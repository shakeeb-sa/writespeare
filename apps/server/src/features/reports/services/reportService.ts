/**
 * Business logic for the WriteSpeare Report entity.
 *
 * A Report is the six-section validation output produced against
 * one Article. Every section maps one-for-one to a Python
 * validator in `apps/desktop/src/resources/scripts/validation/`:
 * readability, seo, keywords, originality, aiMarkers, grammar.
 * An Article can accumulate multiple Reports — one per validation
 * run, produced against successive versions or against a single
 * version re-checked after the user edits content — and the
 * newest report is the "current" one.
 *
 * The service exposes eight ownership-scoped operations:
 *
 *   createReport             — persist a validation report, with
 *                              the parent article's ownership
 *                              verified and the topicId and
 *                              overallStatus derived
 *   listReports              — read the user's reports, filtered
 *                              by article and/or topic
 *   getReportById            — read a single report
 *   getLatestReportByArticle — read the newest report for an article
 *   getLatestReportByTopic   — read the newest report for a topic
 *   deleteReport             — remove a single report
 *   deleteReportsByArticle   — bulk-remove by parent article
 *   deleteReportsByTopic     — bulk-remove by parent topic
 *
 * Every function takes a `userId` argument that the caller (the
 * controller) derives from `req.user.userId`. That value is never
 * read from the request body, query, or route params — the client
 * cannot choose whose reports they are reading or writing. This
 * is the same ownership contract used by `topicService.ts`,
 * `documentService.ts`, and `articleService.ts`.
 *
 * Cross-feature import — ArticleModel:
 *
 *   This service imports `ArticleModel` from the articles feature
 *   to verify, on the create path, that the parent article exists
 *   and is owned by the caller before persisting the report. The
 *   import direction (child → parent) mirrors the same decision
 *   made in `documentService.ts` (child → topic) and
 *   `articleService.ts` (child → topic). Every ownership-scoped
 *   write in this backend validates its immediate parent's
 *   ownership in the same query that checks the parent's
 *   existence.
 *
 * Why the topicId is derived, not accepted from the client:
 *
 *   The Report schema stores both `articleId` (immediate parent)
 *   and `topicId` (grandparent) denormalized, so that the two
 *   list views — "reports for this article" and "reports for
 *   this topic" — are each a single indexed query with no join.
 *   Storing both is a performance choice; the invariant is that
 *   they must be consistent. If the client supplied a `topicId`
 *   directly, a malicious or buggy caller could post a report
 *   with an `articleId` that belongs to them and a `topicId`
 *   that belongs to someone else, and the denormalized pair
 *   would be internally inconsistent — every report-for-topic
 *   query would then be at risk of leaking article content
 *   across users.
 *
 *   The fix is to never trust a client-supplied `topicId`. The
 *   service looks up the parent article by `(articleId, userId)`,
 *   reads the article's own `topicId` field, and writes THAT
 *   value into the report. The report's `topicId` is therefore
 *   always equal to its parent article's `topicId` by
 *   construction, and the denormalization invariant cannot be
 *   violated from the client side.
 *
 * Why the overallStatus is computed, not accepted from the client:
 *
 *   The `overallStatus` is the weakest of the six section
 *   statuses — a `fail` in any section makes the whole report
 *   `fail`, otherwise a `warning` in any section makes it
 *   `warning`, otherwise it is `good`. This rule is a policy
 *   decision: it is currently fixed, but the plan's settings
 *   model anticipates per-user thresholds and per-user check
 *   enablement, so the rule could change (a user who disables
 *   the AI-marker check should not have that check's status
 *   drag down their overall score). Because it is a policy, it
 *   belongs in the service, and the client should never supply
 *   it — accepting it would create a second source of truth for
 *   a value that the server is supposed to be the authority on.
 *
 *   The schema only enforces that whatever the service writes is
 *   a member of the closed status set.
 *
 * Immutability:
 *
 *   There is no `updateReport` function. A Report represents the
 *   validation output produced by a specific run of the Python
 *   validators against a specific snapshot of an article. If the
 *   user edits the article or regenerates it, the correct
 *   operation is to run validation again — which produces a new
 *   report via `createReport`. The only in-place mutation of a
 *   report is deletion.
 *
 *   This mirrors the immutability rule on Article content: the
 *   version history of everything the pipeline produces is a
 *   clean append-only log, and no downstream consumer ever has
 *   to reason about whether a report has been edited since it
 *   was produced.
 *
 * Cascade semantics:
 *
 *   `deleteReportsByArticle` and `deleteReportsByTopic` exist so
 *   that future cascade paths from article deletion or topic
 *   deletion have well-defined entry points. The current article
 *   and topic services do NOT call them — cascade is a decision
 *   for each owning feature, and the reports feature is the one
 *   that owns the decision of whether to cascade from its
 *   parents. Both functions are scoped to `{ userId, ... }`, so
 *   a caller who does not own the parent matches zero records
 *   and cannot clear another user's reports by guessing an id.
 */

