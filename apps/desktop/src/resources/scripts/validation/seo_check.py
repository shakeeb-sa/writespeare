#!/usr/bin/env python3
"""
validation/seo_check.py — structural SEO validation for WriteSpeare.

The second of the six article validators. Reads the generated
article's raw Markdown, counts its structural elements (words,
H2 and H3 headings, paragraphs), and computes two prose-density
signals — the fraction of sentences that are passive, and the
fraction of sentences that contain a transition word. Together
these six numbers form the `seo` section of the validation
report.

What "structural SEO" means here:

    This validator measures the SHAPE of the article, not its
    topic selection or its keyword placement. Keyword placement
    is `keyword_check.py`'s job; content quality is
    `originality.py`'s and `ai_markers.py`'s. This module's
    concerns are the ones a search-engine content-quality
    assessor looks at when it is deciding whether an article
    reads as a well-structured piece of writing:

      * Word count — is the article the length it claims to be?
      * H2 count — does the article have a scannable section
        structure, or is it one long wall of text?
      * H3 count — does each section subdivide its ideas?
      * Average paragraph length — are the paragraphs readable
        prose, or are they crammed-together run-ons?
      * Passive-voice fraction — does the prose read actively,
        or does it hide its subjects behind the passive voice?
      * Transition-word fraction — does the prose use connectives
        between ideas, or does it just staple sentences together?

    Every one of those questions has a defensible answer that
    maps onto the six numbers. The status field collapses the
    answers into a single good / warning / fail verdict.

What this module reads from the raw Markdown, and what it reads
from the stripped prose:

    The pipeline's article `.md` file carries two kinds of text:
    the Markdown structure — `## ` prefixes, `**bold**` markers,
    `- ` list bullets, fenced code blocks — and the prose the
    structure describes. The two SEO metrics operate on
    different views of that text:

      * The heading counts and the paragraph count read the RAW
        Markdown. A heading is a line beginning with `##` or
        `###`; stripping the `##` before counting would make
        every heading indistinguishable from every other line of
        prose.

      * The word count, the sentence-level metrics (passive
        voice, transition words), and the average paragraph
        length read the STRIPPED prose. Passing raw Markdown to
        the sentence tokenizer would produce "sentences" that
        end in a bullet-point dash and "words" that are really
        heading prefixes — numbers that have nothing to do with
        the article's readability as prose.

    The module therefore strips Markdown for the prose metrics
    and reads the raw text for the structural metrics. The
    heading counters are declared as their own private helpers
    precisely so that the distinction is enforced at the call
    site, not accidentally blurred inside a shared utility.

Passive-voice detection:

    The detector tokenizes each sentence, POS-tags it with
    NLTK's averaged-perceptron tagger, and looks for the
    classical English passive pattern: a form of the verb "to
    be" (tagged `VB`, `VBD`, `VBP`, `VBZ`, `VBG`, or `VBN` and
    whose lemma is "be") followed within a short window by a
    past participle (tagged `VBN`). That pattern catches the
    three common passive constructions:

      "The article was written by the author."  (was + written)
      "The book has been read many times."      (been + read)
      "The proposal is being considered."       (being + considered)

    It does NOT catch every passive in English — a deeper
    syntactic parse would catch more, and would also drag a
    full parser into the pipeline. The classical pattern catches
    the overwhelming majority of passive constructions in
    ordinary prose, and it does so with NLTK's tagger alone,
    which is what the pipeline already ships.

    The `_PASSIVE_BE_FORMS` set lists the surface forms of "be"
    the detector recognises. A form that NLTK tags as one of the
    be-verb tags but that does NOT appear in the set is treated
    as a lexical false positive — "had" is tagged `VBD` but is a
    form of "have", not of "be".

Transition-word detection:

    The detector uses a curated list of English transition words
    and transition phrases — connectives that a writer uses to
    signal a logical relationship between two ideas. The list is
    split into two sets: single-word transitions (matched
    against the tokenizer's word tokens) and multi-word
    transitions (matched against the sentence's lowercased
    surface text). A sentence counts as "containing a
    transition" if it contains at least one member of either
    set.

    The list is deliberately curated rather than scraped from a
    corpus. The plan calls for detecting the transitions a
    good writer uses, and the approximately sixty entries in
    `_TRANSITION_WORDS` cover every connective the style guides
    that informed this project actually name. A larger list
    would begin to include words that are not transitions in
    every context — "still", for example, is a transition in
    "still, the pattern holds" but is a plain adverb in "the
    kettle is still hot". Those ambiguous cases are included
    with the knowledge that they inflate the fraction slightly
    on sentences that use the word in a non-transitional sense;
    the alternative — a full syntactic check for connective
    scope — is disproportionate to the value of the metric.

The report shape this function returns matches the shared
`SeoReport` interface declared in the desktop's
`features/shared/types/index.ts` and the backend's
`features/shared/types/index.ts`:

    {
        "wordCount":               int,
        "h2Count":                 int,
        "h3Count":                 int,
        "avgParagraphWords":       float,
        "passiveVoicePercent":     float,  # 0–1 fraction
        "transitionWordsPercent":  float,  # 0–1 fraction
        "status":                  str,    # 'good' | 'warning' | 'fail'
    }

The two `Percent` fields are fractions, not whole percentages.
The `Report` Mongoose schema in `apps/server/src/features/
reports/models/Report.ts` enforces `min: 0, max: 1` on both,
and the desktop's `SeoPanel` multiplies by 100 at render time
for display. Returning 6 rather than 0.06 would fail the schema
and read as 600% in the panel.

Dependencies: Python stdlib + the `nltk` package (declared in
requirements.txt) + the sibling `core/` package.
"""

