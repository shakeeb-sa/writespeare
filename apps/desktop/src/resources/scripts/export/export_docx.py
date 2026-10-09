#!/usr/bin/env python3
"""
export/export_docx.py — Markdown → .docx writer for WriteSpeare.

The Word-document exporter for the WriteSpeare pipeline. Reads a
finished article's Markdown source, converts it into a Word
document whose headings, bold and italic runs, hyperlinks, list
items, block quotes, and code blocks are the document's native
equivalents, and writes the result to the path the user chose in
the Save-As dialog.

Why python-docx:

    `python-docx` is the standard pure-Python library for
    creating and editing `.docx` files. It does not require a
    copy of Microsoft Word to be installed — the `.docx` format
    is an Open XML package (a ZIP archive of XML parts) and
    python-docx writes those parts directly. That property is
    what makes the packaged app able to offer `.docx` export on
    a machine that has never had Word installed.

    The library's API surface is the second reason. A Word
    document is a `Document` object; adding a heading is
    `doc.add_heading(...)`, adding a paragraph is
    `doc.add_paragraph(...)`, and a paragraph's runs carry the
    bold, italic, and font attributes. That model maps cleanly
    onto Markdown's own block and inline structures, which is
    what makes the conversion in this file a short, direct
    translation rather than a complicated transformation.

The parsing model — why it does not use a general-purpose
Markdown library:

    A `markdown` or `mistune` library would turn the article's
    source into an abstract syntax tree or an HTML string. Either
    output would then have to be converted into python-docx calls
    — an HTML-to-docx conversion layer on top of the
    Markdown-to-HTML conversion, or a tree-walk over an AST whose
    node taxonomy was designed for HTML output rather than for
    Word. Both paths add a dependency (the Markdown library) and
    an intermediate representation (the HTML or AST) without
    removing any of the work the conversion actually has to do.

    This file therefore parses the article's Markdown directly,
    line by line, using a small set of regexes that recognize the
    six block types the writer step produces — headings, list
    items, block quotes, code fences, horizontal rules, and
    ordinary paragraphs — plus the six inline constructs it
    produces — bold, italic, bold-italic, inline code, and
    links. Every construct is recognized by a pattern anchored
    to a specific position (a heading's `#` at the start of a
    line, a link's `[` and `](` bracketing the URL), and
    everything else is treated as plain text.

    The trade-off: this file does not handle every legal
    Markdown construct. It does not handle HTML blocks, tables,
    reference-style links, footnote definitions, nested list
    levels, or emphasis containing other emphasis. Those are all
    constructs the writer step does not produce. If a future
    session finds that the writer's output includes one of them,
    the correct change is to add a branch to the parser for that
    one construct, in the same shape as the branches already
    present, rather than to swap in a general-purpose library.
    The parser's job is to convert the writer's output, not to
    be a complete Markdown implementation.

The atomic-write pattern:

    python-docx's `Document.save(path)` writes to the target
    path directly — it opens the file, writes the ZIP, and
    closes it. A process that crashed in the middle of that
    write would leave a partial `.docx` at the destination,
    which Word would refuse to open. To avoid that, this file
    saves the document to a sibling path
    (`<output>.docx.tmp`) and then renames the temporary file
    over the destination. The rename is atomic on both Windows
    (`MoveFileEx` with `MOVEFILE_REPLACE_EXISTING`) and POSIX
    (`rename(2)`), so a reader — the user, the Windows shell
    that will open the file — sees either the previous file (or
    no file) or the complete new one, never a partial write.

    The pattern mirrors `core.file_io.write_text_atomic`, which
    every other writer in the pipeline uses. The difference is
    that python-docx's `save` takes a path rather than a string,
    so this file cannot call `write_text_atomic` directly. The
    two-step sequence (save to temp, rename over target) is the
    same algorithm, applied to a binary writer that does not
    expose a "write these bytes" method.

Frontmatter:

    The article `.md` file the writer step produces does not
    carry YAML frontmatter — the writer strips it before
    saving, because the frontmatter of a source doc file is
    metadata about the scrape, not about the generated article.
    This file strips frontmatter defensively anyway, using
    `core.extractor.strip_frontmatter`, because the
    future-proofing cost is one function call and the failure
    mode without it — a docx whose first paragraph is a pile
    of `url: "..."` lines — is ugly enough to be worth
    avoiding.

What this file does NOT do:

  * It does not modify the article `.md` file. The source is
    read-only; the docx is written to a NEW path.

  * It does not open Word or any Word-compatible editor. It
    writes a file and returns; what the user does with the file
    is not this module's concern.

  * It does not emit markers. Export is a short operation with
    no progress to report — see the package `__init__.py`'s
    docstring for the reasoning.

  * It does not handle images. `python-docx` can embed images
    from local files, but the writer step does not produce
    images in its output, and fetching images from URLs would
    require a network request that this stage is deliberately
    built not to make. An image construct (`![alt](url)`)
    encountered in the article is rendered as a plain-text
    placeholder of the form `[Image: alt]`, with a warning
    logged. A future session that wants to embed images could
    add the logic here — the shape is a branch in
    `_add_inline_runs` — but the current plan does not call
    for it.

Dependencies: Python stdlib + the `python-docx` package
(declared in requirements.txt) + the sibling `core/` package.
"""

