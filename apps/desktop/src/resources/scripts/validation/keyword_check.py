#!/usr/bin/env python3
"""
validation/keyword_check.py — keyword placement for WriteSpeare.

The third of the six article validators. Reads the generated
article's raw Markdown, locates each of the user's keywords in
it, and computes one entry per keyword for the `keywords` section
of the validation report.

What this validator measures:

    Six numbers per keyword, all of which a good content editor
    looks at when they are checking whether an article actually
    targets the keywords it claims to target:

      * count         — total occurrences of the keyword phrase
                        in the article body.

      * density       — count divided by the article's total word
                        count. Reported as a fraction in [0, 1];
                        the UI multiplies by 100 for display.

      * inTitle       — whether the keyword appears in the
                        article's H1 title.

      * inIntro       — whether the keyword appears in the first
                        N words of the body.

      * inH2Count     — how many H2 headings contain the keyword.

      * status        — a per-keyword verdict derived from the
                        numbers above.

    Plus one entry per keyword for the report: the keyword itself
    and its priority (primary / secondary / supporting), both of
    which are supplied by the caller.

What "the user's keywords" means at this layer:

    The keyword set this validator examines is entirely the
    caller's responsibility. `validate_all.py` constructs it from
    the topic's own `keywords` array (the ones the user typed
    into the New Topic modal) plus any candidates the user
    accepted from the keyword-extraction stage, tagging each with
    a priority. This module does not read any config file, does
    not invoke a keyword extractor, and does not attempt to
    discover keywords on its own — it scores the set it is
    given.

    The consequences of that separation:

      * The validator is a pure function of
        `(article_text, keywords, thresholds)` and is trivially
        testable.

      * A future session that adds a new keyword source — a
        secondary extractor, a competitor-analysis import, a
        user-supplied CSV — needs to change only the
        dispatcher's keyword-construction step, not this file.

      * The keyword set that gets scored is exactly the keyword
        set the user saw at the extraction step. There is no
        hidden "the model also considers these keywords"
        behaviour, which would make the report unexplainable to
        the user.

Word-boundary matching:

    A keyword match is a case-insensitive, whole-word (or
    whole-phrase) match. The pattern for keyword "compost" does
    NOT match "composting" or "composted"; the pattern for
    "small space gardening" does NOT match "small garden" or
    "space gardening". The matching is done with a
    `\\b`-anchored regular expression built from the keyword
    with `re.escape` applied so that a keyword containing a
    punctuation character — "small-space gardening" with a
    hyphen, "R&D" with an ampersand, "Gmail.com" with a dot —
    matches literally rather than as a regex metacharacter.

    Whole-word matching is what makes the `count` metric
    meaningful. A substring match would count "compost" inside
    "composting" and "composted" and "composter", inflating the
    count and the density in a way that does not reflect the
    article's actual keyword usage. The word-boundary anchor
    fixes that.

    The one concession is that the boundary characters around a
    hyphenated keyword are the hyphen's own — "small-space
    gardening" is one phrase token from the regex's point of
    view, and it is matched against the article's text without
    any normalization of the article's own hyphenation. A writer
    who writes "small space gardening" in the article and
    "small-space gardening" as the keyword will see the keyword
    count as zero. That trade-off is deliberate: normalizing
    hyphen-versus-space differences would require tokenizing the
    article and the keyword identically, and the two tokenizers
    would then have to agree about every punctuation character
    the article might contain. The current contract — the
    keyword must appear as written — is unambiguous, and the
    user can change the keyword to match the article or vice
    versa.

The title, intro, and H2 rules:

    * The title is the first H1 heading in the raw Markdown — a
      line matching `^#\\s+...` — with the `#` and the
      surrounding whitespace stripped. An article that has no
      H1 has no title for this validator's purposes, and every
      keyword's `inTitle` field is false.

    * The intro is the first `intro_word_count` words of the
      article's plain-prose body. The default of 100 matches
      the plan's user-journey description ("first 100 words")
      and is also the SEO industry's conventional threshold for
      "what a reader sees before deciding to keep reading".
      The count is taken from the stripped prose, not from the
      raw Markdown, so the Markdown markers do not consume the
      word budget.

    * The H2 headings are every line matching `^##\\s+...` in
      the raw Markdown. `inH2Count` is the number of those
      headings whose text contains the keyword as a whole-word
      match. An article with five H2 sections of which two
      contain "container gardening" reports an `inH2Count` of
      2.

Placement vs. density — why both:

    Density alone tells the user "how often the keyword
    appears". Placement tells the user "where it appears".
    A keyword that hits its density target entirely in the
    article's body — never in the title, never in the intro,
    never in a heading — is technically present but is not
    doing its job of signalling the article's topic to a reader
    (or a search engine) who scans the structure. The report
    needs both numbers to explain why a section that meets its
    density target is still flagged.

    The per-keyword status rule reflects that distinction:

      * `'fail'`    — the keyword is missing entirely (count
                      zero), or its density is below the
                      minimum, or its density is above the
                      maximum (keyword stuffing).

      * `'warning'` — the density is in range, but the keyword
                      is not in the title, not in the intro, and
                      not in any H2 heading. It appears only in
                      the body prose.

      * `'good'`    — the density is in range and the keyword
                      appears in at least one of title / intro /
                      H2 headings.

    The priority field is metadata, not a status input. A
    primary keyword and a supporting keyword are held to the
    same density thresholds in the default configuration; a
    caller that wants a lower threshold for supporting
    keywords would call the validator with a lower `min_density`
    argument. That design keeps the classification rule — "the
    keyword is doing its job or it is not" — from depending on
    a per-keyword parameter the user never sees.

The report shape this function returns matches the shared
`KeywordReport` interface declared in the desktop's
`features/shared/types/index.ts` and the backend's
`features/shared/types/index.ts`:

    {
        "keywords": [
            {
                "keyword":    str,
                "priority":   'primary' | 'secondary' | 'supporting',
                "count":      int,
                "density":    float,     # 0–1 fraction
                "inTitle":    bool,
                "inIntro":    bool,
                "inH2Count":  int,
                "status":     'good' | 'warning' | 'fail',
            },
            ...
        ],
        "status": 'good' | 'warning' | 'fail',
    }

    The outer `status` is the worst of the per-keyword statuses.
    A section where four keywords are good and one is a warning
    reports a warning; a section with any fail reports a fail.

Dependencies: Python stdlib + the sibling `core/` package.
"""

