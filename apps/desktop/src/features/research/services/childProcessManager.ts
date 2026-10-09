/**
 * childProcessManager — Python subprocess lifecycle for the main process.
 *
 * Every WriteSpeare automation operation — search, extract, write,
 * validate, export — runs as a short-lived Python subprocess
 * spawned via `python main.py <subcommand> ...`. This module owns
 * the lifecycle of those subprocesses: it spawns them with the
 * correct executable, working directory, and environment; it
 * surfaces their stdout and stderr as line events; it kills their
 * entire process tree on demand; and it tracks every live manager
 * in a module-level registry so the app can find them at shutdown.
 *
 * The registry model — one manager per running task, keyed by taskId:
 *
 *   A task ID is a caller-supplied string that identifies a single
 *   running operation. Two concurrent operations (a search for
 *   topic A and an extraction for topic B) get two distinct task
 *   IDs and therefore two distinct managers; each manager's events
 *   belong exclusively to its own operation. The registry keyed
 *   by taskId is what allows a "kill everything" or "find the
 *   manager for topic X" call without the caller having to hold a
 *   reference to every manager it ever created.
 *
 *   The task ID is opaque to this module. A caller that uses
 *   `${topicId}-search` gets one behavior; a caller that uses a
 *   fresh UUID per operation gets another. The module's contract
 *   is only that the same taskId identifies the same manager
 *   (idempotent `createProcessManager`) and that different taskIds
 *   produce different managers.
 *
 * What this module does NOT do:
 *
 *   - It does not parse markers. The `::ROOKIE::<TYPE>::<json>`
 *     lines that `main.py` emits to stdout are parsed by the
 *     sibling `listenerBridge.ts` module, which attaches to the
 *     same ChildProcess stdout independently. This module emits
 *     raw stdout lines for any consumer that wants them (a
 *     developer inspecting the process, a future logging layer);
 *     the marker parsing and the IPC forwarding are the bridge's
 *     job, not this module's.
 *
 *   - It does not launch Chrome. Chrome is launched by the sibling
 *     `chromeLauncher.ts` module — a separate lifecycle with a
 *     separate registry. The port number the launcher assigns is
 *     passed to the Python script as a CLI argument (`--port`),
 *     and the script connects to that Chrome instance over CDP.
 *
 *   - It does not allocate ports. Ports are allocated by the
 *     sibling `portAllocator.ts` module, used by the launcher, and
 *     passed to the Python script as a CLI argument by the caller
 *     that built the operation's argument list.
 *
 *   - It does not know what a "topic" is. Topics, articles,
 *     reports, and every other domain concept live in the callers
 *     (searchService, extractionService, writerService, and so on
 *     — added in later session steps). This module operates on
 *     task IDs and argument arrays only.
 *
 *   - It does not write to a run-config file. The ROOKIE launcher
 *     read a config file that carried the plan path, the campaign
 *     ID, and the captcha policy. WriteSpeare's `main.py` has no
 *     such file — every operation's arguments arrive on the
 *     command line, and the captcha policy arrives via the
 *     WRITESPEARE_CAPTCHA_POLICY environment variable when the
 *     caller overrides the default.
 *
 * The environment variables the manager sets on every child:
 *
 *   PYTHONUTF8=1
 *       Force Python to use UTF-8 for all text I/O. Without this,
 *       Python on Windows defaults to the system code page (often
 *       cp1252), and a single emoji or a non-ASCII character in a
 *       scraped title crashes the process. Required for the
 *       pipeline to handle the web's actual content.
 *
 *   PYTHONIOENCODING=utf-8
 *       The complementary setting for stdin and stderr. Both are
 *       needed — PYTHONUTF8 handles the encoding, PYTHONIOENCODING
 *       handles the stream configuration.
 *
 *   PYTHONUNBUFFERED=1
 *       Disable Python's block-buffered stdout when the output is
 *       a pipe. Without it, print() calls sit in an 8 KB in-memory
 *       buffer until the child exits, so a search's progress
 *       markers would all arrive at the renderer in a single burst
 *       AFTER the search finished — making the UI look frozen
 *       during the search and then suddenly complete. With this
 *       set, each marker flushes immediately and progress streams
 *       live.
 *
 *   PLAYWRIGHT_BROWSERS_PATH=<resolved path>
 *       Point Playwright at the bundled Chromium binaries instead
 *       of the default per-user cache. Without this, the packaged
 *       app's Python scripts would fail on a machine that has
 *       never run `playwright install chromium`, because
 *       Playwright would look in a directory that does not exist.
 *       The path is resolved from `app.isPackaged` so dev and
 *       packaged builds use different (correct) locations.
 *
 *   WRITESPEARE_CAPTCHA_POLICY=<policy>
 *       Set only when the caller supplies a `captchaPolicy` in
 *       `ProcessOptions`. When absent, `core/output.py` defaults
 *       the policy to 'ask' — the correct behavior for a normal
 *       interactive run. A caller that wants to auto-skip or
 *       auto-stop on captcha sets this explicitly.
 *
 * Dependencies: Node stdlib + electron + `tree-kill` (declared in
 * `apps/desktop/package.json`).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { app } from 'electron';
import treeKill from 'tree-kill';

// =============================================================================
//  ESM directory resolution
// =============================================================================
//
//  In the compiled output, this module lives at
//  `dist/features/research/services/childProcessManager.js`. The
//  path helpers below use `__dirname` to derive absolute paths to
//  the bundled Python runtime and the Python script source. ESM
//  does not provide `__dirname` as a global (unlike CommonJS), so
//  it is reconstructed here from `import.meta.url` via
//  `fileURLToPath` and `path.dirname`.

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// =============================================================================
//  Public types
// =============================================================================

/**
 * The options accepted by `ChildProcessManager.start()`.
 */