import re
import sys
from pathlib import Path

# =============================================================================
#  sys.path bootstrap — MUST run BEFORE any `from core.* import ...`
# =============================================================================
#  Identical to the bootstrap in every other feature script. The
#  script lives at scripts/export/export_docx.py, so its own
#  directory is export/, and the parent's parent is the directory
#  that contains `core/`. That directory must be on sys.path for
#  the sibling imports below to resolve in the packaged app's
#  embedded Python distribution.

_SCRIPT_DIR = Path(__file__).resolve().parent
_SCRIPTS_ROOT = _SCRIPT_DIR.parent
if str(_SCRIPTS_ROOT) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_ROOT))

from docx import Document
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.opc.constants import RELATIONSHIP_TYPE
from docx.shared import Pt, Inches

from core.extractor import strip_frontmatter
from core.file_io import read_doc
from core.utils import log_warning, log_error, log_success


# =============================================================================
#  Constants — block-level parsing patterns
# =============================================================================
#  Each pattern is anchored to the start of a line so it does not
#  fire on a character sequence that appears mid-paragraph. See
#  the module docstring's "parsing model" section for the
#  rationale on the hand-rolled parser.

_HEADING_PATTERN = re.compile(r"^(#{1,6})\s+(.+?)\s*#*\s*$")
_HR_PATTERN = re.compile(r"^\s{0,3}(?:[-*_]\s*){3,}$")
_BULLET_PATTERN = re.compile(r"^\s{0,3}[-*+]\s+(.+)$")
_NUMBER_PATTERN = re.compile(r"^\s{0,3}\d+\.\s+(.+)$")
_CODE_FENCE_PATTERN = re.compile(r"^\s{0,3}```")
_BLOCKQUOTE_PATTERN = re.compile(r"^\s{0,3}>\s?(.*)$")


# =============================================================================
#  Constants — inline parsing pattern
# =============================================================================
#  The alternation is ordered from most-specific (three asterisks)
#  to least-specific (one asterisk) so that at a given position,
#  the regex engine tries `***` before `**` before `*` — the
#  greedy-matching behavior the alternation depends on.
#
#  Each alternative uses a character class that excludes the
#  emphasis delimiter (`[^*]` for asterisk, `[^_]` for
#  underscore) so that a match cannot cross an emphasis boundary.
#  This is what prevents `*italic*` inside `**bold**` from being
#  matched as part of the outer bold — the `[^*]+` in the bold
#  alternative stops at the first `*`, so the outer match fails
#  and the whole string falls through to being rendered as plain
#  text. See the module docstring for why that fallback is
#  acceptable for the writer step's output.
#
#  The link alternative is last so that it is tried after every
#  emphasis alternative. Ordering the link after the emphasis
#  rules ensures the emphasis rules get a chance to match on the
#  surrounding text before the link rule consumes the whole
#  construct.

_INLINE_PATTERN = re.compile(
    r"(?P<bold_italic>\*\*\*[^*]+\*\*\*)"
    r"|(?P<bold_stars>\*\*[^*]+\*\*)"
    r"|(?P<italic_stars>\*[^*]+\*)"
    r"|(?P<bold_underscores>__[^_]+__)"
    r"|(?P<italic_underscores>_[^_]+_)"
    r"|(?P<code>`[^`]+`)"
    r"|(?P<link>\[[^\]]+\]\([^)]+\))"
    r"|(?P<image>!\[[^\]]*\]\([^)]*\))"
)


# =============================================================================
#  Constants — styling values
# =============================================================================
#  The monospace font name for inline code and code blocks.
#  "Consolas" is present on every Windows installation since
#  Windows Vista and on every macOS system with Microsoft Office
#  installed; on the rare machine without it, Word falls back to
#  its default font, which is a degraded but functional result.

_MONOSPACE_FONT = "Consolas"

# The blockquote's left indent, in inches. python-docx's default
# "Quote" style has no indent, which makes a blockquote look
# identical to a normal paragraph. A quarter-inch indent is
# enough to distinguish it visually without eating too much of
# the page width on a narrow margin.

_QUOTE_INDENT_INCHES = 0.25

# The hyperlink color, as a hex string. This matches the blue
# that Word uses for its built-in "Hyperlink" character style.
# Setting it explicitly (rather than relying on the character
# style being present in the document's template) is what makes
# the hyperlink render as a link on any Word installation.

