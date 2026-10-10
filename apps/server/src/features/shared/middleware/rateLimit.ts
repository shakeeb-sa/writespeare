/**
 * Rate limiting middleware for the WriteSpeare backend.
 *
 * Three pre-configured limiters, exported so that every route
 * file mounts a limiter from one place rather than constructing
 * its own. The plan's Part 1.2 file tree annotates this module
 * with "Rate limiters (login, register)", and the Part 8.2
 * security table gives the login threshold as "5 login attempts
 * per 15 minutes per IP". Those two facts define the shape of
 * this file: three exported limiter instances, one for the login
 * endpoint, one for account creation, and one general-purpose
 * ceiling for the whole API surface.
 *
 * ── Why `express-rate-limit` ────────────────────────────────────
 *
 *   The library is the standard rate limiter for Express, is
 *   already declared as a dependency of this project at
 *   `^7.5.0`, and its v7 API provides the two features this
 *   middleware actually needs:
 *
 *     1. A sliding window keyed on a caller-supplied key
 *        (defaulting to the client's IP address, which is what
 *        every limiter here relies on).
 *
 *     2. A configurable response body so the 429 that a limited
 *        caller receives is the same `{ success, error }`
 *        envelope that every other response in the API uses.
 *
 *   An in-process store — which is what the library's default
 *   `MemoryStore` provides — is correct for the current
 *   deployment. The backend is a single process on Vercel, and
 *   the plan does not describe a multi-instance topology where
 *   the counters would need to be shared. If a future session
 *   runs the backend across multiple instances, the correct
 *   change is to swap the store for a Redis-backed one via the
 *   library's `store` option; the limiter configurations below
 *   are unchanged by that swap.
 *
 * ── The three limiters and their thresholds ─────────────────────
 *
 *   loginLimiter
 *     Window:   15 minutes
 *     Limit:    5 attempts per window per IP
 *     Rationale:
 *       The plan's Part 8.2 security table names this exact
 *       configuration. Five attempts in fifteen minutes allows
 *       a user who mistypes their password a few times to
 *       recover without friction, while making a brute-force
 *       attack against a short password impractical — a
 *       dictionary of ten thousand candidates would take more
 *       than two weeks per IP address to exhaust.
 *
 *   registerLimiter
 *     Window:   60 minutes
 *     Limit:    10 attempts per window per IP
 *     Rationale:
 *       Account creation is an infrequent operation, and the
 *       current product gates it behind the admin role (users
 *       are created through `POST /api/users`, not a public
 *       self-registration endpoint). Ten in an hour gives an
 *       administrator performing an initial bulk import enough
 *       headroom to create a small team's accounts in one
 *       sitting, while still capping an automated attacker who
 *       somehow obtained an admin token to a slow drip rather
 *       than a flood. The window is longer than the login
 *       window because the operation is rarer; the rate is
 *       deliberately similar (10/hr vs 20/hr) because both are
 *       "do a discrete thing" operations whose abuse would be
 *       measured in hundreds or thousands of automated hits.
 *
 *   apiLimiter
 *     Window:   15 minutes
 *     Limit:    300 requests per window per IP
 *     Rationale:
 *       A general ceiling on the whole API. The desktop app is
 *       the only intended client, and its busiest interaction —
 *       opening a topic detail page that fires the topic,
 *       documents, articles, reports, and settings fetches in
 *       parallel — is on the order of ten requests. Even a user
 *       navigating rapidly through topics and back could not
 *       plausibly reach three hundred requests in fifteen
 *       minutes of normal work. Three hundred is set high
 *       enough that a legitimate session never sees a 429 and
 *       low enough that a script iterating through the API at
 *       machine speed is capped within seconds of starting.
 *
 * ── The 429 response body ───────────────────────────────────────
 *
 *   Every limiter is configured with a `message` object of the
 *   shape `{ success: false, error: string }` — the shared
 *   `ApiResponse<null>` envelope that every other response in
 *   the API uses. `express-rate-limit` sends the `message`
 *   verbatim as the 429 response body, so a limited caller
 *   receives the same envelope shape it would receive from any
 *   other error path. The client's response interceptor
 *   unwraps the envelope without a special case for the
 *   rate-limit status code.
 *
 *   The `error` string in each body is written for a user to
 *   read: it names what happened ("Too many login attempts"),
 *   and the login limiter's string adds a duration
 *   ("…try again in a few minutes") so a user who has been
 *   locked out knows whether to retry or to stop.
 *
 * ── The header configuration ────────────────────────────────────
 *
 *   `standardHeaders: true` instructs the library to emit the
 *   `RateLimit-*` headers on every response — including the
 *   successful ones, not just the 429. These headers advertise
 *   the current limit, the remaining count, the window's reset
 *   time, and (in draft-7) whether the request was allowed. A
 *   future client that wanted to back off gracefully before
 *   hitting the limit can read them; today, no client does, but
 *   the headers cost nothing to send and are the modern
 *   convention.
 *
 *   `legacyHeaders: false` disables the older `X-RateLimit-*`
 *   headers that some deployments still consume. The WriteSpeare
 *   desktop app does not read either set, and shipping two
 *   header schemes is noise. A future client that needed the
 *   legacy names would flip this to `true`; the change is one
 *   line and does not affect the limiter's counting behaviour.
 *
 * ── What this module does NOT do ────────────────────────────────
 *
 *   - It does not mount itself on any route. Mounting is the
 *     route file's job. `authRoutes.ts` mounts `loginLimiter`
 *     on `POST /api/auth/login`; `userRoutes.ts` mounts
 *     `registerLimiter` on `POST /api/users`; and a future
 *     session that wanted a global limiter would mount
 *     `apiLimiter` on the app factory in `app.ts`. This module
 *     only constructs the instances.
 *
 *   - It does not identify callers by anything other than IP.
 *     The default `keyGenerator` uses `req.ip`, which Express
 *     populates from the socket's remote address (or, when the
 *     `trust proxy` setting is enabled, from the
 *     `X-Forwarded-For` header). The WriteSpeare backend does
 *     not enable `trust proxy` today, so the value is the
 *     direct socket address on the local development server
 *     and, on Vercel, the address the serverless function
 *     observes after the platform's own proxy. A future
 *     deployment behind an additional reverse proxy would need
 *     to set `trust proxy` in `app.ts` for the keyed value to
 *     reflect the true client; that setting is the app
 *     factory's concern, not this module's.
 *
 *   - It does not distinguish successful login attempts from
 *     failed ones. The plan's Part 8.2 says "5 login attempts",
 *     not "5 failed attempts", and the current configuration
 *     counts every request. A user who logs in successfully
 *     still consumes one of their five attempts, but five
 *     successful logins in fifteen minutes is not a state any
 *     real user reaches — the authentication flow stores a
 *     seven-day token, and a client that had to log in five
 *     times in fifteen minutes has a bug elsewhere. Counting
 *     every request is simpler and matches the plan's wording.
 *     A future session that wanted to skip successes would set
 *     `skipSuccessfulRequests: true` on the login limiter and
 *     accept that the library's "successful" determination is
 *     based on the response status, not on the authentication
 *     outcome — the current login endpoint returns 200 for a
 *     successful login and 401 for a failure, so the library's
 *     default interpretation is already correct.
 *
 *   - It does not log. The library does not log by default, and
 *     this module does not add logging. A production deployment
 *     that wanted to alert on a rate-limit hit would hook the
 *     limiter's `handler` option — a caller-supplied callback
 *     invoked when a request is rejected — and forward to
 *     whatever monitoring the deployment uses. The current
 *     configuration does not install a custom handler; the
 *     library's default handler is what sends the `message`
 *     body.
 *
 * Dependencies: `express-rate-limit` (runtime dependency, at
 * `^7.5.0` in `apps/server/package.json`), `express` (types via
 * `@types/express`), and the shared `ApiResponse` envelope from
 * `../types/index.js`.
 */

