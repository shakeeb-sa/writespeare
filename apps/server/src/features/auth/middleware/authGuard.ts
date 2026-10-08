/**
 * Authentication and authorization middleware for the WriteSpeare
 * backend.
 *
 * Three middleware functions live here, each serving a distinct
 * gate:
 *
 *   authenticate          — the strict gate. Requires a valid,
 *                           unexpired token belonging to a user
 *                           who still exists and is active.
 *                           Anything less produces a 401 (or 403
 *                           for the deactivated-user case). Used
 *                           by every route except login and the
 *                           public version endpoint.
 *
 *   optionalAuthenticate  — the lenient gate. Attaches a user to
 *                           the request when a valid token is
 *                           present and swallow-fails in every
 *                           other case, always calling `next()`.
 *                           Used by routes that behave differently
 *                           for logged-in and anonymous callers
 *                           but do not require a session.
 *
 *   requireAdmin          — the role gate. Must be layered AFTER
 *                           `authenticate` (or after any other
 *                           middleware that populates `req.user`).
 *                           Returns 403 when the attached user is
 *                           not an admin. Never verifies a token
 *                           itself.
 *
 * Token extraction, verification, and user lookup are the three
 * steps that would otherwise be duplicated across every protected
 * route. Centralising them here means the authentication contract
 * lives in exactly one file, and a change to that contract (say,
 * adding a token-version check) has exactly one place to go.
 *
 * Request typing:
 *
 *   `AuthRequest` extends Express's `Request` with an optional
 *   `user` field. Every controller that needs to read `req.user`
 *   types its handler parameter as `AuthRequest`, which gives the
 *   compiler the shape of `user` without a cast. The `user` field
 *   is optional because unauthenticated requests reaching a
 *   handler typed as `AuthRequest` still have `req.user === undefined`.
 *   Handlers that require a user check for it explicitly, or are
 *   protected by `authenticate` and can rely on it being present.
 */

import type { Request, Response, NextFunction } from 'express';
import { verifyToken, type TokenPayload } from '../utils/jwt.js';
import { UserModel } from '../models/User.js';
import { UserRole, type ApiResponse } from '../../shared/types/index.js';

// ============================================================
//  Request shape
// ============================================================

/**
 * Express `Request` extended with the decoded JWT payload.
 *
 * The `user` field is populated by `authenticate` (or
 * `optionalAuthenticate`, when a valid token is present) and read
 * by every downstream middleware and controller that needs to
 * know who is making the request.
 *
 * The field is optional because a handler typed as `AuthRequest`
 * can be reached by an unauthenticated request if the route is
 * not wrapped in `authenticate`. Handlers that require a user
 * either check for the field's presence or rely on `authenticate`
 * having run — the choice is theirs, not the middleware's.
 *
 * `TokenPayload` is deliberately used as-is rather than narrowed
 * to a richer shape. The middleware has verified the signature by
 * the time `user` is populated, so the payload's fields are
 * trustworthy; the fact that `role` is a plain string rather than
 * the `UserRole` enum is deliberate — the token payload is client-
 * visible, and keeping its type surface minimal discourages
 * callers from leaning on it for anything beyond the ID.
 */
export interface AuthRequest extends Request {
  user?: TokenPayload;
}

// ============================================================
//  Token extraction
// ============================================================

/**
 * Extract the bearer token from an incoming request's
 * `Authorization` header, or return `null` when the header is
 * missing, malformed, or empty.
 *
 * The accepted form is `Authorization: Bearer <token>`. The
 * scheme match is case-insensitive because the HTTP specification
 * declares the scheme token to be case-insensitive, and some
 * clients send `bearer` in lowercase.
 *
 * The returned token is trimmed of surrounding whitespace, so a
 * stray `\r` from a CRLF-terminated header (rare but observed on
 * some HTTP clients) does not produce a verification failure that
 * looks like a signature problem.
 *
 * Exported as a standalone helper so a future audit-log
 * middleware can read the token for diagnostics without pulling
 * in the whole `authenticate` flow.
 */
