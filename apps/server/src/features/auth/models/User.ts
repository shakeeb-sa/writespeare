/**
 * Mongoose model for the WriteSpeare User entity.
 *
 * Responsibilities:
 *
 *   1. Enforce the schema-level invariants of a user record — a
 *      unique, well-formed email; a non-empty password hash; a
 *      role drawn from the closed `UserRole` enum; and an `active`
 *      flag with a safe default of `true`.
 *
 *   2. Own the one operation on a user that must never be
 *      reimplemented by a caller: verifying a candidate password
 *      against the stored hash. Exposing this as an instance
 *      method (`comparePassword`) keeps `bcrypt` out of the
 *      service layer entirely, so a future refactor of the hashing
 *      strategy has exactly one file to change.
 *
 *   3. Defend the hash from accidental serialisation. The
 *      `passwordHash` path is marked `select: false`, which
 *      excludes it from every query by default; the `toJSON`
 *      transform strips it again from any document that was
 *      fetched with an explicit `.select('+passwordHash')`. Two
 *      independent guards, because a leaked hash is not the kind
 *      of mistake that announces itself until it is too late.
 *
 * The pre-save hook performs a defensive hash. It hashes the
 * `passwordHash` field ONLY when the incoming value does not
 * already look like a bcrypt hash. This is what allows the model
 * to be correct regardless of which convention the calling service
 * adopts: a service that hashes before assigning works, and a
 * service that assigns plaintext works, and neither path produces
 * a double-hashed value.
 */

import mongoose, { Schema, Document } from 'mongoose';
import { User, UserRole } from '../../shared/types/index.js';

// ============================================================
//  Document interface
// ============================================================

/**
 * The runtime shape of a User document as returned by Mongoose.
 *
 * Extends `Omit<User, '_id'>` (the shared domain interface minus
 * its loosely-typed `_id`) and then re-declares `_id` with the
 * concrete ObjectId type Mongoose actually produces. This is the
 * standard pattern for a document interface: the shared domain
 * type stays transport-agnostic (its `_id` is `string | ObjectId`
 * so it can cross JSON boundaries), while the document interface
 * pins `_id` to what the ODM actually gives you in-process.
 *
 * `comparePassword` is declared here rather than on the schema's
 * `methods` object because declaring it on the interface is what
 * gives every consumer of `UserDocument` compile-time knowledge
 * that the method exists. The runtime attachment happens below via
 * `UserSchema.methods`.
 */
export interface UserDocument extends Omit<User, '_id'>, Document {
  _id: mongoose.Types.ObjectId;
  comparePassword(candidatePassword: string): Promise<boolean>;
}

// ============================================================
//  Helpers
// ============================================================

/**
 * The structural prefix shared by every bcrypt hash produced by
 * any major bcrypt implementation. The `$2a$`, `$2b$`, and `$2y$`
 * variants are all in active use; the cost factor follows as two
 * decimal digits.
 *
 * Used by the pre-save hook to detect an already-hashed value.
 * A plaintext password cannot accidentally match this pattern —
 * a user would have to type something like `$2a$10$...` verbatim,
 * which the email/password validation layer rejects upstream.
 */
const BCRYPT_HASH_PATTERN = /^\$2[aby]\$\d{2}\$/;

// ============================================================
//  Schema
// ============================================================

const UserSchema = new Schema<UserDocument>(
  {
    email: {
      type: String,
      required: [true, 'Email is required'],
      unique: true,
      trim: true,
      lowercase: true,
      match: [/^\S+@\S+\.\S+$/, 'Please provide a valid email address'],
    },
    passwordHash: {
      type: String,
      required: [true, 'Password is required'],
      select: false,
    },
    role: {
      type: String,
      enum: {
        values: Object.values(UserRole),
        message: 'Role must be either "admin" or "user".',
      },
      default: UserRole.USER,
      required: true,
    },
    active: {
      type: Boolean,
      default: true,
      required: true,
    },
  },
  {
    timestamps: true,
    toJSON: {
      transform: (_doc, ret) => {
        delete ret['passwordHash'];
        delete ret['__v'];
        return ret;
      },
    },
  }
);

// ============================================================
//  Indexes
// ============================================================
//  The unique index on `email` is created implicitly by the
//  `unique: true` option on the field, so it is not re-declared
//  here. The two indexes below cover the two access patterns the
//  admin feature exercises directly:
//
//    - Filtering users by role (list of admins).
//    - Filtering users by active status (list of deactivated
//      accounts).
//
//  A compound index on (role, active) would serve both with a
//  single scan but is not needed at the current collection size;
//  it can be added later without a migration.

UserSchema.index({ role: 1 });
UserSchema.index({ active: 1 });

// ============================================================
//  Pre-save hook — defensive hash
// ============================================================

/**
 * Hash the password field on save, unless it is already hashed.
 *
 * The bcrypt module is imported dynamically inside the hook rather
 * than at module scope. Two reasons:
 *
 *   1. It keeps this file's top-level import graph free of the
 *      native bcrypt binary. A build tool that only needs the
 *      schema shape (a tooling script, a migration that reads
 *      the interface) does not have to load the native module.
 *
 *   2. It matches the loading behaviour the rest of the backend
 *      already uses for bcrypt, so there is one convention across
 *      the codebase rather than two.
 *
 * The bcrypt-pattern check is the reason this hook is safe to
 * keep enabled: a caller that pre-hashes (as the auth service
 * does) passes a value that matches the pattern, and the hook
 * steps aside. A caller that assigns plaintext (as a future bulk
 * import script might) passes a value that does not match, and
 * the hook does the hashing. Neither path can produce a
 * double-hashed value, which is the failure mode that breaks
 * login silently.
 */
UserSchema.pre('save', async function (next) {
  if (!this.isModified('passwordHash')) {
    return next();
  }

  const current = this['passwordHash'];
  if (typeof current !== 'string' || current.length === 0) {
    return next();
  }

  if (BCRYPT_HASH_PATTERN.test(current)) {
    return next();
  }

  try {
    const bcrypt = await import('bcrypt');
    const hashed = await bcrypt.hash(current, 10);
    this['passwordHash'] = hashed;
    next();
  } catch (error) {
    next(error instanceof Error ? error : new Error(String(error)));
  }
});

// ============================================================
//  Instance method — comparePassword
// ============================================================

/**
 * Compare a candidate plaintext password against the stored hash.
 *
 * Returns `false` on any failure rather than throwing. A caller
 * cannot distinguish "wrong password" from "user has no hash on
 * disk" from "bcrypt threw" — and deliberately should not, because
 * surfacing those distinctions to a login endpoint would leak
 * account-existence information to an attacker.
 *
 * The `this['passwordHash']` bracket access is required because
 * `passwordHash` is declared with `select: false` on the schema
 * and lives behind the document's index signature. A caller that
 * fetched the user without an explicit `.select('+passwordHash')`
 * will reach this method with the field absent, and the length
 * guard handles that case cleanly by returning `false`.
 */
UserSchema.methods['comparePassword'] = async function (
  this: UserDocument,
  candidatePassword: string
): Promise<boolean> {
  try {
    const stored = this['passwordHash'];
    if (typeof stored !== 'string' || stored.length === 0) {
      return false;
    }
    const bcrypt = await import('bcrypt');
    return await bcrypt.compare(candidatePassword, stored);
  } catch {
    return false;
  }
};

// ============================================================
//  Model
// ============================================================

export const UserModel = mongoose.model<UserDocument>('User', UserSchema);

// ============================================================
//  Default export
// ============================================================

export default UserModel;