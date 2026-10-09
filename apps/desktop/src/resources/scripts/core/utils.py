#!/usr/bin/env python3
"""
core/utils.py — Small shared helpers for the WriteSpeare automation scripts.

The "everything else" module for the `core/` package. It provides the
small, cross-cutting utilities that every stage of the pipeline
occasionally needs and that do not have a more specific home:

    * Logging — five level-tagged, colored log functions
      (log_debug, log_info, log_warning, log_error, log_success).
      Every human-readable line the automation prints to the
      terminal goes through one of these, so the log has a
      consistent shape and the level of every message is
      unambiguous at a glance.

    * Slugification — slugify() converts arbitrary text (a page
      title, a URL fragment, a user keyword) into a filename-safe,
      ASCII-only, lowercase, hyphen-separated slug. Every stage
      that names a file after content calls this function.

    * Deduplication — dedup() removes duplicates from an iterable
      while preserving first-seen order. The standard tool for
      deduping the search-candidate list and the extraction queue.

Design principles shared with the rest of the `core/` package:

    * No side effects beyond colorama.init(). Importing this module
      does not start a thread, open a file, or touch the network.
      The one exception is the colorama.init() call, which is
      documented in its own section below.

    * Stdlib + declared dependencies only. This module imports from
      Python's standard library and from the `colorama` package,
      which is declared in requirements.txt. Nothing else.

    * Every print is flushed. Every logging function calls
      print(..., flush=True), so a log line appears in the parent
      process the moment it is emitted, even when the log is being
      streamed through a pipe.

Why these three helper groups live in one file:

    Each helper is used by more than one script. The logging
    functions are used by every script. slugify() is used by both
    extractors (to name .md files from page titles) and by the
    writer (to name the draft file from the topic title). dedup()
    is used by the search scripts (to dedup candidate URLs) and by
    the extraction dispatcher (to dedup the selected URLs before
    fetching). Centralising the three keeps the call sites short
    and gives each behaviour one place to be fixed, tested, or
    changed.

Dependencies: Python stdlib + the `colorama` package (declared in
apps/desktop/src/resources/scripts/requirements.txt).
"""

import re
import unicodedata
from collections.abc import Callable, Iterable
from typing import Any, TypeVar

import colorama
from colorama import Fore, Style


# =============================================================================
#  One-time colorama initialisation
# =============================================================================
#
# colorama.init() is a one-time, process-wide setup that wraps
# sys.stdout and sys.stderr so ANSI color codes behave correctly on
# Windows:
#
#     * When stdout is a real terminal (a developer running a script
#       by hand), Windows's console API has no native ANSI support in
#       the classic CMD.exe, so colorama translates each escape code
#       into the corresponding console API call. The user sees
#       colors.
#
#     * When stdout is piped (the normal case — the Electron main
#       process spawns the Python script with a pipe), there is no
#       console to translate to, so colorama STRIPS the escape codes
#       and the parent process receives clean, uncolored text. This
#       is exactly what the GUI's log panel wants, and it is why we
#       do not need to strip codes on the parent side.
#
#     * On non-Windows platforms the call is effectively a no-op —
#       ANSI codes are supported natively by every Unix terminal, so
#       no translation or stripping is needed.
#
# The call is idempotent — calling it twice is safe — and it has no
# observable effect until the first print actually happens. It is
# called here at module-import time rather than lazily inside a
# logging function for two reasons:
#
#     1. A single call site is simpler than a per-call check, and the
#        cost (one function invocation at module load) is negligible.
#
#     2. Calling it lazily would make the first log line in a process
#        pay a startup cost that is invisible to the caller — a
#        subtle behaviour difference between the first log and every
#        subsequent log. Doing it once, up front, means every log
#        line costs the same.
#
# This is the only module-level side effect in `core/`, and it is
# documented here so a reader who sees it does not mistake it for an
# oversight.

colorama.init()


# =============================================================================
#  Type variables
# =============================================================================

# The element type for `dedup`. Dedup is generic over the element type
# — it works equally well on a list of URL strings, a list of dicts
# with a `url` key, a list of Pydantic models, or a list of tuples.
T = TypeVar("T")


# =============================================================================
#  Constants
# =============================================================================

# Windows reserves a set of filenames for legacy DOS device names.
# A file named CON, PRN, AUX, NUL, COM1-9, or LPT1-9 cannot be
# created on Windows regardless of its extension — `CON.md` is
# rejected just as `CON` is. Since WriteSpeare's `.md` files are
# named by slugifying a page title, a page titled "Nul" would
# produce a slug that Windows refuses to write.
#
# The set below lists the reserved names in their lowercase form
# (matching the case slugify always produces). A slug that matches
# one of these is suffixed with an underscore, which is a valid
# filename change that preserves the slug's meaning — `nul_` reads
# as "the slug for Nul, adjusted for Windows".
#
# The set is a frozenset so it is immutable, hashable, and safe to
# share across any number of call sites.
_WINDOWS_RESERVED_NAMES: frozenset[str] = frozenset(
    {"con", "prn", "aux", "nul"}
    | {f"com{i}" for i in range(1, 10)}
    | {f"lpt{i}" for i in range(1, 10)}
)


