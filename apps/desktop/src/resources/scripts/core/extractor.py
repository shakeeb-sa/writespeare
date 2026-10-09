#!/usr/bin/env python3
"""
core/extractor.py — content extraction for the WriteSpeare pipeline.

Turns a raw HTML page into clean Markdown: boilerplate-stripped,
main-content-focused, and structurally preserved. Every
platform-specific extractor (`research/extract_*.py`) calls into
this module's `extract_main_content` after it has fetched a page —
either directly (via Playwright, for pages that need a real browser)
or from cache (via `requests`, for static pages).

The primary extractor is trafilatura. It is the best general-purpose
content extractor available in Python: it strips navigation, ads,
footers, and sidebars; it preserves heading structure; and it
outputs Markdown natively (`output_format="markdown"`). Its one
weakness is that it can occasionally return an empty string on
pages whose structure it cannot parse — a niche login-wall or a
minimalist single-column blog with no `<article>` marker. The
fallback handles that case.

The fallback is a BeautifulSoup-based DOM walker. It is not as
smart as trafilatura — it does not attempt boilerplate detection —
but it produces readable Markdown from the block-level elements of
the page's main container (`<article>`, `<main>`, or `<body>`).
For a page where trafilatura failed, the fallback's output is
usually better than nothing.

What this module does NOT do:

  * It does not fetch pages. The caller (a feature script) is
    responsible for getting the HTML — via Playwright for a real
    browser, via `requests` for a static page. This module's input
    is HTML as a string, and its output is Markdown as a string.
    That separation is what keeps the extractor a pure function:
    no network, no file I/O, no side effects.

  * It does not parse platform-specific structures. Reddit threads
    (post + comments), Quora answers (top answer + comments), and
    Medium articles (body + paywall detection) all need DOM walks
    that this general-purpose extractor cannot provide. Those live
    in the sibling `research/extract_*.py` modules. This module is
    the shared primitive they fall back to when their own
    platform-specific extraction fails.

  * It does not detect paywalls or login walls. Whether a page is
    worth keeping is a decision the caller makes — the plan's
    `paywall_domains.txt` and `exclude_sites.csv` config files are
    the user-facing mechanism, and the platform-specific extractors
    are where the checks belong. This module extracts whatever
    content exists on the page it was given.

  * It does not emit markers. Extraction is a pure function of
    HTML → Markdown. The progress markers the GUI listens for
    (`EXTRACT_PROGRESS`, `EXTRACT_DONE`) are emitted by the
    dispatcher (`research/extract_dispatch.py`) around the call to
    this module, not by this module itself.

Dependencies: Python stdlib + trafilatura + beautifulsoup4 + the
sibling `core.utils` module. All declared in `requirements.txt`.
"""

import re

import trafilatura
from bs4 import BeautifulSoup

from core.utils import log_debug, log_warning


# =============================================================================
#  Constants
# =============================================================================

# The block-level HTML tags the BeautifulSoup fallback walks when it
# needs to convert a page's DOM into Markdown. Each one has a
# corresponding Markdown treatment in `_fallback_extract` below.
#
# The list is deliberately small. It covers the tags that carry
# article text on the overwhelming majority of web pages. It
# excludes tags that would produce noise (`div`, `span` — too
# generic), tags that are already stripped before the walk
# (`script`, `style`, `nav`), and tags whose content is not
# article text (`table`, `form` — handled separately or skipped).
BLOCK_TAGS = (
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "p",
    "blockquote",
    "pre",
    "li",
    "figcaption",
)

# The elements removed from the DOM before the fallback walk. Each
# one is a source of text that is not article content: scripts and
# styles have no visible text; navigation, header, and footer carry
# site chrome; aside carries sidebars and related links; iframe and
# form carry interactive content that does not belong in a doc file.
UNWANTED_TAGS = (
    "script",
    "style",
    "nav",
    "header",
    "footer",
    "aside",
    "noscript",
    "iframe",
    "form",
    "svg",
)


# =============================================================================
#  Public: the primary extractor
# =============================================================================

