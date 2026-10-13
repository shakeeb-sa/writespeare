#!/usr/bin/env python3
"""
core/file_io.py — file-system I/O for the WriteSpeare pipeline.

Owns the on-disk layout for everything the pipeline writes: the
topic folders (`topics/<topic>/sources/`, `.../article/`,
`.../reports/`), the `.md` doc files the extractors produce, and
the atomic-write primitive every writer uses.

Every script that puts bytes on disk goes through this module so
the layout is defined in exactly one place. A reader who wants to
know "where does a doc file live?" reads one file — this one.

The on-disk layout:

    <appData>/writespeare/topics/
        <topic>/
            topic.json      written by the Electron main process
                            (not by this module — read only here)
            sources/        one .md file per scraped page
                001-<slug>.md
                002-<slug>.md
                ...
            article/        the writer step's output
                draft-01.md
                draft-02.md   (regeneration produces a new draft)
            reports/        the validation step's output
                report-<article-id>.json

    The <appData> base is:
        Windows: %APPDATA%           (roaming app data)
        macOS:   ~/Library/Application Support
        Linux:   ~/.config

    The `writespeare` subfolder name is hardcoded. It must match
    the path the Electron main process uses when it writes
    `topic.json` and when it passes the topic's folder name to
    this pipeline. The convention mirrors the one used elsewhere
    in the codebase (the ROOKIE-derived child-process manager
    writes its images to `<appData>/rookie/images/` under the
    same rule).

Why "topic_id" is treated as an opaque folder name:

    The plan's `write_doc(topic_id, slug, content, metadata)`
    signature names the first argument `topic_id`, which could
    mean either the database's Mongo ObjectId or the folder-safe
    slug the app uses on disk. The convention this module adopts
    is the latter — the topic's folder name.

    The caller (the Electron main process, via `main.py`) is
    responsible for the naming: it computes the folder name once
    when the topic is created (the plan's user journey describes
    it as "<slugified-title>-<short-id>", for example
    "small-space-gardening-a3f2") and passes that same string
    through every Python invocation for the topic. This module
    does not re-derive the name; it treats the argument as opaque.

    That choice keeps this module free of any knowledge about how
    the topic's title is slugified or how many characters of the
    ObjectId are used — details that belong to the Electron side
    and that a future session might change without wanting to
    touch every Python file.

Why frontmatter serialization is hand-written:

    The doc files carry a YAML frontmatter block:

        ---
        url: "https://example.com/page"
        title: "How to garden in a tiny apartment"
        platform: "reddit"
        word_count: 1847
        fetched_at: "2026-10-10T21:42:50Z"
        ---

    PyYAML would serialize this cleanly, but it is not a direct
    dependency — it arrives transitively via transformers, and
    relying on a transitive dependency is the class of fragility
    that produces "works on my machine" bugs. This module writes
    its own minimal serializer that handles exactly the value
    types frontmatter needs: strings (always double-quoted, with
    backslashes and quotes escaped), integers, floats, booleans,
    and None. It does not attempt to serialize lists, nested
    dicts, or dates — if a future session needs those, the
    serializer gains one branch per type, and the escape rules
    are documented alongside the code.

    The reading side is not implemented, because nothing in the
    current plan reads YAML frontmatter back. The doc files are
    read for their body text only — via `read_doc()`, which
    returns the file as-is, and via
    `core.extractor.strip_frontmatter()`, which removes the
    frontmatter block when the body is what matters.

Atomic writes:

    Every write in this module goes through `write_text_atomic`:
    the bytes land in a temporary file (`.md.tmp`) alongside the
    destination, and the temporary file is renamed over the
    destination with `Path.replace`. On POSIX, `rename` is
    atomic; on Windows, `Path.replace` maps to `MoveFileEx` with
    the `MOVEFILE_REPLACE_EXISTING` flag, which is also atomic at
    the filesystem level. The result is that a reader — another
    process, a file watcher, the user opening the file — sees
    either the old content or the new content, never a
    half-written file.

    This matters for the doc-writing path because the doc file
    is what the writer step reads. A partial file that a crash
    left behind would surface as truncated content in the
    generated article with no obvious cause. Atomic writes make
    that class of bug impossible: the file is either complete or
    it does not exist.

What this module does NOT do:

  * It does not fetch pages. That is the extractors' job.

  * It does not extract text from HTML. That is
    `core.extractor`'s job.

  * It does not parse the frontmatter it writes. See the
    "hand-written serialization" note above.

  * It does not touch `topic.json`. That file is written by the
    Electron main process; this module only reads it, via
    `read_json`, when a caller asks. No Python code writes it.

Dependencies: Python stdlib + jinja2 + the sibling `core.utils`
module. All declared in `requirements.txt`.
"""

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from jinja2 import Template
from jinja2.exceptions import TemplateError

