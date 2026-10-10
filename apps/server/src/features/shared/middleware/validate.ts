/**
 * Express-validator wrapper for the WriteSpeare backend.
 *
 * Owns the two middlewares that turn the results of an
 * `express-validator` validation chain into the same
 * `{ success: false, error }` response body that every other
 * error path in the API produces. The plan annotates this file
 * with the four words "express-validator wrapper" (Part 1.2) and
 * lists it in the Part 8.2 security table as the module that
 * enforces "Input validation" on every mutation endpoint.
 *
 * ── Why a wrapper at all ────────────────────────────────────────
 *
 *   `express-validator` is built from two halves: a set of
 *   chain-building functions (`body`, `param`, `query`, `check`)
 *   that collect validation rules, and a `validationResult`
 *   reader that inspects the request after the chains have run.
 *   On its own, the library does not know what a "failed
 *   validation" should look like on the wire. It exposes the
 *   raw result — an array of error objects, each with a `path`,
 *   a `location`, a `value`, and a `msg` — and leaves the shape
 *   of the response to the caller.
 *
 *   Every route in WriteSpeare returns the same envelope on
 *   every other failure path — a 400 from a Mongoose
 *   ValidationError, a 404 from a missing record, a 409 from a
 *   duplicate key. If the validation failures returned a
 *   different shape (the library's raw array, or a bare string,
 *   or a NestJS-style `{ errors: [] }`), the client would have
 *   two unwrapping rules — one for the API's envelope and one
 *   for validation. This wrapper exists so the client has one.
 *
 * ── The two exports ─────────────────────────────────────────────
 *
 *   `validate(validations)`
 *
 *     The primary combinator. Takes an array of `ValidationChain`
 *     instances, returns a single Express `RequestHandler` that,
 *     when mounted on a route, runs all the chains against the
 *     request and then delegates to `handleValidationErrors`.
 *
 *     This is the shape every consumer of the module will want:
 *     one middleware on the route, all the chains collapsed into
 *     a single argument, no per-chain state to thread.
 *
 *     Usage:
 *
 *       router.post(
 *         '/',
 *         validate([
 *           body('email').isEmail().withMessage('email must be valid.'),
 *           body('password').isLength({ min: 8 })
 *             .withMessage('password must be at least 8 characters.'),
 *         ]),
 *         asyncHandler(createUser)
 *       );
 *
 *   `handleValidationErrors`
 *
 *     The terminal middleware. Reads whatever validation results
 *     the request carries — whether they were deposited by a
 *     `validate(...)` call or by hand-attached chains that a
 *     caller mounted directly — and either forwards with
 *     `next()` or terminates with a 400.
 *
 *     It is exported separately for the case where a caller wants
 *     to run the chains themselves and inspect the request
 *     between the chain-run and the error check. That case does
 *     not arise in the current codebase, but the export costs
 *     nothing and the alternative — inlining the error check
 *     into `validate` and closing off the "I want to interleave
 *     something" path — would be a design that a future session
 *     would have to unwind.
 *
 * ── The response body ───────────────────────────────────────────
 *
 *   When a validation fails, the middleware responds with:
 *
 *       {
 *         "success": false,
 *         "error": "<one or more validator messages, joined>"
 *       }
 *
 *   The `error` field is built from the messages the individual
 *   validators supplied via `.withMessage(...)`. If more than one
 *   validator failed, the messages are deduplicated (the same
 *   message can be attached to multiple fields — for example, a
 *   shared "is required" string) and joined with a `"; "`
 *   separator. A single failure produces a single message with no
 *   separator.
 *
 *   Deduplication is deliberate. Express-validator's own
 *   `validationResult.array()` returns one entry per failed
 *   rule per field, so a request missing both `email` and
 *   `password` produces two entries whose messages could be
 *   identical if the caller reused the same string. Joining
 *   without deduping would surface "is required; is required" to
 *   the user — technically correct and useless.
 *
 *   The `ApiResponse<null>` envelope is the same one every other
 *   error path in the API uses. A client that has already
 *   learned to unwrap `{ success, data, error }` needs no second
 *   rule for validation failures.
 *
 * ── The 400 status code ─────────────────────────────────────────
 *
 *   A failed validation is the textbook 400 Bad Request — the
 *   request itself is malformed, and the client must change it
 *   before retrying. The controller's own inline type checks
 *   (see `topicController.ts`, `documentController.ts`, and the
 *   other feature controllers) also return 400 for the same
 *   class of failure. The two layers agree on the status code,
 *   so a client that distinguishes "the server rejected my
 *   request" (400) from "the server had a problem" (500) sees a
 *   single consistent signal regardless of which layer caught
 *   the mistake.
 *
 * ── What this module does NOT do ────────────────────────────────
 *
 *   - It does not define any validation rules. The chains it
 *     receives are built by the caller, with the field names,
 *     formats, and messages that the specific endpoint needs.
 *     The wrapper is agnostic about what is being validated.
 *
 *   - It does not run Zod schemas. Zod is declared as a
 *     dependency and the plan's Part 8.2 table mentions it
 *     alongside express-validator, but this file's annotation is
 *     specifically "express-validator wrapper". A future session
 *     that wanted a Zod-based request parser would add it as a
 *     separate file — the two validation strategies have
 *     different shapes and mixing them in one module would blur
 *     the boundary.
 *
 *   - It does not sanitize input. `express-validator`'s chains
 *     can include `.trim()`, `.escape()`, `.normalizeEmail()`,
 *     and other mutating rules; the wrapper runs the chains
 *     whatever they contain. If a caller's chain includes a
 *     sanitizer, the mutation is applied to `req.body`,
 *     `req.query`, or `req.params` in place — the same
 *     behavior the library produces without this wrapper.
 *
 *   - It does not stop the controller from running. If a
 *     caller's route omits the wrapper entirely — a mistake, but
 *     a possible one — the controller's own inline type checks
 *     are still present and still return 400 for a malformed
 *     body. The wrapper is an additional layer of validation,
 *     not the only layer.
 *
 *   - It does not log. A failed validation is not an error
 *     condition; it is a normal request outcome. The library
 *     does not log by default, and this wrapper does not add
 *     logging. A caller that wanted to audit validation
 *     failures would install an express middleware that reads
 *     the response status, not a change to this file.
 *
 * Dependencies: `express-validator` (runtime, at `^7.2.0`),
 * `express` (types via `@types/express`), and the shared
 * `ApiResponse` envelope from `../types/index.js`.
 */

