/**
 * HTTP handlers for the WriteSpeare Report entity.
 *
 * Thin request/response layer over `reportService`. Each handler
 * performs exactly four jobs and nothing else:
 *
 *   1. Read the authenticated user's ID from `req.user.userId`
 *      and reject the request with a 401 if it is absent. Every
 *      ownership-scoped operation in WriteSpeare keys off this
 *      value; a handler that is reached without an authenticated
 *      session would either crash on a null dereference or — far
 *      worse — silently operate on the wrong user's data.
 *
 *   2. Validate the shape of the request body / query / params
 *      just enough to reject requests that are so malformed the
 *      service would produce a confusing error. See the "two-
 *      level validation" note below.
 *
 *   3. Delegate to the service. The controller never touches the
 *      database directly — it does not import the Report model,
 *      does not build queries, and does not know what collection
 *      the data lives in. That is the service's job.
 *
 *   4. Format the success response using the shared `ApiResponse`
 *      envelope. Every response — success or failure — uses the
 *      same shape, so a client can unwrap it uniformly.
 *
 * No try/catch appears anywhere in this file. Each route handler
 * is wrapped in `asyncHandler` at the route registration site,
 * which forwards any rejection to the terminal error middleware.
 * The middleware recognises the shared `AppError` class thrown by
 * the service — a 404 for a report or parent article that does
 * not exist or is not owned by the caller — and formats the
 * response with the same envelope this file uses on success.
 *
 * Two-level validation — why the six sections are only shallow-
 * checked at this layer:
 *
 *   A Report's payload is six nested section objects
 *   (readability, seo, keywords, originality, aiMarkers, grammar),
 *   each with its own field structure. Fully validating every
 *   leaf field at the controller level would duplicate the entire
 *   Report sub-schema in TypeScript — hundreds of lines of
 *   near-identical checks that would drift from the schema the
 *   first time a field was renamed.
 *
 *   Instead, the controller validates only the top-level shape:
 *   the request body is a plain object; `articleId` is a non-
 *   empty string; and each of the six section keys is present
 *   and is a plain object (not a string, not an array, not null).
 *   Anything deeper — a status value outside the closed set, a
 *   similarity score outside [0, 1], a non-integer word count —
 *   is the schema's job, and a Mongoose ValidationError is
 *   translated into a 400 by the terminal middleware.
 *
 *   The rationale for the split: the controller catches the
 *   client-developer mistakes that would produce a confusing
 *   service error ("readability must be an object" is a clear
 *   message; a nested CastError pointing at
 *   `readability.fleschReadingEase` is not). Everything subtler
 *   is caught by the schema, which is the authoritative
 *   validator and cannot drift from itself.
 *
 * Response typing — the assignability bridge:
 *
 *   Every handler declares its `Response<T>` type explicitly. On
 *   success the service returns a `ReportDocument` (Mongoose's
 *   in-process shape) which is structurally assignable to the
 *   shared `Report` domain type — the only difference is that
 *   `ReportDocument._id` is a concrete `ObjectId` while
 *   `Report._id` is `string | ObjectId`. Since `ObjectId` is a
 *   member of the union, the assignment is safe. At runtime,
 *   `res.json()` serialises the ObjectId to its hex string form.
 *
 * Payload type — imported from the service, not from shared
 * types:
 *
 *   The `ReportCreatePayload` type is declared in
 *   `../services/reportService.ts`, not in
 *   `../../shared/types/index.ts`. This is a slight deviation
 *   from the pattern used by the three previous controllers
 *   (which imported their payload types from `shared/types`).
 *   The deviation is documented and logged as a PLAN DELTA in the
 *   previous execution step — the shared types module does not
 *   yet declare a first-class `ReportCreatePayload` interface,
 *   and rather than import a symbol that does not exist, the
 *   service declared its own. If the shared type is promoted in a
 *   future session, the sole change required here is to swap the
 *   import source in a single line.
 *
 * The `topicId` invariant:
 *
 *   The create payload does NOT include a `topicId` field. The
 *   service derives the report's `topicId` from its parent
 *   article's own `topicId` field — see `reportService.ts` for
 *   the full rationale. The controller therefore has no
 *   `topicId` handling on the create path; any client-supplied
 *   `topicId` on the request body is ignored (the body's type
 *   does not read that field).
 *
 * Ownership scoping:
 *
 *   The `userId` passed to the service is ALWAYS derived from the
 *   authenticated session — `req.user.userId` — and NEVER read
 *   from the request body or query. This is what makes it
 *   impossible for a client to create or read a report on behalf
 *   of another user: the ownership field is set from the token,
 *   not from anything the client controls.
 */

