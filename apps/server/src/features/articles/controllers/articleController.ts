/**
 * HTTP handlers for the WriteSpeare Article entity.
 *
 * Thin request/response layer over `articleService`. Each handler
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
 *      service would produce a confusing error. The schema (in
 *      `articles/models/Article.ts`) remains the authoritative
 *      validator for everything subtler — non-empty content,
 *      integer word counts, the closed status set — and a Mongoose
 *      ValidationError is translated to a 400 by the terminal
 *      error middleware. Doing anything more in the controller
 *      would duplicate the schema's rules and eventually drift
 *      from them.
 *
 *   3. Delegate to the service. The controller never touches the
 *      database directly — it does not import the Article model,
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
 * the service — a 404 for an article or topic that does not exist
 * or is not owned by the caller — and formats the response with
 * the same envelope this file uses on success.
 *
 * Response typing — the assignability bridge:
 *
 *   Every handler declares its `Response<T>` type explicitly. On
 *   success the service returns an `ArticleDocument` (Mongoose's
 *   in-process shape) which is structurally assignable to the
 *   shared `Article` domain type — the only difference is that
 *   `ArticleDocument._id` is a concrete `ObjectId` while
 *   `Article._id` is `string | ObjectId`. Since `ObjectId` is a
 *   member of the union, the assignment is safe. At runtime,
 *   `res.json()` serialises the ObjectId to its hex string form.
 *
 * The dual-purpose `getLatestArticle` route:
 *
 *   This handler exists to serve one specific query — "give me
 *   the current (highest-version) article for this topic" — that
 *   the topic-detail view issues on every render. It returns 404
 *   when the topic has no articles, when the topic does not exist,
 *   or when the topic belongs to a different user. The three
 *   cases collapse to the same 404, matching the enumeration-
 *   attack rationale used elsewhere in this file (see
 *   `getArticleById` and `deleteArticle`).
 *
 * Status transition route — why it is a sub-path, not a
 * full-resource PATCH:
 *
 *   Only one field of an article is mutable in place: `status`.
 *   Content is immutable by design — a change of content
 *   produces a new version, not a mutation. Rather than expose a
 *   generic `PATCH /api/articles/:id` that accepts arbitrary
 *   fields (which would then have to reject everything except
 *   `status`), the API exposes a narrower, more honest route:
 *   `PATCH /api/articles/:id/status`, whose body is `{ status }`
 *   and nothing else. This is the same style used by many REST
 *   APIs to model a state-machine transition as a distinct
 *   operation rather than as a field write.
 *
 * Ownership scoping:
 *
 *   The `userId` passed to the service is ALWAYS derived from the
 *   authenticated session — `req.user.userId` — and NEVER read
 *   from the request body or query. This is what makes it
 *   impossible for a client to create an article on behalf of
 *   another user: the ownership field is set from the token, not
 *   from anything the client controls.
 */

import type { Response } from 'express';

import {
  createArticle as createArticleService,
  listArticles as listArticlesService,
  getArticleById as getArticleByIdService,
  getLatestArticle as getLatestArticleService,
  updateArticleStatus as updateArticleStatusService,
  deleteArticle as deleteArticleService,
  deleteArticlesByTopic as deleteArticlesByTopicService,
} from '../services/articleService.js';

import type { AuthRequest } from '../../auth/middleware/authGuard.js';
import type {
  ApiResponse,
  Article,
  ArticleCreatePayload,
  ArticleStatus,
} from '../../shared/types/index.js';

// ============================================================
//  Runtime legal-value table and type guard
// ============================================================
//
// The `ArticleStatus` union is a compile-time type — it does not
// exist at runtime, so the value arriving from an untrusted
// client body cannot be checked against it directly. This array
// is the runtime counterpart, and the type annotation
// (`readonly ArticleStatus[]`) guarantees at compile time that
// every string in the array is a legal member of the union.

const ARTICLE_STATUS_VALUES: readonly ArticleStatus[] = [
  'draft',
  'validated',
  'exported',
];

/**
 * Narrow `unknown` to one of the three legal article statuses.
 *
 * The cast to `readonly string[]` before `.includes` is required
 * because `Array.prototype.includes` on a `readonly ArticleStatus[]`
 * expects an `ArticleStatus` argument, and the point of this
 * guard is to check an arbitrary unknown value against the array.
 */
const isArticleStatus = (value: unknown): value is ArticleStatus =>
  typeof value === 'string' &&
  (ARTICLE_STATUS_VALUES as readonly string[]).includes(value);

// ============================================================
//  POST /api/articles
// ============================================================