from core.utils import log_debug, log_info, log_warning


# =============================================================================
#  Constants
# =============================================================================

# The app slug used as the top-level folder under the OS's
# per-user application-data directory. Hardcoded to match the
# Electron main process's convention; a change here must be
# reflected on the TS side in the same commit or the two halves
# of the app would look for files in different places.
_APP_SLUG = "writespeare"

# The name of the subfolder under the app slug that holds every
# topic. Every path this module returns begins with this folder.
_TOPICS_SUBFOLDER = "topics"

# The three per-topic subfolders. Each stage of the pipeline has
# its own — the extractors write to SOURCES, the writer to
# ARTICLE, the validator to REPORTS. Keeping them separate means
# a stage's output is never confused with another's, and a cleanup
# that removes one stage's files can do so without affecting the
# others.
_SOURCES_SUBFOLDER = "sources"
_ARTICLE_SUBFOLDER = "article"
_REPORTS_SUBFOLDER = "reports"

# The per-topic file that records URLs whose extraction failed.
# Written by `research/extract_dispatch.py` at the end of a batch
# that had at least one failure; read by the Electron main
# process when the Sources tab loads. Named here so the writer
# and the reader agree on the filename without either of them
# hardcoding the string.
_FAILURES_FILENAME = "failures.json"

# The subfolder under the app slug that holds the user's prompt
# templates. Lives at <appData>/writespeare/prompts/ — a sibling
# of `topics/`, not a child. The two-folder model puts user
# prompts here and the read-only built-in prompts under
# <scripts>/prompts/, and `resolve_prompt_path` checks this
# folder first so a user-supplied prompt shadows the built-in.
_PROMPTS_SUBFOLDER = "prompts"


# =============================================================================
#  Path resolution
# =============================================================================

def _app_data_root() -> Path:
    """
    Return the OS's per-user application-data directory.

    On Windows, this is `%APPDATA%` (the roaming profile's
    app-data folder — the same one Electron's `app.getPath('appData')`
    returns). On macOS, it is `~/Library/Application Support`. On
    every other platform, it is `~/.config` — the XDG base
    directory that Linux and BSD applications use.

    Raises `RuntimeError` if the resolved path cannot be created.
    The caller (every path helper in this module) relies on the
    return value being a real, writable directory; a path that
    cannot be created is a fatal configuration error and should
    surface as one, not as a confusing "file not found" error
    hundreds of lines later.
    """
    if sys.platform == "win32":
        # `APPDATA` is the roaming profile. `LOCALAPPDATA` is the
        # non-roaming one. Electron's `app.getPath('appData')`
        # returns the roaming folder, so we match.
        base = os.environ.get("APPDATA")
        if base:
            return Path(base)
        # Fallback: construct the canonical location from the
        # user's home directory. This path is what Windows uses
        # for a typical user; the environment variable check above
        # is the reliable path, and this is only used when it is
        # not set (a stripped-down runtime, a service account).
        return Path.home() / "AppData" / "Roaming"

    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support"

    # Linux, BSD, and anything else POSIX-y.
    return Path.home() / ".config"