import { ReportModel, type ReportDocument } from '../models/Report.js';
import { ArticleModel } from '../../articles/models/Article.js';
import type {
  MongoId,
  Report,
  ReportStatus,
} from '../../shared/types/index.js';
import { AppError } from '../../shared/middleware/errorHandler.js';

// ============================================================
//  Payload type
// ============================================================
//
// The shared types module does not yet declare a dedicated
// `ReportCreatePayload` interface (see the PLAN DELTA note in the
// execution response). Rather than import a symbol that does not
// exist, this file derives the payload type locally from the
// domain `Report` interface by omitting the fields the service
// owns:
//
//   _id           — assigned by MongoDB
//   userId        — derived from the authenticated session
//   topicId       — derived from the parent article (see the
//                   file header for why it is not trusted from
//                   the client)
//   createdAt     — assigned by Mongoose timestamps
//   overallStatus — computed by this service from the six
//                   section statuses (see the file header)
//
// The remaining fields — articleId and the six section objects —
// are exactly what the client is expected to submit. If a future
// session promotes this type into `shared/types/index.ts` as a
// first-class interface, the sole change required here is to
// swap the local alias for an import.
export type ReportCreatePayload = Omit<
  Report,
  '_id' | 'userId' | 'topicId' | 'createdAt' | 'overallStatus'
>;

// ============================================================
//  Internal helpers
// ============================================================

/**
 * Compute the overall status from the six section statuses.
 *
 * Rule: the weakest status wins. Any `fail` in any section makes
 * the report `fail`; otherwise any `warning` makes it `warning`;
 * otherwise the report is `good`.
 *
 * This function is deliberately private to the service — the
 * rule is a policy decision, not a schema-level invariant, and
 * hiding it behind this name (rather than inlining the ternary
 * chain at the call site) means a future change to the rule has
 * exactly one place to go.
 */
const computeOverallStatus = (
  sectionStatuses: readonly ReportStatus[]
): ReportStatus => {
  if (sectionStatuses.includes('fail')) {
    return 'fail';
  }
  if (sectionStatuses.includes('warning')) {
    return 'warning';
  }
  return 'good';
};

// ============================================================
//  createReport
// ============================================================

/**
 * Persist a validation report attached to an article owned by
 * the caller.
 *
 * Flow:
 *
 *   1. Look up the parent article by `(articleId, userId)`. The
 *      ownership check is part of the same query — an article
 *      that exists but belongs to a different user is treated
 *      as "not found", which keeps the service from leaking
 *      other users' article IDs through a 403.
 *
 *   2. If the article does not exist or is not owned by the
 *      caller, throw `AppError(404)`. The message refers to the
 *      article, not the report — the caller is trying to attach
 *      a report to an article they cannot see.
 *
 *   3. Derive the report's `topicId` from the article's own
 *      `topicId` field. This is what makes the denormalized
 *      ownership pair `(articleId, topicId)` internally
 *      consistent by construction — see the file header.
 *
 *   4. Compute `overallStatus` from the six section statuses on
 *      the payload. See the file header for why this is a
 *      service-level computation.
 *
 *   5. Persist the report with the caller's `userId`, the
 *      derived `topicId`, and the computed `overallStatus`. Every
 *      other field comes from the payload.
 *
 *   6. Return the saved document.
 *
 * The function does NOT catch validation errors from the schema.
 * A Mongoose ValidationError thrown here — a status value outside
 * the closed set, a similarity score outside [0, 1], a negative
 * word count — propagates to the terminal error middleware, which
 * maps it to a 400 with the schema's own message. The Python
 * validators are the source of truth for what the numbers mean;
 * the schema's job is only to check that the numbers are legal
 * values of their declared types, not to re-derive them.
 *
 * @param userId  - Ownership value, derived from the
 *                  authenticated session by the controller.
 * @param payload - The six validation sections plus the parent
 *                  articleId. `topicId`, `userId`, and
 *                  `overallStatus` are NOT part of this payload —
 *                  the first two are derived from the parent
 *                  article, and the third is computed here.
 */