import rateLimit from 'express-rate-limit';

import type { ApiResponse } from '../types/index.js';

// ============================================================
//  Shared configuration
// ============================================================
//
//  The three limiters below share four configuration values —
//  the response envelope shape, the header scheme, and the two
//  options that control how the library reports its state. They
//  are declared here as a single object rather than repeated in
//  each limiter, so a future change to the header convention or
//  to the response shape is a one-line edit that propagates to
//  every limiter at once.

/**
 * The `429` response body shape, minus the human-readable
 * message. Every limiter spreads this object into its own
 * `message` option and adds an `error` string naming the
 * specific limit that was hit.
 *
 * Typed as `Pick<ApiResponse<null>, 'success'>` — an object with
 * exactly one property, `success: false` — so that the spread
 * below type-checks against the envelope shape without
 * duplicating the literal. The `error` string is added by each
 * limiter individually because it is the one field that varies.
 */
const RATE_LIMIT_ENVELOPE_BASE: Pick<ApiResponse<null>, 'success'> = {
  success: false,
};

/**
 * The configuration options that every limiter shares. The two
 * threshold options (`windowMs` and `limit`) are NOT part of
 * this object — they differ per limiter and are set at the call
 * site. Everything that is common across all three limiters
 * lives here.
 */
const SHARED_LIMITER_OPTIONS = {
  /**
   * Emit the modern `RateLimit-*` headers on every response —
   * both the successful ones and the 429. The plan does not
   * require a client to read them, but they are the current
   * convention and their absence would be more surprising than
   * their presence.
   */
  standardHeaders: true,

  /**
   * Suppress the older `X-RateLimit-*` headers. See the file
   * header for the reasoning; the short version is that shipping
   * two header schemes for a client that reads neither is noise.
   */
  legacyHeaders: false,

  /**
   * Ask the library to emit a warning at startup if it detects
   * a configuration that is likely to misbehave behind a proxy —
   * specifically, if the environment appears to set
   * `X-Forwarded-For` but the Express app has not been told to
   * trust the proxy. The warning is diagnostic: it tells a
   * deployment operator that the IP key the limiter uses may be
   * the proxy's IP rather than the client's, which would cause
   * the limiter to count every client as one caller.
   *
   * The check is enabled here — the default — because the
   * WriteSpeare backend runs both behind a local development
   * server (no proxy, no warning) and on Vercel (a proxy, where
   * the warning is the correct prompt to verify the
   * `trust proxy` setting). A deployment that has verified its
   * proxy configuration and does not want the warning would set
   * this to `false`; the current configuration leaves it on so
   * that a future deployment is nudged in the right direction.
   */
  validate: {
    xForwardedForHeader: true,
  },
} as const;

