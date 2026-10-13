/**
 * extractionService — orchestrates one extraction operation.
 *
 * The extraction stage takes the URLs the user selected from a
 * search's candidate list, opens each one in the app's persistent
 * Chrome instance, turns its HTML into clean Markdown via the
 * Python extractors, and writes one `.md` doc file per successful
 * URL into the topic's `sources/` folder. This module is the
 * main-process coordinator for that operation.
 *
 * ── The flow ────────────────────────────────────────────────────
 *
 *   1. Ensure Chrome is running. Reuse the app's persistent-
 *      profile Chrome if one is registered with the launcher;
 *      otherwise launch a fresh one with the app's chrome-profile
 *      path. Chrome is NOT killed at the end of the operation —
 *      it lives for the app's lifetime so that the user's
 *      DeepSeek login (and every other cookie in the profile)
 *      survives across operations. Shutdown is the app's
 *      `before-quit` handler's job.
 *
 *   2. Spawn `python main.py extract` with the operation's
 *      arguments and the Chrome port. The task ID is derived
 *      from the topic ID (`${topicId}-extract`) so that a
 *      cancel call can find the manager.
 *
 *   3. Subscribe to the manager's `stdout` event. Each line is
 *      parsed as a `::ROOKIE::<TYPE>::<json>` marker; a parsed
 *      marker is broadcast to every renderer window over the
 *      `research:marker` IPC channel — the same channel the
 *      listener bridge uses. EXTRACT_PROGRESS markers drive the
 *      live progress panel; EXTRACT_DONE carries the terminal
 *      savedCount/failedCount; CAPTCHA_REQUIRED opens the modal;
 *      TASK_START / TASK_END bracket the operation.
 *
 *   4. Wait for the child to exit. The exit code classifies the
 *      outcome:
 *
 *        0   → success. At least one document was saved.
 *        1   → either "ran but saved nothing" (an EXTRACT_DONE
 *              marker was seen with savedCount === 0) or a hard
 *              failure (no EXTRACT_DONE marker). The two are
 *              distinguished by the `sawExtractDone` flag.
 *        99  → the user clicked Skip. Return kind='user-skip'.
 *        100 → the user clicked Stop. Return kind='user-stop'.
 *        101 → the captcha policy was 'skip' and a captcha
 *              appeared. Return kind='user-skip'.
 *        any other non-zero → a generic failure. Return
 *              kind='error' with the process's exit code in the
 *              message.
 *
 *   5. Return the extraction result. The function never rejects —
 *      a failure is reported via the resolved result's
 *      `success: false` and `kind` fields, matching the pattern
 *      established by `searchService.runSearch`.
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
 *   own listener to the manager's `stdout` events, parses
 *   markers with a small local parser (same algorithm as the
 *   bridge's), and broadcasts them itself using the same
 *   `MARKER_EVENT_CHANNEL` constant and the same
 *   `webContents.send` shape.
 *
 *   The renderer cannot tell the difference — it receives the
 *   same `{ type, payload }` events on the same channel it would
 *   have received from the bridge. The duplication is roughly
 *   twenty lines of parsing logic, and `searchService.ts` already
 *   contains the same twenty lines for the same reason. This
 *   file's copy is the second instance; a future third copy
 *   (a writer-stage or validation-stage service) would be the
 *   moment to rework the boundary, but for two services the
 *   duplication is cheaper than a shared abstraction whose only
 *   two callers are in the same folder.
 *
 * ── Why the extraction task ID differs from the search task ID ──
 *
 *   `searchService` uses `${topicId}-search` as its task ID. This
 *   module uses `${topicId}-extract`. The two are distinct so that
 *   a search and an extraction for the same topic can, in
 *   principle, run simultaneously without their manager registries
 *   colliding — the childProcessManager's registry is keyed by
 *   task ID and a collision would have the second `createProcessManager`
 *   call return the first's manager.
 *
 *   The consequence a reader should be aware of: the
 *   `research:cancel` IPC handler in `researchIPC.ts` currently
 *   looks up only the SEARCH task ID (`getSearchTaskId(topicId)`).
 *   Cancelling an in-flight extraction therefore does not, today,
 *   reach the extraction's manager. A future session that wants
 *   to close that gap would extend the cancel handler to look up
 *   both task IDs. The correct fix is not to reuse the search's
 *   task ID here, because doing so would defeat the registry's
 *   collision avoidance. See the PLAN DELTA logged with this
 *   file's creation for the full note.
 *
 * ── What this module does NOT do ────────────────────────────────
 *
 *   - It does not kill Chrome. Chrome is the app's shared,
 *     persistent-profile instance; killing it at the end of every
 *     extraction would force a re-login to DeepSeek on the next
 *     operation. Shutdown is `main/index.ts`'s `before-quit`
 *     handler's job.
 *
 *   - It does not persist doc metadata to the backend. The doc
 *     files land on the desktop's disk; the backend's
 *     `/api/documents` endpoint is written to by a separate step
 *     (a future session's documents feature, which reads the
 *     files this operation produced and POSTs their metadata).
 *     This module's job ends when the child process has exited
 *     and the markers have been broadcast.
 *
 *   - It does not retry failed URLs, and it does not read the
 *     failures file. During a batch, the Python extractor's
 *     `EXTRACT_PROGRESS` marker reports per-URL status. After
 *     the batch, `research/extract_dispatch.py` writes the
 *     topic's `failures.json` with a record per failed URL
 *     carrying the reason code, the accumulated attempt count,
 *     the last attempt's timestamp, and the error message.
 *
 *     This service does NOT read that file. The renderer's
 *     `researchStore.loadCandidates` action fetches the
 *     records via the separate `research:getFailures` IPC
 *     channel (`handleGetFailures` in `researchIPC.ts`) on the
 *     next open of the topic. The retry flow —
 *     `researchStore.retryFailed` invoking `research:extract`
 *     with the failed URLs — reaches this same `runExtract`
 *     entry point without knowing that the URLs came from a
 *     previous batch's failures.
 *
 *     The separation is deliberate. This service is stateless
 *     with respect to past runs: a corrupted or missing
 *     `failures.json` cannot affect a fresh extraction, and
 *     the retry UI's source of truth is the same file the
 *     Python side writes, not a copy cached in the main
 *     process.
 *
 *   - It does not filter or validate the URLs beyond the shallow
 *     shape checks in `runExtract` (non-empty array, non-empty
 *     strings). The renderer's source list is the UI's filter;
 *     the Python extractor's dispatch is the content filter.
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
 * The classification of an extraction operation's outcome.
 *
 *   'success'        — the extraction ran and saved at least one
 *                      document. `success` is `true`.
 *   'no-documents'   — the extraction ran cleanly but saved
 *                      nothing. Every URL failed, or the batch
 *                      was empty after Python filtered it. The
 *                      user has nothing new to show for the run.
 *   'error'          — the extraction process failed for a
 *                      reason other than a user action. The
 *                      Python script could not import its
 *                      dispatch module, a Chrome connection
 *                      failed before the batch started, or the
 *                      process crashed.
 *   'user-skip'      — the user clicked Skip on a blocking
 *                      prompt, or the operation was cancelled.
 *   'user-stop'      — the user clicked Stop.
 */
