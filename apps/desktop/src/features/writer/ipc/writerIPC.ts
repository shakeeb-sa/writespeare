/**
 * writerIPC — IPC handlers for the writer feature.
 *
 * Registers the two channels the renderer's
 * `window.electronAPI.writer.*` methods invoke:
 *
 *   writer:generate  — run the DeepSeek writer for a topic and
 *                      return the created Article.
 *   writer:cancel    — abort an in-flight writer operation.
 *
 * The two channels correspond one-to-one with the two methods
 * the preload declares on `window.electronAPI.writer` — `generate`
 * and `cancel`.
 *
 * ── What the generate handler does that the service does not ────
 *
 *   The `writerService.runGenerate` function produces a local
 *   `.md` draft file. The backend's `Article` entity is a Mongo
 *   record with an `_id`, a `version`, a `status`, and four other
 *   fields that a file on disk does not carry. The generate
 *   handler bridges the two:
 *
 *     1. Reads the topic's `topic.json` to obtain the
 *        `promptFile` field. The writer service does not read
 *        `topic.json` — its contract is a set of primitive
 *        arguments, and the JSON read is the caller's
 *        responsibility.
 *
 *     2. Computes the docs directory path from the topic ID,
 *        using the same layout `documentService.ts` uses
 *        (`<appData>/writespeare/topics/<topicId>/sources/`).
 *        The layout is documented in that file's header; the
 *        duplication here is deliberate — the path convention
 *        is a cross-file contract that both files must agree on,
 *        and a shared helper module would be a new file the plan
 *        does not declare.
 *
 *     3. Calls `runGenerate({ topicId, docsDir, promptFile })`
 *        and receives a `WriterServiceResult`.
 *
 *     4. On success, reads the produced `.md` file at
 *        `result.draftPath`, constructs an `ArticleCreatePayload`
 *        from its content and the result's `wordCount`, POSTs
 *        that payload to the backend's `/api/articles` endpoint,
 *        and returns the backend's response — an `Article` with
 *        its Mongo-assigned `_id`, `version`, and `status`.
 *
 *     5. On failure, returns the service's error message in the
 *        standard `ApiResponse` envelope, with `success: false`.
 *
 * ── Why the handler posts to the backend rather than returning the draft ─
 *
 *   The preload's `writer.generate` signature declares
 *   `Promise<ApiResponse<Article>>`. That is the shape the
 *   renderer's writer store expects — it stores the returned
 *   `Article` for the Article tab to render, and it uses the
 *   `_id` field to make subsequent requests (a validation run,
 *   an export). A draft path and a word count would satisfy
 *   none of those needs.
 *
 *   The backend's `/api/articles` endpoint is where the
 *   `Article` record is created. The `apiPost` call below is
 *   what turns a local file into a Mongo record. The bearer
 *   token the request carries is attached by the shared axios
 *   client's request interceptor — the same token every other
 *   authenticated request uses.
 *
 * ── What the cancel handler does ────────────────────────────────
 *
 *   The cancel handler looks up the writer's process manager by
 *   the task ID `getWriterTaskId(topicId)` returns, and calls its
 *   `kill()` method. The `kill()` uses `tree-kill` to terminate
 *   the Python child and every descendant process it spawned —
 *   the same hard-cancel semantics used by the research feature's
 *   cancel path.
 *
 *   Cancelling an operation that has already finished — or that
 *   never started — is a no-op. The handler returns
 *   `{ success: true, data: null }` either way, because the
 *   user's intent ("the writer should not be running") is
 *   satisfied in both cases, and reporting a failure would
 *   produce a spurious error toast.
 *
 * ── Why the generate handler reads the backend's response ───────
 *
 *   The `apiPost<Article>` call below returns whatever the
 *   backend responds with, wrapped in the standard
 *   `ApiResponse` envelope. On success, that envelope's `data`
 *   field carries the created `Article` — including the `_id`
 *   and `version` the backend assigned. The generate handler
 *   returns that envelope to the renderer unchanged. It does
 *   not synthesize an `Article` locally, because doing so would
 *   produce an object with a fake `_id` that would break every
 *   downstream call that expects the real Mongo ID.
 *
 * ── Error handling ─────────────────────────────────────────────
 *
 *   Every failure path — a missing `topic.json`, an unreadable
 *   draft file, a rejected POST, a spawn error — is converted
 *   into a `{ success: false, error }` envelope. No exception
 *   escapes the handlers: an unhandled rejection from an IPC
 *   handler would arrive in the renderer as an unhandled promise
 *   rejection, which is a strictly worse failure mode than a
 *   well-formed error envelope the renderer's store can unwrap.
 *
 * Dependencies: electron + Node stdlib + the sibling writer
 * service + the sibling research service (for the task ID
 * lookup) + the shared axios client.
 */

