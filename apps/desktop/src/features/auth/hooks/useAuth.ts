/**
 * useAuth — the renderer's authentication hook.
 *
 * This is the single entry point through which the app's
 * components read and manipulate the user's session. It sits
 * between two layers:
 *
 *   Below it, `useUserStore` (a Zustand store) holds the session
 *   state — the user, the token, the loading flag, the last
 *   error. The store is a pure container: it holds values and
 *   exposes setters, but it does not know how to talk to the
 *   backend or to the main process.
 *
 *   Below IT again, the main process owns the authoritative
 *   session — the encrypted `electron-store` that survives app
 *   restarts, the JWT that authenticates HTTP calls, the 401
 *   handler that fires when the backend rejects a request. The
 *   renderer reaches all of this through `window.electronAPI.*`,
 *   which the preload installs.
 *
 *   The hook's job is to compose these: it calls the IPC layer
 *   to talk to the main process, and it updates the store with
 *   the results. Components never call the IPC layer directly
 *   (they could, but the store would not know about it), and
 *   they never call the store's setters directly (the hook's
 *   `login` and `logout` encapsulate the side effects). What the
 *   component sees is a stable set of values and three actions.
 *
 * The relationship to the store — read the values, call the
 * actions:
 *
 *   The four data fields (`user`, `token`, `isLoading`, `error`)
 *   are read straight from the store via Zustand selectors. Any
 *   component that calls `useAuth()` re-renders when any of the
 *   four values it subscribes to changes — the store's
 *   subscription mechanism handles that automatically.
 *
 *   The three actions (`login`, `logout`, `refresh`) are
 *   `useCallback`-wrapped so their identities are stable across
 *   renders. A component that puts one of them in a `useEffect`
 *   dependency array (a common pattern — the Login page might
 *   want to reset its form when `login` is called) does not see
 *   the effect re-run on every store update.
 *
 * The bootstrap sequence:
 *
 *   On the first render of the first component that calls this
 *   hook, the hook reads the initial state of the store. The
 *   store's `isLoading` starts as `true` — the app does not yet
 *   know whether a session exists — and the hook's bootstrap
 *   effect fires once to resolve that question:
 *
 *     1. Call `window.electronAPI.auth.getUser()` — an IPC
 *        round-trip to the main process, which reads its
 *        encrypted store and returns the cached user (or null).
 *
 *     2. If a user was returned, set it on the store. If not,
 *        clear the store's session fields entirely.
 *
 *     3. Set `isLoading` to `false`, which is the signal the
 *        layout's auth gate is waiting for. At this point the
 *        gate either renders the dashboard (user present) or
 *        redirects to `/login` (user absent).
 *
 *   The bootstrap is guarded by a MODULE-LEVEL flag
 *   (`bootstrapHasRun`) rather than a per-component `useRef`, so
 *   that two components mounting at the same moment do not both
 *   trigger the same IPC round-trip. The first mount sets the
 *   flag and runs the bootstrap; every subsequent mount sees the
 *   flag and skips the work. Under React's StrictMode
 *   double-invoke in development, the second invocation of the
 *   effect also sees the flag and short-circuits — the same
 *   property that prevents duplicate bootstraps also makes the
 *   effect StrictMode-safe.
 *
 *   The flag is not reset when the app's session is cleared (a
 *   logout does not need to re-run the bootstrap — the store is
 *   already in the correct post-logout state). It is also not
 *   reset across hot-module reloads in development, which is
 *   harmless: the bootstrap is idempotent, and running it again
 *   would only re-read the same encrypted store it read the
 *   first time.
 *
 * The `login` flow:
 *
 *   1. Clear the previous error, so an old "invalid credentials"
 *      message does not linger during a new attempt.
 *   2. Call `window.electronAPI.auth.login({ email, password })`
 *      — an IPC round-trip to the main process, which POSTs to
 *      `/api/auth/login`, installs the returned token on the
 *      shared axios client, and persists the token and user to
 *      its encrypted store.
 *   3. On success: write the returned user and token to the
 *      renderer store, and resolve the promise with `true`.
 *   4. On failure: write the error to the store (wrapped in the
 *      feature-local `AuthError` shape), and resolve with
 *      `false`.
 *
 *   The promise resolves with a boolean rather than throwing,
 *   because the caller — the Login page — needs to make a
 *   decision either way: navigate to the dashboard on success,
 *   or stay on the login form and display the error on failure.
 *   A thrown error would work but would force the caller to wrap
 *   every login attempt in a try/catch, which is noise for what
 *   is a routine outcome.
 *
 *   The `rememberMe` field on `LoginFormValues` is deliberately
 *   not forwarded to the IPC layer. The plan describes the login
 *   form as having a remember-me checkbox, but the semantics of
 *   that checkbox — whether the session persists across app
 *   restarts — are implemented entirely on the main process side
 *   (the encrypted store always persists; there is no
 *   non-persisting mode today). A future session that wants to
 *   honour the checkbox would extend the IPC channel's payload to
 *   accept a `rememberMe: boolean`; this hook would pass it
 *   through. Until then, the field is captured in the form and
 *   ignored at the boundary.
 *
 * The `logout` flow:
 *
 *   1. Call `window.electronAPI.auth.logout()` — an IPC
 *      round-trip that clears the main process's encrypted store
 *      and its axios client's bearer token.
 *   2. Call the store's `clearAuth()` — which nulls the user,
 *      token, and error fields in the renderer store.
 *   3. Do NOT navigate. The layout's auth gate observes the
 *      store's `user` field becoming null and redirects to
 *      `/login` automatically. The redirect happens in exactly
 *      one place — the layout — which is what keeps the
 *      session-expiry and explicit-logout redirect paths
 *      identical.
 *
 *   The IPC call is wrapped in a try/catch that logs the error
 *   and continues to `clearAuth()` regardless. The rationale is
 *   the user's intent: they asked to log out, and the app's job
 *   is to log them out. If the IPC layer fails — say, the
 *   channel is unregistered, or the main process is shutting
 *   down — the renderer still clears its own store so the user
 *   sees the login screen. The main process's failure to clean
 *   up after itself is a separate problem that a subsequent
 *   restart will resolve (an app restart re-reads the encrypted
 *   store, which the IPC failure left with the old credentials;
 *   the user would then need to log out again).
 *
 * The `refresh` flow:
 *
 *   `refresh()` re-runs the bootstrap's IPC call — a re-read of
 *   the main process's encrypted store. It is exposed on the
 *   hook's API for two reasons:
 *
 *     1. The bootstrap itself uses it (internally), so it has to
 *        exist.
 *
 *     2. A component that knows the user's record has changed on
 *        the backend — say, the Settings page after the user
 *        updates their email — can call `refresh()` to sync the
 *        renderer's copy without a full app restart.
 *
 *   Unlike the bootstrap, `refresh` does NOT depend on the
 *   module-level flag. A component that calls it explicitly
 *   wants it to run every time. The IPC call is cheap, and the
 *   operation is idempotent.
 *
 * The return value shape:
 *
 *   The hook returns a single object with seven fields — the
 *   four data values and the three actions. This is the plan's
 *   list ("Exposes user, token, isLoading, error, login, logout,
 *   refresh") with no additions and no subtractions. A component
 *   that destructures only the fields it needs pays no cost for
 *   the ones it does not.
 *
 *   The `AuthHookValue` interface declares the shape explicitly.
 *   It is exported so that a helper function that takes "an
 *   instance of the auth hook" as a parameter can be typed
 *   against the interface without redeclaring the shape.
 */

