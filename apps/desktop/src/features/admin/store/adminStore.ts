/**
 * adminStore — the renderer's state for the admin feature.
 *
 * Holds the state that drives the admin panel at
 * `/dashboard/admin`:
 *
 *   users    — the list of every user in the system, as returned
 *              by the backend's `GET /api/users` endpoint.
 *   status   — the store's async lifecycle state.
 *   error    — the last error message, or null.
 *
 * And the actions the admin panel calls to drive those
 * operations:
 *
 *   loadUsers    — fetch the user list.
 *   createUser   — create a new user account.
 *   updateUser   — apply a partial update to an existing account
 *                  (email, password, role, active flag).
 *   deleteUser   — remove an account.
 *   clearError   — dismiss the last error message.
 *   reset        — return every field to its initial value.
 *
 * ── The inverted ownership model ────────────────────────────────
 *
 *   Every other feature store in this codebase is scoped to the
 *   CALLER's own records: the topics store holds the caller's
 *   topics, the documents store holds the caller's documents, the
 *   settings store holds the caller's settings. Their actions
 *   read and write only what belongs to the authenticated user,
 *   and the backend enforces that isolation on every request.
 *
 *   The admin store is the exception. It holds records that
 *   belong to OTHER users — every account in the system, or at
 *   least every account the backend's user-list endpoint returns.
 *   The store does not scope anything to the caller; the caller
 *   is an administrator acting on arbitrary accounts.
 *
 *   The authorization boundary that replaces the usual ownership
 *   filter is the `requireAdmin` middleware on the backend's
 *   `/api/users` routes (see `userRoutes.ts`). The store does not
 *   re-check the caller's role — the renderer's `Layout`
 *   component decides whether to even render the admin route
 *   (see `App.tsx` and `Sidebar.tsx`), and the backend refuses
 *   any request that arrives without admin credentials. Those
 *   two gates are what make this store's "no ownership scoping"
 *   design safe.
 *
 * ── Why the store is NOT persisted ──────────────────────────────
 *
 *   Same reasoning as `topicStore.ts`, `researchStore.ts`, and
 *   `settingsStore.ts`: the users list is server-authoritative
 *   and changes on the backend whenever any administrator
 *   creates, edits, or deletes an account. Caching the list
 *   across app restarts would let the renderer show stale data
 *   — a user that was deleted from another admin's session would
 *   still appear until the next refresh, and a new user would be
 *   absent until the next refresh. The store therefore does not
 *   use Zustand's `persist` middleware, and the admin panel calls
 *   `loadUsers` on every mount.
 *
 * ── Why there is no marker subscription ─────────────────────────
 *
 *   Every feature store that drives a Python pipeline stage —
 *   `researchStore`, `documentStore`, `writerStore`,
 *   `validationStore` — installs a module-load listener on the
 *   `research:marker` channel and reacts to the marker types its
 *   stage owns. The admin feature has no Python stage and
 *   therefore no markers: every operation is a request-response
 *   HTTP call to the backend. The store's state changes only
 *   when its own actions resolve.
 *
 *   The absence is deliberate, not an oversight. Adding a marker
 *   listener here would be a subscription that never receives a
 *   relevant message.
 *
 * ── Why the actions do IPC rather than the hook ─────────────────
 *
 *   Same pattern as `topicStore.ts`: the plan's file tree places
 *   the admin feature's state and its async operations on the
 *   store, not on the `useAdmin` hook. The hook (`useAdmin.ts`)
 *   is a thin pass-through that exposes the store's fields and
 *   actions to components. The store's `createUser`, `updateUser`,
 *   and `deleteUser` actions each perform their own IPC round
 *   trip and their own state update; the hook does not wrap
 *   either.
 *
 *   The alternative — moving the IPC calls into the hook and
 *   reducing the store to pure state — would contradict the
 *   pattern every other feature follows and would split each
 *   operation across two files. The current design keeps each
 *   operation co-located with the state it mutates.
 *
 * ── What this store does NOT do ─────────────────────────────────
 *
 *   - It does not touch the settings feature's presets. The
 *     backend's admin service manages system-wide presets
 *     (`userId: null`) via the admin routes, but the plan's
 *     admin tree for the desktop declares no preset-management
 *     UI. If a future session adds one, this store would gain a
 *     parallel set of actions for the preset endpoints, or a
 *     sibling store would be created for them. Today the admin
 *     panel manages users only.
 *
 *   - It does not cache individual user records. The whole list
 *     is loaded at once and every mutation refreshes or patches
 *     it. A per-record cache would add a second source of truth
 *     for the same data.
 *
 *   - It does not distinguish "the current user" from the rest
 *     of the list. The store holds every user the backend
 *     returns, including the caller. The UI is responsible for
 *     highlighting or excluding the caller's own account when
 *     that distinction matters — for example, a future "cannot
 *     delete yourself" guard would live in the UI, not here.
 *
 *   - It does not touch the auth store. Logging a user out,
 *     refreshing a user's token, and clearing a deleted user's
 *     session are concerns of the auth feature. If a future
 *     session wants to react to a user deletion by invalidating
 *     that user's session, the reaction belongs in the backend's
 *     delete path, not in this store.
 */

