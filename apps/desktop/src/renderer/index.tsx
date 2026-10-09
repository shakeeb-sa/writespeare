/**
 * WriteSpeare — renderer entry point.
 *
 * This is the module that `apps/desktop/index.html` loads via its
 * `<script type="module" src="/src/renderer/index.tsx">` tag. In
 * development, Vite serves it from `http://localhost:5173`; in
 * production, Vite rewrites the tag to point at the bundled,
 * minified copy under `dist/renderer/assets/`.
 *
 * Responsibilities, in order:
 *
 *   1. Register global error handlers BEFORE the React tree
 *      mounts. Two listeners — one for uncaught synchronous
 *      errors and one for unhandled promise rejections — write a
 *      diagnostic line to the console. Installing them first is
 *      what makes them able to catch an error thrown during the
 *      initial render; installing them after the mount would
 *      miss exactly the class of failures they exist to catch.
 *
 *   2. Import the app's stylesheet. This import is what causes
 *      Vite to include `tailwind.css` in the bundle — the file
 *      has no other way to be discovered by the build. The
 *      import is side-effect-only; the imported binding is
 *      never used, and there is no default or named export to
 *      bind it to.
 *
 *   3. Mount the React tree into `<div id="root">`, wrapped in
 *      `<StrictMode>` so that React 19's development-only checks
 *      run in dev builds. StrictMode has no effect in production
 *      builds — it is erased at build time.
 *
 *   4. Guard against the case where the root element is missing.
 *      This should never happen — the `#root` div is declared in
 *      `index.html` and is a fixed part of the app shell — but
 *      if a future refactor renamed it, a silent null-dereference
 *      during startup would be much harder to diagnose than an
 *      explicit "root element not found" error.
 *
 * What this file deliberately does NOT do:
 *
 *   - It does not import React itself. React 19 with the
 *     `react-jsx` transform (enabled in tsconfig.json) does not
 *     require `import React from 'react'` at the top of a file
 *     that uses JSX. Only the two named imports this file
 *     actually uses — `StrictMode` and `createRoot` — are pulled
 *     in.
 *
 *   - It does not install an ErrorBoundary at this level. Error
 *     boundaries are a React concept and belong in the component
 *     tree (typically in `App.tsx`) where the boundary's layout
 *     context makes sense. The two window listeners below catch
 *     errors that escape the tree entirely — a category no
 *     boundary can address.
 *
 *   - It does not check for the React DevTools global or print a
 *     banner about it. Vite's dev-mode banner already announces
 *     the dev server, and React itself prints a warning if the
 *     extension is missing in dev.
 *
 * The import paths use the `.js` extension convention that the
 * rest of the codebase follows — `./App.js` resolves to
 * `./App.tsx` under the `NodeNext` module resolution configured
 * in tsconfig.json and the Vite resolver plugin in
 * `vite.config.ts`. The CSS import keeps its own extension
 * because Vite's asset pipeline keys on the extension to
 * determine how to process the file (CSS files go through the
 * PostCSS pipeline configured in `postcss.config.js`).
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App.js';
import './styles/tailwind.css';

// ============================================================
//  Global error handlers
// ============================================================
//
// Installed before the mount so that any error thrown during
// the initial render is captured. Both handlers log to the
// console and return — they do not prevent default browser
// behaviour and do not attempt to recover. Recovery is not
// possible from a global handler; the correct response to an
// uncaught error is a clear diagnostic and letting the process
// continue in whatever state it is in. A future error-boundary
// component inside the React tree can add user-visible recovery
// for errors that occur within the tree; these two listeners
// exist for the errors that escape it.

/**
 * Uncaught synchronous errors.
 *
 * The `error` event is triggered by any error that reaches the
 * top of the call stack without a `try/catch` — including
 * errors thrown during a React render phase, errors in event
 * handlers that are not caught by a boundary, and resource load
 * failures (images, stylesheets, scripts) that the browser
 * reports through this same channel.
 *
 * The `event.error` field carries the actual `Error` object
 * when the browser can supply one. `event.message` is the
 * fallback string for cases where the error object is not
 * available — cross-origin script errors, for example, are
 * sanitized by the browser to a generic string for security
 * reasons. Logging whichever is present ensures a diagnostic
 * line regardless of which form the event takes.
 */
window.addEventListener('error', (event) => {
  console.error(
    '[renderer] uncaught error:',
    event.error ?? event.message
  );
});

/**
 * Unhandled promise rejections.
 *
 * The `unhandledrejection` event is triggered when a rejected
 * promise has no `.catch()` handler and the rejection reaches
 * the event loop unclaimed. This is a common failure mode in
 * async code that uses `await` inside an event handler without
 * a `try/catch` — the promise rejects and nothing observes it,
 * which silently swallows an error that would otherwise surface.
 *
 * `event.reason` carries the rejection value — usually an
 * `Error` object, but sometimes a string or an arbitrary value
 * if the promise was rejected with something other than an
 * `Error`. Logging it directly preserves whatever the code threw.
 */
window.addEventListener('unhandledrejection', (event) => {
  console.error(
    '[renderer] unhandled rejection:',
    event.reason
  );
});

// ============================================================
//  Mount
// ============================================================

/**
 * Locate the root element declared in `index.html`.
 *
 * A missing element is treated as a fatal configuration error
 * rather than a silent fallback. The alternative — creating a
 * detached `<div>` and mounting into it — would produce a
 * functioning React tree with no visible output, which is a
 * harder failure to diagnose than the explicit throw below.
 *
 * The non-null assertion that would typically follow this lookup
 * (`document.getElementById('root')!`) is deliberately not used.
 * The explicit null check produces a named error with a
 * descriptive message if the element ever disappears, and the
 * cost — one branch that never fires in a working app — is
 * negligible compared to the diagnostic value if it ever does.
 */
const container = document.getElementById('root');
if (!container) {
  throw new Error(
    'Renderer: root element #root not found. ' +
      'Check that index.html declares <div id="root"></div>.'
  );
}

/**
 * Create the React root and render the app.
 *
 * `createRoot` is React 18+'s concurrent root API — the modern
 * replacement for the legacy `ReactDOM.render`. It returns a
 * root handle whose `.render()` method starts the initial render
 * and then reconciles subsequent updates on the concurrent
 * scheduler.
 *
 * `<StrictMode>` wraps the app in development-only checks: it
 * double-invokes certain lifecycle methods, warns about unsafe
 * patterns, and surfaces deprecated APIs early. In production
 * builds, StrictMode is a no-op and adds no runtime cost — the
 * compiler and React both erase its behaviour.
 */
const root = createRoot(container);
root.render(
  <StrictMode>
    <App />
  </StrictMode>
);