import { useCallback, useEffect } from 'react';

import { useUserStore } from '../store/userStore.js';
import type { AuthError, LoginFormValues } from '../types/authTypes.js';
import type { User } from '../../shared/types/index.js';

// ============================================================
//  Public types
// ============================================================

/**
 * The shape of the object returned by `useAuth()`.
 *
 * See the file header for what each field is and why it exists.
 */
export interface AuthHookValue {
  // ---- Data ----

  /** The currently authenticated user, or null when signed out. */
  user: User | null;

  /** The current JWT bearer token, or null when signed out. */
  token: string | null;

  /**
   * Whether the app is currently determining the session state.
   * Starts true on cold start; becomes false after the
   * bootstrap sequence completes. See `Layout.tsx` for the auth
   * gate that reads this.
   */
  isLoading: boolean;

  /** The last auth error, or null. Cleared at the start of every
   *  login attempt. */
  error: AuthError | null;

  // ---- Actions ----

  /**
   * Attempt to sign in with the given credentials. Resolves with
   * `true` on success (and sets `user` and `token` on the store)
   * or `false` on failure (and sets `error`).
   */
  login: (values: LoginFormValues) => Promise<boolean>;

  /**
   * Sign the current user out. Resolves once the IPC call
   * completes and the local store has been cleared. The redirect
   * to `/login` happens automatically via the layout's auth
   * gate — see the file header.
   */
  logout: () => Promise<void>;

  /**
   * Re-read the current user from the main process's encrypted
   * store and sync the renderer store to match. Exposed for
   * components that know the user's backend record has changed.
   */
  refresh: () => Promise<void>;
}