import { create } from 'zustand';

import type {
  User,
  UserCreatePayload,
  UserUpdatePayload,
} from '../../shared/types/index.js';

// ============================================================
//  Public types
// ============================================================

/**
 * The three-value lifecycle of the store's async activity. Same
 * shape as every other feature store's status type.
 *
 *   'idle'    — no operation is in progress, and the last one
 *               (if any) succeeded. The default state.
 *   'loading' — a load or a save is in flight.
 *   'error'   — the last operation failed. The `error` field
 *               carries a user-facing message. The next
 *               operation to start resets both fields.
 */
export type AdminStoreStatus = 'idle' | 'loading' | 'error';

/**
 * The full shape of the admin store's state, including both the
 * data fields and the actions. Exported so that a consumer that
 * wants to type a parameter or a helper function can reference
 * the shape without redeclaring it.
 */
export interface AdminStoreState {
  // ---- Data ----

  /**
   * The list of every user in the system, in the order the
   * backend returned them (newest first). Empty until the first
   * `loadUsers` call completes.
   */
  users: User[];

  /** The store's async lifecycle state. */
  status: AdminStoreStatus;

  /** The last error message, or null. */
  error: string | null;

  // ---- Async actions ----

  /**
   * Fetch the full user list. Invokes `window.electronAPI.admin.listUsers`
   * and replaces the local list with the result.
   *
   * An empty list is a legitimate response — a fresh installation
   * with no users other than the seeded admin would return a
   * single-element list, not an empty one, but the contract is
   * "whatever the backend returns". The store does not
   * distinguish empty from non-empty.
   */
  loadUsers: () => Promise<void>;

  /**
   * Create a new user account. Invokes
   * `window.electronAPI.admin.createUser` with the supplied
   * payload.
   *
   * On success, prepends the created user to the local list so
   * the panel re-renders with the new account visible at the
   * top.
   *
   * Resolves with the created `User` on success, or null on
   * failure. The caller can use the return value to decide
   * whether to close a modal or fire a toast.
   */
  createUser: (payload: UserCreatePayload) => Promise<User | null>;

  /**
   * Apply a partial update to an existing user account. Invokes
   * `window.electronAPI.admin.updateUser` with the target id and
   * the patch.
   *
   * On success, replaces the corresponding element of the local
   * list with the updated record. The list's order is preserved
   * — a user's position does not change because their role or
   * email was edited.
   *
   * Resolves with the updated `User` on success, or null on
   * failure.
   */
  updateUser: (
    userId: string,
    patch: UserUpdatePayload
  ) => Promise<User | null>;

  /**
   * Delete a user account. Invokes
   * `window.electronAPI.admin.deleteUser` with the target id.
   *
   * On success, removes the user from the local list.
   *
   * Resolves with `true` on success, `false` on failure. The
   * boolean lets the caller decide whether to fire a success
   * toast.
   */
  deleteUser: (userId: string) => Promise<boolean>;

  // ---- Sync actions ----

  /** Clear the last error message. */
  clearError: () => void;

  /** Reset every field to its initial value. */
  reset: () => void;
}

// ============================================================
//  Initial state
// ============================================================

/**
 * The store's initial data fields. Extracted as a constant so
 * `reset` can spread it into a new state object without
 * duplicating the literals.
 */
const INITIAL_STATE = {
  users: [] as User[],
  status: 'idle' as AdminStoreStatus,
  error: null as string | null,
};

// ============================================================
//  Store
// ============================================================

/**
 * The admin store. See the file header for its responsibilities,
 * the inverted ownership model, and the reasoning behind its
 * design.
 *
 * Created without middleware — no `persist` (see the file
 * header), no `devtools`, no Immer. The `create<...>()` form
 * with the extra `()` after the generic is required for
 * Zustand's type inference to work correctly when a store has
 * both state and actions; it is the same pattern every other
 * store in the codebase uses.
 */
