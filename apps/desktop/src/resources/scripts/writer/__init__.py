"""
writer – DeepSeek automation for the WriteSpeare pipeline.

This package contains the script that turns a topic's extracted
source documents into a finished article by driving the DeepSeek
chat UI in a real Chrome instance — the same Chrome instance the
search and extraction stages use, so the user's one-time DeepSeek
login (persisted in the Chrome profile) carries over.

Submodule:

    deepseek_writer.py      The DeepSeek automation. Opens the chat,
                            pastes each source doc file as an
                            attachment, types the prompt template
                            as the message body, sends it, waits
                            for DeepSeek to finish generating, and
                            copies the resulting article to the
                            topic's `article/` folder. Emits
                            WRITER_PROGRESS markers throughout so
                            the GUI's live writing panel stays in
                            sync, and blocks for the user's manual
                            help if DeepSeek presents a captcha or
                            a session-expired login wall.

    The module is called by `main.py`'s `write` subcommand via the
    `run_write(topic_id, docs_dir, prompt_file, port)` entry point.
    It does not launch Chrome — the app's persistent Chrome instance
    is the caller's responsibility, and the port is passed in.

Invariants shared by every submodule in this package:

    1. Imports from `core/` only, plus Python stdlib and declared
       packages (Playwright). No script here imports from another
       feature folder — the dependency graph flows one way and
       this package sits above `core/` and below the export stage.

    2. Emits only writer-stage markers. `WRITER_PROGRESS` and
       `WRITER_DONE` are this package's markers. A script here
       never emits a search, extraction, validation, or export
       marker — that ownership belongs to the packages that own
       those stages.

    3. Never launches Chrome. The script connects to a running
       Chrome instance over CDP using the port the caller passes
       (`core.browser.connect_to_chrome`). The Chrome instance's
       lifecycle belongs to the app, not to this package.

    4. Uses the shared file-system helpers in `core.file_io` for
       every read of a source doc and every write of an article
       draft. No script here writes files with raw `open()` calls
       — the atomic-write and folder-layout guarantees apply to
       this package's output just as they apply everywhere else.

    5. Never interacts with the user's direct input. The script's
       only interaction with the user is through the shared
       modal helpers (`core.output.captcha_required` and
       `core.output.manual_action_required`) — the same ones the
       search and extraction stages use. A future session that
       needs a new kind of blocking prompt adds it to
       `core.output` first, then calls it from here.

Why this file imports nothing:

    The same reasoning as `core/__init__.py` and
    `research/__init__.py`. A package `__init__.py` is evaluated
    the first time any code executes `import writer` or
    `from writer.<submodule> import ...`. If this file imported
    its submodule, that evaluation would drag the writer's
    heavier dependencies (Playwright) into the module graph on
    every `import writer` — even for a consumer that only wants
    the package name. Leaving the file with no imports means
    `import writer` is free.

Why there is no `__all__` here:

    `__all__` on a package's `__init__.py` is meaningful only
    when the file re-exports the package's public symbols. Since
    this file re-exports nothing, an `__all__` would be either
    empty (and therefore noise) or a list of submodule names that
    `import *` would not actually pull in as attributes. Neither
    shape is useful.

Why there is no `__version__` here:

    The application's version lives in
    `apps/desktop/package.json`. Adding a second version string
    inside the Python package would create a second source of
    truth, and the two would eventually disagree — the same class
    of drift `core/__init__.py` warns against.

Dependencies: none — this file is a package marker, not a
runnable module.
"""