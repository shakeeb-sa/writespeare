#!/usr/bin/env python3
"""
core/control_mode.py – Shared stdin-control primitives for the GUI.

Responsibilities:
    * Own the single background thread that reads stdin line-by-line.
    * Expose blocking and non-blocking read APIs for the rest of the code.
    * Provide the `checkpoint_check()` helper that feature scripts call at
      safe points to see if the user clicked Skip / Stop in the GUI.

Architecture (why a thread):
    On Windows, `select.select()` does NOT work on piped stdin — piped
    stdin is a regular file handle, not a waitable socket. The only
    portable way to do a non-blocking read on Windows is to have a
    background thread do the blocking read and hand lines off via a
    `queue.Queue`. That is what this module does.

    The reader thread is the ONLY reader of stdin in the process. Every
    other module — including `output.py`, which needs to wait for a
    "Continue" response at a captcha prompt — gets its stdin lines
    through `read_line_blocking()` or `poll_command()`. Direct
    `sys.stdin.readline()` calls elsewhere would race the reader thread
    for the same bytes, and one of the two readers would lose data.

Single-reader rule:
    Only ONE thread may read from stdin at a time. This module owns that
    thread. Every other module — including `output.py` — MUST get its
    stdin lines through `read_line_blocking()` or `poll_command()`,
    never through a direct `sys.stdin.readline()`. Otherwise two readers
    race for the same bytes and one of them loses.

Control mode flag:
    When control mode is OFF (running a child from a terminal for
    debugging), this module steps out of the way and never touches
    stdin. Calls to `read_line_blocking()` fall back to a plain
    `sys.stdin.readline()`, and `poll_command()` returns `None`
    immediately. This keeps the "manual debug" workflow identical to
    the pre-GUI behaviour: a developer running a script by hand sees
    the same prompts they always did, and no background thread is
    started that could steal the terminal's input.

Dependencies: stdlib only (`sys`, `queue`, `threading`, `typing`).

    Nothing in this module imports from the rest of the project. The
    module has no knowledge of markers, browsers, or the pipeline
    stages — it is pure stdin plumbing, and it stays that way so that
    a feature script can import it without dragging any of the heavier
    submodules into the process.
"""

import sys
import queue
import threading
from typing import Optional


# =============================================================================
#  Control-mode flag (single source of truth)
# =============================================================================

_control_mode_enabled: bool = False


def set_control_mode(enabled: bool) -> None:
    """
    Enable or disable control-mode.

    Called once at startup by `main.py` (and by every feature script
    that is launched from the GUI) with the value of the `--control-mode`
    CLI flag. When disabled, this module will not start the reader
    thread and will not intercept stdin — the debug workflow stays
    exactly as it was before the GUI existed.

    Idempotent: calling this multiple times with the same value is a
    no-op, and calling it with a different value flips the flag without
    restarting the thread (the thread, once started, stays alive for
    the life of the process).
    """
    global _control_mode_enabled
    _control_mode_enabled = bool(enabled)


def is_control_mode() -> bool:
    """Return True if control-mode is currently enabled."""
    return _control_mode_enabled


# =============================================================================
#  Internal: stdin reader thread + queue
# =============================================================================
#
# The reader thread is started lazily on first use and runs as a daemon
# so it never blocks process exit. It pushes every line it reads into
# `_stdin_queue`, terminated by a single sentinel object on EOF.

_EOF_SENTINEL = object()
_stdin_queue: "queue.Queue" = queue.Queue()
_reader_thread: Optional[threading.Thread] = None
_start_lock = threading.Lock()


def _stdin_reader_loop() -> None:
    """
    Background thread: read stdin forever, push each line into the queue.

    Exits on EOF (parent closed our stdin) or on KeyboardInterrupt,
    leaving a single sentinel in the queue so the consumer knows the
    stream is finished.
    """
    while True:
        try:
            line = sys.stdin.readline()
        except (EOFError, KeyboardInterrupt):
            _stdin_queue.put(_EOF_SENTINEL)
            return
        if line == '':
            # Empty string means EOF — parent closed our stdin.
            _stdin_queue.put(_EOF_SENTINEL)
            return
        _stdin_queue.put(line)


def _ensure_reader_started() -> None:
    """
    Start the reader thread if it isn't running yet.
    Idempotent and thread-safe — safe to call on every read.
    """
    global _reader_thread
    with _start_lock:
        if _reader_thread is not None and _reader_thread.is_alive():
            return
        _reader_thread = threading.Thread(
            target=_stdin_reader_loop,
            name="writespeare-stdin-reader",
            daemon=True,
        )
        _reader_thread.start()