def extract_main_content(html: str, url: str = "") -> str:
    """
    Extract the main article body from an HTML page and return it as
    clean Markdown.

    The function is a pure transformation: given the same HTML and
    URL, it produces the same Markdown, with no network access, no
    file I/O, and no side effects. The caller is responsible for
    getting the HTML in the first place.

    The `url` argument is optional. When provided, trafilatura uses
    it to look up site-specific extraction rules (its maintainers
    curate a small set of rules for common domains — news sites,
    blogs, and a few others) and to resolve relative links to
    absolute ones. When omitted, trafilatura's general-purpose
    heuristics run instead. Both paths work; providing the URL
    produces slightly higher-quality output on the sites the rules
    cover.

    Flow:

      1. Guard against empty input — an empty string is returned
         as-is.

      2. Run trafilatura with `output_format="markdown"`. If it
         returns a non-empty string, normalize it and return.

      3. If trafilatura raised, returned empty, or returned
         whitespace-only text, run the BeautifulSoup fallback.

      4. If the fallback also returns empty, return the empty
         string. The caller's contract is that an empty result
         means "no content could be extracted" — the caller is
         expected to log this and either skip the URL or mark it
         as failed.

    Never raises for a malformed page. trafilatura's parser is
    tolerant, and the fallback wraps its own DOM operations in a
    broad try/except so that a page with an unusual structure
    cannot crash the caller.

    Args:
        html: The page's HTML source, as a decoded string.
        url:  The page's absolute URL, optional. Used by trafilatura
              for site rules and link resolution.

    Returns:
        The extracted content as Markdown, or an empty string if
        nothing could be extracted.
    """
    if not html:
        return ""

    # ---- Primary: trafilatura ----
    try:
        markdown = trafilatura.extract(
            html,
            url=url if url else None,
            output_format="markdown",
            include_comments=False,
            include_tables=True,
        )
        if markdown and markdown.strip():
            normalized = normalize_markdown(markdown)
            if normalized:
                log_debug(
                    f"trafilatura extracted {len(normalized)} chars"
                )
                return normalized
    except Exception as exc:
        # trafilatura is documented to raise on unusual inputs.
        # The fallback exists precisely for this case; logging at
        # debug level keeps the log clean when the fallback
        # produces a good result (the common case for a
        # trafilatura miss).
        log_debug(f"trafilatura raised: {exc}")

    # ---- Fallback: BeautifulSoup ----
    log_debug("trafilatura returned empty; using BeautifulSoup fallback")
    try:
        fallback = _fallback_extract(html)
        if fallback and fallback.strip():
            normalized = normalize_markdown(fallback)
            if normalized:
                log_debug(
                    f"fallback extracted {len(normalized)} chars"
                )
                return normalized
    except Exception as exc:
        log_warning(f"BeautifulSoup fallback raised: {exc}")

    # ---- Nothing worked ----
    log_debug("both extractors returned empty")
    return ""


# =============================================================================
#  Public: Markdown normalization
# =============================================================================

def normalize_markdown(text: str) -> str:
    """
    Collapse the small formatting irregularities that both extractors
    can produce.

    The transformation:

      * Strips trailing whitespace from each line. Trailing
        whitespace is invisible in rendered Markdown but occupies
        bytes in the doc file and confuses a diff.

      * Collapses runs of three or more newlines into exactly two.
        In Markdown, two newlines mark a paragraph boundary; three
        or more are equivalent to two at render time but produce
        visual gaps in a source-file diff.

      * Strips leading and trailing whitespace from the whole
        document. A leading newline in a `.md` file renders
        identically to no newline, but a file that starts with a
        blank line looks like an editing mistake.

    Idempotent: calling the function on its own output returns the
    same output. Callers can therefore normalize defensively without
    worrying about double-processing.

    Args:
        text: The Markdown text to normalize.

    Returns:
        The normalized Markdown. Empty string for empty input.
    """
    if not text:
        return ""

    # Strip trailing whitespace per line.
    lines = [line.rstrip() for line in text.split("\n")]
    text = "\n".join(lines)

    # Collapse 3+ newlines into exactly 2.
    text = re.sub(r"\n{3,}", "\n\n", text)

    # Strip document-level leading/trailing whitespace.
    return text.strip()