import type { Response } from 'express';

import {
  createReport as createReportService,
  listReports as listReportsService,
  getReportById as getReportByIdService,
  getLatestReportByArticle as getLatestReportByArticleService,
  getLatestReportByTopic as getLatestReportByTopicService,
  deleteReport as deleteReportService,
  deleteReportsByArticle as deleteReportsByArticleService,
  deleteReportsByTopic as deleteReportsByTopicService,
} from '../services/reportService.js';
import type { ReportCreatePayload } from '../services/reportService.js';

import type { AuthRequest } from '../../auth/middleware/authGuard.js';
import type { ApiResponse, Report } from '../../shared/types/index.js';

// ============================================================
//  Local helpers
// ============================================================

/**
 * Report whether a value is a plain object — an object that is
 * neither null nor an array.
 *
 * Deliberately declared WITHOUT a TypeScript type predicate
 * (`value is Record<string, unknown>`). The lack of a predicate
 * is intentional: adding one would cause every call site to
 * narrow the checked variable to `Record<string, unknown>`, which
 * is precisely the type this file's cast-to-payload step needs
 * to avoid. A `Record<string, unknown>` cannot be cast to a
 * specific interface like `ReadabilityReport` without going
 * through `as unknown as`, which the plan forbids. By keeping
 * the check as a plain boolean, the checked value remains
 * `unknown` at the type level, and a single direct cast is
 * sufficient.
 *
 * The runtime behaviour is identical either way — the function
 * still catches strings, numbers, booleans, null, and arrays.
 */
const isPlainObject = (value: unknown): boolean =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The six section keys that a create-payload is required to
 * carry, as a readonly tuple. Declared once so the create
 * handler's validation loop and its docstring can reference the
 * same list.
 */
const REPORT_SECTION_KEYS: readonly [
  'readability',
  'seo',
  'keywords',
  'originality',
  'aiMarkers',
  'grammar',
] = [
  'readability',
  'seo',
  'keywords',
  'originality',
  'aiMarkers',
  'grammar',
];

// ============================================================
//  POST /api/reports
// ============================================================

/**
 * Persist a validation report attached to an article owned by
 * the authenticated user. The service derives the report's
 * `topicId` from the parent article and computes `overallStatus`
 * from the six section statuses — neither is accepted from the
 * client.
 *
 * Flow:
 *
 *   1. Reject with 401 if no authenticated user is attached.
 *   2. Reject with 400 if the request body is not a plain object.
 *   3. Validate `articleId` is a non-empty string.
 *   4. Validate each of the six section keys is present and is a
 *      plain object. See the file header's "two-level validation"
 *      note for why this check is shallow.
 *   5. Build the payload and delegate to the service. The service
 *      validates that the parent article exists and is owned by
 *      the caller; a 404 thrown by that check propagates to the
 *      terminal middleware.
 *   6. Respond with 201 Created and the persisted report. The
 *      response includes the derived `topicId` and the computed
 *      `overallStatus`.
 */
export const createReport = async (
  req: AuthRequest,
  res: Response<ApiResponse<Report>>
): Promise<void> => {
  // ---- 1. Authentication guard ----
  const userId = req.user?.userId;
  if (!userId) {
    res.status(401).json({
      success: false,
      error: 'Authentication required.',
    });
    return;
  }

  // ---- 2. Body shape guard ----
  const rawBody: unknown = req.body;
  if (
    typeof rawBody !== 'object' ||
    rawBody === null ||
    Array.isArray(rawBody)
  ) {
    res.status(400).json({
      success: false,
      error: 'Request body must be a JSON object.',
    });
    return;
  }
  const body = rawBody as Record<string, unknown>;

  // ---- 3. Required field: articleId ----
  const articleId = body['articleId'];
  if (typeof articleId !== 'string' || articleId.length === 0) {
    res.status(400).json({
      success: false,
      error: 'articleId is required.',
    });
    return;
  }

  // ---- 4. Section shape guards ----
  // Each of the six sections must be present and must be a plain
  // object. The loop uses the shared REPORT_SECTION_KEYS tuple so
  // the list of keys lives in exactly one place.
  for (const key of REPORT_SECTION_KEYS) {
    if (!isPlainObject(body[key])) {
      res.status(400).json({
        success: false,
        error: `${key} must be an object.`,
      });
      return;
    }
  }

  // ---- 5. Build the payload and delegate ----
  // The cast to `ReportCreatePayload` is required because the
  // body's six section fields are typed `unknown` at this point
  // — the schema is the authoritative validator for their
  // interiors, and the controller has deliberately not narrowed
  // them. The `isPlainObject` checks above have confirmed at
  // runtime that each section is an object; the cast tells the
  // compiler to trust that runtime check for the shape of the
  // payload, while the leaf-value validation remains the
  // schema's job at save time. See the file header for the full
  // rationale.
  const payload = {
    articleId,
    readability: body['readability'],
    seo: body['seo'],
    keywords: body['keywords'],
    originality: body['originality'],
    aiMarkers: body['aiMarkers'],
    grammar: body['grammar'],
  } as ReportCreatePayload;

  const report = await createReportService(userId, payload);

  // ---- 6. Respond ----
  res.status(201).json({
    success: true,
    data: report,
  });
};

