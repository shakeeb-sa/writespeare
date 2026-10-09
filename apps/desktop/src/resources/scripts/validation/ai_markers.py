#!/usr/bin/env python3
"""
validation/ai_markers.py — AI-tell phrase detection for WriteSpeare.

The fifth of the six article validators. Counts occurrences of
phrases that are statistically over-represented in LLM-generated
prose, and produces the `aiMarkers` section of the article
validation report.

What "AI-tell phrases" means here:

    Every language model trained on a large corpus of text
    develops a stylistic fingerprint — a small set of words and
    phrases it reaches for more often than a human writer would.
    The fingerprints of the popular instruction-tuned models
    overlap enough that a single curated list of phrases covers
    the detectable tells across all of them.

    The tells fall into four families:

      1. Discourse markers. Phrases that signal "I am about to
         make a point" without making one — "it's important to
         note", "it's worth mentioning", "at the end of the
         day". A human writer uses these sparingly; a model
         reaches for them as connective tissue.

      2. Overused verbs. Verbs that a model has learned to
         associate with "high-quality writing" — "delve into",
         "navigate the landscape", "leverage", "harness",
         "unlock", "pave the way", "shed light on". The
         vocabulary is not wrong, but its frequency is
         unnatural.

      3. Abstract nouns. Nouns that read as "literate" but
         carry little specific meaning — "tapestry",
         "landscape", "realm", "myriad", "plethora",
         "testament to". A model reaches for them when it wants
         to sound expansive; a human writer uses them rarely.

      4. Formal connectors. Adverbs and phrases that signal
         "formal essay" — "moreover", "furthermore", "in
         conclusion", "notably", "importantly". A model uses
         them to chain paragraphs; a human writer mostly uses
         plain transitions instead.

    The list this module ships is a curated subset of those four
    families. It is not exhaustive — every new model release
    reshapes the fingerprint slightly, and a phrase list that
    tried to be complete would be stale within a release. It is,
    however, a good fingerprint of the tells that the plan's
    user-journey example catches: "it's important to note",
    "delve into", "in today's world", "moreover", "furthermore"
    all appear in the list below, and every one of them is
    flagged in the example's report.

How the phrases are matched:

    Each phrase is matched case-insensitively with word-boundary
    anchors at both ends, using a `\\b`-anchored regular
    expression built from the phrase with `re.escape` applied so
    that an apostrophe, a hyphen, or a period inside the phrase
    matches literally rather than as a regex metacharacter.

    Whole-word matching is what makes the count meaningful. A
    substring match would count "leverage" inside "leveraging"
    and "leverages" — the count would reflect the word's
    morphological family rather than its literal appearance, and
    the report would flag sentences the user did not write with
    the flagged phrase. The word-boundary anchor fixes that.

    The concession for multi-word phrases is that the phrase must
    appear as written. "at the end of the day" is flagged but
    "at the end of the week" is not, and a writer who writes
    "at the end of a long day" will see zero flagged occurrences
    of the phrase. That trade-off is deliberate: normalizing the
    phrase to allow insertions would require a parser-aware
    matcher, and the value of catching the inserted-word variant
    is small compared to the cost of a matcher that
    occasionally fails in an inexplicable way.

The threshold and the status rule:

    The `max_ai_markers` argument is the number of total phrase
    occurrences at or below which the article is considered to
    have an acceptable number of AI tells. The default is 10 —
    the value that classifies the plan's user-journey example
    (11 total occurrences) as a warning rather than a failure,
    which is what the example shows.

    The status rule:

      * `'good'`    — the total count is at or below
                      `max_ai_markers`.

      * `'warning'` — the total count is at most twice
                      `max_ai_markers`. The article has an
                      AI-flavoured style, but the tells are
                      spread thin enough that a targeted edit —
                      replacing one or two phrases — brings the
                      count back into range.

      * `'fail'`    — anything else. The tells are dense enough
                      that the article reads as machine-written
                      to a careful reader, and the corrective
                      loop should treat this as a substantial
                      stylistic problem rather than a nudge.

    The doubling margin between good and fail is the same shape
    as the margins in `seo_check.py` and `originality.py`: a
    single number separates "fine" from "worth flagging", and
    twice that number separates "worth flagging" from
    "substantial problem". The consistency across the three
    validators means a user reading the report sees a uniform
    scale — the same "one over the line is a warning, two over
    is a fail" pattern everywhere.

The report shape this function returns matches the shared
`AiMarkersReport` and `AiMarkerEntry` interfaces declared in
the desktop's `features/shared/types/index.ts` and the backend's
`features/shared/types/index.ts`:

    {
        "markerCount": int,     # total occurrences across all phrases
        "markers": [
            {
                "phrase": str,  # the AI-tell phrase
                "count":  int,  # occurrences of that phrase
            },
            ...
        ],
        "status": 'good' | 'warning' | 'fail',
    }

    The `Report` Mongoose schema in `apps/server/src/features/
    reports/models/Report.ts` enforces `min: 0, max: 100000` and
    integer-ness on both `markerCount` and each marker's `count`,
    and `minlength: 1, maxlength: 200` on each marker's `phrase`.
    Every value this module emits satisfies those bounds by
    construction: counts are non-negative integers from
    `len(re.findall(...))`, and phrase strings are the exact
    entries from the phrase list, all of which are short enough
    to be well within the 200-character bound.

What the report does NOT do:

    The report does not attempt to distinguish "legitimate" uses
    of a flagged phrase from "AI-flavoured" uses. A human writer
    who genuinely wants to say "moreover" once in a long essay
    will still see one flagged occurrence, and the report will
    count it. That is the correct behavior at this layer — the
    validator measures the article's stylistic fingerprint, not
    its authorial intent — and it is what makes the number
    trustworthy. A validator that tried to second-guess the
    user's prose would produce a count the user could not
    reproduce by searching the article for the phrases the
    report names.

Dependencies: Python stdlib + the sibling `core/` package.
"""

