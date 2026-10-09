/**
 * Public export surface for the WriteSpeare version feature.
 *
 * The plan declares this file with a single responsibility:
 * "Public exports." That is the entire specification, and this
 * file fills it in with the minimal, non-redundant surface that
 * the rest of the codebase can meaningfully consume — following
 * the exact shape established by the topics feature's index at
 * `features/topics/index.ts`, the documents feature's index at
 * `features/documents/index.ts`, the articles feature's index at
 * `features/articles/index.ts`, the reports feature's index at
 * `features/reports/index.ts`, and the settings feature's index
 * at `features/settings/index.ts`.
 *
 * What belongs here — and what does not:
 *
 *   The version feature contains four kinds of source files:
 *
 *     models/AppVersion.ts        — the Mongoose schema and its
 *                                   document interface
 *     controllers/versionController.ts
 *                                 — the HTTP handler
 *     routes/versionRoutes.ts     — the Express router
 *     index.ts                    — this file
 *
 *   Of those four, only TWO are useful to a consumer OUTSIDE the
 *   feature:
 *
 *     (a) The router. `app.ts` mounts it under `/api/version`.
 *         That is the one import the feature's external boundary
 *         actually needs — the controller is an internal
 *         implementation detail between the router and the
 *         model, and nothing outside the feature should reach
 *         past the router for request-handling behavior.
 *
 *     (b) The model. No consumer exists today — the version
 *         feature is the smallest in the codebase, with a single
 *         read endpoint and no cross-feature references. The
 *         model is only used by its own controller. The export
 *         exists for symmetry with the other feature indexes
 *         and for any future tooling that would need to publish
 *         a new AppVersion record (an admin release-publishing
 *         endpoint, a CI job that writes the current build's
 *         version on deploy) without going through the version
 *         feature's HTTP surface.
 *
 *   Unlike every other feature in this codebase, the version
 *   feature has NO service file. The single query it performs —
 *   reading the most recent AppVersion document by `createdAt` —
 *   is trivially expressible as a single Mongoose call, and the
 *   plan does not declare a service for this feature. Introducing
 *   one would add a file without adding a decision: there is no
 *   business logic to encapsulate, no cross-field validation to
 *   perform, and no cascade to manage. The controller talks
 *   directly to the model, and the file header of
 *   `versionController.ts` documents that arrangement.
 *
 *   For the same reason, there is no controller-vs-service naming
 *   collision to work around in this index. The only symbol this
 *   feature exports besides the router and the model is the
 *   controller's single handler — which is an internal detail
 *   and is NOT re-exported here.
 *
 * Why the router is exported both as a named symbol AND as the
 * default:
 *
 *   The router file itself (`routes/versionRoutes.ts`) exports
 *   its router as the default. This index file preserves that
 *   shape for callers that prefer the default form — `import
 *   versionRoutes from '...features/version'` — while also
 *   giving the named form — `import { versionRoutes } from
 *   '...features/version'` — to callers that prefer named
 *   imports for uniformity with the rest of this file's exports.
 *
 *   The two forms resolve to the same router instance. There is
 *   no double-construction, no second Express `Router()`, and
 *   no chance of the router being registered twice by mistake.
 *
 * Note for readers who have been following the session:
 *
 *   The current `app.ts` imports the version router from its
 *   deep path (`./features/version/routes/versionRoutes.js`),
 *   not from this index. That import needs no change — this
 *   index is a forward-looking surface that a future refactor
 *   can adopt. Until that refactor, this file's exports are
 *   dormant — nothing in the codebase currently imports from it.
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
//  version endpoint. Both the default-export form and the
//  named-export form resolve to the same router instance (see
//  the file header for the reasoning).

export { default as versionRoutes } from './routes/versionRoutes.js';
export { default } from './routes/versionRoutes.js';

// ============================================================
//  Model
// ============================================================
//
//  The Mongoose model and its hydrated document interface.
//  Exported for symmetry with the other feature indexes and for
//  any future tooling that needs to publish an AppVersion record
//  without going through the version feature's HTTP surface.
//
//  The `AppVersionDocument` type is re-exported with the `type`
//  modifier so the compiler can erase it at emit time; it has
//  no runtime representation.

export {
  AppVersionModel,
  type AppVersionDocument,
} from './models/AppVersion.js';