def get_topics_root() -> Path:
    """
    Return the absolute path to the folder that contains every
    topic, one subfolder per topic.

    The folder is created if it does not exist — the first call in
    a fresh installation is what materialises it. Subsequent calls
    are no-ops on the filesystem (the `mkdir` with `exist_ok=True`
    is a syscall that returns immediately when the target already
    exists).

    Returns:
        `<appData>/writespeare/topics/`
    """
    root = _app_data_root() / _APP_SLUG / _TOPICS_SUBFOLDER
    root.mkdir(parents=True, exist_ok=True)
    return root


def get_topic_folder(topic_id: str) -> Path:
    """
    Return the absolute path to a single topic's folder.

    The `topic_id` argument is treated as an opaque folder name —
    see the module docstring for why. The folder is created if it
    does not exist.

    Args:
        topic_id: The topic's folder name. Not the Mongo ObjectId
                  unless the caller happens to use that as the
                  folder name; by convention it is a slug.

    Returns:
        `<appData>/writespeare/topics/<topic_id>/`
    """
    folder = get_topics_root() / topic_id
    folder.mkdir(parents=True, exist_ok=True)
    return folder


def get_sources_folder(topic_id: str) -> Path:
    """
    Return the topic's `sources/` folder — where extracted `.md`
    doc files live. Created if it does not exist.
    """
    folder = get_topic_folder(topic_id) / _SOURCES_SUBFOLDER
    folder.mkdir(parents=True, exist_ok=True)
    return folder


def get_article_folder(topic_id: str) -> Path:
    """
    Return the topic's `article/` folder — where the writer step
    saves its drafts. Created if it does not exist.
    """
    folder = get_topic_folder(topic_id) / _ARTICLE_SUBFOLDER
    folder.mkdir(parents=True, exist_ok=True)
    return folder


def get_reports_folder(topic_id: str) -> Path:
    """
    Return the topic's `reports/` folder — where the validation
    step saves its JSON reports. Created if it does not exist.
    """
    folder = get_topic_folder(topic_id) / _REPORTS_SUBFOLDER
    folder.mkdir(parents=True, exist_ok=True)
    return folder

def get_failures_path(topic_id: str) -> Path:
    """
    Return the absolute path to a topic's `failures.json` file.

    The file records URLs whose extraction failed, one record per
    URL, with the reason code, the accumulated attempt count, the
    timestamp of the most recent attempt, and the error message
    from that attempt. It is written by
    `research/extract_dispatch.py` at the end of every batch that
    had at least one failure, and read by the Electron main
    process when the Sources tab loads a topic.

    The file lives at the topic's folder root, not inside a
    subfolder — it is a property of the topic's whole extraction
    history, not of any one batch or stage.

    The file is NOT created by this function. A topic whose
    extractions have all succeeded has no `failures.json`, and
    the readers on both sides treat "file absent" and "empty
    list" as equivalent. Callers that write the file call
    `write_json_atomic(path, records)` on the return value of
    this helper; callers that read it check `.exists()` first.

    Args:
        topic_id: The topic's folder name.

    Returns:
        `<appData>/writespeare/topics/<topic_id>/failures.json`
    """
    return get_topic_folder(topic_id) / _FAILURES_FILENAME

def ensure_topic_folders(topic_id: str) -> None:
    """
    Create every folder the topic's pipeline will need, in one
    call.

    Called once at the start of a pipeline run (the search step,
    or the extract step when it runs standalone) so that a later
    stage that expects to find a folder never surprises the user
    by failing on a missing parent. Each individual path helper
    also creates its own folder on demand — the difference is
    that this function front-loads the work and produces a single
    clear diagnostic if the topic's folder cannot be created at
    all (a permissions problem on the appData root, for example).

    Args:
        topic_id: The topic's folder name.
    """
    get_sources_folder(topic_id)
    get_article_folder(topic_id)
    get_reports_folder(topic_id)
    log_debug(f"Ensured topic folders for '{topic_id}'")



