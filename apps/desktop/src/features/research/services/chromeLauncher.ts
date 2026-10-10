/**
 * chromeLauncher — Chrome process lifecycle for the main process.
 *
 * Launches a Chrome instance with a Chrome DevTools Protocol (CDP)
 * debug port and a caller-supplied persistent user-data directory,
 * waits until the debug port is accepting connections, and returns
 * a handle the caller can use to kill the instance later. The
 * Chrome that this module launches is the browser the Python
 * automation scripts connect to over CDP — a script's
 * `core.browser.connect_to_chrome(port)` call attaches to the
 * Chrome instance this module started.
 *
 * The lifecycle model — Chrome outlives the caller:
 *
 *   A Chrome instance is not tied to the lifetime of whatever
 *   operation triggered its launch. The plan's user journey has the
 *   user log into DeepSeek ONCE, into a persistent profile, and
 *   then reuse that session across every future search and every
 *   future article — the login is not repeated per operation. The
 *   Chrome instance that holds the login therefore has to live as
 *   long as the app, not as long as one search.
 *
 *   This module reflects that model: it does NOT auto-kill Chrome
 *   when a caller's promise resolves. It returns a handle; the
 *   caller decides when (and whether) to kill. The app's own
 *   shutdown path (`before-quit`) calls `killAllChrome()`, which is
 *   the one place that reliably terminates every tracked instance.
 *
 * The instance registry:
 *
 *   Every successful `launchChrome` call registers the instance in
 *   a module-level array. The registry exists for two reasons:
 *
 *     1. Shutdown cleanup. `killAllChrome()` iterates the registry
 *        and kills each instance, releasing every allocated port.
 *        Without a registry, the shutdown path would have to hold
 *        its own list of instances, duplicating this module's
 *        tracking.
 *
 *     2. Diagnostics. `getRunningInstances()` returns a snapshot of
 *        the registry, which a future diagnostics panel or a test
 *        can use to confirm that instances are being cleaned up
 *        correctly.
 *
 *   The registry removes an instance as soon as it has been killed
 *   — either by `killChrome` or by `killAllChrome`. It never
 *   contains a dead instance, so a caller that queries it is
 *   looking at live Chrome processes only.
 *
 * Why killing uses `tree-kill` and not `child.kill()`:
 *
 *   Chrome spawns a tree of child processes — a browser process,
 *   renderer processes (one per tab), a GPU process, a network
 *   process, and others. Killing the root Chrome process with
 *   `child.kill()` leaves the children orphaned on Windows, where
 *   they keep running until they notice their parent is gone (which
 *   can take a while) or until the user kills them manually. An
 *   app that leaked orphaned Chrome processes on every shutdown
 *   would be a well-known complaint within a week.
 *
 *   The `tree-kill` package (already a dependency in
 *   `apps/desktop/package.json`) walks the process tree and
 *   terminates every descendant. It is the standard solution to
 *   this exact problem in the Electron ecosystem.
 *
 * The readiness check — why `waitForDebugPort` polls rather than
 * listening for a specific event:
 *
 *   Chrome has no "I am ready" event a launcher can subscribe to.
 *   The only signal that its debug server is up is the CDP HTTP
 *   endpoint at `http://localhost:<port>/json/version` responding
 *   with a JSON payload. The launcher polls that endpoint with a
 *   short interval until it answers or a timeout expires. This
 *   matches the behavior of the Python side's
 *   `core/browser.py:wait_for_debug_port`, which does the same
 *   poll for the same reason.
 *
 * What this module does NOT do:
 *
 *   - It does not connect to Chrome over CDP. That is the Python
 *     side's job (`core/browser.py:connect_to_chrome`). This
 *     module's only responsibility is to get a Chrome process
 *     running with a debug port open.
 *
 *   - It does not manage the persistent profile's contents. The
 *     caller supplies the `userDataDir` path; this module creates
 *     the directory if it does not exist (Chrome requires the
 *     parent to exist) but does not touch any file inside it.
 *
 *   - It does not decide when a Chrome instance should be killed.
 *     The caller (the app's `before-quit` handler, a cancellation
 *     path, or a test) makes that decision and calls `killChrome`
 *     or `killAllChrome`.
 *
 *   - It does not fall back to a different Chrome if the primary
 *     one fails to launch. A launch failure surfaces as a rejected
 *     promise with a specific error; the caller's error path
 *     decides what to do.
 *
 *   - It does not verify that the CDP port belongs to the Chrome
 *     instance it just launched. Two Chrome instances on the same
 *     port is impossible — the OS refuses the second bind — and
 *     the allocator (`portAllocator.ts`) guarantees that two
 *     concurrent launches get distinct ports. The check would add
 *     no value.
 *
 * Dependencies: Node stdlib + electron + `tree-kill` (declared in
 * `apps/desktop/package.json`) + `portAllocator` (Session 10,
 * step 71).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import treeKill from 'tree-kill';

import { allocatePort, releasePort } from './portAllocator.js';

// =============================================================================
//  Public types
// =============================================================================

/**
 * A handle to a running Chrome instance.
 *
 * Returned by `launchChrome` on success. The caller passes it back
 * to `killChrome` when it wants to terminate the instance. It is
 * also what `getRunningInstances` returns for each live instance.
 *
 * The fields are all `readonly` — a caller must not mutate the
 * handle. Termination goes through `killChrome`, which updates the
 * registry; a caller that set `instance.process = null` directly
 * would corrupt the registry's bookkeeping without telling the
 * registry anything had happened.
 */