import re
import sys
from pathlib import Path

# =============================================================================
#  sys.path bootstrap — MUST run BEFORE any `from core.* import ...`
# =============================================================================
#  Identical to the bootstrap in every other feature script. The
#  script lives at scripts/validation/keyword_check.py, so its own
#  directory is validation/, and the parent's parent is the
#  directory that contains `core/`. That directory must be on
#  sys.path for the sibling imports below to resolve in the
#  packaged app's embedded Python distribution.

_SCRIPT_DIR = Path(__file__).resolve().parent
_SCRIPTS_ROOT = _SCRIPT_DIR.parent
if str(_SCRIPTS_ROOT) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_ROOT))

from core.utils import log_debug, log_warning


# =============================================================================
#  Constants — heading extraction
# =============================================================================
#
# The two heading patterns use a capture group so the heading's
# visible text — everything after the hash markers and their
# trailing whitespace — can be recovered without a second regex.
# The `#\\s+` and `##\\s+` sequences are anchored to a start of
# line and require at least one whitespace character after the
# hash markers, matching the CommonMark rule and correctly
# excluding a line like `#hashtag` from being read as a heading.
#
# The H1 pattern's single hash cannot match an H2 line: after the
# first `#` character, an H2 line has a second `#` where the
# pattern expects whitespace. The H2 pattern's double hash cannot
# match an H1 line for the symmetric reason.

_H1_PATTERN = re.compile(r"^\s{0,3}#\s+(.+?)\s*$", re.MULTILINE)
_H2_PATTERN = re.compile(r"^\s{0,3}##\s+(.+?)\s*$", re.MULTILINE)


