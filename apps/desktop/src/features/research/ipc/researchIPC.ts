/**
 * researchIPC — IPC handlers for the research feature (main process).
 *
 * Registers the three channels the renderer's
 * `window.electronAPI.research.*` methods invoke:
 *
 *   research:search   — run a search operation on a topic.
 *                       Delegates to `searchService.runSearch`.
 *   research:extract  — fetch and extract a batch of URLs.
 *                       Delegates to `extractionService.runExtract`.
 *   research:cancel   — stop the currently-running research
 *                       operation for a topic.
 *
 * Each handler:
 *
 *   1. Validates the arguments the renderer sent. A malformed
 *      argument — a non-string topicId, an empty URL array, a
 *      missing title — is rejected with a specific error message
 *      before any service is called. The service would also
 *      reject these (each service validates its own inputs), but
 *      the handler's check produces a clearer error and avoids
 *      the overhead of a service call that is guaranteed to
 *      fail.
 *
 *   2. Delegates to the service. The service is where the
 *      interesting work happens — spawning Python, watching
 *      markers, waiting for a terminal result. The handler does
 *      not duplicate any of that logic.
 *
 *   3. Returns the result in the shared `ApiResponse<T>` envelope.
 *      `{ success: true, data }` on success, `{ success: false,
 *      error }` on failure. The renderer's preload passes this
 *      envelope through unchanged, so the renderer's service
 *      layer sees the same shape it would see from the backend's
 *      HTTP API.
 *
 * Why the handler's return value does not carry the full candidate
 * list:
 *
 *   The search service returns a `SearchServiceResult` whose
 *   `candidates` field carries the full list of `SearchCandidate`
 *   objects (url, title, snippet, platform). But the renderer
 *   receives that list through a DIFFERENT path — the
 *   `research:marker` event stream that the search service
 *   broadcasts as the Python script emits `SEARCH_RESULT`. The
 *   renderer's `researchStore` listens on that channel and
 *   populates the candidate list from the marker payload.
 *
 *   The handler's IPC return value is therefore a SUMMARY, not
 *   the data itself: it carries the list of URLs as a convenience
 *   for callers that only want the URLs (a test, a diagnostic
 *   tool), and it carries the terminal success/failure status. If
 *   the marker channel and the IPC return value disagree — a race
 *   where the marker was not yet delivered when the IPC resolved
 *   — the marker channel's data wins, because the marker channel
 *   is the streaming source of truth and the IPC return value is
 *   a summary.
 *
 * The cancel path:
 *
 *   `research:cancel` looks up the process manager for the
 *   topic's search operation and calls its `kill()`, which
 *   tree-kills the Python subprocess (and any child processes it
 *   spawned). This is a HARD cancel — the graceful path, which
 *   writes a `STOP` command to the child's stdin, is available
 *   via `manager.writeStdin('STOP\n')` and is used internally by
 *   the automation store's Stop button. The IPC cancel is the
 *   escape hatch for the case where the graceful path is not
 *   working (the script is hung on a network call) or where the
 *   user wants the operation to end immediately.
 *
 *   The handler returns `{ success: true, data: null }` whether
 *   or not a manager was found. Cancelling an operation that has
 *   already finished is not an error — the user's intent ("the
 *   operation should not be running") is satisfied either way.
 *
 * The extractionService forward reference:
 *
 *   The `research:extract` handler imports `runExtract` from
 *   `../services/extractionService.js`. That file is created in
 *   Session 12, step 91 — a later session than this one. Until it
 *   exists, the import at the top of this file produces a single
 *   `TS2307` error. That is EXPECTED and documented in the
 *   TypeScript Integrity Check below.
 *
 *   The alternative — writing the handler with a stub body that
 *   throws "not yet implemented" — is forbidden by the strict
 *   protocol's "no stubs" rule. The handler is written in full,
 *   referencing the module that will exist; the forward-reference
 *   pattern is the same one used throughout this codebase.
 *
 * What this file does NOT do:
 *
 *   - It does not parse markers. Marker parsing and forwarding is
 *     the search service's job (and eventually the extraction
 *     service's job). The IPC handler sees only the terminal
 *     result.
 *
 *   - It does not manage Chrome. Chrome lifecycle is owned by
 *     `chromeLauncher.ts`, which the services call. The IPC
 *     handler has no visibility into Chrome.
 *
 *   - It does not touch the encrypted store. Research operations
 *     are stateless from the main process's perspective; any
 *     persistence happens through the backend's HTTP API, which
 *     the services call directly when they need to.
 *
 *   - It does not validate the schema of the service's result.
 *     The service is written to always resolve with a
 *     well-formed `SearchServiceResult` or `ExtractionServiceResult`;
 *     the handler trusts that contract and forwards the shape.
 */

