/**
 * WriteSpeare — main navigation sidebar.
 *
 * This module provides the app's persistent left-hand sidebar,
 * the column that appears alongside every authenticated page (see
 * `Layout.tsx`, which mounts this component). It has four jobs:
 *
 *   1. Show the WriteSpeare brand at the top.
 *   2. Render the primary navigation links — Topics, Settings,
 *      and Admin (the last only for admin users).
 *   3. Show the currently authenticated user's email address.
 *   4. Offer a logout action.
 *
 * The component also exposes a collapse/expand toggle that lives
 * in its header. The state itself is NOT owned here — the parent
 * (`Layout.tsx`) owns it and passes it in via props, and the
 * toggle button calls back to the parent through `onToggle`.
 * That structure matches the plan's description of Layout
 * ("Sidebar toggle") and keeps the Sidebar a controlled
 * component whose only concern is rendering.
 *
 * Collapsed vs. expanded:
 *
 *   Expanded (default, ~15rem wide) — full navigation with
 *     labels, brand name, email, and a text-labeled logout
 *     button. This is the state for a user who is actively
 *     navigating.
 *
 *   Collapsed (~4rem wide) — icon-only navigation with a tooltip
 *     on hover for each icon, brand reduced to the logomark, no
 *     email, and an icon-only logout button. This is the state
 *     for a user who wants the sidebar out of the way while
 *     keeping the navigation reachable.
 *
 *   The width transition is animated over 200 ms so collapsing
 *   and expanding feel smooth rather than instant. The duration
 *   matches the animation durations used elsewhere in the app
 *   (`Toast.tsx`, `Modal.tsx`) so the whole UI has a consistent
 *   sense of pacing.
 *
 * Active-link highlighting:
 *
 *   Navigation uses `NavLink` from react-router-dom rather than
 *   `Link`. `NavLink` gives every consumer a boolean `isActive`
 *   through a render-prop callback, which the item uses to switch
 *   between the active style (brand-filled) and the inactive
 *   style (neutral hover). `NavLink` also sets
 *   `aria-current="page"` automatically on the active item, which
 *   is what assistive technology uses to announce "you are here".
 *
 *   The Topics link deliberately has NO `end` prop — the route
 *   `/dashboard/topics/:id` (a topic's detail page) is a
 *   descendant of `/dashboard/topics`, and the Topics link should
 *   stay highlighted while the user is on a detail page. The
 *   Settings and Admin links have no subroutes in the plan's
 *   route tree, so their default matching behaviour is correct.
 *
 * Forward reference:
 *
 *   The authenticated user comes from `useAuth()`, which is
 *   declared in `apps/desktop/src/features/auth/hooks/useAuth.ts`
 *   — a file scheduled for Session 6. Until that file exists,
 *   this module's import specifier `../../auth/hooks/useAuth.js`
 *   does not resolve and produces one `TS2307` error. That is
 *   expected and is the same shape as the forward references
 *   already logged by `renderer/App.tsx` (which waits on several
 *   feature pages) and by `main/preload.ts` (whose types file
 *   landed earlier in this session).
 *
 *   The plan does not declare a re-export shim for `useAuth` in
 *   the shared hooks folder, so this file imports the hook from
 *   its canonical location inside the auth feature. That import
 *   path is the same one the `Login` page and every future
 *   authenticated page will use.
 */

import {
  ChevronLeft,
  ChevronRight,
  Feather,
  FileText,
  LogOut,
  Settings as SettingsIcon,
  ShieldCheck,
  type LucideIcon,
} from 'lucide-react';
import { NavLink, type NavLinkRenderProps } from 'react-router-dom';

import { useAuth } from '../../auth/hooks/useAuth.js';
import { APP_NAME } from '../constants/index.js';

// ============================================================
//  Public types
// ============================================================

/**
 * The props accepted by the `Sidebar` component.
 *
 * The component is a controlled shell — it renders based on the
 * `collapsed` prop and notifies the parent when the toggle button
 * is clicked. The parent owns the state; the child never mutates
 * it directly.
 */
export interface SidebarProps {
  /** Whether the sidebar is currently in its narrow, icon-only
   *  form. The parent toggles this value in response to
   *  `onToggle`. */
  collapsed: boolean;

  /** Called when the user clicks the collapse/expand button.
   *  The parent is responsible for flipping its own state. */
  onToggle: () => void;
}

// ============================================================
//  NavItem — internal helper
// ============================================================

/**
 * Props for the internal `NavItem` helper. Not exported — the
 * helper is an implementation detail of this module.
 */
interface NavItemProps {
  /** The route the item navigates to. Matches a `path` in the
   *  app's route tree (see `renderer/App.tsx`). */
  to: string;

  /** The lucide icon rendered at the start of the item. */
  icon: LucideIcon;

  /** The item's label. Rendered as text when expanded and used
   *  as the tooltip (`title`) when collapsed. */
  label: string;

  /** Whether the sidebar is currently collapsed. Controls the
   *  item's spacing and whether the label is shown. */
  collapsed: boolean;
}

/**
 * Render a single navigation link. Used by `Sidebar` for each of
 * its three items. The `NavLink` render-prop form is what lets
 * the item switch styles based on the router's own active-route
 * determination, which is more reliable than re-deriving the
 * active state from `useLocation()` in the parent — it correctly
 * handles edge cases like nested routes and trailing slashes.
 */