# =============================================================================
#  Constants — Markdown stripping for prose analysis
# =============================================================================
#
# A pattern set shaped like the ones in `readability.py` and
# `seo_check.py`: strip the Markdown markup from the article
# before counting words and matching keywords, so that the
# markup characters are not tokenized as words and the article's
# word count reflects its prose rather than its formatting.
#
# The two strippers that precede this one in the validation
# package (readability.py and seo_check.py) each declare their
# own local copy of these patterns rather than importing a shared
# stripper. That is deliberate — see the module docstring of
# seo_check.py for the reasoning — and the same reasoning applies
# here: the three strippers' pattern sets overlap but are not
# identical, and coupling them by import would force a future
# change to one to be reviewed against the other two.

_MD_CODE_FENCE_PATTERN = re.compile(r"```.*?```", re.DOTALL)
_MD_INLINE_CODE_PATTERN = re.compile(r"`[^`]*`")
_MD_IMAGE_PATTERN = re.compile(r"!\[([^\]]*)\]\([^)]*\)")
_MD_LINK_PATTERN = re.compile(r"\[([^\]]+)\]\([^)]*\)")
_MD_HEADING_PATTERN = re.compile(r"^\s{0,3}#{1,6}\s+", re.MULTILINE)
_MD_BLOCKQUOTE_PATTERN = re.compile(r"^\s{0,3}>+\s?", re.MULTILINE)
_MD_UNORDERED_LIST_PATTERN = re.compile(r"^\s{0,3}[-*+]\s+", re.MULTILINE)
_MD_ORDERED_LIST_PATTERN = re.compile(r"^\s{0,3}\d+\.\s+", re.MULTILINE)
_MD_HORIZONTAL_RULE_PATTERN = re.compile(
    r"^\s{0,3}(?:[-*_]\s*){3,}$", re.MULTILINE
)
_MD_EMPHASIS_ASTERISK_PATTERN = re.compile(r"\*{1,3}([^*]+)\*{1,3}")
_MD_EMPHASIS_UNDERSCORE_PATTERN = re.compile(r"__([^_]+)__")
_MD_HTML_TAG_PATTERN = re.compile(r"<[^>]+>")
_MD_WHITESPACE_COLLAPSE_PATTERN = re.compile(r"\n{3,}")


# =============================================================================
#  Constants — word tokenization for the prose word count and the
#  intro extraction
# =============================================================================
#
# The word pattern matches runs of word characters — letters,
# digits, underscores — the same definition `seo_check.py`'s
# `_count_words` uses. The consistency between the two modules is
# deliberate: the density this file reports for a keyword is
# `count / wordCount`, and if `wordCount` were computed by a
# different definition than the one the SEO panel's `wordCount`
# field uses, the two panels would disagree about the article's
# length. Keeping the same regex across both files means both
# panels report the same denominator.

_WORD_PATTERN = re.compile(r"\w+")


# =============================================================================
#  Constants — allowed priority values
# =============================================================================
#
# The three priorities declared in the shared `KeywordReportEntry`
# interface. A caller that passes an unrecognized priority string
# is normalized to `'primary'` — the safest default for a caller
# that did not tag its keywords, and the value the report type
# can always accept.
#
# The set is frozen so it cannot be mutated at runtime by a
# caller that accidentally does `_VALID_PRIORITIES.add(...)`.
# The `Report` Mongoose schema in
# `apps/server/src/features/reports/models/Report.ts` enforces the
# same three values with a `min: 0, max: 1` check — no, with an
# `enum` — and a value this file rejects before it leaves Python
# would surface as a Mongoose ValidationError at save time. The
# normalization here is what prevents that.

_VALID_PRIORITIES = frozenset({"primary", "secondary", "supporting"})
_DEFAULT_PRIORITY = "primary"


# =============================================================================
#  Public entry point
# =============================================================================

