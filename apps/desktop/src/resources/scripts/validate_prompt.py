#!/usr/bin/env python3
"""
validate_prompt.py — standalone Jinja2 prompt-template validator.

Reads a candidate prompt template from disk, attempts to construct
a Jinja2 `Template` from its contents and render it with a small
set of dummy variables, and reports the outcome as a single JSON
line on stdout. Exits with 0 when the template is valid, 1 when
it is not.

This script is the validator the desktop app spawns when the user
clicks Save in the Prompts editor. See `promptsIPC.ts`'s
`prompts:validate` handler for the caller side: it writes the
candidate content to a temporary file, invokes this script with
the temp file's path as the single argument, reads the script's
last non-empty stdout line as JSON, and returns the parsed result
to the renderer.

Command-line contract
---------------------

    python validate_prompt.py <prompt-file-path>

Arguments:

    <prompt-file-path>  — the absolute path to the file to
                          validate. Must be a file that exists
                          and is readable.

Stdout on success (exit code 0):

    {"valid": true}

Stdout on failure (exit code 1):

    {"valid": false, "error": "<message>", "line": <N>}

    `line` is a 1-based line number when the error carries one
    (Jinja2's `TemplateSyntaxError` for an unclosed block, a
    malformed `{% %}` tag, an unknown filter, and so on all
    carry a `.lineno`). When no line number is available — a
    file-not-found error, an encoding failure, a generic
    exception — `line` is 0. The IPC handler treats 0 as
    "no line number", which is what the renderer expects when
    it renders the error banner without a line anchor.

Stdout on usage error (exit code 1):

    {"valid": false, "error": "Usage: validate_prompt.py <prompt-file-path>", "line": 0}

    A missing argument, or more than one argument, produces this
    line. The script does not read stdin; it does not offer any
    other modes.

The script never prints anything on stdout EXCEPT the final JSON
line. A traceback, if one ever escapes the top-level handler,
goes to stderr; the IPC handler's parse takes the LAST non-empty
stdout line, so stderr output cannot confuse the parse.

Why a standalone script and not inline Python
---------------------------------------------

    The desktop main process is Node. Jinja2 is a Python library.
    Calling Jinja2 from the main process therefore requires
    spawning Python. The alternative — reimplementing Jinja2's
    parser in TypeScript — would be a second parser that would
    inevitably disagree with the real one on the day a template
    used an edge-case construct. The standalone script keeps the
    validation authoritative: it uses the same Jinja2 that the
    writer step uses when it renders the template for real.

    The script is deliberately tiny (a single argument, a single
    output line, no state) so that the spawn cost — a few hundred
    milliseconds of Python startup — is the only cost. It does
    not import `core.*`, does not import any WriteSpeare module,
    and does not depend on the pipeline's layout. It could be run
    by hand from a terminal as a diagnostic.

Why the dummy variables are a superset of the real ones
-------------------------------------------------------

    A Jinja2 template that references a variable the renderer
    did not supply renders the variable as an empty string (the
    default `Undefined` class). The syntax check would therefore
    pass a template that says `{{ nonexistent_variable }}` — but
    in practice, the writer supplies a fixed and known set of
    variables, and a template that references a name outside that
    set is a user error the validator should catch.

    This script does NOT catch that class of error. Catching it
    would require a hard-coded whitelist of variable names, and a
    whitelist would drift the moment the writer's variable set
    changed. The validation-on-save contract the plan describes
    is "is this valid Jinja2", not "does this reference a
    variable the writer will supply" — the two are different
    questions, and this script answers only the first.

    The dummy variables below exist so that templates which use
    the standard variables — the ones the writer DOES supply —
    render without undefined-value surprises during the check.
    Supplying them costs nothing and makes the check's output
    more predictable for the common case. A template that
    references an unknown name still passes, because Jinja2's
    default undefined behavior is to substitute empty string.

Why the `line` field is 0 when no line is available
---------------------------------------------------

    The renderer's error banner reads `line` and formats the
    message as "Line N: <error>" when N > 0, or just "<error>"
    when N == 0. Rendering "Line 0:" for an encoding error or a
    file-not-found would be misleading. Using 0 as the sentinel
    is simpler than a nullable field — the JSON always carries
    the field, the renderer always reads it, and the display
    logic is a single comparison.

Why no `__all__`
----------------

    This is a runnable script, not an importable module. Nothing
    imports from it. `__all__` is a name for package authors to
    publish a public surface; a script that runs and exits has
    no public surface to publish.

Why no `if __name__ == "__main__":` guard
------------------------------------------

    The file has one purpose: to be run as a script. There is no
    case where it would be imported by another module. The guard
    would be dead code — the script always runs, and the `main`
    function always executes. The alternative — wrapping the
    body in a `main()` and calling it under the guard — adds a
    function indirection for no benefit. The direct top-level
    form is the honest shape for what this file is.
"""