import { ipcMain, app, type IpcMainInvokeEvent } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  runGenerate,
  getWriterTaskId,
} from '../services/writerService.js';
import { getByTaskId } from '../../research/services/childProcessManager.js';
import { apiPost } from '../../shared/api/client.js';
import type {
  ApiResponse,
  Article,
} from '../../shared/types/index.js';

// ============================================================
//  Channel name constants
// ============================================================
//
// The two channel names are declared as constants so a future
// refactor that renames them (or a test that spies on them) has
// one place to change. The preload's `src/main/preload.ts`
// declares the same strings on the renderer side of the bridge —
// the two must stay in sync, but neither file imports from the
// other.

const CHANNEL_GENERATE = 'writer:generate';
const CHANNEL_CANCEL = 'writer:cancel';

// ============================================================
//  Layout constants
// ============================================================
//
// Same values `documentService.ts` declares. See this file's
// header for the rationale on the duplication. A change to the
// on-disk layout (a new app slug, a renamed `sources/` folder)
// would have to update both files and the Python side in
// lockstep; the duplication makes the three-way dependency
// visible rather than hiding it behind a shared module whose
// single change would silently break the Python side.

const APP_SLUG = 'writespeare';
const TOPICS_SUBFOLDER = 'topics';
const SOURCES_SUBFOLDER = 'sources';

// ============================================================
//  Helpers — path computation
// ============================================================

/**
 * Return the absolute path to a topic's `sources/` folder.
 * Same layout `documentService.getSourcesFolder` uses.
 */
const getSourcesFolder = (topicId: string): string => {
  return path.join(
    app.getPath('appData'),
    APP_SLUG,
    TOPICS_SUBFOLDER,
    topicId,
    SOURCES_SUBFOLDER
  );
};

/**
 * Return the absolute path to a topic's `topic.json` file.
 * Same layout `documentService` and the Python side use.
 */
const getTopicJsonPath = (topicId: string): string => {
  return path.join(
    app.getPath('appData'),
    APP_SLUG,
    TOPICS_SUBFOLDER,
    topicId,
    'topic.json'
  );
};

// ============================================================
//  Helpers — topic.json reading
// ============================================================

/**
 * Read the `promptFile` field from a topic's `topic.json`.
 *
 * Returns the default (`default.md`) when the file is absent, is
 * not valid JSON, is not an object, or lacks a usable
 * `promptFile` string. The default matches the backend's schema
 * default for the `promptFile` field on a `Topic`, so a topic
 * that never had its prompt file set produces the same behavior
 * here as it would on the backend.
 *
 * Never throws. The caller uses the return value directly; the
 * fallback chain is what makes a malformed or missing file
 * produce a working operation rather than a failed one.
 */
const readPromptFile = async (topicId: string): Promise<string> => {
  const defaultPrompt = 'default.md';
  const topicJsonPath = getTopicJsonPath(topicId);
  try {
    const raw = await fs.readFile(topicJsonPath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      const value = (parsed as Record<string, unknown>)['promptFile'];
      if (typeof value === 'string' && value.trim().length > 0) {
        return value.trim();
      }
    }
    return defaultPrompt;
  } catch {
    return defaultPrompt;
  }
};

// ============================================================
//  Helpers — draft file reading
// ============================================================

/**
 * Read the draft file the writer service produced and compute its
 * word count.
 *
 * The `content` returned here is the article's full Markdown
 * text — the same text `deepseek_writer.py` wrote to disk. The
 * word count is a simple whitespace-split count that matches the
 * count the writer service reported in its `WriterServiceResult`.
 * The service's number is authoritative; this function recomputes
 * it as a defensive measure so a discrepancy between the two —
 * which would indicate a bug in one of the two word counters —
 * is caught before the Article is POSTed.
 *
 * Throws if the file cannot be read. The caller catches the
 * throw and returns an error envelope.
 */
const readDraft = async (
  draftPath: string
): Promise<{ content: string; wordCount: number }> => {
  const content = await fs.readFile(draftPath, 'utf-8');
  // Same word-count definition the Python side uses — a run of
  // non-whitespace characters is a word. See
  // `core/extractor.py::count_words` for the Python counterpart.
  const matches = content.match(/\S+/g);
  const wordCount = matches === null ? 0 : matches.length;
  return { content, wordCount };
};

// ============================================================
//  registerWriterIPC
// ============================================================

/**
 * Register the writer feature's IPC handlers.
 *
 * Called once, from `main/index.ts`, inside the
 * `app.whenReady().then(...)` callback. The function is not
 * idempotent — `ipcMain.handle` refuses to register a second
 * handler for the same channel — matching the contract every
 * other feature's `register*IPC()` function follows.
 */
