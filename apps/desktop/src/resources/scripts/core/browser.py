#!/usr/bin/env python3
"""
core/browser.py — Chrome launch + Chrome DevTools Protocol (CDP) helpers.

Every WriteSpeare script that drives a real browser — the two search
scripts (google_search.py, duckduckgo_search.py), every page extractor
(extract_generic.py and the platform-specific extract_*.py family), and
the DeepSeek writer — gets its Playwright Browser handle from this
module. The module is the single place in the pipeline that knows how
to find Chrome, how to launch it with the flags the automation needs,
and how to connect to it over CDP.

Architecture — why "launch separately, connect over CDP":

    Playwright ships its own bundled Chromium and, by default,
    `playwright.chromium.launch()` starts that bundled browser in a
    headless-equivalent configuration with a fresh ephemeral profile.
    WriteSpeare does NOT use that mode, for one decisive reason: the
    DeepSeek session. The user journey's Stage 0 requires the app to
    open a real Chrome window, let the user log into chat.deepseek.com
    once, and then persist that session across every future launch.
    That persistence is what a persistent `--user-data-dir` gives us,
    and it is what a fresh ephemeral profile does not.

    The second reason is manual interaction. The user journey has the
    user solving captchas and clearing Cloudflare interstitials in the
    SAME window the automation is driving. That requires the browser
    to be a real, visible, user-interactable Chrome — not the
    Playwright-bundled Chromium in its automation configuration.

    So the model this module implements is:

        1. launch_chrome()      — start the OS's real Chrome as a
                                  detached subprocess, with a debug
                                  port and a persistent profile. The
                                  caller gets a Popen handle so it
                                  can kill Chrome later if it wants.

        2. wait_for_debug_port() — poll the CDP HTTP endpoint until
                                  Chrome announces it is ready to
                                  accept connections. Called
                                  internally by launch_chrome; also
                                  exported so a caller that launched
                                  Chrome out-of-band can wait for it.

        3. connect_to_chrome()   — attach Playwright to the running
                                  Chrome via CDP. Playwright becomes
                                  a driver of the browser the user is
                                  also looking at, in the same tabs,
                                  in the same session, with the same
                                  cookies. Every subsequent Playwright
                                  call operates on that browser.

    The three functions are the entire public surface. A caller
    typically does:

        process = launch_chrome(9222, user_data_dir)
        browser = connect_to_chrome(9222)
        try:
            context = browser.contexts[0]
            page = context.pages[0]
            page.goto("https://chat.deepseek.com")
            ...
        finally:
            browser.close()       # disconnect; does NOT kill Chrome
            process.terminate()   # now kill Chrome

Lifecycle ownership:

    launch_chrome() returns the Popen handle for the Chrome subprocess.
    The caller owns that handle: it decides when (and whether) to
    terminate Chrome. This module does not register an atexit handler
    that kills Chrome, because a Python script that finishes its work
    often wants the browser to stay open — for debugging, for the user
    to inspect, for a subsequent script to connect to.

    connect_to_chrome() returns a Playwright Browser. The caller owns
    that handle too: it calls browser.close() when it is done, which
    disconnects the Playwright driver from Chrome but does NOT close
    the Chrome process. The two are independent lifecycles on purpose.

    The Playwright driver itself (the background Node process that
    Playwright spawns to do the actual CDP work) is managed by this
    module as a lazily-started singleton, cleaned up at process exit
    via atexit. The singleton exists because Playwright's sync API can
    only be entered once per process, and each `sync_playwright().start()`
    costs ~200ms of startup. Reusing one Playwright instance across
    multiple connect_to_chrome() calls makes reconnects cheap.

Thread affinity:

    Playwright's sync API is thread-affine — the thread that started
    the driver is the only thread that can call into it. Every
    WriteSpeare script that uses this module runs single-threaded for
    its Playwright work; the only other thread in the process is
    control_mode's stdin reader, which never touches Playwright.
    A future feature that wanted to drive two browsers in parallel
    would need to spawn a separate Python process for the second one,
    because two sync_playwright() instances cannot coexist in one
    thread.

Chrome discovery:

    `_find_chrome_executable()` searches the OS's standard Chrome (and
    Chromium) installation paths, in preference order:

        * Windows — Program Files, Program Files (x86), and
                    LocalAppData, for the stable, Beta, Dev, and
                    Chromium channels.
        * macOS   — /Applications, for the same four channels.
        * Linux   — via `shutil.which()`, for google-chrome,
                    google-chrome-stable, google-chrome-beta,
                    google-chrome-dev, chromium, and chromium-browser.

    The function raises FileNotFoundError if none of the candidates
    exists. A caller that receives that exception should surface a
    clear, actionable message to the user ("Chrome is not installed;
    install it from https://google.com/chrome") rather than letting
    the exception bubble up as a generic traceback.

Dependencies: Python stdlib + the `playwright` package (declared in
apps/desktop/src/resources/scripts/requirements.txt).
"""