export interface ProcessOptions {
  /**
   * Arguments passed to `main.py`, NOT including the script's own
   * path (the manager prepends it) and NOT including a `--control-mode`
   * flag (the caller includes it in this array when marker emission
   * is wanted).
   *
   * Example for a search operation:
   *
   *     ['search', '--query', 'small space gardening',
   *      '--keywords', 'container gardening,vertical planters',
   *      '--max-results', '20', '--topic-id', 'abc123',
   *      '--port', '9222', '--control-mode']
   */
  args: string[];

  /**
   * Working directory for the child process. Defaults to the
   * scripts folder (`<resources>/scripts` in packaged builds,
   * `src/resources/scripts` in development). The default is what
   * `main.py` expects — its `sys.path` bootstrap adds its own
   * directory to `sys.path`, so `core.*` and `research.*` imports
   * resolve regardless of cwd, but the default matches the
   * convention.
   */
  cwd?: string;

  /**
   * Additional environment variables for the child. Merged on top
   * of the manager's own environment (which includes
   * `process.env` plus the six WriteSpeare-specific variables
   * documented in the file header). A caller that passes a value
   * for a variable the manager already sets overrides the
   * manager's value.
   */
  env?: Record<string, string>;

  /**
   * Optional captcha policy for the child. When provided, the
   * manager sets `WRITESPEARE_CAPTCHA_POLICY` to this value in the
   * child's environment. When omitted, the variable is not set and
   * `core/output.py`'s `manual_action_required` defaults the
   * policy to `'ask'` — the correct behavior for a normal
   * interactive run.
   *
   * `'ask'`  — show the captcha modal and block for the user
   *            (this is what the default produces; passing it
   *            explicitly is equivalent to omitting the field).
   * `'skip'` — auto-skip the operation with exit code 101
   *            (`EXIT_CAPTCHA_SKIP`).
   * `'stop'` — auto-stop the run with exit code 100
   *            (`EXIT_STOPPED`).
   */
  captchaPolicy?: 'ask' | 'skip' | 'stop';

