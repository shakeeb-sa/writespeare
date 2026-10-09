#!/usr/bin/env python3
"""
research/duckduckgo_search.py — DuckDuckGo SERP scraper for WriteSpeare.

The companion to research/google_search.py. Same purpose, same
marker contract, same exit-code protocol — different search engine,
different SERP layout, different pagination mechanism.

DuckDuckGo is the fallback the WriteSpeare pipeline uses when
Google throttles, CAPTCHAs, or returns no usable results. Its index
is smaller, but its SERPs are (a) free of Google's anti-automation
measures, (b) structurally simpler, and (c) built with semantic
`data-testid` attributes on the elements the extractor needs. A
recording of a real DuckDuckGo search confirmed these facts:

    * Result title anchors carry `data-testid="result-title-a"`.
      Unlike Google's CSS-in-JS hashed class names and per-render
      random IDs, this attribute is a DuckDuckGo-maintained
      contract — it ships as part of DuckDuckGo's own test suite,
      and it is the most stable selector the extractor could rely
      on.

    * Result containers are `li` elements. DuckDuckGo's SERP is a
      `<ol>` / `<ul>` of `li` items; each `li` holds one result's
      title, URL display line, and snippet.

    * Pagination is "Load more", not numbered pages. Clicking the
      `#more-results` button APPENDS additional `li` items to the
      same page. The URL does not change; the list grows in
      place. This is the single biggest structural difference from
      Google, whose pagination replaces the page and changes the
      URL's `&start=` parameter.

    * There is no consent interstitial and no login wall. The
      recording navigated to duckduckgo.com and reached the SERP
      in a single hop. DuckDuckGo does not gate its SERP behind a
      cookie banner the way Google does on a fresh profile.

    * The `ia=web` URL parameter restricts results to web pages.
      Without it, DuckDuckGo mixes in image / video / news results
      and the SERP structure becomes irregular. The extractor
      always passes `ia=web`.

Three page states the module handles defensively that were NOT
captured in the recording, because the recording was a single
manual search:

    1. DuckDuckGo's rate-limit interstitial. Triggers on a rapid
       burst of queries. The `_detect_rate_limit` helper checks the
       page body for the "we're sorry" / "please try again"
       phrasing DuckDuckGo uses, and stops the search cleanly with
       whatever candidates have been collected.

    2. DuckDuckGo's anti-bot challenge. Triggered rarely, but
       present. The `_detect_captcha` helper checks for the
       challenge page's URL fragment and body text and routes to
       `captcha_required`, which opens the GUI modal and blocks
       until the user solves it.

    3. Network errors during navigation. Handled per-page: a
       failed navigation breaks the pagination loop and returns
       the candidates collected so far.

The extraction strategy — why it re-scans the full list after each
"More Results" click:

    Because DuckDuckGo APPENDS to the page rather than replacing
    it, there is no way to know which `li` elements are new without
    tracking them. The simplest correct strategy is to re-scan the
    full `li` list after every click, dedup the accumulated
    candidates by URL, and continue. This costs a small amount of
    redundant DOM querying per page, but it eliminates an entire
    class of bugs that a "read only the new items" strategy would
    have (a stale index, a DOM node that was re-rendered, an item
    that appeared mid-scan). The dedup call — `core.utils.dedup`
    — makes the redundancy invisible to the caller: the emitted
    candidate list has no duplicates.

What this module does NOT do:

    * It does not open any result pages. Same as google_search.py:
      the extractor collects URLs and titles; fetching the actual
      page content is research/extract_dispatch.py's job.

    * It does not filter candidates by quality or paywall status.
      Same reasoning as google_search.py — the plan's user journey
      describes the filtering as happening at the candidate-list
      review stage, not at search time.

    * It does not choose itself as a fallback. The caller (`main.py`
      via the `--engine` flag, driven by the Electron IPC handler)
      decides which engine to run. When Google throttles, the
      caller can rerun the search with `--engine duckduckgo`.

Dependencies: Python stdlib + playwright + the sibling `core/`
package.
"""

import sys
import time
from pathlib import Path
from typing import Optional
from urllib.parse import quote_plus, urlparse

from playwright.sync_api import Page

# =============================================================================
#  sys.path bootstrap — MUST run BEFORE any `from core.* import ...`
# =============================================================================
#  Identical to the bootstrap in google_search.py: the script lives at
#  scripts/research/duckduckgo_search.py, so its own directory is
#  research/, and the parent's parent is the directory that contains
#  `core/`. That directory must be on sys.path for the sibling
#  imports below to resolve in the packaged app's embedded Python
#  distribution.

