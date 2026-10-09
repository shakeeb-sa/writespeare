/**
 * Public export surface for the WriteSpeare reports feature.
 *
 * The plan declares this file with a single responsibility:
 * "Public exports." That is the entire specification, and this
 * file fills it in with the minimal, non-redundant surface that
 * the rest of the codebase can meaningfully consume — following
 * the exact shape established by the topics feature's index at
 * `features/topics/index.ts`, the documents feature's index at
 * `features/documents/index.ts`, and the articles feature's
 * index at `features/articles/index.ts`.
 *
 * What belongs here — and what does not:
 *
 *   The reports feature contains five kinds of source files:
 *
 *     models/Report.ts            — the Mongoose schema and its
 *                                   document interface
 *     services/reportService.ts
 *                                 — the business-logic layer
 *     controllers/reportController.ts
 *                                 — the HTTP handlers
 *     routes/reportRoutes.ts      — the Express router
 *     index.ts                    — this file
 *
 *   Of those five, only TWO are useful to a consumer OUTSIDE the
 *   feature:
 *
 *     (a) The router. `app.ts` mounts it under `/api/reports`.
 *         That is the one import the feature's external boundary
 *         actually needs — the controller and service are
 *         internal implementation details between the router and
 *         the model, and nothing outside the feature should
 *         reach past the router for request-handling behavior.
 *
 *     (b) The model. A Report references its parent Article by
 *         `articleId`, and no feature BELOW reports references
 *         a report — reports are currently the leaf of the
 *         Topic → Document → Article → Report chain. So no
 *         consumer in the codebase imports `ReportModel` today.
 *         The export exists for symmetry with the other feature
 *         indexes and for any future feature (a report-
 *         aggregation view, a cross-article comparison, an
 *         analytics roll-up) that would need to read reports
 *         from outside this feature's HTTP surface.
 *
 *   The service and controller are NOT re-exported. Both are
 *   internal: the service is only ever consumed by the
 *   controller within the same feature, and the controller is
 *   only ever consumed by the router within the same feature.
 *   Additionally, their function names collide — both export
 *   `createReport`, `listReports`, etc. — and re-exporting both
 *   with bare names would produce a duplicate-export error.
 *   The rule this file follows, matching the three previous
 *   features' indexes: export what is consumed, not everything
 *   that exists.
 *
 * Why the router is exported both as a named symbol AND as the
 * default:
 *
 *   The router file itself (`routes/reportRoutes.ts`) exports
 *   its router as the default. This index file preserves that
 *   shape for callers that prefer the default form — `import
 *   reportRoutes from '...features/reports'` — while also
 *   giving the named form — `import { reportRoutes } from
 *   '...features/reports'` — to callers that prefer named
 *   imports for uniformity with the rest of this file's exports.
 *
 *   The two forms resolve to the same router instance. There is
 *   no double-construction, no second Express `Router()`, and
 *   no chance of the router being registered twice by mistake.
 *
 * Note for readers who have been following the session:
 *
 *   The current `app.ts` imports its feature routers from their
 *   deep paths (`./features/reports/routes/reportRoutes.js`),
 *   not from the feature indexes. This index file does NOT
 *   change that pattern retroactively; it is a forward-looking
 *   surface that a future app-factory refactor can adopt. Until
 *   that refactor, this file's exports are dormant — nothing in
 *   the codebase currently imports from it.
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
//  report endpoints. Both the default-export form and the
//  named-export form resolve to the same router instance (see
//  the file header for the reasoning).

export { default as reportRoutes } from './routes/reportRoutes.js';
export { default } from './routes/reportRoutes.js';

// ============================================================
//  Model
// ============================================================
//
//  The Mongoose model and its hydrated document interface.
//  Exported so that any future feature which ever needs to read
//  reports from outside the feature's HTTP surface has a
//  single, documented import path.
//
//  The `ReportDocument` type is re-exported with the `type`
//  modifier so the compiler can erase it at emit time; it has
//  no runtime representation.

export { ReportModel, type ReportDocument } from './models/Report.js';