  /**
   * Optional timeout in milliseconds. When set and greater than
   * zero, the manager starts a timer on spawn; if the child has
   * not exited by the deadline, the manager emits a `timeout`
   * event and calls `kill()`. When omitted (or set to a
   * non-positive value), no timer is started and the child runs
   * until it exits on its own or the caller kills it.
   *
   * The default (no timeout) is correct for operations whose
   * duration depends on the target site's responsiveness — a
   * search may legitimately take thirty seconds on a slow network,
   * and a hard timeout that fires early would abort a working run.
   */
  timeout?: number;
}

/**
 * The events `ChildProcessManager` emits. This interface documents
 * the shapes a caller can expect when it subscribes; it is NOT a
 * compile-time constraint (Node's `EventEmitter` accepts any
 * listener signature), but it is the contract callers should rely
 * on when they write their handlers.
 *
 * Usage:
 *
 *     const manager = createProcessManager(taskId);
 *     manager.on('stdout', (line) => { ... });
 *     manager.on('exit', (code, signal) => { ... });
 *     await manager.start({ args: [...] });
 */
export interface ProcessEvents {
  /** Emitted for each complete line of child stdout. */
  stdout: (line: string) => void;

  /** Emitted for each complete line of child stderr. */
  stderr: (line: string) => void;

  /** Emitted when the child process exits on its own (not when
   *  it was killed by the manager — the `killed` event covers
   *  that case). */
  exit: (code: number | null, signal: string | null) => void;

  /** Emitted when the manager's `kill()` terminates the child. */
  killed: () => void;

  /** Emitted when the manager's timeout fires and the child is
   *  killed. */
  timeout: () => void;

  /** Emitted when the child process fails to spawn or encounters
   *  a runtime error (a broken pipe, a signal from an external
   *  source). */
  error: (error: Error) => void;
}

// =============================================================================
//  Path helpers
// =============================================================================
//
//  Every path helper is a pure function of `app.isPackaged` and
//  `__dirname`. None of them touch the filesystem — a helper that
//  returns a path the app cannot use will fail at the point of
//  use, with a clearer error than an `existsSync` check here would
//  produce. The exception is `getScriptPath`'s dev branch, which
//  does check for the compiled location's existence before falling
//  back — a nuance inherited from the ROOKIE source and preserved
//  here for the same reason.

/**
 * Absolute path to the Python interpreter the manager spawns.
 *
 *   Packaged: `<resources>/python/python.exe` (Windows),
 *             `<resources>/python/bin/python3` (macOS / Linux).
 *   Dev:      `'python'` — resolved by the OS's `PATH` lookup.
 *             A developer running the app from a terminal has a
 *             working Python on their PATH; requiring the embedded
 *             runtime for dev would mean every dev iteration has to
 *             go through the packaged build, which is not the
 *             workflow the plan intends.
 */
const getPythonExecutable = (): string => {
  if (app.isPackaged) {
    const basePath = process.resourcesPath;
    const platform = process.platform;
    if (platform === 'win32') {
      return path.join(basePath, 'python', 'python.exe');
    }
    if (platform === 'darwin' || platform === 'linux') {
      return path.join(basePath, 'python', 'bin', 'python3');
    }
    return path.join(basePath, 'python', 'python');
  }
  return 'python';
};

/**
 * Absolute path to `main.py`.
 *
 *   Packaged: `<resources>/scripts/main.py` — matches the
 *             `extraResources` mapping in `apps/desktop/package.json`.
 *   Dev:      `apps/desktop/src/resources/scripts/main.py` —
 *             resolved relative to this file's compiled location
 *             (`dist/features/research/services/`).
 */
const getScriptPath = (): string => {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'scripts', 'main.py');
  }
  // Dev path: from dist/features/research/services/ up four levels
  // to the desktop app root, then into src/resources/scripts.
  const devPath = path.join(
    __dirname,
    '../../../..',
    'src',
    'resources',
    'scripts',
    'main.py'
  );
  return devPath;
};

/**
 * Absolute path to the working directory the child should use.
 *
 *   Packaged: `<resources>/scripts` — the folder containing
 *             `main.py` and the sibling `core/`, `research/`,
 *             `writer/`, `validation/`, and `export/` packages.
 *   Dev:      `apps/desktop/src/resources/scripts` — the same
 *             folder in the source tree.
 */
