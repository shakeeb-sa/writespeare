/**
 * Auth feature — backend API layer.
 *
 * This module declares the three backend operations the auth
 * feature performs, as small, focused functions that each return
 * the shared `ApiResponse<T>` envelope:
 *
 *   login            — POST /api/auth/login, and (on success) set
 *                      the bearer token on the shared axios
 *                      client so subsequent authenticated
 *                      requests carry it.
 *
 *   getCurrentUser   — GET /api/auth/me, and return the
 *                      authenticated user.
 *
 *   logout           — clear the bearer token from the shared
 *                      axios client. See "Why logout is a local
 *                      operation" below.
 *
 * This is a MAIN-PROCESS module. It uses the shared axios client
 * declared in `features/shared/api/client.ts`, which runs in the
 * main process. The renderer never imports this file directly —
 * it reaches these operations through `window.electronAPI.auth.*`,
 * which is wired by the preload (see `src/main/preload.ts`) to
 * the IPC handlers registered by the sibling file
 * `ipc/authIPC.ts`. The three IPC channel names that file uses
 * — `auth:login`, `auth:logout`, `auth:getUser` — correspond
 * one-to-one with the three functions this module exports.
 *
 * Why logout is a local operation:
 *
 *   The backend exposes no logout endpoint. Its auth scheme is
 *   stateless JWT: a session is a signed token with a seven-day
 *   `exp` claim, and "logging out" is a client-side decision to
 *   stop using the token. There is no server-side session
 *   registry to remove the token from — revoking a token before
 *   its natural expiry would require rotating the server's
 *   signing secret, which would invalidate every user's token
 *   at once.
 *
 *   Logout is therefore implemented here as a single, meaningful
 *   local action: clear the module-level bearer token on the
 *   shared axios client so that no subsequent request carries
 *   the now-stale credential. The IPC handler that calls this
 *   function is expected to also clear the persistent encrypted
 *   store (`src/main/store.ts`) — that is the handler's concern,
 *   not this module's, because the store is a persistence
 *   surface this module does not own.
 *
 * Why the token lifecycle lives in this module rather than in
 * the IPC handler:
 *
 *   The shared axios client's token is a piece of state that is
 *   set and cleared at specific, defined moments — after a
 *   successful login, and on logout. Tying those two moments to
 *   the two functions that own the corresponding HTTP operations
 *   (`login` sets it, `logout` clears it) keeps the invariant
 *   local: a reader who opens this file sees the full lifecycle
 *   in one place. If the IPC handler owned the token-setting
 *   call instead, that invariant would be split across two files
 *   — the module that produces the token and the module that
 *   installs it — with no compile-time link between them.
 *
 *   The pattern is the same one used by the backend's auth
 *   service (`authService.ts`), which owns both the credential
 *   verification and the token signing, on the grounds that they
 *   are two halves of one operation. The symmetry is deliberate.
 *
 * Why `getCurrentUser` and not `getMe`:
 *
 *   The plan's file-tree description for this module names the
 *   function "getMe" — mirroring the backend's route name
 *   (`/api/auth/me`). The function here is named
 *   `getCurrentUser` instead, because the name reads naturally
 *   at the call sites where it will be used: a reader sees
 *   `getCurrentUser()` and immediately knows what it returns,
 *   whereas `getMe()` is meaningful only to a reader who has
 *   already memorised the route name. The route path itself is
 *   still `/auth/me` — the rename is cosmetic, applied at the
 *   function boundary. A future session that prefers the
 *   plan-literal name can rename the export in a one-line change
 *   that ripples only to the IPC handler.
 *
 * What this module does NOT do:
 *
 *   - It does not touch the encrypted store. Setting and clearing
 *     the store's token is the IPC handler's job (item #50).
 *
 *   - It does not clear the axios client's token on a failed
 *     login. A failed login means the credentials were rejected,
 *     not that the current session (if any) is invalid. Clearing
 *     a still-valid token on a failed login attempt would log
 *     out a user who was trying — for example — to sign in with
 *     a second account.
 *
 *   - It does not distinguish "no user exists for this token"
 *     from "the request failed". Both come back as an
 *     `ApiResponse` with `success: false`, and both are handled
 *     by the caller. The 401-triggered logout path is
 *     independently handled by the shared client's response
 *     interceptor (see `shared/api/client.ts`), not here.
 */

