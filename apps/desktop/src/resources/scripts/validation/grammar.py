#!/usr/bin/env python3
"""
validation/grammar.py — grammar and style checking for WriteSpeare.

The sixth of the six article validators. Runs the article through
a local LanguageTool server and produces the `grammar` section of
the validation report: an issue count, the list of issues with
their character positions and replacement suggestions, and a
section status.

Why LanguageTool:

    LanguageTool is the standard open-source grammar/style/spell
    checker for English and about thirty other languages. It is
    rule-based rather than statistical, which gives two
    properties this validator needs:

      * Deterministic output. The same input produces the same
        issue list on every run, on every machine. That
        reproducibility is what lets the validation report be a
        stable document the user can act on — a checker whose
        output drifted between runs would make the "did I fix
        everything?" question unanswerable.

      * Explanatory messages. Every issue carries a rule
        identifier (`EN_QUOTES`, `UPPERCASE_SENTENCE_START`,
        `MORFOLOGIK_RULE_EN_US`) and a human-readable message
        that names the problem. The rule id is what the desktop
        UI uses to group issues; the message is what the user
        reads.

    The alternative — a statistical grammar model — would
    produce higher coverage on complex stylistic issues but would
    also produce non-reproducible output and unexplained flags.
    For a validation report that the user is expected to act on,
    the trade favors LanguageTool.

The local-server model:

    `language-tool-python` does not embed the LanguageTool
    engine — it launches the Java-based LanguageTool server as a
    subprocess on first use, waits for it to become ready, and
    then communicates with it over HTTP on a loopback port. The
    server's startup costs several seconds (the JVM boot plus
    the LanguageTool engine's model loading), and each `check()`
    call runs against that already-started server.

    The consequences of that design, and how this module handles
    them:

      * The server is expensive to start and cheap to keep
        running. This module caches a single LanguageTool
        instance at module scope, exactly as
        `originality.py` caches its embedding model — the first
        call to `_load_language_tool` pays the startup cost, and
        every subsequent call in the same process reuses the
        already-running server.

      * The server holds a Java subprocess that outlives the
        Python function that started it. This module registers
        an `atexit` handler that calls `close()` on the cached
        instance during interpreter shutdown, so the Java
        subprocess does not linger as an orphan after the
        Python process exits. See the `atexit.register` call
        below for the details.

      * Java must be installed on the machine. If it is not,
        the LanguageTool constructor raises on its first call.
        This module treats that as a recoverable condition —
        the load failure is logged at warning level and every
        subsequent call returns the same degraded result.
        See the module docstring's next section.

Graceful degradation:

    Three failure modes are possible when the LanguageTool
    instance is first loaded or when it runs a check:

      1. Java is not installed on the machine.

      2. The language-tool-python package cannot find its
         bundled LanguageTool jar — a packaging problem in the
         desktop's embedded Python runtime.

      3. The check call itself raises — an out-of-memory error
         on a very large article, an internal LanguageTool
         exception on a pathological input.

    In every one of those cases the module logs the failure at
    warning level and returns a well-formed grammar section with
    an issue count of zero and a status of `'good'`. The choice
    of `'good'` rather than a distinct status is forced by the
    schema — the shared `GrammarReport` type only allows the
    three values `'good' | 'warning' | 'fail'` — and it is the
    honest answer: the validator did not find any issues, and
    the reason it did not find any (the check could not run) is
    recorded in the pipeline's log rather than in the report.

    A hard failure would lose the entire validation run for a
    dimension of the report the user might not even care about;
    a silent degraded result that the log records is the better
    trade.

The stripped-text offset decision:

    LanguageTool's `check()` returns issues whose `offset` and
    `length` fields index into the text it was given. This
    module strips Markdown before calling `check()`, so the
    offsets the report carries index into the STRIPPED text,
    not into the article's original Markdown source.

    That is the correct choice for the UI. The `GrammarPanel`
    in the renderer displays the article's prose, not its
    Markdown — the user reads "The cat sat." not "**The** cat
    sat." — and highlighting an issue at offset 4 of the
    stripped text is what puts the highlight on the right word.
    Highlighting at offset 4 of the raw Markdown would land on
    the second asterisk of the bold marker.

    The consequence the UI has to know about: the offsets are
    relative to the same stripped view the other validators
    operate on, not to the raw `.md` file. The `GrammarPanel`
    is expected to render the article's stripped prose (it can
    strip Markdown client-side with the same rules, or display
    the article body from a pre-stripped view) so that the
    offsets land on the right characters.

The report shape this function returns matches the shared
`GrammarReport` and `GrammarIssue` interfaces declared in the
desktop's `features/shared/types/index.ts` and the backend's
`features/shared/types/index.ts`:

    {
        "issueCount": int,
        "issues": [
            {
                "ruleId":       str,      # 1–200 chars
                "message":      str,      # 1–2000 chars
                "offset":       int,      # 0–1000000
                "length":       int,      # 0–1000000
                "replacements": [str, ...],
            },
            ...
        ],
        "status": 'good' | 'warning' | 'fail',
    }

    The `Report` Mongoose schema in `apps/server/src/features/
    reports/models/Report.ts` enforces the bounds above, plus
    integer-ness on `issueCount`, `offset`, and `length`, and a
    `min: 0, max: 100000` bound on the top-level `issueCount`.
    This module's `_build_issue` helper clamps every value it
    emits to those bounds before returning, so a LanguageTool
    rule that ever produced an exceptionally long message or a
    pathological offset cannot make the report unsaveable.

Dependencies: Python stdlib + the `language-tool-python` package
(declared in requirements.txt) + the sibling `core/` package.
The `language-tool-python` package additionally requires a Java
runtime on the host; see the module docstring's "Graceful
degradation" section for how a missing Java is handled.
"""

