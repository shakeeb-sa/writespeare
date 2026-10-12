/**
 * HTTP handlers for the WriteSpeare Topic entity.
 *
 * Thin request/response layer over `topicService`. Each handler
 * performs exactly four jobs and nothing else:
 *
 *   1. Read the authenticated user's ID from `req.user.userId`
 *      and reject the request with a 401 if it is absent. Every
 *      ownership-scoped operation in WriteSpeare keys off this
 *      value; a handler that is reached without an authenticated
 *      session would either crash on a null dereference or — far
 *      worse — silently operate on the wrong user's data.
 *      `authenticate` on the route layer is the primary gate;
 *      this check is the belt-and-braces guard against a route
 *      that is misconfigured in a future refactor.
 *
 *   2. Validate the shape of the request body / query / params
 *      just enough to reject requests that are so malformed the
 *      service would produce a confusing error. The schema (in
 *      `topics/models/Topic.ts`) remains the authoritative
 *      validator for everything subtler — preset values, numeric
 *      ranges, integer constraints, keyword element types are
 *      all checked there, and a Mongoose ValidationError is
 *      translated to a 400 by the terminal error middleware.
 *      Doing anything more in the controller would duplicate the
 *      schema's rules and eventually drift from them.
 *
 *   3. Delegate to the service. The controller never touches the
 *      database directly — it does not import the Topic model,
 *      does not build queries, and does not know what collection
 *      the data lives in. That is the service's job. A future
 *      change to how topics are stored (a migration to a new
 *      collection, a caching layer, a sharding strategy) must
 *      not require touching this file.
 *
 *   4. Format the success response using the shared `ApiResponse`
 *      envelope. Every response — success or failure — uses the
 *      same shape, so a client can unwrap it uniformly.
 *
 * No try/catch appears anywhere in this file. That is deliberate.
 * Each route handler is wrapped in `asyncHandler` at the route
 * registration site, which forwards any rejection to the terminal
 * error middleware. The middleware recognises the shared `AppError`
 * class thrown by the service, honours its status code, and
 * formats the response with the same envelope this file uses on
 * success. Putting a try/catch here would duplicate the
 * middleware's classification logic and split the error-handling
 * contract across two files.
 *
 * Response typing:
 *
 *   Every handler declares its `Response<T>` type explicitly. On
 *   success the service returns a `TopicDocument` (Mongoose's
 *   in-process shape) which is structurally assignable to the
 *   shared `Topic` domain type — the only difference is that
 *   `TopicDocument._id` is a concrete `ObjectId` while `Topic._id`
 *   is `string | ObjectId`. Since `ObjectId` is a member of the
 *   union, the assignment is safe and the response type can be
 *   declared as the domain type. At runtime, `res.json()`
 *   serialises the ObjectId to its hex string form, which is
 *   exactly what the client's `Topic` interface expects.
 *
 * Ownership scoping:
 *
 *   The `userId` passed to the service is ALWAYS derived from the
 *   authenticated session — `req.user.userId` — and NEVER read
 *   from the request body or query. This is what makes it
 *   impossible for a client to create a topic on behalf of another
 *   user: the ownership field is set from the token, not from
 *   anything the client controls. A service call that used a
 *   client-supplied `userId` would be a privilege-escalation
 *   vulnerability; the controller's job is to make that mistake
 *   impossible by construction.
 *
 * Closed-set validation:
 *
 *   The `Topic` domain has three closed-set fields — `preset`,
 *   `profile`, and `status` — whose runtime-legal values are
 *   declared as union types in `shared/types` and mirrored by
 *   `enum` arrays in `topics/models/Topic.ts`. The controller
 *   needs its own copy of those arrays to validate incoming
 *   requests before delegating, and it declares them locally
 *   rather than re-exporting the schema's private constants so
 *   that the model file's exports remain exactly what its header
 *   declares (it exports `TopicModel` and `TopicDocument`, not
 *   the internal value arrays). The arrays are typed as
 *   `readonly PresetName[]` etc., which gives a compile-time
 *   guarantee that every string in the array is a legal member of
 *   the union; a typo would be a type error, not a silent
 *   runtime surprise.
 */

import type { Response } from 'express';

