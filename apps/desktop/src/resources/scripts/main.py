#!/usr/bin/env python3
"""
main.py — Subcommand dispatcher for the WriteSpeare automation pipeline.

The single executable entry point for every Python automation
operation. The Electron main process spawns this script once per
operation — one invocation runs one pipeline stage — and reads the
`::ROOKIE::` markers this process writes to stdout.

Subcommands:

    search    Search the web for a topic's candidate sources.
    extract   Fetch and extract selected source pages into doc files.
    write     Generate an article via the DeepSeek automation.
    validate  Run the six-validator suite against an article.
    export    Write an article to a file (.docx or .md).

Each invocation handles exactly ONE subcommand. There is no queue,
no batching, and no plan file — the orchestration that ROOKIE's
main.py performed (loading a plan, building a task queue, spawning
one child per site, iterating over rows) does not exist here,
because WriteSpeare's operations are one-shot: the Electron main
process calls `window.electronAPI.research.search(...)` and the IPC
handler spawns one `main.py search` process; the user clicks
"Fetch Selected" and the IPC handler spawns one `main.py extract`
process; and so on.

Architecture — why this file uses LAZY imports inside its subcommand
handlers, not top-level imports:

    This file is created BEFORE the seven feature modules it
    dispatches to exist on disk. `research/google_search.py` lands
    in the next step, `research/extract_dispatch.py` in a later
    session, `writer/deepseek_writer.py` after that, and so on.

    If those imports were at the top of this file, then importing
    main.py at all — even to run `python main.py search` for a
    module that DOES exist — would fail because some OTHER module
    (say, `writer/deepseek_writer.py`) does not exist yet. Python
    imports are eager: every name bound by an import statement is
    resolved at the moment the statement executes.

    The lazy-import pattern — do the import inside the handler
    function that actually needs the module — means main.py loads
    cleanly today and only fails when the user invokes a subcommand
    whose module does not yet exist. When that happens, the failure
    is a clean, actionable `ModuleNotFoundError` caught by the
    handler's try/except and reported as a specific message
    ("search module not available: ...") rather than as a
    Python-level traceback out of a top-level import.

    This is a deliberate departure from how the TypeScript side of
    this codebase handles forward references (where an import of a
    not-yet-created file is a compile-time error that resolves the
    moment the file is created). The two approaches are appropriate
    to their two languages: TypeScript's static analysis reports a
    missing module at compile time and the error goes away on its
    own when the file appears; Python has no such compile step, so
    a top-level import of a missing module is a runtime crash on
    every invocation. Lazy imports move the runtime failure to the
    one subcommand that actually needs the missing module.

The sys.path bootstrap block:

    Every WriteSpeare Python entry point and every feature script
    begins with the same four-line bootstrap:

        _SCRIPT_DIR = Path(__file__).resolve().parent
        if str(_SCRIPT_DIR) not in sys.path:
            sys.path.insert(0, str(_SCRIPT_DIR))

    This is required because the packaged app runs the embedded
    Python distribution, whose `python3xx._pth` file overrides
    sys.path and does NOT automatically prepend the script's own
    directory. Without the bootstrap, `from core.output import ...`
    fails with `ModuleNotFoundError` in the packaged build only —
    the symptom is a script that runs correctly from a developer's
    terminal and fails the moment the .exe launches it.

    In dev (a system Python running `python main.py`), the
    directory is already on sys.path, so the check is a no-op. The
    block is defensive and costs nothing when it is not needed.

The TASK_START / TASK_END markers:

    This file is the ONLY place that emits TASK_START and TASK_END.
    Feature modules emit their stage-specific progress markers
    (SEARCH_PROGRESS, WRITER_PROGRESS, etc.) and their interaction
    markers (CAPTCHA_REQUIRED, MANUAL_ACTION), but the two task
    boundary markers are owned here — see the "Ownership rules"
    section of core/output.py's module docstring.

    TASK_START is emitted before the subcommand handler runs.
    TASK_END is emitted after it returns, in a `finally` block, so
    it fires on every exit path — clean return, sys.exit(99),
    KeyboardInterrupt, or an unhandled exception. The payload of
    TASK_END carries a `status` field that classifies the outcome:
    "success" / "skipped" / "aborted" / "failed". The Electron
    listener bridge reads that status to update the task's badge in
    the automation store.

    Both markers are gated on `is_control_mode()`. When the script
    is run from a terminal for debugging (no --control-mode flag),
    the markers are not emitted and the log output is clean.

Exit-code classification:

    The subcommand handlers return an integer exit code. This file
    classifies that code into a status string for the TASK_END
    marker:

        exit 0                      → "success"
        exit 99 (EXIT_SKIPPED)      → "skipped"
        exit 100 (EXIT_STOPPED)     → "aborted"
        exit 101 (EXIT_CAPTCHA_SKIP)→ "skipped"
        any other non-zero          → "failed"

    The classification is a pure function of the exit code. It does
    not inspect the subcommand's return value beyond its integer
    form, and it does not need to know what the subcommand did —
    every subcommand uses the same three special codes (via
    core.output's exit constants) and returns 0 for success.

What this file does NOT do:

    - It does not launch Chrome. Every subcommand that needs a
      browser gets it via core.browser.connect_to_chrome(port).
      The Chrome process itself is launched by the Electron main
      process (chromeLauncher.ts) and this script connects to it.
      When run standalone from a terminal, a caller that has
      already launched Chrome on the passed --port is expected.

    - It does not read a config file. The ROOKIE launcher read a
      run-config.json that carried a plan path, filters, and a
      captcha policy. WriteSpeare's operations take their arguments
      on the command line; the Electron IPC handler supplies them
      per invocation.

    - It does not iterate. One process handles one operation.

Dependencies: Python stdlib + the packages declared in
requirements.txt. This file imports `core.control_mode` and
`core.output` eagerly (they exist); it imports every feature module
lazily (some do not exist yet).
"""