import {
  apiGet,
  apiPost,
  setAuthToken,
} from '../../shared/api/client.js';
import type {
  ApiResponse,
  LoginRequest,
  LoginResponse,
  User,
} from '../../shared/types/index.js';

// ============================================================
//  login
// ============================================================

/**
 * Exchange credentials for a bearer token and a user object.
 *
 * On success, the returned `LoginResponse` contains the token
 * and the user. This function extracts the token and installs it
 * on the shared axios client so that any authenticated request
 * the process makes afterward carries it.
 *
 * On failure — a wrong password, an unknown email, a deactivated
 * account, a network error — the returned envelope has
 * `success: false` and an `error` message. The client's bearer
 * token (if one was set from a previous session) is NOT cleared:
 * see the file header for why.
 *
 * The function does not throw. Every failure mode the shared
 * client's wrappers can produce has already been converted into
 * an envelope before reaching this function, and the one branch
 * added here (whether to set the token) cannot itself fail.
 *
 * @param credentials - The email and password the user typed.
 * @returns An `ApiResponse` wrapping the `LoginResponse` shape
 *          (`{ user, token }`) on success, or the standard error
 *          envelope on failure.
 */
export const login = async (
  credentials: LoginRequest
): Promise<ApiResponse<LoginResponse>> => {
  const result = await apiPost<LoginResponse>('/auth/login', credentials);

  // Only install the token on success. On failure, leave
  // whatever token was already on the client untouched — see
  // the file header.
  if (result.success && result.data) {
    setAuthToken(result.data.token);
  }

  return result;
};

// ============================================================
//  getCurrentUser
// ============================================================

/**
 * Fetch the currently authenticated user from the backend.
 *
 * The backend's `/api/auth/me` endpoint reads the bearer token
 * from the `Authorization` header, verifies its signature, and
 * returns the corresponding user record. The response is the
 * client-safe projection — no password hash — and its shape is
 * the shared `User` type.
 *
 * The two failure modes that matter to the caller:
 *
 *   - No token installed on the axios client (a cold start where
 *     the encrypted store was empty): the request goes out with
 *     no Authorization header, the backend returns 401, and the
 *     shared client's response interceptor invokes the
 *     unauthorized handler. The result this function returns is
 *     an error envelope.
 *
 *   - Token installed but expired or invalid: same flow — the
 *     interceptor handles the 401, the function returns an
 *     error envelope.
 *
 * In both cases the caller is expected to fall back to the
 * login screen. That fallback is orchestrated by the renderer's
 * auth store and the layout's auth gate, not here.
 */
export const getCurrentUser = async (): Promise<ApiResponse<User>> => {
  return apiGet<User>('/auth/me');
};

// ============================================================
//  logout
// ============================================================

/**
 * Clear the current session's bearer token from the shared axios
 * client.
 *
 * This is a local operation — the backend has no logout endpoint
 * — and it is intentionally narrow: it clears the token on the
 * axios client and returns a success envelope. It does NOT touch
 * the persistent encrypted store; that is the IPC handler's job.
 * See the file header for the full reasoning.
 *
 * The function is `async` (returning a `Promise<ApiResponse<null>>`)
 * even though its body is synchronous, for two reasons:
 *
 *   1. Uniformity with `login` and `getCurrentUser`. A caller
 *      that awaits every authApi call without special-casing
 *      `logout` writes less code than one that has to remember
 *      which functions are synchronous.
 *
 *   2. Future-proofing. If a future backend adds a logout
 *      endpoint — say, to record the event in an audit log — the
 *      body gains an `await apiPost(...)` and the signature does
 *      not change. Callers are already set up for the async
 *      form.
 *
 * The return value is always success. There is no failure mode:
 * clearing a token that was already null is a no-op, and the
 * operation has no external dependency that could fail.
 */
export const logout = async (): Promise<ApiResponse<null>> => {
  setAuthToken(null);
  return { success: true, data: null };
};