/**
 * Persist a generated article attached to a topic owned by the
 * authenticated user. The service computes the next version
 * number for the topic and writes it to the record.
 *
 * Flow:
 *
 *   1. Reject with 401 if no authenticated user is attached.
 *   2. Reject with 400 if the request body is not a plain object.
 *   3. Validate the three required fields on the request body:
 *      `topicId` (non-empty string), `content` (non-empty
 *      string), and `wordCount` (number). Length and content
 *      rules beyond "non-empty" are the schema's job — see the
 *      file header.
 *   4. Delegate to the service. The service validates that the
 *      parent topic exists and is owned by the caller; a 404
 *      thrown by that check propagates to the terminal
 *      middleware.
 *   5. Respond with 201 Created and the persisted article. The
 *      response includes the `version` value the service
 *      assigned.
 *
 * The `userId` argument to the service is derived from the
 * authenticated session. Any client-supplied `userId` field on
 * the request body is ignored — the body's `Record<string,
 * unknown>` type simply does not read that field.
 */
export const createArticle = async (
  req: AuthRequest,
  res: Response<ApiResponse<Article>>
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

  // ---- 3. Required fields ----

  const topicId = body['topicId'];
  if (typeof topicId !== 'string' || topicId.length === 0) {
    res.status(400).json({
      success: false,
      error: 'topicId is required.',
    });
    return;
  }

  const content = body['content'];
  if (typeof content !== 'string' || content.length === 0) {
    res.status(400).json({
      success: false,
      error: 'content is required.',
    });
    return;
  }

  const wordCount = body['wordCount'];
  if (typeof wordCount !== 'number') {
    res.status(400).json({
      success: false,
      error: 'wordCount must be a number.',
    });
    return;
  }

  // ---- 4. Build the payload and delegate ----
  // The `version` field is NOT part of `ArticleCreatePayload` by
  // design — the service computes it. Attempting to pass one
  // would be a compile error.
  const payload: ArticleCreatePayload = {
    topicId,
    content,
    wordCount,
  };

  const article = await createArticleService(userId, payload);

  // ---- 5. Respond ----
  res.status(201).json({
    success: true,
    data: article,
  });
};

// ============================================================
//  GET /api/articles
// ============================================================

/**
 * List the authenticated user's articles. An optional
 * `?topicId=` query parameter narrows the result to the articles
 * attached to a single topic.
 *
 * Sort order is chosen by the service based on whether the query
 * is topic-scoped:
 *
 *   - Topic-scoped: sorted by `version` descending (newest
 *     version first).
 *   - Cross-topic: sorted by `createdAt` descending (most
 *     recently written first).
 *
 * See the service header for the reasoning behind the two sort
 * orders.
 *
 * Flow:
 *
 *   1. Reject with 401 if no authenticated user is attached.
 *   2. If a `?topicId=` query parameter is present, validate
 *      that it is a non-empty string. The service does not
 *      confirm ownership of the topic — a topicId that does not
 *      belong to the caller produces an empty list, not a 404.
 *      See the service header for the enumeration rationale.
 *   3. Delegate to the service.
 *   4. Respond with 200 and the array. An empty array is a valid,
 *      non-error response.
 */
export const listArticles = async (
  req: AuthRequest,
  res: Response<ApiResponse<Article[]>>
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

  // ---- 2. Optional topicId filter ----
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

  // ---- 3. Delegate to the service ----
  const articles = await listArticlesService(userId, topicId);

  // ---- 4. Respond ----
  res.status(200).json({
    success: true,
    data: articles,
  });
};

// ============================================================
//  GET /api/articles/:id
// ============================================================

/**
 * Return a single article by its ID, scoped to the authenticated
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
 *      such article" or "article belongs to a different user";
 *      this handler returns 404 for both.
 *   4. Respond with 200 and the article, or 404 if it was not
 *      found / not owned.
 */
export const getArticleById = async (
  req: AuthRequest,
  res: Response<ApiResponse<Article>>
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
  const articleId = req.params['id'];
  if (typeof articleId !== 'string' || articleId.length === 0) {
    res.status(400).json({
      success: false,
      error: 'Article ID is required.',
    });
    return;
  }

  // ---- 3. Delegate to the service ----
  const article = await getArticleByIdService(userId, articleId);
  if (!article) {
    res.status(404).json({
      success: false,
      error: 'Article not found.',
    });
    return;
  }

  // ---- 4. Respond ----
  res.status(200).json({
    success: true,
    data: article,
  });
};

// ============================================================
//  GET /api/articles/topic/:topicId/latest
// ============================================================

/**
 * Return the current (highest-version) article for a topic, scoped
 * to the authenticated user.
 *
 * Flow:
 *
 *   1. Reject with 401 if no authenticated user is attached.
 *   2. Reject with 400 if the `:topicId` route parameter is
 *      missing or empty.
 *   3. Delegate to the service. A null result means one of three
 *      things — the topic has no articles, the topic does not
 *      exist, or the topic belongs to a different user. All three
 *      collapse to the same 404, matching the enumeration-attack
 *      rationale used elsewhere in this file.
 *   4. Respond with 200 and the article, or 404 if it was not
 *      found / not owned / not yet created.
 */
