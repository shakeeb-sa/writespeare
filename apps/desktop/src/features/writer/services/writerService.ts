/**
 * writerService — orchestrates one DeepSeek writer operation.
 *
 * The writer stage turns a topic's extracted source docs into a
 * finished article by driving the DeepSeek chat UI in the app's
 * persistent Chrome instance. This module is the main-process
 * coordinator for that operation — the counterpart to
 * `searchService.ts` and `extractionService.ts` for the writer
 * stage.
 *
 * ── The flow ────────────────────────────────────────────────────
 *
 *   1. Ensure Chrome is running. Reuse the app's persistent-
 *      profile Chrome if one is registered with the launcher;
 *      otherwise launch a fresh one with the app's chrome-profile
 *      path. Chrome is NOT killed at the end of the operation —
 *      it lives for the app's lifetime so that the user's
 *      DeepSeek login (which the writer step depends on) survives
 *      across operations. Shutdown is the app's `before-quit`
 *      handler's job.
 *
 *   2. Spawn `python main.py write` with the operation's
 *      arguments and the Chrome port. The task ID is derived from
 *      the topic ID (`${topicId}-write`) so a cancel call from a
 *      future session can find the manager.
 *
 *   3. Subscribe to the manager's `stdout` event. Each line is
 *      parsed as a `::ROOKIE::<TYPE>::<json>` marker; a parsed
 *      marker is broadcast to every renderer window over the
 *      `research:marker` IPC channel. WRITER_PROGRESS markers
 *      drive the live writing panel (each doc paste, the prompt
 *      typing, the response waiting); WRITER_DONE carries the
 *      terminal articlePath and wordCount; CAPTCHA_REQUIRED and
 *      MANUAL_ACTION open the modal when DeepSeek presents a
 *      login wall or other blocker; TASK_START / TASK_END
 *      bracket the operation.
 *
 *   4. Wait for the child to exit. The exit code classifies the
 *      outcome:
 *
 *        0   → success. WRITER_DONE was seen and the article was
 *              saved.
 *        99  → the user clicked Skip. Return kind='user-skip'.
 *        100 → the user clicked Stop. Return kind='user-stop'.
 *        101 → the captcha policy was 'skip' and a captcha
 *              appeared. Return kind='user-skip'.
 *        any other non-zero → a generic failure. Return
 *              kind='error' with the process's exit code in the
 *              message.
 *
 *   5. Return the writer result. The function never rejects — a
 *      failure is reported via the resolved result's
 *      `success: false` and `kind` fields, matching the pattern
 *      established by `searchService.runSearch` and
 *      `extractionService.runExtract`.
 *
 * ── The writer step's duration ──────────────────────────────────
 *
 *   The writer is the longest single stage in the pipeline.
 *   Pasting ten source docs takes a few seconds each, typing the
 *   prompt is fast, and the DeepSeek generation itself runs 15–60
 *   seconds for a typical prompt. A whole operation routinely
 *   takes a minute or more.
 *
 *   The service does NOT impose a wall-clock timeout on the
 *   operation. The Python script has its own bounded wait for
 *   the response's appearance and stability (see
 *   `deepseek_writer.py`'s `RESPONSE_APPEAR_TIMEOUT_SECONDS`), so
 *   a stuck generation fails on the Python side after ninety
 *   seconds. Adding a second timeout here would either fire
 *   before the Python timeout on a legitimate slow generation,
 *   or be redundant on a truly stuck one. The service trusts
 *   the Python script's timeout and only responds to the child's
 *   own exit.
 *
 * ── The marker-routing design tradeoff ──────────────────────────
 *
 *   Same situation as `searchService.ts` and
 *   `extractionService.ts`: `listenerBridge.ts` was written to
 *   attach to a raw `ChildProcess`, but `childProcessManager.ts`
 *   does not expose its internal process object. This module
 *   therefore attaches its own listener to the manager's
 *   `stdout` events, parses markers with a small local parser
 *   (same algorithm as the bridge's), and broadcasts them itself
 *   using the same `MARKER_EVENT_CHANNEL` constant and the same
 *   `webContents.send` shape.
 *
 *   The renderer cannot tell the difference. This is the third
 *   copy of the same twenty-line parser in the codebase — see
 *   `searchService.ts`'s file header for the full rationale on
 *   why the current session accepts the duplication rather than
 *   modifying the bridge or the manager to expose the child. A
 *   future session that wants to eliminate the three copies
 *   would give `ChildProcessManager` a public `getProcess()`
 *   method or would change `listenerBridge.attachToProcess` to
 *   accept a manager; either change is a small, well-scoped
 *   refactor that the plan defers.
 *
 * ── Why the writer task ID differs from the other stage IDs ─────
 *
 *   The writer uses `${topicId}-write`, distinct from the search's
 *   `${topicId}-search` and the extraction's `${topicId}-extract`.
 *   The three are distinct so that, in principle, one of each
 *   stage could run simultaneously for the same topic without
 *   their manager registries colliding — the
 *   `childProcessManager`'s registry is keyed by task ID, and a
 *   collision would have the second `createProcessManager` call
 *   return the first's manager.
 *
 *   The consequence a reader should be aware of: a "cancel"
 *   operation for the writer needs to look up the writer's task
 *   ID, not the search's. The cancel IPC handler for the writer
 *   will be added when the writer's own IPC file is created
 *   (Session 14, step 105). Until then, no cancel path for the
 *   writer exists — a user who wants to abort a running
 *   generation must do so from the DeepSeek UI in the Chrome
 *   window, which the Python script detects as an interrupted
 *   response and treats as a failure.
 *
 * ── What this module does NOT do ────────────────────────────────
 *
 *   - It does not kill Chrome. Chrome is the app's shared,
 *     persistent-profile instance; killing it at the end of every
 *     writer operation would force a re-login to DeepSeek on the
 *     next operation. Shutdown is `main/index.ts`'s `before-quit`
 *     handler's job.
 *
 *   - It does not persist the article to the backend. The draft
 *     file lands at `<topicFolder>/article/draft-NN.md`; the
 *     backend's `/api/articles` endpoint is written to by a
 *     separate step — the desktop's writer IPC handler will
 *     construct an `Article` from the draft and POST it. This
 *     service's job ends when the child has exited and the
 *     markers have been broadcast.
 *
 *   - It does not read the topic's `topic.json` to compute the
 *     docs directory or the prompt file. Both are passed in by
 *     the caller (`writerIPC.ts`, a future session's file). See
 *     `WriterServiceOptions` for the argument shapes.
 *
 *   - It does not validate the docs directory's existence or
 *     contents. The Python script does that — an empty folder
 *     produces a clean failure that the service classifies as
 *     `'error'` from the non-zero exit code.
 *
 *   - It does not retry a failed generation. The plan's user
 *     journey has the corrective loop handled at the store /
 *     renderer level, not inside this service. A retry after a
 *     failure is a fresh `runGenerate` call, not an automatic
 *     behavior of this function.
 *
 * ── Cross-feature imports ───────────────────────────────────────
 *
 *   This file imports three modules from the sibling `research`
 *   feature: `listenerBridge`, `chromeLauncher`, and
 *   `childProcessManager`. The plan's Part 9 note says shared
 *   infrastructure lives under `features/automation` and
 *   `features/shared` — but the plan's Part 1.9 file tree places
 *   these three modules under `research/services/`, and no
 *   `automation/services/` folder exists in the tree. The
 *   codebase follows the tree. The import direction (writer →
 *   research) is a consequence of that placement, and is logged
 *   as a PLAN DELTA with this file's creation.
 *
 * Dependencies: Node stdlib + electron + the three sibling
 * research services.
 */