# =============================================================================
#  Logging
# =============================================================================
#
# Five functions, one per log level. Each prints a single line to
# stdout with a colored level tag and the caller's message, and each
# flushes immediately so the line appears in the parent process the
# moment it is emitted.
#
# Format:
#
#     [LEVEL] <message>
#
# The level tag is bracketed and uppercase so that a grep for a
# specific level (`grep "\[ERROR\]"`) finds every line at that level
# and nothing else. The tag is colored via colorama's `Fore` and
# `Style` constants — see the module docstring for why colorama is
# initialised at import time and why the colors are stripped
# automatically when stdout is piped.
#
# None of the log functions raise. If the underlying `print` fails —
# a broken pipe to a parent that has exited, a stdout that has been
# closed — the failure is invisible to the caller. The alternative
# (raising) would let a logging failure kill a running pipeline,
# which is exactly the wrong trade: a missing log line is a small
# inconvenience, a crashed script is a lost run.

def log_debug(message: str) -> None:
    """
    Print a debug-level log line.

    Debug lines are the noisiest and the least important. There is no
    runtime verbosity filter — the pipeline does not have a
    log-level configuration, and a caller that does not want debug
    output simply does not call this function. This keeps the
    decision at the call site, where the author knows whether the
    detail is worth logging.
    """
    print(
        f"{Style.DIM}[DEBUG]{Style.RESET_ALL} {message}",
        flush=True,
    )


def log_info(message: str) -> None:
    """
    Print an info-level log line.

    Info lines are the pipeline's normal progress messages — "found
    N candidates", "extracting 3 of 10", "writer draft saved". They
    are the majority of what a user sees when watching the log.
    """
    print(
        f"{Fore.CYAN}[INFO]{Style.RESET_ALL} {message}",
        flush=True,
    )


def log_success(message: str) -> None:
    """
    Print a success-level log line.

    Success lines mark the completion of a meaningful unit of work —
    a topic's search finished, an article was persisted, a
    validation report was written. They are distinct from info lines
    so that a user scanning the log for "did it work?" can find the
    answer quickly.
    """
    print(
        f"{Fore.GREEN}[OK]{Style.RESET_ALL} {message}",
        flush=True,
    )


def log_warning(message: str) -> None:
    """
    Print a warning-level log line.

    Warning lines flag a non-fatal problem — a page that failed
    extraction but did not abort the batch, a keyword that was
    below its density target, a captcha that was auto-skipped. The
    pipeline continues; the user should be aware.
    """
    print(
        f"{Fore.YELLOW}[WARN]{Style.RESET_ALL} {message}",
        flush=True,
    )


def log_error(message: str) -> None:
    """
    Print an error-level log line.

    Error lines flag a fatal or near-fatal problem — a Chrome launch
    that failed, an extraction batch that lost every page, a writer
    run that produced no article. The pipeline may or may not
    continue, but the user needs to see this line.
    """
    print(
        f"{Fore.RED}[ERROR]{Style.RESET_ALL} {message}",
        flush=True,
    )


# =============================================================================
#  Slugification
# =============================================================================

