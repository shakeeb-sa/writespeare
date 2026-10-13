#!/usr/bin/env python3
"""
writer/deepseek_writer.py — DeepSeek chat automation for WriteSpeare.

Turns a topic's extracted source docs into a finished article by
driving the DeepSeek chat UI in the app's persistent Chrome
instance. Pastes each doc's content into the chat input, lets
DeepSeek convert each paste into an attachment chip, types the
rendered prompt below the chips, submits with Enter, waits for the
response, copies the response's markdown, and writes the result to
the topic's `article/` folder as a new draft.

The flow, step by step:

    1. Connect to Chrome over CDP on the caller-supplied port.
    2. Navigate to `https://chat.deepseek.com/`. The app's
       persistent Chrome profile holds the user's DeepSeek session,
       so the chat interface loads — not a login page.
    3. Start a new chat so the writer's conversation is isolated
       from any chat the user may have been looking at.
    4. For each doc file in the topic's `sources/` folder:
         a. Read the file's content (body only — frontmatter is
            stripped before the paste).
         b. Put the content on the OS clipboard via the page's
            `navigator.clipboard.writeText`.
         c. Focus the chat input.
         d. Press `Ctrl+V` (or `Meta+V` on macOS).
         e. Wait a moment for DeepSeek's paste handler to convert
            the content into an attachment chip.
    5. Render the prompt template with the topic's variables and
       type the result into the chat input as plain text.
    6. Press Enter to submit the message.
    7. Wait for DeepSeek's response to appear and stabilize.
    8. Select the response's markdown container via the JavaScript
       selection API, copy it, and read the copied text back from
       the clipboard.
    9. Write the response to `article/draft-NN.md`, where `NN` is
       one more than the count of existing drafts.
   10. Emit a `WRITER_DONE` marker carrying the article path and
       the word count.

Two design decisions worth stating up front, because they are the
two places the writer script would be brittle if implemented the
obvious way:

Decision 1 — pasting, not uploading:

    DeepSeek's chat interface accepts two kinds of "attach a
    source" interaction: an explicit file-upload button (a
    paperclip icon, opening a file picker), and the paste
    handler — paste long content into the input and DeepSeek
    converts it into an attachment chip. The writer uses the
    SECOND path. Reasons:

      * The paste path is what the plan's user journey
        documents: "Pastes each doc file one at a time into the
        input box. DeepSeek converts each paste into a .txt
        attachment chip." The journey's phrasing is the
        specification; the script implements it.

      * The paste path does not depend on the file picker's DOM,
        which is a native OS dialog that Playwright cannot drive
        from the page context. Playwright CAN intercept the file
        input via `set_input_files`, but only if the file input's
        selector is known — and DeepSeek's file input is not in
        the recording. The paste path needs only the textarea,
        which we DO have.

      * The paste path is faster for a batch: one clipboard write
        per file, no file-dialog round trip.

    The trade-off: the paste path depends on DeepSeek's own
    paste-to-chip heuristic. If DeepSeek's threshold for
    converting a paste to a chip is high enough that a short doc
    file is inserted as text instead of a chip, the writer's
    verify step (below) catches the case and either accepts it
    (the content still reaches the chat) or fails the run with a
    diagnostic.

Decision 2 — reading the response via the selection API, not a
Copy button:

    DeepSeek's response has a hover-only action bar (Copy,
    Regenerate, Like, Dislike, Share). The Copy button's DOM is
    not in the recording. Rather than guess at its selector, the
    writer selects the response's markdown container via
    `document.createRange()` and copies the selected text via the
    OS clipboard — the same end-to-end mechanism (a Ctrl+C) that
    the Copy button would produce, but triggered by an API we can
    call deterministically.

    `div.ds-markdown` is DeepSeek's own semantic class for the
    markdown body of a response. Unlike the CSS-in-JS hashed
    names (`bf38813a`, `_8402d80`, `dc04ec1d`) that appear on
    layout wrappers, `ds-markdown` is a plain descriptive class
    name — the kind that survives a rebuild. The recording
    confirms its presence on a completed response.

    If the selection-copy path ever fails, the writer falls back
    to reading `inner_text()` from the same container. That
    produces plain text rather than markdown, which is a
    degraded but still valid article — a partial success beats a
    hard failure.

The checkpoint checks:

    Between each doc-file paste — a user who clicks Stop while the
    fourth of ten files is being pasted does not wait for the
    remaining six. Checkpoints raise SystemExit(99/100) and the
    caller (`main.py`) classifies the exit code.

What this module does NOT do:

    * It does not launch Chrome — same as every other pipeline
      stage. The caller supplies the port.

    * It does not log into DeepSeek. The app's persistent Chrome
      profile holds the session from the plan's Stage 0 setup.
      If the session has expired, DeepSeek's own UI shows a
      login wall, and this script detects it (see
      `_detect_login_wall`) and calls `manual_action_required`
      up to `MAX_LOGIN_RETRIES` times — the user signs in by
      hand, clicks Continue, and the script re-checks. If the
      wall is still present after every attempt, the script
      emits a `WRITER_DONE` marker carrying
      `reason: "login_abandoned"` and exits with
      `EXIT_LOGIN_ABANDONED` (102) so the desktop can tell
      "user gave up on the login" apart from "login succeeded
      but the writer failed for another reason".

    * It does not detect captchas on DeepSeek's own domain. The
      plan's user journey does not show DeepSeek presenting
      captchas during generation; if a future session finds that
      it does, the fix is a `captcha_required(...)` call in the
      same `_detect_login_wall` helper's shape.

    * It does not regenerate on validation failure. The
      corrective loop (Stage 6 of the user journey) is a
      separate concern — it re-runs this script with a modified
      prompt file and a bumped draft number. The current
      invocation produces exactly one draft.

Dependencies: Python stdlib + playwright + the sibling `core/`
package.
"""

