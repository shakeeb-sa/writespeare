/**
 * WriteSpeare — Electron main process entry point.
 *
 * This is the file `package.json` points at via its `main` field
 * (`dist/main/index.js`). When Electron starts the app, it runs
 * this script in the Node.js context of the main process — the
 * one process that can create windows, spawn child processes,
 * read and write the user's filesystem, and reach the OS's native
 * APIs. Every other script in the app runs either in the
 * preload's isolated context or in the sandboxed renderer, both
 * of which are strictly more limited.
 *
 * Responsibilities, in execution order:
 *
 *   1. Declare the custom `writespeare-asset://` scheme to
 *      Chromium via `registerProtocolSchemes()`. This must run
 *      BEFORE the `ready` event — Electron enforces the ordering
 *      by throwing if the call happens later. See
 *      `./protocols.ts` for the full rationale.
 *
 *   2. Inside `app.whenReady()` — after Chromium has finished
 *      initialising but before any window is created — install
 *      the request handler for the scheme via
 *      `registerProtocolHandlers()`.
 *
 *   3. Create the app's main `BrowserWindow` and load the
 *      renderer into it. In development, the window loads the
 *      Vite dev server URL; in production, it loads the bundled
 *      `dist/renderer/index.html`.
 *
 *   4. Read the cached DeepSeek session status from the
 *      encrypted store, and — when the Chrome launcher's
 *      registry is non-empty — kick off a fresh check in the
 *      background. The check is fire-and-forget; its result is
 *      written to the same encrypted-store field the renderer
 *      reads via `deepseek:checkSession`.
 *
 *   5. Install the three lifecycle hooks every Electron app
 *      needs:
 *
 *        - `window-all-closed` — quit the app on Windows and
 *          Linux when the last window closes. On macOS, stay
 *          running (the platform's convention is that the app
 *          survives with no windows and reopens on a dock click).
 *
 *        - `activate` — on macOS, reopen the main window when the
 *          user clicks the dock icon with no windows open.
 *
 *        - `before-quit` — the shutdown hook. This is where the
 *          app will kill any running Python child processes and
 *          dispose any schedulers before the process exits. The
 *          hook exists today with no work to do; it will grow as
 *          the research, extraction, and writer features are
 *          built in later sessions.
 *
 * IPC handler registration:
 *
 *   Every feature's IPC module is imported at the top of this
 *   file and its `register*IPC()` function is called inside the
 *   `whenReady` callback, before the first window is created.
 *   The registration installs the `ipcMain.handle(...)` handlers
 *   for every channel that feature serves, so the renderer's
 *   `window.electronAPI.*` calls resolve.
 *
 *   The list is complete as of PR-7 of the execution runbook:
 *   auth, topics, research, documents, writer, validation,
 *   export, settings, admin, automation, prompts, and deepseek.
 *   Each module's session number is noted in the import block
 *   above; the registration calls below are ordered by that
 *   same session sequence so a reader scanning the callback
 *   sees the same order the runbook uses.
 *
 *   A feature's registration function is not idempotent —
 *   `ipcMain.handle` refuses to register a second handler for
 *   the same channel — so this file calls each one exactly once
 *   per process. A future session that needed to re-register a
 *   channel after a hot-reload would need to
 *   `ipcMain.removeHandler` first; nothing in the current app
 *   does that.
 *
 * Window creation — the settings that matter and why:
 *
 *   contextIsolation: true — the security boundary that keeps
 *     the preload's JavaScript context separate from the
 *     renderer's. Without it, the renderer could reach into the
 *     preload's scope and modify the exposed API. This is
 *     Electron's default and must never be turned off.
 *
 *   nodeIntegration: false — the renderer runs in the browser
 *     sandbox and has no access to Node's `require`, `process`,
 *     or `fs`. All access flows through the preload's
 *     `contextBridge`. Also Electron's default.
 *
 *   sandbox: false — this one is a deliberate deviation from
 *     Electron's default. The app's `package.json` declares
 *     `"type": "module"`, which makes the compiled preload an
 *     ESM file (`.js` interpreted as ESM). Electron's sandboxed
 *     preload context only supports CommonJS; to run an ESM
 *     preload, sandbox must be disabled. The trade-off is
 *     acceptable because `contextIsolation` and
 *     `nodeIntegration` are the two boundaries that actually
 *     protect the renderer from the OS; `sandbox` protects
 *     against a compromised Node context being able to install
 *     itself into a compromised renderer, which is a narrower
 *     concern. A future session that wants to re-enable the
 *     sandbox would need to compile the preload as CommonJS —
 *     a build-pipeline change that is out of scope for this
 *     file.
 *
 *   preload — the path to the compiled preload script. In the
 *     built app, this file lives at `dist/main/index.js`, and
 *     the preload lives alongside it at `dist/main/preload.js`,
 *     so the path is `path.join(__dirname, 'preload.js')`. The
 *     `__dirname` equivalent for an ESM module is derived from
 *     `import.meta.url` below.
 *
 *   show: false + ready-to-show — the window is created hidden
 *     and only shown once its content has painted. Without this,
 *     the user would see a blank white rectangle for the first
 *     few hundred milliseconds while the renderer loads. The
 *     `ready-to-show` event fires when the first frame has been
 *     rendered, and `win.show()` at that point produces a window
 *     that opens with content already in place.
 *
 * Renderer loading — dev vs. production:
 *
 *   `app.isPackaged` is the standard Electron flag for "am I a
 *   packaged app or a development process". In development, it
 *   is `false`, and the window loads the Vite dev server URL so
 *   the renderer gets hot-module-replacement. In production, it
 *   is `true`, and the window loads the bundled HTML from the
 *   app's own resources.
 *
 *   The dev URL is hard-coded to `http://localhost:5173` because
 *   `vite.config.ts` pins the dev server to that port with
 *   `strictPort: true`. If the port is ever changed in the Vite
 *   config, the constant below must change with it.
 */

