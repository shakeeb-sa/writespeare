/**
 * Public export surface for the WriteSpeare auth feature.
 *
 * The plan declares this file with a single responsibility:
 * "Public exports." That is the entire specification, and this
 * file fills it in with the minimal, non-redundant surface that
 * the rest of the codebase can meaningfully consume — following
 * the exact shape established by the seven previous feature
 * indexes:
 *
 *   features/topics/index.ts       (File 48)
 *   features/documents/index.ts    (File 49)
 *   features/articles/index.ts     (File 50)
 *   features/reports/index.ts      (File 51)
 *   features/settings/index.ts     (File 52)
 *   features/version/index.ts      (File 53)
 *   features/users/index.ts        (File 54)
 *   features/admin/index.ts        (File 55)
 *
 * This is the LAST feature index in the session. After it, only
 * the app-factory update at `apps/server/src/app.ts` remains
 * before the backend is fully wired.
 *
 * The auth feature is the most heavily consumed feature in the
 * codebase — every other route file imports its `authenticate`
 * middleware, two route files import its `requireAdmin`
 * middleware, the users service imports its `User` model and
 * `hashPassword` util, and the app factory imports its router.
 * Despite that, this index file exports only the router and the
 * model, following the exact same rule every other feature index
 * follows: export what is consumed from OUTSIDE the feature via
 * the feature's public entry point, not everything the feature
 * happens to declare.
 *
 * What belongs here — and what does not:
 *
 *   The auth feature contains eight kinds of source files:
 *
 *     models/User.ts                    — the User schema
 *     middleware/authGuard.ts           — authenticate,
 *                                         optionalAuthenticate,
 *                                         requireAdmin
 *     services/authService.ts           — loginUser, getUserById
 *     controllers/authController.ts     — login, getMe
 *     routes/authRoutes.ts              — the Express router
 *     utils/bcrypt.ts                   — hashPassword,
 *                                         comparePassword
 *     utils/jwt.ts                      — signToken, verifyToken,
 *                                         decodeToken
 *     index.ts                          — this file
 *
 *   Of those eight, only TWO are useful to a consumer OUTSIDE the
 *   feature THROUGH THIS INDEX:
 *
 *     (a) The router. `app.ts` mounts it under `/api/auth`. That
 *         is the one import the feature's external boundary
 *         actually needs — the controller and service are
 *         internal implementation details between the router and
 *         the model, and nothing outside the feature should
 *         reach past the router for request-handling behavior.
 *
 *     (b) The model. The users feature's service operates on the
 *         same User collection that the auth feature owns — the
 *         two features share the collection by design, with
 *         authService handling self-scoped login and usersService
 *         handling admin-scoped CRUD. Exporting `UserModel` here
 *         gives the users and admin features a single named
 *         entry point for the collection they operate on, without
 *         changing their current imports (which reach into
 *         `auth/models/User.js` directly). This is the same
 *         reasoning as the settings index's `PresetModel` export
 *         (File 52), which the admin feature's service consumes.
 *
 *   The middleware, utils, service, and controller are NOT re-
 *   exported, for the following reasons:
 *
 *     - Middleware (`authenticate`, `requireAdmin`, and the
 *       others). These ARE consumed by every other route file in
 *       the codebase, but they are consumed via their deep path
 *       (`auth/middleware/authGuard.js`). Re-exporting them here
 *       would create a second entry point that duplicates the
 *       canonical import without changing any consumption. The
 *       rule this file follows — matching every previous feature
 *       index — is to export what is CONSUMED VIA THIS ENTRY
 *       POINT. Today, nothing imports middleware from
 *       `auth/index.ts`, and adding the export would not change
 *       that; it would only add surface. If a future refactor
 *       wants to adopt the index path for middleware imports, it
 *       can add the re-exports then — the decision is cheap to
 *       make later and expensive to make now (because it would
 *       need to be applied consistently across eight route files
 *       simultaneously).
 *
 *     - Utils (`hashPassword`, `comparePassword`, `signToken`,
 *       `verifyToken`, `decodeToken`, `TokenPayload`). These are
 *       consumed by the auth feature's own service and by the
 *       users feature's service (`userService.ts` imports
 *       `hashPassword` from `auth/utils/bcrypt.js`). Same
 *       reasoning as the middleware: consumed via deep paths,
 *       no current consumer imports from this index, and adding
 *       the export here does not change that. The one utility
 *       type that IS a feature-boundary type — `TokenPayload`,
 *       declared in `utils/jwt.ts` and used by `authGuard.ts`'s
 *       `AuthRequest` interface — is already re-exported via
 *       `authGuard.ts`'s own public surface and does not need
 *       a second entry point.
 *
 *     - Service (`loginUser`, `getUserById`, and the `PublicUser`
 *       type). Consumed only by the auth controller. Internal.
 *       Additionally, the service's function names collide with
 *       the controller's (`login` is exported from both) — a
 *       duplicate-export error would result from re-exporting
 *       both.
 *
 *     - Controller (`login`, `getMe`). Consumed only by the auth
 *       router. Internal. Same collision issue as the service.
 *
 * Why the router is exported both as a named symbol AND as the
 * default:
 *
 *   The router file itself (`routes/authRoutes.ts`) exports its
 *   router as the default. This index file preserves that shape
 *   for callers that prefer the default form — `import authRoutes
 *   from '...features/auth'` — while also giving the named form
 *   — `import { authRoutes } from '...features/auth'` — to
 *   callers that prefer named imports for uniformity with the
 *   rest of this file's exports.
 *
 *   The two forms resolve to the same router instance. There is
 *   no double-construction, no second Express `Router()`, and
 *   no chance of the router being registered twice by mistake.
 *
 * Note for readers who have been following the session:
 *
 *   The current `app.ts` imports the auth router from its deep
 *   path (`./features/auth/routes/authRoutes.js`), not from this
 *   index. The users service imports `UserModel` from
 *   `./features/auth/models/User.js`, and `hashPassword` from
 *   `./features/auth/utils/bcrypt.js`. None of those imports need
 *   to change — this index is a forward-looking surface that a
 *   future refactor can adopt. Until that refactor, this file's
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
//  login and me endpoints. Both the default-export form and the
//  named-export form resolve to the same router instance (see
//  the file header for the reasoning).

export { default as authRoutes } from './routes/authRoutes.js';
export { default } from './routes/authRoutes.js';

// ============================================================
//  Model
// ============================================================
//
//  The Mongoose model and its hydrated document interface. The
//  auth feature owns the `User` collection — the single shared
//  user record that every login, every /me request, every admin
//  CRUD operation, and every ownership check in the rest of the
//  codebase ultimately references.
//
//  The users feature's service (`userService.ts`) operates on
//  the same collection and currently imports `UserModel` from
//  the deep path. That import would continue to work identically
//  if it were changed to import from this index; no such change
//  is required, but this export gives that consumer — and any
//  future one — a single named entry point.
//
//  The `UserDocument` type is re-exported with the `type`
//  modifier so the compiler can erase it at emit time; it has
//  no runtime representation.

export { UserModel, type UserDocument } from './models/User.js';