import json
import sys
import time
from pathlib import Path
from typing import Optional

from playwright.sync_api import Page, BrowserContext

# =============================================================================
#  sys.path bootstrap
# =============================================================================

_SCRIPT_DIR = Path(__file__).resolve().parent
_SCRIPTS_ROOT = _SCRIPT_DIR.parent
if str(_SCRIPTS_ROOT) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_ROOT))

from core.browser import connect_to_chrome
from core.control_mode import checkpoint_check
from core.output import (
    emit_marker,
    MARKER_WRITER_PROGRESS,
    MARKER_WRITER_DONE,
    captcha_required,
    manual_action_required,
    EXIT_SKIPPED,
    EXIT_STOPPED,
)
from core.extractor import strip_frontmatter, count_words
from core.file_io import (
    get_sources_folder,
    get_article_folder,
    read_doc,
    read_prompt_template,
    render_prompt,
    resolve_prompt_path,
    write_text_atomic,
)
from core.utils import (
    log_info,
    log_warning,
    log_error,
)


# =============================================================================
#  Constants
# =============================================================================

# The DeepSeek chat URL. The app's persistent Chrome profile loads
# this as the logged-in chat interface; if the session has expired,
# DeepSeek's own UI redirects to a login page, which
# `_detect_login_wall` detects.
CHAT_URL = "https://chat.deepseek.com/"

# Navigation timeout in milliseconds. Generous because DeepSeek's
# initial bundle is large (a full SPA), and the first load on a
# fresh Chrome process can take several seconds.
NAVIGATION_TIMEOUT_MS = 30_000

# The chat input's accessible name. The Chrome DevTools Recorder
# captures the element's accessible name — the string screen
# readers and automation tools use to identify it — which is
# "Message DeepSeek". This name is what the resolver below
# matches against, not a specific attribute.
CHAT_INPUT_ACCESSIBLE_NAME = "Message DeepSeek"

# The fallback chain for locating the chat input, in priority
# order. The first entry that resolves to a visible element on
# the page wins.
#
# Priority rationale:
#
#   1. Role + accessible name. This is the recording-confirmed
#      anchor. Playwright's `get_by_role("textbox", name=...)`
#      matches an element by its accessible name regardless of
#      whether that name comes from an `aria-label` attribute,
#      a `placeholder`, an `aria-labelledby` reference, or a
#      visible `<label>`. This is the primary selector and it
#      should match on any current DeepSeek markup.
#
#   2. `textarea[aria-label="..."]`. The original selector,
#      retained as a fallback in case DeepSeek's team adds an
#      explicit `aria-label` to match the accessible name.
#
#   3. `textarea[placeholder*="Message"]`. A placeholder-
#      substring fallback for a rename of the placeholder's
#      exact text (e.g. "Message DeepSeek" → "Message...") .
#
#   4. `textarea[placeholder*="Ask"]`. A second placeholder-
#      substring fallback for the other common chat-input
#      wording.
#
#   5. Bare `textarea`. Last-ditch: the first visible textarea
#      on the page. Reached only when every named selector
#      missed, which would mean DeepSeek renamed the input in
#      a way none of the above anticipated.
#
# Each entry is a callable that takes the `Page` and returns a
# Playwright `Locator`. The resolver invokes them in order until
# one yields a visible element.
CHAT_INPUT_SELECTOR_CHAIN = (
    lambda page: page.get_by_role(
        "textbox", name=CHAT_INPUT_ACCESSIBLE_NAME
    ),
    lambda page: page.locator(
        'textarea[aria-label="Message DeepSeek"]'
    ),
    lambda page: page.locator(
        'textarea[placeholder*="Message"]'
    ),
    lambda page: page.locator(
        'textarea[placeholder*="Ask"]'
    ),
    lambda page: page.locator("textarea"),
)

# The stable selector for a completed response's markdown body.
# See "Decision 2" in the module docstring for why this is a
# plain descriptive class name (not a hashed CSS-in-JS name).
RESPONSE_SELECTOR = ".ds-markdown"

# How long to wait after a `Ctrl+V` paste before checking whether
# the textarea stayed empty. DeepSeek's paste handler runs a
# debounce and a length check before deciding to make a chip; 1.5
# seconds is long enough for that decision to settle on a normal
# machine and short enough that ten doc files do not add fifteen
# seconds of dead time.
PASTE_SETTLE_SECONDS = 1.5

# Maximum time to wait for DeepSeek's response to appear, in
# seconds. DeepSeek's generation takes 15–60 seconds for a typical
# prompt; the ceiling is well above that to allow for slow
# networks without hanging forever on a stuck generation.
RESPONSE_APPEAR_TIMEOUT_SECONDS = 90

# How long the response must be stable before we declare generation
# complete. The DOM is checked once per second; when three
# consecutive checks produce identical HTML, the response has
# stopped changing. Three seconds of stability is a strong signal —
# DeepSeek's streaming updates are frequent while generating and
# stop entirely when the response is done.
RESPONSE_STABLE_CHECKS_REQUIRED = 3
RESPONSE_STABLE_POLL_SECONDS = 1.0

# The maximum number of times the writer will re-prompt the user
# to sign in to DeepSeek before giving up.
#
# Each iteration of the login-wall loop calls
# `manual_action_required`, waits for the user to click Continue,
# then re-checks the wall. Three attempts is enough to absorb a
# mistyped password, a slow SPA transition, or a session cookie
# that needed a moment to settle — without letting a confused
# user get stuck in a longer loop when the real problem is that
# their account needs attention outside this app.
MAX_LOGIN_RETRIES = 3

