"""
core – shared primitives for the WriteSpeare automation scripts.

Every Python script in the WriteSpeare pipeline imports from this
package. The submodules here are the pieces of infrastructure that
every stage needs, factored out so that no stage reimplements them:

    control_mode.py   Owns the single stdin reader thread. Every
                      module in the pipeline that needs to read a
                      line from stdin goes through this package's
                      read_line_blocking() / poll_command(), never
                      through a direct sys.stdin access. The
                      single-reader invariant is what keeps a Skip
                      or Stop command from being consumed by the
                      wrong reader.

    output.py         Owns marker emission. Every piece of structured
                      information the pipeline sends back to the
                      Electron main process — search results,
                      extraction progress, writer progress, captcha
                      prompts, manual-action prompts — is emitted
                      through output.emit_marker() as a
                      `::ROOKIE::<TYPE>::<json>` line on stdout. The
                      Electron side parses those lines in
                      listenerBridge.ts. The marker prefix is fixed
                      as `::ROOKIE::` across the app; it is a
                      protocol identifier, not a product name.

    browser.py        Chrome launch + CDP connection helpers. Every
                      script that drives a real browser (the
                      search scripts, the extractors, the writer)
                      gets its Playwright connection from here.

    extractor.py      The content extractor. Turns a raw HTML page
                      into clean Markdown, boilerplate-stripped,
                      with the platform-specific extractors
                      (Reddit, Quora, Medium) layered on top.

    file_io.py        Atomic file writes, the topic folder layout,
                      prompt template loading, and Jinja2 rendering.
                      Every script that produces a file on disk
                      goes through this module's write_doc() so the
                      on-disk layout is defined in exactly one
                      place.

    utils.py          Logging, slugification, dedup helpers. The
                      small utilities that do not belong to any of
                      the more specific modules above.

Invariants shared by every submodule in this package:

    1. stdlib + declared requirements only. No script in `core/`
       imports from another feature folder (research, writer,
       validation, export). The dependency graph flows one way:
       feature scripts import from `core/`, `core/` imports from
       nothing inside the project.

    2. No side effects at module-import time. Importing any
       submodule must not start a thread, open a file, launch a
       browser, or touch the network. All side effects live
       inside functions that the caller invokes deliberately.
       This is what lets a feature script import `core.browser`
       for a type reference without paying for a Chrome launch.

    3. Every stdout write of a structured payload goes through
       output.emit_marker(). No submodule prints a `::ROOKIE::`
       line with a hand-formatted f-string — the emission
       function is the only path, so the JSON encoding rules,
       the flushing behaviour, and the marker prefix are defined
       in exactly one place.

Why this file imports nothing:

    A package `__init__.py` is evaluated the first time any code
    executes `import core` or `from core.<submodule> import ...`.
    If this file imported its submodules, that evaluation would
    drag `output.py` (which imports `control_mode.py`) into the
    module graph on every `import core` — and any future
    submodule added to `core/` that itself imports a heavy
    dependency (Playwright, sentence-transformers, trafilatura)
    would then also be loaded on every `import core`, forcing a
    cost on consumers that never touch the heavy module.

    Leaving the file with no imports means `import core` is free.
    Consumers import the specific submodule they need
    (`from core.output import emit_marker`) and pay only for the
    transitive imports of that one submodule.

    This matches the ROOKIE convention that this package is
    ported from: ROOKIE's own `core/__init__.py` contains no
    imports, and its feature scripts import deep paths
    (`from core.output import ...`). The pattern is carried
    forward unchanged.

Why there is no `__all__` here:

    `__all__` on a package's `__init__.py` is meaningful only
    when the file re-exports the package's public symbols — it
    is the list that `from core import *` iterates. Since this
    file re-exports nothing (see above), an `__all__` would be
    either empty (and therefore noise) or a list of submodule
    names that `import *` would not actually pull in as
    attributes. Neither shape is useful, so the file omits it.

    Each submodule declares its own `__all__` — see
    `control_mode.py` and `output.py` for the pattern — which
    is the level at which `__all__` carries information.

Why there is no `__version__` here:

    The application's version lives in
    `apps/desktop/package.json` (`"version": "1.0.0"`), and the
    Electron main process reads it from there when it needs to
    report the running build. Adding a second version string
    inside the Python package would create a second source of
    truth, and the two would eventually disagree — the same
    class of drift the plan's constants module warns against
    for the preset and profile lists.

    A Python script that needs to know the app's version reads
    it from the environment variable that the Electron main
    process sets before spawning the child, or from a path the
    caller passes as a CLI argument. Either way, the version
    is owned by one place, not two.
"""