import atexit
import os
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Optional

from playwright.sync_api import (
    Browser,
    Playwright,
    sync_playwright,
)


# =============================================================================
#  Constants
# =============================================================================

# The default Chrome debug port. Matches the port the Electron main
# process's portAllocator.ts allocates from (its CHROME_BASE_PORT), so
# a caller that does not specify a port gets the first one the TS side
# would use.
DEFAULT_DEBUG_PORT = 9222

# How long launch_chrome() waits for Chrome to open its debug port
# before giving up. Chrome's cold start on a slow disk (network-mounted
# profile directory, first-run on a new machine) can take several
# seconds; 30 seconds is generous without being pathological. A timeout
# shorter than this would produce false negatives on slow machines.
DEBUG_PORT_TIMEOUT_SECONDS = 30.0

# Poll interval while waiting for the debug port. 250ms is fine-grained
# enough that Chrome's readiness is detected promptly, and coarse
# enough that we do not hammer the port with thousands of connection
# attempts per second during the wait.
DEBUG_PORT_POLL_INTERVAL_SECONDS = 0.25

# Timeout for a single HTTP probe against Chrome's CDP endpoint. The
# endpoint responds with a small JSON document from an in-process
# server, so 2 seconds is far more than enough; a longer timeout would
# only make the readiness poll feel sluggish when Chrome is genuinely
# not ready.
CDP_HTTP_PROBE_TIMEOUT_SECONDS = 2.0


# =============================================================================
#  Chrome discovery
# =============================================================================

# Relative paths under each Windows Chrome root. The roots (PROGRAMFILES
# and the two others below) are read from environment variables at
# discovery time, so the same candidate list works on every Windows
# installation regardless of the drive letter or the architecture.
_WINDOWS_CHROME_RELATIVE_PATHS = (
    r"Google\Chrome\Application\chrome.exe",
    r"Google\Chrome Beta\Application\chrome.exe",
    r"Google\Chrome Dev\Application\chrome.exe",
    r"Chromium\Application\chrome.exe",
)

# The three Windows environment variables that can hold a Chrome
# installation root. Checked in this order — a stable Chrome in Program
# Files wins over a Beta in LocalAppData.
_WINDOWS_CHROME_ROOTS = (
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "LOCALAPPDATA",
)

# macOS absolute paths. The `.app` bundle's executable is inside the
# bundle's Contents/MacOS directory.
_MACOS_CHROME_PATHS = (
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta",
    "/Applications/Google Chrome Dev.app/Contents/MacOS/Google Chrome Dev",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
)

# Linux binary names to look up via shutil.which(). The order is
# preference order: stable Chrome, then stable-alias, then Beta, then
# Dev, then the two chromium package names Debian-based and Red-Hat-
# based distributions use.
_LINUX_CHROME_BINARIES = (
    "google-chrome",
    "google-chrome-stable",
    "google-chrome-beta",
    "google-chrome-dev",
    "chromium",
    "chromium-browser",
)


