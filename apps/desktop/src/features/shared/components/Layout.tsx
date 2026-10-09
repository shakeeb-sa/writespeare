/**
 * WriteSpeare — dashboard shell.
 *
 * This is the component `<Routes>` renders as the element of the
 * `/dashboard` route (see `renderer/App.tsx`). It is the
 * authenticated frame that every signed-in page lives inside: a
 * sidebar on the left, a main content area on the right, and an
 * `<Outlet />` in the content area where the currently-matched
 * child route (Topics, Topic Detail, Settings, Admin) renders.
 *
 * The component has exactly two responsibilities:
 *
 *   1. Auth gate — before any dashboard content mounts, verify
 *      that the user is authenticated. If the session is still
 *      being restored, render nothing (the alternative — a
 *      brief flash of the login page — would be wrong, and a
 *      brief flash of the dashboard — also wrong, because it
 *      would show stale or empty data). If the session has been
 *      restored and the user is not authenticated, redirect to
 *      `/login`. Only after a definitive answer is available
 *      does the dashboard tree mount.
 *
 *   2. Layout composition — render `<Sidebar />` on the left and
 *      a scrollable main region on the right. The sidebar's
 *      collapsed/expanded state is owned here and passed down as
 *      a controlled prop, so that `Sidebar` itself is stateless
 *      and easy to test in isolation.
 *
 * Why the auth gate lives here and not in each page:
 *
 *   The alternative would be for every authenticated page to
 *   check `useAuth()` on mount and redirect if the user is
 *   missing. That pattern duplicates the check across five or
 *   more files, and — more importantly — it duplicates the
 *   redirect. If two pages disagree about where an
 *   unauthenticated user should go (say, one sends them to
 *   `/login` and another to `/`), the app produces inconsistent
 *   behaviour depending on which route the user hit first.
 *
 *   Putting the gate in `Layout` means the invariant is enforced
 *   in exactly one place, and it is enforced BEFORE the child
 *   route renders. A page component never has to think about
 *   whether the user is signed in — by the time it renders, the
 *   answer is always "yes".
 *
 * The loading state:
 *
 *   When `isLoading` is `true`, the component returns `null`.
 *   That produces a blank frame for the brief window (usually a
 *   few dozen milliseconds) while the auth store reads the
 *   cached user from the encrypted store. The blank frame is
 *   preferable to either alternative:
 *
 *     - A loading spinner would flash on every cold start, even
 *       for users who are already signed in. The flash would be
 *       noticeable because it appears and disappears too fast to
 *       read, which reads as a glitch.
 *
 *     - Falling through to the login page would cause a redirect
 *       flash for users who are about to be authenticated. The
 *       address bar would show `/login` for a moment before
 *       being replaced by `/dashboard/topics`, and the user's
 *       back button would carry a history entry they did not
 *       create.
 *
 *   Returning `null` produces neither artifact. The cost is a
 *   briefly-empty window, which most users will not notice.
 *
 * Why the redirect uses `replace`:
 *
 *   `<Navigate to="/login" replace />` replaces the current
 *   history entry rather than pushing a new one. Without
 *   `replace`, an unauthenticated user who manually typed
 *   `/dashboard/topics` would press the back button from the
 *   login page and land back on `/dashboard/topics`, which
 *   would immediately redirect them to `/login` again — an
 *   inescapable loop. Replacing the entry closes that loop: the
 *   back button takes them to whatever page preceded their
 *   navigation into the dashboard, not into a redirect cycle.
 *
 * The scroll model:
 *
 *   The outer container is `flex h-full w-full overflow-hidden`
 *   — it fills its parent (the app root, which is set to `h-full`
 *   by the base styles in `tailwind.css`) and clips any overflow.
 *
 *   The sidebar is a fixed-width column that does not scroll —
 *   its internal content is designed to fit the viewport, and
 *   any rare overflow is handled by the sidebar's own
 *   `overflow-y-auto` on its nav element.
 *
 *   The main region is `flex-1 overflow-y-auto`, which makes it
 *   the only scrolling surface in the layout. A long page inside
 *   the `<Outlet />` scrolls the main region while the sidebar
 *   stays put — the standard behaviour for a persistent-nav app.
 *
 * Forward reference:
 *
 *   Like `Sidebar.tsx`, this file depends on `useAuth` from
 *   `apps/desktop/src/features/auth/hooks/useAuth.ts` — a file
 *   scheduled for Session 6. The import specifier therefore
 *   produces one `TS2307` until that file exists. This is the
 *   same forward-reference shape already logged by multiple
 *   files earlier in the session (`main/store.ts`,
 *   `main/preload.ts`, `renderer/App.tsx`, and the previous file
 *   `Sidebar.tsx`).
 *
 * Why there is no `LayoutProps` interface with fields:
 *
 *   The component takes no props today — the sidebar's collapsed
 *   state is internal to this file, and every other piece of the
 *   layout is derived from the router context or the auth store.
 *   The `LayoutProps` type is declared as an empty interface so
 *   that a future addition (for example, a `hideSidebar` prop
 *   for a full-screen view) has a named, exported home. An empty
 *   interface is a legal TypeScript construct and does not fail
 *   under any strict flag; it costs nothing and pre-declares the
 *   growth point.
 */