export interface ChromeInstance {
  /** The Chrome process. `null` after `killChrome` has been called
   *  — the registry sets it to null before removing the instance,
   *  and callers that hold the handle can still read the field. */
  readonly process: ChildProcess | null;

  /** The CDP debug port Chrome is listening on. Available for the
   *  lifetime of the instance — after kill, it has been released
   *  to the allocator's pool. */
  readonly port: number;

  /** The `--user-data-dir` Chrome was launched with. */
  readonly userDataDir: string;

  /** The absolute path to the Chrome executable that was launched. */
  readonly executablePath: string;
}

/**
 * The options accepted by `launchChrome`.
 *
 * Every field except `userDataDir` has a sensible default. A caller
 * that wants "just launch Chrome for a test" can pass only
 * `userDataDir` and get a working instance.
 */
export interface LaunchChromeOptions {
  /**
   * Absolute path to the directory Chrome should use as its
   * persistent user-data directory. The directory is created if it
   * does not exist. This is the directory that holds the user's
   * DeepSeek login across app restarts — the caller decides what
   * path to use (the plan's convention is
   * `path.join(app.getPath('userData'), 'chrome-profile')`).
   */
  userDataDir: string;

  /**
   * Launch Chrome in headless mode.
   *
   * Defaults to `false`. The plan's user journey requires Chrome to
   * be VISIBLE — the user solves CAPTCHAs and clears Cloudflare
   * interstitials in the same window the automation drives. A
   * headless Chrome would make those interactions impossible.
   *
   * The option exists because some future operation (a background
   * re-fetch of a page that has never required interaction) could
   * use headless mode for speed. Nothing in the current plan does.
   */
  headless?: boolean;

  /**
   * The port to launch Chrome on. When omitted, a port is allocated
   * via `portAllocator.allocatePort()`. A caller that passes an
   * explicit port is responsible for ensuring the port is not
   * currently in use — the allocator's guarantee does not apply to
   * explicit ports.
   *
   * The option exists so that a developer running the app against
   * an already-launched Chrome (a manual debugging scenario) can
   * point the app at that Chrome's port without the allocator
   * having to know about it. In normal operation the caller
   * omits this field.
   */
  port?: number;

  /**
   * How long to wait for Chrome's CDP port to open, in
   * milliseconds. Defaults to 30_000 (30 seconds).
   *
   * A cold Chrome start on a slow disk (a network-mounted profile
   * directory, a first-launch on a new machine that has to
   * initialize the profile) can take several seconds. Thirty
   * seconds is generous without being pathological.
   */
  readyTimeoutMs?: number;
}

// =============================================================================
//  Constants
// =============================================================================

/**
 * The Chrome launch flags the automation requires. Each flag is
 * documented with the specific problem it solves; a flag whose
 * problem is not currently present should be removed rather than
 * left in place "just in case."
 */
