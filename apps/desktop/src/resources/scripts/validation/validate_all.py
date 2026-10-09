#!/usr/bin/env python3
"""
validation/validate_all.py — orchestrator for the six validators.

The single entry point the pipeline invokes to validate a
generated article. Reads the article and its source documents,
runs the six validators in this package (readability, seo_check,
keyword_check, originality, ai_markers, grammar) in sequence,
aggregates their six sections into a single JSON report, computes
the report's overall status, writes the report to the topic's
`reports/` folder, and emits the VALIDATION_PROGRESS and
VALIDATION_DONE markers the GUI's Report tab listens for.

The orchestration model:

    `run_validate` is called by `main.py`'s `_run_validate`
    handler via the `validate` subcommand. It is the only
    function in the validation package that reads files, writes
    files, or emits markers — the six validator modules are pure
    functions of `(article_text, ...) -> section_dict`. That
    separation is what makes each validator testable in
    isolation and what lets this file change its orchestration
    (running validators in parallel, skipping disabled
    validators, adding a seventh dimension) without touching the
    validators themselves.

What the article is, and where it comes from:

    The `article_path` argument is the absolute path to the
    article `.md` file the writer step produced. The pipeline's
    convention places articles at
    `<topic>/article/draft-NN.md`, so the topic's folder is the
    grandparent of the article file, and the report lands at
    `<topic>/reports/report-draft-NN.json` — see the "Report file
    location" section below.

    The article's text is read as-is and handed to each validator
    unmodified. Each validator strips frontmatter and Markdown
    for itself, because each has a slightly different view of
    what "prose" means — the readability check strips code fences
    before scoring, the keywords check reads the raw text to find
    the H1 title, the grammar check offsets into the stripped
    text so the UI can highlight the issue — and the orchestration
    layer would have to pre-compute every one of those views to
    keep the validators simple, which would cost more clarity
    than it saves.

Where the keywords come from:

    The keyword_check validator needs the user's keyword set to
    score the article against. The set lives in the topic's own
    `topic.json` file at the topic root — the same file the
    Electron main process writes when the user creates the topic
    and updates when they adjust its keyword list at the keyword-
    extraction stage.

    `run_validate` reads `topic.json` on a best-effort basis. If
    the file is absent — a topic whose `topic.json` was deleted,
    a validation run against an article that was copied out of
    its topic folder — the keyword set is empty and the
    keyword_check validator returns a trivially-good section with
    an empty `keywords` array. That is the correct behavior: the
    user's report cannot penalize the article for missing
    keywords that were never requested.

    The keywords list on `topic.json` is expected to be a
    `string[]`, matching the backend's `Topic` schema. Any entry
    that is not a non-empty string is filtered out before the
    keyword validator runs.

Where the source documents come from:

    The originality validator needs the source docs the article
    was generated from to compare against. The `sources_dir`
    argument is the absolute path to the topic's `sources/`
    folder. `run_validate` globs every `.md` file in that folder
    and passes a list of `{"content": str, "title": str}` dicts
    to the originality validator. The title for each doc is the
    filename stem — `001-reddit-how-to-garden-in-a-tiny-apartment`
    — which is what the extraction pipeline wrote and which is
    descriptive enough to identify the source in the flagged-
    sentence report.

    A missing or empty `sources_dir` produces an empty source
    list. The originality validator returns a trivially-good
    section with zero similarities, and the report's
    `maxTfidfSimilarity` and `maxSemanticSimilarity` fields are
    both 0.0. That degraded result is logged at warning level by
    this file (the source list's absence is worth surfacing) but
    does not fail the validation run.

Report file location:

    The report is written to
    `<topic_folder>/reports/report-<article_stem>.json`, where:

      * `<topic_folder>` is the grandparent of the article file —
        the folder that contains the article's `article/`
        subfolder, the `sources/` subfolder, and the `reports/`
        subfolder.

      * `<article_stem>` is the article file's name without its
        `.md` extension. For an article at
        `.../article/draft-01.md`, the stem is `draft-01`, and
        the report lands at `.../reports/report-draft-01.json`.

    The plan's tree describes the report filename as
    `report-<article-id>.json`. The `<article-id>` in that
    notation is the Mongo ObjectId the backend assigns when the
    Report document is created — an identifier this script does
    not have, because the backend assigns it after the report is
    POSTed to `/api/reports`. Using the article's filename stem
    keeps the local filename deterministic and correlates the
    report to its article by name, which is what the desktop's
    IPC handler uses to map the local file back to the
    corresponding article when it POSTs the report.

Overall status computation:

    The report's `overallStatus` field is the worst of the six
    section statuses, using the same "weakest link" rule the
    backend's `reportService.ts` applies at the API boundary —
    see that file's `computeOverallStatus` helper for the exact
    rule. The two implementations must agree: if the backend
    recomputes the field on POST (which it does, ignoring any
    client-supplied value for it), a discrepancy between the
    local value and the backend's computation would surface as
    a report whose displayed status changed after a round trip
    to the server.

    Keeping the rule in one place — this file for the local
    computation, `reportService.ts` for the server-side one —
    is the contract. The rule itself is three lines and is
    unlikely to change; if it ever does, both files change
    together.

Report shape:

    The report is a JSON object with the following fields:

        {
            "articlePath":   str,      # absolute path to the article
            "validatedAt":   str,      # ISO-8601 UTC timestamp
            "readability":   { ... },  # ReadabilityReport section
            "seo":           { ... },  # SeoReport section
            "keywords":      { ... },  # KeywordReport section
            "originality":   { ... },  # OriginalityReport section
            "aiMarkers":     { ... },  # AiMarkersReport section
            "grammar":       { ... },  # GrammarReport section
            "overallStatus": str,      # 'good' | 'warning' | 'fail'
        }

    The six section objects match the shared `Report` interface's
    sub-types exactly — see each validator's module docstring for
    the specific fields. The top-level `articlePath` and
    `validatedAt` fields are metadata that the desktop's IPC
    handler uses to correlate the report with its article and to
    display a "validated 3 minutes ago" line in the report
    header. They are NOT part of the backend's `Report` schema and
    are stripped by the IPC handler before the report is POSTed.

Checkpoints and exit codes:

    The function checks for a pending Skip / Stop command before
    each validator runs. A user who clicks Stop after the
    readability section completes does not wait for the
    remaining five. A checkpoint that observes Skip or Stop
    causes the process to exit with the code `core.output`
    defines for that outcome — `EXIT_SKIPPED` (99) or
    `EXIT_STOPPED` (100) — which `main.py` classifies into a
    `TASK_END` status of `'skipped'` or `'aborted'`.

    A clean return of 0 indicates the report was written
    successfully. A return of 1 indicates the article could not
    be read or the report could not be written — either is a
    hard failure and the desktop's IPC handler surfaces it as
    an error to the user.

What this module does NOT do:

  * It does not validate any document other than the article.
    The source documents are read for the originality check
    only; their own quality is not part of the report.

  * It does not POST the report to the backend. The report file
    is a local staging artifact. The desktop's IPC handler for
    the validation operation reads the file and POSTs it to
    `/api/reports`, where the backend persists it and returns
    the created `Report` document with the Mongo IDs. Keeping
    the two operations separate means this script can run
    standalone for debugging without needing the backend to be
    reachable.

  * It does not detect or handle the `articleId`, `topicId`, or
    `userId` fields the backend's `Report` schema requires —
    those are the desktop's responsibility, as noted above.

  * It does not emit a `TASK_START` or `TASK_END` marker. Those
    belong to `main.py`, which brackets every subcommand
    invocation with them.

Dependencies: Python stdlib + the six validator modules in this
package + the sibling `core/` package. No external library is
imported directly by this file — the six validators import their
own library dependencies (textstat, nltk, scikit-learn,
sentence-transformers, language-tool-python) internally.
"""