const getWorkingDirectory = (): string => {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'scripts');
  }
  return path.join(
    __dirname,
    '../../../..',
    'src',
    'resources',
    'scripts'
  );
};

/**
 * Absolute path to the folder containing Playwright's bundled
 * Chromium binaries.
 *
 *   Packaged: `<resources>/python/ms-playwright` — matches the
 *             `extraResources` mapping.
 *   Dev:      `apps/desktop/src/resources/python/ms-playwright` —
 *             the folder the Python-runtime setup step installs
 *             Chromium into.
 *
 * Exported to the child via `PLAYWRIGHT_BROWSERS_PATH`. See the
 * file header for why this is required.
 */
const getPlaywrightBrowsersPath = (): string => {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'python', 'ms-playwright');
  }
  return path.join(
    __dirname,
    '../../../..',
    'src',
    'resources',
    'python',
    'ms-playwright'
  );
};

// =============================================================================
//  ChildProcessManager
// =============================================================================

/**
 * Manages one Python subprocess.
 *
 * Every instance is registered in the module-level `processManagers`
 * map (below) under its `taskId`. The map is the app's source of
 * truth for "which Python processes are currently running"; the
 * instance itself owns the actual child process handle, the
 * timeout timer, and the event emission.
 *
 * The class extends `EventEmitter`. A caller subscribes via the
 * standard `on(event, listener)` / `once(event, listener)` methods
 * with the event names documented in `ProcessEvents`.
 *
 * Construction:
 *
 *     const manager = createProcessManager(taskId);
 *     manager.on('stdout', handleStdout);
 *     manager.on('exit', handleExit);
 *     await manager.start({ args: [...] });
 *
 * The `createProcessManager` helper is the recommended way to
 * construct an instance — it goes through the registry and is
 * idempotent for the same task ID. Direct `new ChildProcessManager(...)`
 * is supported (the constructor is public) for tests that want an
 * unregistered instance, but a caller that constructs directly is
 * responsible for its own disposal.
 */
export class ChildProcessManager extends EventEmitter {
  /**
   * The task ID this manager was created under. Set at
   * construction and never changes. Used as the registry key in
   * the module-level map and included in every log line so a
   * developer scanning the main-process console can tell which
   * manager emitted which message when several operations run in
   * parallel.
   */
  public readonly taskId: string;

  /**
   * The live child process, or `null` when none is running. Set
   * by `start()`; cleared by the exit handler, the error handler,
   * and `kill()`. A caller that holds a manager reference can
   * observe this field to answer "is the child still alive?"
   * without going through the `isRunning()` method.
   */
  private process: ChildProcess | null = null;

  /**
   * Whether the current child (if any) was terminated by this
   * manager's `kill()` rather than exiting on its own. The
   * `exit` event is suppressed when this is `true` — the `killed`
   * event covers that case — so a caller's exit handler does not
   * fire for a kill it initiated itself.
   */
  private isKilled = false;

  /**
   * The pending timeout timer, or `null`. Set by `start()` when
   * the caller supplies a positive timeout; cleared by the exit
   * handler, the error handler, and `kill()`.
   */
  private timeoutId: NodeJS.Timeout | null = null;

  /**
   * @param taskId - The identifier this manager is registered
   *                 under. Must be a non-empty string. The
   *                 constructor throws if it is empty or
   *                 non-string, because an empty task ID would
   *                 silently collide with every other empty ID
   *                 in the registry.
   */
  public constructor(taskId: string) {
    super();
    if (typeof taskId !== 'string' || !taskId.trim()) {
      throw new Error(
        'ChildProcessManager requires a non-empty taskId.'
      );
    }
    this.taskId = taskId.trim();
  }

  // ---------------------------------------------------------------------------
  //  start
  // ---------------------------------------------------------------------------