import { useState } from 'react';
import { Navigate, Outlet } from 'react-router-dom';

import { useAuth } from '../../auth/hooks/useAuth.js';
import Sidebar from './Sidebar.js';

// ============================================================
//  Public types
// ============================================================

/**
 * The props accepted by `Layout`. Currently empty — see the file
 * header for why the interface is declared anyway.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface LayoutProps {
  // Reserved for future additions. See file header.
}

// ============================================================
//  Layout
// ============================================================

/**
 * The authenticated dashboard shell. See the file header for the
 * component's two responsibilities and the reasoning behind the
 * auth-gate and loading-state decisions.
 */
export const Layout = (_props: LayoutProps = {}) => {
  const { user, isLoading } = useAuth();

  /**
   * The sidebar's collapsed state. Owned here, passed to
   * `<Sidebar />` as a controlled prop. The initial value is
   * `false` — every fresh session starts with the sidebar
   * expanded, which is the recommended default for a user who is
   * about to navigate. If a future session wants to persist the
   * user's preference across restarts, the persistence call goes
   * in this file (the sole owner of the state), not in
   * `Sidebar.tsx`.
   */
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  /**
   * Flip the sidebar's collapsed state. Written as a functional
   * state update (`prev => !prev`) rather than a direct read of
   * `sidebarCollapsed` so that a rapid double-click produces two
   * toggles, not one — the direct form would compute both
   * updates from the same stale `sidebarCollapsed` value and
   * collapse into a single flip.
   */
  const toggleSidebar = (): void => {
    setSidebarCollapsed((prev) => !prev);
  };

  // ---- Auth gate: loading ----
  // The auth store has not yet determined whether a session
  // exists. Return null to avoid the two visual artifacts
  // described in the file header. See the file header for the
  // full reasoning.
  if (isLoading) {
    return null;
  }

  // ---- Auth gate: not authenticated ----
  // The auth store has resolved and there is no user. Redirect
  // to the login page with `replace` so the back button does not
  // loop. See the file header for the loop explanation.
  if (!user) {
    return <Navigate to="/login" replace />;
  }

  // ---- Authenticated ----
  // The user is signed in. Render the shell. Every child route
  // mounted inside `<Outlet />` can rely on `useAuth()` returning
  // a non-null `user`, because this component does not render its
  // children until the check above has passed.
  return (
    <div className="flex h-full w-full overflow-hidden bg-background">
      <Sidebar collapsed={sidebarCollapsed} onToggle={toggleSidebar} />

      {/*
        * The main content region. `flex-1` takes all remaining
        * horizontal space; `overflow-y-auto` makes this element
        * the app's only scrolling surface, so a long page inside
        * the Outlet scrolls here while the sidebar stays fixed.
        * `min-w-0` is required so that a flex child can shrink
        * below its content width when a descendant has
        * `whitespace-nowrap` or a wide table — without it, the
        * sidebar would be pushed off-screen by such content.
        */}
      <main className="min-w-0 flex-1 overflow-y-auto">
        <Outlet />
      </main>
    </div>
  );
};

// ============================================================
//  Default export
// ============================================================

/**
 * The `Layout` component as the default export, matching the
 * convention used by every other component file in the codebase.
 * `renderer/App.tsx` uses the default form
 * (`import Layout from '.../Layout.js'`), so this is the export
 * that keeps the route tree resolving.
 */
export default Layout;