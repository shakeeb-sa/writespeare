/**
 * Authentication controller.
 *
 * Thin HTTP layer over the auth service. Each handler:
 *
 *   1. Validates the shape of the request body or query — enough
 *      to catch a malformed client before it reaches the service.
 *
 *   2. Calls the service.
 *
 *   3. Formats the success response using the shared `ApiResponse`
 *      envelope.
 *
 * Any error the service throws (an `AppError` for known cases, a
 * raw error for unexpected cases) propagates up to the terminal
 * error middleware. Neither handler contains a try/catch — the
 * `asyncHandler` wrapper installed at the route registration site
 * forwards rejections, and the middleware classifies and formats
 * them. This keeps the controller free of any error-handling
 * logic that would duplicate what the middleware already does.
 *
 * Request validation here is intentionally minimal. The service
 * already performs the authoritative checks (email format is
 * enforced by the schema, password requirements by the login
 * flow). The controller's checks only exist to reject a request
 * that is so malformed the service would produce a confusing
 * error — a missing email, a non-string password. Anything
 * subtler is the service's concern.
 */

import type { Response } from 'express';
import {
  loginUser,
  getUserById,
  type PublicUser,
} from '../services/authService.js';
import type { AuthRequest } from '../middleware/authGuard.js';
import type {
  LoginRequest,
  LoginResponse,
  ApiResponse,
} from '../../shared/types/index.js';

// ============================================================
//  POST /api/auth/login
// ============================================================

/**
 * Authenticate a user and return a token.
 *
 * The request body is typed as `LoginRequest` (email and password
 * as strings). TypeScript types are erased at runtime, so a
 * non-conforming request — a missing field, a numeric password,
 * a null body — is possible. The guards below check for the two
 * cases that would produce a confusing service error: an absent
 * body and non-string field values.
 *
 * On success, the response carries the `LoginResponse` shape:
 * `{ user, token }` inside the standard envelope.
 *
 * On failure, the service throws an `AppError` with a deliberate
 * status code (401 for invalid credentials, 403 for a deactivated
 * account), and the terminal middleware formats the response.
 */
export const login = async (
  req: AuthRequest<Record<string, string>, unknown, LoginRequest>,
  res: Response<ApiResponse<LoginResponse>>
): Promise<void> => {
  const body = req.body;

  // ---- Guard: body must be an object ----
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    res.status(400).json({
      success: false,
      error: 'Request body must be a JSON object.',
    });
    return;
  }

  // ---- Guard: email and password must be strings ----
  if (typeof body.email !== 'string' || typeof body.password !== 'string') {
    res.status(400).json({
      success: false,
      error: 'Email and password are required.',
    });
    return;
  }

  // ---- Delegate to the service ----
  //
  // The service throws on any credential failure. That throw
  // propagates out of this handler, is caught by the asyncHandler
  // wrapper at the route registration site, and is forwarded to
  // the terminal middleware, which honours the AppError status
  // code. No try/catch here — the middleware is the single place
  // that knows how to format errors.
  const { token, user } = await loginUser(body.email, body.password);

  res.status(200).json({
    success: true,
    data: { user, token },
  });
};

// ============================================================
//  GET /api/auth/me
// ============================================================

/**
 * Return the currently authenticated user's profile.
 *
 * This handler is always reached through the `authenticate`
 * middleware, which has already verified the token and populated
 * `req.user` with the decoded payload. The `req.user` field is
 * optional on `AuthRequest` because the type is shared with
 * unauthenticated handlers, so this handler narrows it with a
 * defensive check — if the middleware chain were ever misconfigured
 * and this handler reached without a user attached, the correct
 * response is a 401, not a crash on a null dereference.
 *
 * Two distinct failure cases, each with its own status code:
 *
 *   - No `req.user` on the request → 401. The authentication
 *     middleware did not run, or ran and rejected. Either way,
 *     the caller has no session.
 *
 *   - `req.user.userId` does not resolve to a user → 404. The
 *     token is valid and was signed for a user ID, but that user
 *     no longer exists in the database. This happens when an
 *     admin deletes an account while the client still holds a
 *     token. The correct response is 404 (the resource — the
 *     user — is gone), not 401 (the token is still valid).
 */
export const getMe = async (
  req: AuthRequest,
  res: Response<ApiResponse<PublicUser>>
): Promise<void> => {
  // ---- Guard: authentication middleware must have run ----
  const userId = req.user?.userId;
  if (!userId) {
    res.status(401).json({
      success: false,
      error: 'Authentication required.',
    });
    return;
  }

  // ---- Delegate to the service ----
  const user = await getUserById(userId);
  if (!user) {
    res.status(404).json({
      success: false,
      error: 'User not found.',
    });
    return;
  }

  res.status(200).json({
    success: true,
    data: user,
  });
};

// ============================================================
//  Default export
// ============================================================

export default {
  login,
  getMe,
};