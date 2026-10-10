/**
 * Error handling middleware for the WriteSpeare backend.
 *
 * Centralises three concerns that would otherwise be repeated in
 * every controller:
 *
 *   1. Distinguishing operational errors (a bad request, a
 *      missing record) from programmer errors (a null reference,
 *      a broken invariant). Operational errors carry an HTTP
 *      status code chosen at the throw site; programmer errors
 *      are treated as 500s and never leak their stack to the
 *      client in production.
 *
 *   2. Translating errors thrown by third-party libraries — the
 *      Mongoose driver, the JWT verifier — into the same
 *      response envelope the rest of the API uses. A consumer
 *      never sees a raw `MongoServerError`; they see
 *      `{ success: false, error: "…" }` like everything else.
 *
 *   3. Providing a single wrapper (`asyncHandler`) that lets
 *      async route handlers throw without crashing the process
 *      on an unhandled promise rejection. Express 5 does forward
 *      rejected promises to `next` automatically, but the wrapper
 *      remains in place because it also normalises the shape of
 *      the rejection and because it keeps the call sites explicit
 *      about the fact that they can throw.
 *
 * The response envelope is the `ApiResponse` type from
 * `features/shared/types`, which every other layer of the
 * backend also uses. Keeping the shape identical here means a
 * client can handle every response — success or failure — with
 * the same unwrapping logic.
 */

import type { Request, Response, NextFunction } from 'express';
import type { ApiResponse } from '../types/index.js';

// ============================================================
//  AppError — operational error
// ============================================================

/**
 * An error whose cause is known and whose HTTP status code is
 * deliberate.
 *
 * Throw an `AppError` when the failure is expected and the
 * correct client response is clear:
 *
 *   throw new AppError('Email already registered', 409);
 *   throw new AppError('Topic not found', 404);
 *   throw new AppError('Admin privileges required', 403);
 *
 * The `isOperational` flag defaults to `true` and is what the
 * error handler uses to decide whether to log the full stack.
 * Anything NOT wrapped in an `AppError` is treated as
 * non-operational — a bug in the code — and logged with its
 * stack regardless of environment.
 */
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly isOperational: boolean;

  public constructor(
    message: string,
    statusCode: number,
    isOperational: boolean = true
  ) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = isOperational;

    // Restore the prototype chain. TypeScript's class-emit for a
    // subclass of `Error` breaks `instanceof` without this call on
    // some target/module combinations, because the emit produces a
    // plain function rather than a true subclass. The `Object.setPrototypeOf`
    // form is the portable fix across Node versions.
    Object.setPrototypeOf(this, AppError.prototype);

    // Capture the stack, but only for non-operational errors. An
    // operational error is thrown at a known site, so its stack
    // adds noise to logs without adding diagnostic value. A
    // non-operational error is a bug — its stack is the whole point.
    if (!isOperational) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

// ============================================================
//  Known error shapes from third-party libraries
// ============================================================

/**
 * Mongoose wraps schema-level validation failures in a
 * `ValidationError` — one entry per invalid path. The `errors`
 * map is part of the library's public shape but is not typed on
 * the base `Error`. Narrowing to this shape lets the handler
 * extract the first human-readable message without a `any` cast.
 */
interface MongooseValidationErrorShape {
  name: 'ValidationError';
  message: string;
  errors?: Record<string, { message?: string }>;
}

/**
 * Duplicate-key errors come back from the driver as a plain Error
 * with a numeric `code` of 11000 and a `keyPattern` map naming
 * the offending field. Same treatment as the validation shape —
 * a local narrowing interface so the handler reads cleanly.
 */
interface MongoDuplicateKeyErrorShape {
  code: number;
  keyPattern?: Record<string, unknown>;
}

/**
 * Type guard for the Mongoose validation error. Checks by name
 * rather than by `instanceof` because the class is not imported —
 * importing it would pull a runtime dependency into this module
 * purely for a check, and the name match is how Mongoose itself
 * distinguishes the error in its own internals.
 */
