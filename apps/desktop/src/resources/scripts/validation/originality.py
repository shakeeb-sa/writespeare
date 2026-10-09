#!/usr/bin/env python3
"""
validation/originality.py — originality checking for WriteSpeare.

The fourth of the six article validators. Measures how much the
generated article overlaps with the source documents the writer
step was given, and produces the `originality` section of the
validation report: two independent similarity signals plus the
list of article sentences that exceeded either signal's
threshold.

The two signals — and why both:

    A single similarity score cannot detect both of the two ways
    an article can fail to be original:

      * Copying — the article reuses the source's exact wording.
        A sentence like "Container gardening lets renters move
        their plants when they move themselves" that appears in
        both the article and the source is a verbatim copy, and
        it will be detected by any bag-of-words similarity
        measure.

      * Paraphrasing — the article rewords the source without
        reusing its words. "Container gardening is a way for
        renters to take their plants with them when they
        relocate" conveys the same idea with a different
        vocabulary. A bag-of-words measure sees almost no
        overlap between the two sentences and reports them as
        unrelated.

    TF-IDF cosine similarity catches the first case. It
    vectorizes each text into a sparse vector whose entries are
    word weights (term frequency × inverse document frequency),
    and the cosine of the angle between two such vectors is high
    when the texts share many rare words. That is exactly the
    signature of a verbatim copy — the two sentences share
    "container", "gardening", "renters", "plants" — and it is
    almost invisible for a paraphrase, where the shared rare
    words are a fraction of the total.

    Sentence-transformer embedding cosine similarity catches the
    second case. The embedding model (all-MiniLM-L6-v2, a small
    distilled BERT) maps a sentence to a dense vector in a
    semantic space where "container gardening lets renters move
    their plants" and "container gardening is a way for renters
    to take their plants" are close together even though they
    share few words. The cosine similarity between the two
    vectors is high; the TF-IDF similarity between them is low.

    A pipeline that reported only one of the two would miss one
    of the two failure modes. Both signals are therefore computed
    for every article sentence and reported side by side. The
    report's `maxTfidfSimilarity` and `maxSemanticSimilarity`
    fields each carry the worst case across all sentences for
    their respective signal, and the `flaggedSentences` array
    records every sentence that exceeded either threshold.

What the two signals report — per sentence, not per document:

    Every article sentence is compared against every source
    chunk, and the maximum similarity for that sentence is what
    the report records. Two consequences follow from that design:

      * The `maxTfidfSimilarity` field on the report is the
        maximum over all article sentences of the maximum
        similarity that sentence achieved against any source
        chunk. It is therefore a statement about the WORST
        sentence in the article, which is the number a user
        actually cares about — a single copied sentence in an
        otherwise original article is a more serious problem
        than a uniformly mediocre one, and reporting the
        maximum surfaces it.

      * Each flagged sentence carries its own `similarity` value
        and its own `sourceTitle` — the title of the source
        document it matched most closely. The user can see
        exactly which sentence needs attention and which source
        it resembles, not just that "some sentence somewhere
        was too close to something."

Source chunking — why sentences, not whole documents:

    The source documents are chunked into their own sentences
    before the comparison runs. Chunking is what makes the
    similarity signals precise: comparing an article sentence to
    a whole 2000-word source document would produce a similarity
    score dominated by the source's overall vocabulary rather
    than by the specific passage the article sentence mirrors.
    Comparing sentence to sentence gives a number that reflects
    the actual overlap between the two pieces of prose.

    The chunking has a cost — a source document with 500
    sentences produces 500 chunks to compare against every
    article sentence — but the cost is bounded and the
    comparison is a matrix operation whose complexity is linear
    in the total number of chunks. For the sizes the pipeline
    deals with (article lengths in the thousands of words,
    source documents in the tens of thousands of characters)
    the operation completes in seconds on commodity hardware.

Source documents missing a title:

    A source document with no title — a page whose frontmatter
    omitted the field, a doc written before the title field was
    added to the pipeline — produces a flagged-sentence entry
    whose `sourceTitle` is a fallback string ("Source N", where
    N is the document's 1-based position in the list). The
    fallback keeps the report well-formed; the schema's
    `minlength: 1` on the `sourceTitle` field means an empty
    string would be rejected at save time, and a fallback that
    names the document by position is at least enough for the
    user to identify which source a flagged sentence came from.

Graceful degradation of the semantic check:

    The sentence-transformer model is loaded lazily on the first
    call to `_load_embedding_model`, then cached at module level
    for the rest of the process. Loading costs a disk read plus
    a one-time ~80 MB model download on a fresh machine, which is
    why the model is not loaded at import time — a process that
    never runs the originality check (a search-only pipeline, a
    unit test that exercises the keyword validator) pays nothing
    for the model.

    If the model cannot be loaded — a machine with no network
    for the initial download, a runtime where `sentence-
    transformers` was not installed, an out-of-memory condition
    on a constrained host — the load failure is logged at
    warning level and the semantic check is skipped. Every
    article sentence is then reported with a semantic similarity
    of 0.0, the `maxSemanticSimilarity` field is 0.0, and the
    flagging is based on the TF-IDF signal alone. That degraded
    report is strictly less useful than the full one, but it is
    still a valid report that the pipeline can persist and the
    UI can display; a hard failure would lose the whole
    validation run for what is a best-effort signal.

Threshold defaults:

    The two defaults — 0.30 for TF-IDF and 0.35 for semantic —
    match the plan's user-journey example:

        ORIGINALITY                          ✅
          Closest source (TF-IDF):     0.22   (limit 0.30)
          Closest source (semantic):   0.31   (limit 0.35)
          Flagged sentences:           0

    The example's two observed maxima (0.22 and 0.31) sit below
    the two limits, and the report classifies the section as
    good. A sentence whose TF-IDF similarity rose above 0.30 or
    whose semantic similarity rose above 0.35 would be flagged.
    Both thresholds are exposed as arguments so the dispatcher
    can override them from the user's preset (the Preset schema
    in the backend declares `maxTfidfSimilarity` and
    `maxSemanticSimilarity` fields for exactly this purpose).

The report shape this function returns matches the shared
`OriginalityReport` and `FlaggedSentence` interfaces declared in
the desktop's `features/shared/types/index.ts` and the backend's
`features/shared/types/index.ts`:

    {
        "maxTfidfSimilarity":    float,   # 0–1
        "maxSemanticSimilarity": float,   # 0–1
        "flaggedSentences": [
            {
                "text":        str,       # 1–5000 chars
                "similarity":  float,     # 0–1
                "sourceTitle": str,       # 1–500 chars
            },
            ...
        ],
        "status": 'good' | 'warning' | 'fail',
    }

    The `Report` Mongoose schema in
    `apps/server/src/features/reports/models/Report.ts` enforces
    `min: 0, max: 1` on both similarity fields and on each
    flagged sentence's similarity, `minlength: 1, maxlength:
    5000` on each flagged sentence's text, and `minlength: 1,
    maxlength: 500` on each flagged sentence's sourceTitle. Every
    value this module emits satisfies those bounds by
    construction — similarities are clamped to `[0, 1]`, sentence
    text is truncated to 5000 characters, and source titles are
    truncated to 500 and defaulted to a non-empty string when the
    source document has no title.

Dependencies: Python stdlib + the `numpy`, `scikit-learn`,
`sentence-transformers`, and `nltk` packages (all declared in
requirements.txt) + the sibling `core/` package.
"""

