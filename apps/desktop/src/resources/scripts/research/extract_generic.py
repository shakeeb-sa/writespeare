#!/usr/bin/env python3
"""
research/extract_generic.py — generic HTML-page extractor.

The fallback extractor the pipeline uses for every URL whose domain
is not one of the platform-specific cases (`reddit.com`,
`quora.com`, `medium.com`, `twitter.com` / `x.com`). It is the most
commonly-called extractor in practice — most of the web is "some
page with an article on it", and this module is what turns that
page into a doc file.

The extraction itself is done by `core.extractor.extract_main_content`,
which runs trafilatura and falls back to a BeautifulSoup DOM walk.
This module's job is narrower: get the page loaded in the shared
Playwright browser, read its HTML, call the extractor, and package
the result in the shape `extract_dispatch.py` expects.

Why navigation is bounded:

    `page.goto(...)` has a timeout, and a page that does not settle
    within it — a slow server, a hung CDN, an infinite redirect
    loop — must not block the batch. The dispatcher catches
    exceptions from this module and treats them as per-URL
    failures; the timeout is what makes a hung page produce an
    exception in bounded time rather than a hang that only a user
    can interrupt.

    The `wait_until="domcontentloaded"` choice (rather than
    `"networkidle"` or `"load"`) is deliberate. `"load"` waits for
    every subresource — images, fonts, tracking pixels — many of
    which are irrelevant to the article body and some of which
    hang on slow networks. `"networkidle"` waits for the network
    to be quiet for 500ms, which is a heuristic that can time out
    on a page with a chat widget or analytics beacon firing
    periodically. `"domcontentloaded"` fires as soon as the DOM is
    ready, which is when trafilatura can do its work. The
    extractor does not need images, CSS, or fonts to extract text.

    A short post-DOM delay (see `_POST_LOAD_DELAY_SECONDS`) gives
    client-side JavaScript a moment to render content into the DOM
    before the HTML is read. Many sites are server-rendered and do
    not need the delay; some popular ones are not, and reading the
    HTML immediately after `domcontentloaded` on those pages would
    get the pre-render skeleton rather than the article.

Why the title is read separately from the content:

    trafilatura extracts the body text; it does not return the
    page's title. The doc file's frontmatter needs the title, and
    the title the user's browser shows is the `<title>` element's
    text (or, occasionally, the `<h1>` when `<title>` is missing
    or unhelpful). This module reads both and prefers whichever is
    present and non-empty.

    The `<title>` element is the fallback because it always exists
    on a valid HTML page. The `<h1>` is preferred when present
    because it is usually the article's actual headline — a page
    titled "How to garden in a tiny apartment | The Times" has a
    `<title>` that carries the site name, but the `<h1>` is just
    the headline. The doc file's title is meant to be the latter.

Failure modes, and how each is handled:

    1. Navigation timeout (the `page.goto` call raises Playwright's
       `TimeoutError`). Return `None`. The dispatcher treats the
       URL as failed and continues.

    2. Navigation error (a DNS failure, a connection refused, a
       redirect to an invalid protocol). `page.goto` raises a
       `playwright.sync_api.Error` subclass. Return `None`.

    3. Page loaded but extraction returned empty. The page is a
       login wall, a paywall, a "this page is not available" shell,
       or a JavaScript-only SPA that rendered nothing. Return
       `None` — the dispatcher records the failure and moves on.

    4. Anything else — a bug in this module, an unexpected
       Playwright state, a read of `page.content()` that fails.
       The exception propagates to the dispatcher, which catches
       everything. Returning `None` here would hide the bug; the
       current behaviour lets the dispatcher's warning log name
       the exception, which is what a developer needs to see.

What this module does NOT do:

    * It does not detect paywalls or login walls. If a page loads
      and has content, trafilatura extracts what it can find; if
      the page is entirely a paywall interstitial with no body
      text, trafilatura returns empty and this module returns
      `None`. The distinction between "the article was truncated
      by a paywall" and "there was no article" is a
      content-quality question that the platform-specific
      extractors (Medium, for example) are better positioned to
      detect — this module treats both cases the same.

    * It does not scroll, click, or interact with the page. Some
      sites lazy-load content on scroll, and some hide content
      behind a "Read more" button. This module does not attempt
      any of that — the plan's user journey has the user manually
      interacting with the browser when a page needs it (the
      captcha modal and manual-action modal are the mechanisms
      for that). A future session that adds automatic
      scroll-to-load would add it here, with the caveat that the
      interaction must be safe against every site (an aggressive
      auto-scroll on a site with infinite scroll would never
      terminate).

    * It does not emit markers. Extraction progress is the
      dispatcher's job — the dispatcher wraps the call to
      `extract_url` in the `EXTRACT_PROGRESS` marker emission, so
      this module stays a pure "URL → content" function.

Dependencies: Python stdlib + playwright + the sibling `core/`
package.
"""