import sys
from pathlib import Path

# =============================================================================
#  sys.path bootstrap — MUST run BEFORE any `from core.* import ...`
# =============================================================================
#  Identical to the bootstrap in every other feature script. The
#  script lives at scripts/validation/validate_all.py, so its own
#  directory is validation/, and the parent's parent is the
#  directory that contains `core/`. That directory must be on
#  sys.path for the sibling imports below to resolve in the
#  packaged app's embedded Python distribution.

_SCRIPT_DIR = Path(__file__).resolve().parent
_SCRIPTS_ROOT = _SCRIPT_DIR.parent
if str(_SCRIPTS_ROOT) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_ROOT))

from core.control_mode import checkpoint_check
from core.output import (
    emit_marker,
    MARKER_VALIDATION_PROGRESS,
    MARKER_VALIDATION_DONE,
    EXIT_SKIPPED,
    EXIT_STOPPED,
)
from core.file_io import (
    read_doc,
    read_json,
    write_json_atomic,
    utc_now_iso,
)
from core.utils import (
    log_info,
    log_warning,
    log_error,
    log_debug,
    log_success,
)

from validation.readability import validate_readability
from validation.seo_check import validate_seo
from validation.keyword_check import validate_keywords
from validation.originality import validate_originality
from validation.ai_markers import validate_ai_markers
from validation.grammar import validate_grammar