_HYPERLINK_COLOR_HEX = "0000FF"


# =============================================================================
#  Public entry point
# =============================================================================

def run_export(article_path: str, output_path: str) -> int:
    """
    Convert a Markdown article into a Word document and write it
    to `output_path`.

    See the module docstring for the full flow. Returns an
    integer exit code: 0 on success, 1 on failure.

    A success code means the `.docx` file was written to disk and
    can be opened by any Word-compatible editor. The function
    does not open the file itself; that is the caller's concern.

    A failure code means either the article could not be read or
    the document could not be written. In both cases a diagnostic
    line is emitted at error level before the function returns.
    The caller (`main.py`) does not distinguish the two failure
    modes — both classify the operation as `'failed'` in the
    `TASK_END` marker.

    Args:
        article_path: The absolute path to the article `.md`
                      file to export.
        output_path:  The absolute path to write the exported
                      `.docx` to. The parent directory is
                      expected to exist; the caller (the
                      desktop's IPC handler, which received the
                      path from a Save-As dialog) is responsible
                      for having created it via the dialog.

    Returns:
        0 on success, 1 on failure.
    """
    # ---- 1. Validate the article file ----
    article_file = Path(article_path)
    if not article_file.is_file():
        log_error(
            f"export_docx: article file not found: {article_path}"
        )
        return 1

    # ---- 2. Read the article text ----
    try:
        article_text = read_doc(article_file)
    except Exception as exc:
        log_error(
            f"export_docx: could not read article file: {exc}"
        )
        return 1

    if not article_text.strip():
        log_error("export_docx: article file is empty.")
        return 1

    # ---- 3. Strip frontmatter ----
    # See the module docstring's "Frontmatter" section for why
    # this step is defensive rather than required.
    body = strip_frontmatter(article_text)

    # ---- 4. Build the document ----
    # `_build_document` performs the Markdown-to-docx conversion
    # and returns the in-memory `Document` object. Any exception
    # during the conversion — a python-docx internal error on a
    # pathological input — is caught here and reported as a
    # failure, because a partially-built document cannot be
    # saved meaningfully.
    try:
        document = _build_document(body)
    except Exception as exc:
        log_error(
            f"export_docx: could not build document: {exc}"
        )
        return 1

    # ---- 5. Save the document atomically ----
    # See the module docstring's "atomic-write pattern" section
    # for the rationale.
    output_file = Path(output_path)
    temp_file = output_file.with_suffix(output_file.suffix + ".tmp")

    try:
        document.save(str(temp_file))
    except Exception as exc:
        log_error(f"export_docx: could not save document: {exc}")
        # Best-effort cleanup of the temp file. If the save
        # failed partway through, the temp file may exist in a
        # partial state; removing it keeps the output directory
        # clean. A cleanup failure is swallowed — the original
        # error is what the caller needs to see.
        _safe_unlink(temp_file)
        return 1

    try:
        temp_file.replace(output_file)
    except Exception as exc:
        log_error(f"export_docx: could not finalize export: {exc}")
        _safe_unlink(temp_file)
        return 1

    # ---- 6. Success ----
    log_success(f"Exported article to {output_file.name}")
    return 0


# =============================================================================
#  Private: document building
# =============================================================================

def _build_document(markdown_text: str) -> Document:
    """
    Convert a Markdown article into a python-docx `Document`
    object.

    The document is built by iterating the Markdown source's
    block-level structure and calling the appropriate `_add_*`
    helper for each block. See the module docstring's "parsing
    model" section for the reasoning behind the hand-rolled
    line-by-line parser rather than a general-purpose Markdown
    library.

    The function returns the `Document` object; the caller is
    responsible for saving it. Returning the in-memory
    representation rather than the saved file means the
    conversion logic is testable without filesystem access — a
    caller can build a document from a Markdown string and
    assert on its structure without ever touching disk.

    Never raises for a well-formed Markdown input. A malformed
    input — an unbalanced code fence, an empty heading — is
    handled by the individual block parsers, which fall back to
    treating the input as plain text.

    Args:
        markdown_text: The article's Markdown source, with
                       frontmatter already stripped.

    Returns:
        The populated `Document` object.
    """
    # The default document template is used as-is. The user's
    # Word installation applies its own Normal and Heading
    # styles when the file is opened, which is the behavior the
    # user expects — the docx carries the article's structure,
    # and the user's Word carries the visual styling.
    document = Document()
    _parse_and_append(document, markdown_text)
    return document