// ============================================================
//  GET /api/reports
// ============================================================

/**
 * List the authenticated user's reports, sorted newest first.
 * Optional `?articleId=` and `?topicId=` query parameters narrow
 * the result. When both are provided, the result is the
 * intersection — reports for a single article, which are a
 * subset of reports for its topic.
 *
 * Flow:
 *
 *   1. Reject with 401 if no authenticated user is attached.
 *   2. For each optional filter, validate that if present it is
 *      a non-empty string. A repeated query parameter (`?articleId=a&articleId=b`)
 *      arrives as an array and is rejected — the API accepts
 *      exactly one value per filter.
 *   3. Delegate to the service with a filter object containing
 *      only the filters the caller supplied. Fields left `undefined`
 *      are omitted from the object entirely rather than set to
 *      `undefined`, per `exactOptionalPropertyTypes`.
 *   4. Respond with 200 and the array. An empty array is a
 *      valid, non-error response.
 *
 * A filter whose value does not correspond to any records the
 * caller owns produces an empty array, not a 404 — see the
 * service header for the enumeration rationale.
 */
export const listReports = async (
  req: AuthRequest,
  res: Response<ApiResponse<Report[]>>
): Promise<void> => {
  // ---- 1. Authentication guard ----
  const userId = req.user?.userId;
  if (!userId) {
    res.status(401).json({
      success: false,
      error: 'Authentication required.',
    });
    return;
  }

  // ---- 2. Optional filters ----
  const rawArticleId = req.query['articleId'];
  let articleId: string | undefined;
  if (rawArticleId !== undefined) {
    if (typeof rawArticleId !== 'string' || rawArticleId.length === 0) {
      res.status(400).json({
        success: false,
        error: 'Invalid articleId filter.',
      });
      return;
    }
    articleId = rawArticleId;
  }

  const rawTopicId = req.query['topicId'];
  let topicId: string | undefined;
  if (rawTopicId !== undefined) {
    if (typeof rawTopicId !== 'string' || rawTopicId.length === 0) {
      res.status(400).json({
        success: false,
        error: 'Invalid topicId filter.',
      });
      return;
    }
    topicId = rawTopicId;
  }

  // ---- 3. Build the filter object and delegate ----
  // Conditional assignment (rather than assigning `undefined`)
  // is required under `exactOptionalPropertyTypes`. The resulting
  // object contains only the fields the caller actually supplied.
  const filter: { articleId?: string; topicId?: string } = {};
  if (articleId !== undefined) {
    filter.articleId = articleId;
  }
  if (topicId !== undefined) {
    filter.topicId = topicId;
  }

  const reports = await listReportsService(userId, filter);

  // ---- 4. Respond ----
  res.status(200).json({
    success: true,
    data: reports,
  });
};

// ============================================================
//  GET /api/reports/:id
// ============================================================

/**
 * Return a single report by its ID, scoped to the authenticated
 * user.
 *
 * Flow:
 *
 *   1. Reject with 401 if no authenticated user is attached.
 *   2. Reject with 400 if the `:id` route parameter is missing
 *      or empty. A malformed ID that is present but not a valid
 *      ObjectId is not rejected here — the service's `findOne`
 *      throws a CastError, which the terminal middleware maps to
 *      a 400.
 *   3. Delegate to the service. A null result means either "no
 *      such report" or "report belongs to a different user";
 *      this handler returns 404 for both.
 *   4. Respond with 200 and the report, or 404 if it was not
 *      found / not owned.
 */