export type ExtractionResultKind =
  | 'success'
  | 'no-documents'
  | 'error'
  | 'user-skip'
  | 'user-stop';

/**
 * The options `runExtract` accepts.
 */
export interface ExtractionServiceOptions {
  /** The topic's ID. Used to derive the task ID (so the cancel
   *  path can find the manager), and included in every emitted
   *  marker so the renderer routes the progress to the right
   *  topic's panel. */
  topicId: string;

  /** The URLs to extract. The user selected these from the
   *  candidate list; the order is preserved — the Python
   *  extractor writes doc files in the same order the user saw
   *  them. */
  urls: string[];

  /** The captcha policy to forward to the Python script. See
   *  `ProcessOptions.captchaPolicy` for the semantics. Omit to
   *  get the Python side's default of `'ask'`. */
  captchaPolicy?: 'ask' | 'skip' | 'stop';
}

/**
 * The result of one `runExtract` call. Never thrown — the promise
 * always resolves, and failures are described by the `success` /
 * `kind` / `error` fields.
 */
export interface ExtractionServiceResult {
  /** True only when `kind === 'success'`. */
  success: boolean;

  /** How many documents the extraction saved. Populated on
   *  success and on partial-save failures; zero when the
   *  operation failed before the batch ran. */
  savedCount: number;

  /** How many URLs the extractor attempted but could not save.
   *  Populated whenever the EXTRACT_DONE marker was seen,
   *  including on `'no-documents'` and on some `'error'` paths
   *  where the batch started but the process exited non-zero. */
  failedCount: number;

  /** The classification of the outcome. See
   *  `ExtractionResultKind`. */
  kind: ExtractionResultKind;

  /** A human-readable error message. Present whenever `success`
   *  is `false`. */
  error?: string;
}