def _find_chrome_executable() -> str:
    """
    Locate the OS's installed Chrome (or Chromium) binary.

    Returns the absolute path to the executable. Raises
    FileNotFoundError if no candidate exists — the caller is expected
    to surface that as a user-facing message, not to catch and ignore
    it.

    The search is platform-dispatched: Windows walks the three known
    roots × four known channels, macOS walks four absolute paths,
    Linux asks `shutil.which()` for six binary names. Every branch
    returns the first match it finds, so the preference order within
    each branch is the documented priority.
    """
    if sys.platform == "win32":
        for root_var in _WINDOWS_CHROME_ROOTS:
            root = os.environ.get(root_var)
            if not root:
                continue
            for rel in _WINDOWS_CHROME_RELATIVE_PATHS:
                candidate = Path(root) / rel
                if candidate.is_file():
                    return str(candidate)

    elif sys.platform == "darwin":
        for path in _MACOS_CHROME_PATHS:
            if Path(path).is_file():
                return path

    else:
        for binary in _LINUX_CHROME_BINARIES:
            found = shutil.which(binary)
            if found:
                return found

    raise FileNotFoundError(
        "Chrome or Chromium could not be found on this system. "
        "Install Chrome from https://www.google.com/chrome/ and "
        "re-run."
    )


# =============================================================================
#  Debug port readiness
# =============================================================================

def wait_for_debug_port(port: int) -> bool:
    """
    Poll Chrome's CDP HTTP endpoint until it responds, or until the
    timeout expires.

    Returns True if Chrome is accepting CDP connections, False if the
    timeout was reached without a successful response.

    The probe hits `http://localhost:{port}/json/version`, which is
    Chrome's own status endpoint. Chrome opens this endpoint as soon
    as its debug server is ready; every other CDP endpoint
    (websocket, page targets, etc.) is reachable from that moment on.

    Never raises. Every failure mode — the port is not open yet, the
    HTTP response is malformed, the connection is refused — is treated
    as "not ready yet" and the poll continues until the deadline.
    """
    probe_url = f"http://localhost:{port}/json/version"
    deadline = time.monotonic() + DEBUG_PORT_TIMEOUT_SECONDS

    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(
                probe_url,
                timeout=CDP_HTTP_PROBE_TIMEOUT_SECONDS,
            ) as response:
                if response.status == 200:
                    return True
        except (OSError, urllib.error.URLError):
            # The port is not yet listening, or the connection was
            # refused, or the response did not arrive in time. All of
            # these mean "not ready yet" — sleep and try again.
            pass

        time.sleep(DEBUG_PORT_POLL_INTERVAL_SECONDS)

    return False


# =============================================================================
#  Chrome launch
# =============================================================================