const isMongooseValidationError = (
  err: unknown
): err is MongooseValidationErrorShape => {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { name?: unknown }).name === 'ValidationError'
  );
};

/**
 * Type guard for the Mongo duplicate-key error.
 */
const isMongoDuplicateKeyError = (
  err: unknown
): err is MongoDuplicateKeyErrorShape => {
  return (
    typeof err === 'object' &&
    err !== null &&
    typeof (err as { code?: unknown }).code === 'number' &&
    (err as { code: number }).code === 11000
  );
};

/**
 * Type guard for a JWT verification failure. `jsonwebtoken` throws
 * errors with a `.name` of either `JsonWebTokenError` (malformed
 * or wrong signature) or `TokenExpiredError` (valid but past its
 * `exp`). Both are 401 responses from the client's perspective,
 * but the messages differ, so we distinguish them.
 */
const isJwtError = (
  err: unknown
): err is { name: 'JsonWebTokenError' | 'TokenExpiredError' } => {
  if (typeof err !== 'object' || err === null) return false;
  const name = (err as { name?: unknown }).name;
  return name === 'JsonWebTokenError' || name === 'TokenExpiredError';
};

/**
 * Type guard for a Mongoose `CastError`. Thrown when a value
 * cannot be cast to the type the schema expects — most commonly
 * when a route parameter that should be an ObjectId is not a
 * valid hex string. The cast failure is a client error, not a
 * server error, so it maps to 400.
 */
const isCastError = (
  err: unknown
): err is { name: 'CastError'; message: string } => {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { name?: unknown }).name === 'CastError'
  );
};

// ============================================================
//  Terminal error middleware
// ============================================================

/**
 * Express error-handling middleware.
 *
 * Express identifies an error handler by the arity of the function
 * — four parameters. The signature here is deliberate and must
 * not be shortened. The `_next` parameter is unused but required
 * for Express to recognise the function as an error handler.
 *
 * Behaviour:
 *
 *   1. Start with a 500 / non-operational default.
 *   2. If the error is an `AppError`, honour its status code and
 *      operational flag.
 *   3. If the error matches a known third-party shape (Mongoose
 *      validation, duplicate key, JWT, cast), translate it into
 *      a friendly message and the correct 4xx status.
 *   4. Log the error. Operational errors log a single line; non-
 *      operational errors log the full stack regardless of
 *      environment.
 *   5. Send the response using the shared `ApiResponse` envelope.
 *      In production, the response body never includes a stack
 *      trace. In development, the stack is added to the `message`
 *      field so it surfaces in the client without a second log
 *      dive.
 */
export const errorHandler = (
  err: Error | AppError,
  _req: Request,
  res: Response<ApiResponse<null>>,
  _next: NextFunction
): void => {
  let statusCode = 500;
  let message = err.message || 'Internal server error';
  let isOperational = false;

  // ---- 1. AppError: respect the throw site's intent ----
  if (err instanceof AppError) {
    statusCode = err.statusCode;
    isOperational = err.isOperational;
  }

  // ---- 2. Mongoose validation ----
  else if (isMongooseValidationError(err)) {
    statusCode = 400;
    const firstError = err.errors
      ? Object.values(err.errors)[0]
      : undefined;
    message =
      firstError?.message ??
      err.message ??
      'Validation failed';
  }

  // ---- 3. Mongo duplicate key ----
  else if (isMongoDuplicateKeyError(err)) {
    statusCode = 409;
    const field = err.keyPattern
      ? Object.keys(err.keyPattern)[0]
      : undefined;
    message = field
      ? `Duplicate value for field "${field}".`
      : 'Duplicate value.';
  }

  // ---- 4. JWT verification failures ----
  else if (isJwtError(err)) {
    statusCode = 401;
    message =
      err.name === 'TokenExpiredError'
        ? 'Session expired. Please log in again.'
        : 'Invalid authentication token.';
  }

  // ---- 5. Mongoose cast errors (bad ObjectId etc.) ----
  else if (isCastError(err)) {
    statusCode = 400;
    message = 'Invalid identifier format.';
  }

  // ---- Log ----
  // Operational errors are expected at their throw sites and get a
  // concise log line. Non-operational errors are programming bugs
  // and always log the full stack, in every environment. The log
  // is not what the client sees — the response below is.
  if (!isOperational || process.env['NODE_ENV'] !== 'production') {
    console.error('Error:', err);
  }

  // ---- Response body ----
  const body: ApiResponse<null> = {
    success: false,
    error: message,
  };

  // In development, append the stack so the client-side error
  // toast carries enough detail for the developer to locate the
  // bug without tailing the server log. Never in production.
if (process.env['NODE_ENV'] === 'development') {
  body.message =
    err instanceof Error && err.stack !== undefined
      ? err.stack
      : message;
}
  res.status(statusCode).json(body);
};