export const extractToken = (req: Request): string | null => {
  const authHeader = req.headers.authorization;
  if (typeof authHeader !== 'string') {
    return null;
  }

  // Case-insensitive scheme match, then take everything after the
  // first space. Using `indexOf` rather than `split` avoids
  // copying the token when the string is large.
  const schemeEnd = authHeader.indexOf(' ');
  if (schemeEnd < 0) {
    return null;
  }

  const scheme = authHeader.slice(0, schemeEnd).toLowerCase();
  if (scheme !== 'bearer') {
    return null;
  }

  const token = authHeader.slice(schemeEnd + 1).trim();
  return token.length > 0 ? token : null;
};

// ============================================================
//  authenticate — the strict gate
// ============================================================

/**
 * Verify the request's bearer token and attach the decoded
 * payload to `req.user`. Reject the request with a structured
 * error response in every failure case.
 *
 * Failure cases, in the order they are checked:
 *
 *   1. Missing or malformed Authorization header → 401.
 *   2. Token fails signature or format verification → 401,
 *      with a message that distinguishes the expired case
 *      ("Session expired") from the invalid case ("Invalid
 *      authentication token").
 *   3. Signature is valid but the user ID in the token does not
 *      resolve to an existing user → 401. This is what happens
 *      when an admin deletes a user while that user's token is
 *      still live.
 *   4. User exists but `active` is `false` → 403. A deactivated
 *      account is a distinct case from a non-existent one; the
 *      client-side UI uses the status code to show a different
 *      message ("Account deactivated" rather than "Please log in
 *      again").
 *   5. User lookup fails for any other reason (database error,
 *      malformed ObjectId in a compromised token) → 500. The
 *      underlying error is logged server-side; the client sees
 *      a generic authentication failure so nothing about the
 *      server's internals leaks.
 *
 * On success, `next()` is called and the request proceeds down
 * the middleware chain with `req.user` populated.
 *
 * The function is `async` because it awaits the user lookup. The
 * explicit `next()` calls in each terminal branch are what keep
 * the middleware chain linear and predictable — a silent return
 * after sending a response would leave Express waiting for a
 * `next` that never comes, and the request would hang.
 */
export const authenticate = async (
  req: AuthRequest,
  res: Response<ApiResponse<null>>,
  next: NextFunction
): Promise<void> => {
  // ---- Step 1: extract the token ----
  const token = extractToken(req);
  if (!token) {
    res.status(401).json({
      success: false,
      error: 'Authentication required. Please provide a valid token.',
    });
    return;
  }

  // ---- Step 2: verify the token ----
  //
  // `verifyToken` throws on any verification failure — expired,
  // malformed, wrong signature. The thrown error's message wraps
  // the underlying reason, so we inspect the message text to
  // distinguish the expired case, which the client should handle
  // differently from a generic invalid-token error.
  //
  // The message inspection is deliberate and documented as
  // fragile in the honesty notes for this file. The alternative —
  // exposing the raw jsonwebtoken error classes from the util
  // layer — would couple every consumer of the util to the
  // library's internal error taxonomy, which is not worth it for
  // one string comparison.
  let decoded: TokenPayload;
  try {
    decoded = verifyToken(token);
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    const message = raw.toLowerCase().includes('expired')
      ? 'Session expired. Please log in again.'
      : 'Invalid authentication token.';
    res.status(401).json({ success: false, error: message });
    return;
  }

  // ---- Steps 3, 4, 5: user lookup, activity check, error handling ----
  try {
    // Project only the fields needed for the checks below. The
    // password hash is `select: false` on the schema, so it is
    // excluded by default; the explicit projection narrows the
    // network payload further.
    const user = await UserModel.findById(decoded.userId).select('_id active');

    if (!user) {
      res.status(401).json({
        success: false,
        error: 'User no longer exists.',
      });
      return;
    }

    if (!user.active) {
      res.status(403).json({
        success: false,
        error: 'Account is deactivated. Please contact an administrator.',
      });
      return;
    }

    // Populate the request. From this point on, every downstream
    // middleware and controller can read `req.user.userId`,
    // `req.user.email`, and `req.user.role`.
    req.user = decoded;
    next();
  } catch (error) {
    console.error('authGuard: user lookup failed:', error);
    res.status(500).json({
      success: false,
      error: 'Authentication failed due to a server error.',
    });
  }
};