def launch_chrome(
    port: int,
    user_data_dir: str,
) -> subprocess.Popen:
    """
    Launch the OS's Chrome with a debug port and a persistent profile.

    Returns the `subprocess.Popen` handle for the Chrome process. The
    caller owns that handle and decides when (and whether) to terminate
    it — this function does not register any cleanup, because a
    caller often wants Chrome to outlive the current Python script.

    Blocks until Chrome's CDP endpoint is answering, or until the
    readiness timeout expires. On timeout, Chrome is terminated and a
    RuntimeError is raised — the caller should not proceed as if the
    browser is available when it is not.

    The `user_data_dir` is created if it does not exist. Chrome also
    creates it on first launch, but pre-creating it lets us give a
    clearer error if the parent directory is not writable, and it
    ensures the caller's path is exactly what Chrome uses.

    Chrome's stdout/stderr/stdin are redirected to DEVNULL. This is
    not cosmetic — WriteSpeare's Python scripts use their own stdout to
    emit `::ROOKIE::` marker lines that the Electron main process
    parses. If Chrome inherited stdout, its log output would interleave
    with the marker stream and break the parser. stdin is redirected
    for the same reason: the process's stdin is owned by
    control_mode's reader thread and must not be shared with a
    subprocess.

    Flags chosen for automation:
      --remote-debugging-port=<port>  Required. Opens the CDP endpoint.
      --user-data-dir=<dir>           Required. Persistent profile — this
                                      is what keeps the DeepSeek session
                                      alive across launches.
      --no-first-run                  Skip Chrome's first-run wizard,
                                      which otherwise appears the first
                                      time a fresh user-data-dir is used.
      --no-default-browser-check      Skip the "make Chrome your default
                                      browser?" prompt.
      --disable-background-networking Suppress Chrome's own telemetry and
                                      update pings, which otherwise add
                                      noise and occasional latency.
      --disable-sync                  Do not sync this profile with the
                                      user's Google account. The
                                      WriteSpeare profile is its own
                                      independent Chrome profile.
      --disable-blink-features=AutomationControlled
                                      Suppress the `navigator.webdriver`
                                      signal that some sites use to
                                      detect automation. Not a
                                      guarantee against every detection
                                      method, but the standard baseline.
    """
    chrome_path = _find_chrome_executable()

    profile_dir = Path(user_data_dir)
    profile_dir.mkdir(parents=True, exist_ok=True)

    args = [
        chrome_path,
        f"--remote-debugging-port={port}",
        f"--user-data-dir={profile_dir}",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-networking",
        "--disable-sync",
        "--disable-blink-features=AutomationControlled",
    ]

    process = subprocess.Popen(
        args,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    ready = wait_for_debug_port(port)
    if not ready:
        # Chrome did not announce its debug port within the timeout.
        # Terminate the subprocess we just started so it does not sit
        # in the background orphaned, then raise a clear error.
        try:
            process.terminate()
        except Exception:
            pass
        raise RuntimeError(
            f"Chrome did not open its debug port on {port} within "
            f"{DEBUG_PORT_TIMEOUT_SECONDS:.0f} seconds. The most "
            f"common cause is another Chrome instance already using "
            f"the same user-data-dir: Chrome refuses to open a second "
            f"instance on the same profile and silently hands off to "
            f"the existing one, which is not listening on our debug "
            f"port."
        )

    return process


# =============================================================================
#  Playwright driver singleton
# =============================================================================
#
# The Playwright sync API can be entered exactly once per process: a
# second `sync_playwright().start()` raises an error. Because a single
# WriteSpeare script may legitimately connect to Chrome more than once
# (reconnect after a page crash, connect to a second topic's Chrome
# after finishing the first), this module keeps a lazily-created
# singleton and reuses it across connect_to_chrome() calls.
#
# The singleton is cleaned up at process exit via atexit. The cleanup
# is best-effort — a failure to stop the driver during interpreter
# shutdown must not raise out of atexit, because raising there would
# mask the actual exit reason.

_playwright_instance: Optional[Playwright] = None


def _get_playwright() -> Playwright:
    """
    Return the shared Playwright driver, starting it on first call.

    The driver is a background Node process that Playwright spawns to
    do the actual CDP work; it lives for the lifetime of the Python
    process and is stopped by the atexit handler below.
    """
    global _playwright_instance
    if _playwright_instance is None:
        _playwright_instance = sync_playwright().start()
    return _playwright_instance


def _stop_playwright() -> None:
    """
    Stop the shared Playwright driver. Called by atexit.

    Never raises: atexit handlers run during interpreter shutdown,
    and an exception here would print a confusing traceback next to
    whatever the process's real exit status is.
    """
    global _playwright_instance
    if _playwright_instance is None:
        return
    try:
        _playwright_instance.stop()
    except Exception:
        pass
    _playwright_instance = None


atexit.register(_stop_playwright)


# =============================================================================
#  CDP connect
# =============================================================================

def connect_to_chrome(port: int) -> Browser:
    """
    Attach Playwright to an already-running Chrome over CDP.

    Returns a Playwright `Browser` object that drives the running
    Chrome. Every subsequent Playwright call operates on that browser:
    `browser.contexts` lists the browser's existing contexts (for a
    CDP-attached Chrome, exactly one — the default persistent context
    that owns the user-data-dir), and `context.pages` lists the open
    tabs.

    The caller is expected to have already verified that Chrome is
    listening on `port` — either by having called `launch_chrome()`,
    or by having confirmed the port independently. If Chrome is not
    listening, this function raises Playwright's own connection error
    (a subclass of `playwright._impl._errors.Error`); the caller
    should treat that as "the browser is not where I expected it",
    not as a transient failure to retry.

    Closing the returned Browser (via `browser.close()`) disconnects
    Playwright from Chrome but does NOT terminate the Chrome process.
    Chrome keeps running, its tabs stay open, and its user-data-dir
    keeps its session. A subsequent `connect_to_chrome(port)` call
    reconnects to the same browser in the same state. To actually
    stop Chrome, use the Popen handle returned by `launch_chrome()`.
    """
    playwright = _get_playwright()
    return playwright.chromium.connect_over_cdp(
        f"http://localhost:{port}"
    )


# =============================================================================
#  Default export
# =============================================================================

__all__ = [
    "DEFAULT_DEBUG_PORT",
    "launch_chrome",
    "wait_for_debug_port",
    "connect_to_chrome",
]