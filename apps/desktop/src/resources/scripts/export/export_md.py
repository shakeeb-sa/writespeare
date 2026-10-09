#!/usr/bin/env python3
"""
export/export_md.py — Markdown-to-Markdown export for WriteSpeare.

The simplest exporter in the WriteSpeare pipeline. Reads a
finished article's Markdown source and writes it, unchanged, to
the destination path the user chose in the Save-As dialog. No
parsing, no conversion, no transformation — the article is
already Markdown, and the Markdown copier's entire job is to
place a copy of it at the user's chosen path.

Why this is a separate file from export_docx.py:

    The two exporters share a single interface —
    `run_export(article_path, output_path) -> int` — and `main.py`
    dispatches to one or the other based on the user's chosen
    format. Giving each its own module is what keeps that dispatch
    a one-line import selection (see `_run_export` in `main.py`)
    rather than a branch inside a combined module.

    The split has a second benefit: this file has no external
    dependencies at all — it uses only Python's standard library
    and the sibling `core/` package — while `export_docx.py`
    requires `python-docx`. Keeping them separate means a future
    consumer that only wants Markdown copying does not pay the
    `python-docx` import cost, and it means a bug in the docx
    writer's XML manipulation cannot break the trivially simple
    Markdown path.

Why this module does NOT strip frontmatter:

    The article `.md` files the writer step produces have no
    frontmatter — `deepseek_writer.py` strips any that came in
    from a source doc before saving the article. But if a future
    change ever produced an article with frontmatter, this
    module's contract would still be "copy the source as-is",
    not "strip the frontmatter and copy the body".

    The distinction is deliberate and it differs from
    `export_docx.py`'s behavior. The docx exporter DOES strip
    frontmatter, because a docx renders Markdown as formatted
    text and a pile of `url: "..."` lines would appear as body
    paragraphs. A Markdown file, by contrast, has frontmatter as
    part of its format; a Markdown-aware editor renders it as a
    metadata block, not as prose. Exporting to Markdown means
    exporting the file as the format understands it, which is
    the file as-is.

Why this module uses `core.file_io` rather than `shutil.copy`:

    `shutil.copy` would be a one-line implementation of this
    module's job and would produce a byte-for-byte-identical
    output file on most platforms. It is not used, for three
    reasons:

      1. Atomicity. `shutil.copy` opens the destination and
         writes in chunks; a crash partway through leaves a
         truncated file at the destination, which a reader
         would see as a corrupted export. `write_text_atomic`
         writes to a temporary file and renames it over the
         destination, so a reader sees either the complete
         file or no file.

      2. Parent-directory creation. `shutil.copy` requires the
         destination's parent directory to exist. The
         `write_text_atomic` helper creates it (via
         `path.parent.mkdir(parents=True, exist_ok=True)`) so
         a future caller that names a deep path without
         pre-creating the directories still gets a working
         export.

      3. Consistency. Every other file write in the pipeline
         goes through `core.file_io`'s atomic writers, and the
         pipeline's on-disk layout is documented in exactly one
         place — that module. Adding a `shutil.copy` here
         would be the first exception to that rule, and the
         exception would eventually drift from the rule's
         guarantees.

    The trade-off: `shutil.copy` preserves byte-level
    differences (CRLF line endings, a UTF-8 BOM, the file's
    exact byte sequence) that `read_doc` + `write_text_atomic`
    normalizes away. Python's text-mode I/O converts CRLF to LF
    on read and writes LF on write, so an article that was
    saved with Windows line endings would be exported with Unix
    line endings. For Markdown that is a feature, not a bug —
    LF-only files are the cross-platform standard, and every
    Markdown renderer accepts them. A future session that wants
    byte-exact copies would add a `write_bytes_atomic` helper
    to `core.file_io` and use it here.

What this module does NOT do:

  * It does not modify the article `.md` file. The source is
    read-only; the exported file is written to a new path.

  * It does not emit markers. Export is a short operation with
    no progress to report — see the package `__init__.py`'s
    docstring for the reasoning.

  * It does not open the exported file. It writes to disk and
    returns; what the user does with the file is not this
    module's concern.

  * It does not validate the output path's extension. The
    Save-As dialog's default filename ends in `.md`, but the
    user is free to choose a different extension — `.markdown`,
    `.txt`, `.md.bak`, whatever. Policing the extension would
    be a minor and unwelcome restriction.

Dependencies: Python stdlib + the sibling `core/` package. No
external libraries.
"""

import sys
from pathlib import Path

