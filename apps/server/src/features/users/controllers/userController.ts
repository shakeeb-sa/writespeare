/**
 * HTTP handlers for the WriteSpeare users feature.
 *
 * Admin-only CRUD over the User collection. Every handler is
 * expected to be mounted behind BOTH `authenticate` and
 * `requireAdmin` at the route layer, so by the time a request
 * reaches here the caller is an authenticated administrator.
 * This file does NOT re-check the role — that check has already
 * been performed by the middleware, and duplicating it here would
 * split the authorization contract across two files.
 *
 * The one defensive guard this file DOES apply is the same one
 * every controller in this codebase applies: reading
 * `req.user?.userId` and rejecting with a 401 if it is absent. On
 * the surface that looks redundant given `requireAdmin` already
 * refused non-admins, but the guard costs nothing and protects
 * against a route being misconfigured in a future refactor — a
 * path where an admin-only handler is accidentally exposed
 * without its middleware chain. That class of mistake is rare
 * but has real consequences; the belt-and-braces guard is the
 * cheap insurance.
 *
 * The inverted ownership model:
 *
 *   Every OTHER controller in this codebase passes the CALLER's
 *   identity to its service, and the service uses that identity
 *   to filter queries to the caller's own records. That is how
 *   topics, documents, articles, reports, settings, and presets
 *   enforce isolation.
 *
 *   This controller is the exception. Its handlers target
 *   ARBITRARY users. The `:id` route parameter that
 *   `getUserById`, `updateUser`, and `deleteUser` pass to the
 *   service is the TARGET user's id — the record being acted
 *   upon, not the caller. The service header documents the
 *   reasoning; the controller simply follows the shape that
 *   admin CRUD requires.
 *
 *   The consequence is that the ownership scoping that every
 *   other controller performs — "a user may only see and mutate
 *   their own records" — is not performed here, and cannot be,
 *   because the entire point of the feature is to let an admin
 *   see and mutate someone else's. The scope that replaces it
 *   is "the caller must be an admin", which is enforced by
 *   `requireAdmin` middleware on the route.
 *
 * Response typing — the assignability bridge:
 *
 *   Every handler declares its `Response<T>` type as
 *   `ApiResponse<PublicUser>` or `ApiResponse<PublicUser[]>`. The
 *   service returns `PublicUser` (never a `UserDocument`), so no
 *   assignability conversion is needed — the service is the
 *   layer that applies the projection that strips
 *   `passwordHash`. The controller simply wraps whatever the
 *   service returns in the standard envelope.
 *
 * No try/catch appears anywhere in this file. Each route handler
 * is wrapped in `asyncHandler` at the route registration site,
 * which forwards any rejection to the terminal error middleware.
 * The middleware recognises the shared `AppError` class thrown by
 * the service — a 404 for a target user that does not exist, a
 * 409 for a duplicate email — and formats the response with the
 * same envelope this file uses on success.
 *
 * Validation is shallow:
 *
 *   The controller verifies the primitive type of each field that
 *   it reads from the request body or query — string for email
 *   and password, boolean for active, member-of-enum for role.
 *   It does NOT verify email format, password strength, or
 *   anything else that the User schema already enforces. Those
 *   checks are the schema's job; a Mongoose ValidationError is
 *   translated to a 400 by the terminal middleware with the
 *   schema's own message, which is exactly what a client should
 *   see. Duplicating the schema's rules here would create a
 *   second source of truth that could drift from the first.
 */

import type { Response } from 'express';

import {
  listUsers as listUsersService,
  getUserById as getUserByIdService,
  createUser as createUserService,
  updateUser as updateUserService,
  deleteUser as deleteUserService,
} from '../services/userService.js';
import type { PublicUser } from '../services/userService.js';

import type { AuthRequest } from '../../auth/middleware/authGuard.js';
import {
  UserRole,
  type ApiResponse,
  type UserCreatePayload,
  type UserUpdatePayload,
} from '../../shared/types/index.js';

// ============================================================
//  Runtime legal-value table and type guard
// ============================================================
//
// `UserRole` is a string enum, so its runtime representation is a
// plain object whose values are the strings 'admin' and 'user'.
// The array below is the runtime source of truth for what values
// are legal, and the annotation `readonly UserRole[]` guarantees
// at compile time that every member is a real enum value.