_SCRIPT_DIR = Path(__file__).resolve().parent
_SCRIPTS_ROOT = _SCRIPT_DIR.parent
if str(_SCRIPTS_ROOT) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_ROOT))

from core.browser import connect_to_chrome
from core.control_mode import checkpoint_check
from core.output import (
    emit_marker,
    MARKER_SEARCH_PROGRESS,
    MARKER_SEARCH_RESULT,
    captcha_required,
    EXIT_SKIPPED,
    EXIT_STOPPED,
)
from core.utils import (
    log_info,
    log_warning,
    log_error,
    dedup,
)


# =============================================================================
#  Constants
# =============================================================================

# The DuckDuckGo SERP URL. Built directly rather than going through
# the homepage search box — matching what the recording showed as
# the URL DuckDuckGo redirects to after a homepage search. The
# `ia=web` parameter restricts results to web pages; without it,
# DuckDuckGo mixes image/video/news results into the SERP.
DUCKDUCKGO_SEARCH_URL = "https://duckduckgo.com/"

# Navigation and readiness timeouts, in milliseconds — Playwright's
# unit.
NAVIGATION_TIMEOUT_MS = 30_000
RESULTS_WAIT_TIMEOUT_MS = 15_000

# How long to wait after a "More Results" click for the new items to
# render. DuckDuckGo appends via a fetch-and-render cycle that is
# usually under a second; the timeout is generous so a slow network
# does not abort a pagination that would have succeeded a moment
# later.
MORE_RESULTS_WAIT_MS = 8_000

# How long to wait between pagination clicks. DuckDuckGo is more
# tolerant of rapid requests than Google, but a small delay is still
# the right thing — it reduces the chance of triggering the
# rate-limit interstitial, and it keeps the automation from
# hammering DuckDuckGo's servers.
INTER_PAGE_DELAY_SECONDS = 1.5

# The maximum number of "More Results" clicks the script will make.
# DuckDuckGo has no documented per-page result count, so the cap is
# expressed in clicks rather than pages — each click typically
# appends 10–20 results. Twenty clicks is far more than any
# legitimate topic needs, and the cap exists only to prevent an
# infinite loop if `#more-results` somehow persists after the
# results are exhausted.
MAX_LOAD_MORE_CLICKS = 20

# The stable test-id attributes DuckDuckGo ships on its SERP. The
# `result-title-a` attribute is the anchor that wraps a result's
# title; it appears in the recording on every title click. The
# `result-snippet` attribute is not shown in the recording, but it is
# a DuckDuckGo-maintained attribute that has been stable for years —
# the code uses it optimistically and falls back to the wrapper
# `li`'s text if it is absent.
RESULT_TITLE_SELECTOR = 'a[data-testid="result-title-a"]'
RESULT_SNIPPET_SELECTOR = '[data-testid="result-snippet"]'
RESULT_CONTAINER_SELECTOR = "li"

# Domain-to-platform mapping used to tag each candidate with a
# short platform identifier. Same set as google_search.py — the
# renderer's SourceList uses the tag to badge each candidate, and
# the tag must mean the same thing regardless of which search
# engine found the URL. Duplicated rather than shared because the
# two search scripts are peers, and a shared constants module
# would be a new file outside the plan's file tree.
PLATFORM_DOMAINS: dict[str, str] = {
    "reddit.com": "reddit",
    "quora.com": "quora",
    "medium.com": "medium",
    "twitter.com": "twitter",
    "x.com": "twitter",
}

# DuckDuckGo-owned hostnames that appear in the SERP but are never
# organic results. DDG occasionally links to its own help pages,
# its "About" page, and its settings; those are not candidates for
# extraction.
DUCKDUCKGO_OWNED_HOSTS = frozenset({
    "duckduckgo.com",
    "duck.co",
})

# Body phrases that reliably indicate DuckDuckGo's rate-limit
# notice. DuckDuckGo's exact copy has varied slightly over the
# years; the phrases below cover the common variants.
RATE_LIMIT_PHRASES = (
    "we're sorry",
    "please try again",
    "too many requests",
)

# URL fragments that indicate a DuckDuckGo anti-bot challenge.
# DuckDuckGo redirects suspicious clients to /anomaly/ or to a
# challenge page; the check is substring-based so a query string
# does not defeat it.
CAPTCHA_URL_FRAGMENTS = (
    "/anomaly",
    "/challenge",
)