import json
import sys
from pathlib import Path

from jinja2 import Template
from jinja2.exceptions import TemplateError


# =============================================================================
#  Dummy variables
# =============================================================================
#
#  The variable names the writer step supplies when it renders a
#  prompt for real. Providing them to the validator's render call
#  means a template that uses any of them renders as it would in
#  production, rather than substituting an empty string for the
#  supplied value. That property matters for one specific case:
#  a template that does arithmetic or string manipulation on a
#  variable — `{{ word_count * 2 }}`, `{{ title | upper }}` —
#  behaves the same under the dummy render as it would under a
#  real render. A template that does NOT reference any of these
#  variables is also fine; the dummy render simply ignores the
#  unused ones.
#
#  The values are chosen to be representative in type:
#
#    title         — a non-empty string
#    keywords      — a list of strings
#    word_count    — an integer
#    tone          — a non-empty string
#    sources       — a list of strings (the source file names)
#    source_count  — an integer
#    topic_id      — a non-empty string
#
#  Every name is a real variable the writer supplies. No name is
#  invented. A future session that adds a variable to the writer
#  should add a corresponding entry here in the same change; the
#  cost of adding it is one line, and the benefit is that the
#  validator stays in step with the pipeline it validates against.

_DUMMY_VARIABLES: dict[str, object] = {
    "title": "Sample Topic Title",
    "keywords": ["sample keyword one", "sample keyword two"],
    "word_count": 1200,
    "tone": "blog-post",
    "sources": ["001-sample-source.md", "002-sample-source.md"],
    "source_count": 2,
    "topic_id": "sample-topic-id",
}


# =============================================================================
#  Result emission
# =============================================================================

def _emit(result: dict) -> None:
    """
    Write a single JSON line to stdout.

    The output is flushed immediately so the parent process — the
    desktop main process's `promptsIPC.ts` handler, which reads
    the script's stdout through a pipe — receives the line the
    moment it is written, without waiting for the process to exit.
    Without the flush, a parent that reads stdout on the `exit`
    event would still get the line (the pipe buffer is flushed on
    process termination), but a parent that reads stdout line by
    line would see nothing until the process was already gone.
    The explicit flush makes the behavior independent of how the
    parent reads.

    The serialization uses compact separators (`(',', ':')`) so
    the line stays on one line. The default `json.dumps` output
    uses `', '` and `': '` separators, which are harmless — the
    line is still a single line — but the compact form makes the
    output byte-for-byte predictable for a caller that wants to
    compare it against an expected string, and it is what every
    other structured output in this codebase uses.

    `ensure_ascii=False` preserves any non-ASCII characters in an
    error message literally rather than escaping them to
    `\\uXXXX`. A Jinja2 error that names a filter with a non-ASCII
    character (rare but possible) would remain readable.

    The function is total — it cannot raise for any input the
    caller passes, because `json.dumps` on a dict of strings and
    numbers cannot fail.
    """
    sys.stdout.write(
        json.dumps(result, separators=(",", ":"), ensure_ascii=False)
    )
    sys.stdout.write("\n")
    sys.stdout.flush()


# =============================================================================
#  Error classification
# =============================================================================