// ============================================================
//  loginLimiter
// ============================================================

/**
 * Rate limiter for `POST /api/auth/login`.
 *
 * Five attempts per fifteen minutes per IP address, matching the
 * threshold the plan's Part 8.2 security table declares. A user
 * who mistypes their password a few times stays under the limit
 * and never sees a 429; a brute-force attacker hits the limit
 * within seconds and stays blocked for the remainder of the
 * window.
 *
 * The 429 body's `error` string names the operation and
 * advises a delay. It is deliberately vague about the exact
 * duration — "in a few minutes" rather than "in 12 minutes and
 * 43 seconds" — because exposing the exact reset time lets an
 * attacker schedule their next attempt precisely and because
 * a user who is about to wait does not need second-level
 * precision.
 *
 * The limiter counts every request to the login route,
 * successful or not — see the file header for why the plan's
 * "attempts" wording maps onto that behaviour and not onto a
 * success-skipping variant.
 */
export const loginLimiter = rateLimit({
  ...SHARED_LIMITER_OPTIONS,

  /** 15 minutes, in milliseconds. */
  windowMs: 15 * 60 * 1000,

  /** Five requests per window per IP. */
  limit: 5,

  /**
   * The 429 response body. Sent verbatim by the library as the
   * JSON body of the response. The `error` string is what the
   * renderer's `useAuth` hook displays in the login form's error
   * banner when a user is rate-limited.
   */
  message: {
    ...RATE_LIMIT_ENVELOPE_BASE,
    error:
      'Too many login attempts. Please try again in a few minutes.',
  },
});