import time
from typing import Optional

from playwright.sync_api import Page, TimeoutError as PlaywrightTimeoutError

from core.extractor import extract_main_content
from core.utils import log_debug, log_warning


# =============================================================================
#  Constants
# =============================================================================

# Navigation timeout, in milliseconds. Playwright's unit. Fifteen
# seconds is generous enough that a slow-loading article page on a
# marginal connection still succeeds, and short enough that a hung
# page does not stall the batch for long. The plan's user journey
# has the extraction batch run as a foreground operation with a
# visible progress panel; a page that takes more than fifteen
# seconds to reach `domcontentloaded` is not a page the user wants
# to wait for.
NAVIGATION_TIMEOUT_MS = 15_000

# The pause after `domcontentloaded` before the HTML is read. Some
# pages need a moment for client-side rendering to populate the
# article body. The delay is deliberately short — long enough to
# let a synchronous or microtask-deferred render happen, short
# enough that the batch does not visibly slow down on pages that
# render server-side (the common case). A page that renders via a
# network request after DOMContentLoaded (a fetch that populates
# the article from a JSON endpoint) would need a longer wait or a
# `wait_for_selector` on the article container; that case is not
# currently handled.
POST_LOAD_DELAY_SECONDS = 0.6

# Minimum content length, in characters, for an extraction to be
# considered successful. A page that produces a hundred characters
# of trafilatura output is almost certainly a shell — a login
# prompt, a "page not found" message, a paywall interstitial with
# no article. The threshold is set low enough that a genuinely
# short article (a news brief of a few hundred words) passes, and
# high enough that a page which returned navigation chrome as
# "content" is rejected.
#
# Five hundred characters is roughly seventy words of English
# prose — comfortably below any legitimate article and comfortably
# above any boilerplate message a site serves in place of one.
MIN_CONTENT_LENGTH = 500


# =============================================================================
#  Public entry point
# =============================================================================

def extract_url(url: str, page: Page) -> Optional[dict]:
    """
    Navigate the shared page to `url`, extract its main content,
    and return `{"title": str, "content": str}` on success.

    See the module docstring for the full rationale of every
    decision. The contract with the caller (`extract_dispatch.py`)
    is:

        * Return a dict with `title` and `content` string fields on
          success. The `content` field is non-empty Markdown. The
          `title` field may be an empty string if the page had no
          title (a rare case; the dispatcher handles an empty
          title by using `"untitled"` as the slug fallback).

        * Return `None` on any recoverable failure — a navigation
          timeout, a network error, an extraction that produced
          nothing, an extraction that produced less than the
          minimum viable content length.

        * Let unexpected exceptions propagate. The dispatcher's
          broad `except Exception` catches them and logs a
          warning naming the exception, which is more useful for
          a developer than a silent `None` return would be.

    Args:
        url:  The absolute URL to extract.
        page: The shared Playwright page. The caller is responsible
              for the page's existence and for its association with
              a Chrome instance; this function only drives it.

    Returns:
        `{"title": str, "content": str}` on success, or `None` on
        a recoverable failure.
    """
    log_debug(f"Generic extractor: navigating to {url}")

    # ---- Navigate ----
    # The `page.goto` call can raise `PlaywrightTimeoutError` (the
    # page did not reach `domcontentloaded` within the timeout) or
    # another `playwright.sync_api.Error` subclass (a DNS failure,
    # a connection error, a redirect to an unsupported protocol).
    # Both are recoverable per-URL failures.
    try:
        page.goto(
            url,
            timeout=NAVIGATION_TIMEOUT_MS,
            wait_until="domcontentloaded",
        )
    except PlaywrightTimeoutError:
        log_warning(f"Navigation timed out after {NAVIGATION_TIMEOUT_MS}ms: {url}")
        return None
    except Exception as exc:
        # Catch the other Playwright errors (network failures,
        # invalid URLs reaching this point, etc.). The dispatcher
        # would also catch these, but catching here means the log
        # line names the URL and the extractor, which is more
        # useful than the dispatcher's generic "extractor raised"
        # message.
        log_warning(f"Navigation failed for {url}: {exc}")
        return None

    # ---- Let client-side JS settle ----
    # See `POST_LOAD_DELAY_SECONDS` for the rationale.
    time.sleep(POST_LOAD_DELAY_SECONDS)

    # ---- Read the page ----
    # `page.content()` returns the DOM's current serialized HTML,
    # after any client-side mutations. This is what trafilatura
    # needs; the alternative (`page.evaluate("document.documentElement.outerHTML")`)
    # would be equivalent but slower, and Playwright's own
    # `page.content()` is the documented method.
    try:
        html = page.content()
    except Exception as exc:
        log_warning(f"Could not read page content for {url}: {exc}")
        return None

    if not html or len(html) < 100:
        # A page whose entire HTML is a hundred characters is not a
        # page — it is an empty response or a redirect stub.
        log_debug(f"Page HTML is too short ({len(html)} chars): {url}")
        return None

    # ---- Extract the title ----
    # Prefer the `<h1>` (the article's headline) over the `<title>`
    # (which usually carries the site name as a suffix). Fall back
    # to the `<title>` when `<h1>` is absent. See the module
    # docstring for the full reasoning.
    title = _read_title(page)

    # ---- Extract the content ----
    # The URL is passed to `extract_main_content` so trafilatura
    # can use any site-specific rules it has for the domain, and
    # so relative links in the content can be resolved against the
    # page's base URL.
    content = extract_main_content(html, url)

    if not content or len(content) < MIN_CONTENT_LENGTH:
        log_debug(
            f"Extraction produced too little content "
            f"({len(content) if content else 0} chars): {url}"
        )
        return None

    log_debug(
        f"Generic extractor succeeded for {url} "
        f"({len(content)} chars, title={title!r})"
    )
    return {"title": title, "content": content}


