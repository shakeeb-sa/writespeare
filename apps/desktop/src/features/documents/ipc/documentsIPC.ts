/**
 * documentsIPC — IPC handlers for the documents feature.
 *
 * Registers the three channels the renderer's
 * `window.electronAPI.documents.*` methods invoke:
 *
 *   documents:list    — read the list of doc files attached to a
 *                       topic. Delegates to `documentService.listDocuments`.
 *
 *   documents:read    — read a single doc file's content.
 *                       Delegates to `documentService.readDocument`.
 *
 *   documents:delete  — remove a single doc file from disk.
 *                       Delegates to `documentService.deleteDocument`.
 *
 * The three channels correspond one-to-one with the three methods
 * the preload declares on `window.electronAPI.documents`, and with
 * the three functions this feature's service exports. The three
 * levels (preload API, IPC channels, service functions) share the
 * same shape by construction.
 *
 * ── Each handler's structure ──────────────────────────────────
 *
 *   Every handler follows the same four-step shape:
 *
 *     1. Validate the arguments the renderer sent. A malformed
 *        argument — a non-string topicId, an empty path, a
 *        missing value — is rejected with a specific error
 *        message before any service call runs.
 *
 *     2. Call the service function inside a try/catch. The
 *        service throws on any failure (a file that cannot be
 *        read, a path that fails the safety check, a file that
 *        cannot be deleted), and the catch converts the thrown
 *        error into a well-formed error envelope.
 *
 *     3. Return the result in the shared `ApiResponse<T>`
 *        envelope — `{ success: true, data }` on success,
 *        `{ success: false, error }` on failure.
 *
 *     4. Never let an exception escape the handler. A rejection
 *        from an IPC handler would arrive in the renderer as an
 *        unhandled promise rejection, which is a strictly worse
 *        failure mode than a well-formed error envelope — the
 *        renderer's stores are already set up to unwrap
 *        envelopes, and an exception would bypass them.
 *
 * ── Why the read handler wraps its result in an object ────────
 *
 *   The preload's `documents.read` signature returns
 *   `ApiResponse<{ content: string }>` — an envelope whose `data`
 *   field is an object with a single `content` string. The
 *   service's `readDocument` function returns a plain string.
 *
 *   The wrapping happens here, at the IPC boundary. The reason
 *   the preload's shape is an object rather than a plain string
 *   is that the shared `ApiResponse<T>` type's `data` field is
 *   typed as `T | undefined`. A caller that reads
 *   `result.data` on a successful string response would get
 *   `string | undefined`, forcing every consumer to write a
 *   null-check on the empty-string case, which is not the same
 *   as "no data". Wrapping the string in an object makes the
 *   envelope's `data` field either `undefined` (on failure) or
 *   `{ content: string }` (on success), and the consumer can
 *   check for the presence of the object rather than the length
 *   of the string.
 *
 *   The consequence is that the wrapper is a five-line function
 *   whose only job is to bridge the service's `Promise<string>`
 *   return type to the preload's `Promise<ApiResponse<{ content }>>`
 *   shape. The bridging happens in exactly one place, and both
 *   sides of the bridge stay simple.
 *
 * ── Why this file does not touch the backend ──────────────────
 *
 *   The documents feature's service (`documentService.ts`) reads
 *   the `.md` files from the user's disk and does not call the
 *   backend's `/api/documents` endpoints. The IPC handlers
 *   therefore have nothing to forward to the backend — they
 *   delegate to the local-file service and return its result.
 *
 *   See `documentService.ts`'s header for the rationale on the
 *   local-file-vs-backend choice. The consequence for this file
 *   is that the handlers are simpler than the ones in the auth
 *   or topics features — no HTTP client is involved, no bearer
 *   token is attached, and no network errors are possible. The
 *   only failure modes are the file-system ones the service
 *   raises.
 *
 * ── What this file does NOT do ────────────────────────────────
 *
 *   - It does not validate that a `filepath` argument is a doc
 *     file the app itself produced. That check lives in the
 *     service's `isPathSafe` helper, which rejects any path
 *     outside the app's data directory. The IPC handler's
 *     argument validation is limited to the type and shape
 *     checks that catch a malformed call before any service
 *     logic runs.
 *
 *   - It does not emit markers or broadcast events. The
 *     documents feature is a request-response layer — the
 *     renderer asks for data and receives it. There is no
 *     progress to stream and no event to push.
 *
 *   - It does not persist anything. Deleting a doc file removes
 *     it from disk; deleting the corresponding backend Document
 *     record (when the two stores are eventually synced) is a
 *     future session's concern, not this file's.
 *
 * Dependencies: electron + the sibling documentService.
 */

import { ipcMain, type IpcMainInvokeEvent } from 'electron';

