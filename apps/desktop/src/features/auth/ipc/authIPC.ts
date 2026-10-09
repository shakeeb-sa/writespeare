/**
 * Auth feature — IPC handler for the main process.
 *
 * This module is the bridge between the renderer's
 * `window.electronAPI.auth.*` calls and the main process's auth
 * machinery. Its `registerAuthIPC()` function is called once, at
 * app-ready time, by `src/main/index.ts` — the same place that
 * every other feature's IPC registration will eventually be
 * called from (see the block comment in `src/main/index.ts`
 * listing each feature's `register*IPC()` call in session
 * order).
 *
 * The three channels this file registers:
 *
 *   auth:login    — POSTs the credentials to the backend via
 *                   `authApi.login`, and on success persists the
 *                   returned token and user to the encrypted
 *                   store so the session survives a restart.
 *
 *   auth:logout   — clears the encrypted store (via
 *                   `store.clearAuth`), letting `authApi.logout`
 *                   handle the axios client's bearer token.
 *
 *   auth:getUser  — reads the cached user from the encrypted
 *                   store and returns it. This is the fast,
 *                   offline-friendly read that the renderer's
 *                   bootstrap sequence depends on; it does NOT
 *                   make a network call. See "Why getUser is a
 *                   cache read" below.
 *
 * Two additional responsibilities that this file owns because
 * they belong to the auth feature alone:
 *
 *   1. Startup token restoration. Before any channel is
 *      registered, this file reads the persisted token from
 *      the encrypted store and installs it on the shared axios
 *      client (`setAuthToken`). Without this step, the very
 *      first authenticated request after a cold start would go
 *      out with no `Authorization` header, and the backend
 *      would return 401 even though the user has a valid
 *      session. The restoration is conditional — no persisted
 *      token means no call — which keeps a first-launch
 *      experience (no session yet) from logging spurious
 *      messages.
 *
 *   2. The unauthorized handler. When the shared axios client's
 *      response interceptor detects a 401 (see the interceptor
 *      in `shared/api/client.ts`), it invokes whatever handler
 *      was registered via `setUnauthorizedHandler`. This file
 *      registers one that does two things: (a) clears the
 *      encrypted store so the app's next cold start does not
 *      resume a dead session, and (b) broadcasts an
 *      `auth:sessionExpired` event to every renderer window so
 *      the renderer can react — clear its own store, and let
 *      the layout's auth gate redirect to the login screen.
 *
 * Why the unauthorized handler is registered here rather than in
 * `main/index.ts`:
 *
 *   The handler's whole purpose is auth: it clears the auth
 *   store and signals an auth event. Registering it in the auth
 *   feature's IPC module keeps it co-located with the rest of
 *   the auth wiring. `main/index.ts` calls one function
 *   (`registerAuthIPC()`) and the whole auth subsystem —
 *   channels, startup restoration, session-expiry handling —
 *   comes online together. A reader who wants to know what the
 *   auth feature does at the main-process level has one file to
 *   read.
 *
 * Why `getUser` is a cache read and not a network call:
 *
 *   The renderer's cold-start sequence (see the bootstrap effect
 *   in `useAuth.ts`) calls `auth:getUser` on the very first
 *   mount, before any other request is made. The point of that
 *   call is to give the renderer a yes/no answer on whether a
 *   session exists, as fast as possible, so the app can render
 *   the authenticated shell (or the login page) without a
 *   network round-trip delay.
 *
 *   A cache read achieves that. A call to the backend's
 *   `/api/auth/me` would also answer the question — and it would
 *   validate the token against the backend, catching an expired
 *   session earlier — but it would put a network round-trip on
 *   every cold start. On a remote backend, that adds hundreds of
 *   milliseconds to the app's launch. The failure mode of the
 *   cache approach is that an expired token is not detected
 *   until the first authenticated request goes out; the
 *   unauthorized handler above catches that case and the app
 *   falls back to login, which is the correct behaviour.
 *
 *   The alternative — using `authApi.getCurrentUser` here, which
 *   does call the backend — is available and would be a
 *   one-line change. It is not the current design, for the
 *   latency reason above. If a future session decides the
 *   freshness trade-off is worth the latency, the change is a
 *   single line in the `auth:getUser` handler below.
 *
 * Why the renderer receives `auth:sessionExpired` rather than
 * the main process pushing a state change directly:
 *
 *   The renderer's auth store (`features/auth/store/userStore.ts`)
 *   is a Zustand store that lives entirely in the renderer's
 *   memory. The main process cannot reach it directly — the
 *   context-isolation boundary is what prevents that, and it is
 *   a security feature, not an inconvenience. The only way for
 *   the main process to tell the renderer "your session is
 *   gone" is through an IPC event, which is what this handler
 *   uses.
 *
 *   A PLAN DELTA is logged for the corresponding listener: the
 *   renderer's `useAuth` hook does not yet subscribe to
 *   `auth:sessionExpired`, so on a session expiry the renderer's
 *   store will remain populated until the user takes an action
 *   that produces a fresh 401. The main process side of the
 *   flow is complete in this file; the renderer side is a
 *   one-line effect that a future session can add to
 *   `useAuth.ts`.
 */

import {
  BrowserWindow,
  ipcMain,
  type IpcMainInvokeEvent,
} from 'electron';