import re
import sys
from pathlib import Path

# =============================================================================
#  sys.path bootstrap — MUST run BEFORE any `from core.* import ...`
# =============================================================================
#  Identical to the bootstrap in every other feature script. The
#  script lives at scripts/validation/seo_check.py, so its own
#  directory is validation/, and the parent's parent is the
#  directory that contains `core/`. That directory must be on
#  sys.path for the sibling imports below to resolve in the
#  packaged app's embedded Python distribution.

_SCRIPT_DIR = Path(__file__).resolve().parent
_SCRIPTS_ROOT = _SCRIPT_DIR.parent
if str(_SCRIPTS_ROOT) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_ROOT))

import nltk
from nltk import pos_tag, sent_tokenize, word_tokenize

from core.utils import log_debug, log_warning


# =============================================================================
#  Constants — heading detection
# =============================================================================
#
# Each heading level is matched by its own compiled pattern,
# anchored to the start of a line, allowing up to three spaces of
# indentation (Markdown permits up to three before the `#` and
# still recognises the line as a heading — four spaces makes it a
# code block). The trailing `\s+` requires at least one whitespace
# character after the hashes, which is the CommonMark rule and
# which correctly excludes a line like `###hashtag` that is a
# social-media tag rather than a heading.

_H2_PATTERN = re.compile(r"^\s{0,3}##\s+\S", re.MULTILINE)
_H3_PATTERN = re.compile(r"^\s{0,3}###\s+\S", re.MULTILINE)


# =============================================================================
#  Constants — Markdown stripping for prose analysis
# =============================================================================
#
# A narrower set of patterns than `readability.py`'s stripper.
# This module does not need to remove code fences, images, or
# links from the text before counting words — but it does need to
# remove the emphasis markers, inline code spans, and list and
# heading prefixes, because those are the characters that would
# otherwise be counted as words and would inflate or distort the
# passive-voice and transition-word fractions.
#
# The patterns are declared locally rather than imported from
# `readability.py` because the two modules' stripping needs
# overlap but are not identical, and coupling them by import
# would force a future change to one to be reviewed against the
# other. The duplication is bounded — eight regexes and a few
# lines of substitution — and the two files' docstrings already
# document why each stripper exists.

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
#  Constants — passive-voice detection
# =============================================================================
#
# The surface forms of the verb "to be". A token that NLTK tags
# with one of the be-verb tags (VB, VBD, VBP, VBZ, VBG, VBN) but
# whose lowercased form is not in this set is a different
# verb — "had" is tagged VBD but is a form of "have", "go" is
# tagged VB but is not a be-verb. The set is the disambiguator
# between a genuine be-passive and a lexical coincidence of the
# tagger.
#
# `were` and `was` handle the past tense; `is`, `are`, `am`,
# `be` handle the present and infinitive; `been` handles the
# perfect; `being` handles the progressive; `were` and `was`
# handle the plural and singular past. Every surface form of
# "to be" in standard English is present.

_PASSIVE_BE_FORMS = frozenset({
    "be", "am", "is", "are", "was", "were",
    "been", "being",
})

# The tags NLTK assigns to a form of "to be". The tagger uses
# `VB` for the infinitive, `VBD` for the past, `VBP` for the
# non-third-person present, `VBZ` for the third-person singular
# present, `VBG` for the gerund/present participle, and `VBN`
# for the past participle.
#
# Note that `VBN` appears in BOTH the be-form tags and the
# past-participle tags because a form of "be" can itself be a
# past participle in a compound construction — "has been
# considered" contains the token "been" tagged VBN and the
# token "considered" also tagged VBN. The detector's window
# logic (a be-form followed by a VBN) naturally handles this:
# the "been" is a be-form, and the "considered" is the VBN it
# governs.
_BE_VERB_TAGS = frozenset({"VB", "VBD", "VBP", "VBZ", "VBG", "VBN"})