  /**
   * Spawn the child process.
   *
   * Returns a promise that resolves once the `spawn` call has
   * returned a handle. It does NOT wait for the child to finish —
   * the child's output and termination arrive as events, and the
   * caller subscribes to them before or immediately after calling
   * `start()`.
   *
   * If a child is already running under this manager, `start()`
   * calls `kill()` on it first (fire-and-forget — the previous
   * child's kill completes asynchronously) and then spawns the
   * new one. This matches the "a manager represents one running
   * operation" model; a caller that wants two concurrent
   * operations uses two managers.
   *
   * The promise resolves on success and rejects only if the
   * `spawn` call itself throws synchronously (a malformed
   * executable path, an EACCES on the interpreter). A spawn
   * failure that arrives asynchronously — a nonexistent
   * executable, a permission error — is delivered via the `error`
   * event; the promise has already resolved by then, and the
   * caller's error handler is what sees it.
   */
  public start(options: ProcessOptions): Promise<void> {
    return new Promise((resolve, reject) => {
      // Ensure any previous process is killed. `kill()` is
      // fire-and-forget — the previous child's tree-kill
      // completes asynchronously, but we do not wait for it
      // before spawning the new child. That is safe because the
      // new child gets a fresh set of env vars and args; if the
      // old child's teardown still has a socket open somewhere,
      // the two children do not interact.
      if (this.process) {
        this.kill();
      }

      const pythonPath = getPythonExecutable();
      const scriptPath = getScriptPath();
      const cwd = options.cwd ?? getWorkingDirectory();
      const playwrightBrowsersPath = getPlaywrightBrowsersPath();

      // ---- Build the environment ----
      // Order of precedence (later entries win):
      //   1. process.env — inherit the main process's environment
      //      so PATH, SystemRoot, and the OS's own variables are
      //      available to the child.
      //   2. The six WriteSpeare-specific variables documented in
      //      the file header.
      //   3. WRITESPEARE_CAPTCHA_POLICY if the caller supplied
      //      options.captchaPolicy.
      //   4. options.env — caller-supplied overrides, applied last.
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        PYTHONUTF8: '1',
        PYTHONIOENCODING: 'utf-8',
        PYTHONUNBUFFERED: '1',
        PLAYWRIGHT_BROWSERS_PATH: playwrightBrowsersPath,
      };
      if (options.captchaPolicy !== undefined) {
        env['WRITESPEARE_CAPTCHA_POLICY'] = options.captchaPolicy;
      }
      if (options.env !== undefined) {
        for (const [key, value] of Object.entries(options.env)) {
          env[key] = value;
        }
      }

      // ---- Assemble the argument list ----
      // Python is invoked as `python <scriptPath> <args...>` —
      // the script path is the first argument to the interpreter,
      // and everything else is passed through to main.py's
      // argparse.
      const args = [scriptPath, ...options.args];

      console.log(
        `🚀 Spawning Python for task ${this.taskId}: ` +
          `${pythonPath} ${args.join(' ')}`
      );
      console.log(`📁 Working directory: ${cwd}`);

      // ---- Spawn ----
      // stdio: ['pipe', 'pipe', 'pipe'] — all three streams are
      // piped. stdin is required because writeStdin() delivers
      // Skip/Stop/Continue commands to the child via its stdin.
      // stdout and stderr are required because the manager emits
      // their lines as events and because the listener bridge
      // (a separate consumer) attaches to stdout to parse markers.
      //
      // windowsHide: true — suppress the console window that
      // Windows would otherwise create for a spawned console
      // process. Without it, every Python spawn briefly flashes a
      // black window on the user's taskbar.
      try {
        this.process = spawn(pythonPath, args, {
          cwd,
          env,
          stdio: ['pipe', 'pipe', 'pipe'],
          detached: false,
          windowsHide: true,
        });
      } catch (err) {
        reject(
          err instanceof Error ? err : new Error(String(err))
        );
        return;
      }

      this.isKilled = false;

      // ---- Attach stdout handler ----
      // Lines are split on /\r?\n/ so that a Windows CRLF does not
      // leave a trailing \r on every line. A naive split('\n')
      // would produce lines ending in '\r', and the marker regex
      // in listenerBridge.ts (`^::ROOKIE::...`) would fail to
      // match — the CAPTCHA_REQUIRED and every other marker would
      // silently fail to parse and the GUI would stay dark.
      //
      // The split leaves a trailing empty element when the chunk
      // ends in \n (which every well-formed print() does); the
      // `.filter((line) => line.trim())` drops that empty line so
      // no consumer ever sees a phantom "" event.
      this.process.stdout?.on('data', (data: Buffer) => {
        const output = data.toString('utf-8');
        const lines = output.split(/\r?\n/);
        for (const line of lines) {
          if (line.trim().length > 0) {
            this.emit('stdout', line);
          }
        }
      });

      // ---- Attach stderr handler ----
      // Same splitting logic and same reasoning as the stdout
      // handler above. Kept separate because the two streams are
      // semantically distinct — stdout carries markers, stderr
      // carries uncaught tracebacks — and a caller may want to
      // route them to different destinations.
      this.process.stderr?.on('data', (data: Buffer) => {
        const output = data.toString('utf-8');
        const lines = output.split(/\r?\n/);
        for (const line of lines) {
          if (line.trim().length > 0) {
            this.emit('stderr', line);
          }
        }
      });

      // ---- Attach exit handler ----
      // Fires when the child terminates for any reason — a clean
      // exit, a crash, or a signal. The timeout is cleared (there
      // is nothing left to time out). The `exit` event is emitted
      // only if the termination was NOT initiated by `kill()` —
      // the `killed` event covers that case, and emitting both
      // would confuse callers that rely on exactly one of them
      // firing per termination.
      this.process.on('exit', (code, signal) => {
        if (this.timeoutId) {
          clearTimeout(this.timeoutId);
          this.timeoutId = null;
        }
        if (!this.isKilled) {
          this.emit('exit', code, signal);
        }
        this.process = null;
      });

      // ---- Attach error handler ----
      // Emitted by the ChildProcess for two categories of failure:
      // (a) the process could not be spawned (ENOENT, EACCES),
      // (b) the process could not be killed (a rare, system-level
      // condition). The manager does not try to distinguish these
      // — both are surfaced via the `error` event so the caller's
      // error path handles them uniformly.
      this.process.on('error', (error) => {
        this.emit('error', error);
        this.process = null;
      });

      // ---- Timeout ----
      // Only set when the caller explicitly asks for one. See the
      // ProcessOptions.timeout docstring for why the default is
      // no timeout.
      if (
        options.timeout !== undefined &&
        options.timeout > 0
      ) {
        this.timeoutId = setTimeout(() => {
          if (this.process && !this.isKilled) {
            this.emit('timeout');
            this.kill();
          }
        }, options.timeout);
      }

      resolve();
    });
  }

  // ---------------------------------------------------------------------------
  //  writeStdin
  // ---------------------------------------------------------------------------

  /**
   * Write a command line to the child's stdin.
   *
   * The Skip / Stop / Continue IPC handlers call this to deliver
   * commands to `main.py`, which relays them to the currently
   * active feature script via `core/control_mode.py`. The
   * command strings the child understands are the ones that
   * module classifies: `'SKIP'`, `'STOP'`, `'CONTINUE'`, or the
   * empty string (which is equivalent to `'CONTINUE'`).
   *
   * Behaviour:
   *
   *   - A no-op when no process is running, stdin is closed, or
   *     the process has already been killed. A race between a
   *     user's click on Stop and the process exiting on its own
   *     must not throw — the user's intent ("stop the child") is
   *     already satisfied either way.
   *
   *   - A trailing newline is appended if the caller did not
   *     supply one. This lets a caller write `'SKIP'` or `'SKIP\n'`
   *     interchangeably.
   *
   *   - A write error (a broken pipe, EPIPE) is logged and
   *     swallowed. A closed stdin is a normal condition during
   *     process teardown and is not a reason to throw.
   *
   * @param line - The command line. See the docstring above for
   *               the accepted values.
   */
  public writeStdin(line: string): void {
    if (!this.process || !this.process.stdin || this.isKilled) {
      return;
    }
    try {
      const normalized = line.endsWith('\n') ? line : line + '\n';
      this.process.stdin.write(normalized);
    } catch (error) {
      console.error(
        `[childProcessManager] Failed to write to child stdin ` +
          `for task ${this.taskId}:`,
        error
      );
    }
  }

  // ---------------------------------------------------------------------------
  //  kill
  // ---------------------------------------------------------------------------

  /**
   * Terminate the current child process and its entire process
   * tree.
   *
   * Uses `tree-kill` (via its callback API, called synchronously)
   * to walk the process tree and terminate every descendant.
   * `child.kill()` alone would leave Chrome processes and any
   * Python subprocesses orphaned on Windows — see the sibling
   * `chromeLauncher.ts`'s file header for the full rationale,
   * which applies identically here.
   *
   * Fire-and-forget: the underlying `tree-kill` completes
   * asynchronously, and the manager does not wait for it. A
   * "Stop" button that had to wait for every process in the
   * tree to acknowledge SIGTERM would feel laggy; the caller's
   * `killed` event fires as soon as the tree-kill has been
   * dispatched, not when every child has exited.
   *
   * Idempotent: calling `kill()` twice on the same manager is
   * safe. The second call sees no live process and emits `killed`
   * again (the event is not suppressed on the second call — a
   * caller that subscribes twice will get two `killed` events,
   * which is unusual but not incorrect).
   */
  public kill(): void {
    if (this.process && !this.isKilled) {
      const pid = this.process.pid;
      if (pid !== undefined) {
        console.log(
          `🛑 Killing process tree for task ${this.taskId} ` +
            `(PID: ${pid})`
        );
        treeKill(pid, 'SIGTERM', (error?: Error) => {
          if (error) {
            console.error(
              `❌ Error killing process tree for task ` +
                `${this.taskId}:`,
              error
            );
            // Fall back to a direct kill of the root process.
            // The children will be orphaned but will notice
            // their parent is gone shortly — a less clean
            // teardown than tree-kill, but better than leaving
            // the whole tree running.
            try {
              this.process?.kill('SIGKILL');
            } catch (e) {
              console.error('❌ Direct kill also failed:', e);
            }
          } else {
            console.log(
              `✅ Process tree killed for task ${this.taskId} ` +
                `(PID: ${pid})`
            );
          }
          this.isKilled = true;
          this.emit('killed');
          this.process = null;
        });
      } else {
        // No PID — the spawn failed before the child got an ID.
        // There is nothing to tree-kill; just mark the manager
        // as having no live process.
        try {
          this.process.kill('SIGKILL');
        } catch {
          // Swallowed — see the file header for why kill
          // failures are logged and tolerated.
        }
        this.isKilled = true;
        this.emit('killed');
        this.process = null;
      }
    } else {
      // Already killed or never started. Emit `killed` so a
      // caller awaiting the event is not left hanging.
      this.emit('killed');
    }

    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
  }

  // ---------------------------------------------------------------------------
  //  Introspection
  // ---------------------------------------------------------------------------

  /**
   * Whether a child process is currently running under this
   * manager. `true` from the moment `start()` resolves until the
   * child exits or `kill()` completes; `false` otherwise.
   */
  public isRunning(): boolean {
    return this.process !== null && !this.isKilled;
  }

  /**
   * The child's process ID, or `null` when no child is running.
   * Useful for a diagnostic log line or a test assertion.
   */
  public getPid(): number | null {
    return this.process?.pid ?? null;
  }

  // ---------------------------------------------------------------------------
  //  dispose
  // ---------------------------------------------------------------------------

  /**
   * Kill the current child (if any) and remove every event
   * listener the caller attached.
   *
   * Called by `disposeProcessManager` and `disposeAll` when a
   * caller is done with a manager. A caller that keeps a manager
   * after `dispose()` will observe no further events — every
   * subscription has been removed.
   */
  public dispose(): void {
    this.kill();
    this.removeAllListeners();
  }
}

