/**
 * Route table for the WriteSpeare Article entity.
 *
 * Declares the seven article endpoints and the middleware chain
 * that runs in front of each. The router is mounted at
 * `/api/articles` by the app factory (`src/app.ts`), so the paths
 * declared below are relative to that prefix:
 *
 *   POST   /api/articles                                → create a generated article
 *   GET    /api/articles                                → list the user's articles
 *   GET    /api/articles/:id                            → read a single article
 *   GET    /api/articles/topic/:topicId/latest          → read the current version
 *   PATCH  /api/articles/:id/status                     → transition lifecycle status
 *   DELETE /api/articles/:id                            → delete a single article
 *   DELETE /api/articles/topic/:topicId                 → bulk-delete by topic
 *
 * Every route is protected by `authenticate`. Articles are
 * user-scoped by design — the model's two compound indexes both
 * carry `userId` as their prefix, every service operation filters
 * on `userId`, and every controller handler derives the ownership
 * value from `req.user.userId` rather than from the request. A
 * public article surface does not exist.
 *
 * Middleware order:
 *
 *   `authenticate` runs first and is applied via `asyncHandler`
 *   because the function is async (it awaits a user lookup to
 *   confirm the account still exists and is active). The wrapper
 *   is required — without it, a rejection inside the middleware
 *   would reach the terminal error handler as an unhandled
 *   promise rejection on runtimes that do not forward the
 *   rejection automatically. The existing `authRoutes.ts`,
 *   `topicRoutes.ts`, and `documentRoutes.ts` files use the same
 *   wrapping pattern for the same reason, and all four must stay
 *   in step.
 *
 *   The controller runs second, also wrapped in `asyncHandler`,
 *   for the same reason: the service behind it can throw an
 *   `AppError` (404 for an article or parent topic that does not
 *   exist or belongs to another user; 400 for a schema-level
 *   validation failure such as empty content or a non-integer
 *   word count), and the wrapper is what converts that throw
 *   into a well-formed response via the terminal error
 *   middleware.
 *
 * Route ordering — the multi-segment paths vs the single-`:id`
 * paths:
 *
 *   Three of the routes in this file have more than one segment
 *   after the mount point:
 *
 *     GET    /topic/:topicId/latest       (three segments)
 *     DELETE /topic/:topicId              (two segments)
 *     PATCH  /:id/status                  (two segments)
 *
 *   The remaining four are single-segment or single-parameter:
 *
 *     POST   /
 *     GET    /
 *     GET    /:id                         (one segment)
 *     DELETE /:id                         (one segment)
 *
 *   Express matches routes segment-by-segment, so a request can
 *   never match two routes with different segment counts. That
 *   means the multi-segment routes CANNOT collide with the
 *   single-`:id` routes regardless of declaration order.
 *
 *   The multi-segment routes are nevertheless declared BEFORE the
 *   single-`:id` routes as defensive habit. The rule of thumb
 *   across all route files in this codebase: declare more specific
 *   paths before more general ones. Today no collision exists;
 *   tomorrow, if a literal sub-path like `/featured` is ever
 *   added, the ordering will already be correct.
 *
 *   Within the multi-segment group, `GET /topic/:topicId/latest`
 *   is declared before `DELETE /topic/:topicId` and before
 *   `PATCH /:id/status` — the three do not collide with each
 *   other either (different methods, or different segment names),
 *   but grouping the `/topic/...` routes together and the
 *   `/:id/status` route separately keeps the file readable.
 *
 * The routes are declared as a flat sequence of `router.METHOD`
 * calls rather than as a route table or a declarative
 * configuration. This matches the convention established in
 * `authRoutes.ts`, `topicRoutes.ts`, and `documentRoutes.ts` and
 * in every route file the plan will produce. A reader can scan
 * the file top to bottom and see exactly which middleware runs on
 * which route without holding any additional context.
 *
 * No try/catch appears anywhere in this file. That is deliberate
 * — the asyncHandler wrappers, combined with the terminal error
 * middleware registered in `app.ts`, form the single error-
 * handling contract for every route in the application.
 */