export const createReport = async (
  userId: MongoId,
  payload: ReportCreatePayload
): Promise<ReportDocument> => {
  // ---- 1. Verify the parent article exists and is owned by the caller ----
  const parentArticle = await ArticleModel.findOne({
    _id: payload.articleId,
    userId,
  });

  if (!parentArticle) {
    throw new AppError('Article not found.', 404);
  }

  // ---- 2. Derive the topicId from the article ----
  // The article's topicId is the authoritative value. It is never
  // read from the client payload — see the file header for why.
  const topicId = parentArticle.topicId;

  // ---- 3. Compute the overall status ----
  const overallStatus = computeOverallStatus([
    payload.readability.status,
    payload.seo.status,
    payload.keywords.status,
    payload.originality.status,
    payload.aiMarkers.status,
    payload.grammar.status,
  ]);

  // ---- 4. Persist the report ----
  // The spread of `payload` is safe: it contains exactly the
  // seven fields the schema expects from the caller-supplied
  // portion (articleId and the six sections), and no `userId`,
  // `topicId`, or `overallStatus` field is present on the payload
  // type. All three are added explicitly here from values this
  // function controls.
  const doc = new ReportModel({
    ...payload,
    userId,
    topicId,
    overallStatus,
  });

  return await doc.save();
};

// ============================================================
//  listReports
// ============================================================

/**
 * List the authenticated user's reports, optionally filtered by
 * articleId and/or topicId. Sorted newest first.
 *
 * The filter object has two optional fields:
 *
 *   - `articleId` — narrows to the reports attached to one
 *     article. Covered by the compound index
 *     `{ userId, articleId, createdAt: -1 }`.
 *
 *   - `topicId` — narrows to the reports attached to one topic
 *     (across all the topic's articles). Covered by the compound
 *     index `{ userId, topicId, createdAt: -1 }`.
 *
 *   When both are provided, MongoDB intersects the two filters —
 *   reports for one article are a subset of reports for one
 *   topic, so the intersection is well-defined. When neither is
 *   provided, the query returns every report owned by the user.
 *   That last case is not covered by a purpose-built index (see
 *   the PLAN DELTA note in the execution response); it is a
 *   legitimate operation whose performance profile is acceptable
 *   at the current collection size.
 *
 * A filter whose value does not correspond to any records the
 * caller owns produces an empty array, not a 404. See
 * `documentService.ts` and `articleService.ts` for the same
 * enumeration rationale — the list endpoint is a read-only
 * projection and does not confirm the existence or ownership of
 * the filter's target.
 *
 * @param userId - Ownership value.
 * @param filter - Optional `articleId` and/or `topicId` filter.
 */
export const listReports = async (
  userId: MongoId,
  filter: { articleId?: MongoId; topicId?: MongoId } = {}
): Promise<ReportDocument[]> => {
  const query: {
    userId: MongoId;
    articleId?: MongoId;
    topicId?: MongoId;
  } = { userId };

  if (filter.articleId !== undefined) {
    query.articleId = filter.articleId;
  }
  if (filter.topicId !== undefined) {
    query.topicId = filter.topicId;
  }

  return await ReportModel.find(query).sort({ createdAt: -1 });
};

// ============================================================
//  getReportById
// ============================================================

/**
 * Read a single report by id, scoped to the caller.
 *
 * Returns `null` when the report does not exist, OR when it
 * exists but belongs to a different user. The two cases are
 * intentionally indistinguishable — see `documentService.ts` for
 * the same enumeration rationale (which applies identically
 * here).
 *
 * A malformed id string — one that is not a valid ObjectId —
 * does NOT return null; it causes Mongoose to throw a CastError,
 * which the terminal middleware maps to a 400.
 *
 * @param userId   - Ownership value.
 * @param reportId - The report's id, as a string from the route
 *                   parameter.
 */
export const getReportById = async (
  userId: MongoId,
  reportId: string
): Promise<ReportDocument | null> => {
  return await ReportModel.findOne({ _id: reportId, userId });
};

// ============================================================
//  getLatestReportByArticle
// ============================================================

/**
 * Read the newest report for an article, scoped to the caller.
 *
 * Returns `null` when the article has no reports yet, OR when
 * the article does not exist, OR when the article belongs to a
 * different user. The three cases collapse to the same null —
 * the caller (the article view, the corrective regeneration
 * loop) either has a report to work with or it does not.
 *
 * The query is covered by the compound index
 * `{ userId, articleId, createdAt: -1 }` — the filter matches on
 * the leftmost two fields, and the sort key is the trailing
 * field. The `.limit(1)` form is not used because Mongoose's
 * `findOne` already implies a limit of one; a further `.limit(1)`
 * would be redundant.
 *
 * @param userId    - Ownership value.
 * @param articleId - The parent article whose newest report is
 *                    being fetched.
 */