// ============================================================
//  404 handler
// ============================================================

/**
 * Terminal middleware that runs when no route matched. Registered
 * after every real route so it only fires on unmatched paths.
 *
 * The message includes the method and URL so a client developer
 * can see exactly what was requested. The URL is echoed back, not
 * the raw request headers, so no sensitive data leaves the
 * response.
 */
export const notFoundHandler = (
  req: Request,
  res: Response<ApiResponse<null>>,
  _next: NextFunction
): void => {
  const body: ApiResponse<null> = {
    success: false,
    error: `Route ${req.method} ${req.originalUrl} not found`,
  };
  res.status(404).json(body);
};

// ============================================================
//  asyncHandler — safe wrapper for async route handlers
// ============================================================

/**
 * Wraps an async Express handler so that a rejected promise is
 * forwarded to `next` instead of becoming an unhandled rejection.
 *
 * Express 5 does forward a rejected promise returned from a route
 * handler to the error middleware automatically. This wrapper is
 * still used because:
 *
 *   1. It keeps the call sites explicit about the fact that they
 *      can throw. A reader scanning a route file sees
 *      `asyncHandler(async (req, res) => { … })` and immediately
 *      knows the body is a promise-returning function whose
 *      rejections are handled.
 *
 *   2. It normalises the shape of the rejection. Non-Error
 *      rejections (a raw string, a plain object) are wrapped in
 *      an `Error` so the terminal handler never has to guard
 *      against `err.message` being undefined.
 *
 *   3. It keeps the code portable across Express versions. If a
 *      future release stops forwarding rejections, this wrapper
 *      continues to work without a code change.
 *
 * The generic signature preserves the handler's parameter types
 * and return type, so wrapping a handler does not widen its
 * signature or lose the type information of `req` and `res`.
 */
export const asyncHandler = <
  P = Record<string, string>,
  ResBody = unknown,
  ReqBody = unknown,
  ReqQuery = Record<string, string>,
>(
  fn: (
    req: Request<P, ResBody, ReqBody, ReqQuery>,
    res: Response<ResBody>,
    next: NextFunction
  ) => Promise<unknown> | unknown
): ((
  req: Request<P, ResBody, ReqBody, ReqQuery>,
  res: Response<ResBody>,
  next: NextFunction
) => void) => {
  return (req, res, next): void => {
    Promise.resolve(fn(req, res, next)).catch((err: unknown) => {
      // Normalise non-Error rejections into an Error so the
      // terminal handler can rely on `err.message` being present.
      if (err instanceof Error) {
        next(err);
      } else {
        next(new Error(typeof err === 'string' ? err : 'Unknown error'));
      }
    });
  };
};

// ============================================================
//  Default export
// ============================================================

export default {
  AppError,
  errorHandler,
  notFoundHandler,
  asyncHandler,
};