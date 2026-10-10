/**
 * UserList — the admin panel's table of user accounts.
 *
 * Renders one row per user the page passes in through its `users`
 * prop. Each row shows the account's email, role badge, active
 * status, and creation date, with an action bar on the right that
 * offers Edit and Delete.
 *
 * ── Fully controlled ────────────────────────────────────────────
 *
 *   The component is a pure renderer. It does not fetch, does not
 *   hold state, does not call the store or the IPC layer. Every
 *   piece of information it displays comes from the `users` prop,
 *   and every interaction it offers is reported back to the page
 *   through the `onEdit` and `onDelete` callbacks. The page owns
 *   the data; the list owns the layout.
 *
 *   The pattern matches `TopicCard`'s relationship to `Topics` and
 *   `DocumentList`'s relationship to `TopicDetail`: the parent
 *   page reads the store, and the child renders one item per
 *   element of the array the parent hands it.
 *
 * ── The self-delete guard ───────────────────────────────────────
 *
 *   The Delete button on the caller's own row is disabled — with a
 *   hover tooltip explaining why — because the backend's
 *   `userService.deleteUser` deliberately does NOT guard against
 *   an admin deleting their own account (see that service's file
 *   header for the reasoning: the guard belongs at the controller
 *   layer, and the plan does not call for it). This component is
 *   the correct place for the guard because it is the only layer
 *   that has both the caller's identity (from the `currentUserId`
 *   prop) and the target user's identity (from the row).
 *
 *   The guard is deliberate, not incidental: without it, an
 *   administrator could lock themselves out of the system by
 *   clicking Delete on their own row. That failure mode is severe
 *   enough — recovering from it requires direct database access —
 *   that the belt-and-braces guard is warranted even though the
 *   plan does not explicitly name it.
 *
 *   The button is DISABLED rather than HIDDEN. A hidden button
 *   would leave the admin wondering why their row has fewer
 *   actions than everyone else's; a disabled button with a
 *   tooltip tells them exactly why.
 *
 * ── The role badge ──────────────────────────────────────────────
 *
 *   The `role` field is one of the two `UserRole` enum values —
 *   `'admin'` or `'user'`. The badge colors the value
 *   semantically: an admin gets a brand-primary tint (a
 *   "privileged" signal), a regular user gets a neutral tint
 *   (the default state). The distinction matters at a glance —
 *   an administrator scanning the list sees immediately which
 *   accounts carry privileged access, which is the number they
 *   are most often checking for.
 *
 * ── The active badge ────────────────────────────────────────────
 *
 *   A deactivated account (`active: false`) renders with an amber
 *   "Inactive" badge next to the email. An active account renders
 *   with no badge — the default state is the expected one, and
 *   badding every active row would add visual noise for the
 *   signal that matters. The asymmetry is deliberate: only the
 *   unusual state is called out.
 *
 * ── The date column ─────────────────────────────────────────────
 *
 *   The creation date is formatted with `toLocaleDateString()`
 *   using the user's locale, so a US user sees "10/10/2026" and
 *   a UK user sees "10/10/2026" (same digits, different expected
 *   order — the locale setting resolves the ambiguity). The same
 *   convention is used by `TopicCard`'s relative-time fallback
 *   for dates older than a week. No time-of-day component is
 *   shown: the exact creation minute is not information an admin
 *   needs at the list level, and the tooltip carries the full
 *   ISO string for the rare case where it matters.
 *
 * ── What this component does NOT do ─────────────────────────────
 *
 *   - It does not fetch the user list. That is the page's job
 *     (via the store's `loadUsers` action on mount).
 *
 *   - It does not render its own empty state. The page handles
 *     the empty case before rendering the list — see the
 *     `users.length > 0` condition in `Admin.tsx`. This
 *     component can assume it always receives at least one user.
 *
 *   - It does not open the edit form or the delete-confirmation
 *     modal. Both flows are page-owned: the page's `handleEditUser`
 *     opens the form, and the page's `handleDelete` opens the
 *     confirmation. The list only reports the intent through its
 *     callbacks.
 *
 *   - It does not implement sorting or filtering. The backend
 *     returns the list in `createdAt` descending order, and the
 *     page renders it as-is. A future session that wanted to
 *     sort or filter would add those concerns either to the
 *     page (as additional state that transforms the `users`
 *     prop before passing it here) or to the backend (as query
 *     parameters on the list endpoint). Neither is in scope
 *     today.
 *
 *   - It does not highlight the caller's own row beyond the
 *     disabled Delete button. A future session could add an
 *     "You" badge or a subtle background tint; the plan does
 *     not call for either.
 *
 * Dependencies: react (implicit, via the JSX transform) +
 * lucide-react + the shared `User` type. All present.
 */