# The tag NLTK assigns to a past participle. In the passive
# construction, this is what follows the be-form.
_PAST_PARTICIPLE_TAG = "VBN"

# How many tokens after a be-form the detector searches for the
# past participle. The passive window is short — "was written",
# "has been considered", "is being tested" all have the VBN
# within three tokens of the leading be-form. A longer window
# would begin to match unrelated clauses and inflate the passive
# fraction.
_PASSIVE_WINDOW = 3


# =============================================================================
#  Constants — transition-word detection
# =============================================================================
#
# Two sets: single-word transitions matched against the
# tokenizer's word tokens, and multi-word transitions matched
# against the sentence's lowercased surface text. See the module
# docstring for the curation rationale.

_SINGLE_WORD_TRANSITIONS = frozenset({
    # Contrast and concession
    "however", "nevertheless", "nonetheless", "still", "yet",
    "although", "though", "whereas", "conversely", "instead",
    "otherwise", "rather",
    # Addition and continuation
    "moreover", "furthermore", "additionally", "similarly",
    "likewise", "besides", "also", "equally",
    # Cause and effect
    "therefore", "consequently", "accordingly", "hence", "thus",
    "subsequently", "thereby",
    # Sequence and enumeration
    "first", "firstly", "second", "secondly", "third", "thirdly",
    "fourth", "fourthly", "finally", "lastly", "next", "then",
    "later", "meanwhile", "ultimately", "eventually",
    # Emphasis and clarification
    "indeed", "particularly", "specifically", "notably",
    "especially", "importantly", "significantly",
})

_MULTI_WORD_TRANSITIONS = frozenset({
    "in addition",
    "in contrast",
    "in conclusion",
    "in summary",
    "in short",
    "in fact",
    "in particular",
    "in general",
    "in other words",
    "in essence",
    "on the other hand",
    "on the contrary",
    "for example",
    "for instance",
    "as a result",
    "as such",
    "as a consequence",
    "by contrast",
    "by comparison",
    "by extension",
    "to that end",
    "to be sure",
    "of course",
    "at the same time",
    "at the same time",
})


# =============================================================================
#  Public entry point
# =============================================================================

def validate_seo(
    article_text: str,
    target_word_count: int = 1200,
    min_h2_sections: int = 3,
    max_passive_voice: float = 0.10,
    min_transition_words: float = 0.20,
) -> dict:
    """
    Compute the SEO section of the validation report for an
    article. See the module docstring for the reasoning behind
    every metric and every threshold.

    The function is a pure transformation: given the article's
    Markdown and a set of thresholds, it produces the same
    section dict every time, with no file I/O, no network access,
    and no side effects. The caller (`validate_all.py`) owns the
    dispatch and the marker emission.

    Threshold defaults:

      `target_word_count`     — 1200, matching the plan's
                                Balanced preset and the backend's
                                default for the `wordCount` field
                                on a `Topic`.

      `min_h2_sections`       — 3, the minimum that produces a
                                scannable article. Below three,
                                the article reads as a single
                                block of prose rather than as a
                                structured piece.

      `max_passive_voice`     — 0.10, matching the shared type's
                                "target" and the plan's user
                                journey example (6%). A tenth of
                                sentences reading passively is
                                tolerated; more than a fifth is
                                flagged as a fail.

      `min_transition_words`  — 0.20, matching the plan's user
                                journey example (4.1% would be
                                quite low; 20% of sentences
                                containing a connective is a
                                reasonable minimum for prose that
                                reads as connected reasoning
                                rather than as a list of facts).

    Args:
        article_text:           The article's full Markdown text,
                                including any frontmatter.
        target_word_count:      The intended word count. Used to
                                classify the word-count status;
                                does not affect any other metric.
        min_h2_sections:        The minimum number of H2 headings
                                for a `'good'` heading-structure
                                classification.
        max_passive_voice:      The maximum acceptable passive-
                                voice fraction (0–1) for a
                                `'good'` classification.
        min_transition_words:   The minimum transition-word
                                fraction (0–1) for a `'good'`
                                classification.

    Returns:
        The SEO section dict. Never None, never partial — a
        malformed input produces a well-formed zero-valued dict.
    """
    # ---- 1. Guard against empty input ----
    if not article_text or not article_text.strip():
        log_debug("seo_check: empty article — returning zero metrics")
        return _empty_result()

    # ---- 2. Structural metrics from the RAW Markdown ----
    # The heading counts read the raw text because stripping the
    # `##` prefixes would destroy the very signal being counted.
    h2_count = _count_h2_headings(article_text)
    h3_count = _count_h3_headings(article_text)

    # ---- 3. Strip Markdown for the prose metrics ----
    plain_text = _strip_markdown_for_prose(article_text)
    if not plain_text.strip():
        # An article that is entirely headings has prose metrics
        # of zero but retains its structural metrics from above.
        # Reporting zero for the prose metrics is the correct
        # answer — there is no prose to score.
        log_debug(
            "seo_check: article stripped to empty prose — "
            "prose metrics will be zero"
        )
        word_count = 0
        avg_paragraph_words = 0.0
        passive_fraction = 0.0
        transition_fraction = 0.0
    else:
        # ---- 3a. Word count ----
        word_count = _count_words(plain_text)

        # ---- 3b. Paragraph structure ----
        paragraphs = _split_paragraphs(plain_text)
        avg_paragraph_words = _avg_paragraph_words(paragraphs)

        # ---- 3c. Sentence-level metrics ----
        sentences = _tokenize_sentences(plain_text)
        passive_fraction = _passive_voice_fraction(sentences)
        transition_fraction = _transition_words_fraction(sentences)

    # ---- 4. Classify the status ----
    status = _classify_status(
        word_count=word_count,
        target_word_count=target_word_count,
        h2_count=h2_count,
        min_h2_sections=min_h2_sections,
        avg_paragraph_words=avg_paragraph_words,
        passive_fraction=passive_fraction,
        max_passive_voice=max_passive_voice,
        transition_fraction=transition_fraction,
        min_transition_words=min_transition_words,
    )

    # ---- 5. Build and return the section ----
    return {
        "wordCount": int(word_count),
        "h2Count": int(h2_count),
        "h3Count": int(h3_count),
        "avgParagraphWords": round(float(avg_paragraph_words), 1),
        "passiveVoicePercent": round(float(passive_fraction), 4),
        "transitionWordsPercent": round(float(transition_fraction), 4),
        "status": status,
    }


