#!/usr/bin/env python3
"""
research/google_search.py — Google SERP scraper for the WriteSpeare pipeline.

Opens the WriteSpeare Chrome instance over CDP, submits a topic's
query to Google, and collects the organic result anchors until the
requested number of candidates is reached or the results run out.

The selectors and URL structures this module relies on were derived
from a Chrome DevTools Recorder export of a real Google search
performed against the same browser layout the automation drives.
The recording confirmed these stable anchors:

    * Results container:       #rso
    * Result title anchors:    <a> elements whose direct child is an
                               <h3>, inside #rso
    * Result URL display:      <cite> inside each result container
    * Pagination "Next" link:  #pnnext
    * Pagination URL param:    &start=<N>, incrementing by 10 per page

The recording also showed that Google internal IDs (for example
`#Odp5De`, `#_wDXJavO1AaaU9u8PzuXV2Ak_70`) are present on result
wrappers but are per-render random — the script does NOT rely on
them. It extracts each result's href from the `<a>` wrapping the
result's `<h3>` title, which is Google's oldest and most stable
SERP structure.

Three page states the module handles defensively that were NOT
captured in the recording, because they depend on browser state
the recording did not have:

    1. Google's consent interstitial. On a FRESH Chrome profile
       (which the WriteSpeare profile starts as), Google shows a
       "Before you continue to Google" page with an accept button.
       The recording ran against a Chrome profile that already had
       the consent cookie, so the page did not appear. The
       `_accept_consent_if_present` helper detects the page by its
       heading text and clicks the accept button. On a profile that
       already has the cookie, the helper is a no-op.

    2. Google's "unusual traffic" CAPTCHA. Triggers when Google
       detects automation or a rapid query rate. The recording was
       a single manual search and did not trigger it. The
       `_detect_captcha` helper checks for the /sorry/ URL fragment
       and for the phrase "unusual traffic" in the page body. On
       detection, the script calls `captcha_required()` which blocks
       the process until the user solves it (or clicks Skip/Stop).

    3. Rate-limit interstitial. Google sometimes returns a
       non-CAPTCHA throttling page — a plain HTML notice asking the
       user to slow down. The `_detect_rate_limit` helper checks for
       this separately from the CAPTCHA path, so that a rate-limit
       hit produces a clean `log_warning` rather than a modal the
       user has nothing to click.

The interaction model:

    This script drives an EXISTING Chrome instance. It does not
    launch Chrome — the Electron main process owns the launch (via
    chromeLauncher.ts), and the port the two sides agree on is
    passed to this script as `--port`. When run standalone from a
    terminal, the caller is expected to have already started Chrome
    with `--remote-debugging-port=<port>`.

    For every page navigated to, the script:
      1. Navigates via `page.goto(url)` with a bounded timeout.
      2. Waits for the results container (`#rso`) to appear, or for
         a known blocking state (consent / captcha / rate-limit).
      3. Extracts the results from the loaded page.
      4. Emits a SEARCH_PROGRESS marker with the incremental count.
      5. Checks `checkpoint_check()` for a pending Skip/Stop before
         the next navigation.

    The checkpoint check between pages is what lets a user abort a
    long-running search from the GUI without the script having to
    finish the current page first — the abort takes effect at the
    page boundary.

What this module does NOT do:

    * It does not open any result pages. It collects the URLs and
      returns them; fetching the actual page content is the job of
      research/extract_dispatch.py (Session 11). This separation is
      what keeps the search stage fast — no page loads, just SERP
      parsing.

    * It does not filter candidates by quality, paywall status, or
      user blacklist. The plan's user journey describes an
      "unchecked because low-quality" behaviour on the candidate
      list; that filtering happens in the renderer (SourceList) or
      is a future backend filter, not here. This script returns
      every organic result it finds, in the order Google ranks them.

    * It does not merge in a DuckDuckGo search when Google
      throttles. The plan's Part 1.17 describes duckduckgo_search.py
      as a SEPARATE backend chosen by the caller. This module
      reports a rate-limit hit cleanly; the CALLER (the Electron IPC
      handler, or the user via the UI) decides whether to rerun the
      search with `--engine duckduckgo`.

Dependencies: Python stdlib + playwright + the sibling `core/`
package.
"""

import re
import sys
import time
from pathlib import Path
from typing import Optional
from urllib.parse import quote_plus, unquote, urlparse

from playwright.sync_api import Page