import atexit
import re
import sys
from pathlib import Path

# =============================================================================
#  sys.path bootstrap — MUST run BEFORE any `from core.* import ...`
# =============================================================================
#  Identical to the bootstrap in every other feature script. The
#  script lives at scripts/validation/grammar.py, so its own
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
#  Constants — LanguageTool configuration
# =============================================================================
#
# The language tag passed to LanguageTool's constructor. `en-US`
# is the variant the plan's user journey targets and the one the
# default prompt templates are written for. A future session that
# wants to make the language configurable would lift this into
# the caller's arguments; today it is a module-level constant
# because the pipeline has exactly one language in its scope.

_LANGUAGE_TOOL_LANGUAGE = "en-US"


# =============================================================================
#  Constants — schema-derived bounds
# =============================================================================
#
# The upper bounds the Report Mongoose schema enforces on each
# issue's fields. `_build_issue` clamps to these before emitting
# so a LanguageTool message that ever exceeded a bound cannot
# produce a report the backend would reject at save time.
#
# The lower bounds (1 for the two strings, 0 for the two
# integers) are enforced by the schema's `minlength` and `min`
# options respectively; `_build_issue` handles them by
# substituting a non-empty placeholder for an empty `ruleId` or
# `message` (which LanguageTool never produces but which a
# defensive code path must handle) and by clamping the integers
# with `max(0, ...)`.

_MAX_RULE_ID_LENGTH = 200
_MAX_MESSAGE_LENGTH = 2000
_MAX_OFFSET = 1000000
_MAX_LENGTH = 1000000
_MAX_ISSUE_COUNT = 100000


# =============================================================================
#  Constants — Markdown stripping patterns
# =============================================================================
#
# Same pattern set as the four preceding validators. LanguageTool
# is designed for plain prose — its rules flag `**` as an
# unexpected character, `##` as a misuse of hashes, and a
# markdown-style `- item` line as a sentence fragment. Passing
# the article's raw Markdown would produce a long list of
# grammatical "errors" that are really just the article's own
# formatting. The stripper removes the markup and leaves the
# prose.
#
# The five validators' strippers overlap heavily but are not
# identical; see `seo_check.py`'s module docstring for the
# reasoning behind the local declarations rather than a shared
# import.

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
#  Module-level LanguageTool cache
# =============================================================================
#
# The LanguageTool instance is loaded lazily and cached here.
# The three possible states are:
#
#   None  — the tool has not been loaded yet in this process. The
#           next call to `_load_language_tool` will attempt to
#           load it.
#   A `LanguageTool` instance — the tool is loaded and ready.
#   False — a previous load attempt failed. Subsequent calls
#           return None without retrying, so a failed first
#           attempt does not cost every subsequent call another
#           multi-second JVM boot.
#
# The same "None / instance / False" pattern as
# `originality.py`'s embedding-model cache, and for the same
# reason: distinguishing "not yet attempted" from "attempted and
# failed" requires a sentinel value that is not itself a valid
# loaded instance. `False` is that sentinel.