import re
import sys
from pathlib import Path

# =============================================================================
#  sys.path bootstrap — MUST run BEFORE any `from core.* import ...`
# =============================================================================
#  Identical to the bootstrap in every other feature script. The
#  script lives at scripts/validation/originality.py, so its own
#  directory is validation/, and the parent's parent is the
#  directory that contains `core/`. That directory must be on
#  sys.path for the sibling imports below to resolve in the
#  packaged app's embedded Python distribution.

_SCRIPT_DIR = Path(__file__).resolve().parent
_SCRIPTS_ROOT = _SCRIPT_DIR.parent
if str(_SCRIPTS_ROOT) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_ROOT))

import numpy as np
import nltk
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_similarity

from core.extractor import strip_frontmatter
from core.utils import log_debug, log_warning


# =============================================================================
#  Constants — embedding model
# =============================================================================
#
# `all-MiniLM-L6-v2` is the standard small sentence-transformer.
# It is a distilled BERT model that produces 384-dimensional
# sentence embeddings; its semantic quality on English prose is
# good enough for a paraphrase-detection task, and its size (about
# 80 MB compressed) and inference speed (thousands of sentences
# per second on a CPU) make it the right trade-off for a
# desktop-side validation step.
#
# The name is declared as a module-level constant so a future
# session that wants to swap in a higher-quality model — at the
# cost of a larger download and slower inference — has one place
# to change. The rest of the module accesses the model only
# through `_load_embedding_model`, so no other code path names
# the model string.

_EMBEDDING_MODEL_NAME = "all-MiniLM-L6-v2"