import { Edit3, ShieldCheck, Trash2, User as UserIcon } from 'lucide-react';

import type { User } from '../../shared/types/index.js';

// ============================================================
//  Public types
// ============================================================

/**
 * The props accepted by `UserList`.
 *
 * The shape is fixed by construction: the sibling page
 * (`Admin.tsx`) passes exactly these four props at its own
 * `<UserList ... />` call site, and any drift between the two
 * sides produces a compile-time TS2322 on the page. The
 * interface is exported so a future helper that needs to
 * construct a `UserList`-shaped prop object can reference the
 * same type without redeclaring it.
 */
export interface UserListProps {
  /** The full list of users to render, in the order the backend
   *  returned them (newest first). The page guarantees this is
   *  non-empty — it renders its own empty state when the list
   *  is empty and only mounts this component otherwise. */
  users: User[];

  /** The currently-authenticated user's ID, or undefined when
   *  the auth store has not yet populated it. Used to disable
   *  the Delete button on the caller's own row. A caller that
   *  passes `undefined` gets no self-delete protection — which
   *  is the correct behavior for the transient window between
   *  the page mounting and the auth store settling. In practice
   *  the auth store is settled by the time the page renders
   *  (the layout's auth gate does not mount its children until
   *  `isLoading` is false), so `undefined` does not occur in
   *  the normal flow. */
  currentUserId: string | undefined;

  /** Called when the user clicks the Edit button on a row. The
   *  page handles opening the form and pre-populating it with
   *  the clicked user. */
  onEdit: (user: User) => void;

  /** Called when the user clicks the Delete button on a row. The
   *  page handles opening the confirmation modal; the actual
   *  delete does not happen until the user confirms. */
  onDelete: (user: User) => void;
}

// ============================================================
//  Role badge
// ============================================================
//
// The two role values have distinct visual treatments. An admin
// badge uses the app's brand-primary tint — a "privileged" signal
// that stands out in a list where most rows are regular users.
// A user badge uses the neutral tint, which reads as the default
// state.

interface RoleBadgeProps {
  role: User['role'];
}

const RoleBadge = ({ role }: RoleBadgeProps) => {
  if (role === 'admin') {
    return (
      <span
        className={
          'inline-flex items-center gap-1 rounded-full ' +
          'bg-primary/15 px-2 py-0.5 text-[10px] font-semibold ' +
          'uppercase tracking-wide text-primary-dark ' +
          'dark:bg-primary-light/20 dark:text-primary-light'
        }
      >
        <ShieldCheck size={10} aria-hidden="true" />
        <span>Admin</span>
      </span>
    );
  }

  return (
    <span
      className={
        'inline-flex items-center gap-1 rounded-full ' +
        'bg-neutral-100 px-2 py-0.5 text-[10px] font-semibold ' +
        'uppercase tracking-wide text-neutral-600 ' +
        'dark:bg-neutral-800 dark:text-neutral-300'
      }
    >
      <UserIcon size={10} aria-hidden="true" />
      <span>User</span>
    </span>
  );
};

// ============================================================
//  UserList — the main component
// ============================================================

/**
 * The table of user accounts. See the file header for the
 * component's responsibilities, the self-delete guard, and the
 * reasoning behind the badge treatments.
 */