def validate_keywords(
    article_text: str,
    keywords: list,
    intro_word_count: int = 100,
    min_density: float = 0.001,
    max_density: float = 0.03,
) -> dict:
    """
    Compute the keywords section of the validation report for an
    article. See the module docstring for the reasoning behind
    every metric and every threshold.

    The function is a pure transformation: given the article's
    Markdown, the list of keywords, and the thresholds, it
    produces the same section dict every time, with no file I/O,
    no network access, and no side effects. The caller
    (`validate_all.py`) owns the dispatch and the marker
    emission.

    Threshold defaults:

      `intro_word_count`  — 100, matching the plan's user-
                            journey description of the "intro"
                            section and the SEO convention for
                            "above the fold" keyword placement.

      `min_density`       — 0.001, which corresponds to 0.1%. The
                            user-journey example shows keywords
                            at 0.16% and 0.32% being accepted and
                            a keyword at 0% being rejected, so
                            the minimum the default has to clear
                            is that gap. 0.1% is a defensible
                            value in that range and matches the
                            SEO guidance that a keyword should
                            appear at least once per thousand
                            words.

      `max_density`       — 0.03, which corresponds to 3%. Above
                            that density, SEO guidance agrees
                            that the keyword begins to read as
                            stuffing and the article's prose
                            quality is measurably degraded by the
                            repetition. The plan's preset model
                            exposes both bounds as
                            `minKeywordDensity` and
                            `maxKeywordDensity` and the
                            dispatcher is expected to override
                            these defaults from the user's preset
                            when a preset is in effect.

    The function never raises. Every per-keyword computation is a
    pure regex or arithmetic operation whose inputs are already
    normalized; the only branch that can fail — an exception from
    a regex substitution on a pathological input — cannot occur
    because every substitution's pattern is a valid regular
    expression that returns the input unchanged on a miss.

    Args:
        article_text:       The article's full Markdown text,
                            including any frontmatter, the H1
                            title, and the H2 headings.
        keywords:           The keywords to score. Accepts either:
                              * a list of strings, each treated
                                as a primary-priority keyword; or
                              * a list of dicts, each with a
                                `keyword` field (required,
                                non-empty string) and an optional
                                `priority` field (one of
                                'primary', 'secondary',
                                'supporting'; defaults to
                                'primary' when absent).
                            An entry whose `keyword` is empty or
                            non-string is silently skipped — a
                            caller that passed a list of mixed
                            types is not making a fatal error,
                            but the empty entries are not useful
                            to score.
        intro_word_count:   The number of words in the article's
                            "intro" region for the `inIntro`
                            check. Non-positive values disable
                            the check (every keyword's `inIntro`
                            is false, and the intro's absence
                            does not affect the status — the
                            status rule below treats "not in
                            intro" as neither good nor fail on
                            its own).
        min_density:        The minimum keyword density for a
                            per-keyword status other than
                            `'fail'`. Non-positive values disable
                            the lower bound.
        max_density:        The maximum keyword density for a
                            per-keyword status other than
                            `'fail'`. Non-positive values disable
                            the upper bound.

    Returns:
        The keywords section dict. Never None, never partial —
        an empty `keywords` list produces a well-formed section
        with an empty `keywords` array and an overall status of
        `'good'` (nothing to fail).
    """
    # ---- 1. Normalize the keyword input ----
    # Accept either a list of strings or a list of dicts. The
    # normalized form is a list of `(keyword_str, priority_str)`
    # tuples, which is what the rest of the function works with.
    normalized_keywords = _normalize_keyword_input(keywords)

    if not normalized_keywords:
        # No keywords to score. The section is trivially good —
        # an article cannot miss a keyword that was never
        # requested.
        log_debug(
            "keyword_check: no keywords supplied — "
            "returning empty section"
        )
        return _empty_result()

    # ---- 2. Guard against empty article ----
    if not article_text or not article_text.strip():
        # Every keyword's status is `'fail'` — the article has
        # no words, so no keyword can appear in it.
        log_debug(
            "keyword_check: empty article — "
            "all keywords will be reported as missing"
        )
        return _all_failed_result(normalized_keywords)

    # ---- 3. Extract the title from the raw Markdown ----
    # The title is the text of the first H1 heading. An article
    # without an H1 heading has an empty title, and every
    # keyword's `inTitle` field is false — a correct
    # classification, since the article's title slot is empty.
    title = _extract_title(article_text)

    # ---- 4. Extract the H2 heading texts ----
    # A list of the visible text of every H2 heading, in
    # document order. `inH2Count` for a keyword is the number of
    # entries in this list that contain the keyword.
    h2_headings = _extract_h2_headings(article_text)

    # ---- 5. Strip Markdown to plain prose ----
    # The word count and the keyword occurrence counts both run
    # against the stripped prose, not the raw Markdown — see the
    # module docstring for the reasoning. The two runs have to
    # agree about what constitutes a "word" for the density
    # fraction to be meaningful.
    plain_text = _strip_markdown_for_prose(article_text)

    # ---- 6. Compute the total word count ----
    # This is the denominator of every keyword's density. A zero
    # word count means every density is zero by definition, and
    # every keyword is a fail — the guard above already returns
    # early in that case, so reaching here guarantees a positive
    # word count.
    total_words = _count_words(plain_text)

    # ---- 7. Extract the intro slice ----
    # The first `intro_word_count` words of the prose, as a
    # string. Used to compute the per-keyword `inIntro` flag.
    # An `intro_word_count` of zero or less disables the intro
    # check and yields an empty intro string; no keyword will
    # then have `inIntro === true`.
    intro_text = _extract_intro(plain_text, intro_word_count)

    # ---- 8. Score each keyword ----
    entries = []
    for keyword, priority in normalized_keywords:
        entries.append(
            _score_one_keyword(
                keyword=keyword,
                priority=priority,
                plain_text=plain_text,
                title=title,
                intro_text=intro_text,
                h2_headings=h2_headings,
                total_words=total_words,
                min_density=min_density,
                max_density=max_density,
            )
        )

    # ---- 9. Aggregate the overall status ----
    # The section's status is the worst of the per-keyword
    # statuses. See the module docstring for the reasoning.
    overall_status = _worst([entry["status"] for entry in entries])

    # ---- 10. Build and return ----
    return {
        "keywords": entries,
        "status": overall_status,
    }