# =============================================================================
#  Public: blocking read
# =============================================================================

def read_line_blocking() -> str:
    """
    Return the next line from stdin, blocking until it arrives.

    Returns:
        The raw line (including trailing newline) on success.
        Empty string `''` if stdin has reached EOF (parent closed us).

    Behaviour in non-control mode:
        Falls back to a direct `sys.stdin.readline()` so terminal users
        can still type responses to prompts. No thread is started in
        this mode, so there is no risk of stealing terminal input.

    Behaviour in control mode:
        Reads from the queue fed by the reader thread. The first call
        in control mode is what starts the thread (see
        `_ensure_reader_started`).
    """
    if not _control_mode_enabled:
        # Non-control mode — read directly from the terminal.
        try:
            return sys.stdin.readline()
        except (EOFError, KeyboardInterrupt):
            return ''

    # Control mode — read from the queue fed by the reader thread.
    _ensure_reader_started()
    item = _stdin_queue.get()
    if item is _EOF_SENTINEL:
        return ''
    return item  # type: ignore[return-value]


# =============================================================================
#  Public: non-blocking poll
# =============================================================================

def poll_command(timeout: float = 0.02) -> Optional[str]:
    """
    Non-blocking check for a control command.

    Waits up to `timeout` seconds for a line to arrive. Classifies it:
        "SKIP"     -> 'skip'
        "STOP"     -> 'stop'
        "CONTINUE" -> 'continue'
        empty line -> 'continue'  (unblocks a child waiting on input())
        anything else -> None (ignored)
        EOF        -> 'stop'  (treat closed stdin as a stop signal)

    Why empty line = 'continue':
        The captcha modal's "Continue" button sends a bare newline (no
        text) because that is exactly what a child's `input()` call is
        waiting for. If we returned None for an empty line, the relay
        in the parent would never forward it, and the child would hang
        forever on its stdin read.

    In non-control mode, always returns None immediately — there is no
    GUI to send us commands.

    The `timeout` default of 20ms is small enough to be invisible at
    normal checkpoints but large enough to absorb OS scheduler jitter
    when a command is genuinely in flight.

    Never blocks longer than `timeout` seconds.
    """
    if not _control_mode_enabled:
        return None

    _ensure_reader_started()
    try:
        item = _stdin_queue.get(timeout=timeout)
    except queue.Empty:
        return None

    if item is _EOF_SENTINEL:
        return 'stop'

    cmd = item.strip().upper()  # type: ignore[union-attr]
    if cmd == 'SKIP':
        return 'skip'
    if cmd == 'STOP':
        return 'stop'
    if cmd == 'CONTINUE':
        return 'continue'
    if cmd == '':
        # Bare newline — the captcha modal's "Continue" signal.
        return 'continue'
    return None


# =============================================================================
#  Public: checkpoint helper
# =============================================================================

def checkpoint_check(
    site: str,
    step: str = '',
    timeout: float = 0.02,
) -> str:
    """
    Poll for a pending command at a safe checkpoint.

    Called by feature scripts at specific points where it is safe to
    interrupt execution — before submitting a search, before starting
    a page extraction, before typing the writer prompt, before
    beginning a validation pass, etc.

    Returns:
        'continue' – no command pending (the default, most of the time)
        'skip'     – user clicked "Skip" for the current task
        'stop'     – user clicked "Stop" to abort the run

    The caller is responsible for acting on the result:
        * 'continue'  → proceed normally
        * 'skip'      → emit a terminal marker, sys.exit(99)
        * 'stop'      → emit a terminal marker, sys.exit(100)

    The `site` and `step` arguments are currently unused by this
    function but are part of the signature so that future checkpoints
    can log them or include them in a marker payload without changing
    every call site. They are metadata for diagnostics; the decision
    they inform is the return value alone.

    Never blocks longer than `timeout` seconds.
    """
    cmd = poll_command(timeout=timeout)
    if cmd is None:
        return 'continue'
    return cmd


# =============================================================================
#  Public: introspection helper (useful for tests)
# =============================================================================

def is_reader_thread_running() -> bool:
    """
    Return True if the stdin reader thread is currently alive.

    Exposed for tests and for a diagnostic log line at startup. In
    non-control mode this always returns False — no thread is started
    in that mode, by design.
    """
    return _reader_thread is not None and _reader_thread.is_alive()


# =============================================================================
#  Default export
# =============================================================================

__all__ = [
    # control-mode flag
    "set_control_mode",
    "is_control_mode",
    # reads
    "read_line_blocking",
    "poll_command",
    # checkpoint
    "checkpoint_check",
    # introspection
    "is_reader_thread_running",
]