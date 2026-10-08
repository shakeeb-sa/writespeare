/**
 * Business logic for the WriteSpeare Topic entity.
 *
 * Five CRUD operations, each ownership-scoped. See the file
 * header in the source repository for the design rationale.
 */

import { TopicModel, type TopicDocument } from '../models/Topic.js';
import type {
  MongoId,
  TopicStatus,
  TopicCreatePayload,
  TopicUpdatePayload,
} from '../../shared/types/index.js';
import { AppError } from '../../shared/middleware/errorHandler.js';

// ============================================================
//  createTopic
// ============================================================

/**
 * Create a new topic owned by the given user.
 *
 * The `userId` is supplied by the caller (the controller extracts
 * it from `req.user.userId`), never by the request payload. That
 * is what makes it impossible for a client to create a topic on
 * behalf of another user: the ownership field is set from the
 * authenticated session, not from anything the client controls.
 *
 * Defaults for optional fields (preset, profile, promptFile,
 * wordCount, sourceCount, status) are applied by the schema, not
 * here. Passing an explicit `undefined` would violate
 * `exactOptionalPropertyTypes`, so the function conditionally
 * spreads only the fields the caller actually provided.
 *
 * Throws `AppError(400)` for an empty title (the schema's
 * `minlength: 3` also catches this, but doing it here produces a
 * clearer message than the Mongoose ValidationError's first-error
 * extraction). Any other validation failure — a bad preset, a
 * non-integer wordCount — propagates from the schema as a
 * Mongoose ValidationError, which the terminal middleware maps
 * to a 400.
 */
export const createTopic = async (
  userId: MongoId,
  payload: TopicCreatePayload
): Promise<TopicDocument> => {
  const trimmedTitle = payload.title.trim();
  if (trimmedTitle.length < 3) {
    throw new AppError(
      'Title must be at least 3 characters.',
      400
    );
  }

  const doc = new TopicModel({
    userId,
    title: trimmedTitle,
    ...(payload.keywords !== undefined
      ? { keywords: payload.keywords }
      : {}),
    ...(payload.preset !== undefined ? { preset: payload.preset } : {}),
    ...(payload.profile !== undefined ? { profile: payload.profile } : {}),
    ...(payload.promptFile !== undefined
      ? { promptFile: payload.promptFile.trim() }
      : {}),
    ...(payload.wordCount !== undefined
      ? { wordCount: payload.wordCount }
      : {}),
    ...(payload.sourceCount !== undefined
      ? { sourceCount: payload.sourceCount }
      : {}),
  });

  return await doc.save();
};

// ============================================================
//  listTopics
// ============================================================

/**
 * List every topic owned by the given user, sorted newest first.
 *
 * The optional `statusFilter` narrows the result to a single
 * pipeline state. It is a separate argument rather than a field on
 * a filter object because the service currently supports exactly
 * one filter dimension; a future addition (e.g. preset filter)
 * would arrive as a second argument, at which point the signature
 * changes to accept a filter object. Until then, the flat form is
 * the honest one.
 *
 * The sort is `createdAt: -1` — newest first, matching the
 * default view the Topics page renders. The index
 * `{ userId: 1, createdAt: -1 }` on the schema serves this query
 * without an in-memory sort stage.
 */
export const listTopics = async (
  userId: MongoId,
  statusFilter?: TopicStatus
): Promise<TopicDocument[]> => {
  const filter: { userId: MongoId; status?: TopicStatus } = { userId };
  if (statusFilter !== undefined) {
    filter.status = statusFilter;
  }

  return await TopicModel.find(filter).sort({ createdAt: -1 });
};

// ============================================================
//  getTopicById
// ============================================================

/**
 * Read a single topic by ID, scoped to the requesting user.
 *
 * Returns `null` when no topic with that ID exists OR when the
 * topic exists but belongs to a different user. The two cases are
 * deliberately indistinguishable from this function's return
 * value. A caller (the controller) converts the null into a 404,
 * never a 403, so an authenticated user cannot enumerate other
 * users' topic IDs by probing the endpoint and watching for the
 * status code to change.
 *
 * A malformed `topicId` string (not a valid ObjectId) causes
 * Mongoose's `findOne` to throw a CastError, which the terminal
 * middleware maps to a 400. That is the correct distinction:
 * "the ID is not a valid identifier" is a client error, not a
 * "topic not found" case.
 */
export const getTopicById = async (
  userId: MongoId,
  topicId: string
): Promise<TopicDocument | null> => {
  return await TopicModel.findOne({ _id: topicId, userId });
};

// ============================================================
//  updateTopic
// ============================================================