# =============================================================================
#  Private: input normalization
# =============================================================================

def _normalize_keyword_input(keywords: list) -> list:
    """
    Convert the caller's keyword input into a list of
    `(keyword_str, priority_str)` tuples.

    Handles the two accepted input shapes:

      * A list of strings — each string becomes a tuple with the
        default priority.

      * A list of dicts — each dict's `keyword` field becomes the
        keyword string, and its optional `priority` field becomes
        the priority. A dict with no `priority` field (or with a
        `priority` whose value is not one of the three legal
        strings) gets the default.

    Entries that cannot be interpreted — a keyword that is not a
    string or is the empty string, a list element that is neither
    a string nor a dict — are skipped. A caller that passed a
    malformed list gets a smaller scored set, not an exception.

    The function never raises.

    Args:
        keywords: The caller's input. Any value is accepted; a
                  value that is not a list yields an empty
                  result.

    Returns:
        A list of `(keyword_str, priority_str)` tuples, in the
        caller's original order.
    """
    if not isinstance(keywords, list):
        return []

    result = []
    for entry in keywords:
        # String entries: the simple case.
        if isinstance(entry, str):
            trimmed = entry.strip()
            if trimmed:
                result.append((trimmed, _DEFAULT_PRIORITY))
            continue

        # Dict entries: extract the keyword and priority fields.
        if isinstance(entry, dict):
            keyword_value = entry.get("keyword")
            if not isinstance(keyword_value, str):
                continue
            trimmed = keyword_value.strip()
            if not trimmed:
                continue

            priority_value = entry.get("priority", _DEFAULT_PRIORITY)
            if (
                not isinstance(priority_value, str)
                or priority_value not in _VALID_PRIORITIES
            ):
                priority_value = _DEFAULT_PRIORITY

            result.append((trimmed, priority_value))
            continue

        # Anything else (int, list, None, ...) is skipped.
        continue

    return result


# =============================================================================
#  Private: heading extraction
# =============================================================================

def _extract_title(article_text: str) -> str:
    """
    Return the visible text of the first H1 heading in the
    article, or the empty string if there is none.

    The article's H1 is the title the writer step produced. The
    match is the first occurrence of the `_H1_PATTERN` in the
    raw Markdown; subsequent H1 headings (if any) are ignored —
    a well-formed Markdown document has exactly one H1, and an
    article with two is treated as having the first one as its
    title and the others as body headings.

    The returned string is stripped of surrounding whitespace.
    A title of " Small Space Gardening for Renters " returns as
    "Small Space Gardening for Renters".

    Never raises.

    Args:
        article_text: The raw Markdown.

    Returns:
        The H1 text, or the empty string.
    """
    match = _H1_PATTERN.search(article_text)
    if match is None:
        return ""
    return match.group(1).strip()