import re
import sys
from pathlib import Path

# =============================================================================
#  sys.path bootstrap — MUST run BEFORE any `from core.* import ...`
# =============================================================================
#  Identical to the bootstrap in every other feature script. The
#  script lives at scripts/validation/ai_markers.py, so its own
#  directory is validation/, and the parent's parent is the
#  directory that contains `core/`. That directory must be on
#  sys.path for the sibling imports below to resolve in the
#  packaged app's embedded Python distribution.

_SCRIPT_DIR = Path(__file__).resolve().parent
_SCRIPTS_ROOT = _SCRIPT_DIR.parent
if str(_SCRIPTS_ROOT) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_ROOT))

from core.extractor import strip_frontmatter
from core.utils import log_debug, log_warning


# =============================================================================
#  Constants — AI-tell phrases
# =============================================================================
#
# The curated list of phrases this validator counts. Every phrase
# is lowercase — matching is case-insensitive, and the lowercase
# form is the canonical identifier the report prints.
#
# Organization of the list, in the order the tuples appear:
#
#   1. Discourse markers — "here is my point" phrases.
#   2. Overused verbs    — "literate" verbs a model over-reaches
#                          for.
#   3. Abstract nouns    — nouns that read as "literate" but
#                          carry little specific meaning.
#   4. Formal connectors — adverbs and phrases that signal
#                          "formal essay".
#   5. Business-speak    — modern professional-writing clichés.
#   6. Evaluation-speak  — a smaller family of phrases a model
#                          uses when it wants to sound balanced
#                          ("arguably", "it could be argued").
#
# The list is a `tuple` rather than a `list` so the constant
# cannot be mutated at runtime by accident, and is `frozenset`-
# like in its role as "the closed set of phrases this module
# knows about". It is stored as a tuple — not a frozenset —
# because the report's `markers` array should be presented in a
# deterministic order across runs, and a frozenset's iteration
# order is not stable across Python versions.
#
# What is NOT in the list, and why:
#
#   * Single common words — "the", "and", "also", "very",
#     "really". These appear in every text, human and machine
#     alike; counting them would produce a number that reflects
#     the article's length rather than its AI flavour.
#
#   * Words that are themselves neutral but frequently
#     overused — "important", "significant", "key". A model
#     overuses these, but so does a business writer, and the
#     report would flag the business writer's article as
#     machine-written. The list keeps the phrases where the
#     "human would rarely write this" signal is strongest.
#
#   * Multi-word variants of the same base phrase — "it is
#     important to note" alongside "it's important to note"
#     would double-count the same occurrence whenever a text
#     used one of the two forms. The list uses the contraction
#     for the "it's" family because that is the more common
#     form in modern prose, and omits the expansion.
#
# A future session that wants to add or remove phrases — a
# fingerprint update after a new model release, a user-configured
# addition, a removal that turns out to over-flag — edits this
# tuple and changes nothing else.

