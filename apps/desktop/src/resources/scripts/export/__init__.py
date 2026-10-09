"""
export – article-export writers for the WriteSpeare pipeline.

This package contains the scripts that write a finished article
to a file the user can open outside the application. It is the
last stage of the pipeline — the writer step produces the
article, the validation step reports on its quality, and the
export step is where the user takes the article away.

Submodules:

    export_docx.py          Markdown → .docx. Uses `python-docx`
                            to build a Word document whose
                            headings, bold runs, italic runs,
                            links, and list items are the
                            document's native equivalents —
                            a heading in the article becomes a
                            `Heading 1` / `Heading 2` / `Heading
                            3` style, not a bolded paragraph.
                            The output is a file the user can
                            open in Word, Google Docs, or any
                            other Word-compatible editor without
                            further manipulation.

    export_md.py            Markdown → .md. The trivial export:
                            the article is already Markdown, so
                            this writer's only job is to copy
                            the source article's text into the
                            destination path the user chose in
                            the Save-As dialog. The "writer"
                            name is preserved for symmetry with
                            `export_docx.py` and because a future
                            session that wants to add a
                            transformation (a frontmatter block
                            with the article's metadata, a
                            title-slug-based filename) would put
                            that logic here without changing the
                            module's name.

The two writers share one interface:

    Every module in this package exposes a
    `run_export(article_path, output_path) -> int` function with
    the same signature. That uniformity is what lets `main.py`'s
    `_run_export` handler dispatch to the correct module with a
    single `import` selection and a single call, and it is what
    lets a future session add a third writer (an HTML export, a
    PDF export, a WordPress-ready XML export) without changing
    the dispatcher.

    The `run_export` contract:

      * Read the article from `article_path` (an absolute path
        to the `.md` file the writer step produced).

      * Write the exported file to `output_path` (an absolute
        path the user chose in the Save-As dialog the desktop's
        IPC handler opened).

      * Return 0 on success, 1 on failure. The exit code is
        what `main.py` uses to classify the operation in its
        `TASK_END` marker.

      * Emit no markers. Export is a short operation with no
        progress to report — the user clicks "Export", waits a
        fraction of a second, and either sees a success toast or
        an error toast. There is no intermediate state worth
        streaming back to the GUI, so there are no progress
        markers to emit.

      * Never launch Chrome. Export is a pure file transformation.
        Its absence of a browser dependency is what makes it the
        fastest stage in the pipeline.

      * Never touch the network. The Save-As dialog is the
        desktop's responsibility; by the time `run_export` is
        called, the destination path is already known.

Invariants shared by every submodule in this package:

    1. Imports from `core/` only. Every writer imports the shared
       primitives it needs (file I/O, logging, Markdown parsing)
       from the sibling `core/` package. No writer imports from
       `research/`, `writer/`, or `validation/` — the dependency
       graph flows one way and this package sits at the very top
       of the pipeline's stage order, with no downstream
       consumers of its own.

    2. Atomic writes for every output file. The `export_md.py`
       writer copies text via `core.file_io.write_text_atomic`;
       `export_docx.py` builds the Word document with `python-docx`
       and writes the resulting bytes through an atomic
       temporary-file rename. The guarantee is the same as
       everywhere else in the pipeline: a reader sees either
       the complete file or no file, never a partial write.

    3. No modification of the source article. The `.md` file
       the writer step produced is read-only as far as this
       package is concerned. Every transformation the writers
       perform is applied to an in-memory representation and
       written to a NEW file at the user's chosen destination
       path. The article's own file — sitting in the topic's
       `article/` folder — is never touched.

    4. UTF-8 throughout. Both writers read the source article
       and write the output file as UTF-8. The article's text
       carries characters from every writing system the web
       carries, and a mismatch between the two writers' encoding
       choices would produce mojibake on any non-ASCII character
       — the exact class of bug that is hard to spot in
       English-only testing. The convention is enforced at the
       source: `core.file_io` reads and writes UTF-8, and both
       writers go through it.

    5. No dependency on the desktop's UI. Neither writer knows
       anything about the Save-As dialog, the electronAPI
       surface, or the Zustand stores. The destination path is
       passed in as a string; what the user did to produce that
       string is not the writer's concern. That separation is
       what lets the writers be tested from a command line and
       what would let a future non-desktop client (a CLI, a
       web-based front end) reuse them without modification.

Why this file imports nothing:

    The same reasoning as `core/__init__.py`,
    `research/__init__.py`, `writer/__init__.py`, and
    `validation/__init__.py`. A package `__init__.py` is
    evaluated the first time any code executes
    `import export` or `from export.<submodule> import ...`.
    If this file imported its submodules, that evaluation would
    drag `export_docx.py`'s `python-docx` dependency into the
    module graph on every `import export` — even for a consumer
    that only wants the Markdown copier.

    Leaving the file with no imports means `import export` is
    free. Consumers import the specific submodule they need
    (`from export.export_docx import run_export`) and pay only
    for the transitive imports of that one submodule.

    The pattern matters more for this package than for its
    siblings, because the two writers have deliberately
    asymmetric dependency footprints: `export_md.py` has no
    external dependencies at all, while `export_docx.py`
    requires the `python-docx` package. A consumer that only
    wants the Markdown copier would pay the `python-docx`
    import cost if this file eagerly imported both.

Why there is no `__all__` here:

    `__all__` on a package's `__init__.py` is meaningful only
    when the file re-exports the package's public symbols — it
    is the list that `from export import *` iterates. Since
    this file re-exports nothing (see above), an `__all__`
    would be either empty (and therefore noise) or a list of
    submodule names that `import *` would not actually pull in
    as attributes. Neither shape is useful, so the file omits
    it.

    Each submodule declares its own `__all__` — see
    `export_docx.py` and `export_md.py` for the pattern, both
    of which export a single function — which is the level at
    which `__all__` carries information.

Why there is no `__version__` here:

    The application's version lives in
    `apps/desktop/package.json`. Adding a second version string
    inside the Python package would create a second source of
    truth, and the two would eventually disagree — the same
    class of drift `core/__init__.py` warns against.

Dependencies: none — this file is a package marker, not a
runnable module.
"""