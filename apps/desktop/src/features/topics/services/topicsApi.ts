/**
 * Topics feature — backend API layer.
 *
 * This module declares the five backend operations the topics
 * feature performs, as small, focused functions that each return
 * the shared `ApiResponse<T>` envelope. It is the direct
 * counterpart to the backend's `topicController.ts` (File 20) —
 * every function here maps one-to-one to one of that controller's
 * five handlers, and to one of the five `topics:*` IPC channels
 * that will be registered by the sibling file `ipc/topicsIPC.ts`
 * (item #55 in Session 7).
 *
 * The five operations:
 *
 *   listTopics     — GET    /api/topics, with an optional
 *                    `?status=` filter. Returns `Topic[]`.
 *
 *   createTopic    — POST   /api/topics, with a
 *                    `TopicCreatePayload` body. Returns the
 *                    persisted `Topic`.
 *
 *   getTopic       — GET    /api/topics/:id. Returns one `Topic`
 *                    or a 404-shaped error envelope.
 *
 *   updateTopic    — PATCH  /api/topics/:id, with a
 *                    `TopicUpdatePayload` body. Returns the
 *                    updated `Topic`.
 *
 *   deleteTopic    — DELETE /api/topics/:id. Returns the deleted
 *                    `Topic`.
 *
 * This is a MAIN-PROCESS module. Like `authApi.ts`, it uses the
 * shared axios client that runs in the main process. The
 * renderer never imports this file directly — it reaches these
 * operations through `window.electronAPI.topics.*`, which is
 * wired by the preload to the IPC handlers registered by
 * `ipc/topicsIPC.ts`. The channel names the sibling file will
 * use (`topics:list`, `topics:create`, `topics:get`,
 * `topics:update`, `topics:delete`) correspond one-to-one with
 * the five functions here.
 *
 * No token handling:
 *
 *   Unlike `authApi.ts`, this module does not call
 *   `setAuthToken`. The bearer token is installed once at
 *   startup (restored from the encrypted store by
 *   `registerAuthIPC()` in `authIPC.ts`) and updated only on
 *   login and logout. Every other main-process API module —
 *   topics, documents, articles, reports, settings, admin —
 *   inherits the token from the shared axios client without
 *   touching it. Adding a token-set call here would be
 *   redundant and, more importantly, would imply that this
 *   module owns part of the token's lifecycle. It does not.
 *   The token belongs to the auth feature; the axios client
 *   holds it; every other module uses it implicitly through
 *   the client's request interceptor.
 *
 * The status filter and URL construction:
 *
 *   The backend's `GET /api/topics` endpoint accepts an optional
 *   `?status=` query parameter whose value is one of the eight
 *   `TopicStatus` literals. When `listTopics` is called with a
 *   status, this module appends the query string to the URL;
 *   when called without, it uses the bare path.
 *
 *   The status value is encoded with `encodeURIComponent` even
 *   though every legal value is already URL-safe. The encoding
 *   is defensive: if a future change ever added a status value
 *   with a character that needed escaping, the encoding here
 *   would handle it without a second look. The cost is a few
 *   hundred nanoseconds per call, which is nothing compared to
 *   the network round-trip.
 *
 * What this module does NOT do:
 *
 *   - It does not validate the `TopicStatus` value passed to
 *     `listTopics`. Every legal value comes from the shared
 *     types module's `TopicStatus` union, and TypeScript
 *     prevents a caller from passing an out-of-union string. If
 *     a caller in a future session casts past that safety, the
 *     backend's own validation would catch the bad value and
 *     return a 400, which the shared client converts to an
 *     error envelope. The validation is the backend's job, and
 *     this module trusts the type system on the client side.
 *
 *   - It does not touch the renderer's topic store. The store is
 *     updated by the renderer-side code — the topic IPC handler
 *     sends the API result back through the preload, and the
 *     renderer's `topicsApi.ts` consumer (or the hook that
 *     wraps it) writes the result to the store. This module is
 *     a pure data-fetching layer.
 *
 *   - It does not log or audit any operation. Logging belongs in
 *     the IPC handler layer, where a request's origin and the
 *     user's identity are both known. This module sees only the
 *     arguments it receives.
 */

import {
  apiGet,
  apiPost,
  apiPatch,
  apiDelete,
} from '../../shared/api/client.js';

import type {
  ApiResponse,
  Topic,
  TopicCreatePayload,
  TopicUpdatePayload,
  TopicStatus,
} from '../../shared/types/index.js';

// ============================================================
//  URL prefix
// ============================================================

/**
 * The base path for every topics endpoint. Declared as a constant
 * so a future rename of the route prefix (unlikely, but possible
 * if the backend ever reorganized its paths) is a one-line change
 * with no risk of a partial edit leaving one function pointing at
 * the old prefix. The shared axios client's `baseURL` already
 * includes `/api`, so this constant only names the resource
 * segment.
 */
const TOPICS_PATH = '/topics';

// ============================================================
//  listTopics
// ============================================================