const USER_ROLE_VALUES: readonly UserRole[] = [
  UserRole.ADMIN,
  UserRole.USER,
];

const isUserRole = (value: unknown): value is UserRole =>
  typeof value === 'string' &&
  (USER_ROLE_VALUES as readonly string[]).includes(value);

/**
 * A non-empty string. Rejects the empty string, which is the
 * common "client sent a field but left it blank" case.
 */
const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

const isBoolean = (value: unknown): value is boolean =>
  typeof value === 'boolean';

// ============================================================
//  GET /api/users
// ============================================================

/**
 * List users, sorted newest first. Optional `?role=` and
 * `?active=` query parameters narrow the result.
 *
 * Flow:
 *
 *   1. Reject with 401 if no authenticated user is attached.
 *      (See the file header for the belt-and-braces rationale.)
 *   2. For each optional filter, validate that if present it is
 *      a legal value. An invalid role string is rejected with a
 *      400 rather than silently producing an empty result — a
 *      filter that matches nothing is indistinguishable from a
 *      filter that matches everything to a client that cannot
 *      see the underlying data.
 *   3. Delegate to the service with a filter object containing
 *      only the filters the caller supplied. Fields left
 *      `undefined` are omitted from the object entirely rather
 *      than set to `undefined`, per `exactOptionalPropertyTypes`.
 *   4. Respond with 200 and the array. An empty array is a
 *      valid, non-error response.
 */
export const listUsers = async (
  req: AuthRequest,
  res: Response<ApiResponse<PublicUser[]>>
): Promise<void> => {
  // ---- 1. Defensive authentication guard ----
  // `requireAdmin` on the route already guarantees an authenticated
  // admin reaches here. This check exists for the case where a
  // future route misconfiguration exposes the handler without its
  // middleware chain — see the file header.
  const callerId = req.user?.userId;
  if (!callerId) {
    res.status(401).json({
      success: false,
      error: 'Authentication required.',
    });
    return;
  }

  // ---- 2. Optional role filter ----
  const rawRole = req.query['role'];
  let role: UserRole | undefined;
  if (rawRole !== undefined) {
    if (!isUserRole(rawRole)) {
      res.status(400).json({
        success: false,
        error: `Invalid role filter. Must be one of: ${USER_ROLE_VALUES.join(', ')}.`,
      });
      return;
    }
    role = rawRole;
  }

  // ---- 3. Optional active filter ----
  // Query strings arrive as strings, so `?active=true` needs to be
  // coerced to a boolean. Only the literal strings `'true'` and
  // `'false'` are accepted — anything else (including `'1'`,
  // `'yes'`, or an empty string) is rejected with a 400 rather
  // than silently coerced, because ambiguity here would produce
  // results the client cannot explain.
  const rawActive = req.query['active'];
  let active: boolean | undefined;
  if (rawActive !== undefined) {
    if (rawActive === 'true') {
      active = true;
    } else if (rawActive === 'false') {
      active = false;
    } else {
      res.status(400).json({
        success: false,
        error: "Invalid active filter. Must be 'true' or 'false'.",
      });
      return;
    }
  }

  // ---- 4. Build the filter object and delegate ----
  // Conditional assignment (rather than assigning `undefined`)
  // is required under `exactOptionalPropertyTypes`. The resulting
  // object contains only the fields the caller actually supplied.
  const filter: { role?: UserRole; active?: boolean } = {};
  if (role !== undefined) {
    filter.role = role;
  }
  if (active !== undefined) {
    filter.active = active;
  }

  const users = await listUsersService(filter);

  // ---- 5. Respond ----
  res.status(200).json({
    success: true,
    data: users,
  });
};

// ============================================================
//  GET /api/users/:id
// ============================================================

/**
 * Return a single user by their ID.
 *
 * Flow:
 *
 *   1. Reject with 401 if no authenticated user is attached.
 *   2. Reject with 400 if the `:id` route parameter is missing
 *      or empty. A malformed ID that is present but not a valid
 *      ObjectId is not rejected here — the service's `findById`
 *      throws a CastError, which the terminal middleware maps to
 *      a 400.
 *   3. Delegate to the service with the target ID. A null
 *      result means "no such user"; this handler returns 404.
 *      Note that there is no "not owned by you" case here — the
 *      caller is an admin acting on arbitrary users, and the
 *      only failure mode for a well-formed request is "the user
 *      does not exist".
 *   4. Respond with 200 and the user, or 404.
 */
