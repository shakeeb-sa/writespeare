"""
research – search and extraction scripts for the WriteSpeare pipeline.

This package contains every Python script that touches the open web:
the search engines that discover candidate source pages for a topic,
and the extractors that turn each candidate page into a clean
Markdown doc file on disk.

Submodules:

    google_search.py        Search via Google. Opens Google, handles
                            the consent interstitial if it appears,
                            submits the topic's query, reads the top
                            result anchors, paginates if more
                            candidates are needed, and emits
                            SEARCH_RESULT markers as the candidate
                            list grows. This is the primary search
                            engine — DuckDuckGo is the fallback.

    duckduckgo_search.py    Search via DuckDuckGo. Same shape and
                            same marker contract as google_search.py,
                            used when Google CAPTCHAs, throttles, or
                            returns no usable results. DuckDuckGo's
                            HTML layout is simpler and its rate
                            limits are less aggressive, at the cost
                            of a smaller index.

    extract_dispatch.py     The routing layer. Given a candidate URL,
                            reads its domain, and calls the correct
                            platform-specific extractor below. A
                            Reddit URL is routed to extract_reddit,
                            a Quora URL to extract_quora, and so on;
                            anything unrecognised falls through to
                            extract_generic. Emits EXTRACT_PROGRESS
                            markers as each URL is processed and a
                            single EXTRACT_DONE marker when the
                            batch completes.

    extract_generic.py      The default extractor. Uses trafilatura
                            to pull the main article body from an
                            arbitrary page and convert it to
                            Markdown. Boilerplate (nav, ads,
                            footers, sidebars) is stripped. This is
                            what runs for every URL that does not
                            match a known platform.

    extract_reddit.py       Reddit-specific. Extracts the post body
                            and the top-scoring comments (they carry
                            a meaningful fraction of a Reddit
                            thread's information) with their scores
                            and authors preserved in the output.

    extract_quora.py        Quora-specific. Handles Quora's login
                            wall (asks the user to log in via
                            manual_action_required if the wall
                            appears), then extracts the top answer
                            and the comments beneath it.

    extract_medium.py       Medium-specific. Extracts the article
                            body and detects the paywall —
                            articles beyond the free-member limit
                            are truncated by Medium itself, and the
                            extractor reports the truncation so the
                            pipeline can skip the source rather
                            than feed a half-article to the writer.

    extract_twitter.py      Twitter/X placeholder. Twitter's public
                            pages are JavaScript-rendered and
                            require auth to read beyond a small
                            preview; a full extractor is deferred to
                            a future version. The file exists so that
                            extract_dispatch can route Twitter URLs
                            to a stub that logs a clear "not yet
                            supported" message and returns no
                            content, rather than to extract_generic
                            which would produce a nearly-empty
                            doc file.

Invariants shared by every submodule in this package:

    1. Imports from `core/` only. Every script here imports the
       shared primitives it needs (stdin control, marker emission,
       Chrome launch, HTML extraction, file I/O, logging) from the
       sibling `core/` package. No script imports from `writer/`,
       `validation/`, or `export/` — the dependency graph flows
       one way and this package sits above `core/` and below the
       downstream stages.

    2. Emits only research-stage markers. `SEARCH_PROGRESS`,
       `SEARCH_RESULT`, `EXTRACT_PROGRESS`, and `EXTRACT_DONE` are
       this package's markers. A script here never emits a writer,
       validation, or export marker — that ownership belongs to
       the packages that own those stages.

    3. Never invents a browser. Every script that needs a Chrome
       instance gets it from `core.browser.connect_to_chrome()`.
       The package never launches Chrome itself; the launch is the
       caller's job (the Electron main process, via a spawned
       `main.py` subprocess).

    4. Never writes outside the topic folder. Extracted `.md` files
       land in the topic's `sources/` directory via
       `core.file_io.write_doc()`. No script in this package writes
       anywhere else on disk.

Why this file imports nothing:

    The same reasoning as `core/__init__.py`. A package
    `__init__.py` is evaluated the first time any code executes
    `import research` or `from research.<submodule> import ...`. If
    this file imported its submodules, that evaluation would drag
    the heavier dependencies of every research script (Playwright,
    trafilatura, BeautifulSoup) into the module graph on every
    `import research` — even for a consumer that only wants one
    submodule.

    Leaving the file with no imports means `import research` is
    free. Consumers import the specific submodule they need and pay
    only for the transitive imports of that one submodule.

Why there is no `__all__` here:

    `__all__` on a package's `__init__.py` is meaningful only when
    the file re-exports the package's public symbols. Since this
    file re-exports nothing, an `__all__` would be either empty
    (and therefore noise) or a list of submodule names that
    `import *` would not actually pull in as attributes. Neither
    shape is useful.

Why there is no `__version__` here:

    The application's version lives in
    `apps/desktop/package.json`. Adding a second version string
    inside the Python package would create a second source of
    truth, and the two would eventually disagree — the same class
    of drift `core/__init__.py` warns against.
"""