export const useAdminStore = create<AdminStoreState>((set, get) => ({
  // ---- Initial data ----
  ...INITIAL_STATE,

  // ============================================================
  //  loadUsers
  // ============================================================

  loadUsers: async (): Promise<void> => {
    // Flip the status to loading and clear any previous error.
    // The error clear is deliberate — a panel that was showing
    // an error from a previous load attempt should not still
    // show it while a new attempt is in flight.
    set({ status: 'loading', error: null });

    try {
      const result = await window.electronAPI.admin.listUsers();

      if (result.success && result.data) {
        set({ users: result.data, status: 'idle' });
      } else {
        set({
          status: 'error',
          error: result.error ?? 'Failed to load users.',
        });
      }
    } catch (err) {
      // The `window.electronAPI.admin.listUsers` call itself can
      // reject if the IPC channel is unregistered — for example,
      // during the window between the app's startup and the
      // `registerAdminIPC()` call in the main process. The catch
      // converts that rejection into the same error state the
      // response-envelope failure path produces, so the panel's
      // render logic does not need two cases.
      console.error('[adminStore] loadUsers failed:', err);
      set({
        status: 'error',
        error:
          err instanceof Error
            ? err.message
            : 'Unable to load users.',
      });
    }
  },

  // ============================================================
  //  createUser
  // ============================================================

  createUser: async (payload: UserCreatePayload): Promise<User | null> => {
    // The create path flips `status` to 'loading' so the panel
    // can disable its form and show a spinner on the submit
    // button. The alternative (silent in-flight creates) would
    // let a user click the button twice and produce a duplicate
    // account or a duplicate-key error.
    set({ status: 'loading', error: null });

    try {
      const result =
        await window.electronAPI.admin.createUser(payload);

      if (result.success && result.data) {
        const created = result.data;
        // Prepend to the list — the backend sorts newest first,
        // so a newly-created user belongs at the top. The
        // alternative (refetching the full list) would add a
        // round trip for data the create response already
        // contains.
        set((state) => ({
          users: [created, ...state.users],
          status: 'idle',
        }));
        return created;
      }

      set({
        status: 'error',
        error: result.error ?? 'Failed to create user.',
      });
      return null;
    } catch (err) {
      console.error('[adminStore] createUser failed:', err);
      set({
        status: 'error',
        error:
          err instanceof Error
            ? err.message
            : 'Unable to create user.',
      });
      return null;
    }
  },

  // ============================================================
  //  updateUser
  // ============================================================

  updateUser: async (
    userId: string,
    patch: UserUpdatePayload
  ): Promise<User | null> => {
    set({ status: 'loading', error: null });

    try {
      const result = await window.electronAPI.admin.updateUser(
        userId,
        patch
      );

      if (result.success && result.data) {
        const updated = result.data;
        // Replace the corresponding list element. The filter-
        // and-map pattern preserves the list's order — a user's
        // position is determined by their `createdAt`, not by
        // the fields the update touched.
        set((state) => ({
          users: state.users.map((u) =>
            u._id === userId ? updated : u
          ),
          status: 'idle',
        }));
        return updated;
      }

      set({
        status: 'error',
        error: result.error ?? 'Failed to update user.',
      });
      return null;
    } catch (err) {
      console.error('[adminStore] updateUser failed:', err);
      set({
        status: 'error',
        error:
          err instanceof Error
            ? err.message
            : 'Unable to update user.',
      });
      return null;
    }
  },

  // ============================================================
  //  deleteUser
  // ============================================================

  deleteUser: async (userId: string): Promise<boolean> => {
    // Unlike the load and create actions, `deleteUser` does not
    // flip `status` to 'loading'. A delete is usually initiated
    // from a row in the user list, and the list should stay
    // visible during the operation — a full panel-level loading
    // state would replace the entire list with a spinner, which
    // is more disruptive than the operation warrants. The caller
    // is responsible for showing a row-level spinner or
    // disabled state.
    try {
      const result =
        await window.electronAPI.admin.deleteUser(userId);

      if (result.success) {
        set((state) => ({
          users: state.users.filter((u) => u._id !== userId),
        }));
        return true;
      }

      set({ error: result.error ?? 'Failed to delete user.' });
      return false;
    } catch (err) {
      console.error('[adminStore] deleteUser failed:', err);
      set({
        error:
          err instanceof Error
            ? err.message
            : 'Unable to delete user.',
      });
      return false;
    }
  },

  // ============================================================
  //  Sync actions
  // ============================================================

  clearError: (): void => {
    set({ error: null });
    if (get().status === 'error') {
      set({ status: 'idle' });
    }
  },

  reset: (): void => {
    set({ ...INITIAL_STATE });
  },
}));

// ============================================================
//  Default export
// ============================================================

/**
 * The hook as the default export, matching the convention used
 * by every other store in the codebase. Consumers that prefer
 * the named form use `import { useAdminStore } from ...`;
 * consumers that prefer the default form use
 * `import useAdminStore from ...`. Both resolve to the same
 * hook.
 */
export default useAdminStore;