/**
 * Admin feature — re-export shim for the admin-role middleware.
 *
 * The plan's file tree declares this file under
 * `apps/server/src/features/admin/middleware/` with a single
 * annotation: "Ensures admin role". That annotation is the
 * entire specification the plan gives, and the responsibility
 * it names is already fulfilled by an existing, working
 * middleware — `requireAdmin` in
 * `apps/server/src/features/auth/middleware/authGuard.ts`,
 * written in Session 1 and already in use by both
 * `userRoutes.ts` and `adminRoutes.ts`.
 *
 * ── Why this file exists at all ─────────────────────────────────
 *
 *   The plan declares two paths for the same responsibility:
 *
 *     auth/middleware/authGuard.ts   — "JWT verify + requireAdmin"
 *     admin/middleware/adminGuard.ts — "Ensures admin role"
 *
 *   Both annotations describe the same check — "the caller is
 *   authenticated AND the caller's role is admin" — and there
 *   is only one correct implementation of that check. The
 *   alternative to a single implementation is two divergent
 *   checks: a change to the auth feature's admin policy (say,
 *   adding a second role that qualifies) would have to be
 *   applied twice, and the two copies would eventually
 *   disagree.
 *
 *   The working implementation lives in `authGuard.ts` because
 *   that is where it was written first and because that is
 *   where the routes already import it from. This file exists
 *   because the plan declares it. It does NOT contain a second
 *   implementation of the admin check — it re-exports the
 *   working one.
 *
 * ── The re-export shim pattern ──────────────────────────────────
 *
 *   The same pattern is used elsewhere in the codebase. The
 *   renderer's `features/shared/hooks/useToast.ts` is a
 *   re-export shim for the `useToast` hook whose implementation
 *   lives in `features/shared/components/Toast.tsx` — the plan
 *   declares a `hooks/` path for the hook, and the shim bridges
 *   the plan's declared import path to the implementation's
 *   actual location. See that file's header for the fuller
 *   rationale on why the codebase treats the shim as a
 *   first-class pattern rather than a workaround.
 *
 *   The two situations differ in one detail. In the toast case,
 *   the implementation lives under a `components/` folder
 *   because that is where the provider (which creates the
 *   context the hook reads) also lives, and the plan's tree did
 *   not anticipate the coupling. In this case, the
 *   implementation lives under the `auth` feature because the
 *   admin-role check is fundamentally an authentication concern,
 *   not an admin-feature concern — it reads the same
 *   `req.user.role` field that every authentication path
 *   already knows about, and it depends on the same
 *   `UserRole` enum that the auth feature owns.
 *
 *   The consequence for a future consumer: importing
 *   `requireAdmin` from this file and importing it from
 *   `authGuard.js` are equivalent — both resolve to the same
 *   function object. A caller that prefers the plan-declared
 *   path for its own reasons (a directory layout that mirrors
 *   the plan, a reviewer who wants every admin-related import
 *   to come from the admin feature) uses this file; a caller
 *   that prefers the canonical implementation path uses
 *   `authGuard.js`. Neither choice is wrong, and neither
 *   creates a second source of truth.
 *
 * ── What this file is NOT ───────────────────────────────────────
 *
 *   - It is not a wrapper. The exported `requireAdmin` is the
 *     same function object that `authGuard.ts` exports — not a
 *     `(req, res, next) => requireAdminFromAuthGuard(req, res, next)`
 *     indirection. A caller that imports from either path and a
 *     caller that imports from the other receive the same
 *     reference; identity comparisons (`===`) behave the same
 *     way across both.
 *
 *   - It is not a place for admin-feature-specific policy. If a
 *     future session wants the admin feature to apply a
 *     STRICTER check than the global `requireAdmin` (for
 *     example, "only the installation's root administrator can
 *     delete system presets" as opposed to "any administrator
 *     can"), that check belongs in a new file — a
 *     `requireRootAdmin.ts` or an equivalent — not here. This
 *     file's contract is "the same check as the global admin
 *     guard", and adding policy to it would silently change
 *     what a caller of this path is getting.
 *
 *   - It is not imported by anything today. `adminRoutes.ts`
 *     imports `requireAdmin` from `authGuard.js` directly, as
 *     does `userRoutes.ts`. A future session that wanted the
 *     admin feature's middleware organized under the admin
 *     folder could switch the import in `adminRoutes.ts` to
 *     `../middleware/adminGuard.js` — a one-line change to an
 *     existing file that the current session's file-creation
 *     protocol forbids making. The current session's
 *     contribution is to give the plan-declared path a
 *     meaningful surface so that such a switch is a one-line
 *     change and not a file creation.
 *
 * ── What this file does NOT do ──────────────────────────────────
 *
 *   - It does not verify tokens. The token verification is the
 *     `authenticate` middleware's job, and it runs BEFORE
 *     `requireAdmin` in every route's chain. This file's
 *     exported middleware only reads `req.user`, which the
 *     earlier middleware has already populated.
 *
 *   - It does not accept a role parameter. The global
 *     `requireAdmin` hardcodes the admin role because the
 *     codebase has exactly one privileged role. A future session
 *     that added a second role would extend the auth guard's
 *     check and this file would inherit the new behavior
 *     automatically, because both paths resolve to the same
 *     function.
 *
 *   - It does not export `authenticate` or any of the other
 *     symbols in `authGuard.ts`. The single responsibility
 *     declared for this file — "Ensures admin role" — names one
 *     symbol, and exporting more would blur the boundary
 *     between "the admin feature's middleware surface" and
 *     "the auth feature's middleware surface".
 */

import { requireAdmin } from '../../auth/middleware/authGuard.js';

// ============================================================
//  Re-export
// ============================================================
//
//  A single named re-export. The imported symbol and the
//  exported symbol carry the same name, so there is no
//  aliasing and no second reference — a caller that imports
//  `requireAdmin` from this file receives the same function
//  object that a caller importing from `authGuard.js`
//  receives.

export { requireAdmin };

// ============================================================
//  Default export
// ============================================================
//
//  The named export bundled under a default object, matching
//  the convention used by every other module in the codebase.
//  A consumer that prefers the named form uses
//  `import { requireAdmin } from '...'`; a consumer that
//  prefers the default form uses
//  `import adminGuard from '...'` and destructures. Both
//  resolve to the same function.

export default {
  requireAdmin,
};