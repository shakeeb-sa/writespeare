/**
 * Route table for the WriteSpeare users feature.
 *
 * Declares the five admin-only user-management endpoints and the
 * middleware chain that runs in front of each. The router is
 * mounted at `/api/users` by the app factory (`src/app.ts`), so
 * the paths declared below are relative to that prefix:
 *
 *   POST   /api/users          → create a new user
 *   GET    /api/users          → list users, optional filters
 *   GET    /api/users/:id      → read one user
 *   PATCH  /api/users/:id      → partial update
 *   DELETE /api/users/:id      → delete
 *
 * Every route is protected by BOTH `authenticate` AND
 * `requireAdmin`. That is the one structural difference between
 * this file and the previous six route files in the codebase:
 *
 *   - The `authenticate` middleware verifies the bearer token
 *     and attaches the decoded payload to `req.user`. It is
 *     async — it awaits a user lookup to confirm the account
 *     still exists and is active.
 *
 *   - The `requireAdmin` middleware (which must run AFTER
 *     `authenticate`, because it reads `req.user`) rejects the
 *     request with a 403 when the attached user's role is not
 *     `UserRole.ADMIN`. Its current implementation is
 *     synchronous — it reads `req.user`, sends a response on
 *     failure, or calls `next()` on success.
 *
 * A non-admin authenticated user cannot reach any handler in
 * this file. The controller's handlers therefore do not re-check
 * the role — that check has already been performed by the
 * middleware, and duplicating it in the controller would split
 * the authorization contract across two files. The
 * `userController.ts` file header documents the same arrangement
 * from the controller's perspective.
 *
 * Middleware order:
 *
 *   `authenticate` runs first and is applied via `asyncHandler`
 *   because it is an async function. The wrapper is required —
 *   without it, a rejection inside the middleware would reach
 *   the terminal error handler as an unhandled promise
 *   rejection on runtimes that do not forward the rejection
 *   automatically. This matches the wrapping pattern used in
 *   every previous route file.
 *
 *   `requireAdmin` runs second and is ALSO applied via
 *   `asyncHandler`, even though its current implementation is
 *   synchronous and cannot produce an unhandled rejection. The
 *   wrapper is applied for two reasons:
 *
 *     (1) Uniformity. Every middleware in this file's chain
 *         takes the same `asyncHandler(fn)` form, so a reader
 *         scanning the file does not have to work out which
 *         middlewares are async and which are not. The three
 *         middlewares on each route read as a single repeating
 *         shape.
 *
 *     (2) Future-proofing. If `requireAdmin` is ever changed to
 *         an async function — for example, to re-check the
 *         user's current role from the database rather than
 *         trusting the token payload — the wrapper is already
 *         in place and no call-site change is needed. The cost
 *         of the extra promise allocation per request is
 *         negligible compared to the cost of a future mid-
 *         refactor.
 *
 *   The controller runs third, also wrapped in `asyncHandler`
 *   for the same reason as every other controller: the service
 *   behind it can throw an `AppError` (404 for a user that does
 *   not exist, 409 for a duplicate email), and the wrapper is
 *   what converts that throw into a well-formed response via
 *   the terminal error middleware.
 *
 * Route ordering — collection routes before parameterized:
 *
 *   Express matches routes by segment count, so `GET /api/users`
 *   (one segment after the mount point) can never collide with
 *   `GET /api/users/:id` (two segments). The two are declared in
 *   collection-first order as a defensive habit, consistent with
 *   every other route file in the codebase: declare more
 *   specific paths before more general ones. Today no collision
 *   exists; tomorrow, if a literal sub-path like `/me` is added,
 *   the ordering will already be correct.
 *
 * The routes are declared as a flat sequence of `router.METHOD`
 * calls rather than as a route table or a declarative
 * configuration. This matches the convention established in
 * every previous route file — `authRoutes.ts`,
 * `topicRoutes.ts`, `documentRoutes.ts`, `articleRoutes.ts`,
 * `reportRoutes.ts`, `settingsRoutes.ts`, and
 * `versionRoutes.ts`.
 *
 * No try/catch appears anywhere in this file. That is deliberate
 * — the asyncHandler wrappers, combined with the terminal error
 * middleware registered in `app.ts`, form the single error-
 * handling contract for every route in the application.
 */

import { Router } from 'express';

import {
  listUsers,
  getUserById,
  createUser,
  updateUser,
  deleteUser,
} from '../controllers/userController.js';

import {
  authenticate,
  requireAdmin,
} from '../../auth/middleware/authGuard.js';
import { asyncHandler } from '../../shared/middleware/errorHandler.js';

// ============================================================
//  Router instance
// ============================================================

const userRoutes = Router();

// ============================================================
//  POST /api/users
// ============================================================
//
//  Create a new user. Admin-only. The service hashes the
//  password before persisting; a duplicate email produces a
//  409 from the unique index on `email`.

userRoutes.post(
  '/',
  asyncHandler(authenticate),
  asyncHandler(requireAdmin),
  asyncHandler(createUser)
);

// ============================================================
//  GET /api/users
// ============================================================
//
//  List users, sorted newest first. Admin-only. Optional
//  `?role=` and `?active=` query parameters narrow the result;
//  the controller validates each filter's shape before
//  delegating.

userRoutes.get(
  '/',
  asyncHandler(authenticate),
  asyncHandler(requireAdmin),
  asyncHandler(listUsers)
);

// ============================================================
//  GET /api/users/:id
// ============================================================
//
//  Return a single user by ID. Admin-only. The service returns
//  null when the target does not exist; the controller converts
//  that null into a 404. There is no "not owned by you" case —
//  the caller is an admin acting on arbitrary users.

userRoutes.get(
  '/:id',
  asyncHandler(authenticate),
  asyncHandler(requireAdmin),
  asyncHandler(getUserById)
);

// ============================================================
//  PATCH /api/users/:id
// ============================================================
//
//  Partial update of a user. Admin-only. If the update includes
//  a `password` field, the service hashes it before writing;
//  the controller passes the plaintext through and never sees
//  the resulting hash.

userRoutes.patch(
  '/:id',
  asyncHandler(authenticate),
  asyncHandler(requireAdmin),
  asyncHandler(updateUser)
);

// ============================================================
//  DELETE /api/users/:id
// ============================================================
//
//  Delete a user. Admin-only. The service does NOT cascade to
//  the target user's topics, documents, articles, reports,
//  settings, or presets — see the service header for the
//  cascade rationale. There is no guard against an admin
//  deleting their own account at this layer; the service
//  header documents why that check does not belong there, and
//  the controller header documents the same for its layer.

userRoutes.delete(
  '/:id',
  asyncHandler(authenticate),
  asyncHandler(requireAdmin),
  asyncHandler(deleteUser)
);

// ============================================================
//  Default export
// ============================================================

export default userRoutes;