// ============================================================
//  Module-level bootstrap guard
// ============================================================
//
//  See the file header for why this is a module-level flag
//  rather than a per-component ref. The short version: two
//  components mounting in the same tick must not both trigger
//  the same IPC round-trip, and a single flag shared by every
//  instance is the simplest way to guarantee that.

let bootstrapHasRun = false;

// ============================================================
//  The hook
// ============================================================

/**
 * Return the current authentication state and the actions that
 * manipulate it. See the file header for the full description of
 * the hook's responsibilities, its bootstrap sequence, and its
 * three actions.
 */
export const useAuth = (): AuthHookValue => {
  // ---- Store subscriptions ----
  // Each of these is a separate subscription; the component
  // re-renders when any of the four data values changes. The
  // action getters are stable references across renders, so
  // pulling them out here does not cause extra re-renders.
  const user = useUserStore((s) => s.user);
  const token = useUserStore((s) => s.token);
  const isLoading = useUserStore((s) => s.isLoading);
  const error = useUserStore((s) => s.error);
  const setUser = useUserStore((s) => s.setUser);
  const setToken = useUserStore((s) => s.setToken);
  const setLoading = useUserStore((s) => s.setLoading);
  const setError = useUserStore((s) => s.setError);
  const clearAuth = useUserStore((s) => s.clearAuth);

  // ---- refresh ----
  // Reads the main process's encrypted store and syncs the
  // renderer store to match. Used both by the bootstrap effect
  // below and (potentially) by a caller who knows the user's
  // backend record has changed.
  //
  // The IPC call is wrapped in a try/catch so that a failure —
  // say, the IPC channel is unregistered because the main
  // process has not finished starting up — does not leave the
  // store in a partially-updated state. The `finally` ensures
  // `isLoading` becomes false regardless of which branch ran:
  // the bootstrap's contract is to answer the "is there a
  // session?" question, and the answer "no, because the IPC
  // failed" is a legitimate outcome that the layout's auth gate
  // should treat the same as any other signed-out state.
  const refresh = useCallback(async (): Promise<void> => {
    try {
      const result = await window.electronAPI.auth.getUser();
      if (result.success && result.data) {
        setUser(result.data);
      } else {
        clearAuth();
      }
    } catch (err) {
      console.error('[useAuth] refresh failed:', err);
      clearAuth();
    } finally {
      setLoading(false);
    }
  }, [setUser, clearAuth, setLoading]);

  // ---- bootstrap ----
  // Runs the refresh sequence once, on the first mount of the
  // first component that uses this hook. See the file header
  // for why the guard is module-level and for how this behaves
  // under StrictMode.
  useEffect(() => {
    if (bootstrapHasRun) {
      return;
    }
    bootstrapHasRun = true;
    void refresh();
  }, [refresh]);

  // ---- login ----
  const login = useCallback(
    async (values: LoginFormValues): Promise<boolean> => {
      // Clear any stale error before the new attempt, so the
      // Login page's error banner does not show a message from a
      // previous failure while the new request is in flight.
      setError(null);

      try {
        const result = await window.electronAPI.auth.login({
          email: values.email,
          password: values.password,
        });

        if (result.success && result.data) {
          setUser(result.data.user);
          setToken(result.data.token);
          return true;
        }

        setError({
          message: result.error ?? 'Login failed. Please try again.',
        });
        return false;
      } catch (err) {
        console.error('[useAuth] login IPC failed:', err);
        setError({
          message: 'Unable to reach the server. Please try again.',
        });
        return false;
      }
    },
    [setUser, setToken, setError]
  );

  // ---- logout ----
  const logout = useCallback(async (): Promise<void> => {
    // Ask the main process to clear its encrypted store and
    // strip the bearer token from the shared axios client. If
    // that call fails, log it and continue — the user's intent
    // is to log out, and the local store's `clearAuth` below is
    // the operation that actually flips the UI's state.
    try {
      await window.electronAPI.auth.logout();
    } catch (err) {
      console.error('[useAuth] logout IPC failed:', err);
    }
    clearAuth();
  }, [clearAuth]);

  // ---- return ----
  return {
    user,
    token,
    isLoading,
    error,
    login,
    logout,
    refresh,
  };
};

// ============================================================
//  Default export
// ============================================================

/**
 * The hook as the default export, matching the convention used
 * by every other hook and store in the codebase. Consumers that
 * prefer the named form use `import { useAuth } from ...`;
 * consumers that prefer the default form use
 * `import useAuth from ...`. Both resolve to the same hook.
 */
export default useAuth;