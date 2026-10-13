#!/usr/bin/env python3
"""
research/extract_dispatch.py — routing + batch loop for extraction.

The orchestrator the pipeline calls when the user has selected the
URLs to extract. Its job is narrow but central: for each selected
URL, ensure Chrome is navigating to it, call the correct
platform-specific extractor to turn the page's HTML into Markdown,
write the result to a doc file in the topic's `sources/` folder,
and emit a progress marker so the renderer's live extraction panel
reflects what happened.

The platform extractors do the actual work. This module decides
which one to call, and it owns the batch-level concerns — the
Chrome connection, the marker stream, the doc-file naming, the
progress reporting, the checkpoint checks that let a user abort
mid-batch.

The interface each platform extractor must provide:

    extract_url(url: str, page: Page) -> Optional[dict]

The function navigates the given Playwright `Page` to `url`, waits
for the page to settle (each extractor knows the wait condition its
platform needs — the post body for Reddit, the answer area for
Quora, the article body for Medium, the DOM-ready event for a
generic page), extracts the page's content, and returns:

    {"title": str, "content": str}

    ... on success, or None on failure.

The dict does NOT include the URL, the platform slug, the word
count, or the fetch timestamp. Those are added by this dispatcher
after the extractor returns — that is what makes every doc file
have the same metadata shape regardless of which extractor produced
it. An extractor that returned them itself would produce doc files
with subtly different frontmatter depending on the platform, which
would be a bug the moment a future session tried to read the
frontmatter back generically.

Failure handling — why a single failed URL does not stop the batch:

    A batch of ten extractions on real-world URLs will usually
    have at least one that fails: a page that has been deleted
    since the search, a site that blocks the automation, a page
    that loads but has no main content (a 404 dressed as a page,
    a paywall interstitial, a JavaScript-only shell). The user
    asked to extract ten pages, not ten successfully. A batch
    that aborted on the first failure would leave the user with
    nine pages un-extracted because one was broken, which is
    strictly worse than letting the nine succeed.

    So the loop catches every per-URL exception, emits an
    `EXTRACT_PROGRESS` marker with status `"failed"`, logs a
    warning, and continues. The user sees the failed URL in the
    extraction panel and can retry it individually later.

    The exception is a User Skip or Stop. Those are not "the URL
    failed"; they are the user telling the operation to end. The
    checkpoint check inside the loop raises SystemExit(99/100),
    and this module does not catch that — the process exits, and
    `main.py` classifies the exit code into a TASK_END status.

The checkpoint checks:

    Two of them, both cheap:

    1. Before the first URL — a user who clicked Stop on the
       previous stage's modal does not wait for the first
       extraction to complete before the abort takes effect.

    2. Between URLs — a user who clicks Stop after the third of
       ten extractions does not wait for the remaining seven.

    A checkpoint returns immediately if no command is pending, so
    the cost of adding them is a few microseconds per iteration.

The Chrome connection model:

    The caller (`main.py`) has launched or reused the app's
    persistent Chrome instance on the port passed via `--port`.
    This module connects to that Chrome over CDP, picks the
    browser's existing page (or creates one), and passes that
    page to each platform extractor in turn.

    Reusing the same page across URLs is deliberate. Creating a
    fresh page per URL would leave ten tabs open at the end of
    the batch (the user's Chrome window would be a mess) and
    would slow the loop with a page-creation cost per URL.
    Reusing one page means the user sees a single tab that
    navigates through the batch, which is what the plan's user
    journey shows in its "Extracting 3 of 10" progress panel.

    The Chrome instance is NOT killed at the end of the batch.
    Its lifecycle belongs to the app — see `chromeLauncher.ts`
    for the full rationale. The plan's user journey has Chrome
    alive across search, extraction, writing, and validation.

What this module does NOT do:

    * It does not launch Chrome. That is the caller's job (the
      Electron main process's `chromeLauncher.ts` on the TS side,
      or a developer running `chrome --remote-debugging-port=...`
      manually before running the Python script standalone). This
      module connects to a port the caller supplies.

    * It does not detect paywalls, login walls, or anti-bot
      interstitials. Those are the platform-specific extractors'
      concerns — a future Reddit extractor would know what a
      Reddit login wall looks like, a future Medium extractor
      would know what Medium's paywall looks like, etc. When a
      platform-specific extractor is not present, the generic
      extractor handles the URL and this module treats its
      non-empty result as success and its empty result as
      failure.

    * It does not re-fetch a URL that failed. A failed URL stays
      failed for the batch. The user can retry it by running the
      extraction again with that URL alone — a natural flow the
      renderer supports by letting the user re-check a subset of
      the candidate list.

    * It does not write to the backend. Every doc file lands in
      the local `sources/` folder; the doc's metadata is also
      mirrored to the backend's `/api/documents` endpoint by a
      separate step (a future IPC call from the Electron side
      after the batch completes, not a concern of this script).

Dependencies: Python stdlib + playwright + the sibling `core/`
package + the sibling `research/extract_*.py` modules (imported
lazily — see the "Lazy imports" note in the code below).
"""

