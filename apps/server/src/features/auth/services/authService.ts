/**
 * Authentication service.
 *
 * Provides the two operations that the auth controller needs from
 * the business layer: verify a set of credentials and issue a
 * token, and read a user by ID. Both return a projection of the
 * user document that omits the password hash — the same
 * `PublicUser` shape — so that every path a user object takes to
 * the client passes through one projection function.
 *
 * Error handling:
 *
 *   The service throws `AppError` with a deliberate HTTP status
 *   code at each failure path. `AppError` is the shared error
 *   vocabulary of the backend; the terminal error middleware
 *   recognises it and honours the status code without needing
 *   any service-specific translation. The controller therefore
 *   only has to call `next(err)` when a service throws — it does
 *   not classify the error itself.
 *
 *   Unexpected failures (a database outage, a malformed ObjectId
 *   reaching `findById`) are NOT wrapped. They propagate as raw
 *   errors, which the middleware treats as non-operational 500s
 *   and logs with the full stack. This is the correct behaviour:
 *   a bug in the service should be visible, not sanitised into a
 *   misleading 4xx response.
 *
 * Credential verification order:
 *
 *   The password comparison happens BEFORE the active-status
 *   check. This is deliberate. If the active check ran first,
 *   an attacker could learn the existence of any deactivated
 *   account by submitting any password — the response would
 *   differ from the "unknown email" case. Running the password
 *   check first means the "account deactivated" response is only
 *   ever returned to a caller who has already proven ownership
 *   of the account. This is the same information-leak avoidance
 *   that produces the shared "Invalid email or password" message
 *   for both the unknown-email and wrong-password cases.
 */

import { UserModel, type UserDocument } from '../models/User.js';
import { comparePassword } from '../utils/bcrypt.js';
import { signToken } from '../utils/jwt.js';
import type { User } from '../../shared/types/index.js';
import { AppError } from '../../shared/middleware/errorHandler.js';

// ============================================================
//  Public projection
// ============================================================

/**
 * The shape of a user object as it crosses the API boundary.
 *
 * Defined as a local alias so the two public functions in this
 * file have a single, named return type — a reader scanning the
 * signatures does not have to re-derive what "user without the
 * password hash" means. The alias is exported so the controller
 * (and any future consumer) can reference the same type without
 * re-declaring it.
 */
export type PublicUser = Omit<User, 'passwordHash'>;

/**
 * Project a full user document into the client-safe shape.
 *
 * Explicitly lists every field rather than destructuring and
 * omitting the hash. An explicit projection fails loudly at
 * compile time if a field is added to the `User` interface and
 * this function is not updated — which is what we want, because
 * a new field on a user record is exactly the kind of change that
 * deserves a deliberate decision about whether it should be
 * visible over the API.
 *
 * The password hash is never referenced here, and the schema's
 * `select: false` on that field means most callers could not read
 * it even if they tried. The projection is the second of the two
 * independent guards against leaking it.
 */
const toPublicUser = (doc: UserDocument): PublicUser => {
  return {
    _id: doc._id,
    email: doc.email,
    role: doc.role,
    active: doc.active,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
};

// ============================================================
//  loginUser
// ============================================================

/**
 * Verify a set of credentials and issue an authentication token.
 *
 * Flow:
 *
 *   1. Normalize the submitted email — trim whitespace, lowercase
 *      — so a client that capitalizes the first letter of the
 *      address still authenticates. The schema lowercases on
 *      store, so a query that did not also normalize would miss.
 *
 *   2. Look up the user by email, explicitly requesting the
 *      `passwordHash` field. The schema marks it `select: false`,
 *      which excludes it from every default query; the `+` prefix
 *      on the projection opts in for this single call.
 *
 *   3. If no user exists, throw an `AppError(401)` with the
 *      generic "Invalid email or password" message. The same
 *      message is used for a wrong password further down. A
 *      caller cannot distinguish the two cases from the response.
 *
 *   4. Verify the submitted password against the stored hash
 *      using the timing-safe comparison in `comparePassword`. A
 *      mismatch throws the same generic `AppError(401)`.
 *
 *   5. Only AFTER the password has been verified, check the
 *      `active` flag. A deactivated account throws
 *      `AppError(403)` with a distinct message, because the
 *      caller has now proven they own the account and it is
 *      correct to tell them why login is being refused. See the
 *      file header for the ordering rationale.
 *
 *   6. Sign a token carrying the user's ID, email, and role, and
 *      return it alongside the projected user object.
 *
 * The email lookup normalizes both sides. The comparison is
 * case-sensitive at the driver level, but the input has already
 * been lowercased and the stored value was lowercased by the
 * schema on write, so the two sides always meet at the same
 * case.
 *
 * @param email    - The email submitted by the client.
 * @param password - The plaintext password submitted by the client.
 */
export const loginUser = async (
  email: string,
  password: string
): Promise<{ token: string; user: PublicUser }> => {
  const normalizedEmail = email.trim().toLowerCase();

  const user = await UserModel.findOne({ email: normalizedEmail }).select(
    '+passwordHash'
  );

  if (!user) {
    throw new AppError('Invalid email or password', 401);
  }

  // The document type declares `passwordHash: string`, and the
  // projection above selected it. A type guard is not needed —
  // a well-formed document always carries the field at this point,
  // and a malformed one (a raw write bypassing the schema) would
  // present as an empty string here, which the comparison below
  // fails cleanly.
  const isPasswordCorrect = await comparePassword(
    password,
    user.passwordHash
  );
  if (!isPasswordCorrect) {
    throw new AppError('Invalid email or password', 401);
  }

  if (!user.active) {
    throw new AppError(
      'Account is deactivated. Please contact an administrator.',
      403
    );
  }

  const token = signToken({
    userId: user._id.toString(),
    email: user.email,
    role: user.role,
  });

  return { token, user: toPublicUser(user) };
};

// ============================================================
//  getUserById
// ============================================================

/**
 * Read a user by their ID and return the client-safe projection.
 *
 * Returns `null` when no user with that ID exists. The caller is
 * responsible for converting the null into whatever response is
 * appropriate for their endpoint — the `/me` route turns it into
 * a 404, but a caller that treats "no user" as an expected state
 * (an idempotent delete, for example) can consume the null
 * directly.
 *
 * The function does NOT catch cast errors from a malformed ID.
 * A non-hexadecimal string reaching `findById` throws a
 * `CastError`, and that error propagates to the terminal
 * middleware, which maps it to a 400. This is deliberate: a
 * malformed ID is a client error, not a "user not found" case,
 * and treating the two identically would mask a client bug.
 *
 * @param userId - The user ID to look up.
 */
export const getUserById = async (
  userId: string
): Promise<PublicUser | null> => {
  const user = await UserModel.findById(userId);
  if (!user) {
    return null;
  }
  return toPublicUser(user);
};

// ============================================================
//  Default export
// ============================================================

export default {
  loginUser,
  getUserById,
};