def _parse_and_append(document: Document, markdown_text: str) -> None:
    """
    Walk the Markdown text line by line, dispatch each block to
    its builder, and append the result to the document.

    The function reads the text into a list of lines and iterates
    with an explicit index rather than a `for` loop, because
    several of the block types — code fences, block quotes,
    multi-line paragraphs — consume a variable number of
    consecutive lines and need to advance the index past the
    lines they consumed. An indexed `while` loop is the shape
    that accommodates that consumption pattern; a `for` loop
    would leave the inner block parsers responsible for skipping
    lines they had already processed, which is harder to reason
    about.

    See the module docstring for the rationale on the hand-rolled
    parser.

    Args:
        document:      The `Document` object to append to.
        markdown_text: The Markdown source.
    """
    lines = markdown_text.split("\n")
    total = len(lines)
    i = 0

    while i < total:
        stripped = lines[i].rstrip()

        # ---- Blank line: paragraph separator ----
        if not stripped.strip():
            i += 1
            continue

        # ---- Code fence ----
        # Checked first because a fence's content may itself
        # contain characters that match the other block patterns
        # (a `# comment` inside a shell snippet, a `- item` inside
        # a YAML block). Consuming the fence before any other
        # pattern sees its content is what keeps the snippet's
        # text intact.
        if _CODE_FENCE_PATTERN.match(stripped):
            i = _consume_code_block(document, lines, i)
            continue

        # ---- Heading ----
        heading_match = _HEADING_PATTERN.match(stripped)
        if heading_match:
            hashes = heading_match.group(1)
            level = min(len(hashes), 6)
            text = heading_match.group(2).strip()
            _add_heading(document, level, text)
            i += 1
            continue

        # ---- Horizontal rule ----
        # Checked before the bullet pattern because a run of
        # three or more `-` characters matches both — the bullet
        # pattern requires trailing content and the HR pattern
        # does not, so only the HR pattern can match a bare
        # `---`.
        if _HR_PATTERN.match(stripped):
            _add_horizontal_rule(document)
            i += 1
            continue

        # ---- Blockquote ----
        if _BLOCKQUOTE_PATTERN.match(stripped):
            i = _consume_blockquote(document, lines, i)
            continue

        # ---- Unordered list item ----
        bullet_match = _BULLET_PATTERN.match(stripped)
        if bullet_match:
            _add_bullet(document, bullet_match.group(1))
            i += 1
            continue

        # ---- Ordered list item ----
        number_match = _NUMBER_PATTERN.match(stripped)
        if number_match:
            _add_number(document, number_match.group(1))
            i += 1
            continue

        # ---- Regular paragraph ----
        # The fallthrough case. Everything that is not one of the
        # structured block types above is prose.
        i = _consume_paragraph(document, lines, i)


def _consume_code_block(
    document: Document,
    lines: list,
    start: int,
) -> int:
    """
    Consume a fenced code block starting at `start` and append
    it to the document. Returns the index of the first line
    after the block.

    A code block starts with a line matching
    `_CODE_FENCE_PATTERN` and ends with the next line matching
    the same pattern. The lines between the two fences are the
    code block's content. An opening fence with no matching
    closing fence consumes every remaining line — the fallback
    for a malformed input is to treat the rest of the document
    as code rather than to lose the content silently.

    Args:
        document: The `Document` to append to.
        lines:    The document's lines.
        start:    The index of the opening fence line.

    Returns:
        The index of the first line after the code block.
    """
    i = start + 1
    code_lines = []
    total = len(lines)
    while i < total and not _CODE_FENCE_PATTERN.match(lines[i]):
        code_lines.append(lines[i])
        i += 1
    # Skip the closing fence, if one was found.
    if i < total:
        i += 1
    _add_code_block(document, code_lines)
    return i


def _consume_blockquote(
    document: Document,
    lines: list,
    start: int,
) -> int:
    """
    Consume a blockquote starting at `start` and append it to
    the document. Returns the index of the first line after the
    blockquote.

    A blockquote is one or more consecutive lines whose start
    matches `_BLOCKQUOTE_PATTERN`. The matched text on each line
    is the line's content with the leading `>` and its optional
    following space removed. The lines are joined with a single
    space, matching Markdown's soft-wrap rule.

    Args:
        document: The `Document` to append to.
        lines:    The document's lines.
        start:    The index of the first blockquote line.

    Returns:
        The index of the first line after the blockquote.
    """
    i = start
    quote_parts = []
    total = len(lines)
    while i < total:
        match = _BLOCKQUOTE_PATTERN.match(lines[i].rstrip())
        if not match:
            break
        quote_parts.append(match.group(1))
        i += 1
    text = " ".join(part for part in quote_parts if part.strip())
    if text.strip():
        _add_blockquote(document, text)
    return i


