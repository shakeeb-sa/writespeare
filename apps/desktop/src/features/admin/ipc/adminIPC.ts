/**
 * adminIPC — IPC handlers for the admin feature.
 *
 * Registers the four channels the renderer's
 * `window.electronAPI.admin.*` methods invoke:
 *
 *   admin:getUsers    — list every user in the system.
 *   admin:createUser  — create a new user account.
 *   admin:updateUser  — apply a partial update to an existing
 *                       account (email, password, role, active
 *                       flag).
 *   admin:deleteUser  — remove an account.
 *
 * The four channels correspond one-to-one with the four methods
 * the preload declares on `window.electronAPI.admin` — `listUsers`,
 * `createUser`, `updateUser`, and `deleteUser`. There is no fifth
 * channel here and no fifth preload method; the two sides stay in
 * lockstep by construction.
 *
 * ── The inverted ownership model ────────────────────────────────
 *
 *   Every other feature's IPC handlers pass the CALLER's identity
 *   implicitly — through the bearer token that the shared axios
 *   client attaches to every request — and the backend filters
 *   every query to the caller's own records. That is how topics,
 *   documents, articles, reports, settings, and presets enforce
 *   isolation.
 *
 *   The admin handlers are the exception. Their HTTP requests
 *   target the backend's `/api/users` endpoints, which the
 *   backend protects with BOTH `authenticate` AND `requireAdmin`
 *   middleware. The bearer token the client attaches is the
 *   caller's — as always — but the backend's admin authorization
 *   check uses that identity to decide whether the CALLER is
 *   allowed to act on other users, not to scope the operation to
 *   the caller's own data.
 *
 *   The consequence for this file: its handlers do not pass any
 *   "caller id" argument to the backend, because the backend
 *   derives the caller's identity from the bearer token it
 *   receives. The handlers forward the operation's TARGET
 *   identifier — the user id to update or delete — and the
 *   operation's payload, and nothing else.
 *
 * ── Why the handlers are thin pass-throughs ─────────────────────
 *
 *   The four HTTP operations this file forwards are all ordinary
 *   REST calls that the shared axios client already knows how to
 *   make and how to fail. The handlers do not need to:
 *
 *     * Attach the bearer token. The shared client's request
 *       interceptor does that for every request, automatically.
 *
 *     * Convert HTTP failures into envelopes. The shared client's
 *       `apiGet` / `apiPost` / `apiPatch` / `apiDelete` wrappers
 *       already convert every axios failure — a 4xx, a 5xx, a
 *       timeout, a network error — into a `{ success: false,
 *       error }` envelope. The handler receives that envelope
 *       and returns it unchanged.
 *
 *     * Distinguish the backend's error codes. The backend's
 *       controller returns the correct HTTP status for each
 *       failure mode (404 for a missing target, 409 for a
 *       duplicate email, 400 for a schema-level validation
 *       error), and the shared client preserves the message that
 *       came with it. The renderer's admin store reads the
 *       envelope's `error` field and displays it as-is.
 *
 *   What the handlers DO need to do is validate the shape of the
 *   arguments the renderer sent. A renderer that passed a
 *   malformed value — a non-string user id, a patch that is not
 *   an object, a create payload missing its email — would
 *   produce a confusing downstream error from the backend (a
 *   CastError for a non-ObjectId id, a schema validation error
 *   for a missing field). Catching those at the IPC boundary
 *   produces a clearer message, avoids a round trip that is
 *   guaranteed to fail, and keeps the renderer's error surface
 *   consistent regardless of which layer caught the mistake.
 *
 * ── Why the delete handler returns the deleted user ─────────────
 *
 *   The backend's `DELETE /api/users/:id` handler returns the
 *   deleted user's public projection — see the backend's
 *   `userController.deleteUser` for the rationale (the client
 *   can render an "undo" affordance with the returned record
 *   without a second round trip). This file's `admin:deleteUser`
 *   handler forwards the backend's response envelope unchanged,
 *   so the renderer receives the same `{ success: true, data:
 *   deletedUser }` shape it would have received from a direct
 *   HTTP call.
 *
 *   The store's `deleteUser` action ignores the returned
 *   `data` field — it only reads `success` — so the extra
 *   payload is currently unused. A future session that wants
 *   the delete-undone flow would extend the store to read and
 *   cache the deleted user; the IPC handler would not need to
 *   change.
 *
 * ── Why the create handler validates the payload shape ──────────
 *
 *   The preload's `admin.createUser` signature takes a
 *   `UserCreatePayload`-shaped object. TypeScript checks that
 *   shape at the call site, but the IPC boundary is a runtime
 *   surface — a caller that used `as` to bypass the type check,
 *   or a future component that passed a wrong-shaped object by
 *   mistake, would reach this handler with something other than
 *   the expected shape.
 *
 *   The handler therefore checks that the payload is a plain
 *   object and that the two required fields (`email`,
 *   `password`) are non-empty strings. It does NOT check the
 *   optional `role` and `active` fields' types — those are the
 *   backend controller's job, and a field-level check here
 *   would duplicate rules that already live in one place. A
 *   payload with a bad optional field reaches the backend and
 *   receives a 400 with a specific message.
 *
 * ── What this file does NOT do ──────────────────────────────────
 *
 *   - It does not touch the encrypted store. The admin feature
 *     has no persistent main-process state. Every operation is
 *     stateless from this layer's perspective.
 *
 *   - It does not cache the user list. Every `admin:getUsers`
 *     call issues a fresh HTTP GET. The admin panel's user list
 *     is short-lived and the frequency of the operation is low
 *     — a user clicks the admin nav link, the panel mounts,
 *     the list loads. A cache would add invalidation logic for
 *     no benefit.
 *
 *   - It does not distinguish the caller from the other users
 *     in the list. The backend returns every user, including
 *     the caller, and this handler forwards the full array.
 *     A future "cannot delete yourself" guard would live in
 *     the renderer's admin page, not in this handler — the
 *     handler has no way to identify the caller without
 *     inspecting the store, and inspecting the store would
 *     introduce a dependency from this file to the auth
 *     feature that has no other purpose.
 *
 *   - It does not emit markers. The admin feature is a pure
 *     request-response layer — every operation is an HTTP call,
 *     and the renderer's `useAdmin` hook drives the UI state
 *     from the envelope this file returns. There is no progress
 *     to stream and no event to broadcast.
 *
 *   - It does not register the system-preset channels that the
 *     backend's admin routes also expose. The backend's
 *     `adminRoutes.ts` declares four preset-management endpoints
 *     (`/api/admin/presets...`), but the plan's admin tree for
 *     the desktop declares no preset-management UI and the
 *     preload declares no `admin.presets.*` methods. Adding
 *     handlers for channels the preload does not declare would
 *     be dead code — a channel the renderer can never reach.
 *     A future session that adds the preset-management UI would
 *     extend both the preload and this file together.
 *
 * Dependencies: electron + the shared axios client + the shared
 * types module. All present.
 */