# =============================================================================
#  Private: Markdown stripping
# =============================================================================

def _strip_markdown_for_prose(text: str) -> str:
    """
    Strip Markdown syntax and return the plain prose for the
    sentence-level metrics.

    Narrower than `readability.py`'s stripper: this function does
    not need to remove images or links entirely (their visible
    text contributes to the prose), and does not need to preserve
    paragraph boundaries (those are computed separately from the
    original text). It removes the markup characters that would
    be tokenized as words — emphasis markers, inline code,
    heading and list prefixes — and leaves the rest of the text
    untouched.

    The substitution order matters, matching the reasoning in
    `readability.py`:

      1. Code fences first, so a `#` inside a shell snippet is
         not treated as a heading.
      2. Inline code spans.
      3. Images to alt text, then links to link text — images
         first because the image syntax contains the link syntax
         as a substring.
      4. Structural prefixes — headings, blockquotes, list
         markers, horizontal rules.
      5. Emphasis markers.
      6. HTML tags.
      7. Blank-line collapse.

    Never raises. A pattern that does not match returns the input
    unchanged; a malformed input remains in the text and is
    scored as it appears.

    Args:
        text: The article's Markdown source.

    Returns:
        The prose with markup removed, stripped.
    """
    # 1. Code fences.
    text = _MD_CODE_FENCE_PATTERN.sub(" ", text)

    # 2. Inline code.
    text = _MD_INLINE_CODE_PATTERN.sub(" ", text)

    # 3. Images and links.
    text = _MD_IMAGE_PATTERN.sub(r"\1", text)
    text = _MD_LINK_PATTERN.sub(r"\1", text)

    # 4. Structural prefixes.
    text = _MD_HEADING_PATTERN.sub("", text)
    text = _MD_BLOCKQUOTE_PATTERN.sub("", text)
    text = _MD_UNORDERED_LIST_PATTERN.sub("", text)
    text = _MD_ORDERED_LIST_PATTERN.sub("", text)
    text = _MD_HORIZONTAL_RULE_PATTERN.sub("", text)

    # 5. Emphasis markers.
    text = _MD_EMPHASIS_ASTERISK_PATTERN.sub(r"\1", text)
    text = _MD_EMPHASIS_UNDERSCORE_PATTERN.sub(r"\1", text)

    # 6. Inline HTML.
    text = _MD_HTML_TAG_PATTERN.sub(" ", text)

    # 7. Blank-line collapse.
    text = _MD_WHITESPACE_COLLAPSE_PATTERN.sub("\n\n", text)

    return text.strip()


# =============================================================================
#  Private: structural metrics
# =============================================================================