export const getUserById = async (
  req: AuthRequest,
  res: Response<ApiResponse<PublicUser>>
): Promise<void> => {
  // ---- 1. Defensive authentication guard ----
  const callerId = req.user?.userId;
  if (!callerId) {
    res.status(401).json({
      success: false,
      error: 'Authentication required.',
    });
    return;
  }

  // ---- 2. Route parameter guard ----
  const targetId = req.params['id'];
  if (!isNonEmptyString(targetId)) {
    res.status(400).json({
      success: false,
      error: 'User ID is required.',
    });
    return;
  }

  // ---- 3. Delegate to the service ----
  const user = await getUserByIdService(targetId);
  if (!user) {
    res.status(404).json({
      success: false,
      error: 'User not found.',
    });
    return;
  }

  // ---- 4. Respond ----
  res.status(200).json({
    success: true,
    data: user,
  });
};

// ============================================================
//  POST /api/users
// ============================================================

/**
 * Create a new user.
 *
 * Flow:
 *
 *   1. Reject with 401 if no authenticated user is attached.
 *   2. Reject with 400 if the request body is not a plain
 *      object.
 *   3. Validate the two required fields — `email` and
 *      `password`, both non-empty strings — and the two
 *      optional fields — `role` (a member of `UserRole`) and
 *      `active` (a boolean) — when present.
 *   4. Delegate to the service. The service hashes the password
 *      and persists the user; a duplicate email produces a 409
 *      from the terminal middleware via the unique index on
 *      `email`.
 *   5. Respond with 201 Created and the new user's public
 *      projection (which does NOT include the password hash).
 *
 * The controller never sees the password hash. It passes the
 * plaintext through to the service, which performs the hash. The
 * response object is the service's `PublicUser` projection.
 */