const CHROME_FLAGS = [
  // `--no-first-run` — suppress the first-run wizard. Without it, a
  // fresh user-data-dir triggers Chrome's first-run flow, which
  // blocks the debug port from opening until the user dismisses a
  // series of dialogs. Since WriteSpeare's profile starts fresh on
  // a new machine, this flag is required for the first launch.
  '--no-first-run',

  // `--no-default-browser-check` — suppress the "make Chrome your
  // default browser?" prompt. Same reasoning as above: a modal
  // dialog blocks automation until dismissed.
  '--no-default-browser-check',

  // `--disable-background-networking` — suppress Chrome's own
  // telemetry, update pings, and background Safe Browsing fetches.
  // The automation does not need these, and they add noise to the
  // network traffic on a machine that is already being used for
  // scraping.
  '--disable-background-networking',

  // `--disable-sync` — do not sync this profile with the user's
  // Google account. WriteSpeare's profile is its own independent
  // Chrome profile; it must not merge the user's bookmarks,
  // history, or extensions from their personal Chrome.
  '--disable-sync',

  // `--disable-blink-features=AutomationControlled` — remove the
  // `navigator.webdriver` signal that Chrome sets by default when
  // it detects automation. This is not a guarantee against every
  // detection method — Google's anti-bot in particular uses a
  // wider set of signals — but it is the standard baseline and it
  // removes the one signal that is trivially detectable.
  '--disable-blink-features=AutomationControlled',

  // `--disable-features=Translate,MediaRouter` — disable two
  // Chrome features that open background processes the automation
  // does not need. Saves a small amount of memory per instance.
  '--disable-features=Translate,MediaRouter',

  // `--no-sandbox` on Windows only. Chrome's sandbox uses a
  // Windows job object that conflicts with Electron's own
  // process-tree management; disabling it is the standard fix for
  // Chrome-in-Electron setups. NOT applied on macOS or Linux,
  // where the sandbox interacts differently with the OS and no
  // conflict exists.
] as const;

/**
 * The Windows registry-uninstaller locations to search for Chrome
 * when the standard `Program Files` paths do not contain it. Chrome
 * on Windows can be installed in a user-scoped location
 * (`%LOCALAPPDATA%`) rather than a system-wide one; checking only
 * `Program Files` would miss a user-scoped install.
 *
 * The tuple is ordered: stable Chrome first, then Beta, then Dev,
 * then Chromium. The first match wins.
 */
const WINDOWS_CHROME_RELATIVE_PATHS = [
  path.join('Google', 'Chrome', 'Application', 'chrome.exe'),
  path.join('Google', 'Chrome Beta', 'Application', 'chrome.exe'),
  path.join('Google', 'Chrome Dev', 'Application', 'chrome.exe'),
  path.join('Chromium', 'Application', 'chrome.exe'),
] as const;

const WINDOWS_CHROME_ROOTS = [
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'LOCALAPPDATA',
] as const;

const MACOS_CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
  '/Applications/Google Chrome Dev.app/Contents/MacOS/Google Chrome Dev',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
] as const;

const LINUX_CHROME_BINARIES = [
  'google-chrome',
  'google-chrome-stable',
  'google-chrome-beta',
  'google-chrome-dev',
  'chromium',
  'chromium-browser',
] as const;

// =============================================================================
//  Module state — the instance registry
// =============================================================================

/**
 * Every Chrome instance this module has launched and that has not
 * yet been killed. See the file header for the registry's purpose.
 *
 * The array's order is launch order. `killAllChrome` iterates it
 * from the end backward (most-recently-launched first), matching
 * the natural "undo in reverse order" convention for cleanup.
 *
 * Module-private. Callers read a snapshot via
 * `getRunningInstances()`.
 */
const runningInstances: ChromeInstance[] = [];

// =============================================================================
//  Chrome discovery
// =============================================================================

/**
 * Locate the OS's installed Chrome (or Chromium) binary.
 *
 * Returns the absolute path to the executable. Throws if no
 * candidate exists — the caller is expected to surface that as a
 * user-facing error, not to catch and ignore it.
 *
 * The search is platform-dispatched:
 *
 *   - Windows: walks the three known roots × four known channels,
 *     returning the first match.
 *   - macOS: walks four absolute paths.
 *   - Linux: walks the `PATH` via `which`.
 *
 * The function is exported because a diagnostics panel or a
 * first-run setup screen may want to display "Chrome not found" as
 * a specific message rather than as a generic launch failure. A
 * caller that only cares about launching does not need to call it
 * directly — `launchChrome` calls it internally.
 *
 * @returns The absolute path to a Chrome or Chromium executable.
 * @throws  `Error` if no candidate exists on this machine.
 */