// ============================================================
//  registerLimiter
// ============================================================

/**
 * Rate limiter for account-creation endpoints — currently
 * `POST /api/users` (the admin panel's create-user route), and
 * any future self-registration endpoint.
 *
 * Ten attempts per sixty minutes per IP address. See the file
 * header's "registerLimiter" section for the threshold
 * rationale: account creation is an infrequent operation with
 * a legitimate bulk-use case, and the limiter is sized to allow
 * a small batch of admin-driven account creations in one
 * sitting while capping automated abuse.
 *
 * The name `registerLimiter` follows the plan's Part 1.2
 * annotation ("Rate limiters (login, register)") even though
 * the current product has no self-registration endpoint. The
 * name matches the plan's vocabulary, and the first route it is
 * mounted on — the admin create-user route — is the closest
 * thing the product has to a registration path today. A future
 * session that adds a public signup route mounts the same
 * limiter there without renaming anything.
 */
export const registerLimiter = rateLimit({
  ...SHARED_LIMITER_OPTIONS,

  /** 60 minutes, in milliseconds. */
  windowMs: 60 * 60 * 1000,

  /** Ten requests per window per IP. */
  limit: 10,

  /**
   * The 429 response body. The `error` string is what the admin
   * panel's `UserForm` toast displays when an administrator
   * exceeds the creation rate — a rare event that indicates
   * either a scripted flow gone wrong or a legitimate bulk
   * import that has been capped.
   */
  message: {
    ...RATE_LIMIT_ENVELOPE_BASE,
    error:
      'Too many account-creation requests. Please try again later.',
  },
});

// ============================================================
//  apiLimiter
// ============================================================

/**
 * General-purpose rate limiter for the API surface.
 *
 * Three hundred requests per fifteen minutes per IP address —
 * approximately twenty per minute. See the file header's
 * "apiLimiter" section for the threshold rationale: high enough
 * that no legitimate client interaction is throttled, low
 * enough that a machine-speed loop through the API is capped
 * within seconds.
 *
 * This limiter is not mounted anywhere in the current codebase.
 * The plan's Part 1.2 file tree declares it as an export, and
 * the plan's design places the rate-limiting decision on each
 * route file: the login and register limiters are mounted on
 * their specific routes because those operations have tighter
 * thresholds, and a general limiter on the whole `/api` surface
 * would be mounted on the app factory in `app.ts` if a future
 * session decided the API needs a global ceiling. Until then,
 * this export is a constructed-but-unmounted limiter — its
 * existence in the module is the plan's declaration, and its
 * mount point is a separate decision that the current session
 * does not have to make.
 *
 * The 429 body's `error` string is the general variant. It does
 * not name a specific operation because it is not tied to one;
 * a caller who hits this limit has issued too many requests of
 * whatever kind the request was.
 */
export const apiLimiter = rateLimit({
  ...SHARED_LIMITER_OPTIONS,

  /** 15 minutes, in milliseconds. */
  windowMs: 15 * 60 * 1000,

  /** Three hundred requests per window per IP. */
  limit: 300,

  /**
   * The 429 response body. The `error` string is the fallback
   * that every client at every level can display without any
   * context beyond "the API refused my request".
   */
  message: {
    ...RATE_LIMIT_ENVELOPE_BASE,
    error:
      'Too many requests. Please slow down and try again shortly.',
  },
});

// ============================================================
//  Default export
// ============================================================
//
//  The three limiters bundled under a single default object,
//  matching the convention used by every other shared utility
//  module in the codebase. A caller that prefers the named form
//  uses `import { loginLimiter } from '...'`; a caller that
//  prefers the default form uses
//  `import rateLimits from '...'` and destructures. Both resolve
//  to the same three instances — there is no wrapper and no
//  second construction, so the two forms cannot drift.

export default {
  loginLimiter,
  registerLimiter,
  apiLimiter,
};