# =============================================================================
#  Public: word count
# =============================================================================

def count_words(text: str) -> int:
    """
    Count the words in a text.

    "Word" is defined as any run of non-whitespace characters. The
    definition matches what a word processor reports for English
    prose: "don't" is one word, "well-known" is one word, "a b" is
    two. It does NOT try to strip Markdown syntax — a heading line
    `## The start` counts the `##` as a word.

    For the doc file's metadata, this is close enough. The number is
    used by the writer step to decide how many doc files it can
    paste before exhausting a token budget, and by the pipeline's
    "N documents saved · X words total" summary line. The
    single-word imprecision of counting `##` is a rounding error
    against a document of hundreds of words.

    If a future session needs a precise word count that strips
    Markdown, the change is a Markdown-aware tokenizer — a
    significant piece of work for a marginal accuracy gain. The
    simpler definition is documented here so a reader knows what
    the number means.

    Args:
        text: The text whose words should be counted.

    Returns:
        The word count. Zero for empty input.
    """
    if not text:
        return 0
    return len(re.findall(r"\S+", text))


# =============================================================================
#  Public: frontmatter stripping
# =============================================================================

def strip_frontmatter(text: str) -> str:
    """
    Remove leading YAML frontmatter from a text, if present.

    A Markdown file can start with a YAML frontmatter block
    delimited by two `---` lines:

        ---
        title: How to garden
        author: Jane
        ---
        # The article begins here

    This function strips such a block from the front of the input
    and returns the remaining text. If no frontmatter is present —
    the input does not start with `---`, or the block is not closed
    by a second `---` — the input is returned unchanged.

    The function is used by two call sites:

      * `research/extract_*.py` — some source pages already contain
        a frontmatter block (a site that serves Markdown directly,
        or a page the pipeline is re-processing). Stripping it
        before extraction prevents the frontmatter from being
        mistaken for content.

      * `writer/deepseek_writer.py` — the writer reads doc files
        whose frontmatter carries the doc's metadata (URL, author,
        word count). When it builds the paste-in payload, the
        frontmatter is stripped so the model sees only the body
        text.

    The regex is non-greedy (`.*?`) so a document with multiple
    `---` separators (an HR in the body) only has its FIRST block
    stripped. The `text.startswith("---")` guard ensures the
    function does not accidentally strip a horizontal rule in the
    middle of a document that does not start with frontmatter.

    Args:
        text: The text to strip.

    Returns:
        The text with any leading frontmatter removed.
    """
    if not text.startswith("---"):
        return text

    # The closing `---` must be on its own line. The `.*?` is
    # non-greedy so the regex finds the FIRST closing line, not the
    # last.
    match = re.match(r"^---\s*\n.*?\n---\s*\n", text, re.DOTALL)
    if match is None:
        # No closing `---` was found. The document is not
        # frontmatter — it starts with an HR or a literal `---`.
        return text

    return text[match.end():]


# =============================================================================
#  Private: BeautifulSoup fallback extractor
# =============================================================================

def _make_soup(html: str) -> BeautifulSoup:
    """
    Build a BeautifulSoup document, preferring the lxml parser and
    falling back to the stdlib html.parser if lxml is not available.

    `lxml` is faster and more tolerant of malformed HTML, which
    matters for the fallback path — a page that has already
    defeated trafilatura is more likely to have structural
    irregularities than a page that has not. The `html.parser`
    fallback is slower but always available (it is part of
    BeautifulSoup's own dependencies).

    The function is a thin wrapper rather than an inline call
    because the two call sites in this module (the DOM walk and any
    future needs) must use the same parser choice — a difference
    there would produce two subtly different soups from the same
    HTML.
    """
    try:
        return BeautifulSoup(html, "lxml")
    except Exception:
        # lxml is not installed, or it rejected the input. The
        # stdlib parser is slower but reliable.
        return BeautifulSoup(html, "html.parser")


