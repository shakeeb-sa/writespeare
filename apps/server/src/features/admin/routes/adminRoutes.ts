/**
 * Route table for the WriteSpeare admin feature.
 *
 * Declares the four admin-only system-preset management endpoints
 * and the middleware chain that runs in front of each. The router
 * is mounted at `/api/admin` by the app factory (`src/app.ts`),
 * so the paths declared below are relative to that prefix:
 *
 *   GET    /presets                → list every system preset
 *   GET    /presets/:name          → read one system preset by name
 *   PUT    /presets/:name          → create or replace a system preset
 *   DELETE /presets/:name          → delete a system preset
 *
 * Every route is protected by BOTH `authenticate` AND
 * `requireAdmin`. This is the same dual-middleware arrangement
 * that `userRoutes.ts` uses (File 44), and the two route tables
 * are the only ones in the codebase that layer `requireAdmin` on
 * top of `authenticate` — every other feature's routes are
 * user-scoped and rely on `authenticate` alone.
 *
 * Why these paths are grouped under `/api/admin/presets` rather
 * than under `/api/presets`:
 *
 *   Presets already have a user-facing endpoint surface at
 *   `/api/settings/presets` (see `settingsRoutes.ts`, File 38).
 *   That surface exposes the user's OWN presets plus the system
 *   presets in a merged list, and it allows create/update/delete
 *   operations only on the caller's own presets — the
 *   user-scoped `settingsService` deliberately excludes the
 *   system scope from every write path.
 *
 *   The system-preset management operations that this file
 *   exposes are a DIFFERENT capability on a DIFFERENT scope: an
 *   administrator managing the shared, system-wide presets that
 *   every user reads. Keeping them under `/api/admin/presets`
 *   makes the distinction structural, not merely semantic — the
 *   URL alone tells a reader (and a middleware) that these
 *   operations are admin-scoped, and the `requireAdmin` guard
 *   that all four routes carry enforces it.
 *
 * Which middleware to use for the admin role check:
 *
 *   The plan's file tree declares an `admin/middleware/adminGuard.ts`
 *   with the annotation "Ensures admin role". That file exists on
 *   disk as an empty placeholder, and its annotated responsibility
 *   is the SAME responsibility that the auth feature's
 *   `requireAdmin` middleware already fulfills — the one that was
 *   written in Session 1 and is already in use by `userRoutes.ts`
 *   (File 44). There is only one admin-role check to perform, and
 *   it has one implementation.
 *
 *   This file therefore imports `requireAdmin` from
 *   `auth/middleware/authGuard.js` — the working, proven
 *   implementation — and leaves `admin/middleware/adminGuard.ts`
 *   as an unused placeholder. If the plan intended that file to
 *   contain a genuinely DIFFERENT check (a stricter policy, a
 *   second factor, anything beyond "the caller's role is
 *   admin"), that intent is not documented anywhere and cannot
 *   be guessed; the correct disposition is to leave the file
 *   alone and note the redundancy in the PLAN DELTA section of
 *   the execution response.
 *
 * Middleware order:
 *
 *   `authenticate` runs first and is applied via `asyncHandler`
 *   because it is an async function (it awaits a user lookup to
 *   confirm the account still exists and is active). The wrapper
 *   is required — without it, a rejection inside the middleware
 *   would reach the terminal error handler as an unhandled
 *   promise rejection on runtimes that do not forward the
 *   rejection automatically. This matches the wrapping pattern
 *   used in every previous route file.
 *
 *   `requireAdmin` runs second and is ALSO applied via
 *   `asyncHandler`, even though its current implementation is
 *   synchronous. The rationale is the same as in `userRoutes.ts`:
 *   uniformity across the three-middleware chain, and future-
 *   proofing in case `requireAdmin` is ever made async. The
 *   cost is one extra promise allocation per request, which is
 *   negligible.
 *
 *   The controller runs third, also wrapped in `asyncHandler`
 *   for the same reason as every other controller: the service
 *   behind it can throw an `AppError` (404 for a preset that
 *   does not exist, 409 for a name collision within the system
 *   scope), and the wrapper is what converts that throw into a
 *   well-formed response via the terminal error middleware.
 *
 * Route ordering — collection route before parameterized ones:
 *
 *   Express matches routes by segment count, so `GET /presets`
 *   (one segment after the mount point) can never collide with
 *   `GET /presets/:name` (two segments). The collection route is
 *   declared first as a defensive habit, consistent with every
 *   other route file in the codebase: declare more specific
 *   paths before more general ones. Today no collision exists;
 *   tomorrow, if a literal sub-path like `/presets/system` is
 *   added, the ordering will already be correct.
 *
 *   Within the parameterized group, all three routes live on the
 *   SAME path (`/presets/:name`) and are distinguished only by
 *   HTTP method — GET, PUT, and DELETE. Express's router keys on
 *   method + path, so the three cannot collide regardless of
 *   their declaration order. They are declared in the order
 *   GET → PUT → DELETE, which matches the natural reading order
 *   of "read, then write, then remove".
 *
 * The routes are declared as a flat sequence of `router.METHOD`
 * calls rather than as a route table or a declarative
 * configuration. This matches the convention established in
 * every previous route file — `authRoutes.ts`,
 * `topicRoutes.ts`, `documentRoutes.ts`, `articleRoutes.ts`,
 * `reportRoutes.ts`, `settingsRoutes.ts`, `versionRoutes.ts`,
 * and `userRoutes.ts`.
 *
 * No try/catch appears anywhere in this file. That is deliberate
 * — the asyncHandler wrappers, combined with the terminal error
 * middleware registered in `app.ts`, form the single error-
 * handling contract for every route in the application.
 */