_language_tool_instance = None


def _close_language_tool_at_exit() -> None:
    """
    Close the cached LanguageTool instance during interpreter
    shutdown. Registered with `atexit` below.

    LanguageTool's Python wrapper spawns a Java subprocess on
    first construction. That subprocess does not terminate when
    the Python process exits unless it is told to — a naive
    implementation would leave an orphaned `java.exe` on the
    user's machine after every validation run, visible in Task
    Manager as a process that consumes memory for no reason.

    The `close()` method on the LanguageTool instance is what
    terminates the subprocess. This handler calls it, but only
    when an instance is actually cached — a process that never
    loaded the tool has nothing to close.

    Never raises. An exception during `close()` is logged at
    debug level (not warning level — this runs during interpreter
    shutdown, when the log itself may be closing, and a shutdown
    warning would be noise the user cannot act on). The cleanup
    is best-effort; a Java subprocess that survived a close
    failure is a system-level anomaly, not a bug this module can
    fix.
    """
    global _language_tool_instance

    if _language_tool_instance is None or _language_tool_instance is False:
        return

    try:
        _language_tool_instance.close()
    except Exception:
        # Swallowed intentionally. See the docstring.
        pass
    finally:
        _language_tool_instance = None


atexit.register(_close_language_tool_at_exit)


# =============================================================================
#  Public entry point
# =============================================================================