import { ipcMain, type IpcMainInvokeEvent } from 'electron';

import {
  apiGet,
  apiPost,
  apiPatch,
  apiDelete,
} from '../../shared/api/client.js';

import type {
  ApiResponse,
  User,
  UserCreatePayload,
  UserUpdatePayload,
} from '../../shared/types/index.js';

// ============================================================
//  Channel name constants
// ============================================================
//
// The four channel names are declared as constants so a future
// refactor that renames them (or a test that spies on them) has
// one place to change. The preload's `src/main/preload.ts`
// declares the same strings on the renderer side of the bridge —
// the two must stay in sync, but neither file imports from the
// other, because the preload is a renderer-context module and
// this file is a main-context module.

const CHANNEL_GET_USERS = 'admin:getUsers';
const CHANNEL_CREATE_USER = 'admin:createUser';
const CHANNEL_UPDATE_USER = 'admin:updateUser';
const CHANNEL_DELETE_USER = 'admin:deleteUser';

// ============================================================
//  Primitive type predicates
// ============================================================
//
// Two small predicates, used by the create and update handlers
// below. They are declared locally rather than shared because no
// other IPC handler module in the codebase has needed them yet —
// the shape of an admin user payload is specific to this file.

/**
 * A non-empty string. Rejects the empty string, which is the
 * common "renderer sent a field but left it blank" case.
 * Whitespace-only strings pass here and are rejected by the
 * backend's schema (via `trim: true` + `minlength: 1` on the
 * relevant fields).
 */
const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

/**
 * A plain object — an object that is neither null nor an array.
 * Used to check that a create payload and an update patch are
 * shaped like the objects the backend expects, without
 * narrowing the object's fields (which the backend's schema is
 * authoritative on).
 */
const isPlainObject = (
  value: unknown
): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// ============================================================
//  registerAdminIPC
// ============================================================

/**
 * Register the admin feature's IPC handlers.
 *
 * Called once, from `main/index.ts`, inside the
 * `app.whenReady().then(...)` callback — the same place every
 * other feature's registration function is called. The function
 * is not idempotent: `ipcMain.handle` refuses to register a
 * second handler for the same channel, and a second call would
 * therefore produce Electron errors. The single-call contract is
 * the same one every other feature's `register*IPC()` function
 * follows.
 */