def _count_h2_headings(text: str) -> int:
    """
    Return the number of H2 headings in the raw Markdown.

    A heading is a line that begins with exactly two hashes
    followed by at least one whitespace character. The pattern
    is anchored to the start of a line, so `## Real heading`
    counts but `This has ## inside it` does not.

    See the module's heading-pattern constants for the full
    CommonMark rule the pattern implements.

    Args:
        text: The raw Markdown source.

    Returns:
        The count of H2 headings. Zero when none are present.
    """
    return len(_H2_PATTERN.findall(text))


def _count_h3_headings(text: str) -> int:
    """
    Return the number of H3 headings in the raw Markdown.

    An H3 is a line beginning with exactly three hashes followed
    by whitespace. The pattern is declared with an explicit `\\s+`
    after the third hash rather than a `##[^#]` lookahead so that
    a line of `##` (an H2) does not match the H3 pattern — the
    pattern requires a third hash character before the space.

    Args:
        text: The raw Markdown source.

    Returns:
        The count of H3 headings. Zero when none are present.
    """
    return len(_H3_PATTERN.findall(text))


# =============================================================================
#  Private: word, paragraph, and sentence metrics
# =============================================================================

def _count_words(text: str) -> int:
    """
    Return the number of words in the plain-prose text.

    A word is a run of one or more word characters — letters,
    digits, and underscores — matched by the `\\w+` pattern
    against the stripped prose. Punctuation runs are not words;
    a lone hyphen does not count.

    The definition matches what the article's own `wordCount`
    field on the `Article` schema is expected to hold — a count
    of words as a human would count them, not a count of tokens
    as a tokenizer would produce. Punctuation-separated tokens
    that a general-purpose tokenizer would split — "well-known"
    becomes one word here, not two — are the correct unit for
    an article-length metric.

    Args:
        text: The plain-prose text.

    Returns:
        The word count. Zero for an empty input.
    """
    return len(re.findall(r"\w+", text))


def _split_paragraphs(text: str) -> list:
    """
    Split the plain-prose text into paragraphs by blank lines.

    A paragraph is a maximal run of non-blank lines. The split
    uses a blank-line separator — two or more consecutive
    newlines — which matches the CommonMark rule and which is
    what the article generator's Markdown output uses between
    its body paragraphs.

    Empty segments produced by trailing or leading blank lines
    are filtered out, so the returned list contains only the
    non-empty paragraph bodies.

    Args:
        text: The plain-prose text.

    Returns:
        A list of paragraph strings. Empty when the input has no
        non-blank content.
    """
    blocks = re.split(r"\n\s*\n", text)
    return [b.strip() for b in blocks if b.strip()]


def _avg_paragraph_words(paragraphs: list) -> float:
    """
    Return the average number of words per paragraph.

    A simple arithmetic mean over the paragraph word counts.
    Zero paragraphs yields zero, and the caller treats a zero
    average paragraph length as a valid — if uninformative —
    metric.

    The helper is a private function rather than an inline
    expression so the two arithmetic steps — count the words,
    divide by the count of paragraphs — are visible in one
    place and cannot drift from each other across a future
    edit.

    Args:
        paragraphs: The list of paragraph strings.

    Returns:
        The average word count per paragraph. Zero when the list
        is empty.
    """
    if not paragraphs:
        return 0.0
    total = sum(_count_words(p) for p in paragraphs)
    return total / len(paragraphs)


def _tokenize_sentences(text: str) -> list:
    """
    Tokenize the plain-prose text into sentences, with a
    regex-based fallback if NLTK's sentence tokenizer is
    unavailable.

    The primary path uses `nltk.sent_tokenize`, which is the
    same tokenizer the rest of the validation package relies on
    for its sentence-level metrics, and which correctly handles
    the punctuation cases a naive splitter misses — "Dr. Smith"
    is not two sentences, "the U.S. policy" is not two
    sentences, and a decimal "3.14" does not split mid-number.

    The fallback is a regex split on sentence-ending punctuation
    followed by whitespace. It is coarser than the punkt model
    but produces usable sentence boundaries for the passive-voice
    and transition-word fractions, and its presence means the
    validator never crashes when the NLTK data is missing.

    Never raises. Any exception from the primary path is logged
    at warning level and the fallback is used.

    Args:
        text: The plain-prose text.

    Returns:
        A list of sentence strings. Empty for empty input.
    """
    if not text or not text.strip():
        return []

    try:
        return list(nltk.sent_tokenize(text))
    except LookupError:
        log_warning(
            "seo_check: NLTK punkt model is not installed; "
            "using regex sentence splitting"
        )
        return _regex_sentence_split(text)
    except Exception as exc:
        log_warning(
            f"seo_check: sentence tokenization failed ({exc}); "
            f"using regex sentence splitting"
        )
        return _regex_sentence_split(text)