def _line_number_of(exc: BaseException) -> int:
    """
    Return the 1-based line number an exception carries, or 0
    when no line number is available.

    Jinja2's `TemplateSyntaxError` — the class of error raised
    for an unclosed `{% block %}`, a malformed `{{ }}`, an
    unknown filter, a stray `{% endfor %}`, and every other
    parse-time or compile-time failure — carries the source
    line as an integer attribute named `lineno`. The attribute
    is 1-based, matching the numbering the renderer's error
    banner displays.

    Other exception classes — `UnicodeDecodeError` from a file
    that is not valid UTF-8, `OSError` from a missing or
    unreadable file, `ValueError` from a pathological input —
    have no line number. The function returns 0 for those, which
    the renderer treats as "no line anchor".

    The `getattr` chain and the `isinstance` check are both
    required. `lineno` is not part of the `TemplateError` base
    class's typed surface; a plain `exc.lineno` would be a type
    error under mypy, and a `getattr(exc, 'lineno', 0)` without
    the isinstance check would return a non-integer if some
    future exception class happened to have an unrelated
    `lineno` attribute of a different type. The explicit check
    is the correct boundary.
    """
    lineno = getattr(exc, "lineno", None)
    if isinstance(lineno, int) and lineno > 0:
        return lineno
    return 0


# =============================================================================
#  Entry point
# =============================================================================

def main() -> int:
    """
    Validate the file named by `sys.argv[1]` and return the
    process exit code.

    The function is not called from anywhere; the module's body
    below executes it directly at import time. The return value
    is passed to `sys.exit`, which is what sets the process's
    exit code.

    Flow:

      1. Read `sys.argv[1]`. If it is absent — the caller
         invoked the script with no argument — emit the usage
         error and return 1.

      2. Read the file's contents. A missing file, a directory
         in the file's place, or a permissions failure raises
         an `OSError`; a non-UTF-8 file raises `UnicodeDecodeError`.
         Both are caught and reported as validation failures
         with `line: 0` — from the caller's perspective, "the
         file could not be read" and "the template is invalid"
         are the same kind of answer: the file is not usable
         as a prompt template.

      3. Attempt to construct a `Template` and render it with
         the dummy variables. `TemplateError` subclasses cover
         every failure Jinja2 can raise during construction or
         rendering — a syntax error, an unknown filter, an
         unknown test, an undefined-followed-by-operation error
         on a `StrictUndefined` (which this script does not use,
         so the class of error does not arise in practice but is
         still caught defensively).

      4. Any OTHER exception — a bug in the validator itself, a
         memory error, an unexpected import failure — is caught
         by a broad `except Exception` and reported as a
         validation failure. The alternative — letting the
         exception escape and produce a non-JSON traceback on
         stderr with a non-zero exit — would leave the IPC
         handler's JSON parse to fail on empty stdout, and the
         handler would surface a generic "validator failed"
         message. The broad catch produces a specific message
         instead, at the cost of two lines of extra code.
    """
    # ---- 1. Argument check ----
    if len(sys.argv) != 2:
        _emit(
            {
                "valid": False,
                "error": "Usage: validate_prompt.py <prompt-file-path>",
                "line": 0,
            }
        )
        return 1

    prompt_path = Path(sys.argv[1])

    # ---- 2. Read the file ----
    try:
        content = prompt_path.read_text(encoding="utf-8")
    except OSError as exc:
        _emit(
            {
                "valid": False,
                "error": f"Could not read the prompt file: {exc}",
                "line": 0,
            }
        )
        return 1
    except UnicodeDecodeError as exc:
        _emit(
            {
                "valid": False,
                "error": f"Prompt file is not valid UTF-8: {exc}",
                "line": 0,
            }
        )
        return 1

    # ---- 3. Attempt the Jinja2 parse + render ----
    try:
        template = Template(content)
        # The render is what actually triggers a full parse of the
        # template body. `Template(content)` alone performs some
        # lazy work; the render is what walks every token and
        # raises on a malformed tag, an unclosed block, or an
        # unknown filter reference.
        template.render(**_DUMMY_VARIABLES)
    except TemplateError as exc:
        _emit(
            {
                "valid": False,
                "error": str(exc) or type(exc).__name__,
                "line": _line_number_of(exc),
            }
        )
        return 1
    except Exception as exc:
        # Defensive catch — see the function docstring's step 4.
        _emit(
            {
                "valid": False,
                "error": str(exc) or type(exc).__name__,
                "line": 0,
            }
        )
        return 1

    # ---- 4. Success ----
    _emit({"valid": True})
    return 0


# =============================================================================
#  Bootstrap
# =============================================================================
#
#  The script runs `main()` immediately on import, matching the
#  convention established by every other runnable script in this
#  codebase (`main.py`, `debug_deepseek.py`). See the module
#  docstring's "Why no `if __name__ == '__main__'` guard" note
#  for the reasoning.

sys.exit(main())