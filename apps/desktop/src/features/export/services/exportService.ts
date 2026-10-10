/**
 * exportService — orchestrates one export operation.
 *
 * The export stage takes a generated article and writes it to a
 * user-chosen path in one of the pipeline's supported formats.
 * It is the shortest operation in the pipeline — no page
 * loads, no network calls, no model invocation — and the only
 * one whose output path is chosen by the user through a native
 * dialog rather than derived from the topic's folder layout.
 *
 * This module is the main-process coordinator for that
 * operation, following the same shape as the four preceding
 * stage services (`searchService`, `extractionService`,
 * `writerService`, `validationService`).
 *
 * ── The flow ────────────────────────────────────────────────────
 *
 *   1. Spawn `python main.py export` with the caller-supplied
 *      `--format`, `--article`, and `--output` arguments. The
 *      task ID is derived from the topic ID and the format
 *      (`${topicId}-export-${format}`) so a cancel path can
 *      find the manager even if the user started a docx and an
 *      md export in quick succession.
 *
 *   2. Subscribe to the manager's `stdout` event. Every parsed
 *      marker is forwarded to the renderer over the
 *      `research:marker` IPC channel. The export script itself
 *      emits no stage-specific markers, but `main.py` brackets
 *      every subcommand with `TASK_START` / `TASK_END`, and
 *      forwarding those keeps the automation store's running-
 *      tasks list consistent with the other four stages.
 *
 *   3. Wait for the child to exit. The exit code classifies the
 *      outcome:
 *
 *        0   → success. The output file was written.
 *        99  → the user clicked Skip. Return kind='user-skip'.
 *        100 → the user clicked Stop. Return kind='user-stop'.
 *        101 → the captcha policy was 'skip' and a captcha
 *              appeared. Never fires for export — export has no
 *              browser — but classified alongside the others
 *              for uniformity.
 *        any other non-zero → a generic failure. Return
 *              kind='error' with the process's exit code in the
 *              message.
 *
 *   4. Return the export result. The function never rejects —
 *      a failure is reported via the resolved result's
 *      `success: false` and `kind` fields.
 *
 * ── No Chrome, no port ──────────────────────────────────────────
 *
 *   Same reasoning as `validationService.ts`: export is a pure
 *   file transformation. The two Python writers
 *   (`export_docx.py`, `export_md.py`) read the article from
 *   disk and write the output to disk. No browser is involved.
 *   The service therefore does not call `ensureChromeRunning`
 *   and does not pass a `--port` argument; the Python side's
 *   argparse default (9222) applies and is never read by the
 *   `validate` handler.
 *
 * ── The Save-As dialog is the caller's concern ─────────────────
 *
 *   The user chooses the export destination through a native
 *   Save-As dialog — `dialog.showSaveDialog` from Electron's
 *   `dialog` module. That dialog is a main-process API, so it
 *   is opened by the export IPC handler (`exportIPC.ts`,
 *   Session 17 step 127) BEFORE this service is invoked. By the
 *   time `runExport` runs, the caller already has the resolved
 *   output path in hand and passes it as `options.outputPath`.
 *
 *   The consequence: this service does not need to know that
 *   the dialog exists. It receives an absolute path and writes
 *   to it. The dialog's default filename, filters, and the
 *   user's possibly-cancelled choice are all handled one layer
 *   up.
 *
 * ── The output path is trusted, not validated ───────────────────
 *
 *   This service does NOT validate the output path against a
 *   sandbox or a folder allowlist. The path came from a dialog
 *   the user drove directly — it is whatever the user chose,
 *   anywhere on their filesystem, and that is the correct
 *   scope for a desktop app whose purpose is to produce files
 *   the user can open in Word or a Markdown editor.
 *
 *   The contrast with `documentService.ts`'s `isPathSafe` check
 *   is deliberate. That check exists because the document
 *   feature's paths come from the extraction pipeline's
 *   internally-computed folder layout, and a compromised
 *   renderer could otherwise ask it to read arbitrary files.
 *   The export output path has the opposite trust model: the
 *   user chose it, and refusing their choice would be the bug.
 *
 * ── The marker-routing design tradeoff ──────────────────────────
 *
 *   Same situation as the four preceding services: the listener
 *   bridge was written to attach to a raw `ChildProcess`, but
 *   `childProcessManager.ts` does not expose its internal
 *   process. This module attaches its own stdout listener and
 *   parses markers with the same local parser the other four
 *   services use.
 *
 *   This is the fifth and final copy of the same twenty-line
 *   parser in the codebase. The full rationale for accepting
 *   the duplication is documented in `searchService.ts`'s file
 *   header. A future session that wants to eliminate the five
 *   copies would give `ChildProcessManager` a public
 *   `getProcess()` method or would change
 *   `listenerBridge.attachToProcess` to accept a manager.
 *
 * ── Cross-feature imports ───────────────────────────────────────
 *
 *   Same PLAN DELTA that applied to `writerService.ts` and
 *   `validationService.ts`: this file imports two modules from
 *   the sibling `research` feature (`listenerBridge` and
 *   `childProcessManager`) because the plan's Part 1.9 file
 *   tree places the shared-runner infrastructure under
 *   `research/services/`, and no `automation/services/` folder
 *   exists in the tree.
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
 * The two output formats the export service currently supports.
 *
 * The two values are the ones `main.py`'s `export` subparser
 * declares in its `--format` choices. A future session that
 * added a third writer (an HTML exporter, a PDF exporter) would
 * add the format to the union and to the Python side's choices
 * together, and update the preload's `ExportNamespace` interface
 * with a new method for the format.
 *
 * The preload currently declares three methods — `docx`, `md`,
 * `txt` — but the Python side ships only two writers. The `txt`
 * method is forward-looking; a caller that invoked it would find
 * the export IPC handler returning a "format not supported"
 * error. See the export IPC handler's file header for the
 * handling of the mismatch.
 */
