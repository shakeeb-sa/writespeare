/**
 * Public export surface for the WriteSpeare articles feature.
 *
 * The plan declares this file with a single responsibility:
 * "Public exports." That is the entire specification, and this
 * file fills it in with the minimal, non-redundant surface that
 * the rest of the codebase can meaningfully consume — following
 * the exact shape established by the topics feature's index at
 * `features/topics/index.ts` and the documents feature's index
 * at `features/documents/index.ts`.
 *
 * What belongs here — and what does not:
 *
 *   The articles feature contains five kinds of source files:
 *
 *     models/Article.ts          — the Mongoose schema and its
 *                                  document interface
 *     services/articleService.ts
 *                                — the business-logic layer
 *     controllers/articleController.ts
 *                                — the HTTP handlers
 *     routes/articleRoutes.ts    — the Express router
 *     index.ts                   — this file
 *
 *   Of those five, only TWO are useful to a consumer OUTSIDE the
 *   feature:
 *
 *     (a) The router. `app.ts` mounts it under `/api/articles`.
 *         That is the one import the feature's external boundary
 *         actually needs — the controller and service are
 *         internal implementation details between the router and
 *         the model, and nothing outside the feature should
 *         reach past the router for request-handling behavior.
 *
 *     (b) The model. The reports feature owns records with an
 *         `articleId` field — a Report validates one Article —
 *         and its service (`reportService.ts`) already imports
 *         `ArticleModel` directly from `articles/models/Article.js`
 *         to validate that a parent article exists and is owned
 *         by the caller. Exporting the model from the feature
 *         index gives that consumer (and any future one) a
 *         single named entry point without requiring a code
 *         change in the consumer.
 *
 *   The service and controller are NOT re-exported. Both are
 *   internal: the service is only ever consumed by the
 *   controller within the same feature, and the controller is
 *   only ever consumed by the router within the same feature.
 *   Additionally, their function names collide — both export
 *   `createArticle`, `listArticles`, etc. — and re-exporting
 *   both with bare names would produce a duplicate-export error.
 *   The rule this file follows, matching the two previous
 *   features' indexes: export what is consumed, not everything
 *   that exists.
 *
 * Why the router is exported both as a named symbol AND as the
 * default:
 *
 *   The router file itself (`routes/articleRoutes.ts`) exports
 *   its router as the default. This index file preserves that
 *   shape for callers that prefer the default form — `import
 *   articleRoutes from '...features/articles'` — while also
 *   giving the named form — `import { articleRoutes } from
 *   '...features/articles'` — to callers that prefer named
 *   imports for uniformity with the rest of this file's exports.
 *
 *   The two forms resolve to the same router instance. There is
 *   no double-construction, no second Express `Router()`, and
 *   no chance of the router being registered twice by mistake.
 *
 * Note for readers who have been following the session:
 *
 *   The current `app.ts` imports its feature routers from their
 *   deep paths (`./features/articles/routes/articleRoutes.js`),
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
//  article endpoints. Both the default-export form and the
//  named-export form resolve to the same router instance (see
//  the file header for the reasoning).

export { default as articleRoutes } from './routes/articleRoutes.js';
export { default } from './routes/articleRoutes.js';

// ============================================================
//  Model
// ============================================================
//
//  The Mongoose model and its hydrated document interface.
//  Exported so that the reports feature — which owns records
//  with an `articleId` reference — has a single, documented
//  import path for the parent-ownership check that its create
//  path performs.
//
//  The `ArticleDocument` type is re-exported with the `type`
//  modifier so the compiler can erase it at emit time; it has
//  no runtime representation.

export { ArticleModel, type ArticleDocument } from './models/Article.js';