# The exit code the writer uses when the user has clicked Continue
# on the DeepSeek login prompt `MAX_LOGIN_RETRIES` times without
# the session actually becoming live.
#
# Distinct from `EXIT_SKIPPED` (99), `EXIT_STOPPED` (100), and
# `EXIT_CAPTCHA_SKIP` (101), all of which come from
# `core.output`. The value is defined locally rather than in
# `core.output` because it is a writer-stage-specific condition —
# no other pipeline stage has a login flow to abandon — and
# because adding it to `core.output` would expand that module's
# exit-code vocabulary for a reason that only one caller cares
# about. `main.py`'s existing non-zero classifier treats 102 the
# same as any other failure, which is the correct behavior: the
# run failed. The distinctness is what the marker channel
# carries to the desktop, so the desktop can classify it more
# precisely than the exit code alone would allow.
EXIT_LOGIN_ABANDONED = 102

# =============================================================================
#  Internal: chat-input resolver
# =============================================================================

def _resolve_chat_input(page: Page):
    """
    Return a Playwright `Locator` for the chat input, using the
    selector chain declared in `CHAT_INPUT_SELECTOR_CHAIN`.

    Each entry in the chain is tried in order. The first entry
    whose locator resolves to at least one visible element is
    returned. If every entry fails, `None` is returned.

    The function never raises. A chain entry that throws — a
    selector syntax error, a page that has navigated away
    mid-probe — is caught and the next entry is tried. This is
    what lets the resolver survive a page whose DOM is in
    transition: an entry that queries a temporarily-absent
    element raises nothing (Playwright's `.count()` returns 0 on
    a missing locator), but a `get_by_role` call against a
    malformed accessibility tree can, and that failure should not
    abort the whole resolution.

    Returns:
        A `Locator` for the first visible match, or `None`.
    """
    for idx, entry in enumerate(CHAT_INPUT_SELECTOR_CHAIN):
        try:
            locator = entry(page)
            count = locator.count()
            if count == 0:
                continue
            first = locator.first
            if first.is_visible():
                log_info(
                    f"Resolved chat input via selector "
                    f"#{idx + 1} of {len(CHAT_INPUT_SELECTOR_CHAIN)}."
                )
                return first
        except Exception as exc:
            log_warning(
                f"Chat-input selector #{idx + 1} failed: {exc}"
            )
            continue
    return None


# =============================================================================
#  Internal: login-wall detection
# =============================================================================

def _detect_login_wall(page: Page) -> bool:
    """
    Return True if DeepSeek's page is currently a login wall rather
    than the chat interface.

    Detection signals, any of which is sufficient:

      * The current URL contains any common login-page fragment.
        DeepSeek's login page lives at `chat.deepseek.com/sign_in`,
        and a naïve `"signin"` substring match against the URL is
        NOT sufficient: the string is `sign_in` (with an
        underscore), and `"signin" in "…/sign_in"` evaluates to
        False.

      * The page body contains a phrase DeepSeek's login screen
        uses. The list covers the wording that has shipped on
        DeepSeek's login page across recent versions.

      * Neither of the above matched, but the chat textarea is
        absent while a "Log in" button is present. This is the
        catch-all for a login page whose copy has drifted from
        every phrase above — a UI redesign that renames the
        heading but keeps the button label.

    The check runs immediately after navigation; if it fires, the
    caller invokes `manual_action_required` so the user can log
    back in via the same one-time flow the plan's Stage 0
    describes. The writer script does not attempt to enter
    credentials itself — that is the user's account, and the
    session restoration is the point of the persistent Chrome
    profile.
    """
    try:
        url = (page.url or "").lower()
        for fragment in ("login", "signin", "sign_in", "sign-in"):
            if fragment in url:
                return True
    except Exception:
        pass

    try:
        body = (page.inner_text("body") or "").lower()
        for phrase in (
            "sign in to deepseek",
            "log in to continue",
            "welcome back",
            "continue with google",
            "continue with apple",
            "continue with email",
        ):
            if phrase in body:
                return True
    except Exception:
        pass

    # ---- Fallback: textarea absent + a login button present ----
    # Reached only when the URL and the body copy both failed to
    # identify the page. The two-part test — no chat textarea AND
    # a visible login affordance — is specific enough that a
    # normal chat page (which HAS a textarea) can never trigger it.
    #
    # The textarea-absence check goes through the same selector
    # chain the main flow uses. If any entry in the chain resolves
    # to a visible textarea, the page is a chat page, not a login
    # wall. This is what keeps the fallback consistent with
    # `_resolve_chat_input` — a future chain addition is picked up
    # here automatically.
    try:
        resolved = _resolve_chat_input(page)
        if resolved is not None:
            return False
        login_btn = page.get_by_role(
            "button", name="Log in", exact=False
        )
        if login_btn.count() > 0 and login_btn.first.is_visible():
            return True
    except Exception:
        pass

    return False


# =============================================================================
#  Internal: clipboard helper
# =============================================================================

