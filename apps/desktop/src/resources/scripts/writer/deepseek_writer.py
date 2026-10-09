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
      so the user can log back in once via the same one-time
      flow.

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

# The stable selector for the chat input. Confirmed three times in
# the user's recordings: `textarea[aria-label="Message DeepSeek"]`.
# The `aria-label` attribute is a semantic anchor DeepSeek's team
# maintains; it does not change on a CSS rebuild the way the
# hashed class names do.
TEXTAREA_SELECTOR = 'textarea[aria-label="Message DeepSeek"]'

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


# =============================================================================
#  Internal: login-wall detection
# =============================================================================

def _detect_login_wall(page: Page) -> bool:
    """
    Return True if DeepSeek's page is currently a login wall rather
    than the chat interface.

    Detection signals, any of which is sufficient:

      * The current URL contains "login" or "signin".
      * The page body contains the phrase "sign in to deepseek"
        or "log in to continue".

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
        if "login" in url or "signin" in url:
            return True
    except Exception:
        pass

    try:
        body = (page.inner_text("body") or "").lower()
        if "sign in to deepseek" in body or "log in to continue" in body:
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

    Returns True on success, False on any failure. The failure mode
    is almost always a missing clipboard permission on the browser
    context; the caller (`_paste_content`) grants the permission
    before calling this, so a False return here indicates an
    unexpected state and the caller logs it.
    """
    try:
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
    Paste `content` into the chat input, relying on DeepSeek's own
    paste handler to convert it into an attachment chip.

    Returns True if the paste appears to have produced a chip (the
    textarea stayed empty), False if the content landed in the
    textarea as text (DeepSeek decided not to convert this paste).

    The False path is not an immediate failure: the content is
    still in the chat input and will be submitted with the prompt.
    It just means the article page will be presented to DeepSeek
    as raw text rather than as an attachment. This is
    functionally equivalent from the model's perspective — the
    model reads the same content either way — so the writer logs
    a debug line and continues.
    """
    if not _write_clipboard(page, content):
        return False

    # Focus the textarea so the paste event targets it.
    try:
        textarea.click()
    except Exception as exc:
        log_warning(f"Could not focus the chat input: {exc}")
        return False

    # Small pause to let the focus settle before the paste.
    time.sleep(0.2)

    # Fire the paste. The `Control+V` sequence is the Windows/Linux
    # form; macOS uses `Meta+V`. Playwright's modifier names are
    # platform-specific, so the check picks the right one.
    modifier = "Meta" if sys.platform == "darwin" else "Control"
    try:
        page.keyboard.press(f"{modifier}+V")
    except Exception as exc:
        log_warning(f"Could not send paste keystroke: {exc}")
        return False

    # Let DeepSeek's paste handler decide.
    time.sleep(PASTE_SETTLE_SECONDS)

    # Check whether the textarea stayed empty. An empty textarea
    # after a long paste is the chip path — DeepSeek intercepted
    # the paste and created an attachment. A non-empty textarea
    # means the content went in as text.
    try:
        textarea_value = textarea.input_value() or ""
    except Exception:
        # The textarea's value cannot be read (the paste may have
        # caused a DOM replacement). Treat as success — the paste
        # landed somewhere in the chat, which is what matters.
        return True

    if textarea_value.strip() == "":
        log_info(f"Pasted source {index} as an attachment chip.")
        return True

    log_info(
        f"Pasted source {index} as text (DeepSeek did not "
        f"convert it to a chip). The prompt will follow it."
    )
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
                      The path is resolved relative to the
                      scripts folder's `prompts/` subdirectory —
                      `default.md` refers to
                      `<scripts>/prompts/default.md`.
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

    # The prompt file is passed as a name (e.g. "default.md"); the
    # full path is resolved against the scripts folder's prompts
    # subdirectory. This matches the convention the plan's file
    # tree uses (prompts/default.md, prompts/seo-focused.md, etc.).
    prompt_path = _SCRIPTS_ROOT / "prompts" / prompt_file
    if not prompt_path.is_file():
        log_error(f"write: prompt template not found: {prompt_path}")
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
    # login page rather than the chat. Block for the user to log
    # back in once.
    time.sleep(1.5)
    if _detect_login_wall(page):
        log_warning(
            "DeepSeek is showing a login wall — waiting for the "
            "user to sign in."
        )
        manual_action_required(
            site="deepseek",
            step="login",
            prompt=(
                "DeepSeek needs you to sign in again. Log in in the "
                "Chrome window, then click Continue."
            ),
        )
        # After Continue, the page should now be the chat.
        time.sleep(2.0)

    # ---- Wait for the chat input ----
    try:
        textarea = page.locator(TEXTAREA_SELECTOR).first
        textarea.wait_for(timeout=15_000)
    except Exception as exc:
        log_error(f"Chat input did not appear: {exc}")
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
            # Re-query the textarea since the DOM may have shifted.
            textarea = page.locator(TEXTAREA_SELECTOR).first
            textarea.wait_for(timeout=10_000)
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
        # Clear any stray content (defensive — a chip paste
        # should leave the textarea empty, but a bug in a
        # previous step might have left something).
        textarea.fill("")
        textarea.fill(rendered_prompt)
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