export const getReportById = async (
  req: AuthRequest,
  res: Response<ApiResponse<Report>>
): Promise<void> => {
  // ---- 1. Authentication guard ----
  const userId = req.user?.userId;
  if (!userId) {
    res.status(401).json({
      success: false,
      error: 'Authentication required.',
    });
    return;
  }

  // ---- 2. Route parameter guard ----
  const reportId = req.params['id'];
  if (typeof reportId !== 'string' || reportId.length === 0) {
    res.status(400).json({
      success: false,
      error: 'Report ID is required.',
    });
    return;
  }

  // ---- 3. Delegate to the service ----
  const report = await getReportByIdService(userId, reportId);
  if (!report) {
    res.status(404).json({
      success: false,
      error: 'Report not found.',
    });
    return;
  }

  // ---- 4. Respond ----
  res.status(200).json({
    success: true,
    data: report,
  });
};

// ============================================================
//  GET /api/reports/article/:articleId/latest
// ============================================================

/**
 * Return the newest report for an article, scoped to the
 * authenticated user.
 *
 * Flow:
 *
 *   1. Reject with 401 if no authenticated user is attached.
 *   2. Reject with 400 if the `:articleId` route parameter is
 *      missing or empty.
 *   3. Delegate to the service. A null result means one of three
 *      things — the article has no reports, the article does not
 *      exist, or the article belongs to a different user. All
 *      three collapse to the same 404, matching the enumeration-
 *      attack rationale used elsewhere in this file.
 *   4. Respond with 200 and the report, or 404 if none was found.
 */
export const getLatestReportByArticle = async (
  req: AuthRequest,
  res: Response<ApiResponse<Report>>
): Promise<void> => {
  // ---- 1. Authentication guard ----
  const userId = req.user?.userId;
  if (!userId) {
    res.status(401).json({
      success: false,
      error: 'Authentication required.',
    });
    return;
  }

  // ---- 2. Route parameter guard ----
  const articleId = req.params['articleId'];
  if (typeof articleId !== 'string' || articleId.length === 0) {
    res.status(400).json({
      success: false,
      error: 'Article ID is required.',
    });
    return;
  }

  // ---- 3. Delegate to the service ----
  const report = await getLatestReportByArticleService(userId, articleId);
  if (!report) {
    res.status(404).json({
      success: false,
      error: 'No report found for this article.',
    });
    return;
  }

  // ---- 4. Respond ----
  res.status(200).json({
    success: true,
    data: report,
  });
};

// ============================================================
//  GET /api/reports/topic/:topicId/latest
// ============================================================

/**
 * Return the newest report for a topic — the most recently
 * produced report across all the topic's articles — scoped to
 * the authenticated user.
 *
 * Flow is identical to `getLatestReportByArticle` with the
 * articleId substituted for a topicId. Returns 404 when the
 * topic has no reports, the topic does not exist, or the topic
 * is not owned by the caller.
 */
export const getLatestReportByTopic = async (
  req: AuthRequest,
  res: Response<ApiResponse<Report>>
): Promise<void> => {
  // ---- 1. Authentication guard ----
  const userId = req.user?.userId;
  if (!userId) {
    res.status(401).json({
      success: false,
      error: 'Authentication required.',
    });
    return;
  }

  // ---- 2. Route parameter guard ----
  const topicId = req.params['topicId'];
  if (typeof topicId !== 'string' || topicId.length === 0) {
    res.status(400).json({
      success: false,
      error: 'Topic ID is required.',
    });
    return;
  }

  // ---- 3. Delegate to the service ----
  const report = await getLatestReportByTopicService(userId, topicId);
  if (!report) {
    res.status(404).json({
      success: false,
      error: 'No report found for this topic.',
    });
    return;
  }

  // ---- 4. Respond ----
  res.status(200).json({
    success: true,
    data: report,
  });
};

// ============================================================
//  DELETE /api/reports/:id
// ============================================================

