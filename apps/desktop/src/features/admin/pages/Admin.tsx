/**
 * Admin — the admin panel page.
 *
 * Rendered at `/dashboard/admin` inside the authenticated shell
 * (see `renderer/App.tsx`). The page is the administrator's single
 * surface for user management: it lists every user account in the
 * system, exposes a "New User" button that opens the create-user
 * modal, and gives each row Edit and Delete actions.
 *
 * ── The three gates that keep this page admin-only ──────────────
 *
 *   Three independent layers protect this page, and all three are
 *   required because each closes a different gap:
 *
 *     1. THE ROUTER + LAYOUT. The `/dashboard/admin` route is
 *        nested under `<Layout />`, which performs the auth check
 *        and redirects an unauthenticated user to `/login`. A
 *        logged-in non-admin is NOT redirected by the layout —
 *        the layout only checks "is there a user?", not "what
 *        role does the user have?" — so this gate alone does
 *        not close the page to non-admins.
 *
 *     2. THE SIDEBAR. The Sidebar renders the "Admin" navigation
 *        link only when `user.role === 'admin'`. This closes
 *        the discoverability gap — a non-admin never sees the
 *        link — but it does not prevent a non-admin from
 *        navigating to `/dashboard/admin` by typing the URL.
 *
 *     3. THIS PAGE. The defensive check below renders an
 *        "administrator access required" panel when the
 *        authenticated user is not an admin, and skips the
 *        `loadUsers` call entirely so a non-admin's session
 *        never fires the IPC round trip.
 *
 *   The three gates are belt-and-braces on purpose. Each one
 *   alone is sufficient in a well-behaved session; the three
 *   together make the page correct even if a future refactor
 *   weakens one of them. The backend's `requireAdmin` middleware
 *   on the `/api/users` routes is the fourth, definitive gate —
 *   even if all three renderer gates failed, the backend would
 *   refuse every request the page makes.
 *
 * ── Why the page does not distinguish the caller's own account ──
 *
 *   The user list includes the caller. The page does NOT hide the
 *   caller's own row, does not prevent editing the caller's own
 *   account, and does not prevent deleting it beyond what the
 *   `UserList` component itself does. The plan's user journey
 *   does not describe a "cannot edit yourself" rule, and the
 *   backend's service explicitly leaves the self-delete guard to
 *   the renderer (see `userService.ts`'s header).
 *
 *   The one guard this page DOES participate in is self-delete:
 *   `UserList` receives the caller's ID and disables its own
 *   delete button on that row. The page passes the ID; the list
 *   decides how to render it. See `UserList.tsx` for the exact
 *   treatment when it is created.
 *
 * ── The four visual states ──────────────────────────────────────
 *
 *   The loaded body renders one of four states, driven by the
 *   store's `status` field and by whether the `users` array is
 *   populated:
 *
 *     1. LOADING — the store is fetching and no list is displayed
 *        yet. A centered spinner.
 *
 *     2. ERROR — the last fetch failed. A red banner with the
 *        message and a "Try again" button that re-fires
 *        `loadUsers`.
 *
 *     3. EMPTY — the fetch succeeded but the list has no
 *        entries. In practice this state is unreachable — the
 *        seeded admin is always present, so the list always
 *        contains at least one row. It is rendered anyway for
 *        the same reason every other page renders its empty
 *        state: a future change to the backend's list filter
 *        (a soft-delete that hides deactivated users, a
 *        pagination boundary that returns an empty page) could
 *        produce it, and a blank page with no explanation would
 *        be a confusing failure.
 *
 *     4. POPULATED — the list of user rows, rendered by the
 *        `UserList` component.
 *
 * ── The create/edit modal ───────────────────────────────────────
 *
 *   The modal is a single component — `UserForm` — that serves
 *   both "create a new user" and "edit an existing user". The
 *   mode is determined by whether the `user` prop passed to it
 *   is null (create) or a `User` object (edit). The page tracks
 *   which mode is active via its `editingUser` state and passes
 *   the right value.
 *
 *   The modal's open state is also page-owned: `formOpen`. This
 *   is the same controlled-component pattern used by the New
 *   Topic modal in `Topics.tsx` and by the Sidebar's collapsed
 *   state in `Layout.tsx`.
 *
 * ── The delete confirmation ─────────────────────────────────────
 *
 *   Deleting a user is irreversible from the UI's perspective —
 *   there is no undo. The delete button therefore opens a
 *   confirmation modal (through the shared `useModal()` API)
 *   rather than deleting immediately. On confirmation, the
 *   page calls `deleteUser(user._id)` from the hook, and fires
 *   a success or error toast based on the boolean the action
 *   resolves with. The store removes the row from its list on
 *   success, so the UserList re-renders without any additional
 *   work in this component.
 *
 *   The confirmation pattern is the same one `TopicCard.tsx` uses
 *   for its topic-delete confirmation, and the same one
 *   `DocumentList.tsx` uses for its document-delete confirmation.
 *   Consistency across the three destructive-action flows means a
 *   user who has seen one has seen all three.
 *
 * ── Forward references ──────────────────────────────────────────
 *
 *   The page imports two components that are scheduled for later
 *   steps in this same session:
 *
 *     `../components/UserList.js`  — step 145, "Table of users".
 *     `../components/UserForm.js`  — step 146, "Create/edit user
 *                                     modal".
 *
 *   Because this file is created BEFORE those two, it owns their
 *   prop interfaces by construction. When the two components are
 *   created in the next steps, they must accept exactly the props
 *   this file passes — if they don't, the compiler reports a
 *   TS2322 mismatch on the JSX call sites here, which is the
 *   correct signal that the interface has drifted.
 *
 *   Until the two files exist on disk, the imports produce two
 *   `TS2307` errors. That is EXPECTED and is documented in the
 *   TypeScript Integrity Check below.
 *
 * ── What this page does NOT do ──────────────────────────────────
 *
 *   - It does not implement preset management. The backend's
 *     admin routes expose four system-preset endpoints
 *     (`/api/admin/presets...`), but the plan's admin tree for
 *     the desktop declares no preset-management UI, and the
 *     preload declares no `admin.presets.*` methods. A future
 *     session that adds that UI would extend this page with a
 *     second tab or a second page; today the page is users-only.
 *
 *   - It does not paginate the user list. The backend returns
 *     every user in one call, and the page renders every row.
 *     A future session that needed pagination would add the
 *     controls to the `UserList` component and change the
 *     backend's list endpoint to accept a page cursor.
 *
 *   - It does not poll or refresh on a timer. The list loads on
 *     mount, and the local list is updated by the store's
 *     `createUser` / `updateUser` / `deleteUser` actions. A
 *     future "another admin just changed something" refresh
 *     would be a manual "Refresh" button on the toolbar.
 *
 *   - It does not navigate away on success. Creating or editing
 *     a user keeps the admin on the admin page — the row is
 *     added or updated in place. This matches the "manage a
 *     list of items" pattern the topics page uses.
 *
 * Dependencies: react + lucide-react + the four already-created
 * sibling modules + the two forward-referenced components. All
 * declared in package.json or in the codebase.
 */