// =============================================================================
//  Constants
// =============================================================================

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
 * launched by the app shares one profile — and one DeepSeek
 * login.
 *
 * The path is `<userData>/chrome-profile`. On Windows that
 * resolves to `%APPDATA%/writespeare-desktop/chrome-profile`; on
 * macOS to `~/Library/Application Support/writespeare-desktop/chrome-profile`;
 * on Linux to `~/.config/writespeare-desktop/chrome-profile`. The
 * `userData` name is set by Electron from the app's package.json
 * `name` field.
 *
 * The path is the same string `searchService.ts` computes. The
 * duplication is intentional: the two services are peers, and a
 * shared constant module would be a new file outside the plan's
 * tree. If a third service ever needs the same path, the correct
 * change is to promote it into a small shared helper.
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
 *
 * The implementation mirrors `searchService.ts`'s helper of the
 * same name. See that file's docstring for the design rationale
 * on the fast path's `running[0]` access pattern.
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
 * because the bridge's parser is not exported, and the two
 * consumers are in the same folder with only one other sibling
 * sharing the same twenty lines.
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
 * Extract the `savedCount` and `failedCount` fields from an
 * `EXTRACT_DONE` marker's payload.
 *
 * A malformed payload — a non-object, a missing `savedCount`, a
 * negative value — yields zeros for both fields. The Python side
 * is expected to emit a well-formed payload; the guard exists so
 * a bug in the Python side produces a smaller count, not a crash
 * in the main process.
 *
 * The two counts are returned together because they come from the
 * same marker and are consumed together — a `savedCount` without
 * its `failedCount` would give the caller no way to know whether
 * the extraction partially succeeded or just ran on a short URL
 * list.
 */
const extractDoneCounts = (
  payload: unknown
): { savedCount: number; failedCount: number } => {
  if (typeof payload !== 'object' || payload === null) {
    return { savedCount: 0, failedCount: 0 };
  }
  const p = payload as Record<string, unknown>;
  const saved = p['savedCount'];
  const failed = p['failedCount'];
  return {
    savedCount:
      typeof saved === 'number' && saved >= 0 ? saved : 0,
    failedCount:
      typeof failed === 'number' && failed >= 0 ? failed : 0,
  };
};

/**
 * The deterministic task ID for an extraction operation on a
 * given topic. Exported so a future session's cancel handler (or
 * a diagnostic tool) can compute the same ID without duplicating
 * the naming convention.
 *
 * The task ID is what `createProcessManager` and
 * `disposeProcessManager` (and the manager registry) key on, so
 * any caller that needs to look up the extraction's manager must
 * agree on this value exactly.
 *
 * See the file header for the reasoning behind using a distinct
 * suffix from `searchService`'s `${topicId}-search`.
 */
export const getExtractionTaskId = (topicId: string): string => {
  return `${topicId}-extract`;
};

// =============================================================================
//  Public entry point
// =============================================================================

/**
 * Run an extraction operation and return the saved/failed counts,
 * or a structured failure.
 *
 * See the file header for the full flow. The function never
 * rejects — a failure is reported via the resolved result's
 * `success: false` and `kind` fields.
 *
 * The per-URL progress is delivered to the renderer through the
 * marker channel, not through the returned promise. The promise
 * resolves once the child has exited with the terminal counts.
 */
