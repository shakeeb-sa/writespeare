/**
 * searchService — orchestrates one search operation.
 *
 * A search is a multi-part dance between four modules:
 *
 *   portAllocator        → gives Chrome a debug port
 *   chromeLauncher       → ensures a Chrome instance is running on that port
 *   childProcessManager  → spawns `python main.py search ...`
 *   listenerBridge       → (NOT USED — see the note below)
 *
 * This module composes them, exposes a single `runSearch()` entry
 * point, and returns a candidate list (or a structured failure) to
 * the caller.
 *
 * ── The flow ────────────────────────────────────────────────────
 *
 *   1. Ensure Chrome is running. Reuse the app's existing
 *      persistent-profile Chrome if one is registered with the
 *      launcher; otherwise launch a fresh one with the app's
 *      chrome-profile path. Chrome is NOT killed at the end of
 *      the operation — it lives for the app's lifetime so that
 *      the user's DeepSeek login (and every other cookie in the
 *      profile) survives across operations. Shutdown is the
 *      app's `before-quit` handler's job.
 *
 *   2. Spawn `python main.py search` with the operation's
 *      arguments and the Chrome port. The task ID is derived
 *      from the topic ID (`${topicId}-search`) so that a cancel
 *      call from the renderer can find the manager.
 *
 *   3. Subscribe to the manager's `stdout` event. Each line is
 *      parsed as a `::ROOKIE::<TYPE>::<json>` marker; a parsed
 *      marker is broadcast to every renderer window over the
 *      `research:marker` IPC channel — the same channel the
 *      listener bridge uses. SEARCH_PROGRESS markers drive the
 *      progress UI; SEARCH_RESULT carries the candidate list;
 *      CAPTCHA_REQUIRED opens the modal; TASK_START / TASK_END
 *      bracket the operation.
 *
 *   4. Wait for the child to exit. The exit code classifies the
 *      outcome:
 *
 *        0   → success. Return whatever candidates the
 *              SEARCH_RESULT marker carried (or an empty list if
 *              the query genuinely matched nothing).
 *        99  → the user clicked Skip. Return kind='user-skip'.
 *        100 → the user clicked Stop. Return kind='user-stop'.
 *        101 → the captcha policy was 'skip' and a captcha
 *              appeared. Return kind='user-skip'.
 *        any other non-zero → a generic failure. Return
 *              kind='error' with the process's exit code in the
 *              message.
 *
 *   5. If the primary engine failed for a recoverable reason
 *      (no candidates, a generic error — NOT a user skip/stop),
 *      and the caller did not opt out of fallback, retry the
 *      whole flow with `--engine duckduckgo` on the same Chrome.
 *
 * ── The marker-routing design tradeoff ──────────────────────────
 *
 *   `listenerBridge.ts` was written to attach to a raw
 *   `ChildProcess` object. `childProcessManager.ts` does not
 *   expose its internal `ChildProcess` — its `process` field is
 *   private, and its `start()` method returns only a resolved
 *   `Promise<void>`. So this module cannot pass the child to
 *   `attachToProcess()`.
 *
 *   The alternative was to modify one of the two files, which the
 *   current session forbids. Instead, this module attaches its
 *   own listener to the manager's `stdout` events, parses markers
 *   with a small local parser (same algorithm as the bridge's),
 *   and broadcasts them itself using the same
 *   `MARKER_EVENT_CHANNEL` constant and the same
 *   `webContents.send` shape.
 *
 *   The renderer cannot tell the difference — it receives the
 *   same `{ type, payload }` events on the same channel it would
 *   have received from the bridge. The duplication is roughly
 *   twenty lines of parsing logic. If a future session decides
 *   the manager should expose a public getter for its raw
 *   process (or if `listenerBridge` is redesigned to accept a
 *   manager instead of a child), this module can switch to the
 *   bridge in one edit.
 *
 * ── What this module does NOT do ────────────────────────────────
 *
 *   - It does not kill Chrome. Chrome is the app's shared,
 *     persistent-profile instance; killing it at the end of every
 *     search would force a re-login to DeepSeek on the next
 *     operation. Shutdown is `main/index.ts`'s `before-quit`
 *     handler's job.
 *
 *   - It does not retry within a single engine. The "retries"
 *     the plan's annotation refers to are the fallback to a
 *     different engine — see step 5. A network error that would
 *     resolve on retry with the same engine is not currently
 *     handled; adding it would require a backoff loop and a
 *     distinguished error signal from the Python script.
 *
 *   - It does not open the candidate pages. Fetching each
 *     candidate's content is `extractionService.ts`'s job
 *     (Session 12).
 *
 *   - It does not filter or rank candidates. The list is returned
 *     in the order Google or DuckDuckGo ranked it; the renderer's
 *     SourceList renders the list and the user decides.
 *
 *   - It does not persist anything. The result goes back to the
 *     caller and lives in the renderer's store; the backend's
 *     `/api/topics` and `/api/documents` endpoints are what
 *     eventually persist the user's choices.
 *
 * Dependencies: Node stdlib + electron + the three sibling
 * services (`portAllocator` is used indirectly via
 * `chromeLauncher`).
 */