def _write_clipboard(page: Page, text: str) -> bool:
    """
    Write `text` to the OS clipboard via the page's clipboard API.

    Returns True on success, False on any failure.

    Two failure modes are checked, in order:

      1. `navigator.clipboard` or `navigator.clipboard.writeText`
         is undefined on the page. This happens on an insecure
         origin and — importantly for the CDP-attached Chrome
         case — on some browser configurations where the
         clipboard API is gated behind a permission that
         `BrowserContext.grant_permissions` does not reach.
         A page-level availability probe catches this case
         cleanly and avoids the noisy exception that a direct
         `evaluate` call would produce.

      2. The `writeText` call itself rejects — a permission
         denial, a page that has lost focus, a browser that has
         revoked the API mid-session. The exception is caught
         and logged at warning level.

    A False return is not fatal: the caller (`_paste_content`)
    falls back to typing the content directly into the chat
    input, which does not depend on the clipboard at all. See
    that function for the full fallback path.
    """
    try:
        # The availability probe. `navigator.clipboard` is
        # undefined on an insecure origin, and `writeText` is
        # absent on a handful of hardened browser builds. One
        # `evaluate` call settles both questions.
        usable = page.evaluate(
            "() => Boolean(navigator.clipboard && "
            "navigator.clipboard.writeText)"
        )
        if not usable:
            log_warning(
                "navigator.clipboard.writeText is not available "
                "in this page context; the paste step will fall "
                "back to direct text entry."
            )
            return False

        # `json.dumps` escapes quotes, backslashes, and newlines so
        # the string is safe to embed as a JavaScript literal.
        page.evaluate(
            f"navigator.clipboard.writeText({json.dumps(text)})"
        )
        return True
    except Exception as exc:
        log_warning(f"Could not write to clipboard: {exc}")
        return False


def _read_clipboard(page: Page) -> str:
    """
    Read the current OS clipboard content via the page's clipboard
    API. Returns an empty string on any failure.
    """
    try:
        result = page.evaluate("navigator.clipboard.readText()")
        return result if isinstance(result, str) else ""
    except Exception as exc:
        log_warning(f"Could not read from clipboard: {exc}")
        return ""


# =============================================================================
#  Internal: paste one doc as a chip
# =============================================================================

def _paste_content(
    page: Page,
    textarea,
    content: str,
    index: int,
) -> bool:
    """
    Place `content` into the chat input, preferring DeepSeek's
    paste-to-chip handler but falling back to direct typing when
    the clipboard is unavailable.

    Returns True when the content reached the chat input by any
    means — a chip, a paste-as-text, or a direct-typed fallback.
    Returns False only when every avenue failed.

    Three strategies, tried in order:

      1. Clipboard write + Ctrl+V. This is the intended path —
         DeepSeek's paste handler intercepts a long paste and
         converts it to an attachment chip. This is what the
         plan's user journey describes.

      2. Direct text entry via `textarea.fill(...)`. Used when
         the clipboard is unavailable — on a CDP-attached Chrome
         context the clipboard API sometimes rejects even after
         `grant_permissions`. The content still reaches DeepSeek
         as message body text; only the chip presentation is
         lost, and the model reads the same content either way.

      3. Append-with-separator when the textarea already holds
         content from a previous direct-typed doc. Without this,
         a second doc would overwrite the first, so a batch
         where every doc takes the fallback path would end with
         only the last doc visible.

    The False path is now the rare case where even direct typing
    failed — a textarea that has disappeared from the DOM, a page
    that has navigated away. The caller logs a warning and moves
    on; a single un-pasteable doc does not abort the batch.
    """
    # ---- Strategy 1: clipboard + paste keystroke ----
    if _write_clipboard(page, content):
        # Focus the textarea so the paste event targets it.
        try:
            textarea.click()
        except Exception as exc:
            log_warning(f"Could not focus the chat input: {exc}")
        else:
            # Small pause to let the focus settle before the paste.
            time.sleep(0.2)

            # Fire the paste. The `Control+V` sequence is the
            # Windows/Linux form; macOS uses `Meta+V`. Playwright's
            # modifier names are platform-specific, so the check
            # picks the right one.
            modifier = (
                "Meta" if sys.platform == "darwin" else "Control"
            )
            try:
                page.keyboard.press(f"{modifier}+V")
                time.sleep(PASTE_SETTLE_SECONDS)

                # An empty textarea after a long paste is the chip
                # path — DeepSeek intercepted the paste and created
                # an attachment. A non-empty textarea means the
                # content went in as text. Either way, the content
                # reached DeepSeek and the strategy succeeded.
                try:
                    textarea_value = textarea.input_value() or ""
                except Exception:
                    # The textarea's value cannot be read (the
                    # paste may have caused a DOM replacement).
                    # Treat as success — the paste landed.
                    return True

                if textarea_value.strip() == "":
                    log_info(
                        f"Pasted source {index} as an attachment chip."
                    )
                else:
                    log_info(
                        f"Source {index} pasted as text (DeepSeek "
                        f"did not convert it to a chip)."
                    )
                return True
            except Exception as exc:
                log_warning(f"Paste keystroke failed: {exc}")

    # ---- Strategy 2 & 3: direct text entry ----
    # Reached when the clipboard path could not run or the paste
    # keystroke failed. Direct typing bypasses the clipboard and
    # the OS paste handler entirely — it sets the textarea's value
    # via the DOM. DeepSeek's React layer sees the input event and
    # treats the text as message body content. No chip is created,
    # but the model still reads the content.
    log_warning(
        f"Clipboard paste unavailable; typing source {index} "
        f"directly into the chat input."
    )

    try:
        textarea.click()
    except Exception as exc:
        log_warning(f"Could not focus the chat input: {exc}")
        return False

    # Preserve any content already present. A previous direct-typed
    # doc left its text in the textarea; a chip-pasted doc left
    # nothing. The empty-check distinguishes the two cases so the
    # separator only appears between two direct-typed docs.
    try:
        existing = textarea.input_value() or ""
    except Exception:
        existing = ""

    separator = "\n\n---\n\n" if existing.strip() else ""

    try:
        textarea.fill(existing + separator + content)
        time.sleep(0.3)
        log_info(
            f"Typed source {index} directly into the chat input."
        )
        return True
    except Exception as exc:
        log_warning(f"Direct text entry failed: {exc}")
        return False