_AI_TELL_PHRASES = (
    # ---- 1. Discourse markers ----
    "it's important to note",
    "it's worth noting",
    "it's worth mentioning",
    "it's no secret that",
    "it should be noted",
    "it's worth pointing out",
    "it is important to remember",
    "in today's world",
    "in today's fast-paced world",
    "in today's digital age",
    "in the ever-evolving",
    "in the realm of",
    "at the end of the day",
    "when it comes to",
    "at its core",
    "in essence",
    "the fact of the matter is",
    "it's clear that",
    "it's evident that",

    # ---- 2. Overused verbs ----
    "delve into",
    "delve deeper",
    "navigate the landscape",
    "navigate the complexities",
    "navigate the challenges",
    "leverage",
    "leveraging",
    "harness",
    "harnessing",
    "unlock",
    "unlocking the potential",
    "pave the way",
    "shed light on",
    "unleash",
    "underscore",
    "underscores",
    "exacerbate",
    "epitomize",
    "encapsulate",
    "illuminate",

    # ---- 3. Abstract nouns ----
    "tapestry",
    "realm",
    "labyrinth",
    "myriad",
    "plethora",
    "testament to",
    "beacon of",
    "kaleidoscope",
    "mosaic",
    "panorama",
    "symphony",
    "odyssey",
    "narrative",
    "paradigm",
    "zeitgeist",
    "milieu",

    # ---- 4. Formal connectors ----
    "moreover",
    "furthermore",
    "in conclusion",
    "in summary",
    "notably",
    "importantly",
    "significantly",
    "consequently",
    "subsequently",
    "accordingly",
    "henceforth",
    "whereupon",
    "thereupon",
    "notwithstanding",

    # ---- 5. Business-speak ----
    "cutting-edge",
    "state-of-the-art",
    "seamlessly",
    "seamless integration",
    "robust solution",
    "robust framework",
    "synergy",
    "synergies",
    "paradigm shift",
    "value proposition",
    "best practices",
    "core competencies",
    "move the needle",
    "low-hanging fruit",
    "circle back",
    "deep dive",
    "game-changer",
    "game-changing",
    "next level",
    "at scale",
    "holistic",
    "granular",
    "actionable",

    # ---- 6. Evaluation-speak ----
    "arguably",
    "it could be argued",
    "one might argue",
    "it can be argued",
    "on balance",
    "all things considered",
    "broadly speaking",
    "generally speaking",
    "in a sense",
    "to some extent",
)


# =============================================================================
#  Constants — pre-compiled phrase patterns
# =============================================================================
#
# Each phrase is compiled once at module load into a
# `(phrase, compiled_regex)` tuple, and the resulting list is
# what `validate_ai_markers` iterates. Compiling at import time
# costs a few milliseconds of startup work and saves the cost on
# every subsequent article the module validates — a meaningful
# saving on a process that validates many articles in a batch.
#
# The pattern for each phrase is:
#
#     \\b + re.escape(phrase) + \\b
#
# with the `re.IGNORECASE` flag. The `\\b` anchors make the match
# whole-word at both ends; the `re.escape` makes any regex
# metacharacter in the phrase match literally. See the module
# docstring for the trade-offs of that matching rule.

def _compile_phrase_patterns():
    """
    Compile the phrase list into a list of
    `(phrase, compiled_regex)` tuples. Called once at module load
    to build `_COMPILED_PHRASE_PATTERNS`.

    The function is defined and called at module scope rather
    than inline because the resulting list is a module-level
    constant, and building it inline in a `for` loop at module
    scope would leave a mutable `patterns = []` variable visible
    to the rest of the module. The function form keeps the
    intermediate state local.
    """
    compiled = []
    for phrase in _AI_TELL_PHRASES:
        pattern = re.compile(
            r"\b" + re.escape(phrase) + r"\b",
            re.IGNORECASE,
        )
        compiled.append((phrase, pattern))
    return compiled


_COMPILED_PHRASE_PATTERNS = _compile_phrase_patterns()


# =============================================================================
#  Public entry point
# =============================================================================

