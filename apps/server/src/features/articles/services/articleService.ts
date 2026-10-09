/**
 * Business logic for the WriteSpeare Article entity.
 *
 * An Article is one generated article attached to a Topic. A
 * Topic can own multiple Article versions — the initial draft
 * returned by the writer step, plus any subsequent versions
 * produced by the corrective regeneration loop. Each Article is
 * a numbered snapshot; the article with the highest `version`
 * number is the "current" one for its topic.
 *
 * The service exposes seven ownership-scoped operations:
 *
 *   createArticle           — persist a generated article, with
 *                             the next version number computed
 *                             from the existing versions
 *   listArticles            — read the user's articles,
 *                             optionally filtered by topic
 *   getArticleById          — read a single article
 *   getLatestArticle        — read the current version for a topic
 *   updateArticleStatus     — transition the lifecycle status
 *   deleteArticle           — remove a single article
 *   deleteArticlesByTopic   — bulk-remove every article under a topic
 *
 * Every function takes a `userId` argument that the caller (the
 * controller) derives from `req.user.userId`. That value is never
 * read from the request body, query, or route params — the client
 * cannot choose whose articles they are reading or writing. This
 * is the same ownership contract used by `topicService.ts` and
 * `documentService.ts`.
 *
 * Cross-feature import — TopicModel:
 *
 *   This service imports `TopicModel` from the topics feature to
 *   verify, on the create path, that the parent topic exists and
 *   is owned by the caller before persisting the article. Without
 *   the check, a client could POST an article with any `topicId`
 *   — including one belonging to another user — and the article
 *   would be persisted with an inconsistent ownership pair. The
 *   import direction (child → parent) mirrors the same decision
 *   made in `documentService.ts`, and the same caveat applies:
 *   future cross-feature imports in the wrong direction would be
 *   rejected, but this one is fundamental to the hierarchy.
 *
 * Version computation:
 *
 *   Each call to `createArticle` computes the next version number
 *   by finding the current maximum for the `(userId, topicId)`
 *   pair and adding one. The first article for a topic is version
 *   1; every subsequent creation is version N+1. The computation
 *   is a single indexed query (the compound index
 *   `{ userId, topicId, version: -1 }` on the Article schema
 *   covers it), and the schema's `version` field only enforces
 *   that the result is a positive integer — the assignment of the
 *   specific next value is the service's job.
 *
 *   Two concurrent regenerations for the same topic could, in
 *   principle, both read the same current maximum and both write
 *   version N+1. The schema does NOT declare `(userId, topicId,
 *   version)` unique, so the second write would succeed and the
 *   topic would end up with two articles at the same version
 *   number. That outcome is acceptable for the current product —
 *   the desktop client serializes regenerations (one at a time,
 *   via the writer store's `isGenerating` flag), so the race
 *   cannot occur through the supported UI. If a future backend
 *   exposes concurrent regeneration, the correct fix is a unique
 *   compound index plus a retry loop in this function, not a
 *   change to the schema in isolation.
 *
 * Immutability of content:
 *
 *   There is no `updateArticleContent` function. An Article
 *   represents a specific snapshot of the writer step's output.
 *   If the user edits an article or regenerates it, the correct
 *   operation is to create a new version — this is what the
 *   "Regenerate" and "Edit" actions in the desktop client do, by
 *   calling `createArticle` with the new content. The only field
 *   that can be mutated in place is `status`, via the narrow
 *   `updateArticleStatus` function.
 *
 *   This design keeps the version history a clean log of every
 *   article state the topic has ever held. If article content
 *   were mutable, a Report produced against version 3 would
 *   become stale the moment the content changed, and there would
 *   be no way to reconstruct which version the report was
 *   actually validating. Immutable content plus a separate status
 *   field avoids that class of ambiguity entirely.
 *
 * The status transition and the corrective loop:
 *
 *   `draft`     — the article as first returned by the writer.
 *   `validated` — a Report has been produced against it.
 *   `exported`  — the user has exported it to a file.
 *
 *   The service does not enforce which transitions are legal from
 *   which state — it accepts any `ArticleStatus` value and writes
 *   it. Enforcing transition rules at the service level would
 *   require a lookup of the current status on every update and
 *   would add a second source of truth alongside the schema's
 *   enum. In practice the callers (the validation runner and the
 *   export handler) only ever advance the status forward, and the
 *   schema's enum restricts the values to the closed set. If a
 *   future requirement needs enforced transitions, the correct
 *   place to add them is here, guarded by a current-status read.
 *
 * Cascade semantics:
 *
 *   `deleteArticlesByTopic` exists so that a future cascade from
 *   topic deletion has a well-defined entry point, mirroring the
 *   same function on the Document service. The current topic
 *   service does NOT call it — see the header comment in
 *   `topicService.ts`, which explicitly notes that cascading is
 *   "a decision for each owning feature". The cascade is scoped
 *   to the caller's `userId`, so a caller who does not own the
 *   topic matches zero records and cannot clear another user's
 *   articles by guessing the topic id.
 */