# =============================================================================
#  Internal: wait for response completion
# =============================================================================

def _wait_for_response(page: Page) -> bool:
    """
    Wait for DeepSeek's response to appear and stabilize.

    Returns True when a stable response container is present, False
    on timeout.

    "Stable" means three consecutive one-second polls of the
    response container's HTML returned identical content. DeepSeek
    streams its response token-by-token; while generation is in
    progress the container's HTML changes on every poll. When it
    stops changing, generation is done.
    """
    deadline = time.time() + RESPONSE_APPEAR_TIMEOUT_SECONDS

    # ---- Wait for the container to appear ----
    while time.time() < deadline:
        try:
            count = page.locator(RESPONSE_SELECTOR).count()
            if count > 0:
                break
        except Exception:
            pass
        time.sleep(0.5)
    else:
        log_warning(
            f"DeepSeek response did not appear within "
            f"{RESPONSE_APPEAR_TIMEOUT_SECONDS}s."
        )
        return False

    # ---- Wait for stability ----
    last_html = ""
    stable_count = 0
    while time.time() < deadline:
        time.sleep(RESPONSE_STABLE_POLL_SECONDS)
        try:
            current_html = page.locator(RESPONSE_SELECTOR).last.inner_html()
        except Exception:
            # Container temporarily unavailable (a re-render is in
            # flight). Reset the stability counter and keep polling.
            stable_count = 0
            last_html = ""
            continue

        if current_html == last_html:
            stable_count += 1
            if stable_count >= RESPONSE_STABLE_CHECKS_REQUIRED:
                log_info("DeepSeek response stabilized.")
                return True
        else:
            last_html = current_html
            stable_count = 0

    log_warning("DeepSeek response did not stabilize within the timeout.")
    return False


# =============================================================================
#  Internal: extract the response text
# =============================================================================

def _extract_response(page: Page) -> str:
    """
    Extract the text of DeepSeek's completed response.

    Two strategies, tried in order:

      1. Select the response container via the JavaScript selection
         API, copy the selection, and read the clipboard back. This
         preserves the response's markdown formatting — headings,
         bold, lists — because DeepSeek's rendered markdown
         carries the structural information in the DOM elements
         and the clipboard round-trip preserves it.

      2. Fall back to reading `inner_text()` from the container.
         This produces plain text without markdown formatting. It
         is a degraded but non-empty result.

    Returns the extracted text, or an empty string if both
    strategies failed.
    """
    # ---- Strategy 1: selection + clipboard ----
    try:
        # Give the page focus (clipboard read requires a focused
        # document).
        try:
            page.locator(RESPONSE_SELECTOR).last.click()
        except Exception:
            pass

        # Select the LAST response container's full text via the
        # selection API. The `.last` matters because a
        # multi-message chat has one `.ds-markdown` per message;
        # the one we want is DeepSeek's most recent response.
        page.evaluate(
            """() => {
                const els = document.querySelectorAll('.ds-markdown');
                if (els.length === 0) return;
                const target = els[els.length - 1];
                const range = document.createRange();
                range.selectNodeContents(target);
                const sel = window.getSelection();
                sel.removeAllRanges();
                sel.addRange(range);
            }"""
        )

        modifier = "Meta" if sys.platform == "darwin" else "Control"
        page.keyboard.press(f"{modifier}+C")
        time.sleep(0.3)

        copied = _read_clipboard(page)
        if copied and copied.strip():
            log_info(f"Copied response via clipboard ({len(copied)} chars).")
            return copied
    except Exception as exc:
        log_warning(f"Clipboard extraction failed: {exc}")

    # ---- Strategy 2: inner_text from the container ----
    try:
        text = page.locator(RESPONSE_SELECTOR).last.inner_text() or ""
        if text.strip():
            log_info(f"Read response via inner_text ({len(text)} chars).")
            return text
    except Exception as exc:
        log_warning(f"inner_text extraction failed: {exc}")

    log_error("Could not extract the DeepSeek response.")
    return ""


# =============================================================================
#  Internal: pick the next draft filename
# =============================================================================

def _next_draft_path(topic_id: str) -> Path:
    """
    Return the path for the next article draft.

    Drafts are numbered sequentially in the topic's `article/`
    folder: `draft-01.md`, `draft-02.md`, and so on. The next
    draft's number is one more than the count of existing drafts.
    A topic that has never been written to gets `draft-01.md`.

    The numbering convention is what lets the writer's
    "regenerate" flow (a future session's concern) add a new
    draft without overwriting the previous one — the user can
    compare drafts side-by-side.
    """
    article_folder = get_article_folder(topic_id)
    existing = sorted(article_folder.glob("draft-*.md"))
    next_number = len(existing) + 1
    return article_folder / f"draft-{next_number:02d}.md"


# =============================================================================
#  Public entry point
# =============================================================================

