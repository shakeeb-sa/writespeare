/**
 * useAdmin — the renderer's admin hook.
 *
 * The single entry point through which the app's components read
 * and manipulate the admin feature's state. It sits over
 * `useAdminStore` and mirrors the role every sibling hook plays
 * for its own feature:
 *
 *   - The store owns the state. The hook does not add any.
 *
 *   - The store owns the async actions that reach the IPC layer
 *     and, through it, the main process. The hook does not
 *     reimplement them.
 *
 *   - The hook's only job is to give a component a single, stable
 *     object with everything the admin feature exposes — the
 *     three data fields and the six actions.
 *
 * ── The hook's API ──────────────────────────────────────────────
 *
 *   Data fields:
 *
 *     users    The list of every user in the system, as returned
 *              by the backend's `GET /api/users` endpoint. Empty
 *              until the first `loadUsers()` call completes.
 *
 *     status   The store's async lifecycle state — 'idle',
 *              'loading', or 'error'.
 *
 *     error    The last error message, or null.
 *
 *   Actions:
 *
 *     loadUsers()                Fetch the full user list.
 *     createUser(payload)        Create a new account. Resolves
 *                                with the created `User` or null.
 *     updateUser(id, patch)      Apply a partial update. Resolves
 *                                with the updated `User` or null.
 *     deleteUser(id)             Remove an account. Resolves with
 *                                `true` on success, `false` on
 *                                failure.
 *     clearError()               Dismiss the last error message.
 *     reset()                    Reset the store to its initial
 *                                state.
 *
 * ── Why the hook is a straight re-export of the store's surface ──
 *
 *   Same reasoning as every sibling hook. The store's four async
 *   actions already do their own IPC calls and their own state
 *   updates; the store's `clearError` and `reset` actions are
 *   pure setters. Every action the hook exposes is a direct
 *   reference to the store's own action — there is no
 *   composition to perform.
 *
 *   The hook's value is in two places:
 *
 *     (a) A stable import path. Components write
 *         `import { useAdmin } from '../hooks/useAdmin.js'`
 *         rather than reaching into the store module and
 *         selecting five fields by hand.
 *
 *     (b) The `AdminHookValue` interface. It declares the hook's
 *         shape as a single, exported type so a helper function
 *         that takes "an instance of the admin hook" as a
 *         parameter can be typed against it without
 *         redeclaring the shape.
 *
 * ── Why the hook subscribes to each data field separately ───────
 *
 *   Zustand re-renders a component when any of the selectors it
 *   subscribed to returns a different value. Subscribing to each
 *   of the three data fields through its own selector gives the
 *   finest-grained re-render behavior that Zustand supports for
 *   a multi-field read: a change to `status` does not re-render a
 *   component whose only visible effect was `users`, because
 *   `users` did not change.
 *
 *   The alternative — a single `useAdminStore((s) => s)` call —
 *   would re-render on every store change and would require a
 *   shallow-equality comparator to avoid wasted renders. The
 *   per-field form is the recommended Zustand pattern and the
 *   one this hook follows.
 *
 * ── Why the actions are selected directly from the store ────────
 *
 *   Zustand's `create` runs its state creator exactly once per
 *   store instance, and the functions returned by that creator
 *   are the same references for the entire life of the store.
 *   That means the action references obtained from
 *   `useAdminStore((s) => s.loadUsers)` are already stable across
 *   renders — a `useCallback` wrapper around them would be
 *   redundant.
 *
 *   The same pattern is used by every sibling hook. The one
 *   exception in the codebase is `useAuth.ts`, whose `login` and
 *   `logout` actions are composed functions defined inside the
 *   hook body; those need `useCallback` to be stable. The admin
 *   hook has no such composed functions.
 *
 * ── What this hook does NOT do ──────────────────────────────────
 *
 *   - It does not call `loadUsers` on mount. The hook is a
 *     passive reader; the component that mounts it decides when
 *     to fetch. The `Admin` page calls `loadUsers()` in its own
 *     `useEffect`; a component that only wants to read the error
 *     state or invoke `deleteUser` does not have to trigger a
 *     fetch to get it.
 *
 *   - It does not guard against the "not an admin" case. The
 *     backend enforces the role check via `requireAdmin`
 *     middleware on every `/api/users` route, and the renderer's
 *     `Layout` / `Sidebar` decide whether to even render the
 *     `/dashboard/admin` route. A non-admin user who somehow
 *     reached a component that called `useAdmin()` would find
 *     that every action resolves with an error envelope — the
 *     backend refuses the request. The hook trusts those two
 *     gates and does not re-check the role.
 *
 *   - It does not expose the store's `set` or `get` functions.
 *     Components that need to mutate state go through the store's
 *     named actions, which are the ones that carry the correct
 *     semantics.
 *
 *   - It does not distinguish "the current user" from the rest
 *     of the list. The store returns every user the backend
 *     provides, including the caller. The UI is responsible for
 *     handling that distinction — for example, a "cannot delete
 *     yourself" guard would live in the page component, not here.
 */