import {
  createTopic as createTopicService,
  listTopics as listTopicsService,
  getTopicById as getTopicByIdService,
  updateTopic as updateTopicService,
  deleteTopic as deleteTopicService,
} from '../services/topicService.js';

import type { AuthRequest } from '../../auth/middleware/authGuard.js';
import type {
  ApiResponse,
  Topic,
  TopicStatus,
  TopicCreatePayload,
  TopicUpdatePayload,
  PresetName,
  ProfileName,
} from '../../shared/types/index.js';

// ============================================================
//  Runtime legal-value tables
// ============================================================
//
// Each array is annotated with the corresponding union type,
// which gives a compile-time guarantee that every string is a
// legal member. A typo such as 'balenced' would be flagged by the
// compiler — the one class of drift this pattern is designed to
// catch. What the annotation does NOT catch is a union member
// that is missing from the array (a new status added to the union
// in `shared/types` without a corresponding array update); that
// has to be caught by a reviewer or by an integration test that
// exercises every legal value.

const PRESET_VALUES: readonly PresetName[] = [
  'quick',
  'balanced',
  'deep',
  'custom',
];

const PROFILE_VALUES: readonly ProfileName[] = [
  'blog-post',
  'news-article',
  'product-review',
  'academic',
];

const TOPIC_STATUS_VALUES: readonly TopicStatus[] = [
  'draft',
  'researching',
  'extracting',
  'extracted',
  'writing',
  'validating',
  'completed',
  'failed',
];

// ============================================================
//  Runtime type guards
// ============================================================
//
// Small, single-purpose predicates. They exist so the handler
// bodies read as a sequence of `if (isX(value))` checks rather
// than as an interleaved mix of shape checks and value checks.

/**
 * Narrow `unknown` to one of the three legal preset names.
 *
 * The cast to `readonly string[]` before `.includes` is required
 * because `Array.prototype.includes` on a `readonly PresetName[]`
 * expects a `PresetName` argument, and we deliberately want to
 * check an arbitrary unknown value against the array. The cast
 * does not weaken the runtime check — the array still contains
 * exactly the preset strings — it just tells the compiler that a
 * wider comparison is intentional here.
 */
const isPresetName = (value: unknown): value is PresetName =>
  typeof value === 'string' &&
  (PRESET_VALUES as readonly string[]).includes(value);

/**
 * Narrow `unknown` to one of the four legal profile names.
 */
const isProfileName = (value: unknown): value is ProfileName =>
  typeof value === 'string' &&
  (PROFILE_VALUES as readonly string[]).includes(value);

/**
 * Narrow `unknown` to one of the eight legal topic statuses.
 */
const isTopicStatus = (value: unknown): value is TopicStatus =>
  typeof value === 'string' &&
  (TOPIC_STATUS_VALUES as readonly string[]).includes(value);

/**
 * Narrow `unknown` to a `string[]`.
 *
 * Checks both that the value is an array AND that every element
 * is a string. The element check is what the `Array.isArray`
 * guard alone would miss: `[1, 2, 3]` passes `Array.isArray` but
 * cannot be assigned to `string[]` without a cast. Checking the
 * elements keeps the guard honest and lets the compiler narrow
 * the result correctly.
 */
const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.every((item) => typeof item === 'string');

  /**
 * The four time-range buckets a topic's search distribution is
 * expressed as.
 *
 * Derived from `TopicCreatePayload['searchBuckets']` so the local
 * shape cannot drift from the shape the shared types module
 * declares. The `NonNullable<...>` wrapper is required because
 * the field is optional on both `TopicCreatePayload` and
 * `TopicUpdatePayload` — the handler only reaches this type after
 * the request has supplied the field, so the `undefined` arm of
 * the union is not relevant at that point.
 *
 * The same alias is declared (locally, for the same reason) in
 * `settingsService.ts` and `adminController.ts`. All three
 * declarations derive from their own feature's payload type, so
 * they cannot silently disagree: if the shared declaration of the
 * bucket-layout shape ever changes, every one of the three
 * breaks at compile time on the same edit.
 */
type BucketLayout = NonNullable<
  TopicCreatePayload['searchBuckets']
>;

