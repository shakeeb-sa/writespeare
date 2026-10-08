/**
 * Bcrypt utility module.
 *
 * Owns the two operations that every consumer of password hashing
 * in the WriteSpeare backend needs: hash a plaintext password, and
 * verify a candidate plaintext against a stored hash. Both are
 * promise-based wrappers around the native `bcrypt` module, which
 * exposes its API through a callback shape that does not compose
 * well with the rest of the codebase's async/await style.
 *
 * Design notes:
 *
 *   - The salt-round count is declared once, here, and used by
 *     both operations. When the auth service hashes a new user's
 *     password, it goes through `hashPassword`; when the same
 *     password is later verified, it goes through
 *     `comparePassword`. A single source for the cost factor
 *     means the two cannot drift apart if the cost is ever
 *     raised — a mismatch there would produce the same
 *     login-silently-fails symptom as a wrong algorithm choice.
 *
 *   - `comparePassword` returns `false` on any failure rather than
 *     throwing. A login endpoint must not leak the difference
 *     between "wrong password" and "malformed hash on disk" — both
 *     are simply "not this user's password" from the client's
 *     perspective. A thrown exception would be caught higher up
 *     and, if handled naively, would produce a 500 instead of a
 *     401 for the wrong-password case, which is an information
 *     leak about the user record's state.
 *
 *   - `hashPassword` DOES throw on failure. A failure to hash
 *     means the account cannot be created at all, and the caller
 *     must know. Silently returning an empty string would write a
 *     user with an unusable hash — a state the login path would
 *     then never be able to recover from.
 */

import bcrypt from 'bcrypt';

// ============================================================
//  Configuration
// ============================================================

/**
 * Cost factor for the bcrypt hashing algorithm.
 *
 * Ten is the widely accepted default as of the current state of
 * commodity hardware: roughly 50–100 ms per hash on a modern CPU,
 * which is well below the threshold a user would notice during
 * login and well above the threshold that makes a brute-force
 * attack against a stolen hash database impractical at scale.
 *
 * Raising this value increases both hash time and verification
 * time linearly in `2^rounds`. Any change here must be paired
 * with a plan for re-hashing existing users on next login, since
 * old hashes remain verifiable (bcrypt stores the cost factor in
 * the hash itself), but new logins would continue to use the old
 * cost until each user's password is changed.
 */
const SALT_ROUNDS = 10;

// ============================================================
//  Public API
// ============================================================

/**
 * Hash a plaintext password.
 *
 * Returns the bcrypt hash string, which is safe to store verbatim
 * in the database. The returned value is salted internally by
 * bcrypt — no separate salt column exists or is needed, because
 * the salt is embedded in the hash string itself.
 *
 * Throws on any failure (invalid input, entropy unavailable on
 * the host, native module misbehaviour). Callers must treat a
 * throw here as a fatal error for the operation in progress:
 * the user record cannot be safely created.
 *
 * @param plainText - The user-supplied password.
 */
export const hashPassword = async (plainText: string): Promise<string> => {
  try {
    const salt = await bcrypt.genSalt(SALT_ROUNDS);
    const hash = await bcrypt.hash(plainText, salt);
    return hash;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to hash password: ${reason}`);
  }
};

/**
 * Verify a candidate plaintext password against a stored bcrypt
 * hash.
 *
 * Returns `true` when the candidate matches, `false` in every
 * other case — a mismatched password, a malformed or truncated
 * hash stored on disk, or an unexpected error from the native
 * module. The uniform `false` response is deliberate: a login
 * endpoint must not distinguish between these cases in its
 * response, so the helper does not expose the distinction either.
 *
 * Never throws. A caller that writes `if (await comparePassword(…))`
 * never has to guard against an exception, which keeps the auth
 * flow linear and easy to reason about.
 *
 * @param plainText - The candidate password from the login form.
 * @param hashed    - The stored hash from the user document.
 */
export const comparePassword = async (
  plainText: string,
  hashed: string
): Promise<boolean> => {
  try {
    return await bcrypt.compare(plainText, hashed);
  } catch {
    return false;
  }
};

// ============================================================
//  Default export
// ============================================================

export default {
  hashPassword,
  comparePassword,
};