import argparse
import sys
from pathlib import Path


# =============================================================================
#  sys.path bootstrap — MUST run BEFORE any `from core.* import ...`
# =============================================================================
# Ensure this script's own directory is on sys.path so the sibling
# `core/`, `research/`, `writer/`, `validation/`, and `export/`
# packages are importable, regardless of how Python was launched.
#
# WHY THIS IS NEEDED:
#   In dev, `python main.py` runs under a system Python, which
#   automatically prepends the script's own directory to sys.path[0].
#   In the packaged app, the embedded Python distribution
#   (resources\python\python.exe) ships with a `python3xx._pth` file
#   that OVERRIDES sys.path entirely and does NOT prepend the
#   script's directory. Without this bootstrap, `from core.output
#   import ...` fails with ModuleNotFoundError in the packaged
#   build only — the exact symptom seen when running automation
#   from the .exe.
#
# Every feature script that is spawned as a subprocess of main.py
# carries the identical bootstrap for the same reason; the two are
# redundant in the strict sense, but the bootstrap in each script
# means a script run on its own (a developer typing `python
# research/google_search.py ...` from a terminal) works too.

_SCRIPT_DIR = Path(__file__).resolve().parent
if str(_SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPT_DIR))


# =============================================================================
#  Core imports (eager — these modules exist)
# =============================================================================
#
# These two modules are the shared plumbing every subcommand needs.
# They are imported at the top of the file because they exist and
# because every subcommand uses them.

from core.control_mode import (
    set_control_mode,
    is_control_mode,
)
from core.output import (
    emit_marker,
    MARKER_TASK_START,
    MARKER_TASK_END,
    EXIT_SKIPPED,
    EXIT_STOPPED,
    EXIT_CAPTCHA_SKIP,
)


# =============================================================================
#  Exit-code classification
# =============================================================================

def _classify_status(exit_code: int) -> str:
    """
    Map a subcommand's integer exit code to a status string for the
    TASK_END marker payload.

    The mapping is documented in the module docstring. The function
    is pure — it depends only on its argument — so the TASK_END
    status is reproducible from the exit code alone, without any
    hidden state.
    """
    if exit_code == 0:
        return "success"
    if exit_code == EXIT_SKIPPED:
        return "skipped"
    if exit_code == EXIT_STOPPED:
        return "aborted"
    if exit_code == EXIT_CAPTCHA_SKIP:
        return "skipped"
    return "failed"


