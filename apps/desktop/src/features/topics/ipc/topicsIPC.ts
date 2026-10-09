/**
 * Topics feature — IPC handler for the main process.
 *
 * This module is the bridge between the renderer's
 * `window.electronAPI.topics.*` calls and the main process's
 * topics API layer (`topicsApi.ts`, the previous file in this
 * session). Its `registerTopicsIPC()` function is called once,
 * at app-ready time, by `src/main/index.ts` — the same place
 * that calls `registerAuthIPC()` (see `auth/authIPC.ts`) and
 * that will eventually call each feature's `register*IPC()` in
 * session order.
 *
 * The five channels this file registers:
 *
 *   topics:list    — reads the user's topics, optionally
 *                    filtered by pipeline status. Forwards to
 *                    `listTopics` from the API layer.
 *
 *   topics:create  — creates a new topic from a
 *                    `TopicCreatePayload`. Forwards to
 *                    `createTopic`.
 *
 *   topics:get     — reads a single topic by id. Forwards to
 *                    `getTopic`.
 *
 *   topics:update  — applies a partial update to a topic.
 *                    Forwards to `updateTopic`.
 *
 *   topics:delete  — deletes a topic. Forwards to
 *                    `deleteTopic`.
 *
 * The channels correspond one-to-one with the five functions
 * exported by the API layer, and with the five methods on the
 * renderer side's `window.electronAPI.topics.*` object. There is
 * no channel here that does not correspond to a real backend
 * operation, and no backend operation that does not have a
 * channel — the three levels (renderer API, IPC channels,
 * main-process API) share the same shape by construction.
 *
 * Why this file has almost no logic:
 *
 *   Each handler is a one-line forward of its arguments to the
 *   corresponding function in the API layer, and a one-line
 *   return of the result. The API layer already converts any
 *   failure — an axios error, a network timeout, a malformed
 *   response — into the standard `ApiResponse<T>` envelope, so
 *   the handler does not need a try/catch of its own. The
 *   handler's job is only to translate the IPC call boundary
 *   into a function call, and back.
 *
 *   This is the same shape as `authIPC.ts`'s three handlers,
 *   and it is deliberate. A feature's IPC handler is a
 *   pass-through by design: the interesting work belongs to the
 *   service layer (which does the HTTP), and the handler should
 *   not duplicate or second-guess it. If a future session finds
 *   itself adding logic here — validation, transformation,
 *   caching — the correct move is almost always to push that
 *   logic down into the service, where it is testable without
 *   an IPC harness.
 *
 * What this file does NOT do:
 *
 *   - It does not touch the encrypted store. The auth store
 *     (see `main/store.ts`) is owned by the auth feature.
 *     Topics have no persistent main-process state.
 *
 *   - It does not set the bearer token on the shared axios
 *     client. That lifecycle belongs to the auth feature's
 *     `authIPC.ts` and is performed once at startup. Every
 *     other feature's IPC handler inherits the token from the
 *     shared client without touching it.
 *
 *   - It does not validate the arguments. The IPC channel is
 *     only reachable from the renderer, the renderer's calls
 *     are typed against the shared types, and the backend's own
 *     schema validation is the authoritative check. Adding
 *     a validation layer at the IPC boundary would duplicate
 *     what the backend already does and would need to be kept
 *     in sync with it — a maintenance cost with no benefit for
 *     the current single-client architecture.
 *
 *   - It does not log. Logging belongs one level down, in the
 *     service layer, where a request's outcome and its timing
 *     are both available without adding noise to every IPC
 *     call. The topics API layer does not log today, but if a
 *     future session adds request logging it belongs there,
 *     not here.
 */

import { ipcMain, type IpcMainInvokeEvent } from 'electron';

import {
  listTopics,
  createTopic,
  getTopic,
  updateTopic,
  deleteTopic,
} from '../services/topicsApi.js';