import { Router } from 'express';

import {
  createArticle,
  listArticles,
  getArticleById,
  getLatestArticle,
  updateArticleStatus,
  deleteArticle,
  deleteArticlesByTopic,
} from '../controllers/articleController.js';

import { authenticate } from '../../auth/middleware/authGuard.js';
import { asyncHandler } from '../../shared/middleware/errorHandler.js';

// ============================================================
//  Router instance
// ============================================================

const articleRoutes = Router();

// ============================================================
//  POST /api/articles
// ============================================================
//
//  Persist a generated article attached to a topic owned by the
//  authenticated user. The service computes the next version
//  number for the topic and writes it to the record — the client
//  never supplies a version. The service verifies that the parent
//  topic exists and is owned by the same caller before the
//  article is written.

articleRoutes.post(
  '/',
  asyncHandler(authenticate),
  asyncHandler(createArticle)
);

// ============================================================
//  GET /api/articles
// ============================================================
//
//  List the authenticated user's articles. An optional
//  `?topicId=` query parameter narrows the result to the
//  articles attached to a single topic. The sort order is chosen
//  by the service based on whether the query is topic-scoped —
//  see the service header for the dual-sort rationale.

articleRoutes.get(
  '/',
  asyncHandler(authenticate),
  asyncHandler(listArticles)
);

// ============================================================
//  GET /api/articles/topic/:topicId/latest
// ============================================================
//
//  Return the current (highest-version) article for a topic.
//  This is a dedicated query rather than a filter on the list
//  endpoint — the topic-detail view issues it on every render,
//  and the dedicated route lets the service answer it with a
//  single indexed findOne. A 404 is returned when the topic has
//  no articles, when the topic does not exist, or when the topic
//  belongs to a different user — all three collapse to the same
//  response for enumeration-safety reasons documented in the
//  controller.

articleRoutes.get(
  '/topic/:topicId/latest',
  asyncHandler(authenticate),
  asyncHandler(getLatestArticle)
);

// ============================================================
//  DELETE /api/articles/topic/:topicId
// ============================================================
//
//  Bulk-delete every article attached to a topic, scoped to the
//  authenticated user. The filter is scoped to
//  `{ userId, topicId }` in the service, so a caller who does not
//  own the topic matches zero records and cannot clear another
//  user's articles by guessing the topic id.

articleRoutes.delete(
  '/topic/:topicId',
  asyncHandler(authenticate),
  asyncHandler(deleteArticlesByTopic)
);

// ============================================================
//  GET /api/articles/:id
// ============================================================
//
//  Return a single article by ID, scoped to the authenticated
//  user. The service merges the "not found" and "not owned"
//  cases and returns null for both; the controller converts that
//  null into a 404 without distinguishing the two — see the
//  controller header for the information-leak rationale.

articleRoutes.get(
  '/:id',
  asyncHandler(authenticate),
  asyncHandler(getArticleById)
);

// ============================================================
//  PATCH /api/articles/:id/status
// ============================================================
//
//  Transition an article's lifecycle status. The `status` field
//  is the only mutable field on an existing article — content is
//  immutable by design, and a content change produces a new
//  version rather than an in-place edit. The narrow sub-path
//  (`/status` rather than a generic PATCH on `/:id`) makes the
//  single-field nature of the operation explicit in the URL.

articleRoutes.patch(
  '/:id/status',
  asyncHandler(authenticate),
  asyncHandler(updateArticleStatus)
);

// ============================================================
//  DELETE /api/articles/:id
// ============================================================
//
//  Delete a single article, scoped to the authenticated user.
//  The service returns the deleted document so the client can
//  render an undo affordance without a second round trip. The
//  service does NOT cascade to the article's Reports — removing
//  a Report that referenced the article is the reports feature's
//  responsibility, not the articles feature's.

articleRoutes.delete(
  '/:id',
  asyncHandler(authenticate),
  asyncHandler(deleteArticle)
);

// ============================================================
//  Default export
// ============================================================

export default articleRoutes;