import { ipcMain, type IpcMainInvokeEvent } from 'electron';

import {
  runSearch,
  getSearchTaskId,
} from '../services/searchService.js';
import { runExtract } from '../services/extractionService.js';
import { getByTaskId } from '../services/childProcessManager.js';
import type { ApiResponse } from '../../shared/types/index.js';

// =============================================================================
//  Channel name constants
// =============================================================================
//
//  The three channel names are declared as constants so a future
//  refactor that renames them (or a test that spies on them) has
//  one place to change. The preload's `src/main/preload.ts`
//  declares the same strings on the renderer side of the bridge —
//  the two must stay in sync, but neither file imports from the
//  other, because the preload is a renderer-context module and this
//  file is a main-context module.

const CHANNEL_SEARCH = 'research:search';
const CHANNEL_EXTRACT = 'research:extract';
const CHANNEL_CANCEL = 'research:cancel';

// ============================================================
//  Constants
// ============================================================

/**
 * The default number of candidates a search collects when the
 * renderer does not specify one.
 *
 * The renderer's `research.search(topicId, title, keywords?)`
 * signature (defined in `preload.ts`) does not carry a maxResults
 * parameter, so this handler supplies the default. Twenty
 * candidates gives the user a meaningful choice at the selection
 * step without making the initial search take an excessive amount
 * of time — Google's SERP yields ten per page, so twenty is two
 * pages.
 *
 * A future session that wants the search's max to depend on the
 * topic's preset (Quick=5, Balanced=10, Deep=20, per the user
 * journey document) would either extend the preload's signature
 * to pass the value explicitly, or read the topic from the
 * backend inside this handler before calling the service. Neither
 * change is in scope for the current session.
 */
const DEFAULT_MAX_RESULTS = 20;

// ============================================================
//  research:search
// ============================================================

/**
 * Run a search operation on a topic.
 *
 * Arguments sent by the renderer:
 *
 *   topicId   — the topic's ID. Required, non-empty string.
 *   title     — the search query, normally the topic's title.
 *               Required, non-empty string.
 *   keywords  — the user's keywords. Optional; an empty or
 *               missing list means the search runs on the title
 *               alone.
 *
 * Returns:
 *
 *   `{ success: true, data: { candidates: string[] } }` when the
 *   search produced at least one candidate. The `candidates` array
 *   is the list of URLs — the full candidate objects (title,
 *   snippet, platform) arrive separately through the marker
 *   stream's `SEARCH_RESULT` payload.
 *
 *   `{ success: false, error: string }` on any failure. The error
 *   string is user-facing — the renderer's research store displays
 *   it in the SearchProgress panel.
 */
const handleSearch = async (
  _event: IpcMainInvokeEvent,
  topicId: unknown,
  title: unknown,
  keywords: unknown
): Promise<ApiResponse<{ candidates: string[] }>> => {
  // ---- Validate ----
  if (typeof topicId !== 'string' || topicId.trim().length === 0) {
    return { success: false, error: 'topicId is required.' };
  }
  if (typeof title !== 'string' || title.trim().length === 0) {
    return { success: false, error: 'title is required.' };
  }

  // The keywords argument is optional and may arrive as
  // `undefined` (the renderer omits it) or as an array of strings.
  // Any non-array, non-undefined value is a malformed call and is
  // rejected rather than coerced.
  let normalizedKeywords: string[] = [];
  if (keywords !== undefined) {
    if (!Array.isArray(keywords)) {
      return { success: false, error: 'keywords must be an array.' };
    }
    for (const k of keywords) {
      if (typeof k !== 'string') {
        return {
          success: false,
          error: 'keywords must contain only strings.',
        };
      }
      const trimmed = k.trim();
      if (trimmed.length > 0) {
        normalizedKeywords.push(trimmed);
      }
    }
  }

  // ---- Delegate ----
  const result = await runSearch({
    query: title.trim(),
    keywords: normalizedKeywords,
    maxResults: DEFAULT_MAX_RESULTS,
    topicId: topicId.trim(),
  });

  // ---- Envelope ----
  if (result.kind === 'success') {
    return {
      success: true,
      data: {
        candidates: result.candidates.map((c) => c.url),
      },
    };
  }

  return {
    success: false,
    error: result.error ?? 'Search failed.',
  };
};

// ============================================================
//  research:extract
// ============================================================

