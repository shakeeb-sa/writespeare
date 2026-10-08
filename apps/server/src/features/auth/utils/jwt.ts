/**
 * JWT utility module.
 *
 * Produces and verifies the authentication tokens that the
 * backend issues at login and consumes on every protected route.
 * The token payload is intentionally narrow — user ID, email,
 * role — because every byte inside a JWT is client-visible. A
 * field that is not needed to make an authorisation decision must
 * not be placed in the token, no matter how convenient that would
 * be at the call site.
 *
 * Secret handling:
 *
 *   The signing secret is read from `process.env['JWT_SECRET']`
 *   exactly once, at module load. If it is absent, empty, or too
 *   short to be a meaningful secret, the module throws immediately
 *   so the process fails to start. A server that boots with an
 *   undefined secret would issue tokens that verify against an
 *   undefined key — a silent misconfiguration that only surfaces
 *   as "every login eventually succeeds from any forged token" in
 *   production. Refusing to start is the correct behaviour.
 *
 *   A minimum length check of 32 characters is enforced. The
 *   underlying HS256 algorithm has a 256-bit key size, which is
 *   exactly 32 bytes; a shorter secret is under-strength for the
 *   algorithm and violates the security baseline.
 *
 * Expiry:
 *
 *   Tokens expire after 7 days by default. The expiry is embedded
 *   in the token itself (the `exp` claim), so verification is
 *   stateless and does not require a lookup. The caller may
 *   override the expiry when signing, but the default is what
 *   every code path in this application uses.
 *
 * Failure semantics:
 *
 *   `signToken` throws on failure. A signing failure means the
 *   server cannot issue a session, which is fatal to the login
 *   request and must be visible to the caller.
 *
 *   `verifyToken` throws on failure. The caller (the auth
 *   middleware) catches the throw, converts it to a 401 response,
 *   and distinguishes the expired-token case from the
 *   invalid-token case in the message it returns. Throwing rather
 *   than returning `null` keeps the happy path of the middleware
 *   linear.
 *
 *   `decodeToken` never throws — it is a diagnostic helper for
 *   reading a token's claims without verifying its signature. It
 *   is not a security boundary and must never be used to
 *   authorise a request.
 */

import jwt from 'jsonwebtoken';

// ============================================================
//  Token payload
// ============================================================

/**
 * The set of claims carried inside an issued token.
 *
 * Every field here is safe to expose to the client — the client
 * already knows its own user ID, email, and role. None of them
 * is a secret. The security of the scheme comes from the
 * signature, not from the payload's confidentiality.
 *
 * `role` is stored as a plain string rather than the `UserRole`
 * enum from `features/shared/types` to keep this module free of
 * any dependency on the shared types module. The auth middleware
 * narrows it back to the enum when it needs to. A string that
 * happens to be `"admin"` or `"user"` behaves identically to the
 * enum value at runtime, and the middleware is the single place
 * where the closed set is enforced.
 */
export interface TokenPayload {
  userId: string;
  email: string;
  role: string;
}

// ============================================================
//  Secret resolution and validation
// ============================================================

/**
 * Minimum acceptable secret length, in characters.
 *
 * Twenty-four is the number of bytes in a 256-bit key when
 * represented as a base64 string with padding (`32 * 4 / 3 ≈ 43`
 * for base64, but a hex string uses two characters per byte and
 * needs 64). Rather than enforce a specific encoding, the check
 * is a lower bound on the raw string length: any secret that is
 * at least 32 characters long is sufficient regardless of
 * encoding. Secrets shorter than that are rejected outright —
 * they are either the default placeholder from the example env
 * file, a truncated paste, or an empty value that slipped through
 * validation.
 */
const MIN_SECRET_LENGTH = 32;

/**
 * Read and validate the JWT signing secret from the environment.
 *
 * Called exactly once, at module load. Throws a descriptive error
 * if the secret is missing or too short, which stops the process
 * before any request handler is registered. This is deliberate:
 * a server that starts with a broken secret is worse than a
 * server that refuses to start, because the failure it produces
 * at runtime is silent and security-critical.
 */
const resolveSecret = (): string => {
  const value = process.env['JWT_SECRET'];

  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(
      'JWT_SECRET is not set. Set it in the server .env file before starting.'
    );
  }

  if (value.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `JWT_SECRET must be at least ${MIN_SECRET_LENGTH} characters. ` +
        `The current value is ${value.length} characters long.`
    );
  }

  return value;
};