import { app, BrowserWindow } from 'electron';
import path from 'node:path';

import {
  MARKER_EVENT_CHANNEL,
  type MarkerEvent,
} from './listenerBridge.js';
import {
  getRunningInstances,
  launchChrome,
} from './chromeLauncher.js';
import {
  createProcessManager,
  disposeProcessManager,
  type ProcessOptions,
} from './childProcessManager.js';

// =============================================================================
//  Public types
// =============================================================================

/**
 * The two search engines the pipeline can drive. The same union
 * the Python side's `main.py` accepts via its `--engine` flag.
 */
export type SearchEngine = 'google' | 'duckduckgo';

/**
 * One candidate source page, as returned by the Python search
 * script and forwarded to the renderer. Every field is a plain
 * string — the Python side guarantees they are present and
 * non-empty for every candidate it emits.
 */
export interface SearchCandidate {
  /** The absolute URL of the page. */
  url: string;

  /** The page's title, as displayed on the SERP. */
  title: string;

  /** The SERP snippet — a one- or two-line preview of the page's
   *  content. May be an empty string for results that do not carry
   *  one. */
  snippet: string;

  /** The platform slug for the URL's domain — `'reddit'`,
   *  `'quora'`, `'medium'`, `'twitter'`, or `'generic'`. */
  platform: string;
}

/**
 * The classification of a search's outcome.
 *
 *   'success'       — the search ran and found at least one
 *                     candidate. `success` is `true`.
 *   'no-candidates' — the search ran cleanly but found nothing.
 *                     `success` is `false`.
 *   'error'         — the search process failed for a reason other
 *                     than a user action. `success` is `false`.
 *   'user-skip'     — the user clicked Skip on a blocking prompt,
 *                     or the operation was cancelled. `success` is
 *                     `false`.
 *   'user-stop'     — the user clicked Stop. `success` is `false`.
 */
export type SearchResultKind =
  | 'success'
  | 'no-candidates'
  | 'error'
  | 'user-skip'
  | 'user-stop';

/**
 * The options `runSearch` accepts.
 */
export interface SearchServiceOptions {
  /** The search query — normally the topic's title. */
  query: string;

  /** The user's keywords. Carried in the marker payload for
   *  display, but does NOT affect the search itself. */
  keywords: string[];

  /** The maximum number of candidates to collect. The search may
   *  return fewer if the engine runs out of results. */
  maxResults: number;

  /** The topic's ID. Used to derive the task ID (so the cancel
   *  path can find the manager) and included in every emitted
   *  marker so the renderer routes the candidates to the right
   *  store entry. */
  topicId: string;

  /** Which engine to try first. Defaults to `'google'`. */
  engine?: SearchEngine;