# =============================================================================
#  Constants — status classification
# =============================================================================
#
# The status rule uses a single margin fraction rather than a
# per-signal margin. A similarity at or below its limit is good;
# a similarity up to `(1 + margin) * limit` is a warning; above
# that, the section fails. The margin of 0.25 corresponds to "25%
# over the limit" — a TF-IDF similarity of 0.375 against a 0.30
# limit is a warning, a similarity of 0.40 is a fail.
#
# A second condition — the number of flagged sentences — participates
# in the classification. A section whose maxima are both within
# limits produces zero flagged sentences; the flag count therefore
# only matters as a tie-breaker for sections that are already over
# at least one limit. A handful of just-over sentences is a
# warning; more than a handful is a fail. The threshold of 3
# matches the plan's implicit "a few sentences" framing without
# pretending to a precision the user-visible report does not have.

_GRADE_WARNING_MARGIN_FRACTION = 0.25
_MAX_FLAGGED_FOR_WARNING = 3


# =============================================================================
#  Constants — string bounds from the Report schema
# =============================================================================
#
# The Mongoose schema in `apps/server/src/features/reports/models/
# Report.ts` enforces these length bounds on every flagged sentence.
# Values that exceeded them would be rejected at save time with a
# ValidationError, which would surface as a failed POST from the
# desktop. The truncation in `_build_flagged_sentence` clamps to
# these same limits so the report always saves.

_MAX_FLAGGED_TEXT_LENGTH = 5000
_MAX_SOURCE_TITLE_LENGTH = 500


# =============================================================================
#  Constants — Markdown stripping for sentence extraction
# =============================================================================
#
# Same pattern set as `readability.py` and `seo_check.py`. The
# sentence extraction that follows needs the article's plain
# prose, not its markup — a heading line in the raw text would
# become a "sentence" consisting of `## Real heading`, which is
# not what the user wrote as prose and which would be compared
# against the sources as if it were.
#
# The three validators' strippers overlap but are not identical;
# see `seo_check.py`'s module docstring for the reasoning behind
# the local declarations rather than a shared import.

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
#  Constants — sentence-boundary regex fallback
# =============================================================================
#
# Used by `_split_into_sentences` when NLTK's punkt model is
# unavailable. Same pattern and same rationale as the fallback in
# `seo_check.py`: split on sentence-ending punctuation followed
# by whitespace, which avoids splitting on a decimal or an
# abbreviation that is followed by a comma rather than a period.

_SENTENCE_SPLIT_PATTERN = re.compile(r"(?<=[.!?])\s+")


# =============================================================================
#  Module-level model cache
# =============================================================================
#
# The sentence-transformer model is loaded lazily and cached here.
# The three possible states are:
#
#   None  — the model has not been loaded yet in this process. The
#           next call to `_load_embedding_model` will attempt to
#           load it.
#   A SentenceTransformer instance — the model is loaded and ready.
#   False — a previous load attempt failed. Subsequent calls return
#           None without retrying, so a failed first attempt does
#           not cost every subsequent call another timeout.
#
# Using `False` rather than a second sentinel variable keeps the
# "not yet attempted" and "attempted and failed" cases
# distinguishable with a single module-level binding. A future
# session that wants to allow a retry after a transient failure
# would reset this binding to None; nothing in the current code
# does so.

_embedding_model = None


# =============================================================================
#  Public entry point
# =============================================================================