export type ExportFormat = 'docx' | 'md';

/**
 * The classification of an export operation's outcome.
 *
 *   'success'    — the export ran and the output file was
 *                  written. `success` is `true`.
 *   'error'      — the export process failed for a reason other
 *                  than a user action. The Python writer could
 *                  not read the article, a disk error occurred,
 *                  the output format was not supported.
 *   'user-skip'  — the user cancelled the operation (through a
 *                  future UI affordance; today, an export
 *                  cannot be cancelled because it completes in
 *                  under a second).
 *   'user-stop'  — same as `'user-skip'`, classified separately
 *                  for consistency with the other services.
 */
export type ExportResultKind =
  | 'success'
  | 'error'
  | 'user-skip'
  | 'user-stop';

/**
 * The options `runExport` accepts.
 */
export interface ExportServiceOptions {
  /** The topic's ID. Used to derive the task ID (so a cancel
   *  path can find the manager), and included in every marker
   *  the Python script emits. */
  topicId: string;

  /** Which format to write. See `ExportFormat`. */
  format: ExportFormat;

  /** The absolute path to the article `.md` file to export. The
   *  caller computes this from the topic's folder layout — the
   *  same convention `validationIPC.ts` uses. */
  articlePath: string;

  /** The absolute path to write the exported file to. The
   *  caller obtains this from a Save-As dialog before invoking
   *  this service. */
  outputPath: string;
}

/**
 * The result of one `runExport` call. Never thrown — the promise
 * always resolves, and failures are described by the `success` /
 * `kind` / `error` fields.
 */
export interface ExportServiceResult {
  /** True only when `kind === 'success'`. */
  success: boolean;

  /** The path the exported file was written to. Populated on
   *  success. On failure, the caller-supplied `outputPath` is
   *  echoed back so the caller can correlate the result with
   *  its request. */
  outputPath: string;