def slugify(text: str, max_length: int = 80) -> str:
    """
    Convert arbitrary text to a filename-safe slug.

    The transformation, in order:

        1. Unicode normalization (NFKD) — decomposes accented
           characters into base characters plus combining marks, so
           that "café" becomes "cafe" and "naïve" becomes "naive"
           after step 2.

        2. ASCII encoding with 'ignore' — drops any character that
           cannot be represented in ASCII. This removes the
           combining marks from step 1 and any non-Latin script
           (Cyrillic, CJK, emoji) from the input.

        3. Lowercase.

        4. Replacement of every run of one-or-more non-alphanumeric
           ASCII characters with a single hyphen.

        5. Strip of leading and trailing hyphens.

        6. Truncation to `max_length` characters, followed by a
           second strip of trailing hyphens (in case truncation cut
           in a way that left one).

        7. Windows-reserved-name protection: if the result matches a
           Windows reserved filename (CON, PRN, AUX, NUL, COM1-9,
           LPT1-9), a trailing underscore is appended.

        8. Empty-string fallback: if the result is empty (which can
           happen with input that is entirely non-ASCII or entirely
           punctuation), returns the literal string "untitled".

    The result is guaranteed to be:

        * ASCII-only.
        * Lowercase.
        * Composed only of characters from the set [a-z0-9-].
        * Non-empty.
        * Not a Windows reserved filename.
        * At most `max_length` characters long (though possibly
          shorter if the empty-input fallback or the reserved-name
          underscore was applied).

    The default `max_length` of 80 is chosen for practical path
    length: a Windows path is limited to 260 characters by default,
    and a topic folder path plus a slug plus a `.md` extension must
    all fit within that. 80 characters leaves generous room for the
    folder portion of the path.

    Args:
        text: The text to slugify.
        max_length: The maximum length of the returned slug, in
            characters. Defaults to 80.

    Returns:
        A filename-safe slug. Never empty.
    """
    # 1. Unicode normalization. NFKD is the compatibility decomposition
    #    — it breaks accented characters into base + combining mark, and
    #    maps several typographic variants (ligatures, circled letters)
    #    to their canonical forms.
    normalized = unicodedata.normalize("NFKD", text)

    # 2. ASCII encoding with 'ignore'. This drops the combining marks
    #    from step 1 (they are not ASCII) and any non-Latin character
    #    in the input. The result is a `bytes` object; decode back to
    #    `str` for the subsequent regex and string operations.
    ascii_only = normalized.encode("ascii", "ignore").decode("ascii")

    # 3. Lowercase. Done before the regex so the regex only needs to
    #    match [a-z0-9], not [a-zA-Z0-9].
    lowered = ascii_only.lower()

    # 4. Collapse runs of non-alphanumeric characters into single
    #    hyphens. The regex is greedy — one `re.sub` call replaces
    #    every run with exactly one hyphen, regardless of how long the
    #    run was. This is what makes "Hello,   World!!!" produce
    #    "hello-world" rather than "hello---world".
    hyphenated = re.sub(r"[^a-z0-9]+", "-", lowered)

    # 5. Strip leading and trailing hyphens. A slug that started or
    #    ended with punctuation would otherwise begin or end with a
    #    hyphen, which is aesthetically wrong and occasionally
    #    confusing (a filename starting with a hyphen can be
    #    misread as a CLI flag).
    stripped = hyphenated.strip("-")

    # 6. Truncate and re-strip. The `rstrip` after truncation handles
    #    the case where the truncation boundary happened to fall
    #    immediately after a hyphen (producing a trailing hyphen) or
    #    immediately before one (producing the same). Either way, one
    #    more strip cleans it up.
    if len(stripped) > max_length:
        stripped = stripped[:max_length].rstrip("-")

    # 7. Windows reserved-name protection.
    if stripped in _WINDOWS_RESERVED_NAMES:
        stripped = stripped + "_"

    # 8. Empty-input fallback. A slug that is the empty string cannot
    #    be used as a filename component, so we return a fixed
    #    placeholder. "untitled" is chosen to be a valid slug itself
    #    (all lowercase, all ASCII, no reserved-name conflict) and to
    #    read clearly if a user ever sees it in a directory listing.
    if not stripped:
        return "untitled"

    return stripped


# =============================================================================
#  Deduplication
# =============================================================================

def dedup(
    items: Iterable[T],
    key: Callable[[T], Any] | None = None,
) -> list[T]:
    """
    Remove duplicates from an iterable while preserving first-seen
    order.

    The returned list contains the first occurrence of each distinct
    value. Subsequent occurrences are dropped. The order of the
    result matches the order of first appearance in the input.

    "Distinct" is defined by the `key` argument:

        * When `key` is None, an item is considered a duplicate of an
          earlier item if the two items are equal by Python's `==`
          and hash to the same value. This is the default and works
          for any hashable element type — strings, numbers, tuples.

        * When `key` is a callable, the callable's return value for
          each item is what is compared. The callable must return a
          hashable value; if it returns an unhashable value (a list,
          a dict, a set), the function will raise `TypeError` at the
          point where the value is added to the internal `set`. The
          caller is responsible for choosing a key function that
          returns a hashable value.

    The key-function form is what makes dedup useful for
    case-insensitive comparisons and for dedup-by-field:

        # Case-insensitive dedup of a list of strings:
        dedup(urls, key=lambda u: u.lower())

        # Dedup a list of dicts by their "url" field:
        dedup(results, key=lambda r: r["url"])

        # Dedup a list of objects by one attribute:
        dedup(candidates, key=lambda c: c.normalized_domain)

    The function is generic over the element type. It accepts any
    iterable — a list, a tuple, a generator, a set (though sets are
    already deduped, so deduping one is pointless) — and always
    returns a list. Passing a generator consumes it once; the
    generator cannot be iterated again after the call returns.

    Args:
        items: The iterable to dedup.
        key: An optional callable that extracts a comparison key
            from each item. When None, the items themselves are
            compared. Must return a hashable value when provided.

    Returns:
        A new list containing the first occurrence of each distinct
        item, in first-seen order.
    """
    seen: set[Any] = set()
    result: list[T] = []

    for item in items:
        comparison_key = key(item) if key is not None else item
        if comparison_key in seen:
            continue
        seen.add(comparison_key)
        result.append(item)

    return result


# =============================================================================
#  Default export
# =============================================================================

__all__ = [
    # logging
    "log_debug",
    "log_info",
    "log_success",
    "log_warning",
    "log_error",
    # slugification
    "slugify",
    # deduplication
    "dedup",
]