/**
 * Narrow `unknown` to a `BucketLayout`.
 *
 * Checks that the value is a plain object — not null, not an
 * array — and that all four required fields are finite numbers.
 * Does NOT check numeric ranges or integer-ness; the Topic
 * schema's `SearchBucketsSchema` validators are authoritative on
 * those, and its Mongoose ValidationError is translated to a 400
 * by the terminal middleware. The controller only confirms that
 * the shape is right before the value reaches the service.
 *
 * The predicate follows `isStringArray` in the file's guard
 * order, matching the "compound of primitives" convention the
 * runtime type guards section documents.
 */
const isBucketLayout = (value: unknown): value is BucketLayout => {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value)
  ) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    typeof v['anyTime'] === 'number' &&
    Number.isFinite(v['anyTime']) &&
    typeof v['pastYear'] === 'number' &&
    Number.isFinite(v['pastYear']) &&
    typeof v['pastMonth'] === 'number' &&
    Number.isFinite(v['pastMonth']) &&
    typeof v['pastWeek'] === 'number' &&
    Number.isFinite(v['pastWeek'])
  );
};

// ============================================================
//  POST /api/topics
// ============================================================

/**
 * Create a new topic owned by the authenticated user.
 *
 * Flow:
 *
 *   1. Reject with 401 if no authenticated user is attached.
 *   2. Reject with 400 if the request body is not a plain
 *      object — a null, an array, or a primitive would all
 *      produce confusing service errors otherwise.
 *   3. Require a non-empty `title` (after trim). Missing or
 *      whitespace-only titles are the single most likely client
 *      mistake, and the schema's `minlength: 3` would produce a
 *      less-specific error message than the explicit check here.
 *   4. For every optional field, validate its type or
 *      closed-set membership. An invalid optional field is
 *      rejected with a 400 rather than silently dropped — the
 *      caller asked for something the API cannot deliver, and
 *      telling them is more honest than pretending the request
 *      succeeded with a different shape.
 *   5. Delegate to the service. The service applies defaults for
 *      any field the payload omits.
 *   6. Respond with 201 Created and the persisted topic.
 *
 * The `userId` argument to the service is derived from the
 * authenticated session. It is never read from the body, even if
 * the body happens to contain a `userId` field — any client-
 * supplied ownership value is ignored, not trusted.
 */
export const createTopic = async (
  req: AuthRequest,
  res: Response<ApiResponse<Topic>>
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
  // `req.body` is typed `any` by Express's default generics. The
  // cast to `unknown` here is not cosmetic — it forces every
  // subsequent access to go through an explicit narrowing step,
  // which is what keeps a runtime-invalid value from silently
  // propagating into the payload below.
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

  // ---- 3. Required field: title ----
  const title = body['title'];
  if (typeof title !== 'string' || title.trim().length === 0) {
    res.status(400).json({
      success: false,
      error: 'Title is required.',
    });
    return;
  }

  // ---- 4. Optional fields ----
  // Build the payload incrementally. Each field is added only if
  // the caller supplied it AND it passes validation. `exactOptionalPropertyTypes`
  // makes the incremental form necessary: assigning `undefined`
  // to an optional field would be a type error, so we cannot use
  // the pattern `payload.keywords = body['keywords'] ?? undefined`
  // — the field must either be assigned a concrete value or left
  // entirely unset.
  const payload: TopicCreatePayload = { title };

  const keywords = body['keywords'];
  if (keywords !== undefined) {
    if (!isStringArray(keywords)) {
      res.status(400).json({
        success: false,
        error: 'keywords must be an array of strings.',
      });
      return;
    }
    payload.keywords = keywords;
  }

  const preset = body['preset'];
  if (preset !== undefined) {
    if (!isPresetName(preset)) {
      res.status(400).json({
        success: false,
        error: `preset must be one of: ${PRESET_VALUES.join(', ')}.`,
      });
      return;
    }
    payload.preset = preset;
  }

  const profile = body['profile'];
  if (profile !== undefined) {
    if (!isProfileName(profile)) {
      res.status(400).json({
        success: false,
        error: `profile must be one of: ${PROFILE_VALUES.join(', ')}.`,
      });
      return;
    }
    payload.profile = profile;
  }

  const promptFile = body['promptFile'];
  if (promptFile !== undefined) {
    if (typeof promptFile !== 'string') {
      res.status(400).json({
        success: false,
        error: 'promptFile must be a string.',
      });
      return;
    }
    payload.promptFile = promptFile;
  }

  const wordCount = body['wordCount'];
  if (wordCount !== undefined) {
    if (typeof wordCount !== 'number') {
      res.status(400).json({
        success: false,
        error: 'wordCount must be a number.',
      });
      return;
    }
    payload.wordCount = wordCount;
  }

  const searchBuckets = body['searchBuckets'];
  if (searchBuckets !== undefined) {
    if (!isBucketLayout(searchBuckets)) {
      res.status(400).json({
        success: false,
        error:
          'searchBuckets must be an object with anyTime, ' +
          'pastYear, pastMonth, and pastWeek as numbers.',
      });
      return;
    }
    payload.searchBuckets = searchBuckets;
  }

  const sourceCount = body['sourceCount'];
  if (sourceCount !== undefined) {
    if (typeof sourceCount !== 'number') {
      res.status(400).json({
        success: false,
        error: 'sourceCount must be a number.',
      });
      return;
    }
    payload.sourceCount = sourceCount;
  }

  // ---- 5. Delegate to the service ----
  // Any failure thrown by the service — an `AppError` for a
  // known case, a Mongoose ValidationError for a schema-level
  // violation — propagates out of this function and is forwarded
  // by the asyncHandler wrapper to the terminal error middleware.
  const topic = await createTopicService(userId, payload);

  // ---- 6. Respond ----
  res.status(201).json({
    success: true,
    data: topic,
  });
};