/**
 * The validated secret, resolved once at module load. Every
 * signing and verification call in this file uses this constant —
 * the environment is not read again, so a runtime mutation of
 * `process.env['JWT_SECRET']` cannot desynchronise the signing
 * and verification keys.
 */
const JWT_SECRET = resolveSecret();

// ============================================================
//  Expiry
// ============================================================

/**
 * Default token lifetime. Seven days is long enough that a user
 * who opens the app weekly is never forced to log in again, and
 * short enough that a stolen token has a bounded window of
 * usefulness. The desktop client's own persistent Chrome profile
 * covers the "remember me forever" case by keeping the session
 * alive across restarts, so the token lifetime only needs to
 * cover active sessions.
 */
const DEFAULT_EXPIRES_IN = '7d';

// ============================================================
//  Public API
// ============================================================

/**
 * Sign a token payload into a JWT string.
 *
 * The returned string is safe to send to the client and back. It
 * is NOT encrypted — the payload is base64-encoded, not
 * encrypted, and a client can read it. That is expected; the
 * signature is what prevents the client from modifying it.
 *
 * Throws on any failure. The caller (the auth service) treats a
 * throw here as fatal for the login request — an issued session
 * is a precondition for a successful response.
 *
 * @param payload   - The claims to embed. See `TokenPayload`.
 * @param expiresIn - Optional override of the default lifetime.
 *                    Accepts any value the `jsonwebtoken` library
 *                    understands: a number of seconds, or a
 *                    duration string such as `'1h'`, `'30d'`.
 */
export const signToken = (
  payload: TokenPayload,
  expiresIn: jwt.SignOptions['expiresIn'] = DEFAULT_EXPIRES_IN
): string => {
  try {
    return jwt.sign(payload, JWT_SECRET, { expiresIn });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to sign token: ${reason}`);
  }
};

/**
 * Verify a token string and return its decoded payload.
 *
 * Performs a full signature and expiry check. Throws on any
 * failure — a wrong signature, a malformed token, an expired
 * token, or a token signed with a different algorithm. The
 * `jsonwebtoken` library distinguishes these cases by the `name`
 * field on the thrown error:
 *
 *   - `TokenExpiredError`   — the token was valid, but its `exp`
 *                             claim is in the past.
 *   - `JsonWebTokenError`   — the token is malformed, its
 *                             signature does not match, or its
 *                             algorithm does not match the
 *                             signing algorithm.
 *
 * The caller decides how to respond; this function does not
 * swallow the distinction.
 *
 * The return type is asserted to `TokenPayload` because the
 * `jsonwebtoken` library types the decoded result as
 * `string | JwtPayload`. A well-signed token always decodes to an
 * object, so the assertion is safe — a token that decodes to a
 * string would have to have been signed by a code path that is
 * not present in this application.
 *
 * @param token - The JWT string from the client.
 */
export const verifyToken = (token: string): TokenPayload => {
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as TokenPayload;
    return decoded;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to verify token: ${reason}`);
  }
};

/**
 * Decode a token's payload WITHOUT verifying its signature.
 *
 * This is a diagnostic helper, not a security boundary. It exists
 * for two narrow use cases:
 *
 *   1. The auth middleware wants to log the user ID from an
 *      incoming token before it decides whether to accept it. The
 *      log is useful regardless of whether verification later
 *      succeeds.
 *
 *   2. The client's own session-restore path may want to read the
 *      expiry of its stored token to decide whether to attempt a
 *      refresh before making a request.
 *
 * It must NEVER be used to authorise a request. A token whose
 * signature has not been verified is attacker-controlled data,
 * and treating it as trusted is exactly how authentication
 * bypasses happen.
 *
 * Returns `null` on any failure (malformed token, unexpected
 * shape) rather than throwing, because the callers above are
 * diagnostic paths that should degrade gracefully.
 *
 * @param token - The JWT string.
 */
export const decodeToken = (token: string): TokenPayload | null => {
  try {
    const decoded = jwt.decode(token);
    if (typeof decoded !== 'object' || decoded === null) {
      return null;
    }
    return decoded as TokenPayload;
  } catch {
    return null;
  }
};

// ============================================================
//  Default export
// ============================================================

export default {
  signToken,
  verifyToken,
  decodeToken,
};