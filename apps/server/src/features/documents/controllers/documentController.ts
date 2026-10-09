/**
 * HTTP handlers for the WriteSpeare Document entity.
 *
 * Thin request/response layer over `documentService`. Each handler
 * performs exactly four jobs and nothing else:
 *
 *   1. Read the authenticated user's ID from `req.user.userId`
 *      and reject the request with a 401 if it is absent. Every
 *      ownership-scoped operation in WriteSpeare keys off this
 *      value; a handler that is reached without an authenticated
 *      session would either crash on a null dereference or — far
 *      worse — silently operate on the wrong user's data.
 *      `authenticate` on the route layer is the primary gate; this
 *      check is the belt-and-braces guard against a route that is
 *      misconfigured in a future refactor.
 *
 *   2. Validate the shape of the request body / query / params
 *      just enough to reject requests that are so malformed the
 *      service would produce a confusing error. The schema (in
 *      `documents/models/Document.ts`) remains the authoritative
 *      validator for everything subtler — URL parsing, platform
 *      slug format, string length bounds, integer constraints on
 *      the word count are all checked there, and a Mongoose
 *      ValidationError is translated to a 400 by the terminal
 *      error middleware. Doing anything more in the controller
 *      would duplicate the schema's rules and eventually drift
 *      from them.
 *
 *   3. Delegate to the service. The controller never touches the
 *      database directly — it does not import the Document model,
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
 * the service — a 404 for a document or topic that does not exist
 * or is not owned by the caller — and formats the response with
 * the same envelope this file uses on success. Putting a try/catch
 * here would duplicate the middleware's classification logic and
 * split the error-handling contract across two files.
 *
 * Response typing — the assignability bridge:
 *
 *   Every handler declares its `Response<T>` type explicitly. On
 *   success the service returns a `DocumentDocument` (Mongoose's
 *   in-process shape) which is structurally assignable to the
 *   shared `Document` domain type — the only difference is that
 *   `DocumentDocument._id` is a concrete `ObjectId` while
 *   `Document._id` is `string | ObjectId`. Since `ObjectId` is a
 *   member of the union, the assignment is safe and the response
 *   type can be declared as the domain type. At runtime,
 *   `res.json()` serialises the ObjectId to its hex string form,
 *   which is exactly what the client's `Document` interface
 *   expects.
 *
 * The `fetchedAt` conversion — why this file does it:
 *
 *   The `DocumentCreatePayload` type declares `fetchedAt: Date`,
 *   because that is the type the schema stores and the service
 *   receives. But an HTTP request body arrives as JSON, and JSON
 *   has no Date type — a `Date` serialised through `JSON.stringify`
 *   becomes an ISO-8601 string. The controller is therefore the
 *   one place where the wire format (string) meets the in-process
 *   type (Date), and the conversion — plus its associated
 *   validation that the string actually parses to a valid date —
 *   lives here. Every other layer of the stack receives a
 *   `Date` and never has to think about it.
 *
 *   The validation rejects two cases distinctly: a missing or
 *   non-string `fetchedAt` (400 "must be an ISO date string"),
 *   and a string that does not parse (400 "must be a valid ISO
 *   date string"). The two messages differ so a client developer
 *   can tell whether they omitted the field or sent the wrong
 *   kind of value.
 *
 * Route-ordering note for `deleteDocumentsByTopic`:
 *
 *   This file exposes a bulk-delete-by-topic route at
 *   `DELETE /api/documents/topic/:topicId`, alongside the
 *   single-document `DELETE /api/documents/:id`. Express matches
 *   routes by segment count, and the two paths differ in the
 *   number of segments they contain (`/topic/:topicId` has two,
 *   `/:id` has one), so no ambiguity exists regardless of which
 *   route is declared first in the route file. The route is
 *   exposed for the cascade-delete workflow described in the
 *   service's header comment — the current desktop IPC surface
 *   does not call it, but the backend's route table is the
 *   authoritative declaration of what the API can do, and this
 *   route is a legitimate operation the API supports.
 *
 * Ownership scoping:
 *
 *   The `userId` passed to the service is ALWAYS derived from the
 *   authenticated session — `req.user.userId` — and NEVER read
 *   from the request body or query. This is what makes it
 *   impossible for a client to create a document on behalf of
 *   another user: the ownership field is set from the token, not
 *   from anything the client controls.
 */

import type { Response } from 'express';

import {
  createDocument as createDocumentService,
  listDocuments as listDocumentsService,
  getDocumentById as getDocumentByIdService,
  deleteDocument as deleteDocumentService,
  deleteDocumentsByTopic as deleteDocumentsByTopicService,
} from '../services/documentService.js';

import type { AuthRequest } from '../../auth/middleware/authGuard.js';
import type {
  ApiResponse,
  Document,
  DocumentCreatePayload,
} from '../../shared/types/index.js';

// ============================================================
//  POST /api/documents
// ============================================================