/**
 * Delete a single report, scoped to the authenticated user.
 *
 * Flow:
 *
 *   1. Reject with 401 if no authenticated user is attached.
 *   2. Reject with 400 if the `:id` route parameter is missing
 *      or empty.
 *   3. Delegate to the service. The service throws `AppError(404)`
 *      when the report does not exist or belongs to a different
 *      user.
 *   4. Respond with 200 and the deleted report. Returning the
 *      deleted document gives the client a last-chance look at
 *      what was removed. Reports have no children, so there is
 *      no cascade to consider.
 */
export const deleteReport = async (
  req: AuthRequest,
  res: Response<ApiResponse<Report>>
): Promise<void> => {
  // ---- 1. Authentication guard ----
  const userId = req.user?.userId;
  if (!userId) {
    res.status(401).json({
      success: false,
      error: 'Authentication required.',
    });
    return;
  }

  // ---- 2. Route parameter guard ----
  const reportId = req.params['id'];
  if (typeof reportId !== 'string' || reportId.length === 0) {
    res.status(400).json({
      success: false,
      error: 'Report ID is required.',
    });
    return;
  }

  // ---- 3. Delegate to the service ----
  const report = await deleteReportService(userId, reportId);

  // ---- 4. Respond ----
  res.status(200).json({
    success: true,
    data: report,
  });
};

// ============================================================
//  DELETE /api/reports/article/:articleId
// ============================================================

/**
 * Delete every report attached to the given article, scoped to
 * the authenticated user.
 *
 * Flow:
 *
 *   1. Reject with 401 if no authenticated user is attached.
 *   2. Reject with 400 if the `:articleId` route parameter is
 *      missing or empty.
 *   3. Delegate to the service. The service returns the number
 *      of reports removed. Zero is a valid result — see the
 *      service header. The filter is scoped to
 *      `{ userId, articleId }`, so a caller cannot clear another
 *      user's reports by guessing an article ID.
 *   4. Respond with 200 and `{ deletedCount }`.
 *
 * Route-path note — the multi-segment paths in this file:
 *
 *   `DELETE /api/reports/article/:articleId` has two segments
 *   after the mount point. `DELETE /api/reports/:id` has one.
 *   Express matches by segment count, so the two routes cannot
 *   collide regardless of the order in which they are declared
 *   in the route file.
 */
export const deleteReportsByArticle = async (
  req: AuthRequest,
  res: Response<ApiResponse<{ deletedCount: number }>>
): Promise<void> => {
  // ---- 1. Authentication guard ----
  const userId = req.user?.userId;
  if (!userId) {
    res.status(401).json({
      success: false,
      error: 'Authentication required.',
    });
    return;
  }

  // ---- 2. Route parameter guard ----
  const articleId = req.params['articleId'];
  if (typeof articleId !== 'string' || articleId.length === 0) {
    res.status(400).json({
      success: false,
      error: 'Article ID is required.',
    });
    return;
  }

  // ---- 3. Delegate to the service ----
  const deletedCount = await deleteReportsByArticleService(
    userId,
    articleId
  );

  // ---- 4. Respond ----
  res.status(200).json({
    success: true,
    data: { deletedCount },
  });
};

// ============================================================
//  DELETE /api/reports/topic/:topicId
// ============================================================

/**
 * Delete every report attached to the given topic, scoped to the
 * authenticated user.
 *
 * Flow is identical to `deleteReportsByArticle` with the
 * articleId substituted for a topicId. The filter is scoped to
 * `{ userId, topicId }` in the service, so a caller who does not
 * own the topic matches zero records.
 *
 * Route-path note — `/topic/:topicId` (two segments) vs `/:id`
 * (one segment): no collision, same reasoning as the article-
 * scoped delete above.
 */
export const deleteReportsByTopic = async (
  req: AuthRequest,
  res: Response<ApiResponse<{ deletedCount: number }>>
): Promise<void> => {
  // ---- 1. Authentication guard ----
  const userId = req.user?.userId;
  if (!userId) {
    res.status(401).json({
      success: false,
      error: 'Authentication required.',
    });
    return;
  }

  // ---- 2. Route parameter guard ----
  const topicId = req.params['topicId'];
  if (typeof topicId !== 'string' || topicId.length === 0) {
    res.status(400).json({
      success: false,
      error: 'Topic ID is required.',
    });
    return;
  }

  // ---- 3. Delegate to the service ----
  const deletedCount = await deleteReportsByTopicService(
    userId,
    topicId
  );

  // ---- 4. Respond ----
  res.status(200).json({
    success: true,
    data: { deletedCount },
  });
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