import type {
  ApiResponse,
  Topic,
  TopicCreatePayload,
  TopicUpdatePayload,
  TopicStatus,
} from '../../shared/types/index.js';

// ============================================================
//  Channel name constants
// ============================================================
//
//  The five channel names are declared as constants so a future
//  refactor that renames them (or a test that spies on them) has
//  one place to change. The preload's `src/main/preload.ts`
//  declares the same strings on the renderer side of the bridge
//  — the two must stay in sync, but neither file imports from
//  the other, because the preload is a renderer-context module
//  and this file is a main-context module.

const CHANNEL_LIST = 'topics:list';
const CHANNEL_CREATE = 'topics:create';
const CHANNEL_GET = 'topics:get';
const CHANNEL_UPDATE = 'topics:update';
const CHANNEL_DELETE = 'topics:delete';

// ============================================================
//  registerTopicsIPC
// ============================================================

/**
 * Register the topics feature's IPC handlers.
 *
 * Called once, from `main/index.ts`, inside the
 * `app.whenReady().then(...)` callback. By the time this runs,
 * the shared axios client exists — it was initialized when its
 * own module was imported at the top of the main process's
 * module graph — and the auth feature's `registerAuthIPC()` has
 * already run (or will run in the same sequence), so the shared
 * client has a bearer token restored from the encrypted store.
 *
 * The function is not idempotent: calling it twice will produce
 * Electron errors on the second call, because `ipcMain.handle`
 * refuses to register a second handler for the same channel.
 * The single-call contract is the same one every other
 * feature's `register*IPC()` function follows.
 */
export const registerTopicsIPC = (): void => {
  // ---- topics:list ----
  //
  // Read the user's topics, optionally filtered by status. The
  // optional filter is a `TopicStatus | undefined`; passing
  // `undefined` produces the unfiltered list.
  ipcMain.handle(
    CHANNEL_LIST,
    async (
      _event: IpcMainInvokeEvent,
      status?: TopicStatus
    ): Promise<ApiResponse<Topic[]>> => {
      return listTopics(status);
    }
  );

  // ---- topics:create ----
  //
  // Create a new topic. The payload is the user's chosen values
  // from the New Topic modal; the backend's service derives the
  // owner from the authenticated session.
  ipcMain.handle(
    CHANNEL_CREATE,
    async (
      _event: IpcMainInvokeEvent,
      payload: TopicCreatePayload
    ): Promise<ApiResponse<Topic>> => {
      return createTopic(payload);
    }
  );

  // ---- topics:get ----
  //
  // Read a single topic by id. A topic that does not exist or
  // that belongs to a different user is treated identically by
  // the backend (both return 404), so a client cannot distinguish
  // "no such topic" from "not your topic".
  ipcMain.handle(
    CHANNEL_GET,
    async (
      _event: IpcMainInvokeEvent,
      topicId: string
    ): Promise<ApiResponse<Topic>> => {
      return getTopic(topicId);
    }
  );

  // ---- topics:update ----
  //
  // Apply a partial update. Every field on `TopicUpdatePayload`
  // is optional; the backend's service merges the patch onto the
  // existing document.
  ipcMain.handle(
    CHANNEL_UPDATE,
    async (
      _event: IpcMainInvokeEvent,
      topicId: string,
      patch: TopicUpdatePayload
    ): Promise<ApiResponse<Topic>> => {
      return updateTopic(topicId, patch);
    }
  );

  // ---- topics:delete ----
  //
  // Delete a topic. The backend returns the deleted document so
  // the renderer can render an undo affordance.
  ipcMain.handle(
    CHANNEL_DELETE,
    async (
      _event: IpcMainInvokeEvent,
      topicId: string
    ): Promise<ApiResponse<Topic>> => {
      return deleteTopic(topicId);
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
 * (`import { registerTopicsIPC } from ...`), so the default form
 * is a convenience rather than a load-bearing export.
 */
export default registerTopicsIPC;