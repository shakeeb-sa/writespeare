/**
 * Business logic for the WriteSpeare users feature.
 *
 * This is the admin-oriented CRUD service for the User collection.
 * It provides five operations used by the admin panel: list, read
 * one, create, partial update, and delete.
 *
 * The relationship to `authService.ts`:
 *
 *   The auth feature already has a service (`authService.ts`)
 *   that exposes two operations on the User collection:
 *   `loginUser` (verify credentials, issue a token) and
 *   `getUserById` (read a user for the `/me` endpoint). Both are
 *   login-focused and ownership-scoped — they answer questions
 *   about the caller themselves.
 *
 *   This service is different in purpose. It is admin-focused:
 *   it answers questions about OTHER users, on behalf of an
 *   administrator. The operations it exposes are the ones an
 *   admin panel needs: browse the user list, create a new
 *   account, edit someone's role or active status, remove an
 *   account.
 *
 *   The two services operate on the same collection but with
 *   different contracts, and they are deliberately kept in
 *   different feature folders. Merging them would force a single
 *   service to serve two purposes with different authorization
 *   rules — a shape that tends to produce bugs at the boundary.
 *
 * The ownership model — this service is NOT ownership-scoped:
 *
 *   Every OTHER service in this codebase takes the caller's
 *   `userId` as its first argument and uses it to filter queries
 *   against the caller's own data. That is how topics, documents,
 *   articles, reports, settings, and presets all enforce
 *   isolation: a user can only see and mutate their own records.
 *
 *   This service is the exception. Its operations target
 *   ARBITRARY users, not the caller's own records. The `userId`
 *   argument on `getUserById`, `updateUser`, and `deleteUser` is
 *   the TARGET user's id — the record being acted upon. The
 *   caller's identity is not passed to this service at all.
 *
 *   That shift is deliberate. An admin editing another user's
 *   account is the entire point of the feature; ownership-scoping
 *   the queries here would make the service useless. The
 *   authorization contract is instead:
 *
 *     1. The controller applies `requireAdmin` middleware, which
 *        rejects any request whose caller is not an admin. A
 *        non-admin cannot reach these operations at all.
 *
 *     2. Every route that serves this service is admin-only. The
 *        route file (`userRoutes.ts`) is where that invariant is
 *        enforced at the framework level.
 *
 *     3. The service trusts its caller. It does not re-verify
 *        authorization, because authorization is not something
 *        the service can check — it has no way of knowing whether
 *        the "target userId" it received corresponds to the
 *        caller or to someone else. That distinction is a
 *        controller-level concern, and the controller already
 *        handles it correctly by refusing to route non-admin
 *        requests here at all.
 *
 *   The self-delete footgun — an admin deleting their own
 *   account by mistake — is deliberately NOT guarded at this
 *   layer. The service could check it if it received the
 *   caller's id, but it doesn't, and adding that argument would
 *   complicate every operation for a single edge case. If the
 *   guard is ever needed, the correct place is the admin
 *   controller, where the caller's identity is already
 *   available as `req.user.userId`. The current plan does not
 *   call for the guard, so it is not implemented. This note
 *   exists so that a future reader does not mistake the
 *   omission for an oversight.
 *
 * Password handling:
 *
 *   The payload types use `password` (plaintext) for the
 *   incoming value; the persisted field is `passwordHash`. The
 *   service hashes on both create and update, using
 *   `hashPassword` from `auth/utils/bcrypt.ts`.
 *
 *   Why hash explicitly rather than rely on the User model's
 *   pre-save hook:
 *
 *     The User model has a defensive pre-save hook that hashes a
 *     plaintext value assigned to `passwordHash`. That hook
 *     works for `doc.save()` — the create path — but it does
 *     NOT run for `findOneAndUpdate` or `findByIdAndUpdate`,
 *     which are the model APIs the update path uses. If
 *     `updateUser` passed a plaintext password to a
 *     `findByIdAndUpdate` call, the plaintext would be stored
 *     verbatim, and the next login attempt would fail with a
 *     confusing "wrong password" error even though the user
 *     typed the right password.
 *
 *     The service therefore hashes explicitly on every write.
 *     On the create path, this means the model's hook sees a
 *     value that already looks like a bcrypt hash and steps
 *     aside — the hook's own check prevents double-hashing.
 *     Both paths produce the same stored value: a single bcrypt
 *     hash of the plaintext the caller supplied.
 *
 * The `PublicUser` projection:
 *
 *   Every read in this service returns `PublicUser` — the
 *   domain `User` type minus its `passwordHash` field. The
 *   projection is applied by the local `toPublicUser` helper,
 *   which constructs the response object field-by-field rather
 *   than destructuring the document.
 *
 *   The explicit construction (rather than `const { passwordHash,
 *   ...rest } = doc; return rest;`) is deliberate: it fails
 *   loudly at compile time if a new field is added to the
 *   `User` interface and this function is not updated. A
 *   destructive projection would silently pass through any new
 *   field — including, one day, something sensitive. The
 *   verbose form is the correct trade.
 *
 *   Note that the model marks `passwordHash` with
 *   `select: false`, so most queries do not even load it. The
 *   projection is a second independent guard — this file never
 *   relies on the model's default projection alone.
 *
 * Password-change semantics on update:
 *
 *   The update payload's `password` field is optional. When it
 *   is absent, the user's existing password is left untouched —
 *   the service does not re-hash or clear it. When it is
 *   present, the service hashes the new plaintext and replaces
 *   the stored hash. There is no "verify old password before
 *   changing" flow at this layer — that belongs to a
 *   user-facing account-settings feature, not to the admin
 *   panel, and the plan does not declare one.
 *
 * Email normalization:
 *
 *   On create and on email-changing updates, the submitted
 *   email is trimmed and lowercased before persistence. The
 *   model's schema also applies `trim: true` and `lowercase: true`,
 *   so this is a belt-and-braces step — but doing it in the
 *   service means the value is normalized BEFORE the unique
 *   index check runs, not after. Without the service-level
 *   normalization, a duplicate-key error could surface for
 *   `Alice@example.com` vs `alice@example.com` on some MongoDB
 *   configurations where the index is case-sensitive before
 *   the schema's lowercase step fires — an issue that does not
 *   arise with consistent normalization at the input boundary.
 *
 * Cascade semantics:
 *
 *   `deleteUser` does NOT cascade to the target user's topics,
 *   documents, articles, reports, settings, or presets. That is
 *   the same convention every other service in this codebase
 *   follows (see the headers of `topicService.ts`,
 *   `documentService.ts`, and `articleService.ts`): cascade is a
 *   decision for each owning feature, and the plan's file tree
 *   does not declare a cascade path for user deletion.
 *
 *   The practical consequence is that deleting a user leaves
 *   their topics, documents, and other records orphaned in the
 *   collections — still present, still readable by any admin
 *   query that does not filter on `userId`, but no longer
 *   reachable by the deleted user (whose account no longer
 *   exists) and not currently cleaned up by any other path.
 *
 *   A future cleanup migration can address this. The correct
 *   place for it is not this service — it would be a cross-
 *   feature migration that walks every user-scoped collection
 *   and removes records for the deleted `userId`. That is a
 *   discrete maintenance operation, not a request-time concern,
 *   and the plan explicitly separates the two.
 */