def _consume_paragraph(
    document: Document,
    lines: list,
    start: int,
) -> int:
    """
    Consume a plain paragraph starting at `start` and append it
    to the document. Returns the index of the first line after
    the paragraph.

    A paragraph is a maximal run of consecutive non-blank lines
    that do not begin another block type — a heading, a code
    fence, a blockquote, a list item, or a horizontal rule. The
    lines are joined with a single space, matching Markdown's
    soft-wrap rule.

    The line-classification check is duplicated from
    `_parse_and_append` rather than factored into a shared
    predicate because the paragraph-collection loop needs to
    check every block-starting pattern at once, and the dispatch
    loop checks one pattern at a time in priority order. Sharing
    the check would force both loops to call through a common
    helper that recomputed the same matches, which is more code
    for less clarity than the small duplication.

    Args:
        document: The `Document` to append to.
        lines:    The document's lines.
        start:    The index of the first paragraph line.

    Returns:
        The index of the first line after the paragraph.
    """
    i = start
    paragraph_parts = []
    total = len(lines)
    while i < total:
        line = lines[i].rstrip()
        if not line.strip():
            break
        if _CODE_FENCE_PATTERN.match(line):
            break
        if _HEADING_PATTERN.match(line):
            break
        if _HR_PATTERN.match(line):
            break
        if _BLOCKQUOTE_PATTERN.match(line):
            break
        if _BULLET_PATTERN.match(line):
            break
        if _NUMBER_PATTERN.match(line):
            break
        paragraph_parts.append(line)
        i += 1
    text = " ".join(paragraph_parts)
    if text.strip():
        _add_paragraph(document, text)
    return i


# =============================================================================
#  Private: block-level builders
# =============================================================================

def _add_heading(
    document: Document,
    level: int,
    text: str,
) -> None:
    """
    Append a heading at the given level, with inline formatting
    (bold, italic, etc.) applied to its content.

    The `python-docx` `add_heading` helper takes a plain string
    and produces a heading whose text is unstyled. That is
    sufficient for a heading like `# Introduction`, but not for
    a heading that contains inline emphasis — `## *Important*
    considerations` — where the user expects the word
    "Important" to render in italic.

    This function therefore calls `add_heading` with an empty
    string and then applies the inline-run parser to the heading
    text, adding the parsed runs to the heading's paragraph. The
    paragraph's style is set by `add_heading`; the runs are what
    this function populates.

    Args:
        document: The `Document` to append to.
        level:    The heading level, 1–6.
        text:     The heading's raw Markdown text (without the
                  leading `#` characters).
    """
    # `add_heading` accepts levels 0–9 in python-docx. Level 0
    # gives the document "Title" style; levels 1–9 give
    # "Heading 1" through "Heading 9". The parser clamps to 1–6
    # (Markdown's own maximum) so the value passed here is
    # always in range.
    clamped_level = max(1, min(6, level))
    heading = document.add_heading("", level=clamped_level)
    _add_inline_runs(heading, text)


def _add_paragraph(document: Document, text: str) -> None:
    """
    Append a plain paragraph with inline formatting applied.

    The paragraph's style is the document's default "Normal"
    style — no explicit style is set. That is the correct
    behavior for a body paragraph: the user's Word template
    applies its own Normal style, and the article inherits it.

    Args:
        document: The `Document` to append to.
        text:     The paragraph's raw Markdown text.
    """
    paragraph = document.add_paragraph()
    _add_inline_runs(paragraph, text)


def _add_bullet(document: Document, text: str) -> None:
    """
    Append a bulleted list item with inline formatting applied.

    Uses the "List Bullet" style that python-docx's default
    template ships. The style carries the bullet glyph, the
    left-indent that positions the item, and the paragraph
    spacing that distinguishes list items from body paragraphs
    — all of which would have to be set explicitly if the style
    were not used.

    Args:
        document: The `Document` to append to.
        text:     The item's raw Markdown text (without the
                  leading bullet marker).
    """
    paragraph = document.add_paragraph(style="List Bullet")
    _add_inline_runs(paragraph, text)


def _add_number(document: Document, text: str) -> None:
    """
    Append a numbered list item with inline formatting applied.

    Uses the "List Number" style that python-docx's default
    template ships. Word's numbering is automatic — each
    successive item added with this style increments the
    counter, and a non-list paragraph between two items resets
    it. That matches the pipeline's writer output, where a
    numbered list is a self-contained block.

    Args:
        document: The `Document` to append to.
        text:     The item's raw Markdown text (without the
                  leading number and period).
    """
    paragraph = document.add_paragraph(style="List Number")
    _add_inline_runs(paragraph, text)