/**
 * Persist a scraped document attached to a topic owned by the
 * authenticated user.
 *
 * Flow:
 *
 *   1. Reject with 401 if no authenticated user is attached.
 *   2. Reject with 400 if the request body is not a plain object.
 *   3. Validate the eight required fields present on the request
 *      body. Each is checked for a primitive type — strings for
 *      the four text fields, a number for the word count, a
 *      string for the two identifiers. Length and content rules
 *      (URL parses, platform slug format, non-empty title,
 *      integer word count) are the schema's job and are not
 *      duplicated here.
 *   4. Convert `fetchedAt` from its wire-format ISO string into a
 *      `Date` and validate that the conversion succeeded. See the
 *      file header for why this conversion is the controller's
 *      responsibility.
 *   5. Delegate to the service. The service validates that the
 *      parent topic exists and is owned by the caller; a 404
 *      thrown by that check propagates to the terminal middleware.
 *   6. Respond with 201 Created and the persisted document.
 *
 * The `userId` argument to the service is derived from the
 * authenticated session. Any client-supplied `userId` field on
 * the request body is ignored — the body's `Record<string,
 * unknown>` type simply does not read that field.
 */
export const createDocument = async (
  req: AuthRequest,
  res: Response<ApiResponse<Document>>
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
  // The cast to `unknown` before the type check forces every
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

  // ---- 3. Required fields ----
  // Each field is checked for its primitive type only. Length
  // and content rules belong to the schema — see the file
  // header. The checks are ordered so that the error message a
  // client sees names the first missing field, which is more
  // useful than a generic "invalid body" for a client developer
  // iterating on their request shape.

  const topicId = body['topicId'];
  if (typeof topicId !== 'string' || topicId.length === 0) {
    res.status(400).json({
      success: false,
      error: 'topicId is required.',
    });
    return;
  }

  const url = body['url'];
  if (typeof url !== 'string' || url.length === 0) {
    res.status(400).json({
      success: false,
      error: 'url is required.',
    });
    return;
  }

  const platform = body['platform'];
  if (typeof platform !== 'string' || platform.length === 0) {
    res.status(400).json({
      success: false,
      error: 'platform is required.',
    });
    return;
  }

  const title = body['title'];
  if (typeof title !== 'string' || title.length === 0) {
    res.status(400).json({
      success: false,
      error: 'title is required.',
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

  // ---- 4. fetchedAt conversion ----
  // The wire format is an ISO-8601 string; the in-process type
  // is a Date. The two failure modes are distinguished so a
  // client developer can tell whether the field was omitted,
  // sent as the wrong type, or sent as a string that does not
  // parse.
  const fetchedAtRaw = body['fetchedAt'];
  if (typeof fetchedAtRaw !== 'string') {
    res.status(400).json({
      success: false,
      error: 'fetchedAt must be an ISO date string.',
    });
    return;
  }
  const fetchedAt = new Date(fetchedAtRaw);
  if (Number.isNaN(fetchedAt.getTime())) {
    res.status(400).json({
      success: false,
      error: 'fetchedAt must be a valid ISO date string.',
    });
    return;
  }

  // ---- 5. Build the payload and delegate ----
  const payload: DocumentCreatePayload = {
    topicId,
    url,
    platform,
    title,
    content,
    wordCount,
    fetchedAt,
  };

  const document = await createDocumentService(userId, payload);

  // ---- 6. Respond ----
  res.status(201).json({
    success: true,
    data: document,
  });
};

// ============================================================
//  GET /api/documents
// ============================================================

/**
 * List the authenticated user's documents, sorted newest first.
 * An optional `?topicId=` query parameter narrows the result to
 * the documents attached to a single topic.
 *
 * Flow:
 *
 *   1. Reject with 401 if no authenticated user is attached.
 *   2. If a `?topicId=` query parameter is present, validate that
 *      it is a non-empty string. The service does not confirm
 *      ownership of the topic — a topicId that does not belong to
 *      the caller produces an empty list, not a 404. That is
 *      deliberate: the list endpoint is a read-only projection,
 *      and distinguishing "no documents under someone else's
 *      topic" from "no documents under your own empty topic"
 *      would reopen the enumeration channel the rest of the
 *      service closes. See the service header for the full
 *      rationale.
 *   3. Delegate to the service with the derived `userId` and the
 *      optional filter.
 *   4. Respond with 200 and the array. An empty array is a valid,
 *      non-error response.
 */
export const listDocuments = async (
  req: AuthRequest,
  res: Response<ApiResponse<Document[]>>
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
  // `req.query['topicId']` is typed `string | ParsedQs | (string
  // | ParsedQs)[] | undefined` under Express's default generics.
  // A repeated query parameter arrives as an array and is
  // rejected by the `typeof !== 'string'` check — the correct
  // behaviour, since the API accepts exactly one topicId filter
  // per request.
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
  const documents = await listDocumentsService(userId, topicId);

  // ---- 4. Respond ----
  res.status(200).json({
    success: true,
    data: documents,
  });
};

// ============================================================
//  GET /api/documents/:id
// ============================================================

/**
 * Return a single document by its ID, scoped to the authenticated
 * user.
 *
 * Flow:
 *
 *   1. Reject with 401 if no authenticated user is attached.
 *   2. Reject with 400 if the `:id` route parameter is missing
 *      or empty. A malformed ID that is present but not a valid
 *      ObjectId is not rejected here — the service's `findOne`
 *      throws a CastError, which the terminal middleware maps
 *      to a 400.
 *   3. Delegate to the service. A null result means either "no
 *      such document" or "document belongs to a different
 *      user"; this handler returns 404 for both. Returning 403
 *      for the "belongs to someone else" case would leak the
 *      existence of other users' document IDs to an authenticated
 *      attacker probing the endpoint.
 *   4. Respond with 200 and the document, or 404 if it was not
 *      found / not owned.
 */
export const getDocumentById = async (
  req: AuthRequest,
  res: Response<ApiResponse<Document>>
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
  const documentId = req.params['id'];
  if (typeof documentId !== 'string' || documentId.length === 0) {
    res.status(400).json({
      success: false,
      error: 'Document ID is required.',
    });
    return;
  }

  // ---- 3. Delegate to the service ----
  const document = await getDocumentByIdService(userId, documentId);
  if (!document) {
    res.status(404).json({
      success: false,
      error: 'Document not found.',
    });
    return;
  }

  // ---- 4. Respond ----
  res.status(200).json({
    success: true,
    data: document,
  });
};

// ============================================================
//  DELETE /api/documents/:id
// ============================================================

/**
 * Delete a single document, scoped to the authenticated user.
 *
 * Flow:
 *
 *   1. Reject with 401 if no authenticated user is attached.
 *   2. Reject with 400 if the `:id` route parameter is missing
 *      or empty.
 *   3. Delegate to the service. The service throws `AppError(404)`
 *      when the document does not exist or belongs to a different
 *      user — the same merged case as `getDocumentById`, and for
 *      the same reason.
 *   4. Respond with 200 and the deleted document. Returning the
 *      deleted document (rather than an empty body with 204)
 *      gives the client a last-chance look at what was removed,
 *      which the UI uses to render a "Deleted document X —
 *      Undo?" affordance without a second round trip.
 *
 * The service does NOT touch the filesystem. The `.md` file that
 * the extraction pipeline wrote lives on the desktop client's
 * disk; removing it is the desktop's job (via the IPC layer), not
 * the backend's. The backend owns only the metadata record.
 */
export const deleteDocument = async (
  req: AuthRequest,
  res: Response<ApiResponse<Document>>
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
  const documentId = req.params['id'];
  if (typeof documentId !== 'string' || documentId.length === 0) {
    res.status(400).json({
      success: false,
      error: 'Document ID is required.',
    });
    return;
  }

  // ---- 3. Delegate to the service ----
  const document = await deleteDocumentService(userId, documentId);

  // ---- 4. Respond ----
  res.status(200).json({
    success: true,
    data: document,
  });
};

// ============================================================
//  DELETE /api/documents/topic/:topicId
// ============================================================

/**
 * Delete every document attached to the given topic, scoped to
 * the authenticated user.
 *
 * Flow:
 *
 *   1. Reject with 401 if no authenticated user is attached.
 *   2. Reject with 400 if the `:topicId` route parameter is
 *      missing or empty.
 *   3. Delegate to the service. The service returns the number of
 *      documents removed. Zero is a valid result: it means either
 *      the topic has no documents, or the topic does not exist,
 *      or the topic belongs to a different user — the caller does
 *      not need to distinguish those cases. The filter is scoped
 *      to `{ userId, topicId }`, so a caller cannot clear another
 *      user's topic by guessing its ID.
 *   4. Respond with 200 and `{ deletedCount }`. The count is
 *      returned in the `data` field (rather than as a free-form
 *      message) so the client can read it programmatically — a
 *      toast saying "Cleared 8 documents" reads the number from
 *      this exact place.
 *
 * Route-path note — `/topic/:topicId` vs `/:id`:
 *
 *   Express matches routes segment-by-segment. A request to
 *   `DELETE /api/documents/topic/abc123` has two segments after
 *   the mount point (`topic` and `abc123`); a request to
 *   `DELETE /api/documents/xyz` has one (`xyz`). The route
 *   `/:id` matches exactly one segment and cannot collide with
 *   `/topic/:topicId`, which matches exactly two. Both routes can
 *   therefore be declared in the route file in either order
 *   without ambiguity. The nested form is used rather than a
 *   query parameter (`DELETE /api/documents?topicId=...`)
 *   because the query-parameter form collides semantically with
 *   the single-document delete — a caller cannot tell from the
 *   URL alone whether they are clearing one document or all of a
 *   topic's documents, and the nested path makes the intent
 *   explicit.
 */
export const deleteDocumentsByTopic = async (
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
  const deletedCount = await deleteDocumentsByTopicService(
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
  createDocument,
  listDocuments,
  getDocumentById,
  deleteDocument,
  deleteDocumentsByTopic,
};