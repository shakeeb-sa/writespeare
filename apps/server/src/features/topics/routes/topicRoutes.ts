/**
 * Route table for the WriteSpeare Topic entity.
 *
 * Declares the five topic endpoints and the middleware chain that
 * runs in front of each. The router is mounted at `/api/topics`
 * by the app factory (`src/app.ts`), so the paths declared below
 * are relative to that prefix:
 *
 *   POST   /api/topics       → create a new topic
 *   GET    /api/topics       → list the user's topics, newest first
 *   GET    /api/topics/:id   → read a single topic
 *   PATCH  /api/topics/:id   → partial update
 *   DELETE /api/topics/:id   → delete
 *
 * Every route is protected by `authenticate`. Topics are
 * user-scoped by design — the model's two compound indexes both
 * carry `userId` as their prefix, every service operation filters
 * on `userId`, and every controller handler derives the ownership
 * value from `req.user.userId` rather than from the request. A
 * public topic surface does not exist, and adding one later would
 * require revisiting every service call — which is exactly the
 * property we want from routing here: no ambiguity about who can
 * reach what.
 *
 * Middleware order:
 *
 *   `authenticate` runs first and is applied via `asyncHandler`
 *   because the function is async (it awaits a user lookup to
 *   confirm the account still exists and is active). The wrapper
 *   is required — without it, a rejection inside the middleware
 *   would reach the terminal error handler as an unhandled
 *   promise rejection on runtimes that do not forward the
 *   rejection automatically. The existing `authRoutes.ts` file
 *   uses the same wrapping pattern for the same reason, and the
 *   two files should stay in step.
 *
 *   The controller runs second, also wrapped in `asyncHandler`,
 *   for the same reason: the service behind it can throw an
 *   `AppError` (404 for a topic that does not exist or belongs to
 *   another user, 400 for a schema-level validation failure), and
 *   the wrapper is what converts that throw into a well-formed
 *   response via the terminal error middleware.
 *
 * Route ordering:
 *
 *   The `:id` routes are declared after the collection route.
 *   Express matches in declaration order, and `GET /:id` would
 *   match a literal path like `/api/topics/special` if such a
 *   route existed and were declared first. No such literal
 *   sub-path exists today — the five routes below are the
 *   complete surface — but keeping the collection route above
 *   the parameterized ones preserves the invariant if a future
 *   literal sub-path (say `/api/topics/import`) is ever added.
 *
 *   No middleware distinguishes the two parameterized routes.
 *   `PATCH /:id` and `DELETE /:id` are declared as separate
 *   router methods on the same path — Express's router keys on
 *   method + path, so they cannot collide.
 *
 * The routes are declared as a flat sequence of `router.METHOD`
 * calls rather than as a route table or a declarative
 * configuration. This matches the convention established in
 * `authRoutes.ts` and in every route file the plan will produce.
 * A reader can scan the file top to bottom and see exactly which
 * middleware runs on which route without holding any additional
 * context. That property is worth more than the brevity a table
 * would buy at this scale, and it means a change to the
 * middleware chain of one route cannot accidentally affect
 * another through a shared table entry.
 *
 * No try/catch appears anywhere in this file. That is deliberate
 * — the asyncHandler wrappers, combined with the terminal error
 * middleware registered in `app.ts`, form the single error-
 * handling contract for every route in the application. Adding
 * a try/catch here would duplicate that contract and split the
 * behaviour across two files, which is the failure mode the
 * `app.ts` comment about the terminal handler specifically warns
 * against.
 */

import { Router } from 'express';

import {
  createTopic,
  listTopics,
  getTopicById,
  updateTopic,
  deleteTopic,
} from '../controllers/topicController.js';

import { authenticate } from '../../auth/middleware/authGuard.js';
import { asyncHandler } from '../../shared/middleware/errorHandler.js';

// ============================================================
//  Router instance
// ============================================================

const topicRoutes = Router();

// ============================================================
//  POST /api/topics
// ============================================================
//
//  Create a new topic owned by the authenticated user. The
//  controller reads the ownership value from `req.user.userId`
//  and never from the request body, so a client cannot create a
//  topic on behalf of another user regardless of what the
//  payload contains.

topicRoutes.post(
  '/',
  asyncHandler(authenticate),
  asyncHandler(createTopic)
);

// ============================================================
//  GET /api/topics
// ============================================================
//
//  List the authenticated user's topics, sorted newest first.
//  An optional `?status=` query parameter narrows the result;
//  the controller validates it against the closed set before
//  delegating to the service.

topicRoutes.get(
  '/',
  asyncHandler(authenticate),
  asyncHandler(listTopics)
);

// ============================================================
//  GET /api/topics/:id
// ============================================================
//
//  Return a single topic by ID, scoped to the authenticated
//  user. The service merges the "not found" and "not owned"
//  cases and returns null for both; the controller converts
//  that null into a 404 without distinguishing the two — see
//  the controller header for the information-leak rationale.

topicRoutes.get(
  '/:id',
  asyncHandler(authenticate),
  asyncHandler(getTopicById)
);

// ============================================================
//  PATCH /api/topics/:id
// ============================================================
//
//  Partial update. Every field in the request body is optional;
//  fields that are absent leave the corresponding document
//  field untouched. The one piece of business logic in this
//  flow — unsetting `error` when `status` moves away from
//  `'failed'` — lives in the service, not the controller.

topicRoutes.patch(
  '/:id',
  asyncHandler(authenticate),
  asyncHandler(updateTopic)
);

// ============================================================
//  DELETE /api/topics/:id
// ============================================================
//
//  Delete a topic, scoped to the authenticated user. The
//  service returns the deleted document so the client can
//  render an undo affordance without a second round trip; the
//  cascade to child records (documents, articles, reports) is
//  a decision for each owning feature and is deliberately not
//  part of this route.

topicRoutes.delete(
  '/:id',
  asyncHandler(authenticate),
  asyncHandler(deleteTopic)
);

// ============================================================
//  Default export
// ============================================================

export default topicRoutes;