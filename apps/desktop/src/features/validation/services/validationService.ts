/**
 * validationService — orchestrates one validation operation.
 *
 * The validation stage takes a generated article and runs the six
 * Python validators (readability, seo, keywords, originality, ai
 * markers, grammar) against it, producing a report that the
 * Article tab's Report view renders as six panels. This module is
 * the main-process coordinator for that operation — the
 * counterpart to `searchService.ts`, `extractionService.ts`, and
 * `writerService.ts` for the validation stage.
 *
 * ── The flow ────────────────────────────────────────────────────
 *
 *   1. Spawn `python main.py validate` with the operation's
 *      arguments. The task ID is derived from the topic ID
 *      (`${topicId}-validate`) so a cancel call from a future
 *      session can find the manager.
 *
 *   2. Subscribe to the manager's `stdout` event. Each line is
 *      parsed as a `::ROOKIE::<TYPE>::<json>` marker; a parsed
 *      marker is broadcast to every renderer window over the
 *      `research:marker` IPC channel. `VALIDATION_PROGRESS`
 *      markers drive the live progress panel (one per validator,
 *      six in total); `VALIDATION_DONE` carries the terminal
 *      `reportPath` and `overallStatus`; `TASK_START` /
 *      `TASK_END` bracket the operation.
 *
 *   3. Wait for the child to exit. The exit code classifies the
 *      outcome:
 *
 *        0   → success. The report was written; the
 *              `VALIDATION_DONE` marker carries its path.
 *        99  → the user clicked Skip. Return kind='user-skip'.
 *        100 → the user clicked Stop. Return kind='user-stop'.
 *        101 → the captcha policy was 'skip' and a captcha
 *              appeared. Return kind='user-skip'. Validation
 *              does not involve captchas, so this code is
 *              classified the same way as the other three
 *              services for uniformity — it should never fire
 *              in practice.
 *        any other non-zero → a generic failure. Return
 *              kind='error' with the process's exit code in the
 *              message.
 *
 *   4. Return the validation result. The function never rejects
 *      — a failure is reported via the resolved result's
 *      `success: false` and `kind` fields, matching the pattern
 *      established by the other three services.
 *
 * ── No Chrome, no port ──────────────────────────────────────────
 *
 *   Validation is the only stage in the pipeline that does not
 *   need a browser. The six validators are pure text analyses —
 *   `textstat`, `nltk`, `sentence-transformers`, and
 *   `language-tool-python` all operate on strings, not on pages.
 *   The Python side's `main.py` accepts the `--port` flag on
 *   every subcommand because the flag is declared on the shared
 *   parent parser, but the `validate` handler ignores it.
 *
 *   This service therefore does NOT call `ensureChromeRunning`
 *   and does NOT pass a `--port` argument. Omitting the argument
 *   lets argparse apply its default (`9222`); the value is never
 *   read by the validate handler.
 *
 *   The practical consequence: a validation operation succeeds
 *   even when Chrome is closed, even when the user has never
 *   launched the app's Chrome profile, and even on a fresh
 *   install where the DeepSeek login has not been performed.
 *   That independence is what makes validation safe to run at
 *   any time — the user can validate an article immediately
 *   after opening the app, before any browser-based stage has
 *   been reached.
 *
 * ── The marker-routing design tradeoff ──────────────────────────
 *
 *   Same situation as the other three services: the listener
 *   bridge was written to attach to a raw `ChildProcess`, but
 *   `childProcessManager.ts` does not expose its internal
 *   process. This module therefore attaches its own listener to
 *   the manager's `stdout` events, parses markers with the same
 *   local parser the other services use, and broadcasts them
 *   itself using the same `MARKER_EVENT_CHANNEL` constant and the
 *   same `webContents.send` shape.
 *
 *   This is the fourth copy of the same twenty-line parser in the
 *   codebase. See `searchService.ts`'s file header for the full
 *   rationale on why the current session accepts the duplication
 *   rather than modifying the bridge or the manager to expose the
 *   child. A future session that wants to eliminate the four
 *   copies would give `ChildProcessManager` a public
 *   `getProcess()` method or would change
 *   `listenerBridge.attachToProcess` to accept a manager; either
 *   change is a small, well-scoped refactor that the plan defers.
 *
 * ── Why the validation task ID differs from the other stage IDs ─
 *
 *   The validation uses `${topicId}-validate`, distinct from the
 *   search's `${topicId}-search`, the extraction's
 *   `${topicId}-extract`, and the writer's `${topicId}-write`.
 *   The four are distinct so that, in principle, one of each
 *   stage could run simultaneously for the same topic without
 *   their manager registries colliding — the
 *   `childProcessManager`'s registry is keyed by task ID, and a
 *   collision would have the second `createProcessManager` call
 *   return the first's manager.
 *
 *   The consequence a reader should be aware of: a "cancel"
 *   operation for the validation needs to look up the validation's
 *   task ID, not the search's or the writer's. The cancel IPC
 *   handler for the validation will be added when the validation's
 *   own IPC file is created (Session 16, step 121). Until then, no
 *   cancel path for the validation exists — a validation run is
 *   short (a few seconds to a few minutes) and the user's
 *   alternative is to wait for it to finish.
 *
 * ── Why the service does not read the report file ───────────────
 *
 *   The Python script writes a JSON report to
 *   `<topicFolder>/reports/report-<articleStem>.json`, and the
 *   `VALIDATION_DONE` marker carries that path. This service
 *   returns the path to the caller without reading the file —
 *   the same pattern the writer service uses for its draft
 *   path, and the same pattern the search and extraction
 *   services use for their marker-carried data.
 *
 *   The caller (the validation's IPC handler, `validationIPC.ts`,
 *   Session 16 step 121) reads the file, and — when the desktop
 *   has an endpoint for it — POSTs the report's content to the
 *   backend's `/api/reports` route, receiving back a full
 *   `Report` object with the backend-assigned `_id`,
 *   `articleId`, `topicId`, `userId`, and `createdAt` fields.
 *   Keeping that read out of this service means the service
 *   stays a pure "spawn Python, wait, return path" coordinator.
 *
 * ── What this module does NOT do ────────────────────────────────
 *
 *   - It does not launch or connect to Chrome. See "No Chrome,
 *     no port" above.
 *
 *   - It does not persist the report to the backend. The
 *     backend's `/api/reports` endpoint is written to by the
 *     IPC handler, which reads the report file and POSTs it.
 *
 *   - It does not read the report file. See "Why the service
 *     does not read the report file" above.
 *
 *   - It does not validate the sources directory's existence or
 *     contents. The Python script does that — an empty or
 *     missing sources folder produces a report whose originality
 *     section is trivially good, per `validate_all.py`'s
 *     `_load_source_docs` behavior.
 *
 *   - It does not retry a failed validation. The operation is
 *     idempotent and cheap; a retry after a failure is a fresh
 *     `runValidate` call, not an automatic behavior of this
 *     function.
 *
 * ── Cross-feature imports ───────────────────────────────────────
 *
 *   This file imports two modules from the sibling `research`
 *   feature: `listenerBridge` and `childProcessManager`. The
 *   same PLAN DELTA that applied to `writerService.ts` applies
 *   here — the plan's Part 9 note says shared infrastructure
 *   lives under `features/automation`, but the plan's Part 1.9
 *   file tree places these modules under `research/services/`,
 *   and no `automation/services/` folder exists in the tree.
 *   The codebase follows the tree.
 *
 * Dependencies: Node stdlib + electron + the two sibling
 * research services.
 */