def _regex_sentence_split(text: str) -> list:
    """
    Split a text into sentences by a regex on sentence-ending
    punctuation. The fallback used by `_tokenize_sentences` when
    NLTK's tokenizer is not available. See that function's
    docstring for the trade-off.

    The pattern requires sentence-ending punctuation followed by
    at least one whitespace character, which avoids splitting on
    a decimal (no whitespace after the `.`) or on an abbreviation
    that is followed by a comma rather than a period.

    Args:
        text: The plain-prose text.

    Returns:
        A list of sentence strings, each stripped of surrounding
        whitespace. Empty segments are filtered out.
    """
    parts = re.split(r"(?<=[.!?])\s+", text)
    return [p.strip() for p in parts if p.strip()]


def _tokenize_words(text: str) -> list:
    """
    Tokenize a sentence into words, with a regex-based fallback.

    The primary path uses `nltk.word_tokenize`, which is the
    treebank-style tokenizer and which correctly separates
    contractions ("don't" becomes two tokens), handles possessives
    ("Smith's"), and splits off trailing punctuation as its own
    token. The last of those is what the passive-voice detector
    relies on — a be-form followed by a comma would be mistagged
    by a simpler tokenizer as one token.

    The fallback matches runs of word characters, the same
    definition used by `_count_words`. It is coarser but
    sufficient for both the passive-voice and transition-word
    detectors, which operate on the words the tokenizer emits
    and do not care about the punctuation boundaries between
    them.

    Never raises.

    Args:
        text: A sentence string.

    Returns:
        A list of word tokens. Empty for an empty input.
    """
    if not text or not text.strip():
        return []

    try:
        return list(word_tokenize(text))
    except LookupError:
        log_warning(
            "seo_check: NLTK punkt model is not installed; "
            "using regex word tokenization"
        )
        return re.findall(r"\w+", text)
    except Exception as exc:
        log_warning(
            f"seo_check: word tokenization failed ({exc}); "
            f"using regex word tokenization"
        )
        return re.findall(r"\w+", text)


# =============================================================================
#  Private: passive voice
# =============================================================================

def _passive_voice_fraction(sentences: list) -> float:
    """
    Compute the fraction of sentences that contain a passive
    construction. See the module docstring for the detection
    rule and the trade-offs of using NLTK's tagger rather than a
    full parser.

    The function returns a fraction in the range [0, 1] — 0.0
    when no sentence is passive, 1.0 when every sentence is.
    The caller multiplies by 100 for display.

    The POS tagger is applied to one sentence at a time, not to
    the whole text at once, because the classical passive
    pattern is short-range — a be-form followed by a past
    participle within a few tokens — and a longer text would
    introduce cross-sentence coincidences (a sentence ending
    with "was" followed by a sentence beginning with a past
    participle would be falsely matched if the text were tagged
    as a single block).

    A tagger failure for a single sentence — an exceptionally
    long sentence, an input with characters the tagger cannot
    handle — is caught, logged at debug level, and the sentence
    is counted as non-passive. The alternative — losing the
    whole fraction to one bad sentence — is a worse trade.

    Args:
        sentences: The list of sentence strings.

    Returns:
        The fraction of sentences containing a passive
        construction. Zero for an empty list.
    """
    if not sentences:
        return 0.0

    passive_count = 0
    for sentence in sentences:
        if not sentence or not sentence.strip():
            continue
        try:
            words = _tokenize_words(sentence)
            if not words:
                continue
            tagged = pos_tag(words)
            if _sentence_is_passive(tagged):
                passive_count += 1
        except Exception as exc:
            log_debug(
                f"seo_check: POS tagging failed for one sentence "
                f"({exc}); counted as non-passive"
            )
            continue

    return passive_count / len(sentences)


def _sentence_is_passive(tagged: list) -> bool:
    """
    Return True if a POS-tagged sentence contains a classical
    English passive construction.

    The rule: a token whose lowercased form is a surface form of
    "to be" AND whose tag is a be-verb tag, followed within
    `_PASSIVE_WINDOW` tokens by a token tagged `VBN` (past
    participle). The window is short — three tokens — because
    the passive's be-form and past participle are always adjacent
    or separated by a single adverb or negation:

        "was written"         (adjacent)
        "was carefully written" (one adverb between)
        "was not written"     (negation between)
        "has been considered" (the first be-form is `has`, which
                              NLTK tags `VBZ` and whose lemma
                              is not "be" — so the detector
                              starts at `been`; the "considered"
                              is the following VBN)

    Longer distances indicate unrelated clauses and would
    produce false positives. See the module docstring for the
    full rationale.

    Args:
        tagged: A list of `(word, tag)` tuples from
                `nltk.pos_tag`.

    Returns:
        True if the sentence contains a passive construction,
        False otherwise.
    """
    for i, (word, tag) in enumerate(tagged):
        # The leading token must be a form of "be".
        if tag not in _BE_VERB_TAGS:
            continue
        if word.lower() not in _PASSIVE_BE_FORMS:
            continue

        # Look ahead within the window for a past participle.
        window_end = min(i + 1 + _PASSIVE_WINDOW, len(tagged))
        for j in range(i + 1, window_end):
            _, following_tag = tagged[j]
            if following_tag == _PAST_PARTICIPLE_TAG:
                return True

    return False