// =============================================================================
//  Registry
// =============================================================================
//
//  Every live manager is registered in this module-level map,
//  keyed by task ID. The map is the app's source of truth for
//  "which Python processes are currently running" — the shutdown
//  path iterates it to kill every subprocess before the app
//  exits, and a diagnostics panel can inspect it to show the
//  user what is running.
//
//  The registry is module-scoped and never persisted. Process
//  handles and PIDs are meaningless across app restarts; a fresh
//  launch starts with an empty registry.

/**
 * All live managers, keyed by task ID.
 */
const processManagers = new Map<string, ChildProcessManager>();

/**
 * Get or create the manager for a task ID.
 *
 * Idempotent for the same task ID: the second call returns the
 * existing instance rather than constructing a new one. This is
 * what prevents two callers from each spawning a Python process
 * for the same logical task — a race the registry exists to close.
 *
 * The returned manager is NOT started. The caller is expected to
 * attach event listeners and then call `.start(options)` itself.
 *
 * A caller that wants a fresh manager for a task ID that is
 * already registered calls `disposeProcessManager(taskId)` first;
 * the next `createProcessManager(taskId)` then constructs a new
 * instance.
 */
export const createProcessManager = (
  taskId: string
): ChildProcessManager => {
  const existing = processManagers.get(taskId);
  if (existing !== undefined) {
    return existing;
  }
  const manager = new ChildProcessManager(taskId);
  processManagers.set(taskId, manager);
  return manager;
};