import { BrowserWindow } from 'electron';

import {
  MARKER_EVENT_CHANNEL,
  type MarkerEvent,
} from '../../research/services/listenerBridge.js';
import {
  createProcessManager,
  disposeProcessManager,
  type ProcessOptions,
} from '../../research/services/childProcessManager.js';

// =============================================================================
//  Public types
// =============================================================================

/**
 * The classification of a validation operation's outcome.
 *
 *   'success'    — the validation ran and the report was
 *                  written. `success` is `true` and `reportPath`
 *                  names the created file.
 *   'error'      — the validation process failed for a reason
 *                  other than a user action. The Python script
 *                  could not find the article file, a validator
 *                  crashed with an unhandled exception, an
 *                  internal error occurred mid-run.
 *   'user-skip'  — the user clicked Skip on a blocking prompt,
 *                  or the operation was cancelled. Validation
 *                  does not produce captcha or manual-action
 *                  prompts, so this kind is only reachable
 *                  through an explicit cancellation.
 *   'user-stop'  — the user clicked Stop.
 */
export type ValidationResultKind =
  | 'success'
  | 'error'
  | 'user-skip'
  | 'user-stop';

/**
 * The options `runValidate` accepts.
 */
export interface ValidationServiceOptions {
  /** The topic's ID. Used to derive the task ID (so a cancel
   *  path can find the manager), and included in every marker
   *  the Python script emits so the renderer routes the
   *  progress to the right topic's panel. */
  topicId: string;