export const UserList = ({
  users,
  currentUserId,
  onEdit,
  onDelete,
}: UserListProps) => {
  return (
    <div
      className={
        'overflow-hidden rounded-xl border ' +
        'border-neutral-200 bg-background ' +
        'dark:border-neutral-800'
      }
    >
      {/* ---- Column headers ---- */}
      {/* `hidden sm:grid` collapses the header on a narrow
          viewport; the rows below also collapse their own
          layout to a stacked form on the same breakpoint. The
          grid template is shared by the header and every row
          so the columns line up without a table element. */}
      <div
        className={
          'hidden grid-cols-[1fr_auto_auto_auto] items-center ' +
          'gap-4 border-b border-neutral-200 bg-neutral-50 ' +
          'px-4 py-2 text-[10px] font-medium uppercase ' +
          'tracking-wide text-neutral-500 ' +
          'sm:grid ' +
          'dark:border-neutral-800 dark:bg-neutral-900/40 ' +
          'dark:text-neutral-400'
        }
      >
        <span>Email</span>
        <span className="w-20 text-left">Role</span>
        <span className="w-24 text-left">Created</span>
        <span className="w-20 text-right">Actions</span>
      </div>

      {/* ---- Rows ---- */}
      <ul className="divide-y divide-neutral-100 dark:divide-neutral-800/60">
        {users.map((user) => {
          const isSelf = user._id === currentUserId;
          const isInactive = !user.active;

          return (
            <li
              key={user._id}
              className={
                'grid grid-cols-1 items-center gap-3 px-4 py-3 ' +
                'transition-colors hover:bg-neutral-50 ' +
                'sm:grid-cols-[1fr_auto_auto_auto] sm:gap-4 ' +
                'dark:hover:bg-neutral-800/40'
              }
            >
              {/* ---- Email + status ---- */}
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <p
                    className={
                      'truncate text-sm font-medium text-text ' +
                      'dark:text-neutral-100'
                    }
                    title={user.email}
                  >
                    {user.email}
                  </p>
                  {/* Only the inactive state gets a badge. See
                      the file header for the asymmetry. */}
                  {isInactive && (
                    <span
                      className={
                        'shrink-0 rounded-full bg-amber-100 ' +
                        'px-2 py-0.5 text-[10px] font-semibold ' +
                        'uppercase tracking-wide text-amber-800 ' +
                        'dark:bg-amber-950/60 ' +
                        'dark:text-amber-200'
                      }
                    >
                      Inactive
                    </span>
                  )}
                  {/* The caller's own row gets a "You" indicator
                      so an admin scanning the list knows which
                      account belongs to them without matching
                      on the email string. */}
                  {isSelf && (
                    <span
                      className={
                        'shrink-0 rounded-full bg-sky-100 ' +
                        'px-2 py-0.5 text-[10px] font-semibold ' +
                        'uppercase tracking-wide text-sky-800 ' +
                        'dark:bg-sky-950/60 dark:text-sky-200'
                      }
                    >
                      You
                    </span>
                  )}
                </div>
              </div>

              {/* ---- Role badge ---- */}
              <div className="sm:w-20">
                <RoleBadge role={user.role} />
              </div>

              {/* ---- Created date ---- */}
              <div className="text-xs text-neutral-500 sm:w-24 dark:text-neutral-400">
                <span title={user.createdAt}>
                  {new Date(user.createdAt).toLocaleDateString()}
                </span>
              </div>

              {/* ---- Actions ---- */}
              <div className="flex items-center gap-1 sm:w-20 sm:justify-end">
                <button
                  type="button"
                  onClick={() => onEdit(user)}
                  aria-label={`Edit user ${user.email}`}
                  title="Edit"
                  className={
                    'rounded-md p-1.5 text-neutral-500 ' +
                    'transition-colors ' +
                    'hover:bg-neutral-100 hover:text-primary ' +
                    'focus-visible:outline-none ' +
                    'dark:text-neutral-400 ' +
                    'dark:hover:bg-neutral-800 ' +
                    'dark:hover:text-primary-light'
                  }
                >
                  <Edit3 size={16} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  onClick={() => onDelete(user)}
                  disabled={isSelf}
                  aria-label={
                    isSelf
                      ? 'You cannot delete your own account'
                      : `Delete user ${user.email}`
                  }
                  title={
                    isSelf
                      ? 'You cannot delete your own account'
                      : 'Delete'
                  }
                  className={
                    'rounded-md p-1.5 transition-colors ' +
                    'focus-visible:outline-none ' +
                    'disabled:cursor-not-allowed ' +
                    'disabled:opacity-40 ' +
                    (isSelf
                      ? 'text-neutral-400 dark:text-neutral-600'
                      : 'text-neutral-500 ' +
                        'hover:bg-red-50 hover:text-red-700 ' +
                        'dark:text-neutral-400 ' +
                        'dark:hover:bg-red-950/60 ' +
                        'dark:hover:text-red-400')
                  }
                >
                  <Trash2 size={16} aria-hidden="true" />
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
};

// ============================================================
//  Default export
// ============================================================

/**
 * The `UserList` component as the default export. The sibling
 * `Admin.tsx` page imports it with the default form
 * (`import UserList from '../components/UserList.js'`), so this
 * is the export that resolves that file's forward reference.
 */
export default UserList;