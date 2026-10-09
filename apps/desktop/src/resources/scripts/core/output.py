#!/usr/bin/env python3
"""
core/output.py – Structured stdout markers + manual-action helpers.

Every Python script in the WriteSpeare pipeline uses the functions in
this module to communicate with the Electron main process.

Marker format (must match Electron's listenerBridge.ts regex):

    ::ROOKIE::<TYPE>::<compact-json>\n

The `::ROOKIE::` prefix is a fixed protocol identifier, not a product
name. It appears on every marker line emitted by every script in
WriteSpeare, and the Electron side parses exactly this prefix. The
prefix is shared with the ROOKIE project this pipeline is ported from
— the marker protocol is the same protocol, deliberately, so that the
two codebases remain interoperable at the wire level even though their
domains differ.

All markers are flushed immediately so Electron sees them the moment
they are emitted, even when stdout is a piped buffer.

Ownership rules:
    * This module EMITS the interaction markers
      (CAPTCHA_REQUIRED, CAPTCHA_SOLVED, MANUAL_ACTION) and the
      pipeline progress markers (SEARCH_*, EXTRACT_*, WRITER_*,
      VALIDATION_*). Which markers a given script emits is the
      script's responsibility — this module only defines the
      emission mechanism and the marker type constants.
    * The TASK_START and TASK_END markers are emitted by main.py,
      which is the single control point that classifies every
      feature script's exit code. Child scripts do NOT emit these.
    * Stdin access is delegated to core.control_mode, which owns the
      single reader thread. Never read sys.stdin directly from here.

Exit codes used by the control-mode protocol:

    99  – user clicked "Skip" on a blocking prompt (a captcha modal
          or a manual-action modal)
    100 – user clicked "Stop" on a blocking prompt
    101 – child auto-skipped a captcha prompt because the run policy
          is "skip" (WRITESPEARE_CAPTCHA_POLICY=skip). Distinct from
          99 so main.py (and the Electron listener bridge) can
          distinguish an automatic skip from a user-initiated one.

The `set_control_mode` / `is_control_mode` names are re-exported from
core.control_mode so existing callers keep working. Do NOT define a
local copy of the flag in this module — two flags mean two truths, and
a caller that set the flag via this module's re-export would leave the
control_mode module's own flag out of sync.

This module has NO external dependencies — only Python stdlib.
"""

import os
import sys
import json

from core.control_mode import (
    set_control_mode,
    is_control_mode,
    read_line_blocking,
)


# =============================================================================
#  Marker type constants
# =============================================================================
#
# These strings are the <TYPE> portion of the ::ROOKIE::<TYPE>:: prefix.
# They MUST match the corresponding constants in Electron's
# `features/automation/services/listenerBridge.ts`.
#
# Grouping:
#   * TASK_*        — emitted by main.py. Delimit the execution of a
#                     single pipeline operation.
#   * SEARCH_*      — emitted by research/google_search.py and
#                     research/duckduckgo_search.py during Stage 2.
#   * EXTRACT_*     — emitted by research/extract_dispatch.py and the
#                     platform-specific extractors during Stage 3.
#   * WRITER_*      — emitted by writer/deepseek_writer.py during
#                     Stage 5.
#   * VALIDATION_*  — emitted by validation/validate_all.py during
#                     Stage 6.
#   * CAPTCHA_*/MANUAL_ACTION — emitted by any script via
#                     manual_action_required() / captcha_required()
#                     when a human must intervene in the browser.
#
# Every marker named here has a defined consumer in the Electron
# listenerBridge. A marker that is not in this list, or a marker in
# this list that no script emits, is a bug — see the file header of
# listenerBridge.ts for the parser's exact accepted set.

# ---------------------------------------------------------------------------
#  Task boundaries (emitted by main.py, not by feature scripts)
# ---------------------------------------------------------------------------
MARKER_TASK_START = "TASK_START"   # main.py, before spawning the feature script
MARKER_TASK_END   = "TASK_END"     # main.py, after the feature script exits

# ---------------------------------------------------------------------------
#  Search stage (Stage 2 — Source Discovery)
# ---------------------------------------------------------------------------
MARKER_SEARCH_PROGRESS = "SEARCH_PROGRESS"   # per candidate-line progress
MARKER_SEARCH_RESULT   = "SEARCH_RESULT"     # full candidate list, once