/**
 * Apply a partial update to a topic, scoped to the requesting
 * user.
 *
 * Only the fields present in the patch are modified. Fields
 * omitted from the patch are left unchanged on the document.
 * Fields passed as `null` are not currently supported — the
 * schema does not use `null` as a sentinel for any field, and
 * clearing a field is achieved by omitting it or by passing an
 * empty value of the field's type (an empty string for string
 * fields, an empty array for the keywords list).
 *
 * One business rule lives here rather than in the schema: when
 * `status` is being changed to anything other than `'failed'`,
 * the `error` field is unset. A topic whose status is
 * `'researching'` must not carry a stale failure message from a
 * previous attempt — the two together would be misleading in the
 * Topics list, and the pipeline only sets the error field
 * immediately before setting `status: 'failed'`.
 *
 * The reverse is not automated: if `patch.status === 'failed'`
 * and `patch.error` is not provided, the error field is left as
 * it was. The schema permits a failed topic with no error string,
 * and the pipeline may set the error in a follow-up write.
 *
 * Throws `AppError(404)` when the topic does not exist or is not
 * owned by the requesting user. The two cases are merged for the
 * same reason as in `getTopicById`.
 */
export const updateTopic = async (
  userId: MongoId,
  topicId: string,
  patch: TopicUpdatePayload
): Promise<TopicDocument> => {
  // Build the $set and $unset operations separately. Fields that
  // are being set go into $set; the `error` field being cleared
  // goes into $unset. Mixing the two into a single $set with an
  // empty-string value would leave a non-undefined `error` in the
  // document, which is not the same as the field being absent and
  // which would surface as `error: ''` in any code that checks
  // `'error' in topic`.
  const setFields: Record<string, unknown> = {};
  const unsetFields: Record<string, 1> = {};

  if (patch.title !== undefined) {
    const trimmedTitle = patch.title.trim();
    if (trimmedTitle.length < 3) {
      throw new AppError('Title must be at least 3 characters.', 400);
    }
    setFields['title'] = trimmedTitle;
  }

  if (patch.keywords !== undefined) {
    setFields['keywords'] = patch.keywords;
  }

  if (patch.preset !== undefined) {
    setFields['preset'] = patch.preset;
  }

  if (patch.profile !== undefined) {
    setFields['profile'] = patch.profile;
  }

  if (patch.promptFile !== undefined) {
    setFields['promptFile'] = patch.promptFile.trim();
  }

  if (patch.wordCount !== undefined) {
    setFields['wordCount'] = patch.wordCount;
  }

  if (patch.sourceCount !== undefined) {
    setFields['sourceCount'] = patch.sourceCount;
  }

  if (patch.status !== undefined) {
    setFields['status'] = patch.status;

    // Status moved away from 'failed' — clear any stale error.
    // Status moved TO 'failed' — only overwrite the error if the
    // caller supplied one; otherwise leave the existing message
    // in place (the schema permits a failed topic with no error
    // string, and a caller that sets 'failed' without an error
    // may set it in a follow-up write).
    if (patch.status !== 'failed') {
      unsetFields['error'] = 1;
    } else if (patch.error !== undefined) {
      setFields['error'] = patch.error;
    }
  } else if (patch.error !== undefined) {
    // Status is not being changed, but the caller is supplying an
    // error. This is a legitimate write — a caller that wants to
    // annotate an existing failed topic with a better message.
    setFields['error'] = patch.error;
  }

  // If the patch contains no actionable fields, return the
  // current document unchanged. This is more honest than issuing
  // an empty $set and returning whatever Mongoose decides.
  if (
    Object.keys(setFields).length === 0 &&
    Object.keys(unsetFields).length === 0
  ) {
    const existing = await TopicModel.findOne({ _id: topicId, userId });
    if (!existing) {
      throw new AppError('Topic not found.', 404);
    }
    return existing;
  }

  const updateOps: Record<string, Record<string, unknown>> = {};
  if (Object.keys(setFields).length > 0) {
    updateOps['$set'] = setFields;
  }
  if (Object.keys(unsetFields).length > 0) {
    updateOps['$unset'] = unsetFields;
  }

  const updated = await TopicModel.findOneAndUpdate(
    { _id: topicId, userId },
    updateOps,
    { new: true, runValidators: true }
  );

  if (!updated) {
    throw new AppError('Topic not found.', 404);
  }

  return updated;
};

// ============================================================
//  deleteTopic
// ============================================================

/**
 * Delete a topic, scoped to the requesting user.
 *
 * Returns the deleted document so the caller can cascade the
 * deletion (removing the topic's Documents, Articles, and Reports
 * if the pipeline stages that own them decide to do so). The
 * service does NOT cascade the delete itself — that is a decision
 * for each owning feature, and keeping it out of this function
 * means a future change to the cascade rules does not require
 * touching the topic service.
 *
 * Throws `AppError(404)` when the topic does not exist or is not
 * owned by the requesting user. Same merge as the other
 * ownership-scoped operations.
 */
export const deleteTopic = async (
  userId: MongoId,
  topicId: string
): Promise<TopicDocument> => {
  const deleted = await TopicModel.findOneAndDelete({
    _id: topicId,
    userId,
  });

  if (!deleted) {
    throw new AppError('Topic not found.', 404);
  }

  return deleted;
};

// ============================================================
//  Default export
// ============================================================

export default {
  createTopic,
  listTopics,
  getTopicById,
  updateTopic,
  deleteTopic,
};