const NavItem = ({ to, icon: Icon, label, collapsed }: NavItemProps) => {
  const className = ({ isActive }: NavLinkRenderProps): string => {
    const base =
      'flex items-center rounded-lg text-sm font-medium ' +
      'transition-colors focus-visible:outline-none';

    const spacing = collapsed
      ? 'justify-center p-2'
      : 'gap-3 px-3 py-2';

    const state = isActive
      ? 'bg-primary text-white'
      : 'text-neutral-700 hover:bg-neutral-100 ' +
        'dark:text-neutral-300 dark:hover:bg-neutral-800';

    return `${base} ${spacing} ${state}`;
  };

  return (
    <NavLink to={to} className={className} title={collapsed ? label : undefined}>
      <Icon size={18} className="shrink-0" aria-hidden="true" />
      {!collapsed && <span className="truncate">{label}</span>}
    </NavLink>
  );
};

// ============================================================
//  Sidebar
// ============================================================

/**
 * The main navigation sidebar. See the file header for the
 * component's responsibilities, the collapsed/expanded state
 * contract, and the reasoning behind the design choices.
 */
export const Sidebar = ({ collapsed, onToggle }: SidebarProps) => {
  const { user, logout } = useAuth();

  /**
   * Whether the current user is an administrator. The Admin link
   * is rendered only when this is `true`. The role check itself
   * is a string comparison — `useAuth` returns the user object
   * as the backend serialized it, and the backend's `UserRole`
   * enum serializes to the string `'admin'`.
   */
  const isAdmin = user?.role === 'admin';

  /**
   * Log the user out. The actual state transitions — clearing
   * the token, clearing the cached user, notifying the main
   * process — are handled by `useAuth`'s `logout` function. This
   * handler exists only to give the click a place to attach and
   * to keep the component free of `void`-discarded floating
   * promises.
   *
   * The redirect back to `/login` is NOT performed here. It is
   * performed by `Layout.tsx`'s auth check, which runs whenever
   * the store's user becomes null — the same code path that
   * handles a session expiring during use. Keeping the redirect
   * in one place (Layout) rather than two (Layout and Sidebar)
   * is what prevents the two from disagreeing about when to
   * redirect.
   */
  const handleLogout = (): void => {
    void logout();
  };

  return (
    <aside
      className={
        'flex h-full flex-col border-r border-neutral-200 ' +
        'bg-background transition-[width] duration-200 ' +
        'dark:border-neutral-800 ' +
        (collapsed ? 'w-16' : 'w-60')
      }
    >
      {/* ---- Header ---- */}
      {/* The brand and the collapse/expand toggle. When expanded,
          the brand takes the horizontal space (flex-1) and pushes
          the toggle to the right edge; when collapsed, the toggle
          is centered. */}
      <div
        className={
          'flex h-14 shrink-0 items-center gap-2 px-3 ' +
          'border-b border-neutral-200 dark:border-neutral-800 ' +
          (collapsed ? 'justify-center' : '')
        }
      >
        {!collapsed && (
          <div className="flex flex-1 items-center gap-2 overflow-hidden">
            <Feather
              size={20}
              className="shrink-0 text-primary"
              aria-hidden="true"
            />
            <span className="truncate font-semibold text-text dark:text-neutral-100">
              {APP_NAME}
            </span>
          </div>
        )}

        <button
          type="button"
          onClick={onToggle}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className={
            'shrink-0 rounded-md p-1 text-neutral-500 transition-colors ' +
            'hover:bg-neutral-100 hover:text-neutral-800 ' +
            'dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100 ' +
            'focus-visible:outline-none'
          }
        >
          {collapsed ? (
            <ChevronRight size={18} aria-hidden="true" />
          ) : (
            <ChevronLeft size={18} aria-hidden="true" />
          )}
        </button>
      </div>

      {/* ---- Navigation ---- */}
      {/* `flex-1` pushes the footer to the bottom; `overflow-y-auto`
          handles the case of an unusually large number of nav items
          (today there are at most three) without pushing the footer
          off-screen. */}
      <nav
        aria-label="Main navigation"
        className="flex-1 space-y-1 overflow-y-auto p-2"
      >
        <NavItem
          to="/dashboard/topics"
          icon={FileText}
          label="Topics"
          collapsed={collapsed}
        />

        <NavItem
          to="/dashboard/settings"
          icon={SettingsIcon}
          label="Settings"
          collapsed={collapsed}
        />

        {isAdmin && (
          <NavItem
            to="/dashboard/admin"
            icon={ShieldCheck}
            label="Admin"
            collapsed={collapsed}
          />
        )}
      </nav>

      {/* ---- Footer: user + logout ---- */}
      <div
        className={
          'shrink-0 border-t border-neutral-200 p-3 ' +
          'dark:border-neutral-800'
        }
      >
        {!collapsed && user && (
          <div
            className="mb-2 truncate px-1 text-xs text-neutral-500 dark:text-neutral-400"
            title={user.email}
          >
            {user.email}
          </div>
        )}

        {user && (
          <button
            type="button"
            onClick={handleLogout}
            title={collapsed ? 'Log out' : undefined}
            className={
              'flex w-full items-center rounded-lg text-sm font-medium ' +
              'text-neutral-700 transition-colors ' +
              'hover:bg-neutral-100 hover:text-neutral-900 ' +
              'dark:text-neutral-300 dark:hover:bg-neutral-800 dark:hover:text-neutral-100 ' +
              'focus-visible:outline-none ' +
              (collapsed
                ? 'justify-center p-2'
                : 'gap-3 px-3 py-2')
            }
          >
            <LogOut size={18} className="shrink-0" aria-hidden="true" />
            {!collapsed && <span className="truncate">Log out</span>}
          </button>
        )}
      </div>
    </aside>
  );
};

// ============================================================
//  Default export
// ============================================================

/**
 * The `Sidebar` component as the default export, matching the
 * convention used by every other component file in the codebase.
 * Consumers that prefer the named form use
 * `import { Sidebar } from ...`; consumers that prefer the
 * default form use `import Sidebar from ...`. Both resolve to
 * the same component.
 */
export default Sidebar;