  /** Whether to fall back to DuckDuckGo if Google fails.
   *  Defaults to `true`. Setting it to `false` makes a Google
   *  failure final — useful in tests that need determinism, and
   *  in a future UI that lets the user lock an engine. */
  fallbackToDuckDuckGo?: boolean;

  /** The captcha policy to forward to the Python script. See
   *  `ProcessOptions.captchaPolicy` for the semantics. Omit to
   *  get the Python side's default of `'ask'`. */
  captchaPolicy?: 'ask' | 'skip' | 'stop';
}

/**
 * The result of one `runSearch` call. Never thrown — the promise
 * always resolves, and failures are described by the `success` /
 * `kind` / `error` fields.
 */
export interface SearchServiceResult {
  /** True only when `kind === 'success'`. */
  success: boolean;

  /** The candidate list the search produced. Populated on success,
   *  and possibly populated on failure if the search had collected
   *  candidates before failing — the caller can decide whether to
   *  keep them. */
  candidates: SearchCandidate[];

  /** Which engine produced this result. Under a successful fallback
   *  this is `'duckduckgo'` even though the caller requested
   *  Google; the value reflects the engine that actually ran. */
  engine: SearchEngine;

  /** The classification of the outcome. See `SearchResultKind`. */
  kind: SearchResultKind;

  /** A human-readable error message. Present whenever `success`
   *  is `false`. */
  error?: string;
}

// =============================================================================
//  Constants
// =============================================================================

/** The engine tried first when the caller does not specify one. */
const DEFAULT_ENGINE: SearchEngine = 'google';

/** The engine tried if the primary engine fails. */
const FALLBACK_ENGINE: SearchEngine = 'duckduckgo';

/** The marker prefix that every Python script writes on stdout.
 *  Must match `core/output.py` and `listenerBridge.ts`. */
const MARKER_PREFIX = '::ROOKIE::';

/** The exit code the Python side uses for "user clicked Skip"
 *  (mirrors `core/output.py`'s `EXIT_SKIPPED`). */
const EXIT_SKIPPED = 99;

/** The exit code for "user clicked Stop" (`EXIT_STOPPED`). */
const EXIT_STOPPED = 100;

/** The exit code for "auto-skipped because captcha policy was
 *  'skip'" (`EXIT_CAPTCHA_SKIP`). */
const EXIT_CAPTCHA_SKIP = 101;

// =============================================================================
//  Helpers
// =============================================================================

/**
 * The absolute path to the persistent Chrome profile the app
 * uses. Deterministic across operations so that every Chrome
 * launched by the app shares one profile — and one DeepSeek login.
 *
 * The path is `<userData>/chrome-profile`. On Windows that
 * resolves to `%APPDATA%/writespeare-desktop/chrome-profile`; on
 * macOS to `~/Library/Application Support/writespeare-desktop/chrome-profile`;
 * on Linux to `~/.config/writespeare-desktop/chrome-profile`. The
 * `userData` name is set by Electron from the app's package.json
 * `name` field.
 */
const getChromeProfilePath = (): string => {
  return path.join(app.getPath('userData'), 'chrome-profile');
};

/**
 * Return the current app-wide Chrome instance's debug port,
 * launching a fresh Chrome if none is running.
 *
 * See the file header for why Chrome is reused across operations
 * rather than launched per operation — the persistent profile
 * holds the user's DeepSeek login and killing Chrome would force
 * a re-login.
 *
 * The function is `async` because launching Chrome (the slow path)
 * is async. The fast path — an existing instance — returns
 * synchronously wrapped in a resolved promise.
 */
const ensureChromeRunning = async (): Promise<number> => {
  const running = getRunningInstances();
  const first = running[0];
  if (first !== undefined) {
    return first.port;
  }
  const instance = await launchChrome({
    userDataDir: getChromeProfilePath(),
  });
  return instance.port;
};

/**
 * Parse a single `::ROOKIE::<TYPE>::<json>` line into a
 * `MarkerEvent`, or return `null` for a non-marker line.
 *
 * Same algorithm as `listenerBridge.ts`'s private parser. The
 * duplication is documented in the file header — it exists
 * because the bridge's parser is not exported.
 */