def _fallback_extract(html: str) -> str:
    """
    Convert a page's DOM into Markdown by walking its block-level
    elements.

    The transformation is deliberately simple: strip the unwanted
    chrome (scripts, styles, nav, header, footer, aside), find the
    page's main container (`<article>`, `<main>`, or `<body>` in
    that preference order), and walk the block-level elements
    inside it. Each element becomes a Markdown fragment — headings
    become `#`-prefixed lines, list items become `-`-prefixed
    lines, blockquotes become `>`-prefixed lines, code blocks
    become fenced code blocks, and everything else becomes a plain
    paragraph.

    The walker skips elements that are nested inside another
    block-level element it has already processed. That is what
    prevents a paragraph inside a blockquote from being emitted
    twice — once when the blockquote is processed (as part of its
    inner text) and once when the paragraph is reached.

    This is not a general-purpose HTML-to-Markdown converter. It
    does not handle tables, images, links, or inline formatting
    (bold, italic, code spans). It produces readable prose from a
    page's paragraphs and headings, which is what the fallback is
    for: a second chance at getting SOMETHING usable out of a page
    that trafilatura could not parse.

    Args:
        html: The page's HTML.

    Returns:
        Markdown as a string. Empty string if the page has no
        block-level content.
    """
    soup = _make_soup(html)

    # ---- Strip the chrome ----
    for tag in soup(UNWANTED_TAGS):
        tag.decompose()

    # ---- Find the main content container ----
    # The preference order matters: an `<article>` element is the
    # strongest signal of "this is the main content", followed by
    # `<main>`, followed by the whole body. A page that has both an
    # `<article>` and a `<main>` (some frameworks produce both)
    # should prefer the narrower one.
    container = (
        soup.find("article")
        or soup.find("main")
        or soup.body
        or soup
    )

    # ---- Walk the block-level elements ----
    parts: list[str] = []
    for element in container.find_all(BLOCK_TAGS):
        # Skip elements nested inside another block-level element
        # we have already processed. The parent's text already
        # includes this element's text, so re-processing would
        # duplicate it.
        if element.find_parent(BLOCK_TAGS) is not None:
            continue

        # Extract the element's visible text. `separator=" "` joins
        # inline elements with a space — "the <b>good</b> book"
        # becomes "the good book", not "thegoodbook".
        text = element.get_text(separator=" ", strip=True)
        if not text:
            continue

        name = element.name
        if name.startswith("h"):
            # Headings: `#` repeated for the level, then the text.
            # The level is clamped to 6 — an `<h7>` would be
            # invalid HTML, but BeautifulSoup's parser is lenient
            # enough to produce one if the source has it.
            level = min(int(name[1]), 6)
            parts.append("#" * level + " " + text)
        elif name == "li":
            # List items: a `-` bullet followed by the text. The
            # list's own <ul>/<ol> tag is not in BLOCK_TAGS, so
            # this branch fires for every item without the
            # nesting check triggering.
            parts.append("- " + text)
        elif name == "blockquote":
            # Blockquotes: a `>` prefix on every line. The text
            # has already been joined by `get_text`, so it is a
            # single line; a multi-paragraph blockquote would be
            # rendered as one paragraph in the fallback. The
            # primary path (trafilatura) preserves blockquote
            # structure properly.
            parts.append("> " + text)
        elif name == "pre":
            # Code blocks: a fenced Markdown block. The inner
            # text is extracted without the joining separator
            # because code preserves its own line breaks and
            # spacing — joining with `" "` would destroy them.
            code = element.get_text()
            parts.append("```\n" + code.strip() + "\n```")
        elif name == "figcaption":
            # Figure captions: rendered as italic paragraphs.
            parts.append("*" + text + "*")
        else:
            # Everything else — the common case of a `<p>` — is a
            # plain paragraph.
            parts.append(text)

    return "\n\n".join(parts)


# =============================================================================
#  Default export
# =============================================================================

__all__ = [
    # primary extractor
    "extract_main_content",
    # markdown utilities
    "normalize_markdown",
    "count_words",
    "strip_frontmatter",
    # constants (exported for callers that want to reuse the tag
    # lists — a future custom extractor that runs the same walker
    # on a narrower container)
    "BLOCK_TAGS",
    "UNWANTED_TAGS",
]