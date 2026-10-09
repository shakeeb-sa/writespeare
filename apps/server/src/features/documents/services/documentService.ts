/**
 * Business logic for the WriteSpeare Document entity.
 *
 * A Document is one scraped source page attached to a Topic. The
 * service exposes five ownership-scoped operations, mirroring the
 * shape of `topicService.ts` so the two feature services read as
 * the same pattern:
 *
 *   createDocument          — persist a scraped document
 *   listDocuments           — read the user's documents, optionally
 *                             filtered by the parent topic
 *   getDocumentById         — read a single document
 *   deleteDocument          — remove a single document
 *   deleteDocumentsByTopic  — bulk-remove every document under a topic
 *
 * Every function takes a `userId` argument that the caller (the
 * controller) derives from `req.user.userId`. That value is never
 * read from the request body, query, or route params — the client
 * cannot choose whose documents they are reading or writing. This
 * is the same ownership contract that `topicService.ts` uses, and
 * for the same reason: a service call that trusted a client-
 * supplied `userId` would be a privilege-escalation vulnerability.
 *
 * Cross-feature import — TopicModel:
 *
 *   This service is the one place in the documents feature that
 *   imports from the topics feature. The dependency is real, not a
 *   smell: a Document's `topicId` field refers to a Topic, and the
 *   only way to guarantee the reference is valid AND that the
 *   caller is allowed to write to that topic is to look the topic
 *   up. Without the check, a client could submit a POST with any
 *   `topicId` — including one belonging to another user — and the
 *   document would be created with an inconsistent ownership pair
 *   (this user's `userId`, some other user's `topicId`). Rejecting
 *   that case with a 404 before the write is what keeps the
 *   collection's ownership invariants intact.
 *
 *   The import direction is child → parent, which is the only
 *   direction that makes sense for a hierarchical domain. A future
 *   change to the documents feature that required importing from,
 *   say, the articles feature would be the wrong direction and
 *   would be rejected — but the topics import is fundamental.
 *
 * Merged not-found / not-owned responses:
 *
 *   `getDocumentById` and `deleteDocument` return `null` (or throw
 *   a 404) when the document does not exist, AND for the case
 *   where it exists but belongs to a different user. The two cases
 *   are deliberately indistinguishable to the caller. A service
 *   that returned 403 for "exists but not yours" would let an
 *   authenticated attacker enumerate other users' document IDs by
 *   probing the endpoint and watching for the status code to
 *   change from 404 to 403. Merging the cases closes that channel.
 *
 * Immutability:
 *
 *   There is no `updateDocument` function. A Document represents
 *   a page that was fetched at a point in time; its url, title,
 *   content, and wordCount are historical facts, not editable
 *   state. If a user wants a different version of a page, the
 *   correct operation is to delete the old document and re-run
 *   extraction — the desktop client supports both from the
 *   document list. Adding an update path would invite exactly the
 *   kind of "which version is authoritative" ambiguity that the
 *   pipeline is designed to avoid.
 *
 * Cascade semantics:
 *
 *   `deleteDocumentsByTopic` exists so that a future cascade from
 *   topic deletion has a well-defined entry point. The current
 *   topic service does NOT call it — see the file header comment
 *   in `topicService.ts`, which explicitly notes that cascading is
 *   "a decision for each owning feature". Adding the function here
 *   now means the cascade is one call away when the decision is
 *   made, without requiring a later modification to this file.
 *
 *   The cascade is scoped to the caller's `userId`, not just to
 *   the `topicId`. If the topic belongs to another user, the
 *   deleteMany filter matches zero records and the function
 *   returns 0 rather than deleting anything. That is the correct
 *   behaviour: a caller who does not own the topic should not be
 *   able to clear the topic's documents by guessing its id.
 */