/**
 * Look up the manager for a task ID, or `null` if none exists.
 *
 * Unlike `createProcessManager`, this does NOT construct a new
 * manager when the task ID is unknown. Use this when you want to
 * inspect or control an existing manager without side effects.
 */
export const getByTaskId = (
  taskId: string
): ChildProcessManager | null => {
  return processManagers.get(taskId) ?? null;
};

/**
 * Every manager whose child is currently running.
 *
 * A manager that has finished its operation but not yet been
 * disposed is NOT included — see `ChildProcessManager.isRunning()`.
 */
export const getAllRunning = (): ChildProcessManager[] => {
  return Array.from(processManagers.values()).filter((m) =>
    m.isRunning()
  );
};

/**
 * Kill every running manager's process tree, but leave the
 * managers themselves registered.
 *
 * Fire-and-forget — each `kill()` dispatches its tree-kill and
 * returns immediately. A "Stop All" click does not wait for four
 * separate tree-kills to complete before the IPC handler returns
 * to the renderer.
 *
 * Use this when the app needs to stop all active work but may
 * want to inspect manager state afterward (a Stop All button that
 * keeps the run cards visible, for example). For a full shutdown,
 * use `disposeAll()` — it kills AND removes.
 */
export const killAll = (): void => {
  for (const manager of processManagers.values()) {
    manager.kill();
  }
};