# =============================================================================
#  Constants — the six phases, in run order
# =============================================================================
#
# The tuple below is the single source of truth for the
# orchestration's ordering and for the phase names that appear in
# every VALIDATION_PROGRESS marker payload. The order is the one
# the plan's user journey shows in its report panel — readability,
# seo, keywords, originality, ai markers, grammar — and matches
# the order the six section keys appear on the shared `Report`
# interface.
#
# The names are snake_case because they double as the phase
# identifiers in the marker payload and as a compact reference in
# the pipeline's log. A hypothetical future phase named "seo"
# would produce a marker with `phase: "seo"` — the validator's
# name and the phase's name are the same string by design, so a
# reader who sees a marker can immediately locate the source of
# that section.

_PHASES = (
    "readability",
    "seo",
    "keywords",
    "originality",
    "ai_markers",
    "grammar",
)

_TOTAL_PHASES = len(_PHASES)


# =============================================================================
#  Public entry point
# =============================================================================

def run_validate(
    article_path: str,
    sources_dir: str,
) -> int:
    """
    Validate a generated article and write its report to disk.

    See the module docstring for the full flow. Returns an
    integer exit code:

        0   – the report was written to disk
        1   – the article could not be read, or the report could
              not be written
        99  – user clicked Skip at a checkpoint (raises, does
              not return)
        100 – user clicked Stop at a checkpoint (raises, does
              not return)

    The 0-vs-1 distinction is what `main.py` uses to classify the
    operation in its `TASK_END` marker. A validation run that
    completed its six sections — even if one of them degraded
    because a validator's optional dependency was unavailable —
    returns 0: the report was written, and the desktop's IPC
    handler can POST it to the backend. A run whose article file
    is missing or whose report file could not be written returns
    1: the caller has no report to deliver.

    Parameters (matched by `main.py`'s keyword-argument call
    site):

        article_path – The absolute path to the article `.md`
                       file to validate.
        sources_dir  – The absolute path to the topic's
                       `sources/` folder. Used by the
                       originality validator to compare the
                       article against its sources.

    The function is fully synchronous — it performs no async I/O
    and spawns no subprocess itself. The six validators it calls
    may each start their own background subprocess on first use
    (LanguageTool's Java server, the sentence-transformer model
    load); those subprocesses are cached at module level and
    their lifecycles are managed by the validators.
    """
    # ---- 1. Validate the article file exists ----
    # This is the one input that the whole run depends on. A
    # missing article file is an immediate failure — there is
    # nothing to validate.
    article_file = Path(article_path)
    if not article_file.is_file():
        log_error(
            f"validate: article file not found: {article_path}"
        )
        return 1

    # ---- 2. Derive the topic folder from the article path ----
    # The topic folder is the grandparent of the article file,
    # under the pipeline's convention that articles live at
    # `<topic>/article/draft-NN.md`. The topic's own identifier
    # is the folder's name; if the path is unusually shallow and
    # the grandparent's name is empty, a fallback is used so the
    # markers still carry a stable string.
    article_stem = article_file.stem
    topic_folder = article_file.parent.parent
    topic_id = topic_folder.name or "(unknown-topic)"
    log_info(
        f"Validating article '{article_file.name}' for topic "
        f"'{topic_id}'"
    )

    # ---- 3. Read the article text ----
    # The full article, including any frontmatter it may carry.
    # Each validator handles its own frontmatter stripping.
    try:
        article_text = read_doc(article_file)
    except Exception as exc:
        log_error(f"validate: could not read article file: {exc}")
        return 1

    if not article_text.strip():
        log_error("validate: article file is empty.")
        return 1

    # ---- 4. Read the topic's keywords (best-effort) ----
    # The keyword validator needs the user's keyword set. It is
    # read from `topic.json` at the topic root. A missing file
    # or a missing `keywords` field yields an empty list; the
    # keyword validator treats an empty list as "no keywords
    # requested" and returns a trivially-good section.
    keywords = _read_topic_keywords(topic_folder)

    # ---- 5. Load the source documents (best-effort) ----
    # The originality validator compares the article against the
    # sources. A missing `sources_dir` or an empty one yields an
    # empty list; the originality validator returns a
    # trivially-good section with zero similarities.
    source_docs = _load_source_docs(sources_dir)

    # ---- 6. Run the six validators ----
    # Each phase follows the same shape:
    #
    #   a. Checkpoint — honour a pending Skip / Stop.
    #   b. Emit a VALIDATION_PROGRESS marker so the GUI shows
    #      the current phase.
    #   c. Call the validator, catching any unexpected exception
    #      and falling back to a minimal fail-shaped section.
    #
    # The sections are collected into a dict keyed by phase name
    # so the aggregation step below can assemble them without
    # caring about the order of assignments.
    sections = {}

    for index, phase in enumerate(_PHASES):
        ordinal = index + 1

        # ---- 6a. Checkpoint ----
        cmd = checkpoint_check("validation", phase)
        if cmd == "skip":
            log_info(f"Validation skipped by user before {phase}.")
            sys.exit(EXIT_SKIPPED)
        if cmd == "stop":
            log_info(f"Validation stopped by user before {phase}.")
            sys.exit(EXIT_STOPPED)

        # ---- 6b. Progress marker ----
        emit_marker(
            MARKER_VALIDATION_PROGRESS,
            {
                "topicId": topic_id,
                "phase": phase,
                "index": ordinal,
                "total": _TOTAL_PHASES,
            },
        )
        log_info(f"Running validator {ordinal}/{_TOTAL_PHASES}: {phase}")

        # ---- 6c. Call the validator ----
        # The `_call_validator` helper wraps the call in a
        # try/except and returns a minimal fail-shaped section
        # when the validator raises an unexpected exception.
        # The individual validators handle their own internal
        # failure paths and return well-formed dicts for those;
        # the helper exists for the "something went wrong in the
        # validator itself" case, so one buggy validator cannot
        # lose the other five sections.
        section = _call_validator(
            phase,
            article_text=article_text,
            keywords=keywords,
            source_docs=source_docs,
        )
        sections[phase] = section
        log_debug(
            f"{phase}: status={section.get('status', 'unknown')}"
        )

    # ---- 7. Assemble the report ----
    # The report dict combines the six sections with two
    # metadata fields the desktop's IPC handler uses to
    # correlate the report with its article. The metadata
    # fields are NOT part of the backend's `Report` schema and
    # are stripped before the report is POSTed to
    # `/api/reports`.
    overall_status = _compute_overall_status(sections)
    report = {
        "articlePath": str(article_file),
        "validatedAt": utc_now_iso(),
        "readability": sections["readability"],
        "seo": sections["seo"],
        "keywords": sections["keywords"],
        "originality": sections["originality"],
        "aiMarkers": sections["ai_markers"],
        "grammar": sections["grammar"],
        "overallStatus": overall_status,
    }

    # ---- 8. Write the report ----
    # The report lands at `<topic_folder>/reports/report-<stem>.json`.
    # The `write_json_atomic` helper creates the `reports/` folder
    # if it does not exist, writes the file to a temp path, and
    # renames it into place — a reader (the desktop IPC handler
    # that polls for the report) sees either the complete file or
    # no file, never a partial write.
    report_folder = topic_folder / "reports"
    report_path = report_folder / f"report-{article_stem}.json"

    try:
        write_json_atomic(report_path, report)
    except Exception as exc:
        log_error(f"validate: could not write report: {exc}")
        return 1

    # ---- 9. Success log ----
    log_success(
        f"Validation complete: {report_path.name} "
        f"(overall: {overall_status})"
    )

    # ---- 10. Emit the terminal marker ----
    emit_marker(
        MARKER_VALIDATION_DONE,
        {
            "topicId": topic_id,
            "reportPath": str(report_path),
            "overallStatus": overall_status,
        },
    )

    return 0