/**
 * Fetch and extract a batch of URLs into doc files.
 *
 * Arguments sent by the renderer:
 *
 *   topicId  — the topic's ID. Required, non-empty string.
 *   urls     — the URLs the user selected for extraction.
 *               Required, non-empty array of non-empty strings.
 *
 * Returns:
 *
 *   `{ success: true, data: { savedCount: number } }` when the
 *   extraction completed. `savedCount` is the number of doc files
 *   successfully written; it may be less than `urls.length` if
 *   some pages failed, and the renderer's document list reflects
 *   the actual set of saved files (delivered via the marker
 *   stream).
 *
 *   `{ success: false, error: string }` on any failure.
 *
 * Forward reference: `runExtract` is imported from
 * `../services/extractionService.js`, which is created in
 * Session 12, step 91. Until that file exists, the import at the
 * top of this module produces a single `TS2307`. See the file
 * header for why the handler is written in full rather than
 * stubbed.
 */
const handleExtract = async (
  _event: IpcMainInvokeEvent,
  topicId: unknown,
  urls: unknown
): Promise<ApiResponse<{ savedCount: number }>> => {
  // ---- Validate ----
  if (typeof topicId !== 'string' || topicId.trim().length === 0) {
    return { success: false, error: 'topicId is required.' };
  }
  if (!Array.isArray(urls) || urls.length === 0) {
    return {
      success: false,
      error: 'urls must be a non-empty array.',
    };
  }
  const normalizedUrls: string[] = [];
  for (const u of urls) {
    if (typeof u !== 'string' || u.trim().length === 0) {
      return {
        success: false,
        error: 'urls must contain only non-empty strings.',
      };
    }
    normalizedUrls.push(u.trim());
  }

  // ---- Delegate ----
  const result = await runExtract({
    topicId: topicId.trim(),
    urls: normalizedUrls,
  });

  // ---- Envelope ----
  if (result.success) {
    return {
      success: true,
      data: { savedCount: result.savedCount },
    };
  }

  return {
    success: false,
    error: result.error ?? 'Extraction failed.',
  };
};

// ============================================================
//  research:cancel
// ============================================================

/**
 * Cancel the currently-running research operation for a topic.
 *
 * The cancel is a HARD kill — the process manager's `kill()`
 * method, which uses `tree-kill` to terminate the Python
 * subprocess and every child it spawned. The graceful path (a
 * `STOP` command written to the child's stdin, which the Python
 * script's checkpoint detects and acts on at its next safe point)
 * is available via the manager's `writeStdin` method; a caller
 * that wants the graceful behaviour uses that method directly
 * (it is what the automation store's Stop button does). The IPC
 * cancel is the escape hatch for the cases where the graceful
 * path does not apply — a hung script, an unresponsive network
 * call, or a user who wants the operation to end immediately.
 *
 * Arguments sent by the renderer:
 *
 *   topicId  — the topic's ID. Required, non-empty string.
 *
 * Returns:
 *
 *   Always `{ success: true, data: null }`. Cancelling an
 *   operation that has already finished — or that never started —
 *   is not an error; the user's intent ("this operation should
 *   not be running") is satisfied either way. Reporting a
 *   failure because there was nothing to cancel would produce a
 *   spurious error toast on the renderer.
 */
const handleCancel = async (
  _event: IpcMainInvokeEvent,
  topicId: unknown
): Promise<ApiResponse<null>> => {
  // ---- Validate ----
  if (typeof topicId !== 'string' || topicId.trim().length === 0) {
    return { success: false, error: 'topicId is required.' };
  }

  // ---- Look up the manager and kill ----
  // The task ID is derived from the topic ID by the same helper
  // the search service uses, so the two agree on the key. A
  // missing manager (no operation has ever started for this topic,
  // or the previous one finished and was disposed) is a no-op.
  const taskId = getSearchTaskId(topicId.trim());
  const manager = getByTaskId(taskId);
  if (manager !== null) {
    manager.kill();
  }

  return { success: true, data: null };
};

// ============================================================
//  registerResearchIPC
// ============================================================

/**
 * Register the research feature's IPC handlers.
 *
 * Called once, from `main/index.ts`, inside the
 * `app.whenReady().then(...)` callback — the same place the auth
 * and topics features' registration functions are called. The
 * function is not idempotent: `ipcMain.handle` refuses to register
 * a second handler for the same channel, and a second call would
 * therefore produce Electron errors. The single-call contract is
 * the same one every other feature's `register*IPC()` function
 * follows.
 */
export const registerResearchIPC = (): void => {
  ipcMain.handle(CHANNEL_SEARCH, handleSearch);
  ipcMain.handle(CHANNEL_EXTRACT, handleExtract);
  ipcMain.handle(CHANNEL_CANCEL, handleCancel);
};

// ============================================================
//  Default export
// ============================================================

/**
 * The registration function as the default export, matching the
 * convention used by every other IPC module in the codebase.
 * `main/index.ts` uses the named import
 * (`import { registerResearchIPC } from ...`), so the default form
 * is a convenience rather than a load-bearing export.
 */
export default registerResearchIPC;