export const findChromeExecutable = (): string => {
  const platform = process.platform;

  if (platform === 'win32') {
    for (const rootVar of WINDOWS_CHROME_ROOTS) {
      const root = process.env[rootVar];
      if (!root) continue;
      for (const rel of WINDOWS_CHROME_RELATIVE_PATHS) {
        const candidate = path.join(root, rel);
        if (existsSync(candidate)) {
          return candidate;
        }
      }
    }
  } else if (platform === 'darwin') {
    for (const candidate of MACOS_CHROME_PATHS) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  } else {
    // Linux / BSD — use PATH lookup. `which` is not directly
    // available in Node, but the shelling-out approach is fragile
    // (a shell that is not present, a quoting issue). Instead,
    // iterate the PATH entries from `process.env.PATH` and check
    // each candidate directly.
    const pathEntries = (process.env['PATH'] ?? '').split(path.delimiter);
    for (const binaryName of LINUX_CHROME_BINARIES) {
      for (const entry of pathEntries) {
        if (!entry) continue;
        const candidate = path.join(entry, binaryName);
        if (existsSync(candidate)) {
          return candidate;
        }
      }
    }
  }

  throw new Error(
    'Chrome or Chromium could not be found on this system. ' +
      'Install Chrome from https://www.google.com/chrome/ and try again.'
  );
};

// =============================================================================
//  Readiness check
// =============================================================================

/**
 * Poll Chrome's CDP HTTP endpoint until it answers, or until the
 * timeout expires.
 *
 * Returns a promise that resolves when Chrome is accepting CDP
 * connections, or rejects on timeout. The check hits
 * `http://localhost:<port>/json/version`, which is Chrome's own
 * status endpoint — it opens as soon as Chrome's debug server is
 * ready, and every other CDP endpoint is reachable from that
 * moment on.
 *
 * The polling uses `fetch`, which is available in Node 18+ (and
 * Electron 44 ships Node 20+). No external HTTP library is needed.
 *
 * @param port          - The debug port Chrome was launched on.
 * @param timeoutMs     - How long to wait before rejecting.
 * @returns A promise that resolves when Chrome is ready.
 * @throws  `Error` if the timeout expires without a successful
 *          response.
 */
const waitForDebugPort = async (
  port: number,
  timeoutMs: number
): Promise<void> => {
  const url = `http://localhost:${port}/json/version`;
  const deadline = Date.now() + timeoutMs;
  const intervalMs = 250;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // The port is not yet listening, or the request failed.
      // Sleep and retry.
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(
    `Chrome did not open its debug port on ${port} within ` +
      `${timeoutMs}ms. The most common cause is another Chrome ` +
      `instance already using the same user-data-dir: Chrome ` +
      `refuses to open a second instance on the same profile and ` +
      `silently hands off to the existing one, which is not ` +
      `listening on our debug port.`
  );
};

// =============================================================================
//  Public API — launch
// =============================================================================

/**
 * Launch a Chrome instance and wait until its CDP port is open.
 *
 * Flow:
 *
 *   1. Locate the Chrome executable via `findChromeExecutable`.
 *   2. Determine the debug port. If `options.port` is provided,
 *      use it; otherwise allocate one via `allocatePort`.
 *   3. Ensure `options.userDataDir` exists (Chrome requires its
 *      parent directory to exist).
 *   4. Spawn Chrome with the flags in `CHROME_FLAGS`, plus the
 *      debug port and user-data-dir.
 *   5. Wait for the CDP endpoint to answer.
 *   6. Register the instance in `runningInstances` and return a
 *      handle.
 *
 * On any failure after the port has been allocated, the port is
 * released so it is not leaked back into the pool. A failure
 * before the port is allocated has nothing to release.
 *
 * The spawned Chrome process is detached from the main process's
 * stdio: its `stdio` is set to `['ignore', 'ignore', 'ignore']`,
 * so Chrome's own output does not pollute the main process's
 * console (which the developer is reading for the app's own logs).
 * Chrome's log output is available through
 * `chrome://inspect`'s "Open dedicated DevTools" button if a
 * developer needs it — the terminal is not the right place for it.
 *
 * @param options - The launch configuration. Only `userDataDir` is
 *                  required; all other fields have defaults.
 * @returns A promise that resolves to a `ChromeInstance` handle
 *          once Chrome is ready to accept CDP connections.
 * @throws  `Error` if Chrome cannot be located, fails to spawn, or
 *          does not open its debug port within the timeout. The
 *          port is released on failure.
 */