const parseMarkerLine = (line: string): MarkerEvent | null => {
  if (!line.startsWith(MARKER_PREFIX)) {
    return null;
  }
  const afterPrefix = line.slice(MARKER_PREFIX.length);
  const typeEnd = afterPrefix.indexOf('::');
  if (typeEnd === -1) {
    return null;
  }
  const type = afterPrefix.slice(0, typeEnd);
  if (type.length === 0) {
    return null;
  }
  const jsonText = afterPrefix.slice(typeEnd + 2);
  let payload: unknown;
  try {
    payload = jsonText.length > 0 ? JSON.parse(jsonText) : {};
  } catch {
    return null;
  }
  return { type, payload };
};

/**
 * Broadcast a parsed marker to every renderer window.
 *
 * Same shape and same channel as `listenerBridge.broadcast` — the
 * renderer cannot tell which module emitted a given marker.
 */
const broadcastMarker = (event: MarkerEvent): void => {
  const windows = BrowserWindow.getAllWindows();
  for (const win of windows) {
    if (win.isDestroyed()) continue;
    win.webContents.send(MARKER_EVENT_CHANNEL, event);
  }
};

/**
 * Extract the candidate list from a `SEARCH_RESULT` marker's
 * payload, narrowing the opaque `unknown` to `SearchCandidate[]`
 * with runtime checks.
 *
 * A malformed candidate entry — a non-object, a missing `url`, a
 * missing `title` — is skipped rather than included with default
 * values. The Python side is expected to emit well-formed
 * payloads; the guard exists so a bug in the Python side produces
 * a smaller list, not a crash in the main process.
 */
const extractCandidates = (payload: unknown): SearchCandidate[] => {
  if (typeof payload !== 'object' || payload === null) {
    return [];
  }
  const candidatesField = (payload as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidatesField)) {
    return [];
  }

  const result: SearchCandidate[] = [];
  for (const raw of candidatesField) {
    if (typeof raw !== 'object' || raw === null) continue;
    const c = raw as Record<string, unknown>;
    const url = c['url'];
    const title = c['title'];
    if (typeof url !== 'string' || url.length === 0) continue;
    if (typeof title !== 'string' || title.length === 0) continue;
    const snippet = typeof c['snippet'] === 'string' ? c['snippet'] : '';
    const platform =
      typeof c['platform'] === 'string' ? c['platform'] : 'generic';
    result.push({ url, title, snippet, platform });
  }
  return result;
};

/**
 * The deterministic task ID for a search operation on a given
 * topic. Exported so that the IPC handler's cancel path can
 * compute the same ID without duplicating the naming convention.
 *
 * The task ID is what `createProcessManager` and
 * `disposeProcessManager` (and the manager registry) key on, so
 * the cancel handler and the service must agree on it exactly.
 */
export const getSearchTaskId = (topicId: string): string => {
  return `${topicId}-search`;
};

// =============================================================================
//  Internal — single-engine attempt
// =============================================================================

/**
 * Run one search on one engine and resolve when the child either
 * emits a terminal marker or exits.
 *
 * Never rejects — the returned promise always resolves, and the
 * caller distinguishes success from failure via the result's
 * `kind` field. The pattern matches how the renderer's stores
 * consume results: a plain object with a `success` boolean is
 * easier to reason about than a promise that might throw.
 */
