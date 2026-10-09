/**
 * Public export surface for the WriteSpeare admin feature.
 *
 * The plan declares this file with a single responsibility:
 * "Public exports." That is the entire specification, and this
 * file fills it in with the minimal surface that the rest of the
 * codebase can meaningfully consume — following the shape
 * established by the seven previous feature indexes:
 * `features/topics/index.ts`, `features/documents/index.ts`,
 * `features/articles/index.ts`, `features/reports/index.ts`,
 * `features/settings/index.ts`, `features/version/index.ts`,
 * and `features/users/index.ts`.
 *
 * This is the SECOND of the feature indexes with NO model
 * section (the first was the users feature, File 54):
 *
 *   The admin feature owns no collection of its own. Its
 *   service (`adminService.ts`) operates on the `Preset` model
 *   that lives under the settings feature at
 *   `features/settings/models/Preset.js`, managing the
 *   system-wide preset scope — the Preset documents with
 *   `userId: null` that every user of the installation reads.
 *   The user-facing preset management lives in the settings
 *   feature's own service; the admin feature is the one path
 *   that can create, edit, or delete presets in the SYSTEM
 *   scope, which the settings service deliberately excludes
 *   from its own write paths.
 *
 *   Because there is no model owned by this feature, there is
 *   no model to re-export. Re-exporting `PresetModel` from
 *   `features/settings/models/Preset.js` via this index would
 *   be misleading: it would tell a reader that the admin
 *   feature owns the Preset collection, when in fact the
 *   settings feature does. A consumer that needs the Preset
 *   model should import it from where it lives —
 *   `features/settings/models/Preset.js` — or, once the
 *   settings index is populated, from
 *   `features/settings/index.ts`.
 *
 * What belongs here — and what does not:
 *
 *   The admin feature contains five kinds of source files:
 *
 *     services/adminService.ts         — system-preset logic
 *     controllers/adminController.ts   — HTTP handlers
 *     routes/adminRoutes.ts            — the Express router
 *     middleware/adminGuard.ts         — an empty placeholder
 *                                        (see the note below)
 *     index.ts                         — this file
 *
 *   Of those five, only ONE is useful to a consumer OUTSIDE the
 *   feature:
 *
 *     The router. `app.ts` mounts it under `/api/admin`. That is
 *     the one import the feature's external boundary actually
 *     needs — the controller and service are internal
 *     implementation details between the router and the Preset
 *     collection, and nothing outside the feature should reach
 *     past the router for request-handling behavior.
 *
 *   The service and controller are NOT re-exported. Both are
 *   internal: the service is only ever consumed by the
 *   controller within the same feature, and the controller is
 *   only ever consumed by the router within the same feature.
 *   Additionally, their function names collide — both export
 *   `listSystemPresets`, `upsertSystemPreset`, etc. — and
 *   re-exporting both with bare names would produce a
 *   duplicate-export error.
 *
 *   The `admin/middleware/adminGuard.ts` file — the plan's
 *   empty placeholder for a role-check middleware — is NOT
 *   re-exported. That file is not imported by anything, and the
 *   admin routes use the working `requireAdmin` middleware from
 *   `auth/middleware/authGuard.js` instead. Re-exporting the
 *   empty file's (nonexistent) exports would be a compile error;
 *   leaving it out is the correct behavior. See the file header
 *   of `adminRoutes.ts` for the full reasoning on the redundant
 *   middleware declaration.
 *
 * Why the router is exported both as a named symbol AND as the
 * default:
 *
 *   The router file itself (`routes/adminRoutes.ts`) exports
 *   its router as the default. This index file preserves that
 *   shape for callers that prefer the default form — `import
 *   adminRoutes from '...features/admin'` — while also giving
 *   the named form — `import { adminRoutes } from
 *   '...features/admin'` — to callers that prefer named imports
 *   for uniformity with the rest of this file's exports.
 *
 *   The two forms resolve to the same router instance. There is
 *   no double-construction, no second Express `Router()`, and
 *   no chance of the router being registered twice by mistake.
 *
 * Note for readers who have been following the session:
 *
 *   The current `app.ts` imports the admin router from its deep
 *   path (`./features/admin/routes/adminRoutes.js`), not from
 *   this index. That import needs no change — this index is a
 *   forward-looking surface that a future refactor can adopt.
 *   Until that refactor, this file's exports are dormant —
 *   nothing in the codebase currently imports from it.
 *
 *   That is fine, and it is what the plan's "Public exports"
 *   annotation calls for. The surface exists so that when a
 *   consumer DOES need it, there is a declared, documented place
 *   for that import to come from — rather than a deep path that
 *   was chosen ad hoc.
 *
 *   With this file in place, only the auth feature's index
 *   (`features/auth/index.ts`) remains empty among the eight
 *   feature folders in the codebase. That one will be populated
 *   separately — the auth feature owns the `User` model, so it
 *   is the last index with a full router-and-model shape.
 */

// ============================================================
//  Router
// ============================================================
//
//  The router is the feature's only public API surface — the
//  one import that the app factory needs in order to mount the
//  admin system-preset endpoints. Both the default-export form
//  and the named-export form resolve to the same router
//  instance (see the file header for the reasoning).
//
//  There is no model section in this file. See the file header
//  for why: the admin feature owns no collection, and re-
//  exporting the settings feature's `PresetModel` from here
//  would misrepresent the ownership relationship.

export { default as adminRoutes } from './routes/adminRoutes.js';
export { default } from './routes/adminRoutes.js';