def _extract_h2_headings(article_text: str) -> list:
    """
    Return the visible text of every H2 heading in the article,
    in document order.

    Each entry is stripped of surrounding whitespace. The list
    is empty when the article has no H2 headings.

    Never raises.

    Args:
        article_text: The raw Markdown.

    Returns:
        A list of H2 heading strings.
    """
    return [m.group(1).strip() for m in _H2_PATTERN.finditer(article_text)]


# =============================================================================
#  Private: Markdown stripping
# =============================================================================

def _strip_markdown_for_prose(text: str) -> str:
    """
    Strip Markdown markup from the article and return the plain
    prose.

    Same approach as the two preceding validators' strippers —
    see `seo_check.py`'s `_strip_markdown_for_prose` for the
    substitution order's full rationale. The short version:
    fenced code and inline code first (so a `#` inside a code
    snippet is not treated as a heading), then images and links
    (kept as their visible text), then the structural prefixes,
    then emphasis, then HTML tags, then a final blank-line
    collapse.

    Never raises.

    Args:
        text: The article's Markdown source.

    Returns:
        The prose with markup removed, stripped.
    """
    text = _MD_CODE_FENCE_PATTERN.sub(" ", text)
    text = _MD_INLINE_CODE_PATTERN.sub(" ", text)
    text = _MD_IMAGE_PATTERN.sub(r"\1", text)
    text = _MD_LINK_PATTERN.sub(r"\1", text)
    text = _MD_HEADING_PATTERN.sub("", text)
    text = _MD_BLOCKQUOTE_PATTERN.sub("", text)
    text = _MD_UNORDERED_LIST_PATTERN.sub("", text)
    text = _MD_ORDERED_LIST_PATTERN.sub("", text)
    text = _MD_HORIZONTAL_RULE_PATTERN.sub("", text)
    text = _MD_EMPHASIS_ASTERISK_PATTERN.sub(r"\1", text)
    text = _MD_EMPHASIS_UNDERSCORE_PATTERN.sub(r"\1", text)
    text = _MD_HTML_TAG_PATTERN.sub(" ", text)
    text = _MD_WHITESPACE_COLLAPSE_PATTERN.sub("\n\n", text)
    return text.strip()


# =============================================================================
#  Private: word counting and intro extraction
# =============================================================================

def _count_words(text: str) -> int:
    """
    Return the number of words in a plain-prose text.

    A word is a run of one or more word characters, matched by
    `_WORD_PATTERN`. Same definition as `seo_check.py`'s
    `_count_words`, so the density denominators the two panels
    report agree.

    Args:
        text: The plain-prose text.

    Returns:
        The word count. Zero for an empty input.
    """
    return len(_WORD_PATTERN.findall(text))


def _extract_intro(text: str, word_count: int) -> str:
    """
    Return the first `word_count` words of a plain-prose text as
    a single whitespace-joined string.

    A non-positive `word_count` returns the empty string — the
    intro check is disabled. A `word_count` at or beyond the
    text's actual length returns the whole text.

    The extraction is a simple slice of the word list, joined by
    single spaces. Preserving the original whitespace would
    require tracking character offsets through the regex
    matches, and the resulting string is used only for a
    case-insensitive substring check — the internal whitespace
    is irrelevant to that check.

    Never raises.

    Args:
        text:       The plain-prose text.
        word_count: How many words to include.

    Returns:
        The intro text, or an empty string.
    """
    if word_count <= 0 or not text:
        return ""
    words = _WORD_PATTERN.findall(text)
    return " ".join(words[:word_count])


# =============================================================================
#  Private: per-keyword scoring
# =============================================================================

