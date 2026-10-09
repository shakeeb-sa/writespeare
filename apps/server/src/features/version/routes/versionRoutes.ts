/**
 * Route table for the WriteSpeare version feature.
 *
 * Declares the single public endpoint that the desktop client's
 * update checker calls. The router is mounted at `/api/version`
 * by the app factory (`src/app.ts`), so the path declared below
 * is relative to that prefix:
 *
 *   GET /api/version   → the most recently published release
 *
 * Why this is the only public route in the backend:
 *
 *   Every other route in the application is behind the
 *   `authenticate` middleware — topics, documents, articles,
 *   reports, settings, and (in a later session) users and admin.
 *   This one is deliberately not, and the reason is structural:
 *
 *   The desktop client's update checker runs before the user has
 *   logged in. On first launch, on every subsequent launch, and
 *   after any logout, the client has no session token and needs
 *   to know whether an update is available. If this endpoint
 *   required authentication, the client would face a chicken-
 *   and-egg problem: it would need a token to discover that a
 *   security update is available, at exactly the moment when
 *   the token might not exist yet. Worse, a user on an outdated
 *   build with an expired token would be forced to log in again
 *   before being told they need to update — and the login
 *   endpoint itself might be the one the update fixes.
 *
 *   The endpoint therefore returns only public information: the
 *   latest release version, its download URL, and its release
 *   notes. There is nothing in the response that would not
 *   appear in a public changelog. No per-user data is read, no
 *   user-scoped collection is touched, and the handler has no
 *   dependencies on the caller's identity.
 *
 *   The exception is scoped to exactly one handler reading
 *   exactly one collection with exactly one query. It does not
 *   generalize. A future feature that wants to read some other
 *   public data should be reviewed on its own merits; the
 *   existence of this route is not precedent for skipping
 *   `authenticate` elsewhere.
 *
 * Middleware:
 *
 *   The route has NO `authenticate` middleware. It has only the
 *   `asyncHandler` wrapper, which is still required — the
 *   controller's `getLatestVersion` is async (it awaits a Mongoose
 *   query) and a rejection from it must reach the terminal error
 *   middleware rather than becoming an unhandled promise
 *   rejection. The wrapper's purpose is orthogonal to
 *   authentication: it catches async errors, it does not check
 *   identity.
 *
 *   The other six route files in the codebase have both
 *   middlewares in this order — `asyncHandler(authenticate)` then
 *   `asyncHandler(controller)`. This file has only the second.
 *   The omission is documented in a comment at the route
 *   declaration site below so that a reader scanning the file
 *   does not mistake it for an oversight.
 *
 * Route ordering:
 *
 *   There is only one route in this file, so no ordering question
 *   arises. The route is declared as a single `router.get(...)`
 *   call. If a future addition ever introduces a second route to
 *   this feature — say, a `GET /api/version/history` — the
 *   established convention applies: declare more specific paths
 *   before more general ones, so the literal sub-path comes
 *   before the bare route.
 *
 * No try/catch appears anywhere in this file. That is deliberate
 * — the asyncHandler wrapper, combined with the terminal error
 * middleware registered in `app.ts`, form the single error-
 * handling contract for every route in the application,
 * including this one.
 */

import { Router } from 'express';

import { getLatestVersion } from '../controllers/versionController.js';
import { asyncHandler } from '../../shared/middleware/errorHandler.js';

// ============================================================
//  Router instance
// ============================================================

const versionRoutes = Router();

// ============================================================
//  GET /api/version
// ============================================================
//
//  The route is intentionally NOT protected by `authenticate`.
//  See the file header for the full rationale — in short, the
//  desktop client's update checker runs before the user has a
//  session and needs a public way to learn whether an update
//  exists. The `asyncHandler` wrapper is still applied so that
//  any rejection from the controller's async body is forwarded
//  to the terminal error middleware rather than becoming an
//  unhandled promise rejection.

versionRoutes.get(
  '/',
  asyncHandler(getLatestVersion)
);

// ============================================================
//  Default export
// ============================================================

export default versionRoutes;