import json
import sys
from pathlib import Path
from typing import NamedTuple, Optional
from urllib.parse import urlparse

from playwright.sync_api import Page

# =============================================================================
#  sys.path bootstrap — MUST run BEFORE any `from core.* import ...`
# =============================================================================
#  Same block as every other feature script. The script lives at
#  scripts/research/extract_dispatch.py, so its own directory is
#  research/, and the parent's parent is the directory that
#  contains `core/`. That directory must be on sys.path for the
#  sibling imports below to resolve in the packaged app's embedded
#  Python distribution.

_SCRIPT_DIR = Path(__file__).resolve().parent
_SCRIPTS_ROOT = _SCRIPT_DIR.parent
if str(_SCRIPTS_ROOT) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_ROOT))

from core.browser import connect_to_chrome
from core.control_mode import checkpoint_check
from core.output import (
    emit_marker,
    MARKER_EXTRACT_PROGRESS,
    MARKER_EXTRACT_DONE,
    EXIT_SKIPPED,
    EXIT_STOPPED,
)
from core.extractor import count_words
from core.file_io import (
    ensure_topic_folders,
    write_doc,
    utc_now_iso,
    get_failures_path,
    write_json_atomic,
)
from core.utils import (
    log_info,
    log_warning,
    log_error,
    slugify,
)


# =============================================================================
#  Constants
# =============================================================================

# Domain → platform slug. Same set the search scripts use, and the
# same slugs the doc file's frontmatter and the renderer's platform
# badges expect. A URL whose domain does not appear here dispatches
# to the generic extractor.
#
# The mapping is checked by suffix match — `reddit.com` matches
# `reddit.com`, `www.reddit.com`, `old.reddit.com`, and
# `np.reddit.com`. Any subdomain of a listed domain dispatches to
# the same extractor.
DOMAIN_TO_PLATFORM: dict[str, str] = {
    "reddit.com": "reddit",
    "quora.com": "quora",
    "medium.com": "medium",
    "twitter.com": "twitter",
    "x.com": "twitter",
}

# -----------------------------------------------------------------------------
#  Failure reason codes
# -----------------------------------------------------------------------------
# The `reason` field of a record in failures.json. Short, stable
# slugs the renderer can map to a human-readable explanation.
#
# The set is deliberately small. Each code corresponds to a
# distinct condition the dispatcher can actually distinguish:
#
#   extractor_error  — the extractor raised an exception (a
#                      Playwright timeout, a navigation error, a
#                      bug in the extractor). The exception's
#                      message is carried in `errorMessage`.
#   no_result        — the extractor returned None without
#                      raising. The extractor's own contract
#                      does not distinguish between "the page
#                      had no content" and "the extractor gave
#                      up" — both are None — so the dispatcher
#                      cannot be more specific than this.
#   invalid_result   — the extractor returned something other
#                      than a dict or None. A contract violation,
#                      always a bug.
#   empty_content    — the extractor returned a dict with an
#                      empty (or whitespace-only) `content`
#                      field. There is nothing to save.
#   write_failed     — the extraction succeeded but writing the
#                      doc file to disk failed (permissions,
#                      disk full, etc.). The failure is at the
#                      write step, not the fetch step.
#
# The renderer's retry UI surfaces these codes verbatim; a future
# session that wants richer per-reason guidance (an icon, a
# suggestion) would add a mapping on the renderer side, not a
# new code here.
FAILURE_REASON_EXTRACTOR_ERROR = "extractor_error"
FAILURE_REASON_NO_RESULT = "no_result"
FAILURE_REASON_INVALID_RESULT = "invalid_result"
FAILURE_REASON_EMPTY_CONTENT = "empty_content"
FAILURE_REASON_WRITE_FAILED = "write_failed"