export const createUser = async (
  req: AuthRequest,
  res: Response<ApiResponse<PublicUser>>
): Promise<void> => {
  // ---- 1. Defensive authentication guard ----
  const callerId = req.user?.userId;
  if (!callerId) {
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

  const email = body['email'];
  if (!isNonEmptyString(email)) {
    res.status(400).json({
      success: false,
      error: 'email is required.',
    });
    return;
  }

  const password = body['password'];
  if (!isNonEmptyString(password)) {
    res.status(400).json({
      success: false,
      error: 'password is required.',
    });
    return;
  }

  // ---- 4. Optional fields ----
  // Each optional field is added to the payload only when present
  // in the body and passing validation. `exactOptionalPropertyTypes`
  // makes the incremental form the only legal one — the field
  // cannot be assigned `undefined`, so the branch must be either
  // "assign a concrete value" or "don't assign at all".
  const payload: UserCreatePayload = { email, password };

  const role = body['role'];
  if (role !== undefined) {
    if (!isUserRole(role)) {
      res.status(400).json({
        success: false,
        error: `role must be one of: ${USER_ROLE_VALUES.join(', ')}.`,
      });
      return;
    }
    payload.role = role;
  }

  const active = body['active'];
  if (active !== undefined) {
    if (!isBoolean(active)) {
      res.status(400).json({
        success: false,
        error: 'active must be a boolean.',
      });
      return;
    }
    payload.active = active;
  }

  // ---- 5. Delegate to the service ----
  const user = await createUserService(payload);

  // ---- 6. Respond ----
  res.status(201).json({
    success: true,
    data: user,
  });
};

// ============================================================
//  PATCH /api/users/:id
// ============================================================

/**
 * Apply a partial update to a user.
 *
 * Flow:
 *
 *   1. Reject with 401 if no authenticated user is attached.
 *   2. Reject with 400 if the `:id` route parameter is missing
 *      or empty.
 *   3. Reject with 400 if the request body is not a plain object.
 *   4. For every field present in the body, validate its type or
 *      closed-set membership, and add it to the patch. A field
 *      that is present but invalid is rejected with a 400 rather
 *      than silently dropped. A body with no recognised fields is
 *      a valid no-op — the service short-circuits and returns the
 *      current document unchanged.
 *   5. Delegate to the service. If the update includes a
 *      `password` field, the service hashes it before writing;
 *      the controller passes the plaintext through.
 *   6. Respond with 200 and the updated user's public projection.
 *
 * The service returns the updated document's public projection —
 * the password hash is never part of any response this endpoint
 * can produce, regardless of whether the update touched the
 * password field.
 */
export const updateUser = async (
  req: AuthRequest,
  res: Response<ApiResponse<PublicUser>>
): Promise<void> => {
  // ---- 1. Defensive authentication guard ----
  const callerId = req.user?.userId;
  if (!callerId) {
    res.status(401).json({
      success: false,
      error: 'Authentication required.',
    });
    return;
  }

  // ---- 2. Route parameter guard ----
  const targetId = req.params['id'];
  if (!isNonEmptyString(targetId)) {
    res.status(400).json({
      success: false,
      error: 'User ID is required.',
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

  // ---- 4. Build the patch field-by-field ----
  const patch: UserUpdatePayload = {};

  const email = body['email'];
  if (email !== undefined) {
    if (!isNonEmptyString(email)) {
      res.status(400).json({
        success: false,
        error: 'email must be a non-empty string.',
      });
      return;
    }
    patch.email = email;
  }

  const password = body['password'];
  if (password !== undefined) {
    if (!isNonEmptyString(password)) {
      res.status(400).json({
        success: false,
        error: 'password must be a non-empty string.',
      });
      return;
    }
    patch.password = password;
  }

  const role = body['role'];
  if (role !== undefined) {
    if (!isUserRole(role)) {
      res.status(400).json({
        success: false,
        error: `role must be one of: ${USER_ROLE_VALUES.join(', ')}.`,
      });
      return;
    }
    patch.role = role;
  }

  const active = body['active'];
  if (active !== undefined) {
    if (!isBoolean(active)) {
      res.status(400).json({
        success: false,
        error: 'active must be a boolean.',
      });
      return;
    }
    patch.active = active;
  }

  // ---- 5. Delegate to the service ----
  const user = await updateUserService(targetId, patch);

  // ---- 6. Respond ----
  res.status(200).json({
    success: true,
    data: user,
  });
};

// ============================================================
//  DELETE /api/users/:id
// ============================================================

/**
 * Delete a user.
 *
 * Flow:
 *
 *   1. Reject with 401 if no authenticated user is attached.
 *   2. Reject with 400 if the `:id` route parameter is missing
 *      or empty.
 *   3. Delegate to the service. The service throws
 *      `AppError(404)` when the target user does not exist.
 *   4. Respond with 200 and the deleted user's public
 *      projection. Returning the deleted document gives the
 *      client a last-chance look at what was removed, which the
 *      admin UI uses to render a "Deleted user X — Undo?"
 *      affordance without a second round trip.
 *
 * The service does NOT cascade to the target user's topics,
 * documents, articles, reports, settings, or presets — see the
 * service header for the cascade rationale. Deleting a user
 * leaves their other records in place; a future cleanup
 * migration is the correct place to address them.
 *
 * There is no guard against an admin deleting their own account
 * at this layer. The service header documents why that check
 * does not belong there; the same reasoning applies here — the
 * controller's job is to route the request, not to second-guess
 * the admin's intent. If the guard is ever needed, both the
 * controller and the service would need the caller's id, and the
 * change would be a deliberate addition rather than a silent
 * default.
 */
export const deleteUser = async (
  req: AuthRequest,
  res: Response<ApiResponse<PublicUser>>
): Promise<void> => {
  // ---- 1. Defensive authentication guard ----
  const callerId = req.user?.userId;
  if (!callerId) {
    res.status(401).json({
      success: false,
      error: 'Authentication required.',
    });
    return;
  }

  // ---- 2. Route parameter guard ----
  const targetId = req.params['id'];
  if (!isNonEmptyString(targetId)) {
    res.status(400).json({
      success: false,
      error: 'User ID is required.',
    });
    return;
  }

  // ---- 3. Delegate to the service ----
  const user = await deleteUserService(targetId);

  // ---- 4. Respond ----
  res.status(200).json({
    success: true,
    data: user,
  });
};

// ============================================================
//  Default export
// ============================================================

export default {
  listUsers,
  getUserById,
  createUser,
  updateUser,
  deleteUser,
};