/**
 * List the authenticated user's topics, sorted by the backend
 * (newest first — the backend's controller passes the sort to the
 * service, which uses the `{ userId, createdAt: -1 }` compound
 * index).
 *
 * The optional `status` filter narrows the result to a single
 * pipeline state. When omitted, every topic owned by the user is
 * returned. The filter is expressed as the `?status=` query
 * parameter, matching the backend's controller, which validates
 * the value against the closed `TopicStatus` set.
 *
 * @param status - Optional pipeline-state filter.
 * @returns An `ApiResponse` wrapping the array of topics on
 *          success, or the standard error envelope on failure.
 */
export const listTopics = async (
  status?: TopicStatus
): Promise<ApiResponse<Topic[]>> => {
  // Build the URL with the optional query string. The two
  // branches are collapsed into a single template so the call
  // site does not have to pick between two apiGet overloads.
  const url =
    status !== undefined
      ? `${TOPICS_PATH}?status=${encodeURIComponent(status)}`
      : TOPICS_PATH;

  return apiGet<Topic[]>(url);
};

// ============================================================
//  createTopic
// ============================================================

/**
 * Create a new topic owned by the authenticated user.
 *
 * The `TopicCreatePayload` carries the user's chosen values from
 * the New Topic modal — the title (required), and optionally the
 * keywords, preset, profile, prompt file, word count, and source
 * count. The backend's service applies defaults for any omitted
 * field, so a minimal payload with just a title is valid.
 *
 * The authenticated user's identity is attached to the request
 * by the shared axios client's bearer token; the payload
 * deliberately does not include a `userId` field. The backend's
 * service derives the owner from the authenticated session, and
 * the type's shape (`TopicCreatePayload`) does not include the
 * field — so a caller cannot accidentally pass one.
 *
 * @param payload - The topic's creation values.
 * @returns An `ApiResponse` wrapping the persisted topic on
 *          success, or the standard error envelope on failure.
 */
export const createTopic = async (
  payload: TopicCreatePayload
): Promise<ApiResponse<Topic>> => {
  return apiPost<Topic>(TOPICS_PATH, payload);
};

// ============================================================
//  getTopic
// ============================================================

/**
 * Fetch a single topic by its id.
 *
 * A topic that does not exist or that belongs to a different user
 * returns a 404 from the backend, which the shared axios client
 * converts to an `{ success: false, error: 'Topic not found.' }`
 * envelope. The two cases are merged on the backend for
 * enumeration-safety reasons — a caller cannot distinguish "no
 * such topic" from "topic belongs to someone else". See the
 * backend's `topicService.ts` for the full rationale.
 *
 * @param topicId - The topic's id (a hexadecimal string).
 * @returns An `ApiResponse` wrapping the topic on success, or the
 *          standard error envelope on failure.
 */
export const getTopic = async (
  topicId: string
): Promise<ApiResponse<Topic>> => {
  return apiGet<Topic>(`${TOPICS_PATH}/${encodeURIComponent(topicId)}`);
};

// ============================================================
//  updateTopic
// ============================================================

/**
 * Apply a partial update to a topic.
 *
 * The `TopicUpdatePayload` accepts any subset of the topic's
 * mutable fields — title, keywords, preset, profile, prompt file,
 * word count, source count, status, error. Fields omitted from
 * the patch are left unchanged on the backend's document. Fields
 * present but invalid are rejected with a 400 by the backend's
 * schema validators, which the shared client converts to an error
 * envelope.
 *
 * The backend's service handles one cross-field rule the schema
 * does not: when `status` is changed to anything other than
 * `'failed'`, the `error` field is unset. That logic is entirely
 * server-side; this module does not need to know about it.
 *
 * @param topicId - The topic's id.
 * @param patch   - The fields to update.
 * @returns An `ApiResponse` wrapping the updated topic on
 *          success, or the standard error envelope on failure.
 */
export const updateTopic = async (
  topicId: string,
  patch: TopicUpdatePayload
): Promise<ApiResponse<Topic>> => {
  return apiPatch<Topic>(
    `${TOPICS_PATH}/${encodeURIComponent(topicId)}`,
    patch
  );
};

// ============================================================
//  deleteTopic
// ============================================================

/**
 * Delete a topic.
 *
 * The backend returns the deleted document so the client has a
 * last-chance look at what was removed; the renderer's UI uses
 * that to render an undo affordance without a second round trip.
 *
 * The backend does NOT cascade the delete to the topic's child
 * records (documents, articles, reports). Cascade rules belong to
 * each owning feature and are not implemented in the current
 * plan — a topic delete leaves orphaned child records in the
 * database, which a future cleanup migration could address. This
 * module's job is to reflect the backend's behaviour, not to
 * invent a cascade.
 *
 * @param topicId - The topic's id.
 * @returns An `ApiResponse` wrapping the deleted topic on
 *          success, or the standard error envelope on failure.
 */
export const deleteTopic = async (
  topicId: string
): Promise<ApiResponse<Topic>> => {
  return apiDelete<Topic>(`${TOPICS_PATH}/${encodeURIComponent(topicId)}`);
};