class ExtractAttempt(NamedTuple):
    """
    The result of one URL's extraction attempt.

    A named tuple rather than a plain dict because the fields
    are read positionally by every caller, and a dict would let
    a typo in a key name (`attempt["reson"]`) fail silently at
    runtime. With a NamedTuple, an attribute typo is a
    compile-time error under any type checker.

    Fields on success:

        result        = {"title": str, "content": str}
        reason        = ""        (empty — no failure occurred)
        error_message = ""        (empty — no failure occurred)

    Fields on failure:

        result        = None
        reason        = one of the FAILURE_REASON_* constants above
        error_message = a human-readable message (the exception's
                        string form, or a fixed explanation when
                        no exception was raised)

    The invariant callers rely on: `result is None` if and only if
    `reason` is non-empty. A caller that wants to know whether the
    attempt succeeded checks `result is None`; a caller that wants
    to know why it failed reads `reason` and `error_message`.
    """
    result: Optional[dict]
    reason: str
    error_message: str




# =============================================================================
#  Helpers
# =============================================================================

def _detect_platform(url: str) -> str:
    """
    Return the platform slug for a URL, or "generic" for an
    unknown domain.

    The function never raises. A URL that does not parse — which
    the search side's normalization should have already rejected —
    falls through to "generic", so the URL still gets a chance at
    extraction via the generic extractor rather than being dropped.
    """
    try:
        host = urlparse(url).hostname or ""
    except Exception:
        return "generic"
    host = host.lower()
    for domain, platform in DOMAIN_TO_PLATFORM.items():
        if host == domain or host.endswith("." + domain):
            return platform
    return "generic"


def _build_doc_slug(index: int, platform: str, title: str) -> str:
    """
    Build the doc file's slug from its position in the batch, its
    platform, and its title.

    The shape is:

        {index:03d}-{platform}-{slugified-title}

    Zero-padded to three digits so that a lexical sort of the
    `sources/` folder's contents matches the batch order — with
    `001`, `002`, … `010`, … `100` all sorting correctly. Without
    the padding, `10` would sort before `2`.

    The title is passed through `slugify`, which strips
    punctuation, handles unicode, and enforces a maximum length.
    An empty title (which a malformed extractor could produce)
    falls back to the literal `"untitled"` — the same fallback
    `slugify` itself provides, but applied at this level as a
    belt-and-braces guard against a future change to slugify
    loosening that guarantee.

    The full slug is capped at a reasonable length to keep the
    resulting file path within Windows's 260-character limit. The
    `slugify` default of 80 characters plus the index and platform
    prefix (about 15 characters total) leaves ~165 characters for
    the rest of the path — the app-data root, the app slug, the
    topics folder, and the topic ID — which is comfortable for the
    topic-ID shape the plan's user journey uses.
    """
    title_slug = slugify(title) if title else "untitled"
    return f"{index:03d}-{platform}-{title_slug}"