import { ArticleModel, type ArticleDocument } from '../models/Article.js';
import { TopicModel } from '../../topics/models/Topic.js';
import type {
  MongoId,
  ArticleCreatePayload,
  ArticleStatus,
} from '../../shared/types/index.js';
import { AppError } from '../../shared/middleware/errorHandler.js';

// ============================================================
//  createArticle
// ============================================================

/**
 * Persist a generated article attached to a topic owned by the
 * caller. The next version number for the topic is computed here
 * and written to the record; the caller does not supply a version.
 *
 * Flow:
 *
 *   1. Look up the parent topic by `(topicId, userId)`. The
 *      ownership check is part of the same query — a topic that
 *      exists but belongs to a different user is treated as "not
 *      found", which keeps the service from leaking other users'
 *      topic IDs through a 403.
 *
 *   2. If the topic does not exist or is not owned by the caller,
 *      throw `AppError(404)` with a message that refers to the
 *      topic, not the article. The caller is trying to attach an
 *      article to a topic they cannot see; the correct diagnostic
 *      is "that topic does not exist (from your point of view)".
 *
 *   3. Read the current maximum version number for this
 *      `(userId, topicId)` pair. A topic with no articles yet has
 *      no max, and the next version is 1.
 *
 *   4. Persist the article with the caller's `userId`, the
 *      supplied `topicId` and body fields, and the computed
 *      version. Status defaults to `draft` via the schema.
 *
 *   5. Return the saved document.
 *
 * The function does NOT catch validation errors from the schema.
 * A Mongoose ValidationError thrown here — empty content, a
 * negative word count, a non-integer word count — propagates to
 * the terminal error middleware, which maps it to a 400 with the
 * schema's own message.
 *
 * @param userId  - Ownership value, derived from the authenticated
 *                  session by the controller.
 * @param payload - The generated article's body and word count.
 *                  `version` and `userId` are NOT part of this
 *                  payload by design.
 */
export const createArticle = async (
  userId: MongoId,
  payload: ArticleCreatePayload
): Promise<ArticleDocument> => {
  // ---- 1. Verify the parent topic exists and is owned by the caller ----
  const parentTopic = await TopicModel.findOne({
    _id: payload.topicId,
    userId,
  });

  if (!parentTopic) {
    throw new AppError('Topic not found.', 404);
  }

  // ---- 2. Compute the next version number ----
  // The compound index { userId, topicId, version: -1 } on the
  // Article schema makes this query an index-only scan — no
  // collection fetch, no in-memory sort. The projection narrows
  // the returned document to the single field we need.
  const latest = await ArticleModel.findOne({
    userId,
    topicId: payload.topicId,
  })
    .sort({ version: -1 })
    .select('version');

  // `latest` is `ArticleDocument | null`. When it is null, the
  // topic has no articles yet and this is the first one — version
  // 1. When it is not null, the next version is one past the
  // current maximum.
  const nextVersion = latest ? latest.version + 1 : 1;

  // ---- 3. Persist the article ----
  // The spread of `payload` is safe: it contains exactly the
  // fields the schema expects for the caller-supplied portion
  // (topicId, content, wordCount), and no `userId` or `version`
  // field is present on the payload type. Both are added
  // explicitly here, from values this function controls.
  const doc = new ArticleModel({
    ...payload,
    userId,
    version: nextVersion,
  });

  return await doc.save();
};