import { login, logout } from '../api/authApi.js';
import {
  clearAuth,
  getToken,
  getUser,
  setToken,
  setUser,
} from '../../../main/store.js';
import {
  setAuthToken,
  setUnauthorizedHandler,
} from '../../shared/api/client.js';

import type {
  ApiResponse,
  LoginRequest,
  LoginResponse,
  User,
} from '../../shared/types/index.js';

// ============================================================
//  Channel name constants
// ============================================================
//
//  The three channel names are declared as constants so a future
//  refactor that renames them (or a test that spies on them) has
//  one place to change. The preload's `src/main/preload.ts`
//  declares the same strings on the renderer side of the bridge
//  — the two must stay in sync, but neither file imports from
//  the other, because the preload is a renderer-context module
//  and this file is a main-context module.

const CHANNEL_LOGIN = 'auth:login';
const CHANNEL_LOGOUT = 'auth:logout';
const CHANNEL_GET_USER = 'auth:getUser';

/**
 * The channel name for the session-expired event that this file
 * broadcasts to the renderer. Not exported — the only consumer
 * of this constant is the code below. The renderer's listener
 * (in a future `useAuth` update) will declare the same string on
 * its side of the bridge.
 */
const CHANNEL_SESSION_EXPIRED = 'auth:sessionExpired';

// ============================================================
//  registerAuthIPC
// ============================================================

/**
 * Register the auth feature's IPC handlers and startup wiring.
 *
 * Called once, from `main/index.ts`, inside the
 * `app.whenReady().then(...)` callback. By the time this runs,
 * both the encrypted store and the shared axios client exist —
 * they were initialized when their own modules were imported,
 * which happens at the top of the main process's module graph.
 *
 * The function is not idempotent: calling it twice will produce
 * Electron errors on the second call, because `ipcMain.handle`
 * refuses to register a second handler for the same channel. The
 * single-call contract is the same one every other feature's
 * `register*IPC()` function follows. A future hardening pass
 * could add a module-level `let registered = false` guard, but
 * the guard's value depends on how a double-call would be
 * possible in the first place — and no current code path calls
 * this function twice.
 */
export const registerAuthIPC = (): void => {
  // ---- 1. Startup: restore the persisted bearer token ----
  //
  // Read the token that a previous session left in the encrypted
  // store, and install it on the shared axios client. This is
  // the piece of "wiring" that lets the very first authenticated
  // request after a cold start carry the right bearer, without
  // waiting for a login. See the file header for the reasoning.
  const persistedToken = getToken();
  if (persistedToken) {
    setAuthToken(persistedToken);
  }

  // ---- 2. Register the unauthorized handler ----
  //
  // When the shared axios client's response interceptor sees a
  // 401 (an expired or invalid token, or a deactivated account
  // that the backend refuses), it invokes this handler. See the
  // file header for why the two responsibilities — clearing the
  // store and notifying the renderer — live here.
  setUnauthorizedHandler(() => {
    clearAuth();

    // Notify every renderer window. In the current app there is
    // exactly one window, but the loop handles the multi-window
    // case — a future session might open a DevTools-only window,
    // a modal window for the export dialog, or a secondary
    // window for a side-by-side view. The loop is cheap and the
    // alternative (assuming exactly one window) is the kind of
    // assumption that becomes a bug the moment it stops being
    // true.
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(CHANNEL_SESSION_EXPIRED);
    }
  });

  // ---- 3. Register the three invoke channels ----

  // ---- auth:login ----
  //
  // Forward the credentials to `authApi.login`. On success,
  // persist the returned token and user to the encrypted store
  // so the session survives a restart. The `authApi.login`
  // function also installs the token on the axios client (see
  // its own file header); the `setToken` call here is what
  // makes the token durable across process boundaries.
  ipcMain.handle(
    CHANNEL_LOGIN,
    async (
      _event: IpcMainInvokeEvent,
      credentials: LoginRequest
    ): Promise<ApiResponse<LoginResponse>> => {
      const result = await login(credentials);

      if (result.success && result.data) {
        setToken(result.data.token);
        setUser(result.data.user);
      }

      return result;
    }
  );

  // ---- auth:logout ----
  //
  // Call `authApi.logout` (which clears the axios client's
  // bearer token) and then clear the encrypted store. The order
  // matters slightly: clearing the axios token first means that
  // any in-flight request that resolves after the store is
  // cleared does not accidentally re-authenticate through a
  // still-installed bearer. In practice the order is a
  // belt-and-braces concern — the axios client has no pending
  // requests in a synchronous logout — but the order is the
  // correct one and is preserved for clarity.
  ipcMain.handle(
    CHANNEL_LOGOUT,
    async (): Promise<ApiResponse<null>> => {
      const result = await logout();
      clearAuth();
      return result;
    }
  );

  // ---- auth:getUser ----
  //
  // Read the cached user from the encrypted store. This is a
  // synchronous read of an already-loaded in-memory object; the
  // handler is wrapped in an async function only because
  // `ipcMain.handle` expects a promise-returning listener for
  // consistency with the other two channels. The `success: true`
  // envelope is always returned — "no user cached" is not an
  // error, it is the legitimate state of a first-launch app.
  ipcMain.handle(
    CHANNEL_GET_USER,
    async (): Promise<ApiResponse<User | null>> => {
      const user = getUser();
      return { success: true, data: user };
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
 * (`import { registerAuthIPC } from ...`), so the default form
 * is a convenience rather than a load-bearing export.
 */
export default registerAuthIPC;