def _score_one_keyword(
    keyword: str,
    priority: str,
    plain_text: str,
    title: str,
    intro_text: str,
    h2_headings: list,
    total_words: int,
    min_density: float,
    max_density: float,
) -> dict:
    """
    Compute the report entry for a single keyword.

    See the module docstring for the meaning of every field and
    the classification rule. The function is a pure computation
    over its arguments; it reads no files, writes no files, and
    calls no other functions that do.

    The keyword occurrence count is computed by a
    `re.escape`-protected, `\\b`-anchored, case-insensitive
    regex built from the keyword string. The `re.escape` call
    makes a keyword containing a regex metacharacter (a hyphen,
    a dot, an ampersand) match literally; the `\\b` anchors make
    a keyword match only as a whole word or whole phrase; the
    `re.IGNORECASE` flag makes the match independent of case.
    See the module docstring for the trade-offs of that rule.

    Never raises. The regex is compiled from an escaped string,
    so it cannot produce a `re.error`.

    Args:
        keyword:      The keyword to score. Assumed already
                      trimmed and non-empty (the caller
                      normalizes).
        priority:     One of 'primary' / 'secondary' /
                      'supporting' (the caller normalizes).
        plain_text:   The article's prose, with Markdown
                      stripped. The count and density are
                      computed over this text.
        title:        The article's H1 title (empty if none).
        intro_text:   The article's intro slice (empty if
                      disabled or if the article is too short).
        h2_headings:  The list of H2 heading texts.
        total_words:  The article's total word count. The caller
                      guarantees this is positive.
        min_density:  The lower density bound. Non-positive
                      disables the check.
        max_density:  The upper density bound. Non-positive
                      disables the check.

    Returns:
        The per-keyword report entry dict.
    """
    # ---- 1. Count occurrences ----
    count = _count_keyword_occurrences(keyword, plain_text)

    # ---- 2. Compute density ----
    # A non-positive total word count is guarded by the caller
    # — the empty-article branch returns before reaching this
    # function — but the check is repeated here so the function
    # is safe to call in isolation.
    if total_words <= 0:
        density = 0.0
    else:
        density = count / total_words

    # ---- 3. Placement checks ----
    in_title = _contains_keyword(keyword, title)
    in_intro = _contains_keyword(keyword, intro_text)
    in_h2_count = sum(
        1 for heading in h2_headings
        if _contains_keyword(keyword, heading)
    )

    # ---- 4. Classify the status ----
    status = _classify_keyword_status(
        count=count,
        density=density,
        in_title=in_title,
        in_intro=in_intro,
        in_h2_count=in_h2_count,
        min_density=min_density,
        max_density=max_density,
    )

    # ---- 5. Build and return ----
    return {
        "keyword": keyword,
        "priority": priority,
        "count": int(count),
        "density": round(float(density), 6),
        "inTitle": bool(in_title),
        "inIntro": bool(in_intro),
        "inH2Count": int(in_h2_count),
        "status": status,
    }


def _count_keyword_occurrences(keyword: str, text: str) -> int:
    """
    Return the number of whole-word (or whole-phrase)
    case-insensitive occurrences of `keyword` in `text`.

    The pattern is `\\b` + `re.escape(keyword)` + `\\b`, compiled
    with `re.IGNORECASE`. See `_score_one_keyword`'s docstring
    for the reasoning.

    The `re.escape` call is what makes a keyword containing a
    regex metacharacter safe — `re.escape("small-space")`
    produces `small\\-space`, which matches the literal hyphen.
    Without the escape, the hyphen in a character class or a
    quantifier position would produce an unexpected pattern.

    Never raises.

    Args:
        keyword: The keyword to count.
        text:    The text to search.

    Returns:
        The occurrence count. Zero for an empty keyword or an
        empty text.
    """
    if not keyword or not text:
        return 0
    pattern = re.compile(
        r"\b" + re.escape(keyword) + r"\b",
        re.IGNORECASE,
    )
    return len(pattern.findall(text))


def _contains_keyword(keyword: str, text: str) -> bool:
    """
    Return True if `keyword` appears in `text` as a whole word
    (or whole phrase), case-insensitively.

    A thin boolean wrapper around `_count_keyword_occurrences`
    so the placement checks in `_score_one_keyword` read as
    `_contains_keyword(kw, title)` rather than as
    `_count_keyword_occurrences(kw, title) > 0`. The two share
    the same matching rule by construction — there is one
    function that actually performs the match, and this one
    simply asks a yes/no question of it.

    Never raises.

    Args:
        keyword: The keyword to look for.
        text:    The text to search. May be empty.

    Returns:
        True if the keyword is present, False otherwise.
    """
    return _count_keyword_occurrences(keyword, text) > 0