# =============================================================================
#  Private: validator dispatch
# =============================================================================

def _call_validator(
    phase: str,
    article_text: str,
    keywords: list,
    source_docs: list,
) -> dict:
    """
    Call the validator for a phase and return its section dict,
    with a minimal fail-shaped section as the fallback if the
    validator raises an unexpected exception.

    The helper exists so that the six-validator loop in
    `run_validate` reads as a single shape — checkpoint, emit,
    call, log — rather than as six separate blocks whose
    argument-passing differences obscure the common structure.

    The per-validator arguments differ slightly, so the helper
    switches on the phase name. Each branch is a single call
    whose arguments are exactly what that validator's signature
    declares:

      readability  → (article_text,)
      seo          → (article_text,)
      keywords     → (article_text, keywords)
      originality  → (article_text, source_docs)
      ai_markers   → (article_text,)
      grammar      → (article_text,)

    The explicit switch (rather than a dispatch table built at
    module load) keeps the argument names visible at the call
    site, which is worth more than the brevity a table would
    buy for six entries.

    Never raises. Any exception the validator produced is
    logged at warning level and the phase's fail-shaped
    fallback is returned.

    Args:
        phase:        The phase name — one of the six strings
                      in `_PHASES`.
        article_text: The article's full text, handed to every
                      validator.
        keywords:     The keyword set for the keyword validator.
        source_docs:  The source documents for the originality
                      validator.

    Returns:
        The validator's section dict, or the phase's fail-shaped
        fallback.
    """
    try:
        if phase == "readability":
            return validate_readability(article_text)

        if phase == "seo":
            return validate_seo(article_text)

        if phase == "keywords":
            return validate_keywords(article_text, keywords)

        if phase == "originality":
            return validate_originality(article_text, source_docs)

        if phase == "ai_markers":
            return validate_ai_markers(article_text)

        if phase == "grammar":
            return validate_grammar(article_text)

        # Unreachable — `_PHASES` is the closed set of phase
        # names and the loop in `run_validate` iterates it.
        # The branch exists so a future addition to `_PHASES`
        # that forgets to add a matching dispatch branch fails
        # cleanly (a well-formed fail-shaped section) rather
        # than with a `NameError`.
        log_warning(
            f"validate: no dispatch branch for phase '{phase}'"
        )
        return _fallback_section(phase)
    except Exception as exc:
        log_warning(
            f"{phase} validator raised an unexpected exception "
            f"({exc}); recording a fail-shaped section"
        )
        return _fallback_section(phase)