import { validationResult } from 'express-validator';
import type { ValidationChain } from 'express-validator';

import type {
  NextFunction,
  Request,
  RequestHandler,
  Response,
} from 'express';

import type { ApiResponse } from '../types/index.js';

// ============================================================
//  handleValidationErrors
// ============================================================

/**
 * Terminal middleware that reads the request's accumulated
 * validation results and either forwards to the next handler or
 * terminates with a 400.
 *
 * Behaviour:
 *
 *   1. Calls `validationResult(req)` to collect every error the
 *      chains deposited on the request. The call is synchronous
 *      — the library stores the results on the request as each
 *      chain runs, and this function only reads them.
 *
 *   2. If the result is empty, forwards with `next()`. The
 *      caller's controller runs next in the chain.
 *
 *   3. Otherwise, builds a single message from the collected
 *      errors, deduplicates repeated messages, joins the rest
 *      with `"; "`, and terminates with a 400 whose body is the
 *      shared `ApiResponse<null>` envelope.
 *
 * The middleware never throws. The `validationResult` call is
 * documented to be total over any Express request, and the
 * message-building loop narrows every element of the returned
 * array to a string before using it. A validator whose `msg`
 * was set to a non-string value — which the library permits by
 * leaving the field typed as `any` — is skipped rather than
 * coerced, because a message that is not a string cannot be
 * shown to a user in the `error` field of the envelope.
 *
 * A failure to produce any usable message (every entry in the
 * result had a non-string `msg`, which would require the caller
 * to have built a chain that violated the library's contract)
 * falls back to the literal string `"Validation failed."` — the
 * generic message that at least communicates the class of
 * problem, even when the specifics are unavailable.
 */