def validate_grammar(
    article_text: str,
    max_issues: int = 5,
) -> dict:
    """
    Compute the grammar section of the validation report for an
    article. See the module docstring for the reasoning behind
    every decision.

    The function is a pure transformation (modulo the one-time
    LanguageTool load, which is cached at module level). It reads
    no files, writes no files, and emits no markers — the
    dispatcher owns all of those concerns.

    Threshold default:

      `max_issues` — 5. The value that classifies the plan's
                     user-journey example (4 issues) as `'good'`,
                     matching what the example's report shows.
                     The rule doubles the threshold for the
                     warning band, so an article with 6–10 issues
                     is a warning and an article with 11 or more
                     is a fail.

                     The preset model in the backend exposes a
                     `runGrammarCheck` boolean but does not
                     currently declare a numeric threshold for
                     this validator; the dispatcher calls this
                     function with the default. A future session
                     that adds a per-preset grammar threshold
                     would add the field to the preset schema
                     and pass it here.

    Args:
        article_text:  The article's full Markdown text,
                       including any frontmatter. The text is
                       stripped of frontmatter and Markdown
                       before the LanguageTool check runs; see
                       the module docstring's "stripped-text
                       offset decision" section for what the
                       offsets in the returned issues refer to.
        max_issues:    The threshold at or below which the
                       article is classified `'good'`. A
                       non-positive threshold disables the good
                       band — every article with any issue is at
                       least a warning, and the warning band's
                       upper edge collapses to zero, so every
                       article with any issue is a fail.

    Returns:
        The grammar section dict. Never None, never partial. An
        empty or frontmatter-only input produces a well-formed
        zero-valued dict with a `'good'` status. A degraded run —
        LanguageTool could not be loaded, or the check raised —
        produces the same shape, with the failure recorded in
        the pipeline's log rather than in the section.
    """
    # ---- 1. Guard against empty input ----
    if not article_text or not article_text.strip():
        log_debug(
            "grammar: empty article — returning zero issues"
        )
        return _empty_result()

    # ---- 2. Strip frontmatter ----
    # The article file may carry YAML frontmatter — a title, an
    # author, a timestamp — none of which is prose the grammar
    # checker should be examining. A frontmatter field that
    # happens to be a valid English sentence would produce a
    # grammar issue for text the user did not write as part of
    # the article.
    body = strip_frontmatter(article_text)

    if not body.strip():
        log_debug(
            "grammar: article stripped to empty — "
            "returning zero issues"
        )
        return _empty_result()

    # ---- 3. Strip Markdown ----
    # See the module's Markdown-stripping constants for the
    # rationale.
    plain_text = _strip_markdown(body)

    if not plain_text.strip():
        log_debug(
            "grammar: article stripped to empty prose — "
            "returning zero issues"
        )
        return _empty_result()

    # ---- 4. Load LanguageTool ----
    # The load is cached at module level. A `None` return means
    # the load failed — the failure has already been logged at
    # warning level by `_load_language_tool`, and this function
    # returns the same degraded zero-issues result the empty-
    # input branch produces.
    tool = _load_language_tool()
    if tool is None:
        log_debug(
            "grammar: LanguageTool unavailable — "
            "returning zero issues"
        )
        return _empty_result()

    # ---- 5. Run the check ----
    # A single `check()` call against the entire stripped text.
    # LanguageTool internally segments the text into sentences
    # and runs its rules against each segment; the caller does
    # not need to pre-tokenize. An exception here — a memory
    # error on a very long article, an internal LanguageTool
    # bug on a pathological input — degrades to the same
    # zero-issues result as a load failure, with a warning
    # logged.
    try:
        matches = tool.check(plain_text)
    except Exception as exc:
        log_warning(
            f"grammar: LanguageTool check failed ({exc}); "
            f"returning zero issues"
        )
        return _empty_result()

    # ---- 6. Convert matches to issues ----
    # Each `Match` object is a LanguageTool result. The
    # `_build_issue` helper extracts the five fields the report
    # needs, clamps them to the schema's bounds, and returns the
    # report-shaped dict. A match whose conversion raises — a
    # wildly unexpected Match shape from a future LanguageTool
    # release — is skipped rather than aborting the whole
    # section, on the theory that a partial issue list is more
    # useful than no issue list.
    issues = []
    for match in matches:
        try:
            issues.append(_build_issue(match))
        except Exception as exc:
            log_warning(
                f"grammar: skipped one match that could not be "
                f"converted ({exc})"
            )
            continue

    issue_count = len(issues)

    # ---- 7. Clamp the top-level issue count ----
    # The schema's `max: 100000` on `issueCount` is far above
    # anything a real article would produce, but a pathological
    # input — a file of repeated tokens — could in principle
    # exceed it. Clamping here rather than at the schema is
    # what keeps the report saveable in every case.
    if issue_count > _MAX_ISSUE_COUNT:
        issues = issues[:_MAX_ISSUE_COUNT]
        issue_count = _MAX_ISSUE_COUNT

    # ---- 8. Classify the status ----
    status = _classify_status(
        issue_count=issue_count,
        max_issues=max_issues,
    )

    # ---- 9. Build and return ----
    return {
        "issueCount": int(issue_count),
        "issues": issues,
        "status": status,
    }


# =============================================================================
#  Private: LanguageTool loader
# =============================================================================

def _load_language_tool():
    """
    Load the LanguageTool instance, caching it at module level.
    Returns the instance, or `None` if the load failed.

    The first call in a process attempts the load. If the load
    succeeds, the instance is stored in `_language_tool_instance`
    and subsequent calls return it directly. If the load fails —
    Java is not installed, the language-tool-python package
    cannot find its jar, the JVM boot times out — the failure is
    logged at warning level and `_language_tool_instance` is set
    to `False`, which tells subsequent calls not to retry. See
    the module docstring's "Graceful degradation" section for
    the rationale.

    The import of `language_tool_python` is done lazily inside
    this function rather than at module scope. Two reasons:

      1. A process that never runs the grammar check — a
         search-only pipeline stage, a test that exercises only
         the keyword validator — pays nothing for the import.
         The package pulls in a moderately heavy dependency
         graph and constructing its client is not free.

      2. The import itself can fail in unusual environments (a
         stripped-down embedded Python without the package's
         wheel-resolved dependencies). Wrapping the import in
         the same try/except that wraps the constructor gives
         that failure the same graceful degradation as the
         constructor failing.

    Never raises.

    Returns:
        The loaded `LanguageTool` instance, or `None`.
    """
    global _language_tool_instance

    if _language_tool_instance is False:
        # A previous load failed. Do not retry.
        return None
    if _language_tool_instance is not None:
        # Already loaded.
        return _language_tool_instance

    try:
        import language_tool_python

        log_debug(
            f"grammar: starting LanguageTool server for "
            f"'{_LANGUAGE_TOOL_LANGUAGE}' (first use in this "
            f"process; this may take several seconds)"
        )
        tool = language_tool_python.LanguageTool(
            _LANGUAGE_TOOL_LANGUAGE
        )
        _language_tool_instance = tool
        log_debug("grammar: LanguageTool server ready")
        return tool
    except Exception as exc:
        log_warning(
            f"grammar: could not start LanguageTool "
            f"({exc}); the grammar check will be skipped for "
            f"this run. Ensure a Java runtime is installed."
        )
        _language_tool_instance = False
        return None