import { DocumentModel, type DocumentDocument } from '../models/Document.js';
import { TopicModel } from '../../topics/models/Topic.js';
import type {
  MongoId,
  DocumentCreatePayload,
} from '../../shared/types/index.js';
import { AppError } from '../../shared/middleware/errorHandler.js';

// ============================================================
//  createDocument
// ============================================================

/**
 * Persist a scraped document attached to a topic owned by the
 * caller.
 *
 * Flow:
 *
 *   1. Look up the parent topic by `(topicId, userId)`. The
 *      ownership check is part of the same query — a topic that
 *      exists but belongs to a different user is treated as "not
 *      found", which is what keeps this service from leaking
 *      other users' topic IDs through a 403.
 *
 *   2. If the topic does not exist or is not owned by the caller,
 *      throw `AppError(404)` with a message that refers to the
 *      topic, not to the document. The caller is trying to
 *      attach a document to a topic they cannot see; the correct
 *      diagnostic is "that topic does not exist (from your point
 *      of view)", not "that document does not exist" — the
 *      document has not been created yet.
 *
 *   3. Persist the document with the caller's `userId` and the
 *      supplied `topicId`. Every other field comes straight from
 *      the payload; the schema's validators are the authoritative
 *      check on shape (url parses, platform is a slug, title and
 *      content are non-empty, wordCount is a non-negative
 *      integer, fetchedAt is a Date).
 *
 *   4. Return the saved document.
 *
 * The function does NOT catch validation errors from the schema.
 * A Mongoose ValidationError thrown here — an invalid URL, a
 * negative wordCount, a title that is the empty string after
 * trim — propagates to the terminal error middleware, which maps
 * it to a 400 with the schema's own message. Duplicating those
 * checks in the service would create a second source of truth
 * that could drift from the schema.
 *
 * @param userId  - Ownership value, derived from the authenticated
 *                  session by the controller.
 * @param payload - The scraped document's metadata and body.
 *                  `userId` is NOT part of this payload by design;
 *                  see the file header.
 */
export const createDocument = async (
  userId: MongoId,
  payload: DocumentCreatePayload
): Promise<DocumentDocument> => {
  // ---- 1. Verify the parent topic exists and is owned by the caller ----
  const parentTopic = await TopicModel.findOne({
    _id: payload.topicId,
    userId,
  });

  if (!parentTopic) {
    // The two underlying cases — "no such topic" and "topic exists
    // but belongs to someone else" — collapse to the same 404. See
    // the file header for the enumeration-attack rationale.
    throw new AppError('Topic not found.', 404);
  }

  // ---- 2. Persist the document ----
  // The spread of `payload` is safe: it contains exactly the
  // fields the schema expects (topicId, url, platform, title,
  // content, wordCount, fetchedAt), and no field named `userId`
  // exists on the payload type — the compiler would reject an
  // attempt to pass one through. The `userId` field is added
  // explicitly from the caller-supplied argument, which is the
  // only source of truth for ownership in this function.
  const doc = new DocumentModel({
    ...payload,
    userId,
  });

  return await doc.save();
};

// ============================================================
//  listDocuments
// ============================================================

/**
 * List every document owned by the given user, newest first. If
 * `topicId` is provided, the result is narrowed to the documents
 * attached to that topic.
 *
 * The two read shapes this function serves:
 *
 *   - "list documents for topic X" — the default view in the
 *     documents feature. Pass the topic's id as `topicId`.
 *
 *   - "list all my documents" — the cross-topic view. Omit the
 *     `topicId` argument.
 *
 * A `topicId` that does not belong to the caller returns an empty
 * list rather than a 404. That is deliberate: the list endpoint
 * is a read-only projection, and returning 404 for "no documents
 * under a topic that isn't yours" versus 200-with-empty-list for
 * "no documents under a topic that is yours but has none yet"
 * would reintroduce the enumeration channel that the rest of the
 * service closes.
 *
 * Sort is `createdAt: -1` — newest first, matching the default
 * view the documents feature renders. Both compound indexes on
 * the Document schema include `createdAt: -1` as their sort key,
 * so this query is index-covered regardless of whether `topicId`
 * is present.
 *
 * @param userId  - Ownership value.
 * @param topicId - Optional parent-topic filter.
 */