def _add_blockquote(document: Document, text: str) -> None:
    """
    Append a blockquote paragraph with inline formatting applied
    and a left-indent that visually distinguishes it from a
    normal paragraph.

    Uses the "Quote" style that python-docx's default template
    ships — which applies an italic font that Word's own
    documentation associates with the style. On top of that, a
    left-indent is applied so the blockquote reads as an
    indented passage rather than as just-italic body text. The
    indent value is the `_QUOTE_INDENT_INCHES` constant.

    Args:
        document: The `Document` to append to.
        text:     The blockquote's raw Markdown text (with the
                  leading `>` characters already removed).
    """
    paragraph = document.add_paragraph(style="Quote")
    paragraph.paragraph_format.left_indent = Inches(
        _QUOTE_INDENT_INCHES
    )
    _add_inline_runs(paragraph, text)


def _add_code_block(document: Document, lines: list) -> None:
    """
    Append a code block — one paragraph per line, in a monospace
    font, with no paragraph spacing between lines.

    A code block is conceptually one unit, but Word represents
    it as a sequence of paragraphs, one per line, because Word
    has no native "code block" construct that spans multiple
    lines with preserved internal line breaks. Setting each
    line's paragraph spacing to zero and using a monospace font
    is what makes the sequence read as a single block rather
    than as a list of one-line paragraphs.

    The font is the `_MONOSPACE_FONT` constant ("Consolas").
    python-docx's `run.font.name` setting applies to the ASCII
    and high-ANSI fonts; the East Asian and complex-script
    fonts are set explicitly so a code block that happens to
    contain a non-Latin character also renders in monospace.

    An empty code block (a fence immediately followed by another
    fence) produces no output — there are no lines to append.

    Args:
        document: The `Document` to append to.
        lines:    The code block's lines, without the fences.
    """
    for line in lines:
        paragraph = document.add_paragraph()
        # Zero paragraph spacing so successive lines sit flush.
        paragraph.paragraph_format.space_before = Pt(0)
        paragraph.paragraph_format.space_after = Pt(0)
        run = paragraph.add_run(line)
        _set_monospace_font(run)


def _add_horizontal_rule(document: Document) -> None:
    """
    Append a horizontal rule.

    Word has no native horizontal-rule construct for docx
    documents — an HTML `<hr>` is not representable in Word's
    paragraph model. The closest equivalent is a paragraph whose
    bottom border is a horizontal line, which is what this
    function produces: an empty paragraph with a bottom border.

    The bottom-border technique is the standard way to draw a
    horizontal rule in a docx; it produces a line that spans the
    paragraph's width without introducing a visible character or
    a separate drawing object.

    Args:
        document: The `Document` to append to.
    """
    paragraph = document.add_paragraph()
    # Reduce the paragraph's height to a minimum — a horizontal
    # rule paragraph should be one thin line tall, not the
    # height of a normal text line. The `space_before` and
    # `space_after` values leave a small gap above and below the
    # rule so it does not collide with its neighbors.
    paragraph.paragraph_format.space_before = Pt(6)
    paragraph.paragraph_format.space_after = Pt(6)

    # Add the bottom border via the paragraph's XML properties.
    # The border is a single 6-eighth-point (0.75pt) line in the
    # document's automatic color, spanning the paragraph's width.
    pPr = paragraph._element.get_or_add_pPr()
    pBdr = OxmlElement("w:pBdr")
    bottom = OxmlElement("w:bottom")
    bottom.set(qn("w:val"), "single")
    bottom.set(qn("w:sz"), "6")
    bottom.set(qn("w:space"), "1")
    bottom.set(qn("w:color"), "auto")
    pBdr.append(bottom)
    pPr.append(pBdr)


# =============================================================================
#  Private: inline formatting
# =============================================================================

