/**
 * Public export surface for the WriteSpeare users feature.
 *
 * The plan declares this file with a single responsibility:
 * "Public exports." That is the entire specification, and this
 * file fills it in with the minimal surface that the rest of the
 * codebase can meaningfully consume — following the shape
 * established by the six previous feature indexes
 * (`features/topics/index.ts`, `features/documents/index.ts`,
 * `features/articles/index.ts`, `features/reports/index.ts`,
 * `features/settings/index.ts`, and `features/version/index.ts`).
 *
 * This is the FIRST of the feature indexes with NO model
 * section:
 *
 *   Every previous feature index re-exports at least one
 *   Mongoose model, because every previous feature owns one or
 *   more collections:
 *
 *     topics      owns Topic
 *     documents   owns Document
 *     articles    owns Article
 *     reports     owns Report
 *     settings    owns UserSetting and Preset
 *     version     owns AppVersion
 *
 *   The users feature owns NO collection. Its service
 *   (`userService.ts`) operates on the `User` model that lives
 *   under the auth feature at `features/auth/models/User.ts`.
 *   The admin-oriented CRUD it exposes targets the same User
 *   collection that the auth service reads from — the two
 *   services share the collection by design, because the auth
 *   service handles login/me (self-scoped) while the users
 *   service handles admin CRUD (any-user-scoped).
 *
 *   Because there is no model owned by this feature, there is
 *   no model to re-export. Re-exporting `UserModel` from
 *   `features/auth/models/User.js` via this index would be
 *   misleading: it would tell a reader that the users feature
 *   owns the User collection, when in fact the auth feature
 *   does. A consumer that needs the User model should import
 *   it from where it lives — `features/auth/models/User.js` —
 *   not from here.
 *
 * What belongs here — and what does not:
 *
 *   The users feature contains four kinds of source files:
 *
 *     services/userService.ts          — admin CRUD logic
 *     controllers/userController.ts    — HTTP handlers
 *     routes/userRoutes.ts             — the Express router
 *     index.ts                         — this file
 *
 *   Of those four, only ONE is useful to a consumer OUTSIDE the
 *   feature:
 *
 *     The router. `app.ts` mounts it under `/api/users`. That is
 *     the one import the feature's external boundary actually
 *     needs — the controller and service are internal
 *     implementation details between the router and the User
 *     collection, and nothing outside the feature should reach
 *     past the router for request-handling behavior.
 *
 *   The service and controller are NOT re-exported. Both are
 *   internal: the service is only ever consumed by the
 *   controller within the same feature, and the controller is
 *   only ever consumed by the router within the same feature.
 *   Additionally, their function names collide — both export
 *   `listUsers`, `getUserById`, etc. — and re-exporting both
 *   with bare names would produce a duplicate-export error.
 *
 *   The `PublicUser` type that the service declares and exports
 *   is also NOT re-exported here. It is a service-level type —
 *   a projection of the `User` domain interface minus the
 *   password hash — used by the controller to type its response
 *   payloads. No consumer outside the feature has a use for it;
 *   a consumer that needs the user shape should use the `User`
 *   type from `shared/types`, which is the authoritative
 *   declaration.
 *
 * Why the router is exported both as a named symbol AND as the
 * default:
 *
 *   The router file itself (`routes/userRoutes.ts`) exports its
 *   router as the default. This index file preserves that shape
 *   for callers that prefer the default form — `import
 *   userRoutes from '...features/users'` — while also giving
 *   the named form — `import { userRoutes } from
 *   '...features/users'` — to callers that prefer named imports
 *   for uniformity with the rest of this file's exports.
 *
 *   The two forms resolve to the same router instance. There is
 *   no double-construction, no second Express `Router()`, and
 *   no chance of the router being registered twice by mistake.
 *
 * Note for readers who have been following the session:
 *
 *   The current `app.ts` imports the users router from its deep
 *   path (`./features/users/routes/userRoutes.js`), not from
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
 */

// ============================================================
//  Router
// ============================================================
//
//  The router is the feature's only public API surface — the
//  one import that the app factory needs in order to mount the
//  user-management endpoints. Both the default-export form and
//  the named-export form resolve to the same router instance
//  (see the file header for the reasoning).
//
//  There is no model section in this file. See the file header
//  for why: the users feature owns no collection, and re-
//  exporting the auth feature's `UserModel` from here would
//  misrepresent the ownership relationship.

export { default as userRoutes } from './routes/userRoutes.js';
export { default } from './routes/userRoutes.js';