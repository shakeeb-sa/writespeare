/**
 * Admin seeder for the WriteSpeare backend.
 *
 * Reads ADMIN_EMAIL and ADMIN_PASSWORD from the environment,
 * connects to MongoDB, and creates the super-admin user if one
 * with that email does not already exist. Run once after the
 * database is provisioned and the .env file is populated:
 *
 *     npm run seed
 *
 * The npm script (`"seed": "tsx src/features/shared/utils/seedAdmin.ts"`)
 * invokes this file directly. When `tsx` runs it, the IIFE at the
 * bottom of the file drives the whole lifecycle — seed, disconnect,
 * exit — with a status code the shell can inspect:
 *
 *     0  success (including the "already existed" no-op case)
 *     1  any failure (missing env var, weak password, database
 *        error, email collision with a non-admin user)
 *
 * Idempotency
 * -----------
 * Running the seed more than once is safe. The second run finds
 * the admin created on the first run (matched by email) and exits
 * successfully without modifying anything. The email is the
 * identity anchor: same email + existing admin = no-op.
 *
 * Safety rails
 * ------------
 *   - ADMIN_EMAIL is trimmed and lowercased to match the
 *     normalization the User schema applies on store. Without
 *     this, seeding with "Admin@Example.com" would create a user
 *     that a subsequent login with "admin@example.com" could not
 *     find — the schema lowercases on save, but only after the
 *     first write, so the in-memory value the seeder thought it
 *     created would not match what the login path looks for.
 *
 *   - ADMIN_PASSWORD must be at least eight characters. The seed
 *     is the one place a human types an admin password directly,
 *     so it is also the one place a weak password can reach the
 *     database without passing through any form validation.
 *     Refusing to seed a short password is the correct default:
 *     an admin account with a three-character password is a
 *     production incident waiting to happen.
 *
 *   - If a user with the target email already exists but is NOT
 *     an admin, the seed throws rather than silently promoting
 *     them or silently returning a success. The operator either
 *     chose the wrong email, or they intend to promote that user
 *     through the admin panel — both are decisions the seed script
 *     does not have the context to make on its own.
 *
 *   - The password is passed as plaintext to the User model's
 *     `passwordHash` field. The model's pre-save hook detects
 *     that the value does not match the bcrypt hash pattern and
 *     hashes it before persisting. This mirrors how `loginUser`
 *     handles a new user's password, and it means the seeder
 *     never needs to import the bcrypt helpers directly.
 *
 * Module-scope side effect
 * ------------------------
 * The IIFE at the bottom of the file runs whenever this module is
 * evaluated, including when it is imported by another module. That
 * is deliberate and matches the pattern established in ROOKIE's
 * seedAdmin. It has two consequences a future reader should be
 * aware of:
 *
 *   - Running `tsx src/features/shared/utils/seedAdmin.ts` (which
 *     `npm run seed` does) triggers the whole lifecycle and exits
 *     the process — exactly what a CLI script should do.
 *
 *   - Importing `{ seedAdmin }` from a test or a script would also
 *     trigger the IIFE and exit the process, which is not what a
 *     test would want. If a programmatic caller is ever needed,
 *     the correct fix is to extract the logic into a sibling
 *     `seedAdminCore.ts` and leave this file as a thin wrapper
 *     around it. That refactor is not required today.
 */

import 'dotenv/config';

import { UserModel, type UserDocument } from '../../auth/models/User.js';
import { UserRole } from '../types/index.js';
import { connectDB, disconnectDB } from '../config/db.js';

// ============================================================
//  Constants
// ============================================================

/**
 * Minimum length accepted for the ADMIN_PASSWORD environment
 * variable.
 *
 * Eight characters is the shortest conventional baseline. A
 * shorter value is nearly always a placeholder that was forgotten
 * about — the example in `.env.example` uses a much longer string
 * for exactly that reason — and catching it at seed time is
 * cheaper than discovering it in production.
 */