# =============================================================================
#  Prompt path resolution
# =============================================================================
#
#  The two-folder model the plan's Q5.1 decision establishes:
#
#    * Built-in prompts ship with the app, read-only, under
#      <scripts>/prompts/ — the same folder `main.py` and the
#      sibling `core/`, `research/`, `writer/`, and `validation/`
#      packages live in.
#
#    * User prompts live under <appData>/writespeare/prompts/ —
#      a sibling of `topics/`, outside the app's install tree so
#      it survives an app upgrade.
#
#  `resolve_prompt_path` checks the user folder first. A user
#  prompt whose name matches a built-in one shadows the built-in
#  without destroying it: deleting the user's file reverts the
#  resolution to the built-in on the next call. That is the
#  behavior the plan's user journey describes.
#
#  The bundled folder's path is derived from this module's own
#  position on disk — `core/file_io.py` is two levels below the
#  scripts root, so `Path(__file__).parent.parent` is the scripts
#  root and appending `prompts/` gives the bundled folder. No
#  environment variable or CLI argument is involved: the bundled
#  prompts are always next to the scripts that read them, in both
#  the development tree and the packaged app's `extraResources`
#  layout.

def get_user_prompts_folder() -> Path:
    """
    Return the absolute path to the folder that holds the user's
    prompt templates.

    The folder is created if it does not exist — the first call
    in a fresh installation is what materialises it, so a caller
    that writes a new prompt file does not have to create the
    parent first.

    Returns:
        `<appData>/writespeare/prompts/`

    Note:
        This function creates the folder as a side effect. A
        caller that only wants to inspect whether the folder
        exists does not need to worry — the folder's existence is
        the default state of a working installation, and the
        folder will need to exist the moment the user saves their
        first prompt anyway.
    """
    folder = _app_data_root() / _APP_SLUG / _PROMPTS_SUBFOLDER
    folder.mkdir(parents=True, exist_ok=True)
    return folder


def resolve_prompt_path(name: str) -> Path:
    """
    Resolve a prompt file name to an absolute path using the
    two-folder lookup.

    Lookup order:

        1. `<appData>/writespeare/prompts/<name>` — the user's
           own prompts. If this exists, it wins.
        2. `<scripts>/prompts/<name>` — the built-in prompts that
           ship with the app.

    The user folder is checked first so a user-supplied prompt
    shadows the built-in of the same name without destroying it;
    deleting the user's file reverts the app to the built-in on
    the next resolution.

    Args:
        name: The prompt file's name, e.g. `"default.md"` or
              `"my-style.md"`. Must be a bare filename — see the
              Raises section.

    Returns:
        The absolute path to the file that won the lookup.

    Raises:
        ValueError:
            If `name` is empty, or contains a path separator
            (`/` or `\\`), or contains a `..` segment. The
            lookup is deliberately restricted to a single
            filename inside one of the two folders — a caller
            that passes a path is either confused or hostile,
            and either way this function will not traverse
            outside the two roots.
        FileNotFoundError:
            If neither folder contains a file with the given
            name. The caller is expected to surface this as "the
            prompt file could not be found" rather than silently
            substituting a built-in — a user who assigned a
            specific prompt to a topic and then deleted it needs
            to see the error, not a silent fallback to a
            different voice.
    """
    # ---- Reject names that would escape the two folders ----
    # A name like `"../../etc/passwd"` would resolve outside both
    # roots if it were joined blindly. The check below rejects
    # any name that is not a plain filename. The `..` check is
    # technically redundant with the separator check for a name
    # like `"../foo"`, but a name like `".."` on its own has no
    # separator and would still escape. Both checks are cheap.
    if not name or "/" in name or "\\" in name or ".." in name:
        raise ValueError(
            f"Invalid prompt file name: {name!r}. Must be a bare "
            f"filename with no path separators or '..' segments."
        )

    # ---- Folder 1: the user's prompts ----
    user_candidate = get_user_prompts_folder() / name
    if user_candidate.is_file():
        return user_candidate

    # ---- Folder 2: the bundled prompts ----
    bundled_candidate = (
        Path(__file__).resolve().parent.parent
        / _PROMPTS_SUBFOLDER
        / name
    )
    if bundled_candidate.is_file():
        return bundled_candidate

    raise FileNotFoundError(
        f"Prompt file {name!r} was not found in either the user "
        f"prompts folder ({get_user_prompts_folder()}) or the "
        f"bundled prompts folder."
    )