import {
  useAdminStore,
  type AdminStoreStatus,
} from '../store/adminStore.js';
import type {
  User,
  UserCreatePayload,
  UserUpdatePayload,
} from '../../shared/types/index.js';

// ============================================================
//  Public types
// ============================================================

/**
 * The shape of the object returned by `useAdmin()`.
 *
 * Exported so that a helper function that takes "an instance of
 * the admin hook" as a parameter can be typed against the
 * interface without redeclaring the shape. A component that
 * destructures the return value does not need to reference the
 * interface at all.
 *
 * The interface mirrors `AdminStoreState`'s members one-to-one:
 * three data fields and six actions. The hook is a straight
 * exposure of the store's public surface.
 */
export interface AdminHookValue {
  // ---- Data ----

  /** The list of every user in the system, sorted by the backend
   *  (newest first). Empty until the first `loadUsers` call
   *  completes. */
  users: User[];

  /** The store's async lifecycle state. See `AdminStoreStatus`
   *  in `adminStore.ts` for the meaning of each value. */
  status: AdminStoreStatus;

  /** The last error message from an async action, or null. */
  error: string | null;

  // ---- Actions ----

  /** Fetch the full user list. Resolves when the operation
   *  completes (success or failure). The store's `status` and
   *  `error` fields reflect the outcome. */
  loadUsers: () => Promise<void>;

  /** Create a new user account. Resolves with the created `User`
   *  on success, or null on failure. */
  createUser: (payload: UserCreatePayload) => Promise<User | null>;

  /** Apply a partial update to a user account. Resolves with the
   *  updated `User` on success, or null on failure. */
  updateUser: (
    userId: string,
    patch: UserUpdatePayload
  ) => Promise<User | null>;

  /** Remove a user account. Resolves with `true` on success,
   *  `false` on failure. */
  deleteUser: (userId: string) => Promise<boolean>;

  /** Clear the last error message. */
  clearError: () => void;

  /** Reset the store to its initial state. */
  reset: () => void;
}

// ============================================================
//  The hook
// ============================================================

/**
 * Return the admin feature's state and its actions. See the file
 * header for the hook's role, its relationship to the store, and
 * the reasoning behind the design choices.
 */
export const useAdmin = (): AdminHookValue => {
  // ---- Data subscriptions ----
  // One selector per data field. See the file header for why the
  // fields are read individually rather than as one object.
  const users = useAdminStore((s) => s.users);
  const status = useAdminStore((s) => s.status);
  const error = useAdminStore((s) => s.error);

  // ---- Action subscriptions ----
  // Zustand actions are stable references for the life of the
  // store, so selecting them here does not cause re-renders and
  // does not require `useCallback` around them. See the file
  // header for the reasoning.
  const loadUsers = useAdminStore((s) => s.loadUsers);
  const createUser = useAdminStore((s) => s.createUser);
  const updateUser = useAdminStore((s) => s.updateUser);
  const deleteUser = useAdminStore((s) => s.deleteUser);
  const clearError = useAdminStore((s) => s.clearError);
  const reset = useAdminStore((s) => s.reset);

  // ---- Return ----
  // A single object literal with all nine members. The order
  // matches the interface above, so a reader comparing the two
  // does not have to hunt for a member's position.
  return {
    users,
    status,
    error,
    loadUsers,
    createUser,
    updateUser,
    deleteUser,
    clearError,
    reset,
  };
};

// ============================================================
//  Default export
// ============================================================

/**
 * The hook as the default export, matching the convention used
 * by every other hook and store in the codebase. Consumers that
 * prefer the named form use `import { useAdmin } from ...`;
 * consumers that prefer the default form use
 * `import useAdmin from ...`. Both resolve to the same hook.
 */
export default useAdmin;