import { UserModel, type UserDocument } from '../../auth/models/User.js';
import { hashPassword } from '../../auth/utils/bcrypt.js';
import type {
  User,
  UserRole,
  UserCreatePayload,
  UserUpdatePayload,
} from '../../shared/types/index.js';
import { AppError } from '../../shared/middleware/errorHandler.js';

// ============================================================
//  Public projection
// ============================================================

/**
 * The shape of a user object as it crosses the API boundary.
 *
 * Defined as a local alias — `Omit<User, 'passwordHash'>` — and
 * exported so the controller can reference the same type without
 * re-declaring it. This mirrors the alias of the same name in
 * `authService.ts`; the two are structurally identical, and a
 * future refactor could promote the definition to
 * `shared/types/index.ts`. Until then, keeping the declaration
 * local avoids a cross-feature import between two peer features
 * (auth and users) that the plan's hierarchy does not otherwise
 * require.
 */
export type PublicUser = Omit<User, 'passwordHash'>;

/**
 * Project a full user document into the client-safe shape.
 *
 * Every field is listed explicitly. Adding a new field to the
 * `User` interface therefore requires updating this function —
 * the compiler will fail on the missing field rather than
 * silently omitting it from responses. That is the desired
 * failure mode: a new user-record field deserves a deliberate
 * decision about whether it should be exposed over the API.
 *
 * The password hash is never referenced here, and the model's
 * `select: false` on that field means most queries could not
 * read it even if they tried. The projection is the second of
 * the two independent guards against leaking it.
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
//  listUsers
// ============================================================

/**
 * List all users, sorted newest first. An optional filter narrows
 * the result by role and/or active status.
 *
 * The two filter dimensions mirror the two access patterns the
 * User model's indexes were created to serve:
 *
 *   - `{ role }`   → the "list of admins" view.
 *   - `{ active }` → the "list of deactivated accounts" view.
 *
 * Both indexes on the User schema are single-field and cover
 * these queries without a collection scan.
 *
 * An absent filter returns every user. A filter with neither
 * field set behaves the same as an absent filter. A filter with
 * one or both fields set narrows accordingly.
 *
 * The service does NOT validate the filter's values — a caller
 * that passes a `role` string that is not a member of the
 * `UserRole` enum will simply produce an empty result (no user
 * record has that role, because the schema would never have
 * accepted one). The controller is responsible for rejecting
 * invalid filter values before reaching the service.
 *
 * @param filter - Optional narrowing criteria. Both fields are
 *                  optional and independent.
 */