# =============================================================================
#  Subcommand handlers
# =============================================================================
#
# Every handler follows the same shape:
#
#   1. Import the feature module it needs, lazily, inside a try/except
#      ImportError. A module that does not yet exist (because a later
#      session has not created it) produces a clean diagnostic and an
#      exit code of 1, rather than a Python traceback from a top-level
#      import.
#
#   2. Extract the arguments it needs from the parsed namespace, doing
#      any light parsing (splitting a comma-separated list, for example).
#
#   3. Call the feature module's `run_*` function with keyword arguments
#      and return its integer exit code.
#
# The feature module's `run_*` function is expected to be a
# single-purpose callable that performs the stage's work and returns
# an int. It is NOT expected to be a `main()` function that reads
# sys.argv — main.py owns argument parsing.

def _run_search(args: argparse.Namespace) -> int:
    """
    Handle the `search` subcommand.

    Chooses between the Google and DuckDuckGo backends based on
    `--engine`. Both backends expose the same `run_search` signature
    so the choice is a one-line import, not a branch that duplicates
    the calling code.
    """
    try:
        if args.engine == "duckduckgo":
            from research.duckduckgo_search import run_search
        else:
            from research.google_search import run_search
    except ImportError as exc:
        print(
            f"ERROR: search module not available: {exc}",
            file=sys.stderr,
            flush=True,
        )
        return 1

    # Split the comma-separated keywords string into a list,
    # dropping empty segments. An empty --keywords flag produces
    # an empty list, which the feature module treats as "no user
    # keywords provided" and proceeds with search-only.
    keywords = []
    if args.keywords:
        keywords = [
            k.strip() for k in args.keywords.split(",") if k.strip()
        ]

    return run_search(
        query=args.query,
        keywords=keywords,
        max_results=args.max_results,
        topic_id=args.topic_id,
        port=args.port,
    )


def _run_extract(args: argparse.Namespace) -> int:
    """
    Handle the `extract` subcommand.

    The URL list is passed as a single comma-separated string on the
    command line (matching the shape the Electron IPC handler
    constructs from the user's checkbox selection) and is split here
    into a Python list.
    """
    try:
        from research.extract_dispatch import run_extract
    except ImportError as exc:
        print(
            f"ERROR: extraction module not available: {exc}",
            file=sys.stderr,
            flush=True,
        )
        return 1

    urls = [
        u.strip() for u in args.urls.split(",") if u.strip()
    ]
    if not urls:
        print(
            "ERROR: extract requires at least one URL (--urls)",
            file=sys.stderr,
            flush=True,
        )
        return 1

    return run_extract(
        urls=urls,
        topic_id=args.topic_id,
        port=args.port,
    )


def _run_write(args: argparse.Namespace) -> int:
    """
    Handle the `write` subcommand.

    The DeepSeek automation reads the doc files from `--docs-dir`,
    renders the named `--prompt-file`, and drives the DeepSeek chat
    to produce an article.
    """
    try:
        from writer.deepseek_writer import run_write
    except ImportError as exc:
        print(
            f"ERROR: writer module not available: {exc}",
            file=sys.stderr,
            flush=True,
        )
        return 1

    return run_write(
        topic_id=args.topic_id,
        docs_dir=args.docs_dir,
        prompt_file=args.prompt_file,
        port=args.port,
    )


def _run_validate(args: argparse.Namespace) -> int:
    """
    Handle the `validate` subcommand.

    The validator runner loads the article from `--article`, reads
    the source documents from `--sources-dir` for the originality
    check, runs all six validators, and writes the aggregate report.
    """
    try:
        from validation.validate_all import run_validate
    except ImportError as exc:
        print(
            f"ERROR: validation module not available: {exc}",
            file=sys.stderr,
            flush=True,
        )
        return 1

    return run_validate(
        article_path=args.article,
        sources_dir=args.sources_dir,
    )


def _run_export(args: argparse.Namespace) -> int:
    """
    Handle the `export` subcommand.

    Chooses between the .docx and .md writers based on `--format`.
    Both writers expose the same `run_export` signature so the
    choice is a one-line import, not a duplicated call.
    """
    try:
        if args.format == "docx":
            from export.export_docx import run_export
        elif args.format == "md":
            from export.export_md import run_export
        else:
            # argparse's `choices=` already constrains --format to
            # the two legal values, so this branch is unreachable
            # in practice. The explicit error is defensive — a
            # future session that adds a third format to the
            # argparse choices but forgets to add the corresponding
            # import branch lands here with a clear message rather
            # than a NameError on an undefined `run_export`.
            print(
                f"ERROR: unsupported export format: {args.format}",
                file=sys.stderr,
                flush=True,
            )
            return 1
    except ImportError as exc:
        print(
            f"ERROR: export module not available: {exc}",
            file=sys.stderr,
            flush=True,
        )
        return 1

    return run_export(
        article_path=args.article,
        output_path=args.output,
    )