import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  registerProtocolSchemes,
  registerProtocolHandlers,
} from './protocols.js';

// ---- Feature IPC modules ----
//
// One import per feature. Each module exports a `register*IPC()`
// function that installs the `ipcMain.handle(...)` handlers for
// the channels that feature serves. The functions are invoked
// inside the `app.whenReady()` callback below, after Chromium
// has finished initialising and before the first window is
// created — the same place `registerProtocolHandlers()` is
// called, and for the same reason: everything the window will
// need at first paint must be in place before the window opens.
//
// The import order matches the session order in the plan's
// coding runbook (auth first, then topics, then the seven
// subsequent features) so that a future reader scanning this
// block sees the same sequence the runbook uses.
//
// Every import specifier uses the `.js` extension, which is the
// codebase-wide convention for the desktop app's ESM build.
// TypeScript resolves `.js` back to the `.ts` source at compile
// time; Node resolves the extension literally at runtime against
// the compiled `.js` output in `dist/`.
import { registerAuthIPC } from '../features/auth/ipc/authIPC.js';
import { registerTopicsIPC } from '../features/topics/ipc/topicsIPC.js';
import { registerResearchIPC } from '../features/research/ipc/researchIPC.js';
import { registerDocumentsIPC } from '../features/documents/ipc/documentsIPC.js';
import { registerWriterIPC } from '../features/writer/ipc/writerIPC.js';
import { registerValidationIPC } from '../features/validation/ipc/validationIPC.js';
import { registerExportIPC } from '../features/export/ipc/exportIPC.js';
import { registerSettingsIPC } from '../features/settings/ipc/settingsIPC.js';
import { registerAdminIPC } from '../features/admin/ipc/adminIPC.js';
import { registerAutomationIPC } from '../features/automation/ipc/automationIPC.js';
import { registerPromptsIPC } from '../features/writer/ipc/promptsIPC.js';
import { registerDeepSeekIPC } from '../features/writer/ipc/deepseekIPC.js';

// ---- Launch-time DeepSeek session check dependencies ----
//
// The three imports below support the launch-time session check
// in the `whenReady` callback. They are declared separately from
// the IPC module imports above because their purpose is
// different: the IPC imports exist to register handlers, these
// three exist to run one background operation at startup.
//
//   * `getDeepSeekSessionStatus` / `setDeepSeekSessionStatus`
//     from `./store.js` — the encrypted store's accessor pair
//     for the cached session-status field. The plan's PR-7
//     modification to `main/store.ts` added the field.
//
//   * `checkSession` from the writer feature's
//     `sessionCheckService` — the same triple-check the
//     `deepseek:checkSession` IPC channel invokes. Called
//     directly (not through the IPC layer) because no renderer
//     is mounted yet at this point in the startup sequence.
//
//   * `getRunningInstances` from the research feature's
//     `chromeLauncher` — used to decide whether a fresh check
//     is worth running. The check is skipped when Chrome is
//     not already open, matching the plan's N2 decision
//     ("check at launch only if Chrome is already open").
import {
  getDeepSeekSessionStatus,
  setDeepSeekSessionStatus,
} from './store.js';
import { checkSession } from '../features/writer/services/sessionCheckService.js';
import { getRunningInstances } from '../features/research/services/chromeLauncher.js';