def validate_originality(
    article_text: str,
    source_docs: list,
    max_tfidf: float = 0.30,
    max_semantic: float = 0.35,
) -> dict:
    """
    Compute the originality section of the validation report for
    an article. See the module docstring for the reasoning behind
    every metric and every threshold.

    The function is a pure transformation (modulo the one-time
    semantic-model load, which is cached at module level). It
    reads no files, writes no files, and emits no markers — the
    dispatcher owns all of those concerns.

    Args:
        article_text:  The article's full Markdown text, including
                       any frontmatter, title, and headings.
        source_docs:   The source documents the article is checked
                       against. Accepts a list of dicts, each of
                       which must have a `content` field (the
                       doc's text) and may have a `title` field
                       (the doc's display title). A dict missing
                       `content` is skipped. A title that is
                       absent or empty falls back to "Source N"
                       where N is the dict's 1-based position in
                       the list.
        max_tfidf:     The TF-IDF cosine similarity threshold
                       above which an article sentence is
                       flagged. Non-positive disables the TF-IDF
                       check.
        max_semantic:  The semantic cosine similarity threshold
                       above which an article sentence is
                       flagged. Non-positive disables the
                       semantic check.

    Returns:
        The originality section dict. Never None, never partial —
        an empty or unreadable input produces a well-formed
        zero-valued dict with a `'good'` status (nothing to
        flag).
    """
    # ---- 1. Guard against an empty article ----
    if not article_text or not article_text.strip():
        log_debug(
            "originality: empty article — returning zero metrics"
        )
        return _empty_result()

    # ---- 2. Guard against missing source documents ----
    # With no sources to compare against, every article is
    # trivially original. The report is zero-valued and the
    # status is `'good'` — there is nothing for the user to act
    # on.
    if not source_docs or not isinstance(source_docs, list):
        log_debug(
            "originality: no source documents supplied — "
            "returning zero metrics"
        )
        return _empty_result()

    # ---- 3. Extract the article's prose and sentences ----
    # Strip frontmatter first (the dispatcher reads the article
    # from disk, and a doc-file-shaped article may carry
    # frontmatter), then strip the Markdown markup, then split
    # into sentences.
    article_body = strip_frontmatter(article_text)
    article_prose = _strip_markdown(article_body)
    article_sentences = _split_into_sentences(article_prose)

    if not article_sentences:
        log_debug(
            "originality: article stripped to no sentences — "
            "returning zero metrics"
        )
        return _empty_result()

    # ---- 4. Build the source chunks ----
    # Each source doc is split into its own sentences. See the
    # module docstring's "Source chunking" section for the
    # rationale.
    source_chunks = _build_source_chunks(source_docs)
    if not source_chunks:
        log_debug(
            "originality: no source chunks after extraction — "
            "returning zero metrics"
        )
        return _empty_result()

    chunk_texts = [c["text"] for c in source_chunks]
    chunk_titles = [c["title"] for c in source_chunks]

    # ---- 5. TF-IDF similarity ----
    # A matrix of shape (n_sentences, n_chunks). The
    # `_tfidf_similarity` helper returns per-sentence maxima and
    # the index of the chunk that produced each maximum, so the
    # flagged-sentence builder can name the source.
    if max_tfidf > 0:
        tfidf_maxima, tfidf_source_indices = _tfidf_similarity(
            article_sentences, chunk_texts
        )
    else:
        tfidf_maxima = [0.0] * len(article_sentences)
        tfidf_source_indices = [0] * len(article_sentences)

    # ---- 6. Semantic similarity ----
    # The semantic check is guarded by `max_semantic > 0` and by
    # the model's successful load. If either condition fails, the
    # per-sentence maxima are all zero — a valid, if
    # uninformative, answer.
    if max_semantic > 0:
        semantic_maxima, semantic_source_indices = _semantic_similarity(
            article_sentences, chunk_texts
        )
    else:
        semantic_maxima = [0.0] * len(article_sentences)
        semantic_source_indices = [0] * len(article_sentences)

    # ---- 7. Compute the overall maxima ----
    max_tfidf_value = max(tfidf_maxima) if tfidf_maxima else 0.0
    max_semantic_value = max(semantic_maxima) if semantic_maxima else 0.0

    # ---- 8. Build the flagged-sentences list ----
    # A sentence is flagged when either of its maxima exceeds its
    # respective threshold. The flagged entry reports whichever
    # of the two maxima is higher, so the user sees the strongest
    # signal of "this sentence is too close to something".
    flagged = []
    for i, sentence in enumerate(article_sentences):
        tfidf_score = tfidf_maxima[i] if i < len(tfidf_maxima) else 0.0
        semantic_score = (
            semantic_maxima[i] if i < len(semantic_maxima) else 0.0
        )

        tfidf_exceeds = max_tfidf > 0 and tfidf_score > max_tfidf
        semantic_exceeds = (
            max_semantic > 0 and semantic_score > max_semantic
        )

        if not (tfidf_exceeds or semantic_exceeds):
            continue

        # Pick the higher of the two scores (and its source). If
        # the scores tie, prefer the TF-IDF source — an arbitrary
        # but deterministic choice.
        if tfidf_score >= semantic_score:
            similarity = tfidf_score
            source_title = chunk_titles[tfidf_source_indices[i]]
        else:
            similarity = semantic_score
            source_title = chunk_titles[semantic_source_indices[i]]

        flagged.append(
            _build_flagged_sentence(
                sentence=sentence,
                similarity=similarity,
                source_title=source_title,
            )
        )

    # ---- 9. Classify the section's status ----
    status = _classify_status(
        max_tfidf_value=max_tfidf_value,
        max_semantic_value=max_semantic_value,
        flagged_count=len(flagged),
        max_tfidf_limit=max_tfidf,
        max_semantic_limit=max_semantic,
    )

    # ---- 10. Build and return ----
    return {
        "maxTfidfSimilarity": _clamp_and_round(max_tfidf_value),
        "maxSemanticSimilarity": _clamp_and_round(max_semantic_value),
        "flaggedSentences": flagged,
        "status": status,
    }


# =============================================================================
#  Private: Markdown stripping
# =============================================================================