# =============================================================================
#  Private: transition words
# =============================================================================

def _transition_words_fraction(sentences: list) -> float:
    """
    Compute the fraction of sentences that contain at least one
    transition word or transition phrase.

    A sentence counts as "containing a transition" if the
    tokenizer's word tokens include at least one member of
    `_SINGLE_WORD_TRANSITIONS`, OR if the sentence's lowercased
    surface text contains at least one member of
    `_MULTI_WORD_TRANSITIONS`. The two checks are separate
    because multi-word transitions such as "for example" would
    never appear in a word-token list, and single-word
    transitions such as "however" would never match the multi-
    word phrase list.

    The function returns a fraction in [0, 1]. A sentence that
    contains more than one transition still contributes 1 to the
    numerator — the metric measures the fraction of sentences
    that use a connective at all, not the total count of
    connectives across the article. That choice matches the
    shared type's documented semantics: "fraction of sentences
    containing a transition word."

    Args:
        sentences: The list of sentence strings.

    Returns:
        The fraction of sentences containing a transition. Zero
        for an empty list.
    """
    if not sentences:
        return 0.0

    with_transition = 0
    for sentence in sentences:
        if not sentence or not sentence.strip():
            continue

        # ---- Single-word check ----
        # Compare lowercased word tokens against the set. The
        # `.lower()` call handles the case where the tokenizer
        # preserves the capital of a sentence-initial word — a
        # sentence starting with "However," produces the token
        # "However" which would not match the lowercase entry.
        words = _tokenize_words(sentence)
        lowered_words = {w.lower() for w in words if w.isalpha()}
        has_single = bool(
            lowered_words & _SINGLE_WORD_TRANSITIONS
        )

        # ---- Multi-word check ----
        # The multi-word phrases span token boundaries and can
        # cross punctuation, so they are matched against the
        # sentence's surface text rather than against the word
        # list. The lowercased and whitespace-normalized text
        # is what the substring check runs against.
        has_multi = False
        if not has_single:
            normalized = re.sub(r"\s+", " ", sentence.lower())
            for phrase in _MULTI_WORD_TRANSITIONS:
                if phrase in normalized:
                    has_multi = True
                    break

        if has_single or has_multi:
            with_transition += 1

    return with_transition / len(sentences)


# =============================================================================
#  Private: status classification
# =============================================================================

def _classify_status(
    word_count: int,
    target_word_count: int,
    h2_count: int,
    min_h2_sections: int,
    avg_paragraph_words: float,
    passive_fraction: float,
    max_passive_voice: float,
    transition_fraction: float,
    min_transition_words: float,
) -> str:
    """
    Classify the SEO section as `'good'`, `'warning'`, or
    `'fail'` from the six metrics and the caller-supplied
    thresholds.

    The rule: the section's status is the WORST of six per-
    metric statuses. Any single metric that fails outright makes
    the whole section fail; a metric that is close to failing
    but not there makes the whole section warn; only a section
    where every metric is good is classified good. That
    "weakest link" rule matches how the validation report as a
    whole is aggregated from its six sections — see the
    `reportService.ts` header for the same rule at the outer
    level.

    The per-metric thresholds:

      Word count:      ±20% of target → good
                       ±50% of target → warning
                       otherwise       → fail

      H2 count:        >= target + 1 → good
                       == target     → good
                       >= 1          → warning
                       0             → fail

      Avg paragraph:   20–100 words → good
                       10–200 words → warning
                       otherwise    → fail

      Passive voice:   <= max → good
                       <= 2 * max → warning
                       > 2 * max → fail

      Transitions:     >= min → good
                       >= min / 2 → warning
                       < min / 2 → fail

    The word-count bands are relative to the target rather than
    absolute, so a topic configured for 2000 words is judged by
    the same tolerance as one configured for 800. The H2 band is
    asymmetric — an article with twice the minimum number of H2
    sections is a well-structured piece, not a failure — while
    the passive-voice band is symmetric around the maximum
    because a passive voice fraction is not meaningfully "too
    low". The paragraph band is a range because both an article
    of two-sentence paragraphs and an article of thousand-word
    paragraphs read worse than one of moderate paragraphs.

    Args:
        word_count:             The article's word count.
        target_word_count:      The target word count.
        h2_count:               The H2 heading count.
        min_h2_sections:        The minimum H2 count for good.
        avg_paragraph_words:    The average words per paragraph.
        passive_fraction:       The fraction of passive sentences.
        max_passive_voice:      The fraction threshold for good.
        transition_fraction:    The fraction of transition
                                sentences.
        min_transition_words:   The fraction threshold for good.

    Returns:
        `'good'`, `'warning'`, or `'fail'`.
    """
    # Collect the per-metric statuses; the worst one wins.
    statuses = []

    # ---- Word count ----
    statuses.append(
        _classify_word_count(word_count, target_word_count)
    )

    # ---- H2 count ----
    statuses.append(
        _classify_h2_count(h2_count, min_h2_sections)
    )

    # ---- Average paragraph length ----
    statuses.append(
        _classify_avg_paragraph(avg_paragraph_words)
    )

    # ---- Passive voice ----
    statuses.append(
        _classify_passive_voice(
            passive_fraction, max_passive_voice
        )
    )

    # ---- Transition words ----
    statuses.append(
        _classify_transition_words(
            transition_fraction, min_transition_words
        )
    )

    return _worst(statuses)


