#!/usr/bin/env python3
"""
validation/readability.py — readability scoring for the WriteSpeare pipeline.

The first of the six article validators. Reads the generated
article's plain text and produces the readability section of the
validation report: Flesch Reading Ease, Flesch-Kincaid Grade,
Gunning Fog, SMOG, average sentence length, and an estimated
reading time.

The scoring itself is entirely `textstat`'s. textstat is the
best-maintained readability library in the Python ecosystem —
every metric this module produces has a corresponding function
in it, each metric's formula matches the published academic
definition, and the library's handling of edge cases (a
single-sentence article, a paragraph of numbers, an article in a
non-Latin script) is well-tested. Reimplementing any of the six
metrics by hand would produce a homegrown formula that drifted
from the standard within a release or two.

What this module adds on top of textstat:

  1. Markdown stripping. textstat's metrics are defined over
     plain prose. Passing it raw Markdown source would count
     heading markers (`#`), emphasis markers (`**`), and list
     bullets (`-`) as words, inflating the sentence-length and
     Flesch metrics in a way that has nothing to do with the
     article's readability. The `_strip_markdown` helper runs
     the article through a targeted set of regexes that remove
     the markup while preserving the prose.

  2. Status classification. textstat produces numbers; the
     validation report needs a good / warning / fail verdict
     for the section as a whole. The verdict is derived by
     comparing the article's Flesch-Kincaid grade against the
     target grade band the user's preset declares. See
     `_classify_status` for the exact thresholds.

  3. Reading-time estimation. textstat does not compute a
     reading time; the `readingTimeSeconds` field on the
     report is derived here from textstat's word count and a
     standard adult reading speed.

The single public function, `validate_readability`, is a pure
function of `(article_text, target_grade_min, target_grade_max)`.
It reads no files, writes no files, and emits no markers — the
dispatcher (`validate_all.py`) owns all of those concerns. That
separation is what makes this validator testable in isolation
and what lets the dispatcher decide when to emit progress
markers around it.

The report shape this function returns matches the shared
`ReadabilityReport` interface declared in the desktop's
`features/shared/types/index.ts` and the backend's
`features/shared/types/index.ts`. The seven fields of that
interface are reproduced here exactly — the camelCase key names,
the numeric types, and the closed `'good' | 'warning' | 'fail'`
status union — because a mismatch here would surface as a
missing or malformed panel in the renderer's Report view.

Dependencies: Python stdlib + the `textstat` package (declared
in requirements.txt) + the sibling `core/` package.
"""

import re
import sys
from pathlib import Path

# =============================================================================
#  sys.path bootstrap — MUST run BEFORE any `from core.* import ...`
# =============================================================================
#  Identical to the bootstrap in every other feature script: the
#  script lives at scripts/validation/readability.py, so its own
#  directory is validation/, and the parent's parent is the
#  directory that contains `core/`. That directory must be on
#  sys.path for the sibling imports below to resolve in the
#  packaged app's embedded Python distribution, whose
#  python3xx._pth file overrides sys.path and does NOT
#  automatically prepend the script's own directory.

_SCRIPT_DIR = Path(__file__).resolve().parent
_SCRIPTS_ROOT = _SCRIPT_DIR.parent
if str(_SCRIPTS_ROOT) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_ROOT))

import textstat

from core.extractor import strip_frontmatter
from core.utils import log_debug, log_warning


# =============================================================================
#  Constants
# =============================================================================

# Standard adult reading speed, in words per minute. 250 is the
# middle of the commonly cited 200–300 wpm range and matches the
# value most reading-time calculators use. The exact number is a
# preference; the important property is that it is defined once,
# here, so every reading time the pipeline reports is computed
# from the same speed.
_WORDS_PER_MINUTE = 250

# The tolerance, in grade levels, around the target band that
# still classifies as `warning` rather than `fail`. See
# `_classify_status` for the full rule.
_GRADE_WARNING_MARGIN = 2.0

