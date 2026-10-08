/**
 * Authentication routes.
 *
 * Declares the two auth endpoints and the middleware chain that
 * runs in front of each. Mounted at `/api/auth` by the app
 * factory, so the paths declared here are relative to that
 * prefix:
 *
 *   POST /api/auth/login   → public, no auth required
 *   GET  /api/auth/me      → requires a valid bearer token
 *
 * Every async handler is wrapped in `asyncHandler`. The wrapper
 * is what makes the controllers' "no try/catch" pattern safe:
 * when a service throws (for example, `loginUser` on a wrong
 * password), the rejected promise is caught here and forwarded to
 * the terminal error middleware, which formats the response using
 * the status code the thrown `AppError` carried. Without the
 * wrapper, Express 5 would still forward the rejection on most
 * runtimes, but relying on that behaviour is fragile across
 * versions and the wrapper is the explicit, version-independent
 * contract.
 *
 * The routes are declared as a flat sequence of `router.METHOD`
 * calls rather than as a route table or a declarative
 * configuration. A reader can scan the file top to bottom and see
 * exactly which middleware runs on which route without holding
 * any additional context — that property is worth more than the
 * brevity a table would buy at this scale.
 */

import { Router } from 'express';
import { login, getMe } from '../controllers/authController.js';
import { authenticate } from '../middleware/authGuard.js';
import { asyncHandler } from '../../shared/middleware/errorHandler.js';

// ============================================================
//  Router instance
// ============================================================

const authRoutes = Router();

// ============================================================
//  POST /api/auth/login
// ============================================================
//
//  Public endpoint. No middleware beyond the async wrapper.
//
//  The controller validates the request body shape, calls the
//  auth service, and returns the token plus user on success. On
//  any credential failure, the service throws an `AppError` with
//  the correct status code (401 for invalid credentials, 403 for
//  a deactivated account), which the wrapper forwards to the
//  terminal middleware.

authRoutes.post(
  '/login',
  asyncHandler(login)
);

// ============================================================
//  GET /api/auth/me
// ============================================================
//
//  Protected endpoint. The `authenticate` middleware runs first,
//  verifies the bearer token, checks that the user still exists
//  and is active, and populates `req.user` with the decoded
//  payload. Only if that succeeds does the controller run.
//
//  The middleware sends its own 401 or 403 response and does not
//  call `next()` on failure, so the controller never sees an
//  unauthenticated request. The controller's own defensive check
//  on `req.user` is a belt-and-braces guard against a route being
//  misconfigured in a future refactor — it is not expected to
//  fire in practice.

authRoutes.get(
  '/me',
  asyncHandler(authenticate),
  asyncHandler(getMe)
);

// ============================================================
//  Default export
// ============================================================

export default authRoutes;