// ============================================================
//  GET /api/topics
// ============================================================

/**
 * List every topic owned by the authenticated user, sorted newest
 * first. An optional `?status=` query parameter narrows the
 * result to a single pipeline state.
 *
 * Flow:
 *
 *   1. Reject with 401 if no authenticated user is attached.
 *   2. If a `?status=` query parameter is present, validate it
 *      against the closed set. An unknown status is a 400 — a
 *      typo like `?status=writingg` should not silently return
 *      an empty list, because an empty list and a filtered list
 *      look identical to the client.
 *   3. Delegate to the service, passing `undefined` when no
 *      filter was provided so the service's own default branch
 *      (no filter) runs.
 *
 * The `userId` argument is derived from the authenticated
 * session. A client cannot list another user's topics by adding
 * a `userId` query parameter — the parameter is not read.
 */
export const listTopics = async (
  req: AuthRequest,
  res: Response<ApiResponse<Topic[]>>
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

  // ---- 2. Optional status filter ----
  // `req.query['status']` is typed `string | ParsedQs | (string | ParsedQs)[] | undefined`
  // under Express's default generics. The check narrows it to a
  // `TopicStatus` before it is passed to the service. A repeated
  // query parameter (`?status=a&status=b`) arrives as an array,
  // which fails the `typeof !== 'string'` check and is rejected
  // with a 400 — the correct behaviour, since the API accepts
  // exactly one status filter per request.
  const rawStatus = req.query['status'];
  let statusFilter: TopicStatus | undefined;
  if (rawStatus !== undefined) {
    if (typeof rawStatus !== 'string' || !isTopicStatus(rawStatus)) {
      res.status(400).json({
        success: false,
        error: `Invalid status filter. Must be one of: ${TOPIC_STATUS_VALUES.join(', ')}.`,
      });
      return;
    }
    statusFilter = rawStatus;
  }

  // ---- 3. Delegate to the service ----
  // Passing an explicit `undefined` for the optional parameter is
  // safe — TypeScript's `exactOptionalPropertyTypes` flag applies
  // to object properties, not to function parameters. The service
  // treats `undefined` as "no filter" and skips adding a status
  // clause to the query.
  const topics = await listTopicsService(userId, statusFilter);

  res.status(200).json({
    success: true,
    data: topics,
  });
};

// ============================================================
//  GET /api/topics/:id
// ============================================================

