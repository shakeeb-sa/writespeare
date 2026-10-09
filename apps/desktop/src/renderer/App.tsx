/**
 * WriteSpeare — renderer root component and route tree.
 *
 * This is the component that `src/renderer/index.tsx` mounts into
 * the `#root` element. It composes the app's top-level structure
 * in one place:
 *
 *   1. `<HashRouter>` — the router.
 *   2. `<ToastProvider>` — the toast notification context.
 *   3. `<ModalProvider>` — the modal context.
 *   4. `<Routes>` — the top-level route tree.
 *
 * Why HashRouter and not BrowserRouter:
 *
 *   The packaged Electron app loads the renderer from a `file://`
 *   URL, and there is no server behind that URL to which a
 *   SPA-fallback rule could be attached. BrowserRouter would put
 *   the route in the URL's pathname, and a user who refreshed on
 *   a route other than the root would get a "file not found"
 *   because no file exists at `file:///dashboard/topics` — the
 *   only file is `index.html`. HashRouter puts the route in the
 *   URL fragment (`#/dashboard/topics`), which never reaches the
 *   filesystem and never needs a fallback rule. In the dev server
 *   the difference is invisible, but in the packaged app it is
 *   the difference between working and broken.
 *
 * Provider order — why Router is outermost:
 *
 *   The two providers (`ToastProvider`, `ModalProvider`) do not
 *   use routing — they expose imperative APIs (`useToast()`,
 *   `useModal()`) that components call to open a toast or a modal.
 *   Because those APIs are consumed by components INSIDE the
 *   route tree, the providers must wrap the routes. They do not
 *   need the router's own hooks, so they could sit outside or
 *   inside the router with equal correctness. The order used here
 *   (Router > Toast > Modal > Routes) is the convention, and it
 *   means a provider that ever wanted to react to a navigation
 *   event would already have access to the router's hooks.
 *
 * The route tree:
 *
 *   `/login` — the login page. Rendered standalone, without
 *     `<Layout />` and therefore without the sidebar. An
 *     unauthenticated user has no data to put in the sidebar,
 *     and no navigation to offer except "log in".
 *
 *   `/dashboard` — the authenticated area. `<Layout />` is the
 *     element for this route; it renders the sidebar and an
 *     `<Outlet />` where the nested routes below appear. Layout
 *     also performs the auth check — an unauthenticated user
 *     hitting any `/dashboard/*` URL is redirected to `/login`
 *     by Layout's own logic, not by anything in this file.
 *
 *   Nested under `/dashboard`:
 *     index          → redirect to `topics`.
 *     `topics`       → the topics list (the app's home screen).
 *     `topics/:id`   → a single topic's detail view.
 *     `settings`     → the settings page.
 *     `admin`        → the admin panel. Visibility for a non-admin
 *                      is enforced by Layout (which reads the
 *                      user's role from the auth store), not by
 *                      the router. The route exists in the tree
 *                      regardless of who is logged in.
 *
 *   `*` — catch-all. Redirects to `/dashboard`, which in turn
 *     redirects to `/topics` (via the index redirect above). This
 *     handles both the root path `/` and any typo'd path. The
 *     `replace` on the Navigate is deliberate — it prevents the
 *     browser's back button from returning to the mistyped URL.
 *
 * Forward references — why this file imports files that do not
 * yet exist on disk:
 *
 *   App.tsx is the renderer's integration point. Its whole
 *   purpose is to compose the route tree, and the route tree
 *   references the feature pages and the shared layout. Those
 *   files are declared in later sessions of the plan's coding
 *   order — the shared components in Session 5, the feature
 *   pages in Sessions 6, 7, 18, and 19. This file is therefore
 *   the first in the session whose TypeScript compile depends on
 *   files that do not yet exist.
 *
 *   The consequence is that this file will be STATE B (expected
 *   errors) until those files are created. That is not a bug in
 *   this file — it is the natural shape of an integration point
 *   written ahead of its dependencies. The errors will resolve
 *   one by one as each dependency is created, and the file will
 *   become STATE A once the last dependency is in place.
 *
 *   An alternative — replacing each page with a placeholder
 *   component so the file compiles today — is forbidden by
 *   Section 6 of the execution protocol. A placeholder route
 *   would compile but would not be the file the plan declares,
 *   and it would have to be replaced later anyway. The forward
 *   references are the correct choice.
 *
 * Route path conventions:
 *
 *   The `path` values on the nested routes are relative — a
 *   `<Route path="topics" />` nested under
 *   `<Route path="/dashboard" />` matches `/dashboard/topics`.
 *   This is React Router v6+'s default behaviour, and it is what
 *   makes the route tree read as a hierarchy rather than a flat
 *   list of absolute paths.
 *
 * Why there is no ErrorBoundary or Suspense here:
 *
 *   The plan does not declare either at this level. Global error
 *   handling for errors that escape the tree entirely is
 *   installed in `index.tsx` via `window.addEventListener`. A
 *   React ErrorBoundary — which catches errors during rendering
 *   of its descendants — would belong in a component closer to
 *   where the error occurs (a feature page, a data view), not at
 *   the router level, because a boundary here would replace the
 *   entire app with a fallback rather than just the failing
 *   subtree. Suspense boundaries are similarly per-data-source
 *   and are not needed until a component actually suspends.
 */