def _strip_markdown(text: str) -> str:
    """
    Strip Markdown markup from the article and return the plain
    prose.

    Same substitution order as the two preceding validators'
    strippers — see `seo_check.py`'s `_strip_markdown_for_prose`
    for the reasoning behind the order. The three strippers
    overlap but are not identical; see this module's
    `Constants — Markdown stripping` block for the local-declaration
    rationale.

    Never raises.

    Args:
        text: The Markdown source.

    Returns:
        The prose with markup removed, stripped of leading and
        trailing whitespace.
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
#  Private: sentence splitting
# =============================================================================

def _split_into_sentences(text: str) -> list:
    """
    Split a plain-prose text into sentences.

    Primary path uses `nltk.sent_tokenize`; fallback is a regex
    split on sentence-ending punctuation followed by whitespace.
    Same strategy and same rationale as `seo_check.py`'s
    `_tokenize_sentences`.

    Empty sentences and sentences shorter than a minimum length
    are filtered out. A sentence of fewer than three characters
    is not a real sentence in any language the pipeline handles,
    and a sentence of a single word is generally a heading
    fragment or a stray list-item remnant that survived the
    Markdown strip. Filtering them out keeps the comparison
    focused on substantive sentences.

    Never raises. A missing punkt model is logged at warning
    level and the fallback runs; any other tokenizer exception is
    treated the same way.

    Args:
        text: The plain-prose text.

    Returns:
        A list of sentence strings, in document order.
    """
    if not text or not text.strip():
        return []

    try:
        raw_sentences = list(nltk.sent_tokenize(text))
    except LookupError:
        log_warning(
            "originality: NLTK punkt model is not installed; "
            "using regex sentence splitting"
        )
        raw_sentences = _regex_sentence_split(text)
    except Exception as exc:
        log_warning(
            f"originality: sentence tokenization failed "
            f"({exc}); using regex sentence splitting"
        )
        raw_sentences = _regex_sentence_split(text)

    # Filter to substantive sentences.
    return [
        s.strip() for s in raw_sentences
        if len(s.strip()) >= 3
    ]


def _regex_sentence_split(text: str) -> list:
    """
    Split a text into sentences by a regex on sentence-ending
    punctuation. The fallback used by `_split_into_sentences` when
    NLTK's tokenizer is unavailable.

    Args:
        text: The plain-prose text.

    Returns:
        A list of sentence strings.
    """
    parts = _SENTENCE_SPLIT_PATTERN.split(text)
    return [p.strip() for p in parts if p.strip()]


# =============================================================================
#  Private: source chunk construction
# =============================================================================

def _build_source_chunks(source_docs: list) -> list:
    """
    Convert the caller's source-document list into a flat list of
    sentence chunks, each tagged with the title of the document
    it came from.

    The input is a list of dicts, each with a `content` field and
    an optional `title` field. A dict without a usable `content`
    is skipped. A dict without a title gets a fallback title of
    the form `"Source N"`, where N is the dict's 1-based position
    in the input list.

    Each document's content is stripped of frontmatter, stripped
    of Markdown, split into sentences, and appended to the result
    with the document's title attached to each chunk. The
    resulting list is what the TF-IDF and semantic helpers
    compare against.

    The function never raises. A malformed entry — a dict with a
    non-string `content`, a missing `content`, a `content` that
    strips to nothing — is silently skipped, because the caller
    controls the input shape and a single bad entry should not
    abort the whole check.

    Args:
        source_docs: The caller's source-document list.

    Returns:
        A list of `{"text": str, "title": str}` dicts, one per
        sentence across all documents. Empty when no document
        contributes any sentence.
    """
    chunks = []

    for idx, doc in enumerate(source_docs):
        if not isinstance(doc, dict):
            continue

        content = doc.get("content")
        if not isinstance(content, str) or not content.strip():
            continue

        # Resolve the title, applying the fallback when needed.
        raw_title = doc.get("title")
        if not isinstance(raw_title, str) or not raw_title.strip():
            title = f"Source {idx + 1}"
        else:
            title = raw_title.strip()
            # Truncate to the schema's bound.
            if len(title) > _MAX_SOURCE_TITLE_LENGTH:
                title = title[:_MAX_SOURCE_TITLE_LENGTH].rstrip()

        # Strip frontmatter then Markdown, then split.
        body = strip_frontmatter(content)
        prose = _strip_markdown(body)
        sentences = _split_into_sentences(prose)

        for sentence in sentences:
            chunks.append({"text": sentence, "title": title})

    return chunks


# =============================================================================
#  Private: TF-IDF similarity
# =============================================================================

def _tfidf_similarity(
    article_sentences: list,
    source_texts: list,
) -> tuple:
    """
    Compute, for each article sentence, the maximum TF-IDF cosine
    similarity against any source chunk, and the index of the
    chunk that produced that maximum.

    The vectorizer is fit on the union of article sentences and
    source chunks, so the IDF weights reflect the corpus the
    comparison is being made within. That is the standard
    approach for this kind of task and is what produces
    meaningful cosine similarities — fitting the vectorizer on
    only one of the two sets would produce similarities whose
    scale depended on which set was chosen.

    The similarity matrix has shape `(n_article_sentences,
    n_source_chunks)`. For each row, the argmax column gives the
    chunk the article sentence matched best, and the value at
    that column gives the similarity.

    A degenerate input — an article sentence that tokenizes to
    nothing, a source chunk that tokenizes to nothing — produces
    a zero vector for that entry, and the cosine similarity
    between it and anything is zero. The function does not
    filter those out; the zero similarity is the correct answer
    and the caller's maxima list will include it.

    Never raises for a well-formed input. An exception from
    sklearn — an empty vocabulary, a vectorizer that cannot
    handle a specific character sequence — is caught and logged,
    and the function returns zero maxima for every sentence.

    Args:
        article_sentences: The article's sentences.
        source_texts:      The source chunks' texts.

    Returns:
        A `(maxima, argmax_indices)` tuple, both lists of the
        same length as `article_sentences`. On failure, both
        lists are the correct length and filled with zeros.
    """
    n_sentences = len(article_sentences)
    n_chunks = len(source_texts)

    if n_sentences == 0 or n_chunks == 0:
        return [0.0] * n_sentences, [0] * n_sentences

    try:
        # Fit on the union of both sets. The `token_pattern`
        # default (two-or-more word characters) is retained;
        # single-character tokens are almost always noise in
        # English prose.
        vectorizer = TfidfVectorizer(
            lowercase=True,
            stop_words="english",
            ngram_range=(1, 2),
            sublinear_tf=True,
        )

        all_texts = list(article_sentences) + list(source_texts)
        matrix = vectorizer.fit_transform(all_texts)

        article_matrix = matrix[:n_sentences]
        source_matrix = matrix[n_sentences:]

        # `cosine_similarity` returns a dense array of shape
        # (n_sentences, n_chunks). For the sizes the pipeline
        # deals with this is a small dense array — even a
        # thousand-by-thousand matrix is under a megabyte.
        similarities = cosine_similarity(
            article_matrix, source_matrix
        )
    except Exception as exc:
        log_warning(
            f"originality: TF-IDF similarity failed ({exc}); "
            f"reporting zero similarity for every sentence"
        )
        return [0.0] * n_sentences, [0] * n_sentences

    maxima = []
    argmax_indices = []
    for i in range(n_sentences):
        row = similarities[i]
        # `argmax` returns the first occurrence of the maximum,
        # which gives a deterministic source when two chunks tie.
        best_idx = int(np.argmax(row))
        best_score = float(row[best_idx])
        # Clamp. TF-IDF cosine similarity is mathematically in
        # [0, 1] for non-negative vectors, but floating-point
        # roundoff can push a value infinitesimally above 1.0.
        best_score = max(0.0, min(1.0, best_score))
        maxima.append(best_score)
        argmax_indices.append(best_idx)

    return maxima, argmax_indices


# =============================================================================
#  Private: semantic similarity
# =============================================================================

def _load_embedding_model():
    """
    Load the sentence-transformer model, caching it at module
    level. Returns the model instance, or `None` if the model
    cannot be loaded.

    The first call in a process attempts the load. If the load
    succeeds, the model is stored in `_embedding_model` and
    subsequent calls return it directly. If the load fails —
    `sentence-transformers` is not installed, the model files
    are not on disk and cannot be downloaded, the machine is out
    of memory — the failure is logged at warning level and
    `_embedding_model` is set to `False`, which tells subsequent
    calls not to retry. See the module docstring's "Graceful
    degradation" section for the rationale.

    The function is safe to call from multiple threads in the
    sense that it will not crash, but the load itself is not
    synchronized — two concurrent first-calls could both attempt
    the load. In practice the validator runs single-threaded
    (the pipeline's stdin-reader thread never touches this
    module), so the race is theoretical.

    Never raises.

    Returns:
        The loaded `SentenceTransformer`, or `None`.
    """
    global _embedding_model

    if _embedding_model is False:
        # A previous load failed. Do not retry.
        return None
    if _embedding_model is not None:
        # Already loaded.
        return _embedding_model

    try:
        # Import lazily so the heavy import graph of
        # sentence-transformers (which includes transformers,
        # torch, and a long list of their dependencies) is not
        # paid by a process that never reaches this function.
        from sentence_transformers import SentenceTransformer

        log_debug(
            f"originality: loading embedding model "
            f"'{_EMBEDDING_MODEL_NAME}' (first use in this process)"
        )
        model = SentenceTransformer(_EMBEDDING_MODEL_NAME)
        _embedding_model = model
        return model
    except Exception as exc:
        log_warning(
            f"originality: could not load embedding model "
            f"'{_EMBEDDING_MODEL_NAME}' ({exc}); the semantic "
            f"similarity check will be skipped for this run"
        )
        _embedding_model = False
        return None


def _semantic_similarity(
    article_sentences: list,
    source_texts: list,
) -> tuple:
    """
    Compute, for each article sentence, the maximum semantic
    cosine similarity against any source chunk, and the index of
    the chunk that produced that maximum.

    Uses the cached sentence-transformer model. If the model
    cannot be loaded, returns zero maxima — see the module
    docstring's "Graceful degradation" section.

    The article sentences and the source texts are encoded in a
    single batch so the model's own internal batching can decide
    how to parallelize the work. The resulting embeddings are
    normalized to unit length by the model's default behavior
    (which enables the dot product to equal the cosine
    similarity) — the `cosine_similarity` call below works on
    either normalized or unnormalized embeddings, so the choice
    does not affect the result.

    The similarity matrix has shape `(n_article_sentences,
    n_source_chunks)`. The per-sentence maximum and its argmax
    index are extracted the same way as in `_tfidf_similarity`.

    Never raises for a well-formed input. An exception during
    encoding — a memory error on an exceptionally long input, an
    internal model failure — is caught and logged, and the
    function returns zero maxima.

    Args:
        article_sentences: The article's sentences.
        source_texts:      The source chunks' texts.

    Returns:
        A `(maxima, argmax_indices)` tuple, both lists of the
        same length as `article_sentences`. On failure or when
        the model is unavailable, both lists are the correct
        length and filled with zeros.
    """
    n_sentences = len(article_sentences)
    n_chunks = len(source_texts)

    if n_sentences == 0 or n_chunks == 0:
        return [0.0] * n_sentences, [0] * n_sentences

    model = _load_embedding_model()
    if model is None:
        # Load failed; the caller sees zero maxima. The warning
        # has already been logged by `_load_embedding_model`.
        return [0.0] * n_sentences, [0] * n_sentences

    try:
        # Encode everything in one call. The `convert_to_numpy`
        # option gives a plain NumPy array, which is what
        # `cosine_similarity` accepts.
        all_texts = list(article_sentences) + list(source_texts)
        embeddings = model.encode(
            all_texts,
            convert_to_numpy=True,
            show_progress_bar=False,
        )

        article_embeddings = embeddings[:n_sentences]
        source_embeddings = embeddings[n_sentences:]

        similarities = cosine_similarity(
            article_embeddings, source_embeddings
        )
    except Exception as exc:
        log_warning(
            f"originality: semantic similarity failed ({exc}); "
            f"reporting zero similarity for every sentence"
        )
        return [0.0] * n_sentences, [0] * n_sentences

    maxima = []
    argmax_indices = []
    for i in range(n_sentences):
        row = similarities[i]
        best_idx = int(np.argmax(row))
        best_score = float(row[best_idx])
        # Clamp to [0, 1]. Embedding cosine similarity can be
        # negative for opposite-meaning sentences; a negative
        # value indicates "not similar at all" and reporting 0.0
        # for it is the same conclusion the report would draw
        # from the positive side of the scale.
        best_score = max(0.0, min(1.0, best_score))
        maxima.append(best_score)
        argmax_indices.append(best_idx)

    return maxima, argmax_indices


# =============================================================================
#  Private: flagged-sentence construction
# =============================================================================

def _build_flagged_sentence(
    sentence: str,
    similarity: float,
    source_title: str,
) -> dict:
    """
    Build a single entry for the report's `flaggedSentences`
    array, with every field clamped to the bounds the Report
    schema enforces.

    The clamps:

      * `text` is truncated to `_MAX_FLAGGED_TEXT_LENGTH`
        characters. A flagged sentence is by definition one the
        pipeline has already tokenized and compared, and a
        sentence that exceeds 5000 characters is almost certainly
        the result of a pathological tokenization rather than a
        real prose sentence. Truncation preserves the report's
        validity.

      * `similarity` is clamped to `[0, 1]` and rounded to four
        decimal places. The Mongoose schema enforces `min: 0,
        max: 1`; the roundoff margin is the same the other two
        metrics use.

      * `source_title` is truncated to
        `_MAX_SOURCE_TITLE_LENGTH` characters. The caller
        (`_build_source_chunks`) has already applied the same
        truncation, so this second clamp is belt-and-braces — a
        future caller that bypassed the chunk builder would still
        produce a schema-valid value.

    The function is total — every argument produces a valid
    entry. An empty source title is not possible because the
    chunk builder defaults to a non-empty fallback, but the
    function defensively substitutes a placeholder in that case
    anyway.

    Args:
        sentence:     The article sentence that was flagged.
        similarity:   The similarity value that triggered the
                      flag.
        source_title: The title of the source it matched.

    Returns:
        A dict with `text`, `similarity`, and `sourceTitle`
        fields, all schema-valid.
    """
    # Truncate the sentence text.
    text_value = sentence
    if len(text_value) > _MAX_FLAGGED_TEXT_LENGTH:
        text_value = text_value[:_MAX_FLAGGED_TEXT_LENGTH].rstrip()

    # Clamp and round the similarity.
    similarity_value = max(0.0, min(1.0, float(similarity)))
    similarity_value = round(similarity_value, 4)

    # Truncate and default the source title.
    title_value = source_title or "Untitled source"
    if len(title_value) > _MAX_SOURCE_TITLE_LENGTH:
        title_value = title_value[:_MAX_SOURCE_TITLE_LENGTH].rstrip()

    return {
        "text": text_value,
        "similarity": similarity_value,
        "sourceTitle": title_value,
    }


# =============================================================================
#  Private: status classification
# =============================================================================

def _classify_status(
    max_tfidf_value: float,
    max_semantic_value: float,
    flagged_count: int,
    max_tfidf_limit: float,
    max_semantic_limit: float,
) -> str:
    """
    Classify the originality section as `'good'`, `'warning'`,
    or `'fail'`. See the module docstring for the reasoning.

    Summary of the rule:

      * `'good'`    — neither maximum exceeds its limit, so no
                      sentence was flagged.

      * `'warning'` — at least one maximum exceeds its limit, but
                      the worst excess is within
                      `_GRADE_WARNING_MARGIN_FRACTION` and the
                      flagged-sentence count is at most
                      `_MAX_FLAGGED_FOR_WARNING`.

      * `'fail'`    — anything else.

    The "worst excess" is expressed as a ratio to the limit, so
    the two limits do not have to be equal for the rule to be
    meaningful. A section with a TF-IDF maximum of 0.35 against a
    limit of 0.30 has an excess ratio of 1.166; a section with a
    semantic maximum of 0.42 against a limit of 0.35 has an
    excess ratio of 1.20. Both are within the 1.25 margin and
    therefore warnings, not fails.

    A limit of zero disables its corresponding signal. When both
    limits are zero, every excess ratio is treated as 0.0 and the
    section is classified `'good'` — the caller asked not to
    check originality, so the section reports the trivially-good
    answer.

    Args:
        max_tfidf_value:     The worst TF-IDF similarity.
        max_semantic_value:  The worst semantic similarity.
        flagged_count:       The number of flagged sentences.
        max_tfidf_limit:     The TF-IDF limit.
        max_semantic_limit:  The semantic limit.

    Returns:
        One of `'good'`, `'warning'`, `'fail'`.
    """
    # Compute the worst excess ratio across the two signals.
    # A signal with a non-positive limit is treated as 0.0
    # excess — it cannot be exceeded.
    tfidf_ratio = 0.0
    if max_tfidf_limit > 0:
        tfidf_ratio = max_tfidf_value / max_tfidf_limit

    semantic_ratio = 0.0
    if max_semantic_limit > 0:
        semantic_ratio = max_semantic_value / max_semantic_limit

    worst_ratio = max(tfidf_ratio, semantic_ratio)

    # Inside both limits.
    if worst_ratio <= 1.0:
        return "good"

    # Over at least one limit. Apply the margin and the count
    # tie-breaker.
    within_margin = worst_ratio <= (1.0 + _GRADE_WARNING_MARGIN_FRACTION)
    within_count = flagged_count <= _MAX_FLAGGED_FOR_WARNING

    if within_margin and within_count:
        return "warning"

    return "fail"


# =============================================================================
#  Private: empty-result builders and shared helpers
# =============================================================================

def _clamp_and_round(value: float) -> float:
    """
    Clamp a similarity value to `[0, 1]` and round to four
    decimal places. Used for the two top-level maxima on the
    report so the JSON output is stable and schema-valid.
    """
    clamped = max(0.0, min(1.0, float(value)))
    return round(clamped, 4)


def _empty_result() -> dict:
    """
    Return the originality section for an article that has no
    prose, or for a call with no source documents to compare
    against.

    Every metric is zero and the status is `'good'` — there is
    nothing for the user to act on. The function is the single
    source of truth for that shape; both the "empty article"
    branch and the "no sources" branch in `validate_originality`
    return this value directly.
    """
    return {
        "maxTfidfSimilarity": 0.0,
        "maxSemanticSimilarity": 0.0,
        "flaggedSentences": [],
        "status": "good",
    }


# =============================================================================
#  Default export
# =============================================================================

__all__ = [
    "validate_originality",
]