export const getLatestArticle = async (
  req: AuthRequest,
  res: Response<ApiResponse<Article>>
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
  const article = await getLatestArticleService(userId, topicId);
  if (!article) {
    res.status(404).json({
      success: false,
      error: 'No article found for this topic.',
    });
    return;
  }

  // ---- 4. Respond ----
  res.status(200).json({
    success: true,
    data: article,
  });
};

// ============================================================
//  PATCH /api/articles/:id/status
// ============================================================

/**
 * Transition an article's lifecycle status, scoped to the
 * authenticated user.
 *
 * Flow:
 *
 *   1. Reject with 401 if no authenticated user is attached.
 *   2. Reject with 400 if the `:id` route parameter is missing
 *      or empty.
 *   3. Reject with 400 if the request body is not a plain object,
 *      or if the `status` field is missing / not a member of the
 *      closed set. The closed-set check is done against the
 *      runtime array declared at the top of this file — the
 *      union type alone cannot validate an untrusted value.
 *   4. Delegate to the service. The service writes the status
 *      with `runValidators: true`, so the schema's enum check
 *      runs a second time at the database boundary as a safety
 *      net — see the service header for the rationale.
 *   5. Respond with 200 and the updated article.
 *
 * The `status` field is the ONLY mutable field on an existing
 * article. Content changes produce a new version (a new article)
 * rather than an in-place edit — see the service header.
 */
export const updateArticleStatus = async (
  req: AuthRequest,
  res: Response<ApiResponse<Article>>
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
  const articleId = req.params['id'];
  if (typeof articleId !== 'string' || articleId.length === 0) {
    res.status(400).json({
      success: false,
      error: 'Article ID is required.',
    });
    return;
  }

  // ---- 3. Body shape guard ----
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

  // ---- 4. Status field validation ----
  const status = body['status'];
  if (!isArticleStatus(status)) {
    res.status(400).json({
      success: false,
      error: `status must be one of: ${ARTICLE_STATUS_VALUES.join(', ')}.`,
    });
    return;
  }

  // ---- 5. Delegate to the service ----
  const article = await updateArticleStatusService(
    userId,
    articleId,
    status
  );

  // ---- 6. Respond ----
  res.status(200).json({
    success: true,
    data: article,
  });
};

// ============================================================
//  DELETE /api/articles/:id
// ============================================================

/**
 * Delete a single article, scoped to the authenticated user.
 *
 * Flow:
 *
 *   1. Reject with 401 if no authenticated user is attached.
 *   2. Reject with 400 if the `:id` route parameter is missing
 *      or empty.
 *   3. Delegate to the service. The service throws `AppError(404)`
 *      when the article does not exist or belongs to a different
 *      user.
 *   4. Respond with 200 and the deleted article. Returning the
 *      deleted document gives the client a last-chance look at
 *      what was removed, which the UI uses for an undo
 *      affordance.
 *
 * The service does NOT cascade to the article's Reports. Removing
 * a Report that referenced the article is the reports feature's
 * responsibility — see the service header.
 */
export const deleteArticle = async (
  req: AuthRequest,
  res: Response<ApiResponse<Article>>
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
  const articleId = req.params['id'];
  if (typeof articleId !== 'string' || articleId.length === 0) {
    res.status(400).json({
      success: false,
      error: 'Article ID is required.',
    });
    return;
  }

  // ---- 3. Delegate to the service ----
  const article = await deleteArticleService(userId, articleId);

  // ---- 4. Respond ----
  res.status(200).json({
    success: true,
    data: article,
  });
};

// ============================================================
//  DELETE /api/articles/topic/:topicId
// ============================================================

/**
 * Delete every article attached to the given topic, scoped to the
 * authenticated user.
 *
 * Flow:
 *
 *   1. Reject with 401 if no authenticated user is attached.
 *   2. Reject with 400 if the `:topicId` route parameter is
 *      missing or empty.
 *   3. Delegate to the service. The service returns the number of
 *      articles removed. Zero is a valid result — see the
 *      service header. The filter is scoped to
 *      `{ userId, topicId }`, so a caller cannot clear another
 *      user's topic by guessing its ID.
 *   4. Respond with 200 and `{ deletedCount }`.
 *
 * Route-path note — `/topic/:topicId` vs `/:id`:
 *
 *   Express matches routes segment-by-segment. A request to
 *   `DELETE /api/articles/topic/abc123` has two segments after
 *   the mount point (`topic` and `abc123`); a request to
 *   `DELETE /api/articles/xyz` has one (`xyz`). The two routes
 *   cannot collide. The nested form is used rather than a
 *   query-parameter form so that the URL alone communicates
 *   whether one article is being deleted or all of a topic's
 *   articles.
 */
export const deleteArticlesByTopic = async (
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
  const deletedCount = await deleteArticlesByTopicService(
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
  createArticle,
  listArticles,
  getArticleById,
  getLatestArticle,
  updateArticleStatus,
  deleteArticle,
  deleteArticlesByTopic,
};