// ============================================================
//  Constants
// ============================================================

/**
 * The Vite dev server URL the renderer is loaded from while
 * `app.isPackaged` is `false`. Must match the `server.port`
 * value declared in `vite.config.ts` — see the file header for
 * why the two are coupled.
 */
const DEV_SERVER_URL = 'http://localhost:5173';

/**
 * Default window dimensions. The width and height are the size
 * the window opens at; the minimums are the smallest size the
 * user is allowed to shrink it to. 1024×720 is the smallest
 * size at which the app's sidebar + main content layout still
 * fits without horizontal scrolling; the default of 1440×900 is
 * a comfortable size on a modern high-DPI display.
 */
const WINDOW_DEFAULT_WIDTH = 1440;
const WINDOW_DEFAULT_HEIGHT = 900;
const WINDOW_MIN_WIDTH = 1024;
const WINDOW_MIN_HEIGHT = 720;

/**
 * The background color the window paints before its content
 * loads. Matches the light-mode `background` token declared in
 * `tailwind.config.js`, so the brief moment between window
 * creation and first paint is not a flash of a different color.
 *
 * If the user has the app configured for dark mode, this color
 * is wrong for them — but the window only shows this color for
 * the few hundred milliseconds before React mounts and the theme
 * applies. Using a fixed value here is simpler than reading the
 * user's theme preference before the renderer has loaded it, and
 * the flash is small enough that the complexity is not worth it.
 */
const WINDOW_BACKGROUND = '#ffffff';

// ============================================================
//  ESM directory resolution
// ============================================================

/**
 * The directory this file lives in, as an absolute path. In the
 * built app, that is `dist/main/`.
 *
 * ESM does not provide `__dirname` as a global the way CommonJS
 * does, so it is reconstructed here from `import.meta.url` — the
 * file's own `file://` URL — via `fileURLToPath` and
 * `path.dirname`. This is the canonical replacement and is used
 * by every ESM module in the codebase that needs its own
 * directory.
 */
const currentDir = path.dirname(fileURLToPath(import.meta.url));

// ============================================================
//  Module-scope state
// ============================================================

/**
 * The app's main window, held in a module-scope binding so that
 * the `activate` handler (macOS) and the `before-quit` handler
 * can reach it. The binding is set when the window is created
 * and cleared when it is closed — a window's `closed` event
 * fires after the window has been destroyed, so leaving the
 * reference in place would risk a use-after-destroy from any
 * later code that touched it.
 */
let mainWindow: BrowserWindow | null = null;

/**
 * `true` when running from source (development), `false` when
 * running from a packaged build. Read once at module load and
 * cached so the numerous dev/prod branches throughout this file
 * do not each re-read the property.
 */
const isDev = !app.isPackaged;

// ============================================================
//  Phase 1 — protocol scheme registration
// ============================================================
//
//  MUST run before app.whenReady() resolves. Electron throws if
//  a scheme is registered after ready, and the throw happens
//  inside the ready callback rather than at startup, which
//  produces a confusing delayed failure. Doing it here, at
//  module load, is the correct timing.

registerProtocolSchemes();

// ============================================================
//  Window factory
// ============================================================

/**
 * Build the app's main window and load the renderer into it.
 *
 * Called from inside the `whenReady` handler (for the first
 * window) and again from the macOS `activate` handler when the
 * user clicks the dock icon with no windows open. Because the
 * function has no state beyond its arguments and the module-
 * scope `mainWindow` binding, calling it twice produces two
 * independent windows rather than a shared one — which is what
 * the macOS convention expects.
 *
 * The return value is the newly-created window; the caller is
 * responsible for storing it in `mainWindow` if it wants to
 * track it.
 */