def validate_ai_markers(
    article_text: str,
    max_ai_markers: int = 10,
) -> dict:
    """
    Compute the AI-marker section of the validation report for an
    article. See the module docstring for the reasoning behind
    every phrase and every threshold.

    The function is a pure transformation: given the article's
    Markdown and the threshold, it produces the same section dict
    every time, with no file I/O, no network access, and no side
    effects. The caller (`validate_all.py`) owns the dispatch and
    the marker emission.

    Threshold default:

      `max_ai_markers` — 10. The value that classifies the plan's
                         user-journey example (11 total
                         occurrences) as a warning rather than a
                         failure, matching what the example's
                         report shows. The dispatcher is expected
                         to override this default from the user's
                         preset when a preset is in effect — the
                         `Preset` schema in the backend declares
                         a `maxAiMarkers` field for exactly this
                         purpose.

    The function never raises. Every phrase pattern is compiled
    from an escaped string and cannot produce a `re.error`; the
    article text is treated as an opaque string and is matched
    against without any pre-processing that could fail.

    Args:
        article_text:     The article's full Markdown text,
                          including any frontmatter. The text is
                          matched against as-is, except for
                          frontmatter stripping — see the next
                          paragraph.
        max_ai_markers:   The threshold at or below which the
                          article is classified `'good'`. A
                          non-positive threshold disables the
                          good band (every article with any tell
                          is at least a warning) and a zero-
                          threshold article with zero tells is
                          still good. See `_classify_status` for
                          the exact behavior.

    Returns:
        The AI-markers section dict. Never None, never partial —
        an empty or frontmatter-only input produces a well-formed
        zero-valued dict with a `'good'` status.
    """
    # ---- 1. Guard against empty input ----
    if not article_text or not article_text.strip():
        log_debug(
            "ai_markers: empty article — returning zero metrics"
        )
        return _empty_result()

    # ---- 2. Strip frontmatter ----
    # The article file may or may not carry frontmatter. If it
    # does, the metadata fields (a title, an author, a timestamp)
    # are not the article's prose and must not be scanned for AI
    # tells — a title that happens to contain one of the phrases
    # would produce a false positive. Stripping is cheap and
    # idempotent, so it runs unconditionally.
    body = strip_frontmatter(article_text)

    if not body.strip():
        log_debug(
            "ai_markers: article stripped to empty — "
            "returning zero metrics"
        )
        return _empty_result()

    # ---- 3. Count occurrences of each phrase ----
    # The `markers` list only includes phrases that appeared at
    # least once — a phrase with a count of zero is not useful
    # information to the user, and including it would clutter
    # the report with a long list of "phrase: 0" entries.
    markers = []
    total_count = 0

    for phrase, pattern in _COMPILED_PHRASE_PATTERNS:
        matches = pattern.findall(body)
        count = len(matches)
        if count > 0:
            markers.append({
                "phrase": phrase,
                "count": int(count),
            })
            total_count += count

    # ---- 4. Sort the markers by descending count ----
    # The user reads the report to see which phrases are pulling
    # the section's status down. The phrases with the highest
    # counts are the ones the corrective loop should prioritize,
    # so they appear first. Ties are broken alphabetically so the
    # output is deterministic across runs — a Python sort is
    # stable, but sorting by count alone would leave the order
    # of tied phrases dependent on the phrase list's iteration
    # order, which a future edit could change.
    markers.sort(key=lambda m: (-m["count"], m["phrase"]))

    # ---- 5. Classify the status ----
    status = _classify_status(
        marker_count=total_count,
        max_ai_markers=max_ai_markers,
    )

    # ---- 6. Build and return ----
    return {
        "markerCount": int(total_count),
        "markers": markers,
        "status": status,
    }


# =============================================================================
#  Private: status classification
# =============================================================================

def _classify_status(
    marker_count: int,
    max_ai_markers: int,
) -> str:
    """
    Classify the AI-marker section as `'good'`, `'warning'`, or
    `'fail'`. See the module docstring for the reasoning.

    Summary of the rule, with a positive threshold:

      * `'good'`    — `marker_count` is at or below the
                      threshold.

      * `'warning'` — `marker_count` is at most twice the
                      threshold.

      * `'fail'`    — anything else.

    A non-positive threshold disables the "good" band: every
    article with any tells is at least a warning, and the
    warning band's upper edge is `2 * 0 = 0`, so every article
    with any tells is a fail. That is the correct behavior for a
    caller that has explicitly configured "no AI tells permitted"
    — the fact that the caller chose zero means the caller does
    not want a tolerance band.

    A threshold of exactly 0 with a `marker_count` of 0 returns
    `'good'` — the only value in the intersection of "at or below
    the threshold" and "there is something to classify".

    Args:
        marker_count:      The total number of phrase
                           occurrences.
        max_ai_markers:    The threshold for the `'good'` band.

    Returns:
        One of `'good'`, `'warning'`, `'fail'`.
    """
    if max_ai_markers > 0:
        if marker_count <= max_ai_markers:
            return "good"
        if marker_count <= 2 * max_ai_markers:
            return "warning"
        return "fail"

    # Threshold is zero or negative: no tolerance band.
    if marker_count <= 0:
        return "good"
    return "fail"


# =============================================================================
#  Private: empty-result builder
# =============================================================================

def _empty_result() -> dict:
    """
    Return the AI-marker section for an empty article.

    The count is zero, the markers list is empty, and the status
    is `'good'` — an article with no prose has no AI tells. The
    function is the single source of truth for that shape; both
    the "empty article" branch and the "frontmatter-only article"
    branch in `validate_ai_markers` return this value directly,
    so the two paths cannot drift apart.
    """
    return {
        "markerCount": 0,
        "markers": [],
        "status": "good",
    }


# =============================================================================
#  Default export
# =============================================================================

__all__ = [
    "validate_ai_markers",
]