# =============================================================================
#  Atomic writes
# =============================================================================

def write_text_atomic(path: Path, content: str) -> None:
    """
    Write `content` to `path` atomically.

    The bytes are first written to a sibling file named
    `<path>.tmp`, then renamed over `path`. See the module
    docstring's "Atomic writes" section for why the rename is the
    correct primitive on both POSIX and Windows.

    The parent directory is created if it does not exist, so a
    caller that constructs a path for a folder it has not yet
    asked this module to create does not have to check first.

    Encoding is UTF-8 throughout. The pipeline's content carries
    characters from every writing system the web carries; UTF-8 is
    the only encoding that handles all of them without loss, and
    it is what the reader side (`read_doc`, `read_prompt_template`)
    decodes with. A mismatch between the two encodings would
    produce mojibake on any non-ASCII character, which is exactly
    the class of bug that is hard to spot in English-only testing.

    Args:
        path:    The destination file's absolute path.
        content: The text to write.

    Raises:
        OSError if the destination's parent cannot be created, if
        the temporary file cannot be written, or if the rename
        fails. The caller is expected to let the exception
        propagate — an unrecoverable filesystem error is not
        something a script can meaningfully continue past.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    tmp_path.write_text(content, encoding="utf-8")
    # `Path.replace` is the cross-platform atomic rename. On
    # Windows it maps to `MoveFileEx(..., MOVEFILE_REPLACE_EXISTING)`,
    # which is atomic at the filesystem level; on POSIX it is
    # `rename(2)`, which is atomic by definition.
    tmp_path.replace(path)


def write_json_atomic(path: Path, data: dict) -> None:
    r"""
    Write `data` as UTF-8 JSON to `path` atomically.

    The serialization uses `indent=2` and `ensure_ascii=False`:
    the output is human-readable (a user who opens the file in a
    text editor can see the structure) and any non-ASCII
    characters in the data survive as themselves rather than as
    `\uXXXX` escapes. The `sort_keys=False` default is kept — the
    caller's key order is preserved, which matters when the file
    is a report whose sections have a natural reading order.

    Args:
        path: The destination file's absolute path.
        data: A JSON-serializable dict.
    """
    serialized = json.dumps(data, indent=2, ensure_ascii=False)
    write_text_atomic(path, serialized)


# =============================================================================
#  Frontmatter serialization
# =============================================================================

def _yaml_scalar(value: Any) -> str:
    """
    Serialize a single scalar value as a YAML fragment.

    The function covers the five types frontmatter actually uses:

        str       → a double-quoted string with backslashes and
                    double-quotes escaped. Double-quoting is the
                    universal escape hatch in YAML — every string
                    that could be misinterpreted (leading
                    whitespace, a colon followed by a space, a
                    leading `#`, a bare number) is unambiguous
                    when double-quoted, and the escaping rules are
                    simple enough to state in one line.
        int       → the decimal representation, unquoted.
        float     → the decimal representation, unquoted. `NaN`
                    and `Infinity` are not valid YAML scalars;
                    they are emitted as `.nan` and `.inf`, which
                    is YAML's own convention for those values.
        bool      → `true` or `false` (lowercase — YAML's
                    convention, and the one PyYAML would emit).
        None      → `null` (YAML's representation of the null
                    value, matching what PyYAML emits).

    Any other type raises `TypeError`. That is deliberate: a
    caller that passed a list or a nested dict by mistake
    deserves a clear error at the write site, not a silently
    malformed YAML document that only breaks when the file is
    read back by a tool this module does not control.
    """
    if value is None:
        return "null"
    if isinstance(value, bool):
        # `bool` is a subclass of `int` in Python, so this check
        # must come BEFORE the int check — otherwise `True` would
        # serialise as "1".
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        # Python's repr for float matches YAML's expectations for
        # finite values; the two special cases are handled
        # explicitly because Python's repr produces "nan" and
        # "inf", which are not valid YAML scalars.
        if value != value:  # NaN check
            return ".nan"
        if value == float("inf"):
            return ".inf"
        if value == float("-inf"):
            return "-.inf"
        return repr(value)
    if isinstance(value, str):
        # Escape backslashes first (otherwise the escaping of
        # quotes below would double-escape the backslashes), then
        # double-quotes, then the two control characters that
        # would break the surrounding structure if left literal.
        escaped = (
            value
            .replace("\\", "\\\\")
            .replace('"', '\\"')
            .replace("\n", "\\n")
            .replace("\r", "\\r")
        )
        return f'"{escaped}"'
    raise TypeError(
        f"Unsupported frontmatter value type: {type(value).__name__}. "
        f"Only str, int, float, bool, and None are supported."
    )


def _build_frontmatter(metadata: dict) -> str:
    """
    Build a YAML frontmatter block from a metadata dict, including
    the leading and trailing `---` delimiters and the trailing
    newline that separates the block from the body.

    The order of the keys in the output matches the insertion
    order of the dict, which matches the order the caller added
    them. That convention lets a caller present the frontmatter
    fields in a deliberate reading order (url, then title, then
    the rest) without this module having to know which fields are
    which.

    An empty metadata dict produces an empty string — the caller
    that has no metadata gets a file with no frontmatter, not a
    file with an empty `---\\n---\\n` block.
    """
    if not metadata:
        return ""

    lines = ["---"]
    for key, value in metadata.items():
        lines.append(f"{key}: {_yaml_scalar(value)}")
    lines.append("---")
    lines.append("")  # blank line between frontmatter and body
    return "\n".join(lines) + "\n"


# =============================================================================
#  Doc files
# =============================================================================

def write_doc(
    topic_id: str,
    slug: str,
    content: str,
    metadata: dict,
) -> Path:
    """
    Write a doc file into the topic's `sources/` folder, with YAML
    frontmatter and the given body, and return the file's absolute
    path.

    The file's name is `<slug>.md`. The caller is responsible for
    the slug's content — a conventional choice is a zero-padded
    index followed by a `slugify`-ed fragment of the page's title
    (for example `001-reddit-how-to-garden`), which is what the
    plan's user journey shows in its progress panel. This module
    does not enforce that convention; it accepts whatever slug it
    is given and appends `.md`.

    The metadata dict is composed into the frontmatter block — see
    `_build_frontmatter` for the serialization details and the
    supported value types. The keys are preserved in the order the
    caller added them.

    The write is atomic (see `write_text_atomic`). If the
    destination file already exists, it is overwritten — the
    caller is responsible for choosing a slug that does not
    collide with an existing file's, or for accepting that a
    re-run of the extraction replaces the previous output.

    The full file is:
        ---
        <frontmatter keys and values>
        ---

        <content>

    with a single blank line between the closing `---` and the
    first line of the body — the standard Markdown-with-frontmatter
    layout every Markdown parser recognises.

    Args:
        topic_id: The topic's folder name.
        slug:     The doc file's name, without the `.md` extension.
        content:  The doc file's body, as Markdown.
        metadata: A dict of frontmatter fields. Values must be
                  strings, ints, floats, booleans, or None. An
                  empty dict produces a file with no frontmatter
                  block.

    Returns:
        The absolute path to the file that was written.

    Raises:
        ValueError if the slug is empty. An empty slug would
        produce a file named `.md` — a hidden file on POSIX, and a
        file the caller could never identify. Rejecting the slug
        at the boundary is the correct behaviour.
    """
    cleaned_slug = slug.strip()
    if not cleaned_slug:
        raise ValueError(
            "write_doc: slug must be a non-empty string."
        )

    # The `sources/` folder is created on demand by the path
    # helper, so the write below never fails for a missing parent.
    sources_folder = get_sources_folder(topic_id)
    dest = sources_folder / f"{cleaned_slug}.md"

    frontmatter = _build_frontmatter(metadata)
    full_content = frontmatter + content

    write_text_atomic(dest, full_content)
    log_debug(
        f"Wrote doc '{cleaned_slug}.md' "
        f"({len(content)} chars) to {dest.parent.name}/"
    )
    return dest


def read_doc(path: Path) -> str:
    """
    Read a doc file's full content and return it as a string,
    including the frontmatter block if the file has one.

    The caller that wants the body only — the writer step, which
    pastes the body into a chat without the frontmatter — calls
    `core.extractor.strip_frontmatter()` on the result. The
    decision to keep this function whole-file rather than
    body-only is what lets a caller that DOES want the frontmatter
    (a future session that reads a doc's source URL from its
    metadata) use the same function.

    Decoding is UTF-8, matching the encoding the write side uses.
    A file that cannot be decoded as UTF-8 raises `UnicodeDecodeError`
    from the underlying `read_text` — the caller should let it
    propagate, because a doc file that is not valid UTF-8 is a
    corruption the pipeline should not silently paper over.

    Args:
        path: The file to read.

    Returns:
        The file's content as a string.

    Raises:
        FileNotFoundError if the file does not exist.
        UnicodeDecodeError if the file is not valid UTF-8.
    """
    return path.read_text(encoding="utf-8")


# =============================================================================
#  Prompt templates
# =============================================================================

def read_prompt_template(path: Path) -> str:
    """
    Read a prompt template file and return its content as a
    string.

    The template is expected to be a Jinja2 template — the
    plan's prompts (`default.md`, `seo-focused.md`,
    `conversational.md`) use Jinja2's `{{ variable }}` syntax to
    interpolate the topic's values. This function only reads the
    file; the rendering happens in `render_prompt`.

    Encoding is UTF-8, matching every other reader and writer in
    this module.

    Args:
        path: The template file to read.

    Returns:
        The template's content.

    Raises:
        FileNotFoundError if the template file does not exist.
    """
    return path.read_text(encoding="utf-8")


def render_prompt(template: str, vars: dict) -> str:
    """
    Render a Jinja2 template with the given variables.

    The function is a thin wrapper around Jinja2's `Template` —
    it exists to give the pipeline a single, named function for
    "render a prompt," so a caller does not have to import Jinja2
    directly and so a future change to the rendering strategy (a
    different template engine, a template cache, a strict-undefined
    mode) is a change to this one function.

    The `vars` dict is passed to `Template.render` as keyword
    arguments — `vars['title']` becomes `{{ title }}` in the
    template, `vars['word_count']` becomes `{{ word_count }}`, and
    so on. Every key must be a valid Python identifier (Jinja2's
    `render` takes a `**kwargs`, so a key that is not an
    identifier cannot be passed; a caller with such a key must
    rename it).

    If the template references a variable that is not in `vars`,
    Jinja2's default behaviour is to substitute an empty string —
    this is Jinja2's own default and is preserved here rather than
    overridden to a strict mode, because the plan's prompt
    templates are user-editable and a typo in a variable name
    should produce a template with a missing value, not a crash
    mid-generation.

    If the template is malformed (an unclosed `{{`, an invalid
    filter name), Jinja2 raises a `TemplateError` subclass. The
    function catches that, logs it at warning level, and re-raises
    it — the caller is expected to surface the failure to the user
    as "the prompt template is broken" rather than silently
    proceeding with an empty prompt. The warning log is what
    makes the diagnostic visible in the pipeline's own output.

    Args:
        template: The template string, as returned by
                  `read_prompt_template`.
        vars:     A dict of variable name → value.

    Returns:
        The rendered string.

    Raises:
        TemplateError if the template is malformed. The exception
        is logged at warning level before being re-raised.
    """
    try:
        return Template(template).render(**vars)
    except TemplateError as exc:
        log_warning(f"Prompt template failed to render: {exc}")
        raise


# =============================================================================
#  JSON helpers
# =============================================================================

def read_json(path: Path) -> dict:
    """
    Read a JSON file and return the parsed dict.

    Used by callers that need to inspect `topic.json` (the
    Electron main process's record of the topic's configuration)
    or a report file. The function does not validate the parsed
    content beyond "it parsed to a dict" — a JSON file whose
    top-level value is an array or a scalar raises `TypeError`.
    The plan's JSON files are all objects at the top level, and a
    file that violates that convention is a bug worth surfacing
    at the read site.

    Encoding is UTF-8. A file that is not valid UTF-8 raises
    `UnicodeDecodeError`; a file whose content is not valid JSON
    raises `json.JSONDecodeError`. Both are left to propagate —
    the caller's error handling is the right place to decide what
    a malformed file means for its operation.

    Args:
        path: The file to read.

    Returns:
        The parsed dict.

    Raises:
        FileNotFoundError, UnicodeDecodeError, json.JSONDecodeError
        as described above.
        TypeError if the parsed value is not a dict.
    """
    raw = path.read_text(encoding="utf-8")
    parsed: Any = json.loads(raw)
    if not isinstance(parsed, dict):
        raise TypeError(
            f"read_json: expected a JSON object at the top level "
            f"of {path}, got {type(parsed).__name__}."
        )
    return parsed


# =============================================================================
#  Convenience: ISO 8601 timestamp
# =============================================================================

def utc_now_iso() -> str:
    """
    Return the current UTC time as an ISO 8601 string with a
    trailing `Z`.

    Used by callers that need a `fetched_at` field for doc
    frontmatter or a `created_at` field for a report. The format
    is the one every consumer of the pipeline understands —
    JavaScript's `new Date(iso)` and Python's
    `datetime.fromisoformat()` both parse it.

    The output is timezone-aware (it ends in `Z`, which is the
    ISO 8601 representation of UTC). A naive timestamp — one
    without a timezone — would be ambiguous to a consumer in a
    different timezone, and would cause subtle bugs in a
    dashboard that sorts by timestamp across users.

    The microseconds are truncated to milliseconds, matching the
    granularity the plan's user journey shows in the pipeline's
    log output. Millisecond precision is what the marker payloads
    carry and what the renderer's time formatting expects.
    """
    return (
        datetime.now(timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


# =============================================================================
#  Default export
# =============================================================================

__all__ = [
    # path helpers
    "get_topics_root",
    "get_topic_folder",
    "get_sources_folder",
    "get_article_folder",
    "get_reports_folder",
    "get_failures_path",
    "ensure_topic_folders",
    # prompt path helpers
    "get_user_prompts_folder",
    "resolve_prompt_path",
    # atomic writes
    "write_text_atomic",
    "write_json_atomic",
    # doc files
    "write_doc",
    "read_doc",
    # prompt templates
    "read_prompt_template",
    "render_prompt",
    # JSON
    "read_json",
    # timestamp
    "utc_now_iso",
]