const createWindow = (): BrowserWindow => {
  const win = new BrowserWindow({
    width: WINDOW_DEFAULT_WIDTH,
    height: WINDOW_DEFAULT_HEIGHT,
    minWidth: WINDOW_MIN_WIDTH,
    minHeight: WINDOW_MIN_HEIGHT,

    // Do not show the window until its content has rendered.
    // The `ready-to-show` listener below calls `.show()` at the
    // right moment. See the file header for the rationale.
    show: false,

    // Hide the menu bar on Windows and Linux. The app does not
    // declare a custom menu, and the default Electron menu
    // (File / Edit / View / Window / Help) is not part of the
    // app's design. On macOS the menu bar is OS-level and not
    // affected by this setting.
    autoHideMenuBar: true,

    // The color the window paints before its content loads. See
    // the constant's docstring for why it is a fixed value.
    backgroundColor: WINDOW_BACKGROUND,

    // The web preferences that govern the renderer's security
    // posture. See the file header for the reasoning behind each.
    webPreferences: {
      preload: path.join(currentDir, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // `webSecurity` is left at its default (`true`), which
      // enforces the same-origin policy in the renderer. It is
      // spelled out here as a comment rather than a value so a
      // future reader does not mistake its absence for an
      // oversight.
    },
  });

  // Reveal the window once Chromium has rendered the first frame.
  win.once('ready-to-show', () => {
    win.show();
  });

  // Load the renderer. In development, from the Vite dev server;
  // in production, from the bundled HTML file that Vite wrote to
  // `dist/renderer/`.
  if (isDev) {
    void win.loadURL(DEV_SERVER_URL);

    // Open the Chromium DevTools in a separate window so the
    // developer can inspect the renderer. Detached mode is
    // deliberate — docking the DevTools inside the app's window
    // would shrink the renderer to a size the design was not
    // laid out for, which produces misleading visual bugs.
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    void win.loadFile(path.join(currentDir, '../renderer/index.html'));
  }

  // Clear the module-scope reference when this window is
  // destroyed. See the docstring on `mainWindow` for why.
  win.on('closed', () => {
    if (mainWindow === win) {
      mainWindow = null;
    }
  });

  return win;
};

// ============================================================
//  Lifecycle — ready
// ============================================================

/**
 * The app's startup sequence. Runs once, when Electron has
 * finished loading Chromium and the Node runtime is fully
 * available.
 *
 * The three steps are ordered deliberately:
 *
 *   1. `registerProtocolHandlers()` before any window is
 *      created. The window's first paint will request images
 *      through the custom scheme; if the handler is not yet
 *      installed, those requests fail with a network error and
 *      the window's content shows broken-image placeholders.
 *      Installing the handler first guarantees the scheme is
 *      ready before the renderer asks for anything.
 *
 *   2. IPC handler registration. See the block comment below.
 *
 *   3. Window creation. The window is the last step so that
 *      everything it will need at first paint — the scheme
 *      handler and the IPC handlers — is already in place.
 *
 * The `activate` listener is installed inside this callback
 * rather than at module scope because the listener references
 * `BrowserWindow.getAllWindows()`, which is only meaningful once
 * the app is ready. Installing it earlier would work but would
 * tie the listener to an app in a pre-ready state, which is a
 * corner case worth avoiding.
 */
void app.whenReady().then(() => {
  // ---- 1. Install the protocol handler ----
  // See `./protocols.ts` for the scheme's full specification.
  registerProtocolHandlers();

  // ---- 2. IPC handler registration ----
  //
  // Each feature's IPC module is imported at the top of this
  // file and its registration function is called here, inside
  // the `whenReady` callback. The registration installs the
  // `ipcMain.handle(...)` handlers for every channel that
  // feature serves, so the renderer's `window.electronAPI.*`
  // calls resolve. See the imports block at the top of this
  // file for the full list of the twelve functions being
  // called here.
  //
  // The calls are ordered by session number so that a future
  // reader scanning this block sees the same sequence the
  // plan's coding order uses. Order does not affect runtime
  // behaviour — each function only registers handlers, and no
  // function depends on another having run first.
  //
  // `registerPromptsIPC` and `registerDeepSeekIPC` are the two
  // most recent additions (PR-6 and PR-7 of the execution
  // runbook). They are appended after the earlier ten so that
  // the block reads as "the original ten, then the two
  // additions" — the same incremental shape the import block
  // above uses.
  registerAuthIPC();
  registerTopicsIPC();
  registerResearchIPC();
  registerDocumentsIPC();
  registerWriterIPC();
  registerValidationIPC();
  registerExportIPC();
  registerSettingsIPC();
  registerAdminIPC();
  registerAutomationIPC();
  registerPromptsIPC();
  registerDeepSeekIPC();

  // ---- 3. Create the main window ----
  mainWindow = createWindow();

    // ---- 4. Launch-time DeepSeek session check ----
  //
  // Per the plan's N2 decision: check at launch only if Chrome
  // is already open. Otherwise the launch sequence leaves the
  // cached status alone, and the first Chrome-requiring action
  // (a search, an extraction, a writer run) runs its own fresh
  // check when it is actually needed.
  //
  // The `getRunningInstances()` call is what distinguishes the
  // two cases. When the launcher's registry is empty — the
  // common case on a cold start, because the `before-quit`
  // handler kills every tracked Chrome before the app exits —
  // the cached status is left in place and no background check
  // fires.
  //
  // When the registry is non-empty — a previous session left
  // Chrome orphaned after an unclean exit — a fresh check runs
  // in the background. The check is fire-and-forget: it does
  // not block the window from opening, and its result is
  // written to the encrypted store's cache so the renderer's
  // first `deepseek:checkSession` call (whenever it fires)
  // reads the freshest value.
  //
  // The cached status is read unconditionally, whether Chrome
  // is running or not, so the developer-facing log line names
  // the last-known state on every launch. The renderer reads
  // the same value through its own hook; the log line exists
  // for the Electron main process's terminal, not for the UI.
  const cachedSession = getDeepSeekSessionStatus();
  if (cachedSession !== null) {
    console.log(
      `[main] DeepSeek session cached: live=${cachedSession.live} ` +
        `(checked ${cachedSession.checkedAt})`
    );
  } else {
    console.log(
      '[main] DeepSeek session status not yet cached — ' +
        'will be populated on the first check.'
    );
  }
  if (getRunningInstances().length > 0) {
    void (async (): Promise<void> => {
      try {
        const result = await checkSession();
        setDeepSeekSessionStatus(result);
        console.log(
          `[main] DeepSeek session re-checked at launch: ` +
            `live=${result.live}`
        );
      } catch (err) {
        // A failure here is logged but does not block startup.
        // The renderer's own check — triggered on the settings
        // page's mount and on the writer tab's idle state —
        // re-runs when the user actually needs the status.
        console.error(
          '[main] launch-time DeepSeek session check failed:',
          err
        );
      }
    })();
  }

  // ---- macOS activate handler ----
  // On macOS, closing the last window does not quit the app.
  // When the user clicks the dock icon with no windows open,
  // macOS fires the `activate` event and the app is expected to
  // reopen its main window. On other platforms this event does
  // not fire — the app's lifecycle is simpler — so the handler
  // is effectively a no-op there.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow();
    }
  });
});