export const getLatestReportByArticle = async (
  userId: MongoId,
  articleId: MongoId
): Promise<ReportDocument | null> => {
  return await ReportModel.findOne({ userId, articleId }).sort({
    createdAt: -1,
  });
};

// ============================================================
//  getLatestReportByTopic
// ============================================================

/**
 * Read the newest report for a topic, scoped to the caller.
 *
 * "Newest for the topic" means the most recently produced report
 * across all the topic's articles — the topic-detail view uses
 * this to show the current validation state without needing to
 * know which article is current.
 *
 * Returns `null` under the same three collapsing conditions as
 * `getLatestReportByArticle`: no reports yet, no such topic, or
 * the topic is not owned by the caller.
 *
 * Covered by the compound index `{ userId, topicId, createdAt: -1 }`.
 *
 * @param userId  - Ownership value.
 * @param topicId - The parent topic whose newest report is being
 *                  fetched.
 */
export const getLatestReportByTopic = async (
  userId: MongoId,
  topicId: MongoId
): Promise<ReportDocument | null> => {
  return await ReportModel.findOne({ userId, topicId }).sort({
    createdAt: -1,
  });
};

// ============================================================
//  deleteReport
// ============================================================

/**
 * Delete a single report by id, scoped to the caller.
 *
 * Returns the deleted document so the caller can log or display
 * what was removed. Reports have no children, so there is no
 * cascade to consider.
 *
 * Throws `AppError(404)` when the report does not exist or is
 * not owned by the caller. Same merged case as the read paths.
 *
 * @param userId   - Ownership value.
 * @param reportId - The report's id.
 */
export const deleteReport = async (
  userId: MongoId,
  reportId: string
): Promise<ReportDocument> => {
  const deleted = await ReportModel.findOneAndDelete({
    _id: reportId,
    userId,
  });

  if (!deleted) {
    throw new AppError('Report not found.', 404);
  }

  return deleted;
};

// ============================================================
//  deleteReportsByArticle
// ============================================================

/**
 * Bulk-delete every report attached to the given article, scoped
 * to the caller.
 *
 * Returns the number of reports removed. A count of zero is a
 * legitimate, non-error result: it means either the article has
 * no reports, or the article does not exist, or the article
 * belongs to a different user — the caller does not need to
 * distinguish those cases.
 *
 * The filter is scoped to `{ userId, articleId }`, not just
 * `articleId`. A caller who does not own the article matches
 * zero records on the `userId` clause and therefore cannot clear
 * another user's reports by guessing an article id.
 *
 * @param userId    - Ownership value.
 * @param articleId - The parent article whose reports are being
 *                    removed.
 */
export const deleteReportsByArticle = async (
  userId: MongoId,
  articleId: MongoId
): Promise<number> => {
  const result = await ReportModel.deleteMany({ userId, articleId });
  return result.deletedCount;
};

// ============================================================
//  deleteReportsByTopic
// ============================================================

/**
 * Bulk-delete every report attached to the given topic, scoped
 * to the caller.
 *
 * "Attached to the topic" means every report whose denormalized
 * `topicId` field matches — including reports for articles that
 * are themselves about to be deleted, or that have already been
 * deleted. This is intentional: the denormalized `topicId` makes
 * the topic-scoped delete a single indexed operation with no
 * join through the article collection.
 *
 * Returns the number of reports removed. A count of zero is a
 * legitimate result, same collapsing cases as
 * `deleteReportsByArticle`.
 *
 * The filter is scoped to `{ userId, topicId }`. A caller who
 * does not own the topic matches zero records on the `userId`
 * clause.
 *
 * @param userId  - Ownership value.
 * @param topicId - The parent topic whose reports are being
 *                  removed.
 */
export const deleteReportsByTopic = async (
  userId: MongoId,
  topicId: MongoId
): Promise<number> => {
  const result = await ReportModel.deleteMany({ userId, topicId });
  return result.deletedCount;
};

// ============================================================
//  Default export
// ============================================================

export default {
  createReport,
  listReports,
  getReportById,
  getLatestReportByArticle,
  getLatestReportByTopic,
  deleteReport,
  deleteReportsByArticle,
  deleteReportsByTopic,
};