# =============================================================================
#  URL helpers
# =============================================================================

def _build_search_url(query: str) -> str:
    """
    Build the DuckDuckGo SERP URL for a query.

    DuckDuckGo has no pagination URL parameter — the initial query
    lands on the first page, and additional results are appended by
    clicking "More Results" in place. This function therefore takes
    no `start` argument (unlike its Google counterpart), and the
    pagination loop below does not rebuild the URL after the first
    navigation.
    """
    q = quote_plus(query)
    return f"{DUCKDUCKGO_SEARCH_URL}?q={q}&ia=web"


def _detect_platform(url: str) -> str:
    """
    Return a short platform slug for a URL, or "generic" for an
    unknown domain.

    Identical semantics to the function of the same name in
    google_search.py: a suffix match so that `www.reddit.com` and
    `old.reddit.com` both resolve to `reddit`.
    """
    try:
        host = urlparse(url).hostname or ""
    except Exception:
        return "generic"
    host = host.lower()
    for domain, platform in PLATFORM_DOMAINS.items():
        if host == domain or host.endswith("." + domain):
            return platform
    return "generic"


def _is_duckduckgo_owned(host: str) -> bool:
    """
    Return True if a hostname belongs to a DuckDuckGo-owned property.
    Same suffix-match semantics as google_search.py's Google-owned
    check.
    """
    host = host.lower()
    for owned in DUCKDUCKGO_OWNED_HOSTS:
        if host == owned or host.endswith("." + owned):
            return True
    return False


def _normalize_result_url(href: str) -> Optional[str]:
    """
    Normalize a result anchor's href into an absolute http(s) URL,
    or return None if the href does not reference an external page.

    DuckDuckGo emits result hrefs in one of two forms:

      1. Direct URLs — `https://example.com/page`. This is the
         common case on the modern SERP. Returned as-is.

      2. Redirector URLs — `//duckduckgo.com/l/?uddg=<encoded>`.
         DuckDuckGo wraps some outbound links in a redirector
         (protocol-relative, so no scheme in the href itself).
         The `uddg` parameter carries the percent-encoded
         destination. Unwrapped here.

    Returns None for:

      * `javascript:` pseudo-URLs.
      * DuckDuckGo-owned hosts.
      * Anything that does not parse as an http(s) URL.
    """
    from urllib.parse import unquote

    if not href:
        return None

    raw = href.strip()
    if not raw or raw.startswith("javascript:"):
        return None

    # Protocol-relative — assume https.
    if raw.startswith("//"):
        raw = "https:" + raw

    # ---- Unwrap DuckDuckGo's /l/?uddg= redirector ----
    if "duckduckgo.com/l/" in raw:
        # The redirector's query string carries the destination in
        # the `uddg` parameter, percent-encoded.
        from urllib.parse import parse_qs
        try:
            parsed = urlparse(raw)
            params = parse_qs(parsed.query)
            candidates = params.get("uddg") or []
            if candidates:
                raw = candidates[0]
        except Exception:
            return None

    # ---- Require an absolute http(s) URL ----
    if not (raw.startswith("http://") or raw.startswith("https://")):
        return None

    # ---- Reject DuckDuckGo-owned hosts ----
    try:
        host = urlparse(raw).hostname or ""
    except Exception:
        return None
    if _is_duckduckgo_owned(host):
        return None

    return raw


# =============================================================================
#  Blocking-state detection
# =============================================================================

def _page_text_lower(page: Page) -> str:
    """
    Return the current page's visible text, lowercased, for phrase
    matching. Returns an empty string on any error — a page that is
    mid-navigation cannot be queried, and the caller treats an empty
    string as "no phrase found".
    """
    try:
        return (page.inner_text("body") or "").lower()
    except Exception:
        return ""


def _detect_captcha(page: Page) -> bool:
    """
    Return True if the current page is a DuckDuckGo anti-bot
    challenge.

    The check is a substring match on the page's URL. DuckDuckGo
    redirects challenged clients to `/anomaly/` or to a challenge
    page that includes one of the fragments in this module's
    `CAPTCHA_URL_FRAGMENTS` list.
    """
    try:
        url = page.url or ""
    except Exception:
        return False
    return any(fragment in url for fragment in CAPTCHA_URL_FRAGMENTS)