// ============================================================
//  Lifecycle — window-all-closed
// ============================================================

/**
 * Quit the app when its last window closes, except on macOS.
 *
 * This is the standard Electron pattern. On Windows and Linux,
 * a desktop app that has no windows has no reason to keep
 * running — the process should exit and free its resources. On
 * macOS, the platform convention is the opposite: the app stays
 * alive with no windows, and the user reopens a window by
 * clicking the dock icon (which fires the `activate` event
 * handled above). Respecting the platform convention on each
 * OS is what makes an Electron app feel native rather than
 * ported.
 */
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// ============================================================
//  Lifecycle — before-quit
// ============================================================

/**
 * The app's shutdown hook.
 *
 * This is where the app disposes of anything that would otherwise
 * become an orphaned process or a leaked resource when the app
 * exits. As of this session, there is nothing to dispose — the
 * research, extraction, and writer features that spawn Python
 * child processes are built in later sessions.
 *
 * The hook exists now so that the shape of the shutdown
 * sequence is in place from the start. When a feature begins
 * spawning child processes, the cleanup call is added here in
 * the same session that introduces the spawning. The alternative
 * — adding the hook when the first child process is created —
 * would mean a session that adds a feature but forgets to add
 * the cleanup, and that forgetfulness would produce zombies
 * that are hard to diagnose.
 *
 * The handler is `async` even though the current body is
 * synchronous, because every future addition to it (killing a
 * child process via `tree-kill`, awaiting a `childProcess.kill`
 * promise, waiting for a Chrome instance to disconnect) will be
 * asynchronous. The `void` in front of the callback invocation
 * suppresses the "floating promise" lint warning that would
 * otherwise fire on the ignored return value.
 */
app.on('before-quit', () => {
  void (async () => {
    // ---- Shutdown sequence ----
    //
    // When feature sessions add child processes, the cleanup
    // calls go here, in reverse order of their creation so that
    // a process that depends on another is killed first. The
    // ordering note is preserved even though the list is empty
    // today, so the first future addition does not have to
    // rediscover it.
    //
    // Example shape once populated (commented for reference):
    //
    //   await writerService.killAll();
    //   await extractionService.killAll();
    //   await searchService.killAll();
    //   await chromeLauncher.killAll();
  })();
});