# =============================================================================
#  Argument parser
# =============================================================================

def _build_parser() -> argparse.ArgumentParser:
    """
    Build the argparse tree.

    The global flags (--control-mode, --port) are declared on a
    shared `parents` parser rather than on the top-level parser
    alone. This lets both of the following forms work:

        python main.py --control-mode search --query "..."
        python main.py search --query "..." --control-mode

    The second form is what the Electron IPC handler will use (it
    appends `--control-mode` as the last argument to every spawn),
    so the parents mechanism is load-bearing, not cosmetic.
    """
    # ---- Shared (global) flags ----
    global_flags = argparse.ArgumentParser(add_help=False)
    global_flags.add_argument(
        "--control-mode",
        action="store_true",
        help=(
            "Enable stdin relay + ::ROOKIE:: marker emission. "
            "Set by the Electron GUI; omitted for manual runs."
        ),
    )
    global_flags.add_argument(
        "--port",
        type=int,
        default=9222,
        help="Chrome CDP debug port (default: 9222).",
    )

    # ---- Top-level parser ----
    parser = argparse.ArgumentParser(
        prog="main.py",
        description=(
            "WriteSpeare automation dispatcher. One invocation runs "
            "one pipeline operation. The Electron main process "
            "spawns this script once per operation and reads its "
            "::ROOKIE:: markers on stdout."
        ),
    )
    subparsers = parser.add_subparsers(
        dest="command",
        required=True,
        metavar="{search,extract,write,validate,export}",
    )

    # ---- search ----
    search = subparsers.add_parser(
        "search",
        parents=[global_flags],
        help="Search the web for a topic's candidate sources.",
    )
    search.add_argument(
        "--query",
        required=True,
        help="The topic title to search for.",
    )
    search.add_argument(
        "--keywords",
        default="",
        help="Comma-separated list of user keywords (optional).",
    )
    search.add_argument(
        "--engine",
        choices=["google", "duckduckgo"],
        default="google",
        help="Search engine to use (default: google).",
    )
    search.add_argument(
        "--max-results",
        type=int,
        default=20,
        help="Maximum number of candidate URLs to collect (default: 20).",
    )
    search.add_argument(
        "--topic-id",
        default="",
        help="The topic's id, included in the emitted markers.",
    )
    search.set_defaults(handler=_run_search)

    # ---- extract ----
    extract = subparsers.add_parser(
        "extract",
        parents=[global_flags],
        help="Fetch and extract source pages into doc files.",
    )
    extract.add_argument(
        "--topic-id",
        required=True,
        help="The topic's id, used to name the output folder.",
    )
    extract.add_argument(
        "--urls",
        required=True,
        help="Comma-separated list of URLs to fetch and extract.",
    )
    extract.set_defaults(handler=_run_extract)

    # ---- write ----
    write = subparsers.add_parser(
        "write",
        parents=[global_flags],
        help="Generate an article via the DeepSeek automation.",
    )
    write.add_argument(
        "--topic-id",
        required=True,
        help="The topic's id, included in the emitted markers.",
    )
    write.add_argument(
        "--docs-dir",
        required=True,
        help="Folder containing the source .md doc files.",
    )
    write.add_argument(
        "--prompt-file",
        default="default.md",
        help="The prompt template to render (default: default.md).",
    )
    write.set_defaults(handler=_run_write)

    # ---- validate ----
    validate = subparsers.add_parser(
        "validate",
        parents=[global_flags],
        help="Run the six-validator suite against an article.",
    )
    validate.add_argument(
        "--article",
        required=True,
        help="Path to the article .md file to validate.",
    )
    validate.add_argument(
        "--sources-dir",
        required=True,
        help="Folder containing the source docs (for originality).",
    )
    validate.set_defaults(handler=_run_validate)

    # ---- export ----
    export = subparsers.add_parser(
        "export",
        parents=[global_flags],
        help="Write an article to a file.",
    )
    export.add_argument(
        "--format",
        choices=["docx", "md"],
        required=True,
        help="The output format.",
    )
    export.add_argument(
        "--article",
        required=True,
        help="Path to the article .md file to export.",
    )
    export.add_argument(
        "--output",
        required=True,
        help="Path to write the exported file to.",
    )
    export.set_defaults(handler=_run_export)

    return parser