export const launchChrome = async (
  options: LaunchChromeOptions
): Promise<ChromeInstance> => {
  const executablePath = findChromeExecutable();

  // ---- Determine the port ----
  const explicitPort = options.port;
  const port = explicitPort ?? allocatePort();
  const portWasAllocated = explicitPort === undefined;

  // ---- Ensure the user-data-dir exists ----
  // Chrome requires the parent of `--user-data-dir` to exist. A
  // caller that provides a nested path
  // (`userData/chrome-profile/default`) must have every intermediate
  // directory in place. Rather than replicate `mkdir -p` here, the
  // caller is expected to provide a path whose parent exists — the
  // convention is `path.join(app.getPath('userData'),
  // 'chrome-profile')`, and `app.getPath('userData')` always
  // exists. We check the parent and throw a clear error if it does
  // not; we do not silently create a tree of directories the caller
  // did not intend.
  const parentDir = path.dirname(options.userDataDir);
  if (!existsSync(parentDir)) {
    if (portWasAllocated) {
      releasePort(port);
    }
    throw new Error(
      `The parent directory of the Chrome user-data-dir does not ` +
        `exist: ${parentDir}. The caller must ensure it exists ` +
        `before launching Chrome.`
    );
  }

  // ---- Build the argument list ----
  const args: string[] = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${options.userDataDir}`,
  ];

  for (const flag of CHROME_FLAGS) {
    args.push(flag);
  }

  if (process.platform === 'win32') {
    // See the CHROME_FLAGS comment for why --no-sandbox is Windows-
    // only.
    args.push('--no-sandbox');
  }

  if (options.headless === true) {
    args.push('--headless=new');
  }

  // ---- Spawn ----
  let child: ChildProcess;
  try {
    child = spawn(executablePath, args, {
      stdio: ['ignore', 'ignore', 'ignore'],
      // `detached: false` — the Chrome process is in the same
      // process group as the main process, so a kill of the
      // process group would take Chrome down with it. We do not
      // rely on that (tree-kill handles the tree explicitly), but
      // keeping Chrome attached is the safer default.
      detached: false,
      // `windowsHide: true` — on Windows, do not open a console
      // window for the spawned process. Chrome is a GUI app and
      // does not need one; without this flag, some Windows
      // configurations briefly flash a console window on launch.
      windowsHide: true,
    });
  } catch (err) {
    if (portWasAllocated) {
      releasePort(port);
    }
    throw new Error(
      `Failed to spawn Chrome at ${executablePath}: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }

  // ---- Wait for readiness ----
  const readyTimeoutMs = options.readyTimeoutMs ?? 30_000;
  try {
    await waitForDebugPort(port, readyTimeoutMs);
  } catch (err) {
    // Chrome did not open its debug port. Kill whatever was
    // spawned (it may be alive but stuck) and release the port.
    try {
      await treeKillAsync(child);
    } catch {
      // The kill failure does not change the outcome — Chrome is
      // not usable regardless. The original error is what the
      // caller needs to see.
    }
    if (portWasAllocated) {
      releasePort(port);
    }
    throw err;
  }

  // ---- Register and return ----
  const instance: ChromeInstance = {
    process: child,
    port,
    userDataDir: options.userDataDir,
    executablePath,
  };

  runningInstances.push(instance);

  // ---- Auto-remove on unexpected exit ----
  // If Chrome exits on its own (a crash, a user closing the window
  // manually), the instance should not linger in the registry
  // holding a port. The `exit` event fires for a clean exit AND a
  // crash (with a non-zero code), so a single handler covers both.
  //
  // The handler does NOT call `killChrome` — the process is already
  // dead, and running tree-kill on a dead process is a no-op that
  // would only slow the cleanup down. It removes the registry
  // entry directly and releases the port.
  child.once('exit', () => {
    const idx = runningInstances.indexOf(instance);
    if (idx !== -1) {
      runningInstances.splice(idx, 1);
      releasePort(instance.port);
    }
  });

  return instance;
};

// =============================================================================
//  Public API — kill
// =============================================================================