# ---------------------------------------------------------------------------
#  Extraction stage (Stage 3 — Doc Files)
# ---------------------------------------------------------------------------
MARKER_EXTRACT_PROGRESS = "EXTRACT_PROGRESS"  # per-URL progress
MARKER_EXTRACT_DONE     = "EXTRACT_DONE"      # batch complete

# ---------------------------------------------------------------------------
#  Writer stage (Stage 5 — DeepSeek Automation)
# ---------------------------------------------------------------------------
MARKER_WRITER_PROGRESS = "WRITER_PROGRESS"   # per-doc paste / typing / waiting
MARKER_WRITER_DONE     = "WRITER_DONE"       # article saved

# ---------------------------------------------------------------------------
#  Validation stage (Stage 6 — Article Report)
# ---------------------------------------------------------------------------
MARKER_VALIDATION_PROGRESS = "VALIDATION_PROGRESS"  # per-validator progress
MARKER_VALIDATION_DONE     = "VALIDATION_DONE"      # aggregate report saved

# ---------------------------------------------------------------------------
#  User-interaction markers (emitted by any script)
# ---------------------------------------------------------------------------
MARKER_CAPTCHA_REQUIRED = "CAPTCHA_REQUIRED"  # blocking: user must solve a captcha
MARKER_CAPTCHA_SOLVED   = "CAPTCHA_SOLVED"    # captcha cleared, script resumed
MARKER_MANUAL_ACTION    = "MANUAL_ACTION"     # blocking: user must do something else


# =============================================================================
#  Exit codes
# =============================================================================

EXIT_SKIPPED = 99         # user clicked "Skip" on a blocking prompt
EXIT_STOPPED = 100        # user clicked "Stop" on a blocking prompt
EXIT_CAPTCHA_SKIP = 101   # auto-skipped due to WRITESPEARE_CAPTCHA_POLICY=skip


# =============================================================================
#  Control-mode flag
# =============================================================================
#
# The flag itself lives in core.control_mode. This module simply
# re-exports the same two functions so that callers who import from
# `core.output` (as ROOKIE's callers did) keep working without a
# code change.
#
# Do NOT define a local flag here — two flags mean two truths, and
# `main.py` calling `control_mode.set_control_mode(True)` would leave
# a local `output` flag reading False.
#
# Re-exported above via `from core.control_mode import (...)`. Nothing
# else needs to live in this section.


# =============================================================================
#  Marker emission
# =============================================================================

def emit_marker(marker_type: str, payload: dict) -> None:
    """
    Print a structured marker line to stdout for Electron to parse.

    Format:
        ::ROOKIE::<TYPE>::<compact-json>

    The line is flushed immediately so the parent process can relay
    it to Electron without waiting for a buffer flush. Without the
    flush, a marker emitted just before a long blocking operation
    (a page load, a captcha prompt) would sit in the pipe buffer and
    the GUI would stay dark until the operation completed.

    Never raises: a payload that cannot be JSON-serialized (an
    arbitrary object that is not a dict of primitives, a circular
    reference, a bytes value) is silently dropped, because a bad log
    line must never crash a running pipeline. The alternative —
    raising — would kill a script partway through an extraction or a
    writer run for a reason that is purely cosmetic.

    The JSON is emitted in compact form (`separators=(',', ':')`)
    so a marker line is short enough to be a single line even for a
    large payload. Unicode is preserved literally
    (`ensure_ascii=False`) so that an emoji in a log message or a
    non-ASCII character in a scraped title stays readable in the
    terminal output and in the GUI's log panel.
    """
    try:
        json_payload = json.dumps(
            payload,
            separators=(',', ':'),   # compact — no spaces, no newlines
            ensure_ascii=False,      # keep emoji / unicode literal
        )
    except (TypeError, ValueError):
        return

    print(f"::ROOKIE::{marker_type}::{json_payload}", flush=True)


# =============================================================================
#  Internal: read one command line from stdin
# =============================================================================

