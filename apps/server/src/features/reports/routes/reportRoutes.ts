/**
 * Route table for the WriteSpeare Report entity.
 *
 * Declares the eight report endpoints and the middleware chain
 * that runs in front of each. The router is mounted at
 * `/api/reports` by the app factory (`src/app.ts`), so the paths
 * declared below are relative to that prefix:
 *
 *   POST   /api/reports                            → create a validation report
 *   GET    /api/reports                            → list the user's reports
 *   GET    /api/reports/article/:articleId/latest  → latest report for an article
 *   GET    /api/reports/topic/:topicId/latest      → latest report for a topic
 *   DELETE /api/reports/article/:articleId         → bulk-delete by article
 *   DELETE /api/reports/topic/:topicId             → bulk-delete by topic
 *   GET    /api/reports/:id                        → read a single report
 *   DELETE /api/reports/:id                        → delete a single report
 *
 * Every route is protected by `authenticate`. Reports are user-
 * scoped by design — the model's two compound indexes both carry
 * `userId` as their prefix, every service operation filters on
 * `userId`, and every controller handler derives the ownership
 * value from `req.user.userId` rather than from the request. A
 * public report surface does not exist.
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
 *   `topicRoutes.ts`, `documentRoutes.ts`, and `articleRoutes.ts`
 *   files use the same wrapping pattern for the same reason, and
 *   all five must stay in step.
 *
 *   The controller runs second, also wrapped in `asyncHandler`,
 *   for the same reason: the service behind it can throw an
 *   `AppError` (404 for a report or parent article that does not
 *   exist or belongs to another user; 400 for a schema-level
 *   validation failure such as a status value outside the closed
 *   set or a similarity score outside [0, 1]), and the wrapper is
 *   what converts that throw into a well-formed response via the
 *   terminal error middleware.
 *
 * Route ordering — multi-segment paths before single-`:id` paths:
 *
 *   Six of the eight routes in this file are multi-segment, or
 *   have a literal segment in addition to a parameter:
 *
 *     GET    /article/:articleId/latest   (three segments)
 *     GET    /topic/:topicId/latest       (three segments)
 *     DELETE /article/:articleId          (two segments)
 *     DELETE /topic/:topicId              (two segments)
 *
 *   The remaining four are the collection routes and the single-
 *   resource routes:
 *
 *     POST   /
 *     GET    /
 *     GET    /:id                          (one segment)
 *     DELETE /:id                          (one segment)
 *
 *   Express matches routes segment-by-segment, so a request can
 *   never match two routes with different segment counts. The
 *   four multi-segment routes CANNOT collide with the two single-
 *   `:id` routes regardless of declaration order.
 *
 *   The multi-segment routes are nevertheless declared BEFORE the
 *   single-`:id` routes as defensive habit. The rule of thumb
 *   across all route files in this codebase: declare more
 *   specific paths before more general ones. Today no collision
 *   exists; tomorrow, if a literal sub-path like `/recent` is
 *   ever added under the collection route, the ordering will
 *   already be correct.
 *
 *   Within the multi-segment group, the four routes are grouped
 *   by their segment name — `article/...` first, then
 *   `topic/...` — which mirrors the naming convention across
 *   the codebase (article-scoped before topic-scoped, because
 *   the article is the direct parent of a report and the topic
 *   is the grandparent). The grouping is for readability; the
 *   router does not care about the order within a group.
 *
 * The routes are declared as a flat sequence of `router.METHOD`
 * calls rather than as a route table or a declarative
 * configuration. This matches the convention established in
 * `authRoutes.ts`, `topicRoutes.ts`, `documentRoutes.ts`, and
 * `articleRoutes.ts` and in every route file the plan will
 * produce. A reader can scan the file top to bottom and see
 * exactly which middleware runs on which route without holding
 * any additional context.
 *
 * No try/catch appears anywhere in this file. That is deliberate
 * — the asyncHandler wrappers, combined with the terminal error
 * middleware registered in `app.ts`, form the single error-
 * handling contract for every route in the application.
 */

import { Router } from 'express';

import {
  createReport,
  listReports,
  getReportById,
  getLatestReportByArticle,
  getLatestReportByTopic,
  deleteReport,
  deleteReportsByArticle,
  deleteReportsByTopic,
} from '../controllers/reportController.js';

