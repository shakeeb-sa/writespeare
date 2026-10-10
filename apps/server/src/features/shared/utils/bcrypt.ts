/**
 * Shared bcrypt utility — re-export shim.
 *
 * The plan's file tree declares this file under
 * `apps/server/src/features/shared/utils/` with a single
 * annotation: "Password hashing (re-export)". That annotation
 * is the entire specification the plan gives, and it is
 * explicit about what this file is: a re-export of an existing
 * implementation, not a second implementation.
 *
 * The working implementation lives at
 * `apps/server/src/features/auth/utils/bcrypt.ts`, written in
 * Session 1 and already consumed by two service files:
 *
 *   - `features/auth/services/authService.ts` imports
 *     `comparePassword` to verify login credentials.
 *
 *   - `features/users/services/userService.ts` imports
 *     `hashPassword` to hash passwords on the admin create and
 *     update paths.
 *
 * That file owns the actual logic — the salt-round constant,
 * the two promise-based wrappers around the native `bcrypt`
 * module, the deliberate choice to have `comparePassword`
 * return `false` on failure rather than throw. It is the single
 * source of truth for the password-hashing contract.
 *
 * ── Why this file exists at all ─────────────────────────────────
 *
 *   The plan declares two paths for the same responsibility:
 *
 *     auth/utils/bcrypt.ts         — "hashPassword, comparePassword"
 *     shared/utils/bcrypt.ts       — "Password hashing (re-export)"
 *
 *   The second annotation contains the word "re-export", which
 *   is the plan's own way of saying: "this file forwards the
 *   first one." There is no second implementation intended, no
 *   duplication to perform, and no decision to make about which
 *   is authoritative — the annotation settles it.
 *
 *   The alternative to a re-export — writing a second, parallel
 *   implementation of `hashPassword` and `comparePassword` in
 *   this file — would be a direct violation of the plan's own
 *   annotation and would create a genuine maintenance hazard.
 *   Two implementations of a password-hashing contract can
 *   silently drift on the salt-round constant, the error
 *   handling policy, or the encoding, and a user's password
 *   hashed by one path would fail to verify through the other.
 *   The re-export shim makes that class of drift structurally
 *   impossible: both import paths resolve to the same function
 *   objects, so a change to the auth feature's implementation
 *   is a change to what both paths produce.
 *
 * ── The re-export shim pattern ──────────────────────────────────
 *
 *   Two other files in the codebase already follow this pattern,
 *   for the same reason:
 *
 *     `features/admin/middleware/adminGuard.ts` re-exports
 *     `requireAdmin` from `features/auth/middleware/authGuard.ts`
 *     because the plan declares both paths with the same
 *     responsibility ("Ensures admin role" vs "JWT verify +
 *     requireAdmin") and only one implementation exists.
 *
 *     `features/shared/hooks/useToast.ts` re-exports `useToast`
 *     from `features/shared/components/Toast.tsx` because the
 *     plan's declared hook path does not match where the hook's
 *     provider (and therefore the hook) naturally lives.
 *
 *   In all three cases, the plan declares a path; the working
 *   implementation lives at a different path; the re-export
 *   bridges the two without duplicating the logic. The shim is
 *   a first-class pattern in this codebase, not a workaround.
 *
 *   The consequence for a future consumer: importing
 *   `hashPassword` from this file and importing it from
 *   `auth/utils/bcrypt.js` are equivalent — both resolve to the
 *   same function object. A caller that prefers the shared path
 *   for its own reasons (a directory layout that keeps every
 *   cross-cutting utility under `shared/`, a reviewer who wants
 *   a single import root for shared helpers) uses this file; a
 *   caller that prefers the canonical implementation path uses
 *   `auth/utils/bcrypt.js`. Neither choice is wrong, and neither
 *   creates a second source of truth.
 *
 * ── What this file is NOT ───────────────────────────────────────
 *
 *   - It is not a wrapper. The two exported functions are the
 *     same function objects that `auth/utils/bcrypt.ts` exports
 *     — not `(plainText) => hashPasswordFromAuthUtils(plainText)`
 *     indirections. Identity comparisons (`hashPassword ===
 *     authHashPassword`) behave the same way across both import
 *     paths.
 *
 *   - It is not a place for a different hashing strategy. If a
 *     future session wanted this path to use a different
 *     algorithm — say, moving to argon2 for new hashes while
 *     preserving bcrypt verification for old ones — that change
 *     would be a new implementation, not a modification to this
 *     file. The file's contract is "the same hashing as the auth
 *     feature's implementation", and changing that contract
 *     silently would violate the plan's own "re-export"
 *     annotation.
 *
 *   - It is not imported by anything today. Both current
 *     consumers (`authService.ts` and `userService.ts`) import
 *     from `auth/utils/bcrypt.js` directly. The re-export exists
 *     because the plan declares the path, not because any file
 *     currently reaches for it. A future session that wanted a
 *     shared utility organized under `shared/` could switch one
 *     of those imports to `../../shared/utils/bcrypt.js` — a
 *     one-line change to an existing file that the current
 *     session's file-creation protocol forbids making. The
 *     current session's contribution is to give the plan-
 *     declared path a meaningful surface so that such a switch
 *     is a one-line change and not a file creation.
 *
 * ── What this file does NOT do ──────────────────────────────────
 *
 *   - It does not export any constant. The `SALT_ROUNDS`
 *     constant in `auth/utils/bcrypt.ts` is module-private by
 *     design — the file's header explains why (it is a single
 *     source of truth for the cost factor, and exporting it
 *     would invite a caller to depend on a specific value rather
 *     than on the hashing contract). This file does not
 *     re-export it. A caller that wants to know the current cost
 *     factor reads it from a hash string at runtime, or reads
 *     the auth file directly.
 *
 *   - It does not export any type. The auth file does not
 *     declare any named types — the two functions take and
 *     return primitives — so there is nothing to re-export on
 *     the type side.
 *
 *   - It does not re-export the `bcrypt` npm package itself. A
 *     caller that needs to reach the native library directly —
 *     to call a method this wrapper does not expose — imports
 *     `bcrypt` from `node_modules` and takes on the
 *     corresponding responsibility for its callback API. This
 *     file is the codebase's promise-based facade, and it
 *     intentionally exposes only the two operations the rest of
 *     the codebase uses.
 */

import {
  hashPassword,
  comparePassword,
} from '../../auth/utils/bcrypt.js';

// ============================================================
//  Re-export
// ============================================================
//
//  Two named re-exports. The imported symbols and the exported
//  symbols carry the same names, so there is no aliasing and no
//  second reference — a caller that imports `hashPassword` or
//  `comparePassword` from this file receives the same function
//  objects that a caller importing from
//  `auth/utils/bcrypt.js` receives.

export { hashPassword, comparePassword };

// ============================================================
//  Default export
// ============================================================
//
//  The two named exports bundled under a default object,
//  matching the convention used by every other module in the
//  codebase. A consumer that prefers the named form uses
//  `import { hashPassword } from '...'`; a consumer that
//  prefers the default form uses
//  `import bcrypt from '...'` and destructures. Both resolve
//  to the same two function objects.

export default {
  hashPassword,
  comparePassword,
};