import { app, BrowserWindow } from 'electron';
import path from 'node:path';

import {
  MARKER_EVENT_CHANNEL,
  type MarkerEvent,
} from '../../research/services/listenerBridge.js';
import {
  getRunningInstances,
  launchChrome,
} from '../../research/services/chromeLauncher.js';
import {
  createProcessManager,
  disposeProcessManager,
  type ProcessOptions,
} from '../../research/services/childProcessManager.js';

// =============================================================================
//  Public types
// =============================================================================

/**
 * The classification of a writer operation's outcome.
 *
 *   'success'    — the writer ran and the article was saved.
 *                  `success` is `true` and `draftPath` names the
 *                  created file.
 *   'error'      — the writer process failed for a reason other
 *                  than a user action. The Python script could
 *                  not find the docs directory, the DeepSeek
 *                  session could not be reached, an internal
 *                  error occurred mid-generation.
 *   'user-skip'  — the user clicked Skip on a blocking prompt
 *                  (a DeepSeek login wall, a manual-action
 *                  modal), or the operation was cancelled.
 *   'user-stop'  — the user clicked Stop.
 */
export type WriterResultKind =
  | 'success'
  | 'error'
  | 'user-skip'
  | 'user-stop';

/**
 * The options `runGenerate` accepts.
 */
export interface WriterServiceOptions {
  /** The topic's ID. Used to derive the task ID (so a cancel
   *  path can find the manager), and included in every marker
   *  the Python script emits so the renderer routes the progress
   *  to the right topic's panel. */
  topicId: string;

  /** The absolute path to the topic's `sources/` folder — the
   *  directory the writer step reads its source docs from. The
   *  caller (`writerIPC.ts`) computes this path from the topic
   *  ID using the same convention `documentService.ts` uses. */
  docsDir: string;

  /** The prompt template file's name (e.g. `default.md`,
   *  `seo-focused.md`, `conversational.md`). The Python side
   *  resolves it relative to `<scripts>/prompts/`. */
  promptFile: string;