def _classify_keyword_status(
    count: int,
    density: float,
    in_title: bool,
    in_intro: bool,
    in_h2_count: int,
    min_density: float,
    max_density: float,
) -> str:
    """
    Classify one keyword's status as `'good'`, `'warning'`, or
    `'fail'`. See the module docstring for the rule and the
    reasoning behind it.

    Summary of the rule:

      * `'fail'`    — count is zero, OR density is below
                      `min_density` (when min is positive), OR
                      density is above `max_density` (when max
                      is positive).

      * `'warning'` — the count and density are acceptable, but
                      the keyword is not in the title, not in
                      the intro, and not in any H2 heading. It
                      appears only in the body.

      * `'good'`    — the count and density are acceptable and
                      the keyword appears in at least one of
                      title / intro / H2 headings.

    The `min_density` and `max_density` guards are both
    non-positive-safe: a caller that passes zero (or a negative
    value) disables that bound, which is useful for a test or a
    future "I do not care about density" mode.

    Args:
        count:        Occurrence count.
        density:      Fraction of total words.
        in_title:     Whether the keyword is in the title.
        in_intro:     Whether the keyword is in the intro.
        in_h2_count:  Number of H2 headings containing the
                      keyword.
        min_density:  Lower density bound. Non-positive to
                      disable.
        max_density:  Upper density bound. Non-positive to
                      disable.

    Returns:
        One of `'good'`, `'warning'`, `'fail'`.
    """
    # A completely missing keyword is always a fail.
    if count <= 0:
        return "fail"

    # Density bounds, each checked only when positive.
    if min_density > 0 and density < min_density:
        return "fail"
    if max_density > 0 and density > max_density:
        return "fail"

    # The keyword is present and its density is acceptable.
    # Its status now depends on placement.
    if in_title or in_intro or in_h2_count > 0:
        return "good"

    return "warning"


# =============================================================================
#  Private: status aggregation and empty-section builders
# =============================================================================

def _worst(statuses: list) -> str:
    """
    Return the worst status from a list of `'good'`,
    `'warning'`, and `'fail'` strings.

    The ordering is `'fail'` worse than `'warning'` worse than
    `'good'`. An empty list returns `'good'` — the absence of a
    complaint is the absence of a problem.

    The function is duplicated in `seo_check.py` and here rather
    than imported from a shared location. The duplication is
    three lines, and the alternative — a shared `validation/
    _status.py` module — would be a new file outside the plan's
    tree. If a fourth validator ever needs the same rule, the
    promotion is straightforward.

    Args:
        statuses: A list of status strings.

    Returns:
        The worst status in the list.
    """
    if "fail" in statuses:
        return "fail"
    if "warning" in statuses:
        return "warning"
    return "good"


def _empty_result() -> dict:
    """
    Return the keywords section for an article with no keywords
    supplied. The overall status is `'good'` — the article
    cannot miss a keyword that was never requested — and the
    `keywords` array is empty.

    The function is the single source of truth for that shape;
    the empty-keywords branch in `validate_keywords` returns
    this value directly.
    """
    return {
        "keywords": [],
        "status": "good",
    }


def _all_failed_result(normalized_keywords: list) -> dict:
    """
    Return the keywords section for an empty article, where
    every requested keyword is marked as missing.

    Each entry carries its keyword and priority (the metadata
    the caller supplied) plus zero counts and a `'fail'` status.
    The overall section status is `'fail'`.

    Args:
        normalized_keywords: The `(keyword, priority)` tuples
                             produced by
                             `_normalize_keyword_input`.

    Returns:
        The keywords section dict.
    """
    entries = []
    for keyword, priority in normalized_keywords:
        entries.append({
            "keyword": keyword,
            "priority": priority,
            "count": 0,
            "density": 0.0,
            "inTitle": False,
            "inIntro": False,
            "inH2Count": 0,
            "status": "fail",
        })
    return {
        "keywords": entries,
        "status": "fail",
    }


# =============================================================================
#  Default export
# =============================================================================

__all__ = [
    "validate_keywords",
]