def _extract_one(
    url: str,
    page: Page,
) -> ExtractAttempt:
    """
    Dispatch a single URL to its platform extractor and return
    the attempt outcome.

    The platform is detected from the URL; the corresponding
    extractor module is imported lazily on first use (see the
    "Lazy imports" comment in `run_extract` below for why). The
    extractor is called with the URL and the shared Playwright
    page; it returns `{"title": str, "content": str}` on success
    or `None` on failure.

    Any exception the extractor raises — a Playwright timeout, a
    navigation error, a bug in the extractor — is caught here and
    converted to a failed `ExtractAttempt` whose `reason` and
    `error_message` describe the failure. The caller
    (`run_extract`) records the reason and message in the topic's
    failures.json so a retry attempt can accumulate the URL's
    attempt count and the user can see why the URL failed.

    The exception is logged at warning level rather than debug
    because an extractor that raises is either a bug worth
    reporting or a page state the extractor did not anticipate.
    Both deserve a log line the developer can see.

    Args:
        url:  The absolute URL to extract.
        page: The shared Playwright page. The extractor navigates
              it and reads its content.

    Returns:
        An `ExtractAttempt`. See its docstring for the field
        invariant: `result is None` if and only if `reason` is
        non-empty.
    """
    platform = _detect_platform(url)

    # ---- Lazy import of the platform module ----
    # The lazy pattern is required because this dispatcher is
    # created BEFORE the platform-specific extractor modules it
    # prefers. A top-level `from research.extract_reddit import
    # extract_url` would fail at import time today, and the
    # failure would propagate up to `main.py`'s dispatcher —
    # making the whole extract command fail before any URL was
    # attempted. The lazy import keeps the failure contained to
    # the moment a URL of that platform actually appears in the
    # batch.
    #
    # When a platform-specific extractor is missing (a site whose
    # dedicated extractor has not yet been written), the
    # ImportError handler below falls back to the generic
    # extractor rather than marking the URL as failed. The
    # generic extractor uses trafilatura's heuristics and
    # produces readable output for any HTML page — including
    # reddit, quora, and medium pages — so a URL is never
    # dropped merely because a specialised extractor does not
    # exist yet. When a specialised extractor is added in a
    # future session, the fallback stops firing for that platform
    # automatically; no change to this file is required at that
    # time.
    #
    # Each module is imported fresh on every URL — Python's own
    # import cache makes this nearly free (a dictionary lookup in
    # sys.modules) after the first import of a given module. A
    # future refactor could hoist the import to a module-level
    # cache, but the current form is simpler and the cost is
    # negligible.
    try:
        if platform == "reddit":
            from research.extract_reddit import extract_url
        elif platform == "quora":
            from research.extract_quora import extract_url
        elif platform == "medium":
            from research.extract_medium import extract_url
        elif platform == "twitter":
            from research.extract_twitter import extract_url
        else:
            from research.extract_generic import extract_url
    except ImportError as exc:
        # The platform-specific extractor is not installed (its
        # module file does not exist yet). Fall back to the
        # generic extractor rather than marking the URL as
        # failed — the page is still fetchable, and the generic
        # extractor's trafilatura-based extraction produces
        # usable Markdown from any HTML page. When a specialised
        # extractor is added in a future session, this fallback
        # stops firing for that platform automatically, and no
        # change to this file is required.
        log_warning(
            f"Platform-specific extractor for '{platform}' is not "
            f"available ({exc}); using generic extractor."
        )
        from research.extract_generic import extract_url

    # ---- Call the extractor ----
    try:
        result = extract_url(url, page)
    except Exception as exc:
        log_warning(
            f"Extractor raised for {url} (platform={platform}): {exc}"
        )
        return ExtractAttempt(
            result=None,
            reason=FAILURE_REASON_EXTRACTOR_ERROR,
            error_message=str(exc),
        )

    if result is None:
        # The extractor signalled a clean failure — the page was
        # reachable but its content was not extractable (a 404, a
        # paywall, a JavaScript-only shell). The extractor's own
        # contract does not distinguish these cases, so the
        # reason is `no_result` and the message is a fixed string.
        log_warning(
            f"Extractor for platform '{platform}' returned None "
            f"for {url}"
        )
        return ExtractAttempt(
            result=None,
            reason=FAILURE_REASON_NO_RESULT,
            error_message="Extractor returned no result.",
        )

    if not isinstance(result, dict):
        # A well-behaved extractor returns a dict or None. Anything
        # else is a contract violation — a bug in the extractor,
        # not in the page. Log it with enough context that a
        # developer can identify which extractor misbehaved.
        log_warning(
            f"Extractor for platform '{platform}' returned "
            f"{type(result).__name__} instead of dict or None "
            f"for {url}"
        )
        return ExtractAttempt(
            result=None,
            reason=FAILURE_REASON_INVALID_RESULT,
            error_message=(
                f"Extractor returned {type(result).__name__} "
                f"instead of dict or None."
            ),
        )

    title = result.get("title")
    content = result.get("content")
    if not isinstance(title, str):
        title = ""
    if not isinstance(content, str) or not content.strip():
        # An extractor that returned a dict but with empty content
        # is treated as a failure — there is nothing to save.
        log_warning(
            f"Extractor for platform '{platform}' returned empty "
            f"content for {url}"
        )
        return ExtractAttempt(
            result=None,
            reason=FAILURE_REASON_EMPTY_CONTENT,
            error_message="Extractor returned empty content.",
        )

    return ExtractAttempt(
        result={"title": title, "content": content},
        reason="",
        error_message="",
    )