  /** The captcha policy to forward to the Python script. See
   *  `ProcessOptions.captchaPolicy` for the semantics. Omit to
   *  get the Python side's default of `'ask'`. */
  captchaPolicy?: 'ask' | 'skip' | 'stop';
}

/**
 * The result of one `runGenerate` call. Never thrown — the
 * promise always resolves, and failures are described by the
 * `success` / `kind` / `error` fields.
 */
export interface WriterServiceResult {
  /** True only when `kind === 'success'`. */
  success: boolean;

  /** The absolute path to the created draft file. Populated on
   *  success; empty when the operation failed before the draft
   *  was written. */
  draftPath: string;

  /** The draft's word count, as reported by the writer script's
   *  `WRITER_DONE` marker. Zero when the operation failed. */
  wordCount: number;

  /** The classification of the outcome. See `WriterResultKind`. */
  kind: WriterResultKind;

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
 * Same path as `searchService.ts` and `extractionService.ts`
 * compute. The duplication is intentional — see
 * `extractionService.ts`'s docstring on its helper of the same
 * name for the reasoning.
 */
const getChromeProfilePath = (): string => {
  return path.join(app.getPath('userData'), 'chrome-profile');
};

/**
 * Return the current app-wide Chrome instance's debug port,
 * launching a fresh Chrome if none is running.
 *
 * See `extractionService.ts`'s helper of the same name for the
 * full rationale on the reuse-across-operations model.
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
 * Same algorithm as `listenerBridge.ts`'s private parser and the
 * copies in `searchService.ts` and `extractionService.ts`. See
 * this file's header for the duplication rationale.
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
 * Extract the `articlePath` and `wordCount` fields from a
 * `WRITER_DONE` marker's payload.
 *
 * A malformed payload — a non-object, a missing field, a
 * negative word count, a non-string path — yields empty/zero
 * values. The Python side is expected to emit a well-formed
 * payload; the guard exists so a bug in the Python side produces
 * an empty result, not a crash in the main process.
 *
 * The two fields are returned together because they come from the
 * same marker and are consumed together — a `wordCount` without
 * its `articlePath` would give the caller no way to find the
 * file it was counting.
 */
const extractWriterDoneFields = (
  payload: unknown
): { articlePath: string; wordCount: number } => {
  if (typeof payload !== 'object' || payload === null) {
    return { articlePath: '', wordCount: 0 };
  }
  const p = payload as Record<string, unknown>;
  const articlePath = p['articlePath'];
  const wordCount = p['wordCount'];
  return {
    articlePath:
      typeof articlePath === 'string' ? articlePath : '',
    wordCount:
      typeof wordCount === 'number' && wordCount >= 0
        ? wordCount
        : 0,
  };
};

/**
 * The deterministic task ID for a writer operation on a given
 * topic. Exported so a future session's cancel handler can
 * compute the same ID without duplicating the naming
 * convention.
 *
 * See the file header for the reasoning behind using a distinct
 * suffix from `searchService`'s and `extractionService`'s task
 * IDs.
 */
export const getWriterTaskId = (topicId: string): string => {
  return `${topicId}-write`;
};

// =============================================================================
//  Public entry point
// =============================================================================

/**
 * Run a writer operation and return the path of the created
 * draft, or a structured failure.
 *
 * See the file header for the full flow. The function never
 * rejects — a failure is reported via the resolved result's
 * `success: false` and `kind` fields.
 *
 * The per-doc paste progress, the prompt-typing state, and the
 * response-waiting state are delivered to the renderer through
 * the marker channel, not through the returned promise. The
 * promise resolves once the child has exited with the terminal
 * article path and word count.
 */
export const runGenerate = async (
  options: WriterServiceOptions
): Promise<WriterServiceResult> => {
  // ---- Validate ----
  // Two guards, both of which would produce confusing downstream
  // errors if allowed through. An empty topic ID cannot be used
  // as a task ID (the manager's constructor rejects it with a
  // less-clear message). An empty docs directory would have the
  // Python script fail with a message about a missing folder,
  // which this early check produces more clearly.
  if (
    typeof options.topicId !== 'string' ||
    options.topicId.trim().length === 0
  ) {
    return {
      success: false,
      draftPath: '',
      wordCount: 0,
      kind: 'error',
      error: 'Topic ID is required.',
    };
  }
  if (
    typeof options.docsDir !== 'string' ||
    options.docsDir.trim().length === 0
  ) {
    return {
      success: false,
      draftPath: '',
      wordCount: 0,
      kind: 'error',
      error: 'Docs directory is required.',
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
      draftPath: '',
      wordCount: 0,
      kind: 'error',
      error: `Could not launch Chrome: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  // ---- Set up the process manager ----
  const taskId = getWriterTaskId(options.topicId);

  // Dispose any manager that survived a previous operation on
  // this topic. A stale manager could happen if the previous
  // writer run crashed without going through `settle`, or if the
  // caller cancelled but did not dispose. Disposing is a no-op
  // when no manager exists for this task ID.
  disposeProcessManager(taskId);

  const manager = createProcessManager(taskId);

  return new Promise<WriterServiceResult>((resolve) => {
    let settled = false;
    // The terminal path and word count are populated when the
    // WRITER_DONE marker arrives. They remain empty/zero if the
    // process exits before the marker was emitted, which the
    // exit handler reports as a failure — the caller sees an
    // empty draftPath and knows no article was produced.
    let lastArticlePath = '';
    let lastWordCount = 0;

    /**
     * Finalize the operation: mark as settled, dispose the
     * manager (which kills the child if it is still running),
     * resolve the promise. Idempotent — a second call is a no-op.
     *
     * The manager is disposed BEFORE the resolve because
     * disposing is what stops any pending child from continuing
     * to emit events into a promise that has already resolved.
     */
    const settle = (result: WriterServiceResult): void => {
      if (settled) return;
      settled = true;
      disposeProcessManager(taskId);
      resolve(result);
    };

    // ---- stdout handler ----
    // Each line that parses as a marker is broadcast to every
    // renderer window. WRITER_DONE markers also update the local
    // path and word count so the exit handler can return them.
    manager.on('stdout', (line: string) => {
      const marker = parseMarkerLine(line);
      if (marker === null) return;
      broadcastMarker(marker);
      if (marker.type === 'WRITER_DONE') {
        const fields = extractWriterDoneFields(marker.payload);
        lastArticlePath = fields.articlePath;
        lastWordCount = fields.wordCount;
      }
    });

    // ---- exit handler ----
    // The exit code classifies the outcome. `code` is `number |
    // null` — a null arrives when the process was terminated by a
    // signal rather than exiting on its own.
    //
    // Unlike `extractionService`, there is no "ran but produced
    // nothing" branch here. The writer either saves an article
    // (exit 0, WRITER_DONE seen) or it does not (any non-zero
    // exit, including an interrupted generation). The Python
    // script's own logic ensures that a successful run always
    // emits WRITER_DONE before returning 0, so the two cases
    // (exit 0 with a path, exit 0 with no path) cannot both
    // happen; the exit-code classification is sufficient.
    manager.on(
      'exit',
      (code: number | null, _signal: string | null) => {
        if (code === 0) {
          settle({
            success: true,
            draftPath: lastArticlePath,
            wordCount: lastWordCount,
            kind: 'success',
          });
          return;
        }
        if (code === EXIT_SKIPPED || code === EXIT_CAPTCHA_SKIP) {
          settle({
            success: false,
            draftPath: lastArticlePath,
            wordCount: lastWordCount,
            kind: 'user-skip',
            error: 'Article generation skipped by user.',
          });
          return;
        }
        if (code === EXIT_STOPPED) {
          settle({
            success: false,
            draftPath: lastArticlePath,
            wordCount: lastWordCount,
            kind: 'user-stop',
            error: 'Article generation stopped by user.',
          });
          return;
        }
        settle({
          success: false,
          draftPath: lastArticlePath,
          wordCount: lastWordCount,
          kind: 'error',
          error: `Writer process exited with code ${
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
        draftPath: lastArticlePath,
        wordCount: lastWordCount,
        kind: 'error',
        error: err.message,
      });
    });

    // ---- timeout handler ----
    // Fires when the caller set a timeout and the child exceeded
    // it. `runGenerate` does not set one by default — see the
    // file header for the reasoning — so this path only fires if
    // a future caller overrides the default.
    manager.on('timeout', () => {
      settle({
        success: false,
        draftPath: lastArticlePath,
        wordCount: lastWordCount,
        kind: 'error',
        error: 'Writer timed out.',
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
        draftPath: lastArticlePath,
        wordCount: lastWordCount,
        kind: 'user-skip',
        error: 'Article generation was cancelled.',
      });
    });

    // ---- Build the arguments ----
    // The Python subcommand takes the operation name, the
    // operation's inputs, and the debug port. `--control-mode`
    // is always passed — the whole point of this operation is
    // the marker stream that goes back to the renderer.
    const args: string[] = [
      'write',
      '--topic-id', options.topicId,
      '--docs-dir', options.docsDir,
      '--prompt-file', options.promptFile,
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
        draftPath: '',
        wordCount: 0,
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
 * `extractionService`, `chromeLauncher`, `childProcessManager`).
 * A caller that prefers named imports uses
 * `import { runGenerate } from ...`; a caller that prefers the
 * default form uses `import writerService from ...` and
 * destructures.
 */
export default {
  runGenerate,
  getWriterTaskId,
};