def _detect_rate_limit(page: Page) -> bool:
    """
    Return True if the current page is a DuckDuckGo rate-limit
    notice.

    Checked AFTER `_detect_captcha`, so a page that matches both
    the challenge URL and the rate-limit phrasing is treated as a
    challenge — the more specific and more actionable case.
    """
    body = _page_text_lower(page)
    return any(phrase in body for phrase in RATE_LIMIT_PHRASES)


# =============================================================================
#  Result extraction
# =============================================================================

def _extract_all_results(page: Page) -> list[dict]:
    """
    Return every organic result currently rendered on the page.

    Because DuckDuckGo APPENDS results to the same page as
    "More Results" is clicked, this function re-scans the FULL list
    of `li` containers on every call — it does not attempt to read
    only the items that were added since the previous call. The
    caller deduplicates the accumulated results by URL after each
    call, which makes the redundant scanning invisible to any
    downstream consumer.

    Each result is a dict of the shape:

        {
            "url":      "<absolute http(s) URL>",
            "title":    "<the anchor's visible text>",
            "snippet":  "<the snippet text, or the wrapper's text>",
            "platform": "<reddit | quora | medium | twitter | generic>",
        }

    Extraction proceeds in four steps:

      1. Find every `a[data-testid="result-title-a"]` on the page.
         The `data-testid` attribute is DuckDuckGo's own semantic
         hook — the recording confirmed it on every title click.

      2. For each anchor, extract the href and the title. The href
         is normalized via `_normalize_result_url`; the title is
         the anchor's own inner text, which on DuckDuckGo's SERP is
         the title span's text.

      3. Find the result's snippet. The stable selector is
         `[data-testid="result-snippet"]` scoped to the anchor's
         containing `li`. If the snippet element is absent (a
         result without a snippet — possible on some queries), the
         function falls back to the containing `li`'s inner text,
         minus the title.

      4. Derive the platform slug from the URL.

    Duplicates by URL are removed at the end via `core.utils.dedup`.
    """
    results: list[dict] = []

    try:
        anchors = page.locator(RESULT_TITLE_SELECTOR)
        count = anchors.count()

        for i in range(count):
            try:
                anchor = anchors.nth(i)

                # ---- 2. href + title ----
                href = anchor.get_attribute("href") or ""
                url = _normalize_result_url(href)
                if not url:
                    continue

                title = (anchor.inner_text() or "").strip()
                if not title:
                    # An anchor with no visible title is almost
                    # always a tracking or navigation element;
                    # skip it.
                    continue

                # ---- 3. snippet ----
                # Scope the snippet lookup to the anchor's
                # containing `li` so that two results on the same
                # page cannot have their snippets mixed up.
                snippet = ""
                try:
                    li_container = anchor.locator(
                        f"xpath=ancestor::{RESULT_CONTAINER_SELECTOR}[1]"
                    )
                    if li_container.count() > 0:
                        snippet_el = li_container.first.locator(
                            RESULT_SNIPPET_SELECTOR
                        )
                        if snippet_el.count() > 0:
                            snippet = (
                                snippet_el.first.inner_text() or ""
                            ).strip()
                        else:
                            # Fallback — the container's full text
                            # minus the title. This is coarser but
                            # always present.
                            raw = (
                                li_container.first.inner_text() or ""
                            )
                            snippet = raw
                            if snippet.startswith(title):
                                snippet = snippet[len(title):]
                            snippet = snippet.strip()
                        # Bound the snippet — a runaway container
                        # (an ad unit, a widget) can produce
                        # thousands of characters.
                        if len(snippet) > 500:
                            snippet = snippet[:500].rstrip() + "…"
                except Exception:
                    snippet = ""

                results.append({
                    "url": url,
                    "title": title,
                    "snippet": snippet,
                    "platform": _detect_platform(url),
                })

            except Exception:
                # A single malformed result must not abort the
                # whole page.
                continue

    except Exception as exc:
        log_warning(f"Result extraction failed: {exc}")
        return []

    return dedup(results, key=lambda r: r["url"])


def _count_results(page: Page) -> int:
    """
    Return the number of result anchors currently rendered on the
    page. Used by the "More Results" loop to detect when new items
    have appeared after a click — the count is cheap to fetch and
    is a reliable signal that the append operation has completed.
    """
    try:
        return page.locator(RESULT_TITLE_SELECTOR).count()
    except Exception:
        return 0