export const listDocuments = async (
  userId: MongoId,
  topicId?: MongoId
): Promise<DocumentDocument[]> => {
  const filter: { userId: MongoId; topicId?: MongoId } = { userId };
  if (topicId !== undefined) {
    filter.topicId = topicId;
  }

  return await DocumentModel.find(filter).sort({ createdAt: -1 });
};

// ============================================================
//  getDocumentById
// ============================================================

/**
 * Read a single document by id, scoped to the caller.
 *
 * Returns `null` when the document does not exist, OR when it
 * exists but belongs to a different user. The two cases are
 * intentionally indistinguishable — see the file header.
 *
 * The caller (the controller) converts the null into a 404. A
 * malformed id string — one that is not a valid ObjectId — does
 * NOT return null; it causes Mongoose to throw a CastError, which
 * the terminal middleware maps to a 400. That distinction is
 * correct: "the id is not a valid identifier" is a client error,
 * not a "document not found" case.
 *
 * @param userId     - Ownership value.
 * @param documentId - The document's id, as a string from the
 *                     route parameter.
 */
export const getDocumentById = async (
  userId: MongoId,
  documentId: string
): Promise<DocumentDocument | null> => {
  return await DocumentModel.findOne({ _id: documentId, userId });
};

// ============================================================
//  deleteDocument
// ============================================================

/**
 * Delete a single document by id, scoped to the caller.
 *
 * Returns the deleted document so the caller can cascade whatever
 * cleanup it needs (removing the corresponding `.md` file from
 * disk, clearing a cached reference in a store, etc.). The service
 * itself does NOT touch the filesystem — the backend has no
 * knowledge of where the desktop client stores its source files,
 * and coupling the two would violate the "Python writes files,
 * backend stores metadata" boundary.
 *
 * Throws `AppError(404)` when the document does not exist or is
 * not owned by the caller. Same merge as `getDocumentById`.
 *
 * @param userId     - Ownership value.
 * @param documentId - The document's id.
 */
export const deleteDocument = async (
  userId: MongoId,
  documentId: string
): Promise<DocumentDocument> => {
  const deleted = await DocumentModel.findOneAndDelete({
    _id: documentId,
    userId,
  });

  if (!deleted) {
    throw new AppError('Document not found.', 404);
  }

  return deleted;
};

// ============================================================
//  deleteDocumentsByTopic
// ============================================================

/**
 * Bulk-delete every document attached to the given topic, scoped
 * to the caller.
 *
 * Returns the number of documents that were deleted. A count of
 * zero is a legitimate, non-error result: it means either the
 * topic has no documents, or the topic does not exist, or the
 * topic belongs to a different user. The caller does not need to
 * distinguish those cases — if it wants to verify topic ownership
 * first, it already has `getTopicById` to do so.
 *
 * The filter is scoped to `{ userId, topicId }`, not just
 * `topicId`. A caller who does not own the topic matches zero
 * records on the `userId` clause and therefore cannot clear
 * another user's topic by guessing its id. That is the
 * authorization guarantee this function provides — see the
 * file header for the cascade-context discussion.
 *
 * @param userId  - Ownership value.
 * @param topicId - The parent topic whose documents are being
 *                  removed.
 */
export const deleteDocumentsByTopic = async (
  userId: MongoId,
  topicId: MongoId
): Promise<number> => {
  const result = await DocumentModel.deleteMany({ userId, topicId });
  return result.deletedCount;
};

// ============================================================
//  Default export
// ============================================================

export default {
  createDocument,
  listDocuments,
  getDocumentById,
  deleteDocument,
  deleteDocumentsByTopic,
};