const attemptSearch = async (
  options: SearchServiceOptions,
  engine: SearchEngine,
  port: number
): Promise<SearchServiceResult> => {
  const taskId = getSearchTaskId(options.topicId);

  // Dispose any manager that survived a previous operation on
  // this topic. A stale manager could happen if the previous
  // search crashed without going through `settle`, or if the
  // caller cancelled but did not dispose. Disposing is a no-op
  // when no manager exists for this task ID.
  disposeProcessManager(taskId);

  const manager = createProcessManager(taskId);

  return new Promise<SearchServiceResult>((resolve) => {
    let settled = false;
    let lastCandidates: SearchCandidate[] = [];

    /**
     * Finalize the operation: mark as settled, dispose the
     * manager (which kills the child if it is still running),
     * resolve the promise. Idempotent — a second call is a no-op.
     *
     * The manager is disposed BEFORE the resolve because
     * disposing is what stops any pending child from continuing
     * to emit events into a promise that has already resolved.
     */
    const settle = (result: SearchServiceResult): void => {
      if (settled) return;
      settled = true;
      disposeProcessManager(taskId);
      resolve(result);
    };

    // ---- stdout handler ----
    // Each line that parses as a marker is broadcast to every
    // renderer window. SEARCH_RESULT markers also update the
    // local `lastCandidates` so the exit handler can return them.
    manager.on('stdout', (line: string) => {
      const marker = parseMarkerLine(line);
      if (marker === null) return;
      broadcastMarker(marker);
      if (marker.type === 'SEARCH_RESULT') {
        lastCandidates = extractCandidates(marker.payload);
      }
    });

    // ---- exit handler ----
    // The exit code classifies the outcome. `code` is `number |
    // null` — a null arrives when the process was terminated by a
    // signal rather than exiting on its own.
    manager.on('exit', (code: number | null, _signal: string | null) => {
      if (code === 0) {
        const kind: SearchResultKind =
          lastCandidates.length > 0 ? 'success' : 'no-candidates';
        settle({
          success: kind === 'success',
          candidates: lastCandidates,
          engine,
          kind,
          ...(kind === 'success'
            ? {}
            : { error: 'Search completed with no candidates.' }),
        });
        return;
      }
      if (code === EXIT_SKIPPED || code === EXIT_CAPTCHA_SKIP) {
        settle({
          success: false,
          candidates: lastCandidates,
          engine,
          kind: 'user-skip',
          error: 'Search skipped by user.',
        });
        return;
      }
      if (code === EXIT_STOPPED) {
        settle({
          success: false,
          candidates: lastCandidates,
          engine,
          kind: 'user-stop',
          error: 'Search stopped by user.',
        });
        return;
      }
      settle({
        success: false,
        candidates: lastCandidates,
        engine,
        kind: 'error',
        error: `Search process exited with code ${code ?? 'unknown'}.`,
      });
    });

    // ---- error handler ----
    // The manager's `error` event fires when the child fails to
    // spawn (ENOENT, EACCES) or encounters a runtime error.
    manager.on('error', (err: Error) => {
      settle({
        success: false,
        candidates: lastCandidates,
        engine,
        kind: 'error',
        error: err.message,
      });
    });

    // ---- timeout handler ----
    // Fires when the caller set a timeout and the child exceeded
    // it. `runSearch` does not set one by default, so this path
    // only fires if a future caller overrides the default.
    manager.on('timeout', () => {
      settle({
        success: false,
        candidates: lastCandidates,
        engine,
        kind: 'error',
        error: 'Search timed out.',
      });
    });

    // ---- killed handler ----
    // Fires when the manager's `kill()` terminates the child
    // directly (a hard cancel that bypasses the graceful
    // stdin-based Skip/Stop flow). Treating it as a user skip is
    // the correct semantic — the user asked for the operation to
    // end, and the operation ended.
    manager.on('killed', () => {
      settle({
        success: false,
        candidates: lastCandidates,
        engine,
        kind: 'user-skip',
        error: 'Search was cancelled.',
      });
    });

    // ---- Build the arguments ----
    // The Python subcommand takes the operation name, the
    // operation's inputs, and the debug port. `--control-mode`
    // is always passed — the whole point of this operation is
    // the marker stream that goes back to the renderer.
    const args: string[] = [
      'search',
      '--query', options.query,
      '--keywords', options.keywords.join(','),
      '--max-results', String(options.maxResults),
      '--topic-id', options.topicId,
      '--port', String(port),
      '--engine', engine,
      '--control-mode',
    ];

    const startOptions: ProcessOptions = { args };
    if (options.captchaPolicy !== undefined) {
      startOptions.captchaPolicy = options.captchaPolicy;
    }

    // ---- Spawn ----
    // `start()` resolves once the child is spawned. Its promise
    // can reject if the spawn call itself throws; the catch
    // converts a rejection into the same `settle` the error
    // handler uses, so the caller always sees a resolved result.
    void manager.start(startOptions).catch((err: unknown) => {
      settle({
        success: false,
        candidates: [],
        engine,
        kind: 'error',
        error: err instanceof Error ? err.message : String(err),
      });
    });
  });
};