  /** The absolute path to the article `.md` file to validate.
   *  The caller (`validationIPC.ts`) computes this path from the
   *  topic ID and the article's filename. */
  articlePath: string;

  /** The absolute path to the topic's `sources/` folder — the
   *  directory the originality validator reads to compare the
   *  article against its sources. The caller computes this path
   *  from the topic ID using the same convention
   *  `documentService.ts` and `writerIPC.ts` use. */
  sourcesDir: string;
}

/**
 * The result of one `runValidate` call. Never thrown — the
 * promise always resolves, and failures are described by the
 * `success` / `kind` / `error` fields.
 */
export interface ValidationServiceResult {
  /** True only when `kind === 'success'`. */
  success: boolean;

  /** The absolute path to the created report file. Populated on
   *  success; empty when the operation failed before the report
   *  was written. */
  reportPath: string;

  /** The aggregate status the Python script computed from the
   *  six section statuses. Populated on success; empty on
   *  failure. The value is one of `'good'`, `'warning'`, or
   *  `'fail'` — the same closed set the shared `ReportStatus`
   *  type declares. */
  overallStatus: string;

  /** The classification of the outcome. See
   *  `ValidationResultKind`. */
  kind: ValidationResultKind;

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
 *  'skip'" (`EXIT_CAPTCHA_SKIP`). Never emitted by the validation
 *  stage, but classified alongside the other exit codes for
 *  uniformity with the sibling services. */
const EXIT_CAPTCHA_SKIP = 101;

// =============================================================================
//  Helpers
// =============================================================================

/**
 * Parse a single `::ROOKIE::<TYPE>::<json>` line into a
 * `MarkerEvent`, or return `null` for a non-marker line.
 *
 * Same algorithm as `listenerBridge.ts`'s private parser and the
 * copies in `searchService.ts`, `extractionService.ts`, and
 * `writerService.ts`. See this file's header for the duplication
 * rationale.
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
 * Extract the `reportPath` and `overallStatus` fields from a
 * `VALIDATION_DONE` marker's payload.
 *
 * A malformed payload — a non-object, a missing field, a
 * non-string path — yields empty strings. The Python side is
 * expected to emit a well-formed payload; the guard exists so a
 * bug in the Python side produces an empty result, not a crash in
 * the main process.
 *
 * The two fields are returned together because they come from the
 * same marker and are consumed together — a `reportPath` without
 * its `overallStatus` would require the caller to read the file
 * to learn what the status is, and an `overallStatus` without its
 * `reportPath` would give the caller no way to find the report
 * the status describes.
 */
const extractValidationDoneFields = (
  payload: unknown
): { reportPath: string; overallStatus: string } => {
  if (typeof payload !== 'object' || payload === null) {
    return { reportPath: '', overallStatus: '' };
  }
  const p = payload as Record<string, unknown>;
  const reportPath = p['reportPath'];
  const overallStatus = p['overallStatus'];
  return {
    reportPath: typeof reportPath === 'string' ? reportPath : '',
    overallStatus:
      typeof overallStatus === 'string' ? overallStatus : '',
  };
};

/**
 * The deterministic task ID for a validation operation on a
 * given topic. Exported so a future session's cancel handler can
 * compute the same ID without duplicating the naming convention.
 *
 * See the file header for the reasoning behind using a distinct
 * suffix from the other three services' task IDs.
 */
export const getValidationTaskId = (topicId: string): string => {
  return `${topicId}-validate`;
};

// =============================================================================
//  Public entry point
// =============================================================================

/**
 * Run a validation operation and return the path of the created
 * report, or a structured failure.
 *
 * See the file header for the full flow. The function never
 * rejects — a failure is reported via the resolved result's
 * `success: false` and `kind` fields.
 *
 * The per-validator progress is delivered to the renderer through
 * the marker channel, not through the returned promise. The
 * promise resolves once the child has exited with the terminal
 * report path and overall status.
 */
export const runValidate = async (
  options: ValidationServiceOptions
): Promise<ValidationServiceResult> => {
  // ---- Validate ----
  // Three guards, all of which would produce confusing
  // downstream errors if allowed through. An empty topic ID
  // cannot be used as a task ID (the manager's constructor
  // rejects it with a less-clear message). An empty article
  // path or sources directory would have the Python script fail
  // with a message about a missing argument, which these early
  // checks produce more clearly.
  if (
    typeof options.topicId !== 'string' ||
    options.topicId.trim().length === 0
  ) {
    return {
      success: false,
      reportPath: '',
      overallStatus: '',
      kind: 'error',
      error: 'Topic ID is required.',
    };
  }
  if (
    typeof options.articlePath !== 'string' ||
    options.articlePath.trim().length === 0
  ) {
    return {
      success: false,
      reportPath: '',
      overallStatus: '',
      kind: 'error',
      error: 'Article path is required.',
    };
  }
  if (
    typeof options.sourcesDir !== 'string' ||
    options.sourcesDir.trim().length === 0
  ) {
    return {
      success: false,
      reportPath: '',
      overallStatus: '',
      kind: 'error',
      error: 'Sources directory is required.',
    };
  }

  // ---- Set up the process manager ----
  const taskId = getValidationTaskId(options.topicId);

  // Dispose any manager that survived a previous operation on
  // this topic. A stale manager could happen if the previous
  // validation crashed without going through `settle`. Disposing
  // is a no-op when no manager exists for this task ID.
  disposeProcessManager(taskId);

  const manager = createProcessManager(taskId);

  return new Promise<ValidationServiceResult>((resolve) => {
    let settled = false;
    // The terminal path and status are populated when the
    // VALIDATION_DONE marker arrives. They remain empty if the
    // process exits before the marker was emitted, which the
    // exit handler reports as a failure — the caller sees an
    // empty reportPath and knows no report was written.
    let lastReportPath = '';
    let lastOverallStatus = '';

    /**
     * Finalize the operation: mark as settled, dispose the
     * manager (which kills the child if it is still running),
     * resolve the promise. Idempotent — a second call is a no-op.
     *
     * The manager is disposed BEFORE the resolve because
     * disposing is what stops any pending child from continuing
     * to emit events into a promise that has already resolved.
     */
    const settle = (result: ValidationServiceResult): void => {
      if (settled) return;
      settled = true;
      disposeProcessManager(taskId);
      resolve(result);
    };

    // ---- stdout handler ----
    // Each line that parses as a marker is broadcast to every
    // renderer window. VALIDATION_DONE markers also update the
    // local path and status so the exit handler can return them.
    manager.on('stdout', (line: string) => {
      const marker = parseMarkerLine(line);
      if (marker === null) return;
      broadcastMarker(marker);
      if (marker.type === 'VALIDATION_DONE') {
        const fields = extractValidationDoneFields(marker.payload);
        lastReportPath = fields.reportPath;
        lastOverallStatus = fields.overallStatus;
      }
    });

    // ---- exit handler ----
    // The exit code classifies the outcome. `code` is `number |
    // null` — a null arrives when the process was terminated by a
    // signal rather than exiting on its own.
    //
    // Unlike `extractionService`, there is no "ran but produced
    // nothing" branch here. The validation either writes a
    // report (exit 0, VALIDATION_DONE seen) or it does not (any
    // non-zero exit, including a validator that raised an
    // unhandled exception). The Python script's own logic
    // ensures that a successful run always emits
    // VALIDATION_DONE before returning 0, so the exit-code
    // classification is sufficient.
    manager.on(
      'exit',
      (code: number | null, _signal: string | null) => {
        if (code === 0) {
          settle({
            success: true,
            reportPath: lastReportPath,
            overallStatus: lastOverallStatus,
            kind: 'success',
          });
          return;
        }
        if (code === EXIT_SKIPPED || code === EXIT_CAPTCHA_SKIP) {
          settle({
            success: false,
            reportPath: lastReportPath,
            overallStatus: lastOverallStatus,
            kind: 'user-skip',
            error: 'Validation skipped by user.',
          });
          return;
        }
        if (code === EXIT_STOPPED) {
          settle({
            success: false,
            reportPath: lastReportPath,
            overallStatus: lastOverallStatus,
            kind: 'user-stop',
            error: 'Validation stopped by user.',
          });
          return;
        }
        settle({
          success: false,
          reportPath: lastReportPath,
          overallStatus: lastOverallStatus,
          kind: 'error',
          error: `Validation process exited with code ${
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
        reportPath: lastReportPath,
        overallStatus: lastOverallStatus,
        kind: 'error',
        error: err.message,
      });
    });

    // ---- timeout handler ----
    // Fires when the caller set a timeout and the child exceeded
    // it. `runValidate` does not set one by default — the plan's
    // Part 5 milestone description has the validation running as
    // a foreground operation with a visible progress panel — so
    // this path only fires if a future caller overrides the
    // default.
    manager.on('timeout', () => {
      settle({
        success: false,
        reportPath: lastReportPath,
        overallStatus: lastOverallStatus,
        kind: 'error',
        error: 'Validation timed out.',
      });
    });

    // ---- killed handler ----
    // Fires when the manager's `kill()` terminates the child
    // directly (a hard cancel). Treating it as a user skip is
    // the correct semantic — the user asked for the operation to
    // end, and the operation ended.
    manager.on('killed', () => {
      settle({
        success: false,
        reportPath: lastReportPath,
        overallStatus: lastOverallStatus,
        kind: 'user-skip',
        error: 'Validation was cancelled.',
      });
    });

    // ---- Build the arguments ----
    // The Python subcommand takes the operation name, the
    // operation's inputs, and the `--control-mode` flag. No
    // `--port` is passed — the validate handler does not need a
    // browser and does not read the value. See the file header's
    // "No Chrome, no port" section for the full reasoning.
    const args: string[] = [
      'validate',
      '--article', options.articlePath,
      '--sources-dir', options.sourcesDir,
      '--control-mode',
    ];

    const startOptions: ProcessOptions = { args };

    // ---- Spawn ----
    // `start()` resolves once the child is spawned. Its promise
    // can reject if the spawn call itself throws; the catch
    // converts a rejection into the same `settle` the error
    // handler uses, so the caller always sees a resolved result.
    void manager.start(startOptions).catch((err: unknown) => {
      settle({
        success: false,
        reportPath: '',
        overallStatus: '',
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
 * `extractionService`, `writerService`, `chromeLauncher`,
 * `childProcessManager`). A caller that prefers named imports
 * uses `import { runValidate } from ...`; a caller that prefers
 * the default form uses `import validationService from ...` and
 * destructures.
 */
export default {
  runValidate,
  getValidationTaskId,
};