import {
  listDocuments,
  readDocument,
  deleteDocument,
} from '../services/documentService.js';

import type {
  ApiResponse,
  Document,
} from '../../shared/types/index.js';

// ============================================================
//  Channel name constants
// ============================================================
//
// The three channel names are declared as constants so a future
// refactor that renames them (or a test that spies on them) has
// one place to change. The preload's `src/main/preload.ts`
// declares the same strings on the renderer side of the bridge —
// the two must stay in sync, but neither file imports from the
// other, because the preload is a renderer-context module and
// this file is a main-context module.

const CHANNEL_LIST = 'documents:list';
const CHANNEL_READ = 'documents:read';
const CHANNEL_DELETE = 'documents:delete';

// ============================================================
//  registerDocumentsIPC
// ============================================================

/**
 * Register the documents feature's IPC handlers.
 *
 * Called once, from `main/index.ts`, inside the
 * `app.whenReady().then(...)` callback — the same place the auth
 * and topics features' registration functions are called. The
 * function is not idempotent: `ipcMain.handle` refuses to
 * register a second handler for the same channel, and a second
 * call would therefore produce Electron errors. The single-call
 * contract is the same one every other feature's
 * `register*IPC()` function follows.
 */
export const registerDocumentsIPC = (): void => {
  // ---- documents:list ----
  //
  // The renderer sends a `topicId` and receives the list of doc
  // files attached to that topic, synthesized into `Document`
  // objects by the service.
  //
  // An empty response is a legitimate case — a topic whose
  // extraction has not run yet has no doc files, and the service
  // returns an empty array rather than an error. The renderer's
  // document list handles the empty state; the IPC handler does
  // not need to distinguish "no docs yet" from "topic has an
  // empty doc list", because from the caller's perspective the
  // two are the same.
  ipcMain.handle(
    CHANNEL_LIST,
    async (
      _event: IpcMainInvokeEvent,
      topicId: unknown
    ): Promise<ApiResponse<Document[]>> => {
      // ---- Validate ----
      if (typeof topicId !== 'string' || topicId.trim().length === 0) {
        return { success: false, error: 'topicId is required.' };
      }

      // ---- Delegate ----
      try {
        const documents = await listDocuments(topicId.trim());
        return { success: true, data: documents };
      } catch (err) {
        const message =
          err instanceof Error ? err.message : String(err);
        return {
          success: false,
          error: `Could not list documents: ${message}`,
        };
      }
    }
  );

  // ---- documents:read ----
  //
  // The renderer sends a `filepath` and receives the file's
  // content, wrapped in an object with a `content` field. See the
  // file header for the rationale on the wrapping.
  //
  // The `filepath` is expected to be a value the renderer
  // previously received from a `documents:list` call — the
  // service's list returns objects whose `_id` is the file's
  // absolute path. The service validates the path against the
  // app's data root before reading; this handler does not
  // duplicate that check, because the check has a security
  // purpose that belongs at the service boundary.
  ipcMain.handle(
    CHANNEL_READ,
    async (
      _event: IpcMainInvokeEvent,
      filepath: unknown
    ): Promise<ApiResponse<{ content: string }>> => {
      // ---- Validate ----
      if (typeof filepath !== 'string' || filepath.length === 0) {
        return { success: false, error: 'filepath is required.' };
      }

      // ---- Delegate ----
      try {
        const content = await readDocument(filepath);
        return { success: true, data: { content } };
      } catch (err) {
        const message =
          err instanceof Error ? err.message : String(err);
        return {
          success: false,
          error: `Could not read document: ${message}`,
        };
      }
    }
  );

  // ---- documents:delete ----
  //
  // The renderer sends a `filepath` and receives a `null` data
  // payload on success. The file is removed from disk; the
  // backend's Document record (when it exists) is not touched —
  // see the file header for the rationale.
  //
  // The service throws when the file cannot be removed — a
  // missing file, a permissions error, a path outside the app
  // data directory. Each case is converted to a well-formed
  // error envelope here.
  ipcMain.handle(
    CHANNEL_DELETE,
    async (
      _event: IpcMainInvokeEvent,
      filepath: unknown
    ): Promise<ApiResponse<null>> => {
      // ---- Validate ----
      if (typeof filepath !== 'string' || filepath.length === 0) {
        return { success: false, error: 'filepath is required.' };
      }

      // ---- Delegate ----
      try {
        await deleteDocument(filepath);
        return { success: true, data: null };
      } catch (err) {
        const message =
          err instanceof Error ? err.message : String(err);
        return {
          success: false,
          error: `Could not delete document: ${message}`,
        };
      }
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
 * (`import { registerDocumentsIPC } from ...`), so the default
 * form is a convenience rather than a load-bearing export.
 */
export default registerDocumentsIPC;