/**
 * Return a single topic by its ID, scoped to the authenticated
 * user.
 *
 * Flow:
 *
 *   1. Reject with 401 if no authenticated user is attached.
 *   2. Reject with 400 if the `:id` route parameter is missing
 *      or empty. A malformed ID that is present but not a valid
 *      ObjectId is not rejected here — the service's `findOne`
 *      throws a CastError, which the terminal middleware maps to
 *      a 400. Letting the driver decide what constitutes a valid
 *      ID keeps the definition of "valid identifier" in one
 *      place.
 *   3. Delegate to the service. A null result means either "no
 *      such topic" or "topic belongs to a different user" — the
 *      service deliberately does not distinguish the two, and
 *      this handler returns 404 for both. Returning 403 for the
 *      "belongs to someone else" case would leak the existence
 *      of other users' topic IDs to an authenticated attacker
 *      probing the endpoint.
 *   4. Respond with 200 and the topic, or 404 if it was not
 *      found / not owned.
 */
export const getTopicById = async (
  req: AuthRequest,
  res: Response<ApiResponse<Topic>>
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
  // `req.params` on the unparameterized `AuthRequest` is typed as
  // `ParamsDictionary = { [key: string]: string }`. Under
  // `noUncheckedIndexedAccess`, the bracket access yields
  // `string | undefined` — the check below narrows it.
  const topicId = req.params['id'];
  if (typeof topicId !== 'string' || topicId.length === 0) {
    res.status(400).json({
      success: false,
      error: 'Topic ID is required.',
    });
    return;
  }

  // ---- 3. Delegate to the service ----
  const topic = await getTopicByIdService(userId, topicId);
  if (!topic) {
    res.status(404).json({
      success: false,
      error: 'Topic not found.',
    });
    return;
  }

  // ---- 4. Respond ----
  res.status(200).json({
    success: true,
    data: topic,
  });
};

// ============================================================
//  PATCH /api/topics/:id
// ============================================================

/**
 * Apply a partial update to a topic, scoped to the authenticated
 * user.
 *
 * Flow:
 *
 *   1. Reject with 401 if no authenticated user is attached.
 *   2. Reject with 400 if the `:id` route parameter is missing
 *      or empty.
 *   3. Reject with 400 if the request body is not a plain
 *      object. A PATCH with an empty body (`{}`) is NOT rejected
 *      — the controller builds an empty patch, the service
 *      short-circuits and returns the existing document
 *      unchanged. That is the correct behaviour for a
 *      semantically empty update: succeed without modifying
 *      anything.
 *   4. For every field present in the body, validate its type or
 *      closed-set membership, and add it to the patch. A field
 *      that is present but invalid is rejected with a 400 rather
 *      than silently dropped — a client that asks to set
 *      `wordCount` to a string has made a mistake and should
 *      hear about it.
 *   5. Delegate to the service, which performs the merge. The
 *      service owns the one piece of business logic in this
 *      flow — unsetting the `error` field when `status` moves
 *      away from `'failed'` — so the controller does not have
 *      to know that rule.
 *   6. Respond with 200 and the updated topic.
 */
