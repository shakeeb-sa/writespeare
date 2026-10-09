/**
 * Public export surface for the WriteSpeare documents feature.
 *
 * The plan declares this file with a single responsibility:
 * "Public exports." That is the entire specification, and this
 * file fills it in with the minimal, non-redundant surface that
 * the rest of the codebase can meaningfully consume — following
 * the exact shape established by the topics feature's index at
 * `features/topics/index.ts`.
 *
 * What belongs here — and what does not:
 *
 *   The documents feature contains five kinds of source files:
 *
 *     models/Document.ts          — the Mongoose schema and its
 *                                   document interface
 *     services/documentService.ts
 *                                 — the business-logic layer
 *     controllers/documentController.ts
 *                                 — the HTTP handlers
 *     routes/documentRoutes.ts    — the Express router
 *     index.ts                    — this file
 *
 *   Of those five, only TWO are useful to a consumer OUTSIDE the
 *   feature:
 *
 *     (a) The router. `app.ts` mounts it under `/api/documents`.
 *         That is the one import the feature's external boundary
 *         actually needs — the controller and service are
 *         internal implementation details between the router and
 *         the model, and nothing outside the feature should
 *         reach past the router for request-handling behavior.
 *
 *     (b) The model. A future feature that owns a record with a
 *         document reference — currently none, but the pattern
 *         is symmetric with the topics feature — would need to
 *         validate the parent document's existence and ownership
 *         at write time. Exporting the model from the feature
 *         index gives a single named entry point that such a
 *         consumer can lean on without reaching into the feature
 *         folder.
 *
 *   The service and controller are NOT re-exported. Both are
 *   internal: the service is only ever consumed by the
 *   controller within the same feature, and the controller is
 *   only ever consumed by the router within the same feature.
 *   Additionally, their function names collide — both export
 *   `createDocument`, `listDocuments`, etc. — and re-exporting
 *   both with bare names would produce a duplicate-export error.
 *   The rule this file follows, matching the topics feature:
 *   export what is consumed, not everything that exists.
 *
 * Why the router is exported both as a named symbol AND as the
 * default:
 *
 *   The router file itself (`routes/documentRoutes.ts`) exports
 *   its router as the default. This index file preserves that
 *   shape for callers that prefer the default form — `import
 *   documentRoutes from '...features/documents'` — while also
 *   giving the named form — `import { documentRoutes } from
 *   '...features/documents'` — to callers that prefer named
 *   imports for uniformity with the rest of this file's exports.
 *
 *   The two forms resolve to the same router instance. There is
 *   no double-construction, no second Express `Router()`, and
 *   no chance of the router being registered twice by mistake.
 *
 * Note for readers who have been following the session:
 *
 *   The current `app.ts` imports its feature routers from their
 *   deep paths (`./features/documents/routes/documentRoutes.js`),
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
//  document endpoints. Both the default-export form and the
//  named-export form resolve to the same router instance (see
//  the file header for the reasoning).

export { default as documentRoutes } from './routes/documentRoutes.js';
export { default } from './routes/documentRoutes.js';

// ============================================================
//  Model
// ============================================================
//
//  The Mongoose model and its hydrated document interface.
//  Exported so that any sibling feature which ever owns a
//  record with a document reference has a single, documented
//  import path for the parent-ownership check that such a
//  feature's create path would perform.
//
//  The `DocumentDocument` type is re-exported with the `type`
//  modifier so the compiler can erase it at emit time; it has
//  no runtime representation.

export { DocumentModel, type DocumentDocument } from './models/Document.js';