import {
  useCallback,
  useEffect,
  useState,
} from 'react';
import {
  AlertCircle,
  Loader2,
  Plus,
  ShieldCheck,
} from 'lucide-react';

import { useAdmin } from '../hooks/useAdmin.js';
import { useAuth } from '../../auth/hooks/useAuth.js';
import { useToast } from '../../shared/hooks/useToast.js';
import { useModal } from '../../shared/components/Modal.js';
import UserList from '../components/UserList.js';
import UserForm from '../components/UserForm.js';
import type { User } from '../../shared/types/index.js';

// ============================================================
//  Public types
// ============================================================

/**
 * The props accepted by `Admin`. Currently empty — the page takes
 * no props and derives everything from the admin store, the auth
 * store, and the shared toast and modal contexts.
 *
 * The interface is declared anyway so that a future addition
 * (for example, an `initialFilter` prop for a deep link that
 * wants to open the panel pre-filtered by role) has a named,
 * exported home.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface AdminProps {
  // Reserved for future additions. See interface docstring.
}

// ============================================================
//  Admin — the main component
// ============================================================

/**
 * The admin panel page. See the file header for the page's
 * responsibilities, the three-gate admin check, and the reasoning
 * behind the four visual states.
 */
export const Admin = (_props: AdminProps = {}) => {
  const { user: currentUser } = useAuth();
  const toast = useToast();
  const modal = useModal();
  const {
    users,
    status,
    error,
    loadUsers,
    deleteUser,
    clearError,
  } = useAdmin();

  // ---- Local state ----
  // The form's open/closed flag and the user being edited (null
  // when the form is in "create" mode). These two pieces of
  // state are the page's only locally-owned UI concerns — every
  // other piece of state comes from the admin store.
  const [formOpen, setFormOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<User | null>(null);

  // ---- Role gate ----
  // The defensive role check the file header describes. The
  // value is derived once per render from the auth store's
  // `user` field; a role change (an admin demoting themselves,
  // another admin demoting them) re-renders this component and
  // flips the value the next time the store updates.
  const isAdmin = currentUser?.role === 'admin';

  // ---- Load on mount (admins only) ----
  // The `isAdmin` guard on the effect is what keeps a non-admin
  // session from firing the `loadUsers` IPC call. The store
  // itself does not check the role — it trusts its caller —
  // so the guard has to be here, at the point where the fetch
  // is triggered.
  //
  // The dependency on `loadUsers` (a stable Zustand action
  // reference) means the effect fires exactly once per session,
  // and only after the auth store has populated the user. If
  // the user is still loading on first render, `isAdmin` is
  // false, the effect returns early, and the next render — once
  // the user has loaded — fires the fetch.
  useEffect(() => {
    if (isAdmin) {
      void loadUsers();
    }
  }, [isAdmin, loadUsers]);

  // ---- Handlers ----

  /**
   * Open the modal in create mode. Setting `editingUser` to null
   * is what tells the form to start from an empty state; the
   * `formOpen` flag is what actually shows the modal.
   */
  const handleNewUser = useCallback((): void => {
    setEditingUser(null);
    setFormOpen(true);
  }, []);

  /**
   * Open the modal in edit mode with the given user pre-populated.
   */
  const handleEditUser = useCallback((user: User): void => {
    setEditingUser(user);
    setFormOpen(true);
  }, []);

  /**
   * Close the modal without saving. Used by the modal's own
   * Cancel button and by the callback the form fires after a
   * successful save.
   */
  const handleCloseForm = useCallback((): void => {
    setFormOpen(false);
    setEditingUser(null);
  }, []);

  /**
   * Fired by the form after a successful save. The form itself
   * fires the appropriate success toast; this handler only needs
   * to close the modal and clear the editing target.
   */
  const handleFormSuccess = useCallback((): void => {
    setFormOpen(false);
    setEditingUser(null);
  }, []);

  /**
   * Open the delete-confirmation modal for a user. The modal's
   * "Delete" button fires the actual delete and closes the
   * modal on the same click.
   *
   * The confirmation content names the user's email so the admin
   * sees exactly which account they are about to remove.
   */
  const handleDelete = useCallback(
    (user: User): void => {
      modal.open({
        title: 'Delete user?',
        variant: 'danger',
        size: 'sm',
        content: (
          <p>
            Are you sure you want to delete the account for{' '}
            <strong className="font-semibold">{user.email}</strong>?
            This cannot be undone.
          </p>
        ),
        footer: (
          <>
            <button
              type="button"
              onClick={() => modal.close()}
              className={
                'rounded-lg border border-neutral-300 bg-background ' +
                'px-4 py-2 text-sm font-medium text-text ' +
                'transition-colors hover:bg-neutral-100 ' +
                'dark:border-neutral-700 dark:hover:bg-neutral-800 ' +
                'focus-visible:outline-none'
              }
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => {
                modal.close();
                void (async (): Promise<void> => {
                  const ok = await deleteUser(user._id);
                  if (ok) {
                    toast.success(`Deleted ${user.email}`);
                  } else {
                    toast.error('Failed to delete user.');
                  }
                })();
              }}
              className={
                'rounded-lg bg-red-600 px-4 py-2 text-sm ' +
                'font-medium text-white transition-colors ' +
                'hover:bg-red-700 focus-visible:outline-none'
              }
            >
              Delete
            </button>
          </>
        ),
      });
    },
    [modal, deleteUser, toast]
  );

  /**
   * Re-fire the user-list fetch from the error state's "Try
   * again" button. Clears the previous error before the retry so
   * the banner does not linger during the in-flight request.
   */
  const handleRetry = useCallback((): void => {
    clearError();
    void loadUsers();
  }, [clearError, loadUsers]);

  // ---- Render: not admin ----
  // Defensive early return. See the file header's "three gates"
  // note for the reasoning on why this check is on the page at
  // all when the sidebar and the backend already enforce it.
  if (!isAdmin) {
    return (
      <div className="mx-auto flex h-full w-full max-w-2xl items-center justify-center px-6 py-8">
        <div
          role="alert"
          className={
            'flex flex-col items-center gap-3 rounded-xl border ' +
            'border-neutral-200 bg-background p-8 text-center ' +
            'dark:border-neutral-800'
          }
        >
          <div
            className={
              'flex h-14 w-14 items-center justify-center ' +
              'rounded-2xl bg-neutral-100 text-neutral-500 ' +
              'dark:bg-neutral-800 dark:text-neutral-400'
            }
          >
            <ShieldCheck size={28} aria-hidden="true" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-text dark:text-neutral-100">
              Administrator access required
            </h2>
            <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
              This page is only available to administrators. Ask
              an admin of this installation to grant you access.
            </p>
          </div>
        </div>
      </div>
    );
  }

  // ---- Render: loading ----
  // The `status === 'loading'` branch with no users yet in the
  // list. A re-fetch that already has a list to display keeps the
  // list visible — see the "try again" flow, which reuses the
  // same loaded branch.
  const isInitialLoad = status === 'loading' && users.length === 0;

  return (
    <div className="mx-auto flex h-full w-full max-w-4xl flex-col px-6 py-8">
      {/* ---- Header ---- */}
      <header className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-text dark:text-neutral-100">
            Admin
          </h1>
          <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
            Manage user accounts and access for this installation.
          </p>
        </div>
        <button
          type="button"
          onClick={handleNewUser}
          className={
            'inline-flex items-center gap-2 rounded-lg ' +
            'bg-primary px-4 py-2 text-sm font-medium ' +
            'text-white transition-colors hover:bg-primary-dark ' +
            'focus-visible:outline-none'
          }
        >
          <Plus size={18} aria-hidden="true" />
          <span>New User</span>
        </button>
      </header>

      {/* ---- Body ---- */}
      <div className="flex-1">
        {/* ---- State: LOADING ---- */}
        {isInitialLoad && (
          <div className="flex h-64 items-center justify-center">
            <Loader2
              size={28}
              className="animate-spin text-primary"
              aria-hidden="true"
            />
            <span className="sr-only">Loading users…</span>
          </div>
        )}

        {/* ---- State: ERROR ---- */}
        {/* Shown only when the fetch failed AND there is no list
            to fall back on. If a previous fetch succeeded and a
            re-fetch fails, the loaded list is kept visible and
            the error is surfaced as a toast by the store's own
            action — the empty-state condition below never fires
            over a populated list. */}
        {!isInitialLoad && status === 'error' && error !== null && users.length === 0 && (
          <div
            role="alert"
            className={
              'mx-auto flex max-w-lg flex-col items-center gap-3 ' +
              'rounded-xl border border-red-200 bg-red-50 p-6 ' +
              'text-center dark:border-red-900 ' +
              'dark:bg-red-950/60'
            }
          >
            <AlertCircle
              size={24}
              className="text-red-600 dark:text-red-400"
              aria-hidden="true"
            />
            <p className="text-sm text-red-900 dark:text-red-100">
              {error}
            </p>
            <button
              type="button"
              onClick={handleRetry}
              className={
                'rounded-lg bg-red-600 px-4 py-2 text-sm ' +
                'font-medium text-white transition-colors ' +
                'hover:bg-red-700 focus-visible:outline-none'
              }
            >
              Try again
            </button>
          </div>
        )}

        {/* ---- State: EMPTY ---- */}
        {/* Unreachable in normal operation — the seeded admin is
            always in the list — but rendered for the defensive
            reasons the file header documents. */}
        {!isInitialLoad &&
          status !== 'error' &&
          users.length === 0 && (
            <div className="mx-auto flex max-w-md flex-col items-center gap-4 py-16 text-center">
              <div
                className={
                  'flex h-14 w-14 items-center justify-center ' +
                  'rounded-2xl bg-neutral-100 text-neutral-500 ' +
                  'dark:bg-neutral-800 dark:text-neutral-400'
                }
              >
                <ShieldCheck size={28} aria-hidden="true" />
              </div>
              <div>
                <h2 className="text-lg font-semibold text-text dark:text-neutral-100">
                  No users found
                </h2>
                <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
                  The user list is empty. Create the first account
                  with the button above.
                </p>
              </div>
            </div>
          )}

        {/* ---- State: POPULATED ---- */}
        {users.length > 0 && (
          <UserList
            users={users}
            currentUserId={currentUser?._id}
            onEdit={handleEditUser}
            onDelete={handleDelete}
          />
        )}
      </div>

      {/* ---- Create/edit modal ---- */}
      {/* The modal is mounted unconditionally. The `open` prop
          controls its visibility; the form itself is a no-op
          when `open` is false — it renders nothing and holds
          no state that would need cleaning up. The `user` prop
          tells the form which mode it is in (null = create,
          non-null = edit). */}
      <UserForm
        open={formOpen}
        user={editingUser}
        onClose={handleCloseForm}
        onSuccess={handleFormSuccess}
      />
    </div>
  );
};

// ============================================================
//  Default export
// ============================================================

/**
 * The `Admin` component as the default export. The router in
 * `renderer/App.tsx` imports it with the default form
 * (`import Admin from '.../Admin.js'`), so this is the export
 * that keeps the route tree resolving.
 */
export default Admin;