def _read_command() -> str:
    """
    Block until a line arrives on stdin, then classify it.

    Returns one of:
        'continue' – empty line, or any non-command text
        'skip'     – literal "SKIP" (case-insensitive)
        'stop'     – literal "STOP" (case-insensitive)

    EOF (parent closed stdin) is treated as 'stop' so the script
    exits cleanly instead of hanging forever.

    Stdin access goes through core.control_mode so the single-reader
    invariant is preserved. Never call sys.stdin.readline() directly
    from this module — the reader thread owns the only legitimate
    read path, and a second reader would race it for the same bytes.
    """
    line = read_line_blocking()

    # Empty string means EOF — parent closed our stdin
    if line == '':
        return 'stop'

    cmd = line.strip().upper()
    if cmd == 'SKIP':
        return 'skip'
    if cmd == 'STOP':
        return 'stop'
    return 'continue'


# =============================================================================
#  Public: user-interaction helpers
# =============================================================================

def manual_action_required(
    site: str,
    step: str,
    prompt: str = "",
    is_captcha: bool = False,
    row_idx: int = None,
) -> None:
    """
    Called by feature scripts whenever the user must do something in
    the browser before the script can continue.

    Typical uses:
      * Solve a reCAPTCHA / Cloudflare Turnstile  (is_captcha=True)
      * Close an overlay or popup manually
      * Wait for a page to load after a Cloudflare interstitial
      * Any other "please do X, then continue" moment

    Behaviour:
      1. Emits a structured marker (CAPTCHA_REQUIRED or MANUAL_ACTION).
      2. Prints a human-readable line so the terminal log stays readable.
      3. Blocks on stdin until a response arrives.
      4. Dispatches the response:
           * continue   → returns normally (script resumes)
           * skip       → sys.exit(99). main.py sees 99 and emits
                          TASK_END(skipped) — we do NOT emit it here.
           * stop       → sys.exit(100). main.py sees 100 and emits
                          TASK_END(aborted) — we do NOT emit it here.

    Unexpected-captcha policy:
      When `is_captcha=True`, the function first consults the
      WRITESPEARE_CAPTCHA_POLICY environment variable (set by
      main.py from the run's configuration). If the policy is:
          "skip" → print a log line and sys.exit(EXIT_CAPTCHA_SKIP).
                   main.py classifies the operation as
                   "auto-skipped (captcha)".
          "stop" → print a log line and sys.exit(EXIT_STOPPED).
                   main.py ends the entire run.
          "ask"  → fall through to the normal blocking flow below.
      This check happens BEFORE any marker or prompt is emitted, so
      the GUI never shows a modal for a captcha that is being handled
      automatically.

      The policy applies ONLY to captcha prompts. Manual actions that
      are not captchas (overlays, Cloudflare interstitials, "click
      here" prompts) always block, regardless of policy — the policy
      is a captcha-handling decision, not a general interactivity
      setting.

    NOTE: TASK_END is owned exclusively by main.py, which classifies
    the child's exit code. Emitting it here would produce a duplicate
    marker in the GUI's queue panel.

    The `site` and `step` arguments are metadata (used by the GUI to
    label the modal). `site` is a short identifier for where the
    action is needed — a platform slug (`"google"`, `"reddit"`) for
    the extraction stages, `"deepseek"` for the writer, or any other
    short string the caller finds meaningful. `step` is the pipeline
    stage or sub-operation name. `prompt` is the human-readable
    instruction text shown in the modal. `row_idx` is optional and
    included in the marker payload when not None; WriteSpeare scripts
    that do not process multiple rows leave it unset, in which case
    the payload omits the field entirely (see the payload build
    below).
    """
    # 0. Auto-skip / auto-stop policy.
    #
    # Evaluated before anything user-visible happens: no payload is
    # built, no prompt is printed, no marker is emitted. If the
    # policy says "skip" or "stop", this function exits immediately
    # with the code main.py uses to classify the operation.
    #
    # Only applies to captchas. Non-captcha manual actions (overlays,
    # Cloudflare interstitials, "click here" prompts) always block —
    # the policy is about how to handle captchas, not general
    # interactivity.
    #
    # Default "ask" preserves the pre-feature behavior, so an
    # upgraded install with no policy saved continues exactly as
    # before.
    if is_captcha:
        policy = os.environ.get("WRITESPEARE_CAPTCHA_POLICY", "ask")
        if policy == "skip":
            print(f"⏩ Auto-skipping [{site}] (captcha policy: skip)", flush=True)
            sys.exit(EXIT_CAPTCHA_SKIP)
        if policy == "stop":
            print(f"🛑 Auto-stopping at [{site}] (captcha policy: stop)", flush=True)
            sys.exit(EXIT_STOPPED)
        # policy == "ask" → fall through to the normal blocking flow

    # 1. Build the structured payload
    payload = {
        "site": site,
        "step": step,
        "prompt": prompt or step,
        "isCaptcha": bool(is_captcha),
    }
    if row_idx is not None:
        payload["rowIdx"] = row_idx

    # 2. Human-readable line (always shown, even in non-control mode)
    tag = "reCAPTCHA" if is_captcha else "Manual action"
    label = prompt or step
    print(f"⏳ {tag} required: [{site}] {label}", flush=True)

    # 3. Structured marker (Electron listens for these)
    marker = MARKER_CAPTCHA_REQUIRED if is_captcha else MARKER_MANUAL_ACTION
    emit_marker(marker, payload)

    # 4. Block until the user responds
    command = _read_command()

    # 5. Dispatch. main.py owns TASK_END emission — we simply exit
    #    with the code that tells main.py how to classify this task.
    if command == 'skip':
        print(f"⏩ User skipped: {site}", flush=True)
        sys.exit(EXIT_SKIPPED)

    if command == 'stop':
        print(f"🛑 User stopped the run at {site}", flush=True)
        sys.exit(EXIT_STOPPED)

    # 6. Continue — for captchas, emit a SOLVED marker so the GUI can
    #    clear the modal and update the queue status optimistically.
    if is_captcha:
        emit_marker(MARKER_CAPTCHA_SOLVED, {
            "site": site,
            "step": step,
        })