def _fallback_section(phase: str) -> dict:
    """
    Return a minimal fail-shaped section for a phase whose
    validator raised an unexpected exception.

    The shapes match the corresponding validator's own
    `_empty_result` shape, except the status is `'fail'` rather
    than `'good'` — the empty-input case is a legitimate "there
    is nothing to score" result, and the unexpected-exception
    case is a genuine failure. The distinction matters: a report
    that says "the readability section failed" tells the user
    something went wrong, while a report that says "readability
    is good" when it silently could not run would be misleading.

    Never raises.

    Args:
        phase: The phase name. A phase that is not one of the six
               legal names returns a minimal `{"status": "fail"}`
               dict.

    Returns:
        A fail-shaped section dict matching the phase's schema.
    """
    if phase == "readability":
        return {
            "fleschReadingEase": 0.0,
            "fleschKincaidGrade": 0.0,
            "gunningFog": 0.0,
            "smogIndex": 0.0,
            "avgSentenceLength": 0.0,
            "readingTimeSeconds": 0,
            "status": "fail",
        }
    if phase == "seo":
        return {
            "wordCount": 0,
            "h2Count": 0,
            "h3Count": 0,
            "avgParagraphWords": 0.0,
            "passiveVoicePercent": 0.0,
            "transitionWordsPercent": 0.0,
            "status": "fail",
        }
    if phase == "keywords":
        return {
            "keywords": [],
            "status": "fail",
        }
    if phase == "originality":
        return {
            "maxTfidfSimilarity": 0.0,
            "maxSemanticSimilarity": 0.0,
            "flaggedSentences": [],
            "status": "fail",
        }
    if phase == "ai_markers":
        return {
            "markerCount": 0,
            "markers": [],
            "status": "fail",
        }
    if phase == "grammar":
        return {
            "issueCount": 0,
            "issues": [],
            "status": "fail",
        }
    return {"status": "fail"}