def run_write(
    topic_id: str,
    docs_dir: str,
    prompt_file: str,
    port: int,
) -> int:
    """
    Generate an article from a topic's source docs and write it as
    the next draft. See the module docstring for the full flow.

    Returns an integer exit code:

        0   – an article was generated and saved
        1   – the run failed (no docs, no Chrome, DeepSeek
              timeout, or empty response)
        99  – user clicked Skip at a checkpoint (raises)
        100 – user clicked Stop at a checkpoint (raises)

    Parameters (matched by `main.py`'s keyword-argument call site):

        topic_id    – The topic's folder name. Used to read the
                      docs and write the article.
        docs_dir    – The folder containing the source `.md` files.
                      This is normally `<topic>/sources/` — the
                      caller (main.py) is expected to pass the
                      same path `core.file_io.get_sources_folder`
                      would compute, but the argument is accepted
                      explicitly so a caller can override the
                      default without changing this function.
        prompt_file – The name of the prompt template to render.
                      Resolved via
                      `core.file_io.resolve_prompt_path`, which
                      implements the plan's two-folder model
                      (Q5.1): the user's prompts folder
                      (`<appData>/writespeare/prompts/`) is
                      checked first, and the bundled prompts
                      folder (`<scripts>/prompts/`) is the
                      fallback. A user-supplied prompt whose
                      name matches a built-in shadows it
                      without destroying it.
        port        – The Chrome CDP debug port to connect to.
    """
    # ---- Validation ----
    if not topic_id.strip():
        log_error("write: empty topic_id.")
        return 1

    docs_path = Path(docs_dir)
    if not docs_path.is_dir():
        log_error(f"write: docs folder does not exist: {docs_dir}")
        return 1

    doc_files = sorted(docs_path.glob("*.md"))
    if not doc_files:
        log_error(f"write: no .md files found in {docs_dir}")
        return 1

    # The prompt file is passed as a bare name (e.g. "default.md").
    # `resolve_prompt_path` implements the plan's two-folder model
    # (Q5.1): the user's prompts at <appData>/writespeare/prompts/
    # are checked first, and the bundled prompts at
    # <scripts>/prompts/ are the fallback. A user-supplied prompt
    # whose name matches a built-in shadows it without destroying
    # it; deleting the user's file reverts to the built-in.
    #
    # The helper raises two exception types, both of which are
    # treated here as fatal. `FileNotFoundError` means the name
    # exists in neither folder — a user who assigned a prompt to
    # a topic and then deleted it needs to see the error, not a
    # silent fallback. `ValueError` means the name itself is
    # invalid (empty, or containing a path separator or a `..`
    # segment) — a caller-side bug that deserves a clear message.
    try:
        prompt_path = resolve_prompt_path(prompt_file)
    except FileNotFoundError as exc:
        log_error(f"write: prompt template not found: {exc}")
        return 1
    except ValueError as exc:
        log_error(f"write: invalid prompt file name: {exc}")
        return 1

    # Read the prompt template now so that a malformed file
    # surfaces as a clear error before Chrome is contacted.
    try:
        template_text = read_prompt_template(prompt_path)
    except Exception as exc:
        log_error(f"write: could not read prompt template: {exc}")
        return 1

    log_info(
        f"Generating article for topic '{topic_id}' from "
        f"{len(doc_files)} source doc(s)."
    )

    # ---- Connect to Chrome ----
    try:
        browser = connect_to_chrome(port)
    except Exception as exc:
        log_error(f"Could not connect to Chrome on port {port}: {exc}")
        emit_marker(
            MARKER_WRITER_DONE,
            {"topicId": topic_id, "articlePath": "", "wordCount": 0},
        )
        return 1

    try:
        if not browser.contexts:
            log_error("Connected to Chrome but it has no browser context.")
            return 1
        context: BrowserContext = browser.contexts[0]
    except Exception as exc:
        log_error(f"Could not access the browser context: {exc}")
        return 1

    # Grant the clipboard permissions the writer's paste and copy
    # steps depend on. Without this, `navigator.clipboard.writeText`
    # and `readText` reject with a permission error.
    try:
        context.grant_permissions(["clipboard-read", "clipboard-write"])
    except Exception as exc:
        # Some browser configurations do not expose the clipboard
        # permissions; the operations below will fall back to
        # alternative methods if the direct API fails.
        log_warning(f"Could not grant clipboard permissions: {exc}")

    try:
        page: Page = (
            context.pages[0] if context.pages else context.new_page()
        )
    except Exception as exc:
        log_error(f"Could not obtain a browser page: {exc}")
        return 1

    # ---- Navigate ----
    log_info("Navigating to DeepSeek.")
    try:
        page.goto(CHAT_URL, timeout=NAVIGATION_TIMEOUT_MS,
                  wait_until="domcontentloaded")
    except Exception as exc:
        log_error(f"Could not navigate to DeepSeek: {exc}")
        emit_marker(
            MARKER_WRITER_DONE,
            {"topicId": topic_id, "articlePath": "", "wordCount": 0},
        )
        return 1

    # ---- Check for a login wall ----
    # If the user's session has expired, DeepSeek redirects to a
    # login page rather than the chat. The loop below re-prompts
    # the user up to `MAX_LOGIN_RETRIES` times.
    #
    # The initial settle time is 2.5 seconds rather than 1.5.
    # DeepSeek's SPA takes a moment to decide whether the session
    # cookie is valid and either render the chat or navigate to
    # `/sign_in`; sampling at 1.5s occasionally catches the page
    # mid-redirect, when neither the chat textarea nor the login
    # button is yet present. The longer wait eliminates that
    # race without adding meaningful latency to the normal path.
    #
    # The retry loop exists because a single Continue click is not
    # always a real sign-in. The user might have missed the
    # prompt, might have clicked Continue before finishing the
    # login, or might be dealing with a slow page transition.
    # Re-prompting gives them a second and third chance with a
    # clear message each time, and hard-failing after the third
    # attempt keeps the writer from looping forever on a user who
    # cannot (or will not) sign in. The distinct exit code and the
    # `reason: "login_abandoned"` marker field are what let the
    # desktop classify this as "user gave up on login" rather than
    # as a generic writer failure — see the plan's C7 decision and
    # PR-7's manifest entry.
    time.sleep(2.5)
    if _detect_login_wall(page):
        log_warning(
            "DeepSeek is showing a login wall — waiting for the "
            "user to sign in."
        )

        # `for...else`: the `else` branch runs when the loop
        # completes without hitting a `break`. A successful
        # sign-in breaks out of the loop and skips the hard-fail
        # branch below. Three Continue clicks without a live
        # session exhaust the range and fall through to the
        # `else`, which emits the abandonment marker and exits.
        for attempt in range(1, MAX_LOGIN_RETRIES + 1):
            manual_action_required(
                site="deepseek",
                step="login",
                prompt=(
                    f"DeepSeek needs you to sign in "
                    f"(attempt {attempt} of {MAX_LOGIN_RETRIES}). "
                    f"Log in in the Chrome window, wait for the "
                    f"chat to load, then click Continue."
                ),
            )

            # After Continue, give the SPA a moment to transition
            # from the login page to the chat. Then re-check the
            # wall.
            time.sleep(3.0)

            if not _detect_login_wall(page):
                log_info(
                    f"DeepSeek session is live after attempt "
                    f"{attempt} of {MAX_LOGIN_RETRIES}."
                )
                break

            log_warning(
                f"Login wall still present after attempt "
                f"{attempt} of {MAX_LOGIN_RETRIES}."
            )
        else:
            # Every attempt was exhausted without a successful
            # sign-in. The marker carries `reason:
            # "login_abandoned"` so the desktop's writer store
            # can distinguish this outcome from a login that
            # succeeded but was followed by a writer error. The
            # exit code is distinct (102) for the same reason at
            # the process level. Both are emitted before the
            # process exits so neither signal is lost.
            log_error(
                f"DeepSeek sign-in was not completed after "
                f"{MAX_LOGIN_RETRIES} attempts. The writer "
                f"cannot proceed without a live session."
            )
            emit_marker(
                MARKER_WRITER_DONE,
                {
                    "topicId": topic_id,
                    "articlePath": "",
                    "wordCount": 0,
                    "reason": "login_abandoned",
                },
            )
            sys.exit(EXIT_LOGIN_ABANDONED)

    # ---- Wait for the chat input ----
    # The resolver tries the full selector chain immediately. If
    # none of the entries match on the first probe, we poll the
    # resolver every half-second for twenty seconds. The polling
    # is required because DeepSeek's composer renders
    # asynchronously — the initial probe can run before the
    # textarea has mounted. A single `wait_for` on one selector
    # would fail immediately; the polling form gives the chain a
    # full twenty seconds to find its match on each render tick.
    #
    # Twenty seconds rather than fifteen: DeepSeek's chat
    # interface occasionally takes longer than fifteen to render
    # the composer after the initial bundle loads, especially on
    # a cold Chrome start where the V8 JIT has not yet warmed up.
    textarea = None
    deadline = time.time() + 20.0
    while time.time() < deadline:
        textarea = _resolve_chat_input(page)
        if textarea is not None:
            break
        time.sleep(0.5)

    if textarea is None:
        # Diagnostic before the failure exits the process. The
        # current URL tells us whether DeepSeek navigated away
        # from the chat (a login wall, an interstitial, a
        # redirect we did not anticipate), the body snippet shows
        # what the page actually rendered, and the DOM dump shows
        # exactly how many textarea and contenteditable elements
        # are on the page. All three are invaluable when
        # debugging from a log that otherwise only says "Chat
        # input did not appear".
        try:
            current_url = page.url
        except Exception:
            current_url = "(unavailable)"
        try:
            body_snippet = (page.inner_text("body") or "")[:500]
        except Exception:
            body_snippet = "(unavailable)"
        try:
            textarea_count = page.locator("textarea").count()
        except Exception:
            textarea_count = -1
        try:
            contenteditable_count = page.locator(
                '[contenteditable="true"]'
            ).count()
        except Exception:
            contenteditable_count = -1

        log_error(
            f"Chat input did not appear within 20s. Every "
            f"selector in the chain failed."
        )
        log_error(f"Current page URL: {current_url}")
        log_error(f"Page body snippet: {body_snippet!r}")
        log_error(
            f"DOM counts — <textarea>: {textarea_count}, "
            f"[contenteditable]: {contenteditable_count}"
        )

        emit_marker(
            MARKER_WRITER_DONE,
            {"topicId": topic_id, "articlePath": "", "wordCount": 0},
        )
        return 1

    # ---- Start a new chat ----
    # DeepSeek's chat interface may have a "New chat" button in the
    # sidebar. Clicking it gives the writer an isolated
    # conversation. If the button is not present (a mobile layout,
    # a UI change), the writer proceeds in whatever chat is
    # currently open — the paste-and-submit flow still works, it
    # just appends to an existing conversation.
    try:
        new_chat = page.get_by_text("New chat", exact=False).first
        if new_chat.count() > 0 and new_chat.is_visible():
            new_chat.click(timeout=3_000)
            log_info("Started a new DeepSeek chat.")
            time.sleep(1.0)
            # Re-resolve the chat input since the DOM may have
            # shifted after the new-chat transition. The resolver
            # walks the same selector chain; the same polling
            # pattern as the initial resolution is used, with a
            # shorter 10-second ceiling because the page is
            # already loaded and the composer only needs to
            # re-mount, not bootstrap.
            resolved = None
            recheck_deadline = time.time() + 10.0
            while time.time() < recheck_deadline:
                resolved = _resolve_chat_input(page)
                if resolved is not None:
                    break
                time.sleep(0.5)
            if resolved is not None:
                textarea = resolved
            # If resolution failed, keep the previous `textarea`
            # reference — the pre-existing composer is likely
            # still in the DOM, and the next step (`_paste_content`)
            # will surface a clear per-doc failure if it is not.
    except Exception:
        # Not fatal — proceeding in the current chat is fine.
        pass

    # ---- Paste each doc ----
    total_docs = len(doc_files)
    for i, doc_path in enumerate(doc_files):
        index = i + 1

        # Checkpoint: honour a pending Skip/Stop between pastes.
        cmd = checkpoint_check("deepseek", f"paste_doc_{index}")
        if cmd == "skip":
            log_info("Writer skipped by user during paste.")
            sys.exit(EXIT_SKIPPED)
        if cmd == "stop":
            log_info("Writer stopped by user during paste.")
            sys.exit(EXIT_STOPPED)

        emit_marker(
            MARKER_WRITER_PROGRESS,
            {
                "topicId": topic_id,
                "phase": "pasting",
                "index": index,
                "total": total_docs,
                "fileName": doc_path.name,
            },
        )
        log_info(f"Pasting {index}/{total_docs}: {doc_path.name}")

        # Read the file and strip its frontmatter — only the body
        # text should go to DeepSeek.
        try:
            raw = read_doc(doc_path)
        except Exception as exc:
            log_warning(f"Could not read {doc_path.name}: {exc}")
            continue

        body = strip_frontmatter(raw)
        if not body.strip():
            log_warning(f"Skipping empty doc: {doc_path.name}")
            continue

        _paste_content(page, textarea, body, index)

    # ---- Render the prompt ----   
    # The prompt's variables are populated from what the writer
    # knows: the topic id, and the list of source doc filenames.
    # The plan's prompt templates declare these variables
    # (`{{ topic_id }}`, `{{ sources }}`) and any others a user
    # adds. The Jinja2 render is total — a template variable with
    # no supplied value renders as the empty string (Jinja2's
    # default behaviour), so a user-edited prompt that references
    # an unusual variable does not crash the writer.
    prompt_vars = {
        "topic_id": topic_id,
        "sources": [f.name for f in doc_files],
        "source_count": len(doc_files),
    }
    try:
        rendered_prompt = render_prompt(template_text, prompt_vars)
    except Exception as exc:
        log_error(f"Could not render prompt template: {exc}")
        emit_marker(
            MARKER_WRITER_DONE,
            {"topicId": topic_id, "articlePath": "", "wordCount": 0},
        )
        return 1

    # ---- Type the prompt below the chips ----
    # The prompt is typed as plain text (not pasted) so DeepSeek
    # treats it as the message body rather than as another
    # attachment. `page.fill` on the textarea sets the value and
    # fires the input event DeepSeek's React app listens for. It
    # does NOT trigger DeepSeek's paste-to-chip heuristic, which
    # is what we want.
    emit_marker(
        MARKER_WRITER_PROGRESS,
        {"topicId": topic_id, "phase": "typing"},
    )
    log_info("Typing the prompt.")
    try:
        textarea.click()

        # Read whatever is currently in the textarea. If every
        # doc became a chip (the normal path), the textarea is
        # empty and the prompt is typed on a clean slate. If any
        # doc took the direct-typing fallback, its content is in
        # the textarea and must be preserved — the prompt is the
        # final instruction and is appended BELOW the source
        # material, not on top of it. Clearing the textarea here
        # unconditionally would discard the fallback content and
        # send DeepSeek a prompt with no sources.
        try:
            existing = textarea.input_value() or ""
        except Exception:
            existing = ""

        separator = "\n\n---\n\n" if existing.strip() else ""
        textarea.fill(existing + separator + rendered_prompt)
        time.sleep(0.3)
    except Exception as exc:
        log_error(f"Could not type the prompt: {exc}")
        return 1

    # ---- Submit ----
    # The plan's user journey has the user pressing Enter. DeepSeek
    # submits the message on Enter; Shift+Enter is a newline. The
    # bare `Enter` is the submit.
    emit_marker(
        MARKER_WRITER_PROGRESS,
        {"topicId": topic_id, "phase": "sending"},
    )
    log_info("Submitting the prompt.")
    try:
        textarea.press("Enter")
    except Exception as exc:
        log_error(f"Could not submit the prompt: {exc}")
        return 1

    # ---- Wait for the response ----
    emit_marker(
        MARKER_WRITER_PROGRESS,
        {"topicId": topic_id, "phase": "waiting"},
    )
    log_info("Waiting for DeepSeek to respond.")
    if not _wait_for_response(page):
        log_error("DeepSeek did not respond in time.")
        emit_marker(
            MARKER_WRITER_DONE,
            {"topicId": topic_id, "articlePath": "", "wordCount": 0},
        )
        return 1

    # ---- Extract the response ----
    emit_marker(
        MARKER_WRITER_PROGRESS,
        {"topicId": topic_id, "phase": "copying"},
    )
    log_info("Extracting the response.")
    response_text = _extract_response(page)
    if not response_text.strip():
        log_error("DeepSeek's response was empty.")
        emit_marker(
            MARKER_WRITER_DONE,
            {"topicId": topic_id, "articlePath": "", "wordCount": 0},
        )
        return 1

    # ---- Save the article ----
    draft_path = _next_draft_path(topic_id)
    try:
        write_text_atomic(draft_path, response_text)
    except Exception as exc:
        log_error(f"Could not write the article: {exc}")
        emit_marker(
            MARKER_WRITER_DONE,
            {"topicId": topic_id, "articlePath": "", "wordCount": 0},
        )
        return 1

    word_count = count_words(response_text)
    log_info(
        f"Article saved to {draft_path.name} ({word_count} words)."
    )

    # ---- Emit the terminal marker ----
    emit_marker(
        MARKER_WRITER_DONE,
        {
            "topicId": topic_id,
            "articlePath": str(draft_path),
            "wordCount": word_count,
        },
    )

    return 0


# =============================================================================
#  Default export
# =============================================================================

__all__ = [
    "run_write",
]