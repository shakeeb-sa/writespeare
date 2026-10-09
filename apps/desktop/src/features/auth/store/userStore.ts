/**
 * Renderer-side auth store for the WriteSpeare desktop app.
 *
 * This is the renderer's in-memory (and localStorage-backed)
 * record of who is signed in. It holds four pieces of state:
 *
 *   user      — the current user object, or null when signed out.
 *   token     — the JWT bearer token, or null when signed out.
 *   isLoading — true while the app is determining whether a
 *               session exists. The layout's auth gate reads this
 *               to decide between "return null" and "evaluate
 *               user". See `Layout.tsx` for the gate's reasoning.
 *   error     — the last auth error, or null when the last auth
 *               operation (if any) succeeded or has not run yet.
 *
 * And five actions:
 *
 *   setUser, setToken, setLoading, setError — plain setters.
 *   clearAuth — resets user, token, and error to null in one
 *               call. This is what `logout()` ultimately invokes.
 *
 * The relationship to the main process's encrypted store:
 *
 *   The authoritative persisted copy of the session lives in the
 *   MAIN process, in `src/main/store.ts`, encrypted via
 *   `electron-store`'s AES-256 layer. That store is what survives
 *   an app restart and is what the main process uses to attach a
 *   bearer token to outgoing HTTP requests.
 *
 *   This store is the renderer's CACHE of that authoritative
 *   copy. On a successful login, the main process writes to its
 *   store and returns the user and token to the renderer, which
 *   writes them here. On cold start, the renderer reads its own
 *   persisted copy from `localStorage` — synchronously, before
 *   any IPC round trip — so the app's authenticated shell can
 *   render immediately, without a flash of the login page for
 *   users who are already signed in.
 *
 *   The two stores are kept in sync by the auth IPC handler
 *   (`authIPC.ts`, item #50 in Session 6): whenever the main
 *   process's store changes, the corresponding IPC channel
 *   carries the new value to the renderer, and this store's
 *   action is invoked. Whenever the renderer's store changes,
 *   it is because the main process has already updated itself.
 *   The renderer never originates a state change that the main
 *   process does not know about.
 *
 * Why `persist` writes to `localStorage` and not to the main
 * process's encrypted store:
 *
 *   The `persist` middleware from Zustand is the app's chosen
 *   mechanism for making a renderer-side store survive an app
 *   restart. It writes to `localStorage` because that is the
 *   only persistence surface available in the renderer's sandbox
 *   — the renderer has no filesystem access by design (see the
 *   golden rules).
 *
 *   The trade-off is that `localStorage` is not encrypted. A
 *   user with filesystem access to the app's `Local Storage`
 *   directory could read the token in plaintext. This is a
 *   deliberate acceptance: the token's blast radius is bounded
 *   by its seven-day expiry (see the backend's `jwt.ts`), the
 *   main process's copy of the token is encrypted, and any
 *   attacker with filesystem access to `localStorage` already
 *   has broad access to the user's machine. A future session
 *   that wants to close this gap would drop the `persist`
 *   middleware from this store and initialize it from the main
 *   process's encrypted copy on every cold start, at the cost
 *   of a brief asynchronous load.
 *
 * What is persisted and what is not:
 *
 *   `partialize` below persists only `user` and `token`. The
 *   `isLoading` and `error` fields are ephemeral — they are
 *   reset to their initial values on every app start regardless
 *   of what was in `localStorage`. Persisting `isLoading`
 *   would leave the app stuck in a loading state if it was
 *   killed mid-load; persisting `error` would show a user an
 *   error message from a session that ended hours ago.
 *
 * Why there is no `login` or `logout` action on this store:
 *
 *   The login and logout FLOWS are orchestrated by the auth IPC
 *   handler and the `useAuth` hook, not by the store itself.
 *   The store is purely a state container — it holds the values
 *   and provides setters, but it does not know how to talk to
 *   the backend, how to call the main process, or what the
 *   side effects of a successful login are. A `login` action on
 *   this store would need to import the API client, the IPC
 *   layer, and probably the toast system — which would couple
 *   the store to three other modules and make it harder to test
 *   in isolation.
 *
 *   Keeping the store as a pure state container is the same
 *   pattern used by every other Zustand store in the app: the
 *   store's job is to hold state and expose setters, and the
 *   hook's job is to compose those setters with the side effects
 *   that produce the state in the first place.
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

import type { User } from '../../shared/types/index.js';
import type { AuthError } from '../types/authTypes.js';

// ============================================================
//  State shape
// ============================================================

/**
 * The full shape of the auth store's state, including both the
 * data fields and the actions. Exported so that a consumer that
 * wants to type a parameter or a helper function can reference
 * the shape without redeclaring it.
 */
export interface UserStoreState {
  // ---- Data ----

  /** The current user, or null when signed out. */
  user: User | null;

  /** The JWT bearer token, or null when signed out. */
  token: string | null;

  /**
   * Whether the app is currently determining the session state.
   * `true` on first render, set to `false` after the cold-start
   * sequence either restores a session (via the persisted token
   * being validated) or determines that none exists.
   *
   * See `Layout.tsx` for how this flag drives the auth gate.
   */
  isLoading: boolean;