export const handleValidationErrors: RequestHandler = (
  req: Request,
  res: Response<ApiResponse<null>>,
  next: NextFunction
): void => {
  const result = validationResult(req);

  // ---- Success path ----
  if (result.isEmpty()) {
    next();
    return;
  }

  // ---- Build the error message ----
  // The `errors` field returned by `.array()` is typed as
  // `ValidationError[]` — a union of four shapes, all of which
  // carry a `msg` field typed as `any` by the library's own
  // declarations. The local `unknown` binding forces the
  // subsequent `typeof` check to be the only path by which the
  // value reaches a string variable, so a `msg` that a caller
  // set to a number, an object, or `undefined` is skipped
  // rather than stringified into something the user cannot read.
  //
  // Deduplication uses a linear scan against the accumulated
  // array. For the sizes involved — a handful of failed rules on
  // a handful of fields — the scan is trivially cheaper than
  // constructing a `Set` and iterating it, and it preserves the
  // order the errors were reported in (which matches the order
  // the chains were declared in, which in turn matches the order
  // the caller wrote them in).
  const messages: string[] = [];
  for (const error of result.array()) {
    const raw: unknown = error.msg;
    if (
      typeof raw === 'string' &&
      raw.length > 0 &&
      !messages.includes(raw)
    ) {
      messages.push(raw);
    }
  }

  const errorText =
    messages.length > 0
      ? messages.join('; ')
      : 'Validation failed.';

  // ---- Response ----
  const body: ApiResponse<null> = {
    success: false,
    error: errorText,
  };

  res.status(400).json(body);
};

// ============================================================
//  validate — the combinator
// ============================================================

/**
 * Wrap one or more `express-validator` chains in a single Express
 * middleware.
 *
 * The returned middleware, when mounted on a route, runs every
 * chain against the incoming request — each `.run(req)` call
 * deposits its errors on the request — and then delegates to
 * `handleValidationErrors` to check the results. A request with
 * no validation failures proceeds to the next handler; a request
 * with any failure is terminated with a 400 and the shared
 * envelope.
 *
 * The chains are run concurrently (`Promise.all`), because the
 * library's chains are independent: each reads the request and
 * writes its own results, with no chain observing another's
 * output. Running them in parallel is safe and marginally faster
 * on a route that carries several chains; the alternative —
 * sequential `for await` over the array — would be observably
 * slower without being observably safer.
 *
 * The wrapper returns a synchronous `RequestHandler` even
 * though its internal work is asynchronous. The returned
 * function kicks off the promise chain, attaches a `.catch`
 * that forwards any unexpected rejection to `next`, and returns
 * `void` — which is what Express's `RequestHandler` type
 * declares and what every other middleware in this codebase
 * follows. A caller that mounted the function on a route sees
 * the same shape it would see from any other middleware; the
 * asynchrony is an implementation detail the route file does
 * not have to know about.
 *
 * @param validations - The chains to run. An empty array is
 *                      legal and produces a middleware that
 *                      always forwards to the next handler —
 *                      useful as a placeholder when a route's
 *                      validation is temporarily disabled, and
 *                      correct on its own terms because there
 *                      is nothing to fail.
 * @returns A `RequestHandler` that runs the chains and either
 *          forwards or responds with a 400.
 */
export const validate = (
  validations: readonly ValidationChain[]
): RequestHandler => {
  return (
    req: Request,
    res: Response<ApiResponse<null>>,
    next: NextFunction
  ): void => {
    // `Promise.all` resolves when every chain has finished
    // depositing its results on the request. The chains are
    // invoked in the order they appear in the array, and each
    // `.run(req)` call is awaited inside the array's map — the
    // `Promise.all` here is what coordinates their completions.
    Promise.all(validations.map((chain) => chain.run(req)))
      .then(() => {
        // All chains ran without throwing. Hand the request to
        // the terminal error check, which either forwards or
        // responds with a 400.
        handleValidationErrors(req, res, next);
      })
      .catch((error: unknown) => {
        // A chain's `.run()` rejected — which would indicate an
        // internal error in the library, not a validation
        // failure (validation failures are ordinary results
        // stored on the request, not rejections). Forwarding to
        // `next` lets the terminal error middleware classify
        // and log the fault.
        next(error);
      });
  };
};

// ============================================================
//  Default export
// ============================================================
//
//  The two middlewares bundled under a single default object,
//  matching the convention used by every other shared utility
//  module in the codebase. A caller that prefers the named form
//  uses `import { validate } from '...'`; a caller that prefers
//  the default form uses `import validation from '...'` and
//  destructures. Both resolve to the same two functions — there
//  is no wrapper and no second construction, so the two forms
//  cannot drift.

export default {
  validate,
  handleValidationErrors,
};