# The number of decimal places every numeric metric is rounded
# to before being placed in the report. textstat's underlying
# calculations produce many more digits than are meaningful — a
# Flesch score of 62.41738... is reported as 62.4 — and rounding
# to a fixed precision makes the report diffable and the UI
# readable.
_METRIC_PRECISION = 1


# =============================================================================
#  Markdown-stripping patterns
# =============================================================================
#
# Each pattern is compiled once at module load so a call to
# `validate_readability` does not pay the regex-compilation cost
# on every invocation. The patterns are ordered by the amount of
# text they consume, largest first, so a fenced code block is
# removed before an inline-code span inside it is considered. The
# `re.DOTALL` flag on the fenced-code pattern lets `.` match
# newlines so a multi-line block is consumed in a single match.

_CODE_FENCE_PATTERN = re.compile(r"```.*?```", re.DOTALL)
_INLINE_CODE_PATTERN = re.compile(r"`[^`]*`")

# Image syntax is stripped to its alt text (`![alt](url)` →
# `alt`) rather than to nothing, because the alt text is prose
# the author wrote and contributes to the article's word count
# in a text-reading sense.
_IMAGE_PATTERN = re.compile(r"!\[([^\]]*)\]\([^)]*\)")

# Link syntax is stripped to its visible text (`[text](url)` →
# `text`), for the same reason: the text is prose, the URL is
# not.
_LINK_PATTERN = re.compile(r"\[([^\]]+)\]\([^)]*\)")

_HEADING_PATTERN = re.compile(r"^\s{0,3}#{1,6}\s+", re.MULTILINE)
_BLOCKQUOTE_PATTERN = re.compile(r"^\s{0,3}>+\s?", re.MULTILINE)
_UNORDERED_LIST_PATTERN = re.compile(r"^\s{0,3}[-*+]\s+", re.MULTILINE)
_ORDERED_LIST_PATTERN = re.compile(r"^\s{0,3}\d+\.\s+", re.MULTILINE)
_HORIZONTAL_RULE_PATTERN = re.compile(
    r"^\s{0,3}(?:[-*_]\s*){3,}$", re.MULTILINE
)

# Asterisk emphasis covers `*italic*`, `**bold**`, and
# `***both***` in one pattern. The capture group preserves the
# wrapped text and the surrounding asterisks are dropped.
_EMPHASIS_ASTERISK_PATTERN = re.compile(r"\*{1,3}([^*]+)\*{1,3}")

# Underscore emphasis is restricted to `__bold__` (double) so
# that snake_case identifiers occasionally appearing in a
# technical article — `my_variable`, `parse_input` — are not
# mangled. Single underscores are treated as literal characters.
_EMPHASIS_UNDERSCORE_PATTERN = re.compile(r"__([^_]+)__")

# Inline HTML tags are removed. A few sites deliver Markdown
# with inline `<span>`, `<br>`, or `<a>` elements mixed in; the
# tags themselves are not prose and must not be counted as
# words.
_HTML_TAG_PATTERN = re.compile(r"<[^>]+>")

# Runs of three or more blank lines are collapsed to two. After
# the substitutions above, a document that was composed of a
# heading, a code block, and a paragraph can be left with a
# string of empty lines where the code block was. Collapsing
# keeps the resulting plain text tidy.
_WHITESPACE_COLLAPSE_PATTERN = re.compile(r"\n{3,}")


# =============================================================================
#  Public entry point
# =============================================================================