def _add_inline_runs(paragraph, text: str) -> None:
    """
    Parse a text fragment's inline Markdown and add the
    resulting runs to a paragraph.

    The text is scanned by `_INLINE_PATTERN`, which recognizes
    the seven inline constructs the writer step produces: bold
    (`**...**` or `__...__`), italic (`*...*` or `_..._`),
    bold-italic (`***...***`), inline code (`` `...` ``),
    links (`[text](url)`), and image placeholders
    (`![alt](url)`). Text between matches is added as plain
    runs.

    Bold and italic runs are produced by setting the
    corresponding attribute on a `Run` object
    (`run.bold = True`, `run.italic = True`). Inline code runs
    get a monospace font. Link constructs are handled by
    `_add_hyperlink`, which builds the hyperlink's XML directly
    — python-docx does not expose an `add_hyperlink` method, so
    the link has to be constructed by hand. Image constructs are
    rendered as plain-text placeholders of the form
    `[Image: alt]` — see the module docstring for the reasoning.

    A link that contains emphasis within its text
    (`[**important** link](url)`) is rendered with its full
    text as the link's display text; the emphasis markers
    inside the link text are preserved verbatim rather than
    being re-parsed as emphasis. This is a deliberate
    simplification: the writer step does not produce links
    with styled text, and the alternative — recursively
    parsing the link's text for emphasis — would produce a
    hyperlink whose runs needed to be styled individually,
    which is significantly more XML manipulation for a case
    that does not occur in practice.

    Never raises. A match that does not resolve to a recognized
    construct falls through to a plain run of the match's
    original text, which is the correct behavior for a Markdown
    source that uses a construct this parser does not recognize.

    Args:
        paragraph: The `python-docx` `Paragraph` to add runs to.
        text:      The text to parse.
    """
    last_end = 0
    for match in _INLINE_PATTERN.finditer(text):
        # ---- Emit any plain text before this match ----
        if match.start() > last_end:
            plain = text[last_end:match.start()]
            if plain:
                paragraph.add_run(plain)

        # ---- Emit the formatted run ----
        bold_italic = match.group("bold_italic")
        bold_stars = match.group("bold_stars")
        italic_stars = match.group("italic_stars")
        bold_underscores = match.group("bold_underscores")
        italic_underscores = match.group("italic_underscores")
        code = match.group("code")
        link = match.group("link")
        image = match.group("image")

        if bold_italic is not None:
            content = bold_italic[3:-3]
            run = paragraph.add_run(content)
            run.bold = True
            run.italic = True
        elif bold_stars is not None:
            content = bold_stars[2:-2]
            run = paragraph.add_run(content)
            run.bold = True
        elif italic_stars is not None:
            content = italic_stars[1:-1]
            run = paragraph.add_run(content)
            run.italic = True
        elif bold_underscores is not None:
            content = bold_underscores[2:-2]
            run = paragraph.add_run(content)
            run.bold = True
        elif italic_underscores is not None:
            content = italic_underscores[1:-1]
            run = paragraph.add_run(content)
            run.italic = True
        elif code is not None:
            content = code[1:-1]
            run = paragraph.add_run(content)
            _set_monospace_font(run)
        elif link is not None:
            # Parse the link's text and URL out of the match.
            link_match = re.match(
                r"\[([^\]]+)\]\(([^)]+)\)", link
            )
            if link_match:
                link_text = link_match.group(1)
                link_url = link_match.group(2)
                _add_hyperlink(paragraph, link_url, link_text)
            else:
                # The match shape cannot be re-parsed — an
                # unexpected but not impossible case if a
                # future change to the pattern altered the
                # match's syntax. Falling through to a plain
                # run keeps the text visible rather than
                # dropping it.
                paragraph.add_run(link)
        elif image is not None:
            # Render the image construct as a plain-text
            # placeholder. See the module docstring for the
            # rationale on not embedding images.
            image_match = re.match(
                r"!\[([^\]]*)\]\(([^)]*)\)", image
            )
            if image_match:
                alt_text = image_match.group(1).strip()
                placeholder = (
                    f"[Image: {alt_text}]"
                    if alt_text
                    else "[Image]"
                )
                run = paragraph.add_run(placeholder)
                run.italic = True
                log_warning(
                    f"export_docx: image construct found in "
                    f"article, rendered as text: {placeholder}"
                )
            else:
                paragraph.add_run(image)

        last_end = match.end()

    # ---- Emit any trailing plain text ----
    if last_end < len(text):
        tail = text[last_end:]
        if tail:
            paragraph.add_run(tail)


def _set_monospace_font(run) -> None:
    """
    Apply the monospace font to a `Run` object, setting the
    ASCII, high-ANSI, East Asian, and complex-script font names.

    python-docx's `run.font.name = "..."` setter applies the
    name to the ASCII and high-ANSI font slots only. On a run
    whose content includes a non-Latin character — a code block
    with a Unicode operator, a phrase in a non-English script —
    Word uses the East Asian or complex-script slot for that
    character, and a run whose slot for that script is unset
    renders in the document's default font instead of the
    monospace font.

    Setting all four slots is the standard way to make a
    monospace font apply to the entire run regardless of what
    characters it contains. The four slots and their `w:rFonts`
    attribute names are:

      * `w:ascii`    — plain ASCII characters
      * `w:hAnsi`    — Western European high-ANSI characters
      * `w:eastAsia` — CJK and other East Asian characters
      * `w:cs`       — complex-script characters (Arabic, etc.)

    The function reaches into the run's XML element to set the
    last two slots because python-docx does not expose them
    through its `font.name` property. The manipulation is
    small and self-contained.

    Never raises. An exception during the XML manipulation is
    caught and logged; the run keeps whatever font
    `run.font.name` set (which is the ASCII and high-ANSI
    slots), and the non-Latin characters fall back to the
    document's default font. That is a degraded but functional
    result.

    Args:
        run: The `python-docx` `Run` to apply the font to.
    """
    run.font.name = _MONOSPACE_FONT
    try:
        rPr = run._element.get_or_add_rPr()
        rFonts = rPr.find(qn("w:rFonts"))
        if rFonts is None:
            # `run.font.name` should have created the
            # `w:rFonts` element, but the defensive check
            # covers the case where it did not.
            rFonts = OxmlElement("w:rFonts")
            rPr.append(rFonts)
        rFonts.set(qn("w:ascii"), _MONOSPACE_FONT)
        rFonts.set(qn("w:hAnsi"), _MONOSPACE_FONT)
        rFonts.set(qn("w:eastAsia"), _MONOSPACE_FONT)
        rFonts.set(qn("w:cs"), _MONOSPACE_FONT)
    except Exception as exc:
        log_warning(
            f"export_docx: could not set full font slots "
            f"({exc}); the run keeps its ASCII font"
        )


