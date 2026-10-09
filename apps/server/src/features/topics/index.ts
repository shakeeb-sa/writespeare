/**
 * Public export surface for the WriteSpeare topics feature.
 *
 * The plan declares this file with a single responsibility:
 * "Public exports." That is the entire specification, and this
 * file fills it in with the minimal, non-redundant surface that
 * the rest of the codebase can meaningfully consume.
 *
 * What belongs here — and what does not:
 *
 *   The topics feature contains five kinds of source files:
 *
 *     models/Topic.ts       — the Mongoose schema and its
 *                             document interface
 *     services/topicService.ts
 *                           — the business-logic layer
 *     controllers/topicController.ts
 *                           — the HTTP handlers
 *     routes/topicRoutes.ts — the Express router
 *     index.ts              — this file
 *
 *   Of those five, only TWO are useful to a consumer OUTSIDE the
 *   feature:
 *
 *     (a) The router. `app.ts` mounts it under `/api/topics`.
 *         That is the one import the feature's external boundary
 *         actually needs — the controller and service are
 *         internal implementation details between the router and
 *         the model, and nothing outside the feature should
 *         reach past the router for request-handling behavior.
 *
 *     (b) The model. Sibling features that own a record with a
 *         `topicId` field — currently `documents` and
 *         `articles` — need to validate, at write time, that the
 *         parent topic exists and is owned by the caller. Their
 *         service files already import `TopicModel` directly
 *         from `topics/models/Topic.js`, but exporting it from
 *         the feature index gives a single named entry point
 *         that a future refactor can lean on.
 *
 *   The service and controller are NOT re-exported. Both are
 *   internal: the service is only ever consumed by the
 *   controller within the same feature, and the controller is
 *   only ever consumed by the router within the same feature.
 *   Additionally, their function names collide — both export
 *   `createTopic`, `listTopics`, etc. — and re-exporting both
 *   with bare names would produce a duplicate-export error.
 *   Aliasing one of them (say, `topicService` and `topicController`
 *   namespaces) would work, but it would be pure noise for a
 *   surface that no consumer in the codebase actually uses.
 *   The rule this file follows: export what is consumed, not
 *   everything that exists.
 *
 * Why the router is exported both as a named symbol AND as the
 * default:
 *
 *   The router file itself (`routes/topicRoutes.ts`) exports its
 *   router as the default. This index file preserves that shape
 *   for callers that prefer the default form — `import
 *   topicRoutes from '...features/topics'` — while also giving
 *   the named form — `import { topicRoutes } from
 *   '...features/topics'` — to callers that prefer named imports
 *   for uniformity with the rest of this file's exports.
 *
 *   The two forms resolve to the same router instance. There is
 *   no double-construction, no second Express `Router()`, and
 *   no chance of the router being registered twice by mistake.
 *
 * Note for readers who have been following the session:
 *
 *   The current `app.ts` imports its auth router from
 *   `./features/auth/routes/authRoutes.js` — a deep path, not
 *   from the auth feature's index. This index file does NOT
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
//  topic endpoints. Both the default-export form and the
//  named-export form resolve to the same router instance (see
//  the file header for the reasoning).

export { default as topicRoutes } from './routes/topicRoutes.js';
export { default } from './routes/topicRoutes.js';

// ============================================================
//  Model
// ============================================================
//
//  The Mongoose model and its hydrated document interface.
//  Exported so that sibling features which own records with a
//  `topicId` field — documents, articles — have a single,
//  documented import path for the parent-ownership check that
//  their create paths perform.
//
//  The `TopicDocument` type is re-exported with the `type`
//  modifier so the compiler can erase it at emit time; it has
//  no runtime representation.

export { TopicModel, type TopicDocument } from './models/Topic.js';