// ============================================================
//  listArticles
// ============================================================

/**
 * List every article owned by the given user. If `topicId` is
 * provided, the result is narrowed to the articles attached to
 * that topic.
 *
 * Sort order depends on whether the query is topic-scoped:
 *
 *   - Topic-scoped (topicId provided): sorted by `version`
 *     descending, so the newest version appears first. This is
 *     the version-history view — a list of every regeneration a
 *     topic has produced, newest at the top. The compound index
 *     `{ userId, topicId, version: -1 }` covers both the filter
 *     and the sort without an in-memory stage.
 *
 *   - Cross-topic (topicId omitted): sorted by `createdAt`
 *     descending, so the most recently written article appears
 *     first across the user's entire collection. This is the
 *     dashboard view. The compound index
 *     `{ userId, createdAt: -1 }` covers it.
 *
 *   The two sort orders are not a design inconsistency — they
 *   reflect two different questions the client asks. Within a
 *   topic, "which is the latest version?" is naturally answered
 *   by version number; across topics, "what did I write most
 *   recently?" is naturally answered by timestamp. Both answers
 *   are what the corresponding UI views need.
 *
 * A `topicId` that does not belong to the caller returns an empty
 * list rather than a 404. See `documentService.ts` for the same
 * rationale — the list endpoint is a read-only projection, and
 * distinguishing "no articles under someone else's topic" from
 * "no articles under your own empty topic" would reopen the
 * enumeration channel the rest of the service closes.
 *
 * @param userId  - Ownership value.
 * @param topicId - Optional parent-topic filter.
 */
export const listArticles = async (
  userId: MongoId,
  topicId?: MongoId
): Promise<ArticleDocument[]> => {
  const filter: { userId: MongoId; topicId?: MongoId } = { userId };
  if (topicId !== undefined) {
    filter.topicId = topicId;
    // Topic-scoped: newest version first.
    return await ArticleModel.find(filter).sort({ version: -1 });
  }

  // Cross-topic: most recently written first.
  return await ArticleModel.find(filter).sort({ createdAt: -1 });
};

// ============================================================
//  getArticleById
// ============================================================

/**
 * Read a single article by id, scoped to the caller.
 *
 * Returns `null` when the article does not exist, OR when it
 * exists but belongs to a different user. The two cases are
 * intentionally indistinguishable — see the file header in
 * `documentService.ts` for the same enumeration-attack rationale
 * (which applies identically here).
 *
 * A malformed id string — one that is not a valid ObjectId — does
 * NOT return null; it causes Mongoose to throw a CastError, which
 * the terminal middleware maps to a 400.
 *
 * @param userId    - Ownership value.
 * @param articleId - The article's id, as a string from the route
 *                    parameter.
 */
export const getArticleById = async (
  userId: MongoId,
  articleId: string
): Promise<ArticleDocument | null> => {
  return await ArticleModel.findOne({ _id: articleId, userId });
};

// ============================================================
//  getLatestArticle
// ============================================================