  /** The last auth error, or null. Cleared at the start of every
   *  new login attempt so a stale error does not linger. */
  error: AuthError | null;

  // ---- Actions ----

  /**
   * Set the current user. Pass null to clear. Setting the user
   * without also setting a token is a legal but unusual state —
   * the store does not enforce the invariant that a user
   * implies a token, because a future flow (a read-only mode, a
   * "logged in as a demo user" mode) might legitimately need it.
   * The currently-existing flows always set both together.
   */
  setUser: (user: User | null) => void;

  /**
   * Set the JWT bearer token. Pass null to clear.
   */
  setToken: (token: string | null) => void;

  /**
   * Set the loading flag. Called by the cold-start sequence and
   * by the login flow at the moments they want to signal that
   * work is in progress.
   */
  setLoading: (loading: boolean) => void;

  /**
   * Set or clear the last auth error. The login flow calls
   * `setError(null)` before every attempt so that a previous
   * failure's message is not shown during a retry.
   */
  setError: (error: AuthError | null) => void;

  /**
   * Clear all session-relevant fields in a single call. Resets
   * `user`, `token`, and `error` to null. Does NOT touch
   * `isLoading` — a caller that is clearing auth as part of a
   * logout will typically want to set `isLoading` to false
   * afterward, and conflating the two operations would make the
   * loading state harder to reason about.
   *
   * This is the single function that the `useAuth` hook's
   * `logout` ultimately invokes, and the single function the
   * main process's unauthorized-handler path will invoke when
   * the backend returns a 401 and the app must fall back to the
   * login screen.
   */
  clearAuth: () => void;
}

// ============================================================
//  Initial state
// ============================================================

/**
 * The store's initial data fields. Extracted as a constant so
 * that `clearAuth` can spread it into a new state object without
 * duplicating the null literals in two places.
 *
 * Note that `isLoading` starts as `true`. That is the correct
 * initial value: until the app's cold-start sequence has run,
 * the app does not know whether a session exists, and the layout
 * should render neither the dashboard nor the login page. See
 * `Layout.tsx` for how that decision is made.
 */
const INITIAL_STATE = {
  user: null,
  token: null,
  isLoading: true,
  error: null,
} as const;

// ============================================================
//  Store
// ============================================================

/**
 * The auth store.
 *
 * Created with `create<...>()(persist(...))` — the extra `()` after
 * the generic is required for TypeScript's type inference to work
 * correctly with Zustand's middleware type system. Without it, the
 * `persist` middleware's types would not propagate to the exported
 * hook, and consumers would lose the ability to destructure state
 * with proper narrowing.
 *
 * The `partialize` option is what limits persistence to `user` and
 * `token`. See the file header for why the two ephemeral fields
 * are excluded.
 */
export const useUserStore = create<UserStoreState>()(
  persist(
    (set) => ({
      // ---- Data ----
      ...INITIAL_STATE,

      // ---- Actions ----

      setUser: (user) => {
        set({ user });
      },

      setToken: (token) => {
        set({ token });
      },

      setLoading: (loading) => {
        set({ isLoading: loading });
      },

      setError: (error) => {
        set({ error });
      },

      clearAuth: () => {
        // Reset the three session-relevant fields in one call.
        // `isLoading` is deliberately not reset — see the
        // docstring on `clearAuth` in the interface above for
        // why.
        set({
          user: null,
          token: null,
          error: null,
        });
      },
    }),
    {
      /**
       * The key `localStorage` will use. Prefixed with the app
       * slug so that a developer inspecting the origin's storage
       * in DevTools can identify the entry as belonging to
       * WriteSpeare rather than to any other context that might
       * share the origin (in practice, nothing does — the
       * renderer runs from `file://` in production and from the
       * Vite dev server in development, both of which have their
       * own storage scopes).
       */
      name: 'writespeare-auth',

      /**
       * Use `localStorage` — the default `createJSONStorage`
       * surface in a browser context. Declared explicitly rather
       * than left to the default so that a reader who wonders
       * where the persisted bytes end up sees the answer here.
       */
      storage: createJSONStorage(() => localStorage),

      /**
       * Persist only the two session fields. The `isLoading` and
       * `error` fields are excluded — see the file header for the
       * reasoning.
       *
       * The returned object is typed against a subset of
       * `UserStoreState` — `Pick<UserStoreState, 'user' | 'token'>`
       * is the effective shape. Zustand's `persist` middleware
       * accepts a partial `partialize` return and merges the
       * persisted values over the initial state when it hydrates.
       */
      partialize: (state) => ({
        user: state.user,
        token: state.token,
      }),
    }
  )
);

// ============================================================
//  Default export
// ============================================================

/**
 * The hook as the default export, matching the convention used
 * by every other store and component file in the codebase.
 * Consumers that prefer the named form use
 * `import { useUserStore } from ...`; consumers that prefer the
 * default form use `import useUserStore from ...`. Both resolve
 * to the same hook.
 */
export default useUserStore;