import {
  HashRouter,
  Routes,
  Route,
  Navigate,
} from 'react-router-dom';

// Shared providers and layout — declared in Session 5.
import { ToastProvider } from '../features/shared/components/Toast.js';
import { ModalProvider } from '../features/shared/components/Modal.js';
import Layout from '../features/shared/components/Layout.js';

// Feature pages — declared in later sessions.
import Login from '../features/auth/pages/Login.js';
import Topics from '../features/topics/pages/Topics.js';
import TopicDetail from '../features/topics/pages/TopicDetail.js';
import Settings from '../features/settings/pages/Settings.js';
import Admin from '../features/admin/pages/Admin.js';

// ============================================================
//  App
// ============================================================

/**
 * The renderer's root component.
 *
 * No state, no effects, no logic beyond the route tree itself.
 * Every piece of app-wide behaviour that could live here lives
 * in a provider (the toasts, the modals) or in Layout (the auth
 * check, the sidebar). What remains for this component is
 * exactly the composition the file header describes.
 */
const App = () => {
  return (
    <HashRouter>
      <ToastProvider>
        <ModalProvider>
          <Routes>
            {/* ---- Public routes ---- */}
            <Route path="/login" element={<Login />} />

            {/* ---- Authenticated area ---- */}
            {/*
              * `<Layout />` renders the sidebar and an
              * `<Outlet />`. Its own logic decides whether the
              * user is authenticated; a user without a valid
              * session is redirected to `/login` from inside
              * Layout, so the routes below never render for an
              * anonymous visitor.
              */}
            <Route path="/dashboard" element={<Layout />}>
              {/*
                * The bare `/dashboard` path redirects to the
                * topics list, which is the app's default view
                * once a user is signed in.
                */}
              <Route
                index
                element={<Navigate to="topics" replace />}
              />

              <Route path="topics" element={<Topics />} />
              <Route path="topics/:id" element={<TopicDetail />} />

              <Route path="settings" element={<Settings />} />
              <Route path="admin" element={<Admin />} />
            </Route>

            {/* ---- Catch-all ---- */}
            {/*
              * Any path not matched above — including the root
              * path `/` — is sent to `/dashboard`. From there
              * the auth gate in Layout decides whether the user
              * sees the dashboard or the login page.
              */}
            <Route
              path="*"
              element={<Navigate to="/dashboard" replace />}
            />
          </Routes>
        </ModalProvider>
      </ToastProvider>
    </HashRouter>
  );
};

// ============================================================
//  Default export
// ============================================================

export default App;