# =============================================================================
#  Private: input readers
# =============================================================================

def _read_topic_keywords(topic_folder: Path) -> list:
    """
    Read the keyword set from the topic's `topic.json` file.

    The file lives at `<topic_folder>/topic.json` — the same file
    the Electron main process writes when the topic is created
    and updates when the user's keyword set changes. Its shape
    mirrors the backend's `Topic` interface, with a `keywords`
    field that is a `string[]`.

    Every failure mode is treated as "no keywords":

      * The file does not exist.
      * The file cannot be read (a permissions problem).
      * The file is not valid JSON.
      * The parsed value is not an object.
      * The `keywords` field is absent.
      * The `keywords` field is present but not a list.
      * The `keywords` field is a list but contains non-string
        or empty-string entries — those are filtered out.

    The filtered list is returned. The keyword validator treats
    an empty list as "no keywords requested" and produces a
    trivially-good section.

    Never raises. Every failure is logged at debug or warning
    level (warning only for a missing file, which the caller
    may want to notice; debug for the individual malformed-
    entry cases, which are expected to be rare and not worth
    surfacing on every run).

    Args:
        topic_folder: The topic's folder path.

    Returns:
        A list of non-empty keyword strings, or an empty list.
    """
    topic_json_path = topic_folder / "topic.json"

    if not topic_json_path.is_file():
        log_warning(
            f"validate: topic.json not found at "
            f"{topic_json_path}; the keyword check will run "
            f"with an empty keyword set"
        )
        return []

    try:
        data = read_json(topic_json_path)
    except Exception as exc:
        log_warning(
            f"validate: could not read topic.json ({exc}); "
            f"the keyword check will run with an empty "
            f"keyword set"
        )
        return []

    raw_keywords = data.get("keywords")
    if not isinstance(raw_keywords, list):
        log_debug(
            "validate: topic.json has no keywords list; "
            "the keyword check will run with an empty set"
        )
        return []

    keywords = []
    for entry in raw_keywords:
        if isinstance(entry, str):
            trimmed = entry.strip()
            if trimmed:
                keywords.append(trimmed)
    return keywords


