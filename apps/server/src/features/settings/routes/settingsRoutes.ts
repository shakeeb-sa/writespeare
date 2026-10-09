/**
 * Route table for the WriteSpeare settings feature.
 *
 * Declares the seven settings and preset endpoints and the
 * middleware chain that runs in front of each. The router is
 * mounted at `/api/settings` by the app factory (`src/app.ts`),
 * so the paths declared below are relative to that prefix:
 *
 *   GET    /                        → read the user's settings
 *   PATCH  /                        → partial update of settings
 *   GET    /presets                 → list visible presets
 *   POST   /presets                 → create a user-owned preset
 *   GET    /presets/:id             → read one preset
 *   PATCH  /presets/:id             → update one user-owned preset
 *   DELETE /presets/:id             → delete one user-owned preset
 *
 * Every route is protected by `authenticate`. Settings and presets
 * are user-scoped by design:
 *
 *   - Settings: exactly one settings document per user, with
 *     ownership enforced by the unique index on `userId`.
 *
 *   - Presets: system presets are visible to every user but are
 *     not writable through any route here; a user's own presets
 *     are visible and writable only to that user. The visibility
 *     and write-authorization rules live in the service (see
 *     `settingsService.ts`), and every route below simply
 *     delegates with the authenticated `userId`.
 *
 * Middleware order:
 *
 *   `authenticate` runs first and is applied via `asyncHandler`
 *   because the function is async (it awaits a user lookup to
 *   confirm the account still exists and is active). The wrapper
 *   is required — without it, a rejection inside the middleware
 *   would reach the terminal error handler as an unhandled
 *   promise rejection on runtimes that do not forward the
 *   rejection automatically. The existing `authRoutes.ts`,
 *   `topicRoutes.ts`, `documentRoutes.ts`, `articleRoutes.ts`,
 *   and `reportRoutes.ts` files use the same wrapping pattern for
 *   the same reason, and all six must stay in step.
 *
 *   The controller runs second, also wrapped in `asyncHandler`,
 *   for the same reason: the service behind it can throw an
 *   `AppError` (404 for a settings document or preset that does
 *   not exist or belongs to a different user; 409 for a preset
 *   name collision within the caller's scope), and the wrapper
 *   is what converts that throw into a well-formed response via
 *   the terminal error middleware.
 *
 * Route ordering — the `/presets/:id` routes vs the `/presets`
 * collection routes:
 *
 *   Express matches routes segment-by-segment, so a request for
 *   `GET /presets` cannot match `GET /presets/:id` (different
 *   segment counts) and vice versa. There is no collision to
 *   avoid at the ordering level, and either declaration order
 *   would produce identical behaviour.
 *
 *   The collection routes are nevertheless declared before the
 *   parameterised ones, as a defensive habit. The rule of thumb
 *   across all route files in this codebase: declare more
 *   specific paths before more general ones. If a future
 *   addition ever introduces a literal sub-path under `/presets`
 *   — say, `GET /presets/system` — the ordering will already be
 *   correct.
 *
 * The two top-level routes (`GET /` and `PATCH /`) have no
 * siblings at the root level, so there is no ordering question
 * for them. They are declared first, before the `/presets`
 * group, to keep the file readable: the settings-only routes
 * come first, then the presets group in a visually separate
 * section.
 *
 * The routes are declared as a flat sequence of `router.METHOD`
 * calls rather than as a route table or a declarative
 * configuration. This matches the convention established in
 * every previous route file and in every route file the plan
 * will produce. A reader can scan the file top to bottom and see
 * exactly which middleware runs on which route without holding
 * any additional context.
 *
 * No try/catch appears anywhere in this file. That is deliberate
 * — the asyncHandler wrappers, combined with the terminal error
 * middleware registered in `app.ts`, form the single error-
 * handling contract for every route in the application.
 */

import { Router } from 'express';

import {
  getUserSettings,
  updateUserSettings,
  listPresets,
  createPreset,
  getPresetById,
  updatePreset,
  deletePreset,
} from '../controllers/settingsController.js';

import { authenticate } from '../../auth/middleware/authGuard.js';
import { asyncHandler } from '../../shared/middleware/errorHandler.js';

// ============================================================
//  Router instance
// ============================================================

const settingsRoutes = Router();

// ============================================================
//  GET /api/settings
// ============================================================
//
//  Read the authenticated user's settings. The service upserts
//  on read, so a user who has never opened the Settings page
//  receives a document with schema defaults applied — never a
//  404 for "settings not configured".

settingsRoutes.get(
  '/',
  asyncHandler(authenticate),
  asyncHandler(getUserSettings)
);

// ============================================================
//  PATCH /api/settings
// ============================================================
//
//  Partial update of the authenticated user's settings. Every
//  field on the settings map is optional in the body; fields
//  that are absent are left unchanged. A body with no
//  recognised fields is a valid no-op.

settingsRoutes.patch(
  '/',
  asyncHandler(authenticate),
  asyncHandler(updateUserSettings)
);

// ============================================================
//  GET /api/settings/presets
// ============================================================
//
//  List every preset visible to the authenticated user — the
//  system presets (userId: null) plus the caller's own. Presets
//  owned by other users are excluded by the service's read
//  filter.

settingsRoutes.get(
  '/presets',
  asyncHandler(authenticate),
  asyncHandler(listPresets)
);

// ============================================================
//  POST /api/settings/presets
// ============================================================
//
//  Create a preset owned by the authenticated user. The service
//  sets the owner from the session, never from the body, so a
//  client cannot create a system preset or a preset on behalf
//  of another user. A duplicate name within the caller's own
//  preset set produces a 409 via the compound unique index on
//  (userId, name).

settingsRoutes.post(
  '/presets',
  asyncHandler(authenticate),
  asyncHandler(createPreset)
);

// ============================================================
//  GET /api/settings/presets/:id
// ============================================================
//
//  Read a single preset by ID. The service's read filter accepts
//  both system presets and the caller's own presets; a preset
//  owned by a different user produces a null, which the
//  controller converts to a 404 without distinguishing the
//  "missing" case from the "not yours" case.

settingsRoutes.get(
  '/presets/:id',
  asyncHandler(authenticate),
  asyncHandler(getPresetById)
);

// ============================================================
//  PATCH /api/settings/presets/:id
// ============================================================
//
//  Partial update of a preset the authenticated user owns.
//  System presets are not updatable through this route — the
//  service's write filter excludes the system scope, and the
//  resulting service error surfaces as a 404. The preset's
//  `name` field is deliberately not read from the body; see the
//  controller header for the rationale.

settingsRoutes.patch(
  '/presets/:id',
  asyncHandler(authenticate),
  asyncHandler(updatePreset)
);

// ============================================================
//  DELETE /api/settings/presets/:id
// ============================================================
//
//  Delete a preset the authenticated user owns. System presets
//  are not deletable through this route for the same reason
//  they are not updatable — the service's write filter excludes
//  the system scope. Presets have no children, so there is no
//  cascade to consider.

settingsRoutes.delete(
  '/presets/:id',
  asyncHandler(authenticate),
  asyncHandler(deletePreset)
);

// ============================================================
//  Default export
// ============================================================

export default settingsRoutes;