def captcha_required(
    site: str,
    step: str,
    prompt: str = "",
    row_idx: int = None,
) -> None:
    """
    Thin wrapper around manual_action_required() for the specific case
    of a reCAPTCHA / Cloudflare Turnstile that needs human solving.

    Equivalent to:
        manual_action_required(..., is_captcha=True)

    A dedicated name is provided so call sites read clearly — a
    reader scanning the source sees "captcha_required(...)" and
    immediately knows what kind of prompt it is, without having to
    check a flag.
    """
    manual_action_required(
        site=site,
        step=step,
        prompt=prompt,
        is_captcha=True,
        row_idx=row_idx,
    )


# =============================================================================
#  Public: low-level helper for main.py and control_mode.py
# =============================================================================

def read_one_line() -> str:
    """
    Public wrapper around _read_command() for callers that need to
    observe the raw command without the skip/stop side-effects.

    Returns 'continue' | 'skip' | 'stop'.

    Note: control_mode.py has its own poll_command() for non-blocking
    reads; this helper exists for callers that need a BLOCKING read
    with the continue/skip/stop classification but without triggering
    the sys.exit() side-effects that manual_action_required() applies.
    """
    return _read_command()


# =============================================================================
#  Default export
# =============================================================================

__all__ = [
    # task boundary markers
    "MARKER_TASK_START",
    "MARKER_TASK_END",
    # search stage markers
    "MARKER_SEARCH_PROGRESS",
    "MARKER_SEARCH_RESULT",
    # extraction stage markers
    "MARKER_EXTRACT_PROGRESS",
    "MARKER_EXTRACT_DONE",
    # writer stage markers
    "MARKER_WRITER_PROGRESS",
    "MARKER_WRITER_DONE",
    # validation stage markers
    "MARKER_VALIDATION_PROGRESS",
    "MARKER_VALIDATION_DONE",
    # interaction markers
    "MARKER_CAPTCHA_REQUIRED",
    "MARKER_CAPTCHA_SOLVED",
    "MARKER_MANUAL_ACTION",
    # exit codes
    "EXIT_SKIPPED",
    "EXIT_STOPPED",
    "EXIT_CAPTCHA_SKIP",
    # control-mode flag (re-exported from core.control_mode)
    "set_control_mode",
    "is_control_mode",
    # marker emission
    "emit_marker",
    # user interaction
    "manual_action_required",
    "captcha_required",
    # low-level
    "read_one_line",
]