def validate_readability(
    article_text: str,
    target_grade_min: float = 7.0,
    target_grade_max: float = 9.0,
) -> dict:
    """
    Compute the readability section of the validation report for
    an article.

    See the module docstring for the rationale behind every
    decision. The contract with the caller (`validate_all.py`) is
    the shape of the returned dict, which matches the shared
    `ReadabilityReport` type declared in the desktop's and the
    backend's `features/shared/types/index.ts`:

        {
            "fleschReadingEase":  float,  # 0–100, higher = easier
            "fleschKincaidGrade": float,  # approximate US grade level
            "gunningFog":         float,  # Gunning Fog index
            "smogIndex":          float,  # SMOG index
            "avgSentenceLength":  float,  # words per sentence
            "readingTimeSeconds": int,    # integer seconds
            "status":             str,    # 'good' | 'warning' | 'fail'
        }

    The function never raises for a well-formed article. A
    malformed input — an empty string, a whitespace-only string —
    is handled by the same early-return branch as a genuine empty
    article: every metric is reported as zero and the status is
    `'fail'`. A caller that passes an empty article is asking
    "how readable is nothing?", and the correct answer is "not
    readable at all".

    A textstat call that raises for a specific metric — a
    pathological input that the library's algorithm does not
    handle — is caught and logged at warning level, and that
    metric is reported as zero while the other five are still
    computed. A single bad metric must not lose the whole
    section.

    Args:
        article_text:      The article's full text, including any
                           Markdown markup. Frontmatter, if
                           present, is stripped before scoring.
        target_grade_min:  The lower bound of the target
                           Flesch-Kincaid grade band. Defaults to
                           7.0, matching the plan's "target 7–9"
                           for a blog-post profile.
        target_grade_max:  The upper bound of the target grade
                           band. Defaults to 9.0.

    Returns:
        The readability section dict. Never None, never partial.
    """
    # ---- 1. Guard against empty input ----
    if not article_text or not article_text.strip():
        log_debug("readability: empty article — returning zero metrics")
        return _empty_result()

    # ---- 2. Strip frontmatter if present ----
    # A doc file or an article that carries YAML frontmatter
    # would otherwise have its metadata counted as prose. The
    # dispatcher loads the article from a `.md` file, which by
    # the pipeline's convention has no frontmatter — but
    # stripping is defensive and costs nothing when the block
    # is absent.
    body = strip_frontmatter(article_text)

    # ---- 3. Strip Markdown ----
    # See the module docstring for why this step is required
    # before passing the text to textstat.
    plain_text = _strip_markdown(body)

    if not plain_text.strip():
        # An article that is entirely markup — a set of empty
        # headings, an image-only page — has no prose to score.
        # Same answer as an empty article.
        log_debug(
            "readability: article stripped to empty — "
            "returning zero metrics"
        )
        return _empty_result()

    # ---- 4. Compute the six metrics ----
    # Each textstat call is wrapped in its own try/except so a
    # failure of one metric does not lose the other five. The
    # guards exist for pathological inputs (a very long
    # single-word article, a text with no sentence terminators)
    # that textstat's underlying algorithms do not always handle
    # cleanly.

    try:
        flesch_ease = float(textstat.flesch_reading_ease(plain_text))
    except Exception as exc:
        log_warning(f"readability: flesch_reading_ease failed: {exc}")
        flesch_ease = 0.0

    try:
        flesch_grade = float(textstat.flesch_kincaid_grade(plain_text))
    except Exception as exc:
        log_warning(f"readability: flesch_kincaid_grade failed: {exc}")
        flesch_grade = 0.0

    try:
        gunning_fog = float(textstat.gunning_fog(plain_text))
    except Exception as exc:
        log_warning(f"readability: gunning_fog failed: {exc}")
        gunning_fog = 0.0

    try:
        smog = float(textstat.smog_index(plain_text))
    except Exception as exc:
        log_warning(f"readability: smog_index failed: {exc}")
        smog = 0.0

    try:
        avg_sentence = float(
            textstat.avg_sentence_length(plain_text)
        )
    except Exception as exc:
        log_warning(
            f"readability: avg_sentence_length failed: {exc}"
        )
        avg_sentence = 0.0

    try:
        word_count = int(
            textstat.lexicon_count(plain_text, removepunct=True)
        )
    except Exception as exc:
        log_warning(f"readability: lexicon_count failed: {exc}")
        word_count = 0

    # ---- 5. Derive the reading time ----
    # Words per minute is the standard adult silent-reading
    # speed. The result is rounded to the nearest integer
    # second so the UI can format it as "4 min 20 sec" without
    # an awkward fractional-seconds value.
    reading_time_seconds = _compute_reading_time_seconds(word_count)

    # ---- 6. Classify the status ----
    status = _classify_status(
        flesch_grade, target_grade_min, target_grade_max
    )

    # ---- 7. Build and return the section ----
    return {
        "fleschReadingEase": _round_metric(flesch_ease),
        "fleschKincaidGrade": _round_metric(flesch_grade),
        "gunningFog": _round_metric(gunning_fog),
        "smogIndex": _round_metric(smog),
        "avgSentenceLength": _round_metric(avg_sentence),
        "readingTimeSeconds": reading_time_seconds,
        "status": status,
    }