export const listUsers = async (
  filter?: { role?: UserRole; active?: boolean }
): Promise<PublicUser[]> => {
  const query: { role?: UserRole; active?: boolean } = {};
  if (filter?.role !== undefined) {
    query.role = filter.role;
  }
  if (filter?.active !== undefined) {
    query.active = filter.active;
  }

  const users = await UserModel.find(query).sort({ createdAt: -1 });
  return users.map(toPublicUser);
};

// ============================================================
//  getUserById
// ============================================================

/**
 * Read a single user by their id.
 *
 * Returns `null` when no user with that id exists. The caller
 * (the controller) converts the null into a 404. A malformed id
 * string — one that is not a valid ObjectId — does NOT return
 * null; it causes Mongoose to throw a CastError, which the
 * terminal middleware maps to a 400. That distinction is
 * deliberate: "the id is not a valid identifier" is a client
 * error, not a "user not found" case.
 *
 * @param userId - The target user's id. This is the id of the
 *                  record being read, NOT the id of the caller.
 *                  See the file header for the ownership-model
 *                  explanation.
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
//  createUser
// ============================================================

/**
 * Create a new user.
 *
 * Flow:
 *
 *   1. Normalize the email — trim whitespace, lowercase — so
 *      that two submissions differing only in case are treated
 *      as the same address by the unique index.
 *
 *   2. Hash the plaintext password with the auth feature's
 *      `hashPassword` util. See the file header for why the
 *      hash is performed here rather than left to the model's
 *      pre-save hook.
 *
 *   3. Persist the user. The schema applies defaults for the
 *      two optional fields (`role` defaults to `UserRole.USER`,
 *      `active` defaults to `true`), so a payload that omits
 *      them produces a regular active user.
 *
 *   4. Return the client-safe projection.
 *
 * A duplicate email produces a Mongo duplicate-key error (code
 * 11000), which the terminal error middleware maps to a 409 with
 * a "Duplicate value for field 'email'" message. The service
 * does NOT pre-check for a duplicate — doing so would introduce
 * a race between the check and the insert, and the unique index
 * is the authoritative guard.
 *
 * The function does NOT catch validation errors from the schema.
 * A Mongoose ValidationError thrown here — an empty email, an
 * invalid role, a malformed email string — propagates to the
 * terminal middleware, which maps it to a 400 with the schema's
 * own message.
 *
 * @param payload - The new user's email, plaintext password, and
 *                  optional role and active flag.
 */
export const createUser = async (
  payload: UserCreatePayload
): Promise<PublicUser> => {
  // ---- 1. Normalize the email ----
  const email = payload.email.trim().toLowerCase();

  // ---- 2. Hash the password ----
  // The plaintext from the payload is hashed here; the model
  // sees the resulting hash, which its pre-save hook recognizes
  // as already-hashed and does not re-hash.
  const passwordHash = await hashPassword(payload.password);

  // ---- 3. Persist ----
  // Only the fields the caller supplied are spread into the
  // document. Fields not present in the payload are left out
  // entirely so the schema's defaults apply — spreading
  // `undefined` for `role` or `active` would violate
  // `exactOptionalPropertyTypes` and would also suppress the
  // schema default in some Mongoose versions.
  const doc = new UserModel({
    email,
    passwordHash,
    ...(payload.role !== undefined ? { role: payload.role } : {}),
    ...(payload.active !== undefined ? { active: payload.active } : {}),
  });

  await doc.save();

  // ---- 4. Project and return ----
  return toPublicUser(doc);
};