export const updateTopic = async (
  req: AuthRequest,
  res: Response<ApiResponse<Topic>>
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
  const topicId = req.params['id'];
  if (typeof topicId !== 'string' || topicId.length === 0) {
    res.status(400).json({
      success: false,
      error: 'Topic ID is required.',
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

  // ---- 4. Build the patch ----
  // Fields are added to the patch only when they are present in
  // the request body AND pass validation. Absent fields leave
  // the corresponding document field untouched, which is the
  // whole point of PATCH. A field present but of the wrong type
  // aborts the whole request with a 400 — partial application
  // would leave the document in a state the client did not ask
  // for, which is worse than no change at all.
  const patch: TopicUpdatePayload = {};

  const title = body['title'];
  if (title !== undefined) {
    if (typeof title !== 'string') {
      res.status(400).json({
        success: false,
        error: 'title must be a string.',
      });
      return;
    }
    patch.title = title;
  }

  const keywords = body['keywords'];
  if (keywords !== undefined) {
    if (!isStringArray(keywords)) {
      res.status(400).json({
        success: false,
        error: 'keywords must be an array of strings.',
      });
      return;
    }
    patch.keywords = keywords;
  }

  const preset = body['preset'];
  if (preset !== undefined) {
    if (!isPresetName(preset)) {
      res.status(400).json({
        success: false,
        error: `preset must be one of: ${PRESET_VALUES.join(', ')}.`,
      });
      return;
    }
    patch.preset = preset;
  }

  const profile = body['profile'];
  if (profile !== undefined) {
    if (!isProfileName(profile)) {
      res.status(400).json({
        success: false,
        error: `profile must be one of: ${PROFILE_VALUES.join(', ')}.`,
      });
      return;
    }
    patch.profile = profile;
  }

  const promptFile = body['promptFile'];
  if (promptFile !== undefined) {
    if (typeof promptFile !== 'string') {
      res.status(400).json({
        success: false,
        error: 'promptFile must be a string.',
      });
      return;
    }
    patch.promptFile = promptFile;
  }

  const wordCount = body['wordCount'];
  if (wordCount !== undefined) {
    if (typeof wordCount !== 'number') {
      res.status(400).json({
        success: false,
        error: 'wordCount must be a number.',
      });
      return;
    }
    patch.wordCount = wordCount;
  }

  const searchBuckets = body['searchBuckets'];
  if (searchBuckets !== undefined) {
    if (!isBucketLayout(searchBuckets)) {
      res.status(400).json({
        success: false,
        error:
          'searchBuckets must be an object with anyTime, ' +
          'pastYear, pastMonth, and pastWeek as numbers.',
      });
      return;
    }
    patch.searchBuckets = searchBuckets;
  }

  const sourceCount = body['sourceCount'];
  if (sourceCount !== undefined) {
    if (typeof sourceCount !== 'number') {
      res.status(400).json({
        success: false,
        error: 'sourceCount must be a number.',
      });
      return;
    }
    patch.sourceCount = sourceCount;
  }

  const status = body['status'];
  if (status !== undefined) {
    if (!isTopicStatus(status)) {
      res.status(400).json({
        success: false,
        error: `status must be one of: ${TOPIC_STATUS_VALUES.join(', ')}.`,
      });
      return;
    }
    patch.status = status;
  }

  const error = body['error'];
  if (error !== undefined) {
    if (typeof error !== 'string') {
      res.status(400).json({
        success: false,
        error: 'error must be a string.',
      });
      return;
    }
    patch.error = error;
  }

  // ---- 5. Delegate to the service ----
  const topic = await updateTopicService(userId, topicId, patch);

  // ---- 6. Respond ----
  res.status(200).json({
    success: true,
    data: topic,
  });
};

// ============================================================
//  DELETE /api/topics/:id
// ============================================================

/**
 * Delete a topic, scoped to the authenticated user.
 *
 * Flow:
 *
 *   1. Reject with 401 if no authenticated user is attached.
 *   2. Reject with 400 if the `:id` route parameter is missing
 *      or empty.
 *   3. Delegate to the service. The service throws `AppError(404)`
 *      when the topic does not exist or belongs to a different
 *      user — the same merged case as `getTopicById`, and for the
 *      same reason: distinguishing the two would let an attacker
 *      probe for the existence of other users' topic IDs.
 *   4. Respond with 200 and the deleted topic. Returning the
 *      deleted document (rather than an empty body with 204)
 *      gives the client a last-chance look at what was removed,
 *      which the UI uses to render a "Deleted topic X —
 *      Undo?" toast without a second round trip. The 200/body
 *      form also matches the `ApiResponse` envelope that every
 *      other endpoint in this API uses.
 *
 * The service does NOT cascade the delete to the topic's child
 * records (documents, articles, reports). That is a deliberate
 * design choice — the cascade rules belong to each owning
 * feature, not to the topic service — and it is out of scope
 * for this file. If a cascade is ever needed, it belongs in the
 * service, not here.
 */
export const deleteTopic = async (
  req: AuthRequest,
  res: Response<ApiResponse<Topic>>
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
  const topicId = req.params['id'];
  if (typeof topicId !== 'string' || topicId.length === 0) {
    res.status(400).json({
      success: false,
      error: 'Topic ID is required.',
    });
    return;
  }

  // ---- 3. Delegate to the service ----
  const topic = await deleteTopicService(userId, topicId);

  // ---- 4. Respond ----
  res.status(200).json({
    success: true,
    data: topic,
  });
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