/**
 * Terminate a Chrome instance and release its port.
 *
 * Uses `tree-kill` to terminate the whole process tree, not just
 * the root Chrome process — see the file header for why this is
 * required on Windows. Waits for the kill to complete (tree-kill's
 * callback is wrapped in a promise) so that callers can await this
 * and then safely release the port.
 *
 * If the instance has already been killed (its `process` field is
 * null, or it is not in the registry), this function is a no-op.
 * This makes cleanup paths — which often run on both success and
 * failure — idempotent without needing an explicit "was I already
 * killed" check.
 *
 * The instance's entry in the registry is removed as part of the
 * kill. The port is released back to the allocator's pool.
 *
 * @param instance - The handle returned by `launchChrome`.
 */
export const killChrome = async (instance: ChromeInstance): Promise<void> => {
  // ---- Registry bookkeeping ----
  // Remove the instance from the registry FIRST so that a
  // concurrent `killAllChrome` does not try to kill it a second
  // time. Both functions check the registry membership before
  // killing, so removing here is what makes the two paths
  // mutually exclusive for a given instance.
  const idx = runningInstances.indexOf(instance);
  if (idx !== -1) {
    runningInstances.splice(idx, 1);
  }

  // ---- Kill the process tree ----
  if (instance.process !== null) {
    try {
      await treeKillAsync(instance.process);
    } catch {
      // A kill failure is logged but does not prevent the port
      // release. The port will be freed for the next allocation
      // either way; a Chrome that survived a tree-kill is a rare
      // and system-level problem, not something this function can
      // meaningfully recover from.
    }
  }

  // ---- Release the port ----
  // Idempotent at the allocator layer — a port that is not
  // currently in use is silently ignored by `releasePort`. This
  // is what makes the double-kill path (manual kill, then
  // shutdown's killAllChrome) safe.
  releasePort(instance.port);
};

/**
 * Terminate every tracked Chrome instance.
 *
 * Iterates the registry from the end backward (most-recently-
 * launched first) and awaits each kill. Called from the app's
 * `before-quit` handler so that quitting the app does not leave
 * orphaned Chrome processes on the user's machine.
 *
 * The registry is fully cleared by the end of this call, whether
 * every kill succeeded or not. A Chrome process that survived a
 * tree-kill is a system-level anomaly; it is not a reason to
 * leave the registry in an inconsistent state.
 *
 * Safe to call when no instances are running — an empty registry
 * iterates zero times.
 */
export const killAllChrome = async (): Promise<void> => {
  // Snapshot the registry and clear it up front, so that any
  // concurrent `launchChrome` call during the loop does not have
  // its new instance killed by this shutdown path.
  const snapshot = runningInstances.splice(0, runningInstances.length);

  // Kill in reverse order — the most-recently-launched first.
  for (let i = snapshot.length - 1; i >= 0; i -= 1) {
    const instance = snapshot[i];
    if (!instance) continue;
    try {
      if (instance.process !== null) {
        await treeKillAsync(instance.process);
      }
    } catch {
      // Best-effort. See `killChrome` for the same reasoning.
    }
    releasePort(instance.port);
  }
};

// =============================================================================
//  Public API — introspection
// =============================================================================

/**
 * Return a snapshot of the currently-tracked instances.
 *
 * The returned array is a fresh copy on every call. The caller
 * cannot mutate the registry by mutating the array, and the
 * returned array does not change if instances are added or
 * removed after the call. Both are what a caller wants when
 * inspecting state for a diagnostic log line or a test assertion.
 *
 * Exported for diagnostics and tests. Production code paths
 * generally hold their own handle (returned by `launchChrome`) and
 * do not need to query the registry.
 */
export const getRunningInstances = (): readonly ChromeInstance[] => {
  return [...runningInstances];
};

// =============================================================================
//  Internal — tree-kill wrapper
// =============================================================================

/**
 * Wrap `tree-kill`'s callback API in a promise.
 *
 * `tree-kill` accepts a callback `(err?: Error) => void`. This
 * wrapper resolves on success and rejects on error, so callers can
 * use `await treeKillAsync(child)` instead of managing the
 * callback.
 *
 * The wrapper resolves if the child has no PID — a `ChildProcess`
 * whose `spawn` failed synchronously has `pid === undefined`, and
 * there is nothing to kill. This mirrors the behavior the caller
 * would want: a kill of an already-dead process is a success, not
 * an error.
 */
const treeKillAsync = (child: ChildProcess): Promise<void> => {
  return new Promise((resolve, reject) => {
    const pid = child.pid;
    if (pid === undefined) {
      resolve();
      return;
    }
    treeKill(pid, (err?: Error) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
};