def _load_source_docs(sources_dir: str) -> list:
    """
    Read every `.md` file in the sources folder and return a
    list of `{"content": str, "title": str}` dicts.

    The title for each document is the file's stem — its name
    without the `.md` extension. That is the shape the
    extraction pipeline wrote (see `extract_dispatch.py`'s
    `_build_doc_slug`), and it is descriptive enough to identify
    the source in the originality report's flagged-sentence
    entries.

    The files are sorted by name. The extraction pipeline names
    its docs with a zero-padded index (`001-`, `002-`, …), so a
    lexical sort reproduces the batch order, and the report's
    flagged-sentence `sourceTitle` fields carry the same
    ordering as the user's doc list.

    Every failure mode is treated as "no sources":

      * The folder does not exist.
      * The folder is empty.
      * A specific file cannot be read — that file is skipped,
        with a warning logged, and the other files are still
        returned.

    Never raises.

    Args:
        sources_dir: The absolute path to the sources folder.

    Returns:
        A list of `{"content": str, "title": str}` dicts, one
        per readable source document. Empty when no document
        is readable.
    """
    folder = Path(sources_dir)

    if not folder.is_dir():
        log_warning(
            f"validate: sources folder not found at "
            f"{sources_dir}; the originality check will run "
            f"with no source documents"
        )
        return []

    doc_files = sorted(folder.glob("*.md"))
    if not doc_files:
        log_warning(
            f"validate: sources folder {sources_dir} is empty; "
            f"the originality check will run with no source "
            f"documents"
        )
        return []

    docs = []
    for doc_path in doc_files:
        try:
            content = read_doc(doc_path)
        except Exception as exc:
            log_warning(
                f"validate: could not read source "
                f"{doc_path.name} ({exc}); skipping it"
            )
            continue
        if not content.strip():
            log_debug(
                f"validate: source {doc_path.name} is empty; "
                f"skipping it"
            )
            continue
        docs.append({
            "content": content,
            "title": doc_path.stem,
        })

    log_debug(
        f"validate: loaded {len(docs)} source document(s)"
    )
    return docs


# =============================================================================
#  Private: overall-status computation
# =============================================================================

def _compute_overall_status(sections: dict) -> str:
    """
    Compute the report's overall status from the six section
    statuses.

    The rule: the weakest section status wins. Any `fail` in any
    section makes the report `fail`; otherwise any `warning`
    makes it `warning`; otherwise the report is `good`.

    This is the same rule the backend's `reportService.ts`
    applies when the desktop's IPC handler POSTs the report to
    `/api/reports`. The two implementations must agree — see the
    module docstring's "Overall status computation" section for
    the contract.

    The function is total over any dict whose values are section
    dicts with a `status` field. A section whose `status` is
    missing or whose value is not one of the three legal strings
    is treated as `'fail'` — a malformed section is by definition
    a failure, and reporting `'good'` for it would be misleading.

    Args:
        sections: A dict whose values are the six section dicts.

    Returns:
        `'good'`, `'warning'`, or `'fail'`.
    """
    statuses = []
    for section in sections.values():
        if isinstance(section, dict):
            status = section.get("status", "fail")
            if status in ("good", "warning", "fail"):
                statuses.append(status)
            else:
                statuses.append("fail")
        else:
            statuses.append("fail")

    if "fail" in statuses:
        return "fail"
    if "warning" in statuses:
        return "warning"
    return "good"


# =============================================================================
#  Default export
# =============================================================================

__all__ = [
    "run_validate",
]