# =============================================================================
#  sys.path bootstrap — MUST run BEFORE any `from core.* import ...`
# =============================================================================
#  Same block as every other WriteSpeare Python entry point. See
#  main.py's module docstring for the full reasoning; the short
#  version is that the packaged app's embedded Python has a
#  python3xx._pth file that overrides sys.path and does NOT prepend
#  the script's own directory, so an explicit insert is required for
#  `from core.output import ...` to resolve.

_SCRIPT_DIR = Path(__file__).resolve().parent
# The script lives at scripts/research/google_search.py, so its own
# directory is research/, not scripts/. The parent's parent is the
# directory that contains `core/` and that must be on sys.path.
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

# The Google SERP URL structure. Building the URL directly (rather
# than navigating to google.com and typing into the search box) is
# more reliable: it skips the New Tab Page entirely, it does not
# depend on the search input's selector, and it matches what a user
# would type if they pasted a Google search URL from the address bar.
GOOGLE_SEARCH_URL = "https://www.google.com/search"

# Navigation and readiness timeouts, in milliseconds. Playwright's
# timeout unit is milliseconds, not seconds — a detail that is easy
# to forget and produces a ten-second page load becoming a
# ten-thousand-second one.
NAVIGATION_TIMEOUT_MS = 30_000
RESULTS_WAIT_TIMEOUT_MS = 15_000

# How long to wait between page navigations. A rapid burst of
# pagination requests is the most common trigger for Google's
# "unusual traffic" CAPTCHA. Two seconds between pages is enough to
# look like a human clicking "Next" rather than a script.
INTER_PAGE_DELAY_SECONDS = 2.0

# The maximum number of pages the script will paginate through, even
# if `max_results` has not been reached. This is a safety rail —
# without it, a query that returns almost nothing but never runs out
# of pages could loop indefinitely.
MAX_PAGES = 10

# Domain-to-platform mapping used to tag each candidate with a
# short platform identifier. The renderer's SourceList uses the tag
# to badge each candidate. The mapping is checked by suffix match —
# `reddit.com` matches `reddit.com`, `www.reddit.com`, and
# `old.reddit.com` — so a subdomain does not need its own entry.
PLATFORM_DOMAINS: dict[str, str] = {
    "reddit.com": "reddit",
    "quora.com": "quora",
    "medium.com": "medium",
    "twitter.com": "twitter",
    "x.com": "twitter",
}

# Google-owned hostnames that appear in the SERP but are never
# organic results — internal Google navigation links, the "People
# also ask" widgets that link to Google-owned properties, image
# searches, etc. Filtering these out keeps the candidate list clean.
GOOGLE_OWNED_HOSTS = frozenset({
    "google.com",
    "googleusercontent.com",
    "googleapis.com",
    "gstatic.com",
    "youtube.com",
    "youtu.be",
})

# Phrases in the page body that reliably indicate a blocking state.
# Google rewrites these strings occasionally, but the phrases below
# have been stable for years and are the standard detection
# heuristics.
CAPTCHA_PHRASES = (
    "unusual traffic",
    "our systems have detected unusual traffic",
)
RATE_LIMIT_PHRASES = (
    "you've reached the end of the internet",
    "please try again later",
)


# =============================================================================
#  URL helpers
# =============================================================================

def _build_search_url(query: str, start: int) -> str:
    """
    Build the Google SERP URL for a query, at the given pagination
    offset.

    The `start` argument is the zero-based index of the first result
    to return on the page — Google's own pagination parameter, seen
    in the recording's page-2 URL as `&start=10`. Page 1 uses
    `start=0`.

    The `hl=en` parameter pins the language to English so that the
    SERP layout matches what the selectors in this module were
    built against. Without it, a user whose Chrome profile is in
    another language would see a SERP with different class names
    and localized button labels.

    `quote_plus` URL-encodes the query — spaces become `+`, and
    any character that would break the URL is escaped.
    """
    q = quote_plus(query)
    return f"{GOOGLE_SEARCH_URL}?q={q}&start={start}&hl=en"