# =============================================================================
#  Private: Markdown stripping
# =============================================================================

def _strip_markdown(text: str) -> str:
    """
    Strip Markdown markup from the article and return the plain
    prose.

    Same substitution order as the four preceding validators'
    strippers — see `seo_check.py`'s `_strip_markdown_for_prose`
    for the reasoning. The five strippers overlap but are not
    identical; see the module docstring for the local-declaration
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
#  Private: match-to-issue conversion
# =============================================================================

def _get_match_attr(match, *names, default=None):
    """
    Return the first non-`None` attribute from a list of
    candidate attribute names on a LanguageTool `Match` object.

    The helper exists because the LanguageTool Python wrapper has
    used both camelCase (`ruleId`, `errorLength`) and snake_case
    (`rule_id`, `error_length`) spellings for the same fields
    across its release history, and the pinned version's exact
    spelling is not something a static analysis pass can verify.
    Trying the candidates in order and returning the first one
    that produces a non-`None` value makes the module robust to
    that variation without a version check or a fallback regex.

    The `default` argument is returned when every candidate is
    absent or `None`. A caller that wants to distinguish "the
    attribute is missing" from "the attribute is present and
    `None`" does not need to — LanguageTool never sets a
    `None` value on a Match field, so absent and `None` are the
    same case in practice.

    Never raises. A `Match` object that cannot be introspected —
    an object that raises on every `getattr` — produces the
    default rather than an exception.

    Args:
        match:  The object to inspect.
        *names: The candidate attribute names, in preference
                order.
        default: The fallback value when no candidate is found.

    Returns:
        The first non-`None` attribute value, or `default`.
    """
    for name in names:
        try:
            value = getattr(match, name)
            if value is not None:
                return value
        except Exception:
            continue
    return default


def _build_issue(match) -> dict:
    """
    Convert a LanguageTool `Match` object into the report's
    `GrammarIssue` shape.

    The five fields extracted:

      * `ruleId`       — the LanguageTool rule identifier, e.g.
                         `EN_QUOTES` or
                         `UPPERCASE_SENTENCE_START`. Truncated to
                         200 characters, defaulted to the
                         literal `"UNKNOWN"` when the match has
                         no rule id. The default keeps the
                         schema's `minlength: 1` satisfied.

      * `message`      — the human-readable description of the
                         issue. Truncated to 2000 characters,
                         defaulted to a generic message when the
                         match has none.

      * `offset`       — the 0-based character index into the
                         text the check ran against. Clamped to
                         the range `[0, _MAX_OFFSET]`.

      * `length`       — the length of the offending span, in
                         characters. Clamped to the range
                         `[0, _MAX_LENGTH]`.

      * `replacements` — the ordered list of suggested
                         replacement strings. Non-string
                         entries in the list are stringified so
                         the JSON output is well-formed; an
                         entry that cannot be stringified at all
                         is dropped.

    Never raises for a LanguageTool-produced Match. A match whose
    fields do not match any of the expected names produces an
    issue with a `"UNKNOWN"` rule id, a generic message, and
    zero-valued positions — a well-formed but uninformative
    entry. The caller (`validate_grammar`) treats an exception
    from this function as "skip this match" and continues.

    Args:
        match: A LanguageTool `Match` object.

    Returns:
        A report-shaped `GrammarIssue` dict.
    """
    # ---- ruleId ----
    raw_rule_id = _get_match_attr(
        match, "ruleId", "rule_id", default=""
    )
    rule_id = str(raw_rule_id).strip() or "UNKNOWN"
    if len(rule_id) > _MAX_RULE_ID_LENGTH:
        rule_id = rule_id[:_MAX_RULE_ID_LENGTH].rstrip()

    # ---- message ----
    raw_message = _get_match_attr(
        match, "message", default=""
    )
    message = str(raw_message).strip() or "Grammar issue."
    if len(message) > _MAX_MESSAGE_LENGTH:
        message = message[:_MAX_MESSAGE_LENGTH].rstrip()

    # ---- offset ----
    raw_offset = _get_match_attr(
        match, "offset", default=0
    )
    try:
        offset = int(raw_offset)
    except (TypeError, ValueError):
        offset = 0
    offset = max(0, min(_MAX_OFFSET, offset))

    # ---- length ----
    # LanguageTool's wrapper has used `errorLength`,
    # `error_length`, and plain `length` for this field over its
    # release history; try all three in that preference order.
    raw_length = _get_match_attr(
        match, "errorLength", "error_length", "length", default=0
    )
    try:
        length = int(raw_length)
    except (TypeError, ValueError):
        length = 0
    length = max(0, min(_MAX_LENGTH, length))

    # ---- replacements ----
    raw_replacements = _get_match_attr(
        match, "replacements", default=[]
    )
    replacements = []
    if isinstance(raw_replacements, (list, tuple)):
        for entry in raw_replacements:
            try:
                replacements.append(str(entry))
            except Exception:
                # An entry that cannot be stringified at all —
                # an object whose `__str__` raises — is dropped.
                # The alternative would be to abort the whole
                # issue for one bad suggestion, which is worse.
                continue
    # (If `raw_replacements` was not a list at all, the
    # resulting empty list is the correct default.)

    return {
        "ruleId": rule_id,
        "message": message,
        "offset": offset,
        "length": length,
        "replacements": replacements,
    }


# =============================================================================
#  Private: status classification
# =============================================================================

def _classify_status(
    issue_count: int,
    max_issues: int,
) -> str:
    """
    Classify the grammar section as `'good'`, `'warning'`, or
    `'fail'`. See the module docstring for the reasoning.

    Summary of the rule, with a positive threshold:

      * `'good'`    — `issue_count` is at or below the
                      threshold.

      * `'warning'` — `issue_count` is at most twice the
                      threshold.

      * `'fail'`    — anything else.

    A non-positive threshold disables the "good" band: every
    article with any issue is at least a warning, and the
    warning band's upper edge collapses to zero, so every
    article with any issue is a fail. That is the correct
    behavior for a caller that has explicitly configured "no
    grammar issues permitted".

    A threshold of exactly 0 with an `issue_count` of 0 returns
    `'good'` — the only value in the intersection of "at or below
    the threshold" and "there is something to classify".

    Args:
        issue_count: The number of grammar issues found.
        max_issues:  The threshold for the `'good'` band.

    Returns:
        One of `'good'`, `'warning'`, `'fail'`.
    """
    if max_issues > 0:
        if issue_count <= max_issues:
            return "good"
        if issue_count <= 2 * max_issues:
            return "warning"
        return "fail"

    # Threshold is zero or negative: no tolerance band.
    if issue_count <= 0:
        return "good"
    return "fail"


# =============================================================================
#  Private: empty-result builder
# =============================================================================

def _empty_result() -> dict:
    """
    Return the grammar section for an empty article, or for a
    degraded run where the LanguageTool check could not be
    performed.

    The count is zero, the issues list is empty, and the status
    is `'good'` — the validator found no issues, and the reason
    it found none (an empty input, or a check that could not
    run) is either self-evident or recorded in the pipeline's
    log. See the module docstring's "Graceful degradation"
    section for why the degraded case reports `'good'` rather
    than a distinct status.

    The function is the single source of truth for the shape;
    every branch of `validate_grammar` that produces a
    zero-issues result returns this value directly, so the
    branches cannot drift apart.
    """
    return {
        "issueCount": 0,
        "issues": [],
        "status": "good",
    }


# =============================================================================
#  Default export
# =============================================================================

__all__ = [
    "validate_grammar",
]