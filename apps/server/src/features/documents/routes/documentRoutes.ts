/**
 * Route table for the WriteSpeare Document entity.
 *
 * Declares the five document endpoints and the middleware chain
 * that runs in front of each. The router is mounted at
 * `/api/documents` by the app factory (`src/app.ts`), so the
 * paths declared below are relative to that prefix:
 *
 *   POST   /api/documents                      → persist a scraped document
 *   GET    /api/documents                      → list the user's documents
 *   GET    /api/documents/:id                  → read a single document
 *   DELETE /api/documents/:id                  → delete a single document
 *   DELETE /api/documents/topic/:topicId       → bulk-delete every
 *                                                document under a topic
 *
 * Every route is protected by `authenticate`. Documents are
 * user-scoped by design — the model's two compound indexes both
 * carry `userId` as their prefix, every service operation filters
 * on `userId`, and every controller handler derives the ownership
 * value from `req.user.userId` rather than from the request. A
 * public document surface does not exist.
 *
 * Middleware order:
 *
 *   `authenticate` runs first and is applied via `asyncHandler`
 *   because the function is async (it awaits a user lookup to
 *   confirm the account still exists and is active). The wrapper
 *   is required — without it, a rejection inside the middleware
 *   would reach the terminal error handler as an unhandled
 *   promise rejection on runtimes that do not forward the
 *   rejection automatically. The existing `authRoutes.ts` and
 *   `topicRoutes.ts` files use the same wrapping pattern for the
 *   same reason, and all three must stay in step.
 *
 *   The controller runs second, also wrapped in `asyncHandler`,
 *   for the same reason: the service behind it can throw an
 *   `AppError` (404 for a document or parent topic that does not
 *   exist or belongs to another user; 400 for a schema-level
 *   validation failure such as a malformed URL or a negative
 *   word count), and the wrapper is what converts that throw
 *   into a well-formed response via the terminal error
 *   middleware.
 *
 * Route ordering — the `/topic/:topicId` vs `/:id` question:
 *
 *   The two DELETE routes differ in segment count:
 *   `/topic/:topicId` has two segments after the mount point
 *   (`topic` and a parameter), `/:id` has one. Express's router
 *   matches segment-by-segment, so a request cannot match both
 *   routes simultaneously regardless of declaration order.
 *
 *   The nested form `/topic/:topicId` is declared BEFORE the
 *   single-document `/:id` route as a matter of defensive
 *   habit — if a future addition ever introduces a one-segment
 *   route whose name collides with a literal segment (say,
 *   `DELETE /api/documents/topic` with no id), the ordering
 *   would matter. Today, no collision exists, and either order
 *   would produce identical behaviour; the file documents the
 *   reasoning so the ordering is not mistaken for an accident.
 *
 * The routes are declared as a flat sequence of `router.METHOD`
 * calls rather than as a route table or a declarative
 * configuration. This matches the convention established in
 * `authRoutes.ts` and `topicRoutes.ts` and in every route file
 * the plan will produce. A reader can scan the file top to
 * bottom and see exactly which middleware runs on which route
 * without holding any additional context.
 *
 * No try/catch appears anywhere in this file. That is deliberate
 * — the asyncHandler wrappers, combined with the terminal error
 * middleware registered in `app.ts`, form the single error-
 * handling contract for every route in the application.
 */

import { Router } from 'express';

import {
  createDocument,
  listDocuments,
  getDocumentById,
  deleteDocument,
  deleteDocumentsByTopic,
} from '../controllers/documentController.js';

import { authenticate } from '../../auth/middleware/authGuard.js';
import { asyncHandler } from '../../shared/middleware/errorHandler.js';

// ============================================================
//  Router instance
// ============================================================

const documentRoutes = Router();

// ============================================================
//  POST /api/documents
// ============================================================
//
//  Persist a scraped document attached to a topic owned by the
//  authenticated user. The controller reads the ownership value
//  from `req.user.userId` and never from the request body; the
//  service then verifies that the parent topic exists and is
//  owned by the same caller before the document is written.

documentRoutes.post(
  '/',
  asyncHandler(authenticate),
  asyncHandler(createDocument)
);

// ============================================================
//  GET /api/documents
// ============================================================
//
//  List the authenticated user's documents, sorted newest first.
//  An optional `?topicId=` query parameter narrows the result to
//  the documents attached to a single topic. The controller
//  validates the filter's shape before delegating; the service
//  returns an empty array (not a 404) when the topic has no
//  documents or is not owned by the caller.

documentRoutes.get(
  '/',
  asyncHandler(authenticate),
  asyncHandler(listDocuments)
);

// ============================================================
//  DELETE /api/documents/topic/:topicId
// ============================================================
//
//  Bulk-delete every document attached to a topic, scoped to the
//  authenticated user. Declared before the single-document
//  `/:id` route so that, if a future literal route ever
//  introduces a collision, this more specific path wins. Today
//  the two routes cannot match the same request because their
//  segment counts differ; the ordering is defensive.

documentRoutes.delete(
  '/topic/:topicId',
  asyncHandler(authenticate),
  asyncHandler(deleteDocumentsByTopic)
);

// ============================================================
//  GET /api/documents/:id
// ============================================================
//
//  Return a single document by ID, scoped to the authenticated
//  user. The service merges the "not found" and "not owned"
//  cases and returns null for both; the controller converts
//  that null into a 404 without distinguishing the two — see
//  the controller header for the information-leak rationale.

documentRoutes.get(
  '/:id',
  asyncHandler(authenticate),
  asyncHandler(getDocumentById)
);

// ============================================================
//  DELETE /api/documents/:id
// ============================================================
//
//  Delete a single document, scoped to the authenticated user.
//  The service returns the deleted document so the client can
//  render an undo affordance without a second round trip. The
//  service does NOT touch the filesystem — removing the
//  corresponding `.md` file is the desktop client's job, not
//  the backend's.

documentRoutes.delete(
  '/:id',
  asyncHandler(authenticate),
  asyncHandler(deleteDocument)
);

// ============================================================
//  Default export
// ============================================================

export default documentRoutes;