# =============================================================================
#  sys.path bootstrap — MUST run BEFORE any `from core.* import ...`
# =============================================================================
#  Identical to the bootstrap in every other feature script. The
#  script lives at scripts/export/export_md.py, so its own
#  directory is export/, and the parent's parent is the directory
#  that contains `core/`. That directory must be on sys.path for
#  the sibling imports below to resolve in the packaged app's
#  embedded Python distribution.

_SCRIPT_DIR = Path(__file__).resolve().parent
_SCRIPTS_ROOT = _SCRIPT_DIR.parent
if str(_SCRIPTS_ROOT) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_ROOT))

from core.file_io import read_doc, write_text_atomic
from core.utils import log_error, log_success


# =============================================================================
#  Public entry point
# =============================================================================

def run_export(article_path: str, output_path: str) -> int:
    """
    Copy a Markdown article to the user's chosen destination.

    See the module docstring for the full flow. Returns an
    integer exit code: 0 on success, 1 on failure.

    A success code means the `.md` file was written to disk and
    can be opened by any Markdown-aware editor, pasted into any
    blog platform, or committed to any version-control system.
    The function does not open the file itself; that is the
    caller's concern.

    A failure code means either the article could not be read or
    the destination could not be written. In both cases a
    diagnostic line is emitted at error level before the
    function returns. The caller (`main.py`) does not distinguish
    the two failure modes — both classify the operation as
    `'failed'` in the `TASK_END` marker.

    Args:
        article_path: The absolute path to the article `.md`
                      file to export.
        output_path:  The absolute path to write the exported
                      `.md` to. The parent directory is created
                      if it does not exist, so the caller does
                      not need to pre-create any part of the
                      path.

    Returns:
        0 on success, 1 on failure.
    """
    # ---- 1. Validate the input paths ----
    # Both must be non-empty strings. The `Save-As` dialog the
    # desktop's IPC handler opens produces a non-empty output
    # path in the normal case, but a caller that bypassed the
    # dialog — a script that invoked `main.py export` directly
    # from a terminal — could pass an empty string. An explicit
    # check produces a clear diagnostic rather than letting
    # `Path("")` resolve to the current directory and produce a
    # confusing "cannot write to a directory" error.
    if not article_path or not isinstance(article_path, str):
        log_error("export_md: article_path must be a non-empty string.")
        return 1

    if not output_path or not isinstance(output_path, str):
        log_error("export_md: output_path must be a non-empty string.")
        return 1

    article_file = Path(article_path)
    output_file = Path(output_path)

    # ---- 2. Validate the article file exists ----
    if not article_file.is_file():
        log_error(
            f"export_md: article file not found: {article_path}"
        )
        return 1

    # ---- 3. Read the article text ----
    # `read_doc` reads the file as UTF-8, which is the encoding
    # the writer step wrote it with. A decode failure — the
    # article file was somehow corrupted with invalid UTF-8
    # bytes — surfaces here as an exception, which is caught
    # and reported rather than allowed to propagate. The
    # alternative — writing a half-decoded file — would produce
    # a `UnicodeDecodeError` deep inside a write operation that
    # the caller could not easily diagnose.
    try:
        article_text = read_doc(article_file)
    except Exception as exc:
        log_error(
            f"export_md: could not read article file: {exc}"
        )
        return 1

    # ---- 4. Write the exported file ----
    # `write_text_atomic` performs the two-step atomic write:
    # save to a temporary file next to the destination, then
    # rename over the destination. The destination's parent
    # directory is created automatically if it does not exist.
    # See the module docstring's "Why this module uses
    # `core.file_io` rather than `shutil.copy`" section for the
    # full rationale.
    #
    # Note that this step does NOT validate the article's
    # content. An empty article — the writer step produced no
    # text, or the article file was truncated to zero bytes —
    # produces an empty exported file. That is the correct
    # behavior for a "just copies" export: the user asked to
    # export whatever was in the source, and an empty source
    # produces an empty output. A future session that wanted to
    # reject empty exports would add a check here — the shape
    # is a `if not article_text.strip(): ... return 1` block —
    # but the current plan does not call for it.
    try:
        write_text_atomic(output_file, article_text)
    except Exception as exc:
        log_error(
            f"export_md: could not write export file: {exc}"
        )
        return 1

    # ---- 5. Success ----
    log_success(f"Exported article to {output_file.name}")
    return 0


# =============================================================================
#  Default export
# =============================================================================

__all__ = [
    "run_export",
]