// ============================================================
//  updateUser
// ============================================================

/**
 * Apply a partial update to a user.
 *
 * Flow:
 *
 *   1. Build the `$set` object from the patch. Fields omitted
 *      from the patch are left unchanged on the document. If
 *      `password` is present, the plaintext is hashed and the
 *      resulting hash is what is written to the `passwordHash`
 *      field — see the file header for why this hash is
 *      explicit rather than hook-driven.
 *
 *   2. If the patch contains no actionable fields, short-circuit:
 *      read the current document (to verify existence) and
 *      return it without issuing a write. This is more honest
 *      than an empty `$set`, which MongoDB would accept but
 *      which would not change anything.
 *
 *   3. Otherwise, perform the update. The `runValidators: true`
 *      option makes the schema's per-field validators run on the
 *      update — an invalid role or email format is rejected by
 *      the schema, not just by the controller's pre-checks.
 *
 *   4. Return the client-safe projection.
 *
 * Throws `AppError(404)` when the target user does not exist.
 * This is the update path's "not found" contract, matching the
 * pattern of every other service in this codebase.
 *
 * @param userId - The target user's id. This is the id of the
 *                  record being updated, NOT the id of the
 *                  caller. See the file header.
 * @param patch  - A partial user record. Only the fields present
 *                  are updated.
 */
export const updateUser = async (
  userId: string,
  patch: UserUpdatePayload
): Promise<PublicUser> => {
  // ---- 1. Build the $set object ----
  const setFields: Record<string, unknown> = {};

  if (patch.email !== undefined) {
    setFields['email'] = patch.email.trim().toLowerCase();
  }

  if (patch.password !== undefined) {
    // Hash the plaintext explicitly. The model's pre-save hook
    // does NOT run for `findOneAndUpdate` / `findByIdAndUpdate`,
    // so this is the only path that turns the plaintext into a
    // hash on the update flow.
    setFields['passwordHash'] = await hashPassword(patch.password);
  }

  if (patch.role !== undefined) {
    setFields['role'] = patch.role;
  }

  if (patch.active !== undefined) {
    setFields['active'] = patch.active;
  }

  // ---- 2. Empty-patch short circuit ----
  // Read the existing document (to confirm existence) and
  // return its projection without writing anything.
  if (Object.keys(setFields).length === 0) {
    const existing = await UserModel.findById(userId);
    if (!existing) {
      throw new AppError('User not found.', 404);
    }
    return toPublicUser(existing);
  }

  // ---- 3. Perform the update ----
  const updated = await UserModel.findByIdAndUpdate(
    userId,
    { $set: setFields },
    { new: true, runValidators: true }
  );

  if (!updated) {
    throw new AppError('User not found.', 404);
  }

  // ---- 4. Project and return ----
  return toPublicUser(updated);
};

// ============================================================
//  deleteUser
// ============================================================

/**
 * Delete a user.
 *
 * Returns the deleted user's client-safe projection so the caller
 * can log or display what was removed. The password hash is not
 * part of the returned projection — see the file header for the
 * projection rationale.
 *
 * Throws `AppError(404)` when the target user does not exist.
 *
 * The service does NOT cascade to the target user's topics,
 * documents, articles, reports, settings, or presets. See the
 * file header for the cascade rationale — the same convention
 * every other service in this codebase follows.
 *
 * There is no guard against an admin deleting their own account.
 * See the file header for why that check does not belong at this
 * layer.
 *
 * @param userId - The target user's id. This is the id of the
 *                  record being deleted, NOT the id of the
 *                  caller. See the file header.
 */
export const deleteUser = async (
  userId: string
): Promise<PublicUser> => {
  const deleted = await UserModel.findByIdAndDelete(userId);

  if (!deleted) {
    throw new AppError('User not found.', 404);
  }

  return toPublicUser(deleted);
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