export const runExtract = async (
  options: ExtractionServiceOptions
): Promise<ExtractionServiceResult> => {
  // ---- Validate ----
  // Two guards, both of which would produce confusing downstream
  // errors if allowed through. An empty URL list cannot be
  // extracted; an empty topic ID cannot be used as a task ID (the
  // manager's constructor rejects it with a less-clear message).
  if (options.urls.length === 0) {
    return {
      success: false,
      savedCount: 0,
      failedCount: 0,
      kind: 'error',
      error: 'No URLs provided for extraction.',
    };
  }
  if (options.topicId.trim().length === 0) {
    return {
      success: false,
      savedCount: 0,
      failedCount: 0,
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
      savedCount: 0,
      failedCount: 0,
      kind: 'error',
      error: `Could not launch Chrome: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  // ---- Set up the process manager ----
  const taskId = getExtractionTaskId(options.topicId);

  // Dispose any manager that survived a previous operation on
  // this topic. A stale manager could happen if the previous
  // extraction crashed without going through `settle`, or if the
  // caller cancelled but did not dispose. Disposing is a no-op
  // when no manager exists for this task ID.
  disposeProcessManager(taskId);

  const manager = createProcessManager(taskId);

  return new Promise<ExtractionServiceResult>((resolve) => {
    let settled = false;
    // The terminal counts are populated when the EXTRACT_DONE
    // marker arrives. `sawExtractDone` is what distinguishes
    // "the batch ran but saved nothing" from "the batch never
    // started" when the exit code is 1.
    let lastSavedCount = 0;
    let lastFailedCount = 0;
    let sawExtractDone = false;

    /**
     * Finalize the operation: mark as settled, dispose the
     * manager (which kills the child if it is still running),
     * resolve the promise. Idempotent — a second call is a no-op.
     *
     * The manager is disposed BEFORE the resolve because
     * disposing is what stops any pending child from continuing
     * to emit events into a promise that has already resolved.
     */
    const settle = (result: ExtractionServiceResult): void => {
      if (settled) return;
      settled = true;
      disposeProcessManager(taskId);
      resolve(result);
    };

    // ---- stdout handler ----
    // Each line that parses as a marker is broadcast to every
    // renderer window. EXTRACT_DONE markers also update the
    // local counts so the exit handler can return them, and
    // set the `sawExtractDone` flag.
    manager.on('stdout', (line: string) => {
      const marker = parseMarkerLine(line);
      if (marker === null) return;
      broadcastMarker(marker);
      if (marker.type === 'EXTRACT_DONE') {
        const counts = extractDoneCounts(marker.payload);
        lastSavedCount = counts.savedCount;
        lastFailedCount = counts.failedCount;
        sawExtractDone = true;
      }
    });

    // ---- exit handler ----
    // The exit code classifies the outcome. `code` is `number |
    // null` — a null arrives when the process was terminated by a
    // signal rather than exiting on its own.
    manager.on(
      'exit',
      (code: number | null, _signal: string | null) => {
        if (code === 0) {
          settle({
            success: true,
            savedCount: lastSavedCount,
            failedCount: lastFailedCount,
            kind: 'success',
          });
          return;
        }
        if (code === EXIT_SKIPPED || code === EXIT_CAPTCHA_SKIP) {
          settle({
            success: false,
            savedCount: lastSavedCount,
            failedCount: lastFailedCount,
            kind: 'user-skip',
            error: 'Extraction skipped by user.',
          });
          return;
        }
        if (code === EXIT_STOPPED) {
          settle({
            success: false,
            savedCount: lastSavedCount,
            failedCount: lastFailedCount,
            kind: 'user-stop',
            error: 'Extraction stopped by user.',
          });
          return;
        }
        // Non-zero, non-user codes. Distinguish "the batch ran
        // but saved nothing" from "the batch never started" by
        // whether the terminal marker was seen.
        if (sawExtractDone && lastSavedCount === 0) {
          settle({
            success: false,
            savedCount: 0,
            failedCount: lastFailedCount,
            kind: 'no-documents',
            error: 'Extraction completed but saved no documents.',
          });
          return;
        }
        settle({
          success: false,
          savedCount: lastSavedCount,
          failedCount: lastFailedCount,
          kind: 'error',
          error: `Extraction process exited with code ${
            code ?? 'unknown'
          }.`,
        });
      }
    );

    // ---- error handler ----
    // The manager's `error` event fires when the child fails to
    // spawn (ENOENT, EACCES) or encounters a runtime error.
    manager.on('error', (err: Error) => {
      settle({
        success: false,
        savedCount: lastSavedCount,
        failedCount: lastFailedCount,
        kind: 'error',
        error: err.message,
      });
    });

    // ---- timeout handler ----
    // Fires when the caller set a timeout and the child exceeded
    // it. `runExtract` does not set one by default, so this path
    // only fires if a future caller overrides the default.
    manager.on('timeout', () => {
      settle({
        success: false,
        savedCount: lastSavedCount,
        failedCount: lastFailedCount,
        kind: 'error',
        error: 'Extraction timed out.',
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
        savedCount: lastSavedCount,
        failedCount: lastFailedCount,
        kind: 'user-skip',
        error: 'Extraction was cancelled.',
      });
    });

    // ---- Build the arguments ----
    // The Python subcommand takes the operation name, the
    // operation's inputs, and the debug port. `--control-mode`
    // is always passed — the whole point of this operation is
    // the marker stream that goes back to the renderer.
    //
    // The URL list is joined with commas because `main.py`'s
    // `--urls` flag accepts a comma-separated string and splits
    // it on its own side. A URL that contains a comma would
    // break the split — a rare but real possibility for a URL
    // with a comma in its query string. The Python side's
    // handler (`_run_extract` in `main.py`) uses a simple
    // `.split(",")` rather than a URL-aware parser, so the
    // contract is exactly "comma-separated list". A future
    // session that needed to support URLs with commas would
    // change the argument shape to a JSON-encoded array and
    // update `main.py`'s handler in the same change.
    const args: string[] = [
      'extract',
      '--topic-id', options.topicId,
      '--urls', options.urls.join(','),
      '--port', String(port),
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
        savedCount: 0,
        failedCount: 0,
        kind: 'error',
        error: err instanceof Error ? err.message : String(err),
      });
    });
  });
};

// =============================================================================
//  Default export
// =============================================================================

/**
 * Every export bundled under one default object, matching the
 * convention of the sibling service modules (`searchService`,
 * `chromeLauncher`, `childProcessManager`). A caller that prefers
 * named imports uses `import { runExtract } from ...`; a caller
 * that prefers the default form uses
 * `import extractionService from ...` and destructures.
 */
export default {
  runExtract,
  getExtractionTaskId,
};