def _add_hyperlink(paragraph, url: str, text: str) -> None:
    """
    Append a hyperlink to a paragraph.

    python-docx does not expose an `add_hyperlink` method — its
    documented public API for external links stops at the
    relationship API. Building a hyperlink therefore requires
    three things:

      1. Adding a relationship from the document's part to the
         target URL, with the relationship type `HYPERLINK` and
         `is_external=True`. This registers the URL with the
         document's package, which is what makes the link a live
         link rather than a plain-text URL.

      2. Building a `w:hyperlink` XML element, setting its
         `r:id` attribute to the relationship id returned by
         step 1, and setting the element's `w:history`
         attribute to `1` so Word treats it as a visited link.

      3. Adding a `w:r` (run) element inside the hyperlink, with
         a `w:rPr` (run properties) block that styles the run
         as a hyperlink — blue and underlined. Word uses the
         "Hyperlink" character style for hyperlinks it inserts
         itself; setting the color and underline explicitly
         produces the same appearance without requiring the
         character style to be present in the document's
         template.

    The three steps are what this function performs. The
    resulting hyperlink is indistinguishable in Word from one
    inserted through the UI.

    The URL is truncated at 2048 characters — the maximum a URL
    can be in a docx without Word raising a repair prompt on
    open. An over-long URL is far more likely to be a corrupted
    value from a malformed Markdown source than a genuine long
    link; truncating rather than skipping preserves the text.

    Never raises. An exception during the XML manipulation —
    which would indicate a python-docx internal error — is
    caught and logged; the link's display text is added as a
    plain run so the user still sees the words.

    Args:
        paragraph: The `python-docx` `Paragraph` to add the
                   hyperlink to.
        url:       The hyperlink target URL.
        text:      The hyperlink's display text.
    """
    # Truncate the URL to a length Word will accept without
    # raising a repair prompt on open.
    trimmed_url = url.strip()
    if len(trimmed_url) > 2048:
        trimmed_url = trimmed_url[:2048]

    try:
        part = paragraph.part
        r_id = part.relate_to(
            trimmed_url,
            RELATIONSHIP_TYPE.HYPERLINK,
            is_external=True,
        )

        hyperlink = OxmlElement("w:hyperlink")
        hyperlink.set(qn("r:id"), r_id)
        hyperlink.set(qn("w:history"), "1")

        new_run = OxmlElement("w:r")
        rPr = OxmlElement("w:rPr")

        # Style the run as a hyperlink: blue, underlined. The
        # specific color and underline values are the ones Word
        # uses for its own "Hyperlink" character style.
        color = OxmlElement("w:color")
        color.set(qn("w:val"), _HYPERLINK_COLOR_HEX)
        rPr.append(color)

        u = OxmlElement("w:u")
        u.set(qn("w:val"), "single")
        rPr.append(u)

        new_run.append(rPr)

        # Set the run's text. The `xml:space="preserve"`
        # attribute is required for the run to keep leading or
        # trailing whitespace; without it, Word strips the
        # whitespace from the rendered link.
        t = OxmlElement("w:t")
        t.text = text
        t.set(qn("xml:space"), "preserve")
        new_run.append(t)

        hyperlink.append(new_run)
        paragraph._p.append(hyperlink)
    except Exception as exc:
        log_warning(
            f"export_docx: could not add hyperlink for "
            f"'{trimmed_url}' ({exc}); falling back to plain text"
        )
        paragraph.add_run(text)


# =============================================================================
#  Private: filesystem helpers
# =============================================================================

def _safe_unlink(path: Path) -> None:
    """
    Remove a file, swallowing any error.

    Used to clean up a temporary file when a save or rename has
    failed. The caller has already reported the failure that
    caused the cleanup attempt; a subsequent cleanup failure is
    not the error the user needs to see, and a cleanup attempt
    that itself raised would mask the original error. The
    function therefore returns silently on any exception,
    including the common case where the file simply does not
    exist because the failure happened before it was created.

    Args:
        path: The path to remove.
    """
    try:
        if path.exists():
            path.unlink()
    except Exception:
        pass


# =============================================================================
#  Default export
# =============================================================================

__all__ = [
    "run_export",
]