import { Router } from 'express';

import {
  listSystemPresets,
  getSystemPresetByName,
  upsertSystemPreset,
  deleteSystemPreset,
} from '../controllers/adminController.js';

import {
  authenticate,
  requireAdmin,
} from '../../auth/middleware/authGuard.js';
import { asyncHandler } from '../../shared/middleware/errorHandler.js';

// ============================================================
//  Router instance
// ============================================================

const adminRoutes = Router();

// ============================================================
//  GET /api/admin/presets
// ============================================================
//
//  List every system preset. Admin-only. Returns the presets
//  sorted by name so the admin UI shows them in a stable,
//  predictable order.

adminRoutes.get(
  '/presets',
  asyncHandler(authenticate),
  asyncHandler(requireAdmin),
  asyncHandler(listSystemPresets)
);

// ============================================================
//  GET /api/admin/presets/:name
// ============================================================
//
//  Read a single system preset by its slug name. Admin-only. A
//  name that does not match any system preset returns 404; a
//  user-owned preset with the same name is invisible to this
//  endpoint (the service's `{ userId: null }` filter excludes
//  it), which is correct — this endpoint manages the system
//  scope, not the user scope.

adminRoutes.get(
  '/presets/:name',
  asyncHandler(authenticate),
  asyncHandler(requireAdmin),
  asyncHandler(getSystemPresetByName)
);

// ============================================================
//  PUT /api/admin/presets/:name
// ============================================================
//
//  Create a new system preset, or update the existing one with
//  the same name. Admin-only. The operation is idempotent —
//  sending the same request twice produces the same final state
//  — which is why it is a PUT rather than a POST or PATCH. The
//  preset's `name` is taken from the URL, not the body; see the
//  controller header for the URL-vs-body precedence rule.

adminRoutes.put(
  '/presets/:name',
  asyncHandler(authenticate),
  asyncHandler(requireAdmin),
  asyncHandler(upsertSystemPreset)
);

// ============================================================
//  DELETE /api/admin/presets/:name
// ============================================================
//
//  Delete a system preset by its slug name. Admin-only. A name
//  that matches a user-owned preset but no system preset
//  returns 404 — the user's preset is not touched. No cascade:
//  the deleted preset is a template, and topics that were
//  configured with it store their own copy of the pipeline
//  settings.

adminRoutes.delete(
  '/presets/:name',
  asyncHandler(authenticate),
  asyncHandler(requireAdmin),
  asyncHandler(deleteSystemPreset)
);

// ============================================================
//  Default export
// ============================================================

export default adminRoutes;