# =============================================================================
#  Public entry point
# =============================================================================

def run_extract(
    urls: list[str],
    topic_id: str,
    port: int,
) -> int:
    """
    Extract every URL in `urls` and write a doc file for each
    successful extraction. See the module docstring for the full
    flow.

    Returns an integer exit code:

        0   – at least one URL was extracted successfully
        1   – the batch failed entirely (no URLs extracted, or
              Chrome could not be reached)
        99  – user clicked Skip at a checkpoint (raises, does not
              return)
        100 – user clicked Stop at a checkpoint (raises, does not
              return)

    The 0-vs-1 distinction is what `main.py` uses to classify the
    operation in its `TASK_END` marker. A batch where 1 of 10 URLs
    succeeded is a success — the user has one doc file and knows
    the other nine failed (the renderer's extraction panel shows
    the per-URL statuses). A batch where zero URLs succeeded is a
    failure — the user has nothing to show for the operation and
    the renderer's error state should reflect that.

    Parameters (matched by `main.py`'s keyword-argument call site):

        urls      – The absolute URLs to extract, in the order
                    the user selected them. The doc files are
                    written in this order, and the
                    `EXTRACT_PROGRESS` markers report the same
                    index/total pair the user sees.
        topic_id  – The topic's folder name. Used to compute the
                    output folder and included in every emitted
                    marker so the renderer routes the progress to
                    the correct topic's panel.
        port      – The Chrome CDP debug port to connect to.

    The function is fully synchronous — Playwright's sync API is
    used, matching every other script in the pipeline.
    """
    # ---- Validation ----
    if not urls:
        log_error("extract: no URLs provided.")
        emit_marker(
            MARKER_EXTRACT_DONE,
            {
                "topicId": topic_id,
                "savedCount": 0,
                "failedCount": 0,
            },
        )
        return 1

    if not topic_id.strip():
        log_error("extract: empty topic_id.")
        emit_marker(
            MARKER_EXTRACT_DONE,
            {
                "topicId": topic_id,
                "savedCount": 0,
                "failedCount": 0,
            },
        )
        return 1

    log_info(f"Extracting {len(urls)} URL(s) for topic '{topic_id}'")

    # ---- Ensure the topic's folders exist ----
    # Done before the Chrome connection so that a permissions
    # problem on the output directory surfaces as a clear error
    # rather than as a mysterious "failed to write" halfway through
    # the batch.
    try:
        ensure_topic_folders(topic_id)
    except OSError as exc:
        log_error(f"Could not create topic folders: {exc}")
        emit_marker(
            MARKER_EXTRACT_DONE,
            {
                "topicId": topic_id,
                "savedCount": 0,
                "failedCount": len(urls),
            },
        )
        return 1

    # ---- Connect to Chrome ----
    try:
        browser = connect_to_chrome(port)
    except Exception as exc:
        log_error(f"Could not connect to Chrome on port {port}: {exc}")
        emit_marker(
            MARKER_EXTRACT_DONE,
            {
                "topicId": topic_id,
                "savedCount": 0,
                "failedCount": len(urls),
            },
        )
        return 1

    # The same access pattern as `google_search.py` — see that
    # file's comment for why `browser.contexts[0]` is correct for
    # a CDP-attached browser and why `browser.new_context()` would
    # break the session persistence the app relies on.
    try:
        if not browser.contexts:
            log_error("Connected to Chrome but it has no browser context.")
            emit_marker(
                MARKER_EXTRACT_DONE,
                {
                    "topicId": topic_id,
                    "savedCount": 0,
                    "failedCount": len(urls),
                },
            )
            return 1
        context = browser.contexts[0]
    except Exception as exc:
        log_error(f"Could not access the browser context: {exc}")
        emit_marker(
            MARKER_EXTRACT_DONE,
            {
                "topicId": topic_id,
                "savedCount": 0,
                "failedCount": len(urls),
            },
        )
        return 1

    try:
        page: Page = (
            context.pages[0] if context.pages else context.new_page()
        )
    except Exception as exc:
        log_error(f"Could not obtain a browser page: {exc}")
        emit_marker(
            MARKER_EXTRACT_DONE,
            {
                "topicId": topic_id,
                "savedCount": 0,
                "failedCount": len(urls),
            },
        )
        return 1

    # ---- Load existing failures for attemptCount accumulation ----
    # The topic's failures.json, if it exists, holds records from
    # previous batches. Reading it here lets this batch:
    #
    #   * increment each still-failing URL's attemptCount (so a
    #     URL that has failed three times shows `attemptCount: 3`),
    #   * and preserve records for URLs that are NOT part of this
    #     batch (the user might have retried a subset; the rest
    #     stay on file until retried or explicitly cleared).
    #
    # A malformed or unreadable file is not an error — the batch
    # proceeds with an empty starting state, which means fresh
    # attemptCounts. The alternative (failing the batch) would be
    # worse: the extraction itself is unaffected by a corrupt
    # failures.json, and losing the previous counts is a minor
    # cosmetic loss compared to aborting the user's work.
    existing_failures: dict[str, dict] = {}
    failures_path = get_failures_path(topic_id)
    try:
        if failures_path.exists():
            raw_failures = json.loads(
                failures_path.read_text(encoding="utf-8")
            )
            if isinstance(raw_failures, list):
                for record in raw_failures:
                    if (
                        isinstance(record, dict)
                        and isinstance(record.get("url"), str)
                    ):
                        existing_failures[record["url"]] = record
    except Exception as exc:
        log_warning(
            f"Could not read existing failures.json for topic "
            f"'{topic_id}': {exc}"
        )
        existing_failures = {}

    # ---- Batch loop ----
    saved_count = 0
    failed_count = 0
    total = len(urls)
    # The records this batch will write into failures.json. Only
    # this batch's failures are appended here; URLs whose records
    # are preserved from `existing_failures` are merged back after
    # the loop (see the "Merge preserved and current failures"
    # step below).
    current_failures: list[dict] = []

    for i, url in enumerate(urls):
        index = i + 1

        # ---- Checkpoint: honour a pending Skip/Stop ----
        # Checked BEFORE each URL so a user who clicks Stop after
        # URL 3 does not wait for URLs 4–10 to complete. The
        # checkpoint raises SystemExit(99) or SystemExit(100) —
        # this function does not catch it, and `main.py`
        # classifies the exit code.
        cmd = checkpoint_check("extract", f"url_{index}")
        if cmd == "skip":
            log_info("Extraction skipped by user.")
            sys.exit(EXIT_SKIPPED)
        if cmd == "stop":
            log_info("Extraction stopped by user.")
            sys.exit(EXIT_STOPPED)

        # ---- Emit "loading" progress ----
        emit_marker(
            MARKER_EXTRACT_PROGRESS,
            {
                "topicId": topic_id,
                "index": index,
                "total": total,
                "url": url,
                "status": "loading",
            },
        )
        log_info(f"Extracting {index}/{total}: {url}")

        # ---- Extract ----
        attempt = _extract_one(url, page)

        if attempt.result is None:
            # The extraction failed. Record the failure with its
            # accumulated attempt count, emit the failed progress
            # marker, log a warning, and move to the next URL.
            failed_count += 1

            prev = existing_failures.get(url)
            prev_count = 0
            if prev is not None:
                raw_count = prev.get("attemptCount", 0)
                if isinstance(raw_count, int) and raw_count >= 0:
                    prev_count = raw_count

            current_failures.append({
                "url": url,
                "reason": attempt.reason,
                "attemptCount": prev_count + 1,
                "lastAttemptAt": utc_now_iso(),
                "errorMessage": attempt.error_message,
            })
            emit_marker(
                MARKER_EXTRACT_PROGRESS,
                {
                    "topicId": topic_id,
                    "index": index,
                    "total": total,
                    "url": url,
                    "status": "failed",
                },
            )
            log_warning(
                f"Failed to extract: {url} "
                f"({attempt.reason}: {attempt.error_message})"
            )
            continue

        # `attempt.result` is guaranteed non-None here — the
        # invariant documented on ExtractAttempt ties `result is
        # None` to a non-empty `reason`, and the branch above
        # handles exactly that case.
        extracted = attempt.result

        # ---- Write the doc file ----
        platform = _detect_platform(url)
        slug = _build_doc_slug(index, platform, extracted["title"])
        metadata = {
            "url": url,
            "title": extracted["title"],
            "platform": platform,
            "word_count": count_words(extracted["content"]),
            "fetched_at": utc_now_iso(),
        }

        try:
            doc_path = write_doc(
                topic_id=topic_id,
                slug=slug,
                content=extracted["content"],
                metadata=metadata,
            )
        except Exception as exc:
            # A failure here is a filesystem problem (a permissions
            # error, a full disk, a malformed slug that the write
            # rejects). The extraction succeeded but the write did
            # not — the user sees this as a failed URL, which is
            # the correct classification: a doc file that is not
            # on disk is a doc file the pipeline cannot use.
            failed_count += 1

            prev = existing_failures.get(url)
            prev_count = 0
            if prev is not None:
                raw_count = prev.get("attemptCount", 0)
                if isinstance(raw_count, int) and raw_count >= 0:
                    prev_count = raw_count

            current_failures.append({
                "url": url,
                "reason": FAILURE_REASON_WRITE_FAILED,
                "attemptCount": prev_count + 1,
                "lastAttemptAt": utc_now_iso(),
                "errorMessage": str(exc),
            })
            emit_marker(
                MARKER_EXTRACT_PROGRESS,
                {
                    "topicId": topic_id,
                    "index": index,
                    "total": total,
                    "url": url,
                    "status": "failed",
                },
            )
            log_warning(
                f"Extraction succeeded but file write failed for "
                f"{url}: {exc}"
            )
            continue

        saved_count += 1
        emit_marker(
            MARKER_EXTRACT_PROGRESS,
            {
                "topicId": topic_id,
                "index": index,
                "total": total,
                "url": url,
                "status": "saved",
            },
        )
        log_info(f"Saved {doc_path.name}")

    # ---- Merge preserved and current failures ----
    # The final failures.json carries two sources of records:
    #
    #   1. Records from the previous file for URLs that were NOT
    #      part of this batch. They represent failed URLs the user
    #      has not retried yet — the file must keep them so a
    #      later retry still knows about them.
    #
    #   2. Records for URLs that failed in this batch, with their
    #      attemptCount accumulated from the previous file.
    #
    # URLs that appeared in this batch and succeeded are absent
    # from both sources — their previous failure records, if any,
    # are dropped. A URL that succeeded no longer belongs in the
    # failure list.
    url_set = set(urls)
    preserved_failures: list[dict] = [
        record
        for url_key, record in existing_failures.items()
        if url_key not in url_set
    ]
    final_failures: list[dict] = preserved_failures + current_failures

    # ---- Write failures.json ----
    # Written before the terminal marker so that by the time the
    # renderer's EXTRACT_DONE handler fires, the file on disk
    # reflects the batch's outcome. A write failure is logged but
    # does not change the batch's success/failure classification
    # — the extraction itself completed; the failure file is a
    # diagnostic artifact, and losing it is worse than aborting
    # the batch over a disk-full condition.
    try:
        write_json_atomic(failures_path, final_failures)
    except Exception as exc:
        log_warning(
            f"Could not write failures.json for topic "
            f"'{topic_id}': {exc}"
        )

    # ---- Emit terminal marker ----
    emit_marker(
        MARKER_EXTRACT_DONE,
        {
            "topicId": topic_id,
            "savedCount": saved_count,
            "failedCount": failed_count,
        },
    )

    log_info(
        f"Extraction complete: {saved_count} saved, "
        f"{failed_count} failed (of {total})."
    )

    # ---- Exit code ----
    # 0 if at least one URL was saved; 1 if the batch produced
    # nothing. See the function's docstring for the reasoning.
    return 0 if saved_count > 0 else 1


# =============================================================================
#  Default export
# =============================================================================

__all__ = [
    "run_extract",
]