const MIN_ADMIN_PASSWORD_LENGTH = 8;

// ============================================================
//  Public API
// ============================================================

/**
 * Create the super-admin user if one with the configured email
 * does not already exist.
 *
 * Returns the admin document in both the "created" and "already
 * existed" cases so a caller can log the resulting account. Throws
 * on any configuration or database failure — the caller (the IIFE
 * below, or a future test harness) decides whether to exit or
 * retry.
 *
 * The function connects to MongoDB itself rather than requiring
 * the caller to do so. That keeps the script self-contained when
 * run directly via `tsx`, and it means a test that has already
 * opened a connection reuses it — `connectDB` is idempotent.
 */
export const seedAdmin = async (): Promise<UserDocument> => {
  // ---- 1. Read and validate environment ----
  const rawEmail = process.env['ADMIN_EMAIL'];
  const rawPassword = process.env['ADMIN_PASSWORD'];

  if (typeof rawEmail !== 'string' || rawEmail.trim().length === 0) {
    throw new Error(
      'ADMIN_EMAIL environment variable is not set. ' +
        'Set it in apps/server/.env before running the seed.'
    );
  }

  if (
    typeof rawPassword !== 'string' ||
    rawPassword.length < MIN_ADMIN_PASSWORD_LENGTH
  ) {
    throw new Error(
      `ADMIN_PASSWORD environment variable must be at least ` +
        `${MIN_ADMIN_PASSWORD_LENGTH} characters. ` +
        `Set it in apps/server/.env before running the seed.`
    );
  }

  const adminEmail = rawEmail.trim().toLowerCase();

  // ---- 2. Connect to the database ----
  // `connectDB` is idempotent — a caller that already opened a
  // connection reuses it rather than opening a second one. The
  // matching `disconnectDB` runs in the IIFE below, on both the
  // success and failure paths.
  await connectDB();

  // ---- 3. Look for an existing user with this email ----
  const existing = await UserModel.findOne({ email: adminEmail });

  if (existing) {
    if (existing.role === UserRole.ADMIN) {
      console.log(`Admin user already exists: ${adminEmail}`);
      return existing;
    }

    // A non-admin user with this email already exists. Refuse to
    // modify their role silently — the operator either mistyped
    // the email, or they intend to promote this user, and neither
    // is a decision this script has the context to make.
    throw new Error(
      `A user with email "${adminEmail}" already exists but is ` +
        `not an admin. Choose a different ADMIN_EMAIL, or promote ` +
        `the user through the admin panel.`
    );
  }

  // ---- 4. Create the admin ----
  // The plaintext password is passed to `passwordHash`. The User
  // model's pre-save hook detects that the value does not match
  // the bcrypt hash pattern and hashes it before persisting.
  const newAdmin = new UserModel({
    email: adminEmail,
    passwordHash: rawPassword,
    role: UserRole.ADMIN,
    active: true,
  });

  await newAdmin.save();
  console.log(`Admin user created successfully: ${adminEmail}`);
  return newAdmin;
};

// ============================================================
//  Standalone execution
// ============================================================
//
// The IIFE below runs whenever this module is evaluated — that
// includes both "run directly via tsx" and "imported by another
// module". See the file header for the consequences and for the
// refactor that would remove the import-time side effect if a
// programmatic caller ever needs it.

(async () => {
  try {
    await seedAdmin();
    await disconnectDB();
    console.log('Admin seeding completed.');
    process.exit(0);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Admin seeding failed: ${message}`);

    // Best-effort cleanup. The process is about to exit regardless
    // of whether the disconnect succeeds, and a failure here must
    // not mask the original error — which is the one the operator
    // actually needs to see.
    try {
      await disconnectDB();
    } catch {
      // swallow — see comment above
    }

    process.exit(1);
  }
})();

// ============================================================
//  Default export
// ============================================================

export default {
  seedAdmin,
};