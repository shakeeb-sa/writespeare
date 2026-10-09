"""
validation – the article-quality validation suite for WriteSpeare.

This package contains every Python validator the pipeline runs
against a generated article. Each submodule owns one dimension of
article quality, and `validate_all.py` orchestrates the six of
them into a single aggregated JSON report that the renderer's
Report tab renders as six panels.

Submodules:

    readability.py          Readability scoring via `textstat`.
                            Produces Flesch Reading Ease,
                            Flesch-Kincaid Grade, Gunning Fog,
                            SMOG, average sentence length, and
                            reading time. Emits its section into
                            the report under the `readability` key.

    seo_check.py            Structural SEO analysis. Counts
                            words, H2/H3 headings, average
                            paragraph length, passive-voice
                            percentage, and transition-word
                            percentage. Emits its section under
                            the `seo` key.

    keyword_check.py        Per-keyword placement and density.
                            For each of the user's keywords,
                            reports total occurrences, density as
                            a fraction of word count, and whether
                            the keyword appears in the title, the
                            intro, and any H2 heading. Emits its
                            section under the `keywords` key.

    originality.py          Similarity of the article against
                            its source docs. Two independent
                            signals: TF-IDF cosine similarity
                            (catches lexical overlap) and
                            sentence-transformer embedding
                            cosine similarity (catches
                            paraphrase). Flags sentences above
                            the configured thresholds and emits
                            its section under the `originality`
                            key.

    ai_markers.py           Counts phrases that are
                            statistically over-represented in
                            LLM output — "it's important to
                            note", "delve into", "in today's
                            world", and the other entries in
                            this module's phrase list. Emits
                            its section under the `aiMarkers`
                            key.

    grammar.py              Grammar, style, and spelling issues
                            via LanguageTool. Produces a list of
                            issues, each carrying a rule id, a
                            message, a character offset and
                            length for UI highlighting, and an
                            ordered list of replacement
                            suggestions. Emits its section
                            under the `grammar` key.

    validate_all.py         The orchestrator. Loads the article
                            and the source docs, invokes each of
                            the six validators in turn, aggregates
                            their outputs into a single JSON
                            document, computes the overall status
                            from the six section statuses, and
                            writes the result to the topic's
                            `reports/` folder. Emits
                            VALIDATION_PROGRESS markers between
                            validators and a single
                            VALIDATION_DONE marker on completion.

The orchestration model:

    `validate_all.py` is the entry point that `main.py` invokes
    via the `validate` subcommand. It is the only file in this
    package that writes to disk, the only one that emits markers,
    and the only one that the Electron main process ever spawns
    as a subprocess. The six validator modules are pure functions
    of `(article_text, ...) -> section_dict`; they read no files,
    write no files, and emit no markers. That separation is what
    makes each validator testable in isolation and what lets a
    future session add a seventh validator without touching the
    orchestration contract.

Invariants shared by every submodule in this package:

    1. Imports from `core/` only. Every validator imports the
       shared primitives it needs (marker emission for the
       orchestrator, logging, word counting, Markdown stripping)
       from the sibling `core/` package. No validator imports
       from `research/`, `writer/`, or `export/` — the
       dependency graph flows one way and this package sits at
       the top of the pipeline's stage order.

    2. Emits only validation-stage markers. `VALIDATION_PROGRESS`
       and `VALIDATION_DONE` are this package's markers, and
       `validate_all.py` is the only file that emits them. A
       validator submodule never emits a marker directly — it
       returns a dict, and the orchestrator decides when and how
       to report progress. That ownership is what keeps the
       progress stream unambiguous when a future session runs
       several validators concurrently.

    3. Never launches Chrome. Validation is a pure text-analysis
       stage. It reads the article `.md` file and the source `.md`
       files, computes its numbers, and writes its report. The
       absence of a browser dependency is what makes validation
       the fastest stage in the pipeline and what lets it run
       even when Chrome has been closed by the user.

    4. Never writes outside the topic folder. The single report
       file lands in the topic's `reports/` directory via
       `core.file_io.write_json_atomic`. No validator writes a
       partial report, a scratch file, or a cache — the one JSON
       file the orchestrator writes is the entire on-disk
       footprint of this package.

    5. Uses the shared file-system helpers for every read and
       every write. No validator calls `open()` directly. The
       atomic-write and folder-layout guarantees that
       `core.file_io` provides apply to this package's output
       just as they apply everywhere else in the pipeline.

    6. Produces a report whose shape matches the shared
       `Report` type declared in the desktop's
       `features/shared/types/index.ts` and the backend's
       `features/shared/types/index.ts`. The six section keys
       (`readability`, `seo`, `keywords`, `originality`,
       `aiMarkers`, `grammar`) and the `overallStatus` field are
       the contract between this Python package and the
       TypeScript consumers on both the desktop and the server.
       A key that is renamed here without a corresponding change
       in the shared types would surface as a missing panel in
       the renderer's report view.

Why this file imports nothing:

    The same reasoning as `core/__init__.py`,
    `research/__init__.py`, and `writer/__init__.py`. A package
    `__init__.py` is evaluated the first time any code executes
    `import validation` or `from validation.<submodule> import
    ...`. If this file imported its submodules, that evaluation
    would drag the heavier dependencies of every validator
    (textstat, nltk, sentence-transformers, scikit-learn,
    language-tool-python) into the module graph on every
    `import validation` — even for a consumer that only wants
    the package name.

    Leaving the file with no imports means `import validation`
    is free. Consumers import the specific submodule they need
    (`from validation.validate_all import run_validate`) and pay
    only for the transitive imports of that one submodule.

Why there is no `__all__` here:

    `__all__` on a package's `__init__.py` is meaningful only
    when the file re-exports the package's public symbols — it
    is the list that `from validation import *` iterates. Since
    this file re-exports nothing (see above), an `__all__` would
    be either empty (and therefore noise) or a list of submodule
    names that `import *` would not actually pull in as
    attributes. Neither shape is useful, so the file omits it.

    Each submodule declares its own `__all__` — see
    `validate_all.py` for the pattern — which is the level at
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