def _classify_word_count(
    word_count: int, target: int
) -> str:
    """
    Classify the word-count metric. See `_classify_status` for
    the thresholds. A non-positive target is treated as "the
    caller did not specify a target" and the metric is reported
    as good for any positive word count — a caller that does not
    care about length should not have the length drag down the
    section's status.
    """
    if target <= 0:
        return "good" if word_count > 0 else "fail"
    if word_count <= 0:
        return "fail"
    ratio = word_count / target
    if 0.80 <= ratio <= 1.20:
        return "good"
    if 0.50 <= ratio <= 1.50:
        return "warning"
    return "fail"


def _classify_h2_count(count: int, minimum: int) -> str:
    """
    Classify the H2-count metric. See `_classify_status` for the
    thresholds. A count of zero is always a fail — a long-form
    article with no H2 structure reads as one unbroken block.
    """
    if count == 0:
        return "fail"
    if count >= minimum:
        return "good"
    return "warning"


def _classify_avg_paragraph(words: float) -> str:
    """
    Classify the average-paragraph-length metric. See
    `_classify_status` for the thresholds. A zero average (no
    paragraphs at all) is a fail — there is nothing for the
    metric to score.
    """
    if words <= 0:
        return "fail"
    if 20.0 <= words <= 100.0:
        return "good"
    if 10.0 <= words <= 200.0:
        return "warning"
    return "fail"


def _classify_passive_voice(
    fraction: float, maximum: float
) -> str:
    """
    Classify the passive-voice metric. See `_classify_status` for
    the thresholds. A non-positive maximum is treated as "the
    caller does not care about passive voice" and any fraction is
    good.
    """
    if maximum <= 0:
        return "good"
    if fraction <= maximum:
        return "good"
    if fraction <= 2 * maximum:
        return "warning"
    return "fail"


def _classify_transition_words(
    fraction: float, minimum: float
) -> str:
    """
    Classify the transition-word metric. See `_classify_status`
    for the thresholds. A non-positive minimum is treated as "the
    caller does not care about transition words" and any fraction
    is good.
    """
    if minimum <= 0:
        return "good"
    if fraction >= minimum:
        return "good"
    if fraction >= minimum / 2.0:
        return "warning"
    return "fail"


def _worst(statuses: list) -> str:
    """
    Return the worst status from a list of `'good'`,
    `'warning'`, and `'fail'` strings. The ordering is
    `'fail'` worse than `'warning'` worse than `'good'`.

    A list containing only `'good'` returns `'good'`; a list
    containing any `'fail'` returns `'fail'` regardless of the
    other entries. An empty list — which cannot arise in this
    module, but which a future caller might produce — returns
    `'good'`, on the assumption that the absence of a complaint
    is the absence of a problem.
    """
    if "fail" in statuses:
        return "fail"
    if "warning" in statuses:
        return "warning"
    return "good"


def _empty_result() -> dict:
    """
    Return the SEO section for an empty article.

    The structural counts are zero and every prose metric is
    zero; the status is `'fail'` because an article with no
    structure and no prose fails every structural test. The
    function is the single source of truth for that shape — the
    empty-input branch in `validate_seo` returns this value
    directly, so the two paths cannot drift.
    """
    return {
        "wordCount": 0,
        "h2Count": 0,
        "h3Count": 0,
        "avgParagraphWords": 0.0,
        "passiveVoicePercent": 0.0,
        "transitionWordsPercent": 0.0,
        "status": "fail",
    }


# =============================================================================
#  Default export
# =============================================================================

__all__ = [
    "validate_seo",
]