/**
 * Dispose one task's manager — kill its child (if any) and remove
 * it from the registry.
 *
 * After this returns, `createProcessManager(taskId)` will produce
 * a fresh instance rather than returning the disposed one.
 */
export const disposeProcessManager = (taskId: string): void => {
  const manager = processManagers.get(taskId);
  if (manager === undefined) {
    return;
  }
  manager.dispose();
  processManagers.delete(taskId);
};

/**
 * Dispose every manager and clear the registry.
 *
 * Called on app shutdown (see `before-quit` in `src/main/index.ts`)
 * so that a subsequent startup in the same process — a future
 * "restart app" flow, or a test runner — begins with an empty
 * registry.
 */
export const disposeAll = (): void => {
  for (const manager of processManagers.values()) {
    manager.dispose();
  }
  processManagers.clear();
};

// =============================================================================
//  Default export
// =============================================================================

/**
 * Every export bundled under one default object, matching the
 * pattern the sibling `portAllocator.ts` and `chromeLauncher.ts`
 * modules use. A caller that prefers named imports uses
 * `import { createProcessManager, disposeAll } from ...`; a
 * caller that prefers the default form uses
 * `import childProcessManager from ...` and destructures the
 * members it needs.
 */
export default {
  ChildProcessManager,
  createProcessManager,
  getByTaskId,
  getAllRunning,
  killAll,
  disposeProcessManager,
  disposeAll,
};