import { authenticate } from '../../auth/middleware/authGuard.js';
import { asyncHandler } from '../../shared/middleware/errorHandler.js';

// ============================================================
//  Router instance
// ============================================================

const reportRoutes = Router();

// ============================================================
//  POST /api/reports
// ============================================================
//
//  Persist a validation report attached to an article owned by
//  the authenticated user. The service derives the report's
//  `topicId` from the parent article and computes the
//  `overallStatus` from the six section statuses — neither is
//  accepted from the client. See the controller header for the
//  full rationale.

reportRoutes.post(
  '/',
  asyncHandler(authenticate),
  asyncHandler(createReport)
);

// ============================================================
//  GET /api/reports
// ============================================================
//
//  List the authenticated user's reports, sorted newest first.
//  Optional `?articleId=` and `?topicId=` query parameters
//  narrow the result. The controller validates each filter's
//  shape before delegating; the service returns an empty array
//  (not a 404) when a filter matches no records the caller
//  owns.

reportRoutes.get(
  '/',
  asyncHandler(authenticate),
  asyncHandler(listReports)
);

// ============================================================
//  GET /api/reports/article/:articleId/latest
// ============================================================
//
//  Return the newest report for a specific article. This is a
//  dedicated query rather than a filter on the list endpoint
//  because the article view issues it on every render, and the
//  dedicated route lets the service answer it with a single
//  indexed findOne. A 404 is returned when the article has no
//  reports, when the article does not exist, or when the
//  article belongs to a different user — all three collapse to
//  the same response for enumeration-safety reasons documented
//  in the controller.

reportRoutes.get(
  '/article/:articleId/latest',
  asyncHandler(authenticate),
  asyncHandler(getLatestReportByArticle)
);

// ============================================================
//  GET /api/reports/topic/:topicId/latest
// ============================================================
//
//  Return the newest report for a topic — the most recently
//  produced report across all the topic's articles. Same
//  reasoning as the article-scoped latest route above: a
//  dedicated indexed query, a single-object response, and a
//  404 that merges the three missing cases.

reportRoutes.get(
  '/topic/:topicId/latest',
  asyncHandler(authenticate),
  asyncHandler(getLatestReportByTopic)
);

// ============================================================
//  DELETE /api/reports/article/:articleId
// ============================================================
//
//  Bulk-delete every report attached to an article, scoped to
//  the authenticated user. The filter is scoped to
//  `{ userId, articleId }` in the service, so a caller who does
//  not own the article matches zero records and cannot clear
//  another user's reports by guessing the article id. This
//  route is the entry point for a future cascade from article
//  deletion.

reportRoutes.delete(
  '/article/:articleId',
  asyncHandler(authenticate),
  asyncHandler(deleteReportsByArticle)
);

// ============================================================
//  DELETE /api/reports/topic/:topicId
// ============================================================
//
//  Bulk-delete every report attached to a topic, scoped to the
//  authenticated user. Scoped to `{ userId, topicId }` in the
//  service, same reasoning as the article-scoped bulk delete
//  above. This route is the entry point for a future cascade
//  from topic deletion.

reportRoutes.delete(
  '/topic/:topicId',
  asyncHandler(authenticate),
  asyncHandler(deleteReportsByTopic)
);

// ============================================================
//  GET /api/reports/:id
// ============================================================
//
//  Return a single report by ID, scoped to the authenticated
//  user. The service merges the "not found" and "not owned"
//  cases and returns null for both; the controller converts
//  that null into a 404 without distinguishing the two — see
//  the controller header for the information-leak rationale.

reportRoutes.get(
  '/:id',
  asyncHandler(authenticate),
  asyncHandler(getReportById)
);

// ============================================================
//  DELETE /api/reports/:id
// ============================================================
//
//  Delete a single report, scoped to the authenticated user.
//  The service returns the deleted document so the client can
//  render an undo affordance without a second round trip.
//  Reports have no children — removing a report is a leaf
//  operation with no cascade to consider.

reportRoutes.delete(
  '/:id',
  asyncHandler(authenticate),
  asyncHandler(deleteReport)
);

// ============================================================
//  Default export
// ============================================================

export default reportRoutes;