export const registerAdminIPC = (): void => {
  // ---- admin:getUsers ----
  //
  // Fetch every user in the system. Forwards the backend's
  // `GET /api/users` response envelope unchanged.
  //
  // The handler takes no arguments and reads none from the
  // request. The caller's identity is derived by the backend
  // from the bearer token the shared axios client attaches
  // automatically — see the file header for the inverted
  // ownership model.
  ipcMain.handle(
    CHANNEL_GET_USERS,
    async (_event: IpcMainInvokeEvent): Promise<ApiResponse<User[]>> => {
      try {
        return await apiGet<User[]>('/users');
      } catch (err) {
        // The shared client's wrappers already convert every
        // axios failure into an envelope, so this catch only
        // fires for a genuinely unexpected throw — a bug in
        // the wrapper, an out-of-memory condition, an
        // Electron-internal exception. The message is
        // surfaced to the renderer so the admin panel's error
        // state has something specific to display.
        const message =
          err instanceof Error ? err.message : String(err);
        return {
          success: false,
          error: `Could not load users: ${message}`,
        };
      }
    }
  );

  // ---- admin:createUser ----
  //
  // Create a new user account. Validates the payload's
  // top-level shape and its two required fields before
  // forwarding to the backend's `POST /api/users`.
  //
  // The handler does NOT validate the optional `role` and
  // `active` fields — see the file header for the reasoning.
  // A payload whose optional fields are malformed reaches the
  // backend and receives a 400 with the schema's own message.
  ipcMain.handle(
    CHANNEL_CREATE_USER,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<ApiResponse<User>> => {
      // ---- 1. Payload shape ----
      if (!isPlainObject(payload)) {
        return {
          success: false,
          error: 'User payload must be a JSON object.',
        };
      }

      // ---- 2. Required fields ----
      if (!isNonEmptyString(payload['email'])) {
        return {
          success: false,
          error: 'email is required.',
        };
      }
      if (!isNonEmptyString(payload['password'])) {
        return {
          success: false,
          error: 'password is required.',
        };
      }

      // ---- 3. Delegate to the backend ----
      try {
        // The payload is narrowed to a plain object by the
        // checks above; the cast to `UserCreatePayload` tells
        // the compiler to trust the shape for the axios call.
        // The backend's controller is the authoritative
        // validator for the optional fields' types — see the
        // file header.
        return await apiPost<User>(
          '/users',
          payload as unknown as UserCreatePayload
        );
      } catch (err) {
        const message =
          err instanceof Error ? err.message : String(err);
        return {
          success: false,
          error: `Could not create user: ${message}`,
        };
      }
    }
  );

  // ---- admin:updateUser ----
  //
  // Apply a partial update to an existing user account.
  // Validates the target id and the patch's top-level shape
  // before forwarding to the backend's `PATCH /api/users/:id`.
  ipcMain.handle(
    CHANNEL_UPDATE_USER,
    async (
      _event: IpcMainInvokeEvent,
      userId: unknown,
      patch: unknown
    ): Promise<ApiResponse<User>> => {
      // ---- 1. Target id ----
      if (!isNonEmptyString(userId)) {
        return {
          success: false,
          error: 'userId is required.',
        };
      }

      // ---- 2. Patch shape ----
      if (!isPlainObject(patch)) {
        return {
          success: false,
          error: 'Update patch must be a JSON object.',
        };
      }

      // ---- 3. Delegate to the backend ----
      try {
        // The URL path is encoded so a userId that somehow
        // contains a path-separator character cannot break the
        // route. The backend's route parameter is a Mongo
        // ObjectId, which is hex-only, so the encoding is
        // defensive rather than load-bearing — but it costs
        // nothing and closes a class of hypothetical injection.
        return await apiPatch<User>(
          `/users/${encodeURIComponent(userId)}`,
          patch as unknown as UserUpdatePayload
        );
      } catch (err) {
        const message =
          err instanceof Error ? err.message : String(err);
        return {
          success: false,
          error: `Could not update user: ${message}`,
        };
      }
    }
  );

  // ---- admin:deleteUser ----
  //
  // Remove a user account. Validates the target id before
  // forwarding to the backend's `DELETE /api/users/:id`.
  //
  // The handler forwards the backend's response envelope
  // unchanged — the response's `data` field carries the deleted
  // user's public projection, which the current renderer's
  // `deleteUser` action ignores but a future session could
  // consume for an undo affordance. See the file header.
  ipcMain.handle(
    CHANNEL_DELETE_USER,
    async (
      _event: IpcMainInvokeEvent,
      userId: unknown
    ): Promise<ApiResponse<User>> => {
      // ---- 1. Target id ----
      if (!isNonEmptyString(userId)) {
        return {
          success: false,
          error: 'userId is required.',
        };
      }

      // ---- 2. Delegate to the backend ----
      try {
        return await apiDelete<User>(
          `/users/${encodeURIComponent(userId)}`
        );
      } catch (err) {
        const message =
          err instanceof Error ? err.message : String(err);
        return {
          success: false,
          error: `Could not delete user: ${message}`,
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
 * (`import { registerAdminIPC } from ...`), so the default form
 * is a convenience rather than a load-bearing export.
 */
export default registerAdminIPC;