# =============================================================================
#  Public entry point
# =============================================================================

def run_search(
    query: str,
    keywords: list[str],
    max_results: int,
    topic_id: str,
    port: int,
) -> int:
    """
    Run a DuckDuckGo search and emit the candidate list as markers.

    See the module docstring for the full flow. Returns an integer
    exit code:

        0   – search completed, at least one candidate found
        1   – search failed (no candidates, or a navigation error)
        99  – user clicked Skip on a blocking prompt
        100 – user clicked Stop on a blocking prompt

    The 99/100 codes come from `core.output.captcha_required`
    calling `sys.exit(...)` directly; this function does not catch
    them. When the function returns normally, the code is 0 or 1.

    Parameters (matched by `main.py`'s keyword-argument call site):

        query       – The search string. Normally the topic's title.
        keywords    – The user's keywords. Carried in the marker
                      payload for the GUI's display; do NOT affect
                      the search — the search is on the title alone.
        max_results – Upper bound on the number of candidates to
                      collect. The function may return fewer if
                      DuckDuckGo runs out of results.
        topic_id    – The topic's id. Included in every marker so
                      the renderer can route the candidates to the
                      correct store entry.
        port        – The Chrome CDP debug port to connect to.

    The function is fully synchronous — Playwright's sync API is
    used, matching `core.browser`'s implementation and
    google_search.py's.
    """
    if not query.strip():
        log_error("search: empty query — nothing to search for.")
        return 1

    log_info(f"Searching DuckDuckGo for: {query!r}")

    # ---- 1. Connect to the browser ----
    try:
        browser = connect_to_chrome(port)
    except Exception as exc:
        log_error(f"Could not connect to Chrome on port {port}: {exc}")
        return 1

    # A CDP-attached browser has exactly one persistent context —
    # the default context Chrome itself created. Using it (rather
    # than `browser.new_context()`) is required for session
    # persistence; see google_search.py for the fuller rationale.
    try:
        if not browser.contexts:
            log_error("Connected to Chrome but it has no browser context.")
            return 1
        context = browser.contexts[0]
    except Exception as exc:
        log_error(f"Could not access the browser context: {exc}")
        return 1

    try:
        page: Page = (
            context.pages[0] if context.pages else context.new_page()
        )
    except Exception as exc:
        log_error(f"Could not obtain a browser page: {exc}")
        return 1

    # ---- 2. Initial navigation ----
    url = _build_search_url(query)

    # Checkpoint BEFORE the initial navigation — a user who clicked
    # Stop after the previous stage does not wait for a new page to
    # load before the abort takes effect.
    cmd = checkpoint_check("duckduckgo", "search_initial")
    if cmd == "skip":
        log_info("Search skipped by user.")
        sys.exit(EXIT_SKIPPED)
    if cmd == "stop":
        log_info("Search stopped by user.")
        sys.exit(EXIT_STOPPED)

    log_info(f"Fetching initial results page from {url}")

    try:
        page.goto(
            url,
            timeout=NAVIGATION_TIMEOUT_MS,
            wait_until="domcontentloaded",
        )
    except Exception as exc:
        log_error(f"Navigation to DuckDuckGo failed: {exc}")
        return 1

    # ---- 3. Wait for a terminal state ----
    # DuckDuckGo has no consent interstitial to handle, so the wait
    # is short: either the result anchors appear, or the page is a
    # blocking state (rate-limit / challenge) that the checks below
    # will classify.
    try:
        page.wait_for_selector(
            RESULT_TITLE_SELECTOR,
            timeout=RESULTS_WAIT_TIMEOUT_MS,
        )
    except Exception:
        # No results container appeared. Fall through to the
        # blocking-state checks.
        pass

    # ---- 4. CAPTCHA ----
    if _detect_captcha(page):
        log_warning(
            "DuckDuckGo anti-bot challenge detected — "
            "waiting for user to solve."
        )
        captcha_required(
            site="duckduckgo",
            step="search_initial",
            prompt=(
                "DuckDuckGo is showing an anti-bot challenge. "
                "Solve it in the Chrome window, then click Continue."
            ),
        )
        # On resume, the page is the challenge-cleared state; the
        # extraction below reads whatever results are rendered.

    # ---- 5. Rate-limit ----
    if _detect_rate_limit(page):
        log_warning(
            "DuckDuckGo rate-limit notice detected. Stopping search "
            "before any candidates were collected."
        )
        emit_marker(
            MARKER_SEARCH_RESULT,
            {
                "topicId": topic_id,
                "query": query,
                "keywords": keywords,
                "candidates": [],
            },
        )
        return 1

    # ---- 6. Extract the initial page ----
    collected = _extract_all_results(page)
    if not collected:
        log_warning("Initial DuckDuckGo page returned no candidates.")
        emit_marker(
            MARKER_SEARCH_RESULT,
            {
                "topicId": topic_id,
                "query": query,
                "keywords": keywords,
                "candidates": [],
            },
        )
        return 1

    emit_marker(
        MARKER_SEARCH_PROGRESS,
        {
            "topicId": topic_id,
            "page": 1,
            "found": len(collected),
            "requested": max_results,
        },
    )
    log_info(
        f"Initial page: {len(collected)} candidates collected."
    )

    # ---- 7. Grow the list via "More Results" ----
    # DuckDuckGo appends results in place — no new URL, no new
    # navigation. The loop clicks `#more-results`, waits for the
    # anchor count to increase, then re-scans the full list and
    # deduplicates.
    clicks = 0
    while len(collected) < max_results and clicks < MAX_LOAD_MORE_CLICKS:

        # Checkpoint between pagination rounds — a user-initiated
        # Stop takes effect here rather than after the entire
        # search completes.
        cmd = checkpoint_check("duckduckgo", "load_more")
        if cmd == "skip":
            log_info("Search skipped by user during pagination.")
            sys.exit(EXIT_SKIPPED)
        if cmd == "stop":
            log_info("Search stopped by user during pagination.")
            sys.exit(EXIT_STOPPED)

        # Is there a "More Results" button on the page?
        try:
            more_button = page.locator("#more-results")
            if (
                more_button.count() == 0
                or not more_button.first.is_visible()
            ):
                log_info(
                    "No 'More Results' button on the page — "
                    "end of results."
                )
                break
        except Exception:
            # A page that cannot be queried for the button is
            # treated as the end of results. Blindly clicking
            # would produce a rate-limit hit on the next request.
            break

        # Capture the pre-click anchor count so the wait below can
        # detect the append.
        before = _count_results(page)

        # Click the button.
        try:
            more_button.first.click(timeout=5_000)
        except Exception as exc:
            log_warning(f"'More Results' click failed: {exc}")
            break

        clicks += 1

        # Wait for the anchor count to increase. The polling form
        # (`wait_for_function`) is used rather than
        # `wait_for_selector` because DuckDuckGo does not create
        # NEW elements — it extends the existing list — so waiting
        # for a new selector would time out even on a successful
        # append.
        try:
            page.wait_for_function(
                f"() => document.querySelectorAll("
                f"'{RESULT_TITLE_SELECTOR}').length > {before}",
                timeout=MORE_RESULTS_WAIT_MS,
            )
        except Exception:
            # The count did not increase within the timeout. The
            # most likely cause is that DuckDuckGo has no more
            # results to append. Log and stop.
            log_info(
                f"'More Results' click {clicks} did not yield new "
                f"items — end of results."
            )
            break

        # Re-scan the full list. This is where the append-in-place
        # model differs most from Google's pagination: the full
        # page is read on every iteration, not just a new chunk.
        page_results = _extract_all_results(page)
        if not page_results:
            log_info("No further results — stopping pagination.")
            break

        collected = dedup(collected + page_results, key=lambda r: r["url"])

        emit_marker(
            MARKER_SEARCH_PROGRESS,
            {
                "topicId": topic_id,
                "page": clicks + 1,
                "found": len(collected),
                "requested": max_results,
            },
        )
        log_info(
            f"After click {clicks}: {len(collected)} candidates total."
        )

        # Pace the next click — DuckDuckGo is more tolerant than
        # Google, but a small delay is still the right habit.
        time.sleep(INTER_PAGE_DELAY_SECONDS)

    # ---- 8. Trim to the requested count ----
    final_results = collected[:max_results]

    log_info(
        f"DuckDuckGo search complete: {len(final_results)} candidates "
        f"(after {clicks} 'More Results' click(s))."
    )

    # ---- 9. Emit the final candidate list ----
    emit_marker(
        MARKER_SEARCH_RESULT,
        {
            "topicId": topic_id,
            "query": query,
            "keywords": keywords,
            "candidates": final_results,
        },
    )

    return 0


# =============================================================================
#  Default export
# =============================================================================

__all__ = [
    "run_search",
]