# =============================================================================
#  Private: Markdown stripping
# =============================================================================

def _strip_markdown(text: str) -> str:
    """
    Strip Markdown syntax from a text and return the plain prose.

    The transformation is not a general-purpose Markdown parser.
    It is a targeted set of substitutions that removes exactly
    the markup characters that would otherwise be counted as
    words or as sentence-boundary candidates by textstat. See
    the module docstring for why this is necessary.

    Ordering of the substitutions is deliberate and matters:

      1. Fenced code blocks. Removed first so that any `#`, `*`,
         or `_` characters inside a shell snippet, a regex
         example, or a source listing are not treated as Markdown
         by the substitutions that follow.

      2. Inline code spans. Removed second, for the same reason
         on a smaller scale.

      3. Images and links. Removed third because the image
         syntax `![alt](url)` also contains the link syntax
         `[alt](url)` as a substring; substituting links first
         would leave a stray `!` in front of the alt text.

      4. Structural markup — headings, blockquotes, list
         markers, horizontal rules. Each is anchored to the
         start of a line so the substitution does not fire on a
         `-` that happens to appear mid-sentence (a hyphenated
         word, a parenthetical).

      5. Emphasis markers. Asterisk-based first, then
         underscore-based.

      6. Inline HTML tags. Removed last because a tag can wrap
         inline Markdown (`<span>*bold*</span>`), and removing
         the tag first would leave the emphasis markers to be
         handled by step 5 anyway — the order between steps 5
         and 6 does not matter in practice, but pinning an
         order keeps the function deterministic.

      7. Blank-line collapsing. Runs last, after every removal
         that could leave a run of empty lines behind.

    The function never raises. Each substitution is a `re.sub`
    over a valid pattern, and `re.sub` with a pattern that does
    not match returns the input unchanged. A malformed input —
    an unterminated code fence, a link with a missing `)` —
    simply fails to match its pattern and remains in the text;
    the resulting plain text is scored on whatever it contains,
    which is the correct behaviour for a best-effort stripper.

    Args:
        text: The Markdown source.

    Returns:
        The text with Markdown syntax removed, stripped of
        leading and trailing whitespace.
    """
    # 1. Fenced code blocks.
    text = _CODE_FENCE_PATTERN.sub(" ", text)

    # 2. Inline code spans.
    text = _INLINE_CODE_PATTERN.sub(" ", text)

    # 3. Images before links (see docstring).
    text = _IMAGE_PATTERN.sub(r"\1", text)
    text = _LINK_PATTERN.sub(r"\1", text)

    # 4. Structural markup.
    text = _HEADING_PATTERN.sub("", text)
    text = _BLOCKQUOTE_PATTERN.sub("", text)
    text = _UNORDERED_LIST_PATTERN.sub("", text)
    text = _ORDERED_LIST_PATTERN.sub("", text)
    text = _HORIZONTAL_RULE_PATTERN.sub("", text)

    # 5. Emphasis markers.
    text = _EMPHASIS_ASTERISK_PATTERN.sub(r"\1", text)
    text = _EMPHASIS_UNDERSCORE_PATTERN.sub(r"\1", text)

    # 6. Inline HTML tags.
    text = _HTML_TAG_PATTERN.sub(" ", text)

    # 7. Collapse blank lines left by the removals.
    text = _WHITESPACE_COLLAPSE_PATTERN.sub("\n\n", text)

    return text.strip()


# =============================================================================
#  Private: metric helpers
# =============================================================================