  /** The classification of the outcome. See
   *  `ExportResultKind`. */
  kind: ExportResultKind;

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
 *  'skip'" (`EXIT_CAPTCHA_SKIP`). Never emitted by the export
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
 * Same algorithm as `listenerBridge.ts`'s private parser and
 * the copies in the four sibling services. See this file's
 * header for the duplication rationale.
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
 * Same shape and same channel as `listenerBridge.broadcast` —
 * the renderer cannot tell which module emitted a given marker.
 */
const broadcastMarker = (event: MarkerEvent): void => {
  const windows = BrowserWindow.getAllWindows();
  for (const win of windows) {
    if (win.isDestroyed()) continue;
    win.webContents.send(MARKER_EVENT_CHANNEL, event);
  }
};

/**
 * The deterministic task ID for an export operation on a given
 * topic and format.
 *
 * The task ID includes the FORMAT so that a docx export and an
 * md export — which a user could trigger in quick succession,
 * one after the other from the same ExportMenu dropdown — do
 * not collide in the manager registry. Each format gets its
 * own manager; the two run independently if both are in flight
 * at the same moment.
 *
 * Exported so a future session's cancel handler can compute
 * the same ID without duplicating the naming convention.
 */
export const getExportTaskId = (
  topicId: string,
  format: ExportFormat
): string => {
  return `${topicId}-export-${format}`;
};

// =============================================================================
//  Public entry point
// =============================================================================

/**
 * Run an export operation and return the output path, or a
 * structured failure.
 *
 * See the file header for the full flow. The function never
 * rejects — a failure is reported via the resolved result's
 * `success: false` and `kind` fields.
 *
 * The operation is short — a fraction of a second for either
 * format on a normal-sized article — so no progress markers
 * flow during the run. The returned promise resolves once the
 * child has exited.
 */
export const runExport = async (
  options: ExportServiceOptions
): Promise<ExportServiceResult> => {
  // ---- Validate ----
  // Four guards, each of which would produce a confusing
  // downstream error if allowed through. An empty topic ID
  // cannot be used as a task ID. An empty or invalid format
  // would be rejected by argparse on the Python side with a
  // message about the choices list. An empty article path or
  // output path would have the Python script fail with a
  // message about a missing argument.
  if (
    typeof options.topicId !== 'string' ||
    options.topicId.trim().length === 0
  ) {
    return {
      success: false,
      outputPath: '',
      kind: 'error',
      error: 'Topic ID is required.',
    };
  }
  if (options.format !== 'docx' && options.format !== 'md') {
    return {
      success: false,
      outputPath: '',
      kind: 'error',
      error: `Unsupported export format: ${String(options.format)}.`,
    };
  }
  if (
    typeof options.articlePath !== 'string' ||
    options.articlePath.trim().length === 0
  ) {
    return {
      success: false,
      outputPath: '',
      kind: 'error',
      error: 'Article path is required.',
    };
  }
  if (
    typeof options.outputPath !== 'string' ||
    options.outputPath.trim().length === 0
  ) {
    return {
      success: false,
      outputPath: '',
      kind: 'error',
      error: 'Output path is required.',
    };
  }

  // ---- Set up the process manager ----
  const taskId = getExportTaskId(options.topicId, options.format);

  // Dispose any manager that survived a previous operation on
  // the same topic-and-format pair. Disposing is a no-op when
  // no manager exists for this task ID.
  disposeProcessManager(taskId);

  const manager = createProcessManager(taskId);

  return new Promise<ExportServiceResult>((resolve) => {
    let settled = false;

    /**
     * Finalize the operation: mark as settled, dispose the
     * manager (which kills the child if it is still running),
     * resolve the promise. Idempotent — a second call is a
     * no-op.
     */
    const settle = (result: ExportServiceResult): void => {
      if (settled) return;
      settled = true;
      disposeProcessManager(taskId);
      resolve(result);
    };

    // ---- stdout handler ----
    // Each line that parses as a marker is broadcast to every
    // renderer window. The export script itself emits no
    // stage-specific markers, but `main.py`'s task-boundary
    // markers flow through here. Forwarding them keeps the
    // automation store's running-tasks list consistent with the
    // other four stages.
    manager.on('stdout', (line: string) => {
      const marker = parseMarkerLine(line);
      if (marker === null) return;
      broadcastMarker(marker);
    });

    // ---- exit handler ----
    // The exit code classifies the outcome. `code` is `number |
    // null` — a null arrives when the process was terminated by
    // a signal rather than exiting on its own.
    manager.on(
      'exit',
      (code: number | null, _signal: string | null) => {
        if (code === 0) {
          settle({
            success: true,
            outputPath: options.outputPath,
            kind: 'success',
          });
          return;
        }
        if (code === EXIT_SKIPPED || code === EXIT_CAPTCHA_SKIP) {
          settle({
            success: false,
            outputPath: options.outputPath,
            kind: 'user-skip',
            error: 'Export skipped by user.',
          });
          return;
        }
        if (code === EXIT_STOPPED) {
          settle({
            success: false,
            outputPath: options.outputPath,
            kind: 'user-stop',
            error: 'Export stopped by user.',
          });
          return;
        }
        settle({
          success: false,
          outputPath: options.outputPath,
          kind: 'error',
          error: `Export process exited with code ${
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
        outputPath: options.outputPath,
        kind: 'error',
        error: err.message,
      });
    });

    // ---- timeout handler ----
    // Fires when the caller set a timeout and the child exceeded
    // it. `runExport` does not set one by default — the
    // operation completes in under a second on a normal article
    // — so this path only fires if a future caller overrides
    // the default.
    manager.on('timeout', () => {
      settle({
        success: false,
        outputPath: options.outputPath,
        kind: 'error',
        error: 'Export timed out.',
      });
    });

    // ---- killed handler ----
    // Fires when the manager's `kill()` terminates the child
    // directly. Treating it as a user skip is the correct
    // semantic — the user asked for the operation to end, and
    // the operation ended.
    manager.on('killed', () => {
      settle({
        success: false,
        outputPath: options.outputPath,
        kind: 'user-skip',
        error: 'Export was cancelled.',
      });
    });

    // ---- Build the arguments ----
    // The Python subcommand takes the operation name, the
    // operation's inputs, and the `--control-mode` flag. No
    // `--port` is passed — export has no browser dependency.
    // See the file header's "No Chrome, no port" section.
    const args: string[] = [
      'export',
      '--format', options.format,
      '--article', options.articlePath,
      '--output', options.outputPath,
      '--control-mode',
    ];

    const startOptions: ProcessOptions = { args };

    // ---- Spawn ----
    // `start()` resolves once the child is spawned. Its promise
    // can reject if the spawn call itself throws; the catch
    // converts a rejection into the same `settle` the error
    // handler uses.
    void manager.start(startOptions).catch((err: unknown) => {
      settle({
        success: false,
        outputPath: options.outputPath,
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
 * `extractionService`, `writerService`, `validationService`).
 * A caller that prefers named imports uses
 * `import { runExport } from ...`; a caller that prefers the
 * default form uses `import exportService from ...` and
 * destructures.
 */
export default {
  runExport,
  getExportTaskId,
};