/**
 * Read the current (highest-version) article for a topic, scoped
 * to the caller.
 *
 * Returns `null` when the topic has no articles yet, OR when the
 * topic does not exist, OR when the topic belongs to a different
 * user. The three cases collapse to the same null — the caller
 * (the topic-detail view, the validation runner) either has an
 * article to work with or it does not, and it has no use for the
 * distinction.
 *
 * This is a dedicated function rather than a `.slice(0)` on the
 * result of `listArticles(userId, topicId)` because:
 *
 *   1. The query is a single indexed findOne with an explicit
 *      sort — it terminates at the first matching document
 *      rather than fetching the entire version history and
 *      discarding all but one.
 *
 *   2. The name communicates intent. A future reader who sees
 *      `getLatestArticle(userId, topicId)` in a service method
 *      knows exactly what is being fetched; a reader who sees
 *      `listArticles(userId, topicId)[0]` has to reconstruct
 *      the intent from the surrounding context.
 *
 * The query is covered by the compound index
 * `{ userId, topicId, version: -1 }` — the filter matches on the
 * leftmost two fields, and the sort key is the trailing field.
 *
 * @param userId  - Ownership value.
 * @param topicId - The parent topic whose latest article is being
 *                  fetched.
 */
export const getLatestArticle = async (
  userId: MongoId,
  topicId: MongoId
): Promise<ArticleDocument | null> => {
  return await ArticleModel.findOne({ userId, topicId }).sort({
    version: -1,
  });
};

// ============================================================
//  updateArticleStatus
// ============================================================

/**
 * Transition an article's lifecycle status, scoped to the caller.
 *
 * This is the ONLY field that can be mutated in place on an
 * existing article — see the file header for why content is
 * immutable and why version history is appended, not edited.
 *
 * The function accepts any `ArticleStatus` value. It does NOT
 * enforce that the new status represents a legal transition from
 * the current one; the schema's enum restricts the value to the
 * closed set, and the callers (the validation runner and the
 * export handler) only advance forward in practice. See the file
 * header for why transition enforcement belongs at the service
 * level only if a future requirement demands it.
 *
 * Returns the updated document, so the caller can immediately
 * reflect the new status in its response without a second read.
 *
 * Throws `AppError(404)` when the article does not exist or is
 * not owned by the caller.
 *
 * @param userId    - Ownership value.
 * @param articleId - The article's id.
 * @param status    - The new lifecycle status.
 */
export const updateArticleStatus = async (
  userId: MongoId,
  articleId: string,
  status: ArticleStatus
): Promise<ArticleDocument> => {
  const updated = await ArticleModel.findOneAndUpdate(
    { _id: articleId, userId },
    { $set: { status } },
    { new: true, runValidators: true }
  );

  if (!updated) {
    throw new AppError('Article not found.', 404);
  }

  return updated;
};

// ============================================================
//  deleteArticle
// ============================================================

/**
 * Delete a single article by id, scoped to the caller.
 *
 * Returns the deleted document so the caller can cascade whatever
 * cleanup is appropriate (removing any Report that referenced the
 * article, for example — though the cascade itself is the
 * reports feature's responsibility, not this service's).
 *
 * Throws `AppError(404)` when the article does not exist or is
 * not owned by the caller. Same merged case as the read paths.
 *
 * @param userId    - Ownership value.
 * @param articleId - The article's id.
 */
export const deleteArticle = async (
  userId: MongoId,
  articleId: string
): Promise<ArticleDocument> => {
  const deleted = await ArticleModel.findOneAndDelete({
    _id: articleId,
    userId,
  });

  if (!deleted) {
    throw new AppError('Article not found.', 404);
  }

  return deleted;
};

// ============================================================
//  deleteArticlesByTopic
// ============================================================

/**
 * Bulk-delete every article attached to the given topic, scoped
 * to the caller.
 *
 * Returns the number of articles removed. A count of zero is a
 * legitimate, non-error result: it means either the topic has no
 * articles, or the topic does not exist, or the topic belongs to
 * a different user — the caller does not need to distinguish
 * those cases.
 *
 * The filter is scoped to `{ userId, topicId }`, not just
 * `topicId`. A caller who does not own the topic matches zero
 * records on the `userId` clause and therefore cannot clear
 * another user's topic by guessing its id.
 *
 * @param userId  - Ownership value.
 * @param topicId - The parent topic whose articles are being
 *                  removed.
 */
export const deleteArticlesByTopic = async (
  userId: MongoId,
  topicId: MongoId
): Promise<number> => {
  const result = await ArticleModel.deleteMany({ userId, topicId });
  return result.deletedCount;
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