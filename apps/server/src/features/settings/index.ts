/**
 * Public export surface for the WriteSpeare settings feature.
 *
 * The plan declares this file with a single responsibility:
 * "Public exports." That is the entire specification, and this
 * file fills it in with the minimal, non-redundant surface that
 * the rest of the codebase can meaningfully consume — following
 * the exact shape established by the topics feature's index at
 * `features/topics/index.ts`, the documents feature's index at
 * `features/documents/index.ts`, the articles feature's index at
 * `features/articles/index.ts`, and the reports feature's index
 * at `features/reports/index.ts`.
 *
 * This is the first of the feature indexes to export TWO models,
 * because the settings feature owns two collections — UserSetting
 * (per-user preferences, one document per user) and Preset
 * (named pipeline configuration bundles, which may be system-wide
 * or user-owned). Both models live under `features/settings/models/`
 * per the plan's file tree.
 *
 * What belongs here — and what does not:
 *
 *   The settings feature contains seven kinds of source files:
 *
 *     models/UserSetting.ts             — per-user preferences
 *     models/Preset.ts                  — pipeline configuration
 *     services/settingsService.ts       — business logic for both
 *     controllers/settingsController.ts — HTTP handlers
 *     routes/settingsRoutes.ts          — the Express router
 *     index.ts                          — this file
 *
 *   Of those six, three are useful to a consumer OUTSIDE the
 *   feature:
 *
 *     (a) The router. `app.ts` mounts it under `/api/settings`.
 *         That is the one import the feature's external boundary
 *         actually needs — the controller and service are
 *         internal implementation details between the router and
 *         the models, and nothing outside the feature should
 *         reach past the router for request-handling behavior.
 *
 *     (b) `PresetModel`. The admin feature's service
 *         (`adminService.ts`) manages system-wide presets — the
 *         `userId: null` scope — and imports `PresetModel`
 *         directly from `settings/models/Preset.js` to do so.
 *         That is a real, active cross-feature dependency, and
 *         exporting the model here gives it (and any future
 *         consumer) a single named entry point.
 *
 *     (c) `UserSettingModel`. No consumer exists today — the
 *         model is only used by the settings feature's own
 *         service. The export exists for symmetry with the
 *         other feature indexes and for any future feature
 *         (an admin-facing "view all user settings" view, a
 *         user-preferences audit log) that would need to read
 *         from outside the feature's HTTP surface.
 *
 *   The service and controller are NOT re-exported. Both are
 *   internal: the service is only ever consumed by the
 *   controller within the same feature, and the controller is
 *   only ever consumed by the router within the same feature.
 *   Additionally, their function names collide — both export
 *   `getUserSettings`, `updateUserSettings`, etc. — and
 *   re-exporting both with bare names would produce a
 *   duplicate-export error. The rule this file follows,
 *   matching the four previous features' indexes: export what
 *   is consumed, not everything that exists.
 *
 *   The `UserSettingsUpdatePayload` type that the service
 *   declares and exports is also NOT re-exported here. It is a
 *   service-level type — a `Partial<UserSettingsMap>` alias
 *   used by the settings controller — not a feature-boundary
 *   type. The controller imports it directly from the service,
 *   and no consumer outside the feature has any use for it.
 *
 * Why the router is exported both as a named symbol AND as the
 * default:
 *
 *   The router file itself (`routes/settingsRoutes.ts`) exports
 *   its router as the default. This index file preserves that
 *   shape for callers that prefer the default form — `import
 *   settingsRoutes from '...features/settings'` — while also
 *   giving the named form — `import { settingsRoutes } from
 *   '...features/settings'` — to callers that prefer named
 *   imports for uniformity with the rest of this file's exports.
 *
 *   The two forms resolve to the same router instance. There is
 *   no double-construction, no second Express `Router()`, and
 *   no chance of the router being registered twice by mistake.
 *
 * Note for readers who have been following the session:
 *
 *   The current `app.ts` imports the settings router from its
 *   deep path (`./features/settings/routes/settingsRoutes.js`),
 *   not from this index. The current `adminService.ts` imports
 *   `PresetModel` from `./features/settings/models/Preset.js`,
 *   not from this index either. Neither import needs to change
 *   — this index is a forward-looking surface that a future
 *   refactor can adopt. Until that refactor, this file's
 *   exports are dormant — nothing in the codebase currently
 *   imports from it.
 *
 *   That is fine, and it is what the plan's "Public exports"
 *   annotation calls for. The surface exists so that when a
 *   consumer DOES need it, there is a declared, documented place
 *   for that import to come from — rather than a deep path that
 *   was chosen ad hoc.
 */

// ============================================================
//  Router
// ============================================================
//
//  The router is the feature's public API surface — the one
//  import that the app factory needs in order to mount the
//  settings and preset endpoints. Both the default-export form
//  and the named-export form resolve to the same router
//  instance (see the file header for the reasoning).

export { default as settingsRoutes } from './routes/settingsRoutes.js';
export { default } from './routes/settingsRoutes.js';

// ============================================================
//  UserSetting model
// ============================================================
//
//  Per-user preferences — one document per user, enforced by a
//  unique index on `userId`. No outside consumer today; the
//  export exists for symmetry with the other feature indexes
//  and for any future feature that needs to read a user's
//  preferences without going through the settings HTTP surface.
//
//  The `UserSettingDocument` type is re-exported with the `type`
//  modifier so the compiler can erase it at emit time.

export {
  UserSettingModel,
  type UserSettingDocument,
} from './models/UserSetting.js';

// ============================================================
//  Preset model
// ============================================================
//
//  Named pipeline configuration bundles. The admin feature's
//  service currently imports `PresetModel` from the deep path
//  (`settings/models/Preset.js`) to manage the system-wide
//  scope — `userId: null`. That import would continue to work
//  identically if it were changed to import from this index
//  instead; no such change is required, but this export gives
//  that consumer (and any future one) a single named entry
//  point.
//
//  The `PresetDocument` type is re-exported with the `type`
//  modifier so the compiler can erase it at emit time.

export { PresetModel, type PresetDocument } from './models/Preset.js';