# =============================================================================
#  Entry point
# =============================================================================

def main() -> int:
    """
    Parse arguments, dispatch, emit task markers, and return an exit
    code.

    The `finally` block is what guarantees TASK_END is always
    emitted — even when the subcommand handler calls sys.exit()
    internally (which `core.output.manual_action_required` does on
    a user Skip or Stop), and even when an unexpected exception
    escapes. The status field of the emitted TASK_END reflects the
    final classification of the exit code.
    """
    parser = _build_parser()
    args = parser.parse_args()

    # Enable control mode immediately — before any handler runs —
    # so that the reader thread (in core.control_mode) is ready to
    # receive Skip/Stop commands from the moment the first
    # checkpoint is reached.
    set_control_mode(args.control_mode)

    # ---- Build the identity payload for the task markers ----
    # The payload carries whatever subset of {operation, topic_id,
    # article, engine, format} the invoked subcommand provided. The
    # Electron listenerBridge reads these to route the task to the
    # correct store entry. A field that the current subcommand did
    # not receive is omitted entirely rather than set to an empty
    # string — a listener that checks `payload.topicId !== undefined`
    # gets an unambiguous answer, and a listener that would display
    # the field in a UI does not show a blank placeholder.
    identity = {"operation": args.command}
    for attr in ("topic_id", "article", "engine", "format"):
        value = getattr(args, attr, None)
        if value:
            identity[attr] = value

    if is_control_mode():
        emit_marker(MARKER_TASK_START, identity)

    # ---- Dispatch ----
    # The defaults are chosen so that if the try block exits before
    # assigning a new exit_code (a KeyboardInterrupt arriving on the
    # very first line, say), the finally block still emits a
    # well-formed TASK_END with a sensible status.
    exit_code = 1
    status = "failed"

    try:
        exit_code = args.handler(args)
        status = _classify_status(exit_code)

    except SystemExit as exc:
        # A subcommand — or a call to core.output.manual_action_required
        # inside it — invoked sys.exit(N). sys.exit raises SystemExit,
        # which is NOT caught by `except Exception` (SystemExit
        # inherits from BaseException, not Exception), so it needs
        # its own handler here.
        #
        # `exc.code` is documented to be either an int (the value
        # passed to sys.exit) or None (from a bare `sys.exit()`),
        # or a string (from `sys.exit("message")`). The isinstance
        # check narrows it to the integer case; the None and string
        # cases both map to 1.
        exit_code = exc.code if isinstance(exc.code, int) else 1
        status = _classify_status(exit_code)

    except KeyboardInterrupt:
        # A user pressing Ctrl+C on a manual (non-control-mode) run.
        # The status "aborted" mirrors what EXIT_STOPPED produces for
        # a user-initiated stop through the GUI.
        print(
            "🛑 Interrupted by user.",
            file=sys.stderr,
            flush=True,
        )
        exit_code = 1
        status = "aborted"

    except Exception as exc:
        # Any other exception — a bug in a feature module, a network
        # failure that escaped its own handling, a bad argument that
        # argparse's type checks did not catch. Print the message
        # AND the traceback (a bug needs the traceback to be
        # diagnosable), set the status to "failed", and continue to
        # the finally block so TASK_END still goes out.
        print(
            f"❌ Unhandled exception in subcommand '{args.command}': {exc}",
            file=sys.stderr,
            flush=True,
        )
        import traceback
        traceback.print_exc()
        exit_code = 1
        status = "failed"

    finally:
        # TASK_END is emitted unconditionally in control mode,
        # regardless of which exception path (if any) was taken.
        # The identity payload is merged with the status field so
        # the listener receives a single self-describing record.
        if is_control_mode():
            emit_marker(
                MARKER_TASK_END,
                {**identity, "status": status},
            )

    return exit_code


# =============================================================================
#  Bootstrap
# =============================================================================

if __name__ == "__main__":
    sys.exit(main())