def _round_metric(value: float) -> float:
    """
    Round a numeric readability metric to the fixed precision
    declared by `_METRIC_PRECISION`.

    The function converts its argument to `float` before
    rounding, because a future textstat release that returns a
    numpy scalar would produce a `numpy.float64` object whose
    JSON serialization is not guaranteed — the explicit cast
    normalizes every metric to a plain Python float before it
    reaches the report dict.
    """
    return round(float(value), _METRIC_PRECISION)


def _compute_reading_time_seconds(word_count: int) -> int:
    """
    Convert a word count into an estimated reading time, in
    integer seconds, for a typical adult reader.

    The reading speed is `_WORDS_PER_MINUTE`. A non-positive
    word count yields zero — the caller is responsible for
    deciding what a zero reading time means in context (for an
    empty article, it means the same as every other zero
    metric).

    The result is rounded to the nearest integer second. A
    twelve-hundred-word article at 250 wpm yields 288 seconds
    (4 min 48 sec); the UI formats it as "4 min 48 sec" by
    dividing by 60 and taking the remainder.
    """
    if word_count <= 0:
        return 0
    minutes = word_count / _WORDS_PER_MINUTE
    return int(round(minutes * 60))


def _classify_status(
    grade: float,
    target_min: float,
    target_max: float,
) -> str:
    """
    Classify the readability section as `'good'`, `'warning'`,
    or `'fail'` based on where the article's Flesch-Kincaid
    grade falls relative to the target band.

    The rule:

      * `'good'`    — the grade is inside `[target_min,
                     target_max]`. The article hits the band
                     the user's preset declares.

      * `'warning'` — the grade is within `_GRADE_WARNING_MARGIN`
                     grade levels of the band on either side. A
                     grade of 10.5 against a 7–9 target is
                     slightly too advanced for the intended
                     audience; it does not deserve a `'fail'`
                     but the user should know.

      * `'fail'`    — anything else. A grade of 3 against a
                     7–9 target is well below the band; a grade
                     of 16 is well above. Either case is a
                     substantial miss and the report surfaces it
                     as a hard failure so the corrective loop
                     can act.

    The target bounds are swapped if the caller passes them
    backwards (max < min). The preset UI prevents this, but a
    future caller of this function directly might not, and a
    silent miscalculation would be worse than a normalizing
    swap.

    The return value is always one of the three literals. It is
    never `None` and never an empty string.

    Args:
        grade:       The article's Flesch-Kincaid grade.
        target_min:  The lower bound of the acceptable band.
        target_max:  The upper bound of the acceptable band.

    Returns:
        `'good'`, `'warning'`, or `'fail'`.
    """
    # Defensive swap. See the docstring for the rationale.
    if target_max < target_min:
        target_min, target_max = target_max, target_min

    # Inside the band.
    if target_min <= grade <= target_max:
        return "good"

    # Within the warning margin on either side.
    lower_warning = target_min - _GRADE_WARNING_MARGIN
    upper_warning = target_max + _GRADE_WARNING_MARGIN
    if lower_warning <= grade <= upper_warning:
        return "warning"

    # Outside the margin.
    return "fail"


def _empty_result() -> dict:
    """
    Return the readability section for an empty or entirely
    non-prose article.

    Every metric is zero and the status is `'fail'`. The
    function is the single source of truth for that shape — both
    the "empty input" branch and the "stripped-to-empty branch"
    in `validate_readability` return this value, so the two
    paths cannot drift apart.

    The function takes no arguments, because none of the
    metrics depend on the target grade band. A caller that
    wants to know why the status is `'fail'` does not need to
    know the band — the article simply has nothing to score.
    """
    return {
        "fleschReadingEase": 0.0,
        "fleschKincaidGrade": 0.0,
        "gunningFog": 0.0,
        "smogIndex": 0.0,
        "avgSentenceLength": 0.0,
        "readingTimeSeconds": 0,
        "status": "fail",
    }


# =============================================================================
#  Default export
# =============================================================================

__all__ = [
    "validate_readability",
]