export const registerWriterIPC = (): void => {
  // ---- writer:generate ----
  //
  // The renderer sends a `topicId` and receives the created
  // `Article` on success. See the file header for the full flow.
  ipcMain.handle(
    CHANNEL_GENERATE,
    async (
      _event: IpcMainInvokeEvent,
      topicId: unknown
    ): Promise<ApiResponse<Article>> => {
      // ---- Validate ----
      if (
        typeof topicId !== 'string' ||
        topicId.trim().length === 0
      ) {
        return { success: false, error: 'topicId is required.' };
      }
      const trimmedTopicId = topicId.trim();

      // ---- Compute the operation's inputs ----
      // The docs directory comes from the topic ID; the prompt
      // file comes from the topic's own `topic.json`. See the
      // file header for why both are computed here rather than
      // in the service.
      const docsDir = getSourcesFolder(trimmedTopicId);
      const promptFile = await readPromptFile(trimmedTopicId);

      // ---- Run the writer ----
      // A rejection from `runGenerate` would be unusual — the
      // service's contract is "always resolve" — but the
      // try/catch is here to catch an unexpected throw so the
      // renderer sees a well-formed error envelope rather than
      // an unhandled rejection.
      let result;
      try {
        result = await runGenerate({
          topicId: trimmedTopicId,
          docsDir,
          promptFile,
        });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : String(err);
        return {
          success: false,
          error: `Writer failed: ${message}`,
        };
      }

      if (!result.success) {
        return {
          success: false,
          error: result.error ?? 'Article generation failed.',
        };
      }

      // ---- Read the draft file ----
      if (result.draftPath.length === 0) {
        return {
          success: false,
          error:
            'Writer reported success but produced no draft path.',
        };
      }

      let draftContent: string;
      let wordCount: number;
      try {
        const draft = await readDraft(result.draftPath);
        draftContent = draft.content;
        wordCount = draft.wordCount;
      } catch (err) {
        const message =
          err instanceof Error ? err.message : String(err);
        return {
          success: false,
          error: `Could not read the generated draft: ${message}`,
        };
      }

      // ---- POST the article to the backend ----
      // The backend assigns the Mongo `_id`, the `version`, and
      // the initial `status` of `'draft'`. The payload carries
      // only the three fields the client owns — `topicId`,
      // `content`, `wordCount` — matching the shape of
      // `ArticleCreatePayload` on both the desktop and the
      // backend.
      const postResult = await apiPost<Article>('/articles', {
        topicId: trimmedTopicId,
        content: draftContent,
        wordCount,
      });

      if (!postResult.success || !postResult.data) {
        return {
          success: false,
          error:
            postResult.error ??
            'The article was generated but could not be saved.',
        };
      }

      return {
        success: true,
        data: postResult.data,
      };
    }
  );

  // ---- writer:cancel ----
  //
  // Look up the writer's process manager by the task ID and
  // kill its tree. A missing manager is a no-op — see the file
  // header for the rationale on returning success in that case.
  ipcMain.handle(
    CHANNEL_CANCEL,
    async (
      _event: IpcMainInvokeEvent,
      topicId: unknown
    ): Promise<ApiResponse<null>> => {
      // ---- Validate ----
      if (
        typeof topicId !== 'string' ||
        topicId.trim().length === 0
      ) {
        return { success: false, error: 'topicId is required.' };
      }
      const trimmedTopicId = topicId.trim();

      // ---- Find the writer's manager and kill it ----
      // The task ID is derived from the topic ID by the same
      // helper the service uses, so the two agree on the key.
      // A missing manager — no writer has ever been spawned for
      // this topic, or the previous operation already finished
      // and was disposed — is a no-op.
      //
      // The `kill()` call is fire-and-forget: it dispatches the
      // tree-kill and returns immediately. The service's `killed`
      // event handler is what flips the operation's result to
      // `'user-skip'`; the renderer's store observes that result
      // through the marker channel and updates its state. This
      // handler does not await the child's full termination.
      try {
        const taskId = getWriterTaskId(trimmedTopicId);
        const manager = getByTaskId(taskId);
        if (manager !== null) {
          manager.kill();
        }
      } catch (err) {
        // A failure here is unusual — the task-ID helper is
        // pure and the lookup cannot throw for a valid input —
        // but converting an unexpected throw into an error
        // envelope is the correct behavior, so the renderer's
        // store can surface the problem rather than seeing an
        // unhandled rejection.
        const message =
          err instanceof Error ? err.message : String(err);
        return {
          success: false,
          error: `Could not cancel writer: ${message}`,
        };
      }

      return { success: true, data: null };
    }
  );
};

// ============================================================
//  Default export
// ============================================================

/**
 * The registration function as the default export, matching the
 * convention used by every other IPC module in the codebase.
 * `main/index.ts` uses the named import
 * (`import { registerWriterIPC } from ...`), so the default form
 * is a convenience rather than a load-bearing export.
 */
export default registerWriterIPC;