# =============================================================================
#  Private: title extraction
# =============================================================================

def _read_title(page: Page) -> str:
    """
    Return the best available title for the current page.

    Preference order:

      1. The first visible `<h1>` element's text. This is the
         article's headline on almost every blog, news site, and
         documentation page. It does not carry the site name, so
         the doc file's title reads as the article's own title
         rather than as "The Article | The Site".

      2. The `<title>` element's text, with a common site-name
         suffix stripped. The suffix patterns this strips are the
         ones every site uses — `" | Site"`, `" - Site"`,
         `" – Site"`, `" — Site"`, and the same separators with
         nothing after them. The strip only fires when the suffix
         is the LAST segment of the title and is preceded by one
         of those separators; a title that is `"A | B | C"` keeps
         everything up to the first separator, which is the
         article-title portion in the common case.

      3. An empty string. The dispatcher's `_build_doc_slug`
         handles the empty-title case with an `"untitled"`
         fallback.

    The function never raises. A page whose DOM cannot be queried
    (a navigation that is mid-flight when this is called — which
    should not happen given the `time.sleep` above, but could if
    the page has started a second navigation) returns the empty
    string.

    Args:
        page: The Playwright page whose title to read.

    Returns:
        The best title available, or the empty string.
    """
    # ---- 1. `<h1>` ----
    try:
        h1_locator = page.locator("h1").first
        if h1_locator.count() > 0:
            h1_text = (h1_locator.inner_text() or "").strip()
            if h1_text:
                return _clean_title(h1_text)
    except Exception:
        # A page whose DOM is mid-mutation can raise on a locator
        # query. Fall through to the `<title>` check.
        pass

    # ---- 2. `<title>` ----
    try:
        title_text = (page.title() or "").strip()
        if title_text:
            return _clean_title(title_text)
    except Exception:
        pass

    # ---- 3. Nothing ----
    return ""


def _clean_title(title: str) -> str:
    """
    Strip a site-name suffix from a page title.

    The function splits on the four common separators (`|`, `-`,
    `–`, `—`) surrounded by at least one space, and returns the
    first segment. This handles the two most common title patterns
    on the web:

        "How to garden in a tiny apartment | The Times"
            → "How to garden in a tiny apartment"

        "How to garden in a tiny apartment - The Times Blog"
            → "How to garden in a tiny apartment"

    It does NOT strip when the separator is inside the title
    itself — for example, a title of `"Cooking: A Guide"` has a
    colon, not one of the four separators, so it is returned
    unchanged. A title of `"Renters - how to garden"` would
    incorrectly become `"Renters"` — a risk, but a smaller one
    than the site-suffix pollution that the strip removes on
    almost every other page.

    The result is always non-empty if the input was non-empty — a
    title that is entirely a separator-plus-suffix (a page whose
    `<title>` is just `" | The Times"`) returns the empty string,
    which the caller interprets as "no title".

    The function also enforces a maximum length — a title longer
    than 300 characters is truncated at the nearest word boundary
    with an ellipsis. This matches the backend schema's
    `title: maxlength(500)` constraint with margin, and keeps the
    doc file's frontmatter readable.
    """
    separators = (" | ", " - ", " – ", " — ")
    for separator in separators:
        if separator in title:
            title = title.split(separator, 1)[0].strip()
            break

    # Length cap.
    if len(title) > 300:
        title = title[:300].rstrip()
        # Trim to the last space so the ellipsis does not cut a word.
        last_space = title.rfind(" ")
        if last_space > 250:
            title = title[:last_space]
        title = title + "…"

    return title


# =============================================================================
#  Default export
# =============================================================================

__all__ = [
    "extract_url",
]