def _detect_platform(url: str) -> str:
    """
    Return a short platform slug for a URL, or "generic" for an
    unknown domain.

    The suffix-match logic is what makes the mapping handle
    subdomains: a URL for `www.reddit.com` has hostname
    `www.reddit.com`, which ends with `.reddit.com` and therefore
    matches the `reddit.com` key. The explicit equality check
    handles the bare-domain case (`reddit.com` itself).
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


def _is_google_owned(host: str) -> bool:
    """
    Return True if a hostname belongs to a Google-owned property.

    Same suffix-match semantics as `_detect_platform`.
    """
    host = host.lower()
    for owned in GOOGLE_OWNED_HOSTS:
        if host == owned or host.endswith("." + owned):
            return True
    return False


def _normalize_result_url(href: str) -> Optional[str]:
    """
    Normalize a result anchor's href into an absolute http(s) URL,
    or return None if the href does not reference an external page.

    Google emits result hrefs in two forms:

      1. Absolute URLs — `https://example.com/page`. This is the
         modern form and is what the recording showed for every
         external result. Returned as-is.

      2. Redirector URLs — `/url?q=https://example.com/page&sa=...`.
         This form was universal on older Google layouts and still
         appears for some result types. The `q=` parameter is the
         actual destination. Unwrapped here.

    Returns None for:

      * Relative URLs that are not `/url?q=` redirects (internal
        SERP navigation, anchor links within the page).
      * `javascript:` pseudo-URLs.
      * Google-owned hosts (checked against the extracted host).
      * Anything that does not parse as a URL.
    """
    if not href:
        return None

    raw = href.strip()
    if not raw or raw.startswith("javascript:"):
        return None

    # ---- Unwrap Google's /url?q= redirector ----
    if raw.startswith("/url?"):
        # The redirector's query string contains the destination in
        # the `q` parameter. Parse it out with a simple prefix-and-
        # split rather than a full query-string parser, because
        # Google does not percent-encode the destination URL
        # consistently and a robust parser is overkill here.
        match = re.search(r"[?&]q=([^&]+)", raw)
        if not match:
            return None
        raw = unquote(match.group(1))

    # ---- Require an absolute http(s) URL ----
    if not (raw.startswith("http://") or raw.startswith("https://")):
        return None

    # ---- Reject Google-owned hosts ----
    try:
        host = urlparse(raw).hostname or ""
    except Exception:
        return None
    if _is_google_owned(host):
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


def _accept_consent_if_present(page: Page) -> bool:
    """
    Detect and dismiss Google's consent interstitial, if it is
    present. Return True if a consent page was detected and the
    dismiss action succeeded, False otherwise (including the case
    where no consent page was present).

    Detection is by heading text — "before you continue to google"
    is the exact phrase Google has used for the consent interstitial
    since 2021 and is present in every variant. Button detection is
    by accessible name, which matches Playwright's own recommended
    selector strategy and survives Google's class-name churn.

    The list of acceptable button labels covers every variant
    Google has shipped: "Accept all", "I agree", "Accept the use of
    cookies", and the country-specific variants.
    """
    body = _page_text_lower(page)
    if "before you continue to google" not in body:
        return False

    for label in (
        "Accept all",
        "I agree",
        "Accept the use of cookies",
        "Agree to all",
    ):
        try:
            button = page.get_by_role("button", name=label, exact=False)
            if button.count() > 0 and button.first.is_visible():
                button.first.click(timeout=5_000)
                log_info("Accepted Google consent interstitial.")
                # Give the page a moment to navigate away from the
                # interstitial before the caller queries it again.
                time.sleep(1.0)
                return True
        except Exception:
            continue

    log_warning(
        "Google consent page detected but no accept button matched. "
        "The SERP may not be reachable."
    )
    return False


def _detect_captcha(page: Page) -> bool:
    """
    Return True if the current page is Google's "unusual traffic"
    CAPTCHA.

    Two detection signals, either of which is sufficient:

      1. The URL contains "/sorry/" — Google redirects CAPTCHA hits
         to `https://www.google.com/sorry/index?continue=...`.
         This is the strongest single signal and is checked first.

      2. The page body contains one of the CAPTCHA phrases. This
         catches the case where the CAPTCHA is embedded in a
         results-looking page rather than on the /sorry/ redirect.
    """
    try:
        if "/sorry/" in page.url:
            return True
    except Exception:
        pass

    body = _page_text_lower(page)
    return any(phrase in body for phrase in CAPTCHA_PHRASES)


def _detect_rate_limit(page: Page) -> bool:
    """
    Return True if the current page is a non-CAPTCHA rate-limit
    notice.

    Checked AFTER `_detect_captcha`, so a page that matches both
    phrase lists is treated as a CAPTCHA (the more specific and more
    actionable case).
    """
    body = _page_text_lower(page)
    return any(phrase in body for phrase in RATE_LIMIT_PHRASES)


# =============================================================================
#  Result extraction
# =============================================================================

def _extract_results_from_page(page: Page) -> list[dict]:
    """
    Return the organic results currently visible on the page.

    Each result is a dict of the shape:

        {
            "url":      "<absolute http(s) URL>",
            "title":    "<the anchor's visible text>",
            "snippet":  "<the visible text of the result's wrapper>",
            "platform": "<reddit | quora | medium | twitter | generic>",
        }

    Extraction proceeds in four steps:

      1. Locate the results container. Google's stable ID for the
         organic results block is `#rso`. If it is absent, the page
         is not a normal SERP and the function returns an empty
         list — the caller's blocking-state checks have already
         handled the cases where this would be expected.

      2. Find every result anchor. The stable structure is
         `<a href="..."><h3>Title</h3></a>`. The selector
         `#rso a:has(h3)` matches exactly those anchors — Playwright's
         `:has()` pseudo-class is the supported way to express this
         relationship. Google has never shipped a version of the
         SERP where the result's title was not inside an `<h3>`
         wrapped by the result's anchor.

      3. For each anchor, extract the href and the title. The href
         is normalized via `_normalize_result_url` — see that
         function for the redirector-unwrapping logic. The title is
         the `<h3>`'s inner text.

      4. Derive the snippet from the anchor's surrounding container.
         Walking up to the nearest `<div>` that contains the anchor
         gives a wrapper that holds both the title and the URL
         display line; its inner text is the snippet-like summary
         Google shows. The walk is bounded (three levels up) — a
         longer walk would reach the entire results container and
         produce a giant snippet.

    Duplicates by URL are removed at the end via `core.utils.dedup`.
    """
    results: list[dict] = []

    try:
        # ---- 1. Locate the results container ----
        container = page.locator("#rso")
        if container.count() == 0:
            return results

        # ---- 2. Find every result anchor ----
        anchors = container.locator("a:has(h3)")
        count = anchors.count()

        for i in range(count):
            try:
                anchor = anchors.nth(i)

                # ---- 3. href + title ----
                href = anchor.get_attribute("href") or ""
                url = _normalize_result_url(href)
                if not url:
                    continue

                h3 = anchor.locator("h3").first
                title = (h3.inner_text() or "").strip()
                if not title:
                    # A result without a visible title is almost
                    # always an ad or a widget — skip it rather than
                    # produce a candidate with an empty title.
                    continue

                # ---- 4. snippet from the nearest container ----
                # The wrapper is `anchor.locator("xpath=ancestor::div[1]")`,
                # which is the anchor's immediate parent div.
                # Google wraps each result in a single div at this
                # level on every SERP layout we have seen.
                snippet = ""
                try:
                    parent = anchor.locator("xpath=ancestor::div[1]")
                    if parent.count() > 0:
                        raw_snippet = parent.first.inner_text() or ""
                        # The wrapper's text includes the title and
                        # the URL display line. Strip the title from
                        # the front so the snippet starts at the
                        # first character that is not the title.
                        snippet = raw_snippet
                        if snippet.startswith(title):
                            snippet = snippet[len(title):]
                        snippet = snippet.strip()
                        # Bound the snippet length — a runaway
                        # wrapper (a "People also ask" panel, a
                        # knowledge card) can produce thousands of
                        # characters, and the renderer does not need
                        # more than a line or two for the preview.
                        if len(snippet) > 500:
                            snippet = snippet[:500].rstrip() + "…"
                except Exception:
                    # A missing snippet is fine — the candidate still
                    # has a URL and a title, which is what the
                    # extraction stage actually needs.
                    snippet = ""

                results.append({
                    "url": url,
                    "title": title,
                    "snippet": snippet,
                    "platform": _detect_platform(url),
                })

            except Exception:
                # A single malformed result must not abort the
                # whole page. Skip it and move to the next anchor.
                continue

    except Exception as exc:
        log_warning(f"Result extraction failed: {exc}")
        return []

    # ---- Dedup by URL, preserving first-seen order ----
    deduped = dedup(results, key=lambda r: r["url"])
    return deduped


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
    Run a Google search and emit the candidate list as markers.

    See the module docstring for the full flow. Returns an integer
    exit code:

        0   – search completed, at least one candidate found
        1   – search failed (no candidates, or a navigation error)
        99  – user clicked Skip on a blocking prompt
        100 – user clicked Stop on a blocking prompt

    The 99/100 codes come from `core.output.manual_action_required`
    calling `sys.exit(...)` directly; this function does not catch
    them. When the function returns normally, the code is 0 or 1.

    Parameters (keyword-only by convention, matched by `main.py`'s
    call site):

        query       – The search string. Normally the topic's title.
        keywords    – The user's keywords. Carried in the marker
                      payload for the GUI's display, but do NOT
                      affect the search itself — the search is on
                      the title alone, per the plan's user journey.
        max_results – Upper bound on the number of candidates the
                      search should collect. The function may return
                      fewer if Google runs out of results.
        topic_id    – The topic's id. Included in every marker so
                      the renderer can route the candidates to the
                      correct store entry.
        port        – The Chrome CDP debug port to connect to.

    The function is fully synchronous — Playwright's sync API is
    used, matching `core.browser`'s implementation. It never runs
    under a thread other than the one that started the Playwright
    driver.
    """
    if not query.strip():
        log_error("search: empty query — nothing to search for.")
        return 1

    log_info(f"Searching Google for: {query!r}")

    # ---- 1. Connect to the browser ----
    try:
        browser = connect_to_chrome(port)
    except Exception as exc:
        log_error(f"Could not connect to Chrome on port {port}: {exc}")
        return 1

    # A CDP-attached browser has exactly one persistent context —
    # the default context created by Chrome itself. Using
    # `browser.contexts[0]` is correct for this connection mode;
    # `browser.new_context()` would create a SEPARATE isolated
    # context that does not share cookies with the user's Chrome
    # window, breaking the DeepSeek session persistence the app
    # relies on elsewhere.
    try:
        if not browser.contexts:
            log_error("Connected to Chrome but it has no browser context.")
            return 1
        context = browser.contexts[0]
    except Exception as exc:
        log_error(f"Could not access the browser context: {exc}")
        return 1

    # Reuse the existing page if one is open, otherwise create one.
    # The user's Chrome typically has a tab open (the app opens a
    # window for the user to log into DeepSeek), and reusing it is
    # less disruptive than spawning a new tab on every search.
    try:
        page: Page = (
            context.pages[0] if context.pages else context.new_page()
        )
    except Exception as exc:
        log_error(f"Could not obtain a browser page: {exc}")
        return 1

    # Cap the number of results at Google's per-page maximum (10 by
    # default) multiplied by the maximum pages the script will
    # paginate through. A caller that asks for 500 candidates on a
    # 10-page-cap search will receive whatever 10 pages yields, and
    # a log line reports the cap.
    per_page = 10
    hard_cap = per_page * MAX_PAGES
    effective_max = min(max_results, hard_cap)
    if max_results > hard_cap:
        log_warning(
            f"Requested {max_results} candidates; the search will "
            f"collect at most {hard_cap} "
            f"({MAX_PAGES} pages × {per_page} results)."
        )

    # ---- 2. Paginated collection loop ----
    collected: list[dict] = []
    pages_fetched = 0

    for page_index in range(MAX_PAGES):
        # ---- Checkpoint: honour a pending Skip/Stop ----
        # Checked BEFORE each page navigation so a user who clicked
        # Stop after page 1 does not wait for page 2 to load. The
        # checkpoint raises SystemExit(99) or SystemExit(100) — this
        # function does not catch it, and main.py classifies it.
        cmd = checkpoint_check("google", "search_page")
        if cmd == "skip":
            log_info("Search skipped by user.")
            sys.exit(EXIT_SKIPPED)
        if cmd == "stop":
            log_info("Search stopped by user.")
            sys.exit(EXIT_STOPPED)

        start = page_index * per_page
        url = _build_search_url(query, start)

        log_info(f"Fetching results page {page_index + 1} (start={start})")

        # ---- 2a. Navigate ----
        try:
            page.goto(
                url,
                timeout=NAVIGATION_TIMEOUT_MS,
                wait_until="domcontentloaded",
            )
        except Exception as exc:
            log_warning(f"Navigation to search page {page_index + 1} failed: {exc}")
            break

        # ---- 2b. Wait for a terminal state ----
        # The page settles into one of four states: results present,
        # consent interstitial, CAPTCHA, or rate-limit. The
        # `wait_for_selector` below waits up to
        # RESULTS_WAIT_TIMEOUT_MS for the results container. If the
        # container does not appear in time, the caller falls through
        # to the blocking-state checks — which distinguish "the page
        # is a consent interstitial" from "the page loaded but has
        # no results" (a query with zero hits).
        try:
            page.wait_for_selector(
                "#rso",
                timeout=RESULTS_WAIT_TIMEOUT_MS,
            )
        except Exception:
            # No results container appeared. Check the blocking
            # states before declaring the page empty.
            pass

        # ---- 2c. Consent interstitial ----
        # Handled first because it is the ONLY blocking state the
        # script can resolve on the user's behalf — the accept
        # button is not a CAPTCHA, it is a form.
        if _accept_consent_if_present(page):
            # Retry the current page after the consent flow
            # completes. The interstitial redirected away from the
            # search URL, so a re-navigation is required.
            try:
                page.goto(
                    url,
                    timeout=NAVIGATION_TIMEOUT_MS,
                    wait_until="domcontentloaded",
                )
                page.wait_for_selector(
                    "#rso",
                    timeout=RESULTS_WAIT_TIMEOUT_MS,
                )
            except Exception as exc:
                log_warning(f"Consent resolution did not yield results: {exc}")
                break

        # ---- 2d. CAPTCHA ----
        # A CAPTCHA blocks the search entirely. `captcha_required`
        # emits the CAPTCHA_REQUIRED marker, opens the GUI modal,
        # and blocks until the user solves it (or exits with
        # 99/100). On resume, the script re-reads the page.
        if _detect_captcha(page):
            log_warning("Google CAPTCHA detected — waiting for user to solve.")
            captcha_required(
                site="google",
                step=f"search_page_{page_index + 1}",
                prompt=(
                    "Google is showing an 'unusual traffic' check. "
                    "Solve it in the Chrome window, then click Continue."
                ),
            )
            # After the user solves the CAPTCHA and clicks Continue,
            # the page in the browser is the results page Google
            # redirected to. Extract from it directly.
            # (If the user clicks Skip/Stop instead, the call above
            # does not return — it exits the process with 99/100.)

        # ---- 2e. Rate-limit notice ----
        # A rate-limit hit is not solvable by the user, so we log
        # and stop the search. The collected candidates (if any)
        # are still returned — a partial result is better than no
        # result, and the caller can decide whether to rerun with
        # DuckDuckGo.
        if _detect_rate_limit(page):
            log_warning(
                "Google rate-limit notice detected. Stopping search "
                "with the candidates collected so far."
            )
            break

        # ---- 2f. Extract ----
        page_results = _extract_results_from_page(page)
        if not page_results:
            log_info(
                f"No results on page {page_index + 1}. Stopping search."
            )
            break

        pages_fetched += 1
        collected.extend(page_results)

        # Dedup the FULL collected list after each page — a
        # candidate may appear on multiple pages, and keeping the
        # list deduped means the emitted count in the
        # SEARCH_PROGRESS marker is accurate.
        collected = dedup(collected, key=lambda r: r["url"])

        # ---- 2g. Emit progress ----
        emit_marker(
            MARKER_SEARCH_PROGRESS,
            {
                "topicId": topic_id,
                "page": page_index + 1,
                "found": len(collected),
                "requested": effective_max,
            },
        )
        log_info(
            f"Page {page_index + 1}: +{len(page_results)} candidates "
            f"({len(collected)} total)"
        )

        # ---- 2h. Stop conditions ----
        if len(collected) >= effective_max:
            log_info(f"Reached target of {effective_max} candidates.")
            break

        # ---- 2i. Look for a Next link before paginating ----
        # If Google has not rendered a `#pnnext` link, there is no
        # page 2 and no point in issuing another navigation. The
        # check is done here (before the delay) so the script exits
        # promptly when it has reached the end of the results.
        try:
            next_link = page.locator("#pnnext")
            if next_link.count() == 0 or not next_link.first.is_visible():
                log_info("No 'Next' link on the SERP — end of results.")
                break
        except Exception:
            # A page that cannot be queried for the Next link is
            # treated as the end of results. The alternative —
            # blindly paginating — would produce a Google
            # rate-limit hit on the very next request.
            break

        # ---- 2j. Pace the next request ----
        # A rapid burst of pagination is the most common CAPTCHA
        # trigger. Two seconds between pages is a conservative
        # baseline.
        time.sleep(INTER_PAGE_DELAY_SECONDS)

    # ---- 3. Trim to the requested count ----
    # `collected` may exceed `effective_max` on the last page — the
    # loop stops after appending a page's results, not within them.
    # The trim produces the list the caller actually asked for.
    final_results = collected[:effective_max]

    if not final_results:
        log_warning("Search returned no candidates.")
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

    log_info(
        f"Search complete: {len(final_results)} candidates "
        f"from {pages_fetched} page(s)."
    )

    # ---- 4. Emit the final candidate list ----
    # The payload carries the full list of candidate dicts in
    # Google's rank order. The renderer's SourceList maps directly
    # over the list — no further transformation required.
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