// ============================================================
//  optionalAuthenticate — the lenient gate
// ============================================================

/**
 * Attempt to authenticate the request. Attach a user to the
 * request when the token is valid and belongs to an active user;
 * otherwise, do nothing. Always calls `next()`.
 *
 * This middleware NEVER sends a response. Its contract is
 * "populate `req.user` if you can, then move on regardless". The
 * downstream handler is responsible for deciding whether the
 * absence of a user is acceptable (a public profile view, for
 * example) or not (a protected action, in which case the handler
 * checks `req.user` explicitly).
 *
 * The internal token-verification block is wrapped in its own
 * try/catch so that an invalid token on an optional-auth route
 * does not produce the same 401 that `authenticate` would emit —
 * the whole point of this middleware is that a bad token is
 * treated identically to a missing one.
 *
 * The user-existence check is also wrapped, and its failure is
 * swallowed for the same reason: a stale user ID in a client's
 * stored token should not break an anonymous-accessible route.
 */
export const optionalAuthenticate = async (
  req: AuthRequest,
  _res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const token = extractToken(req);
    if (!token) {
      next();
      return;
    }

    let decoded: TokenPayload;
    try {
      decoded = verifyToken(token);
    } catch {
      next();
      return;
    }

    try {
      const user = await UserModel.findById(decoded.userId).select('_id active');
      if (user && user.active) {
        req.user = decoded;
      }
    } catch {
      // swallow — this path is best-effort by contract
    }

    next();
  } catch {
    // Defensive outer catch: any unexpected throw still results in
    // a request that proceeds without an authenticated user.
    next();
  }
};

// ============================================================
//  requireAdmin — the role gate
// ============================================================

/**
 * Reject the request unless the attached user has the admin role.
 *
 * Must be layered AFTER a middleware that populates `req.user` —
 * typically `authenticate`, but `optionalAuthenticate` also
 * qualifies for routes where admin access is optional (a rare
 * case but one the layering supports without modification).
 *
 * Two failure modes:
 *
 *   - No `req.user` on the request → 401. The admin gate cannot
 *     be the first middleware on a route; if it is reached
 *     without an attached user, the route configuration is
 *     wrong, and the correct response is to reject the request
 *     rather than assume an identity.
 *
 *   - `req.user.role !== 'admin'` → 403. The user is
 *     authenticated, but lacks the required privilege. 403 (not
 *     401) is the correct status for an authenticated request
 *     that the server refuses to authorize.
 *
 * The role comparison uses the `UserRole.ADMIN` enum value
 * rather than the string literal `'admin'` so a future rename of
 * the enum value propagates here automatically. The comparison
 * itself is a plain string equality at runtime — enum values in
 * TypeScript are string literals when the enum is a string enum.
 */
export const requireAdmin = (
  req: AuthRequest,
  res: Response<ApiResponse<null>>,
  next: NextFunction
): void => {
  if (!req.user) {
    res.status(401).json({
      success: false,
      error: 'Authentication required.',
    });
    return;
  }

  if (req.user.role !== UserRole.ADMIN) {
    res.status(403).json({
      success: false,
      error: 'Admin privileges required.',
    });
    return;
  }

  next();
};

// ============================================================
//  Default export
// ============================================================

export default {
  authenticate,
  optionalAuthenticate,
  requireAdmin,
  extractToken,
};