// =============================================================================
//  Public entry point
// =============================================================================

/**
 * Run a search operation and return the candidate list, or a
 * structured failure.
 *
 * See the file header for the full flow. The function never
 * rejects — a failure is reported via the resolved result's
 * `success: false` and `kind` fields.
 *
 * The candidate list is returned in the order the search engine
 * ranked it. The caller is responsible for whatever filtering
 * or reordering it wants before showing the list to the user.
 */
export const runSearch = async (
  options: SearchServiceOptions
): Promise<SearchServiceResult> => {
  const primaryEngine: SearchEngine = options.engine ?? DEFAULT_ENGINE;

  // ---- Validate ----
  // Two guards, both of which would produce confusing downstream
  // errors if allowed through. An empty query cannot be searched;
  // an empty topic ID cannot be used as a task ID (the manager's
  // constructor rejects it with a less-clear message).
  if (options.query.trim().length === 0) {
    return {
      success: false,
      candidates: [],
      engine: primaryEngine,
      kind: 'error',
      error: 'Search query is empty.',
    };
  }
  if (options.topicId.trim().length === 0) {
    return {
      success: false,
      candidates: [],
      engine: primaryEngine,
      kind: 'error',
      error: 'Topic ID is required.',
    };
  }

  // ---- Ensure Chrome is running ----
  // The port is returned to the Python script as a CLI argument.
  // If Chrome cannot be launched, the whole operation fails
  // before any Python process is spawned — an early, clear
  // failure instead of a confusing "could not connect to port
  // NNNN" from the Python side.
  let port: number;
  try {
    port = await ensureChromeRunning();
  } catch (err) {
    return {
      success: false,
      candidates: [],
      engine: primaryEngine,
      kind: 'error',
      error: `Could not launch Chrome: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  // ---- Try the primary engine ----
  const primaryResult = await attemptSearch(
    options,
    primaryEngine,
    port
  );

  if (primaryResult.kind === 'success') {
    return primaryResult;
  }

  // ---- Decide whether to fall back ----
  // Fallback is skipped when any of the following holds:
  //   * the caller explicitly disabled it
  //   * the primary engine was not Google (nothing to fall back to)
  //   * the user already terminated the operation (skip / stop)
  //
  // The last case matters because a fallback would ignore the
  // user's intent: they clicked Skip, and the service must not
  // silently spawn a second engine.
  if (options.fallbackToDuckDuckGo === false) {
    return primaryResult;
  }
  if (primaryEngine !== 'google') {
    return primaryResult;
  }
  if (
    primaryResult.kind === 'user-skip' ||
    primaryResult.kind === 'user-stop'
  ) {
    return primaryResult;
  }

  // ---- Fall back to DuckDuckGo ----
  console.log(
    `[searchService] Primary search failed (${primaryResult.kind}: ` +
      `${primaryResult.error ?? 'no error message'}). ` +
      `Falling back to DuckDuckGo.`
  );

  const fallbackResult = await attemptSearch(
    options,
    FALLBACK_ENGINE,
    port
  );

  return fallbackResult;
};

// =============================================================================
//  Default export
// =============================================================================

/**
 * Every export bundled under one default object, matching the
 * convention of the sibling service modules (`portAllocator`,
 * `chromeLauncher`, `childProcessManager`). A caller that prefers
 * named imports uses `import { runSearch } from ...`; a caller
 * that prefers the default form uses
 * `import searchService from ...` and destructures.
 */
export default {
  runSearch,
  getSearchTaskId,
};