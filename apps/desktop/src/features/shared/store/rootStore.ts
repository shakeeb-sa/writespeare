/**
 * rootStore — the cross-feature state coordination module.
 *
 * The single place the app clears every feature store's renderer-
 * side state in one call. Two use cases drive it:
 *
 *   1. Logout — when the user signs out, clearing the auth store
 *      alone is not enough. Every feature store holds data from
 *      the session that just ended — the topics list, the active
 *      topic, the search candidates, the extracted documents, the
 *      generated article, the validation report, the cached
 *      settings, the admin users list, the automation task list.
 *      If any of them is left populated, the next user to sign
 *      in on the same app instance would briefly see the previous
 *      user's data before their own state is loaded.
 *
 *   2. Manual reset — a future "reset app state" or "reload data"
 *      affordance calls this module to return the renderer to a
 *      clean slate without restarting the process.
 *
 * ── Why this file is a plain module and not a Zustand store ─────
 *
 *   Every other file under a `store/` folder in this codebase is
 *   a Zustand store — a hook that returns a piece of state and
 *   the actions that mutate it. This file is different: it holds
 *   no state. Its entire job is to call nine other stores' reset
 *   actions.
 *
 *   A Zustand store with no data and a single action would be a
 *   jarring pattern — a reader who opens a `*.ts` file under a
 *   `store/` folder expects to find a `create<...>()` call, and a
 *   file that has one but uses it only to wrap a coordination
 *   function would be a small source of confusion in every code
 *   review.
 *
 *   The plain-module form is more honest: the file exports two
 *   functions, and a caller that wants them calls them. No hook,
 *   no subscription, no state. The name `rootStore.ts` refers to
 *   the fact that this file coordinates the OTHER stores, not
 *   that it is itself one.
 *
 * ── The ordering of the resets ──────────────────────────────────
 *
 *   The resets are performed in a specific order, and the order
 *   matters for one subtle reason.
 *
 *   The auth store is cleared LAST. When `useUserStore.clearAuth()`
 *   runs, the auth gate in `Layout.tsx` re-renders (its `user`
 *   subscription fires) and redirects to `/login`. If the other
 *   stores had not yet been cleared at that moment, the login
 *   page would briefly mount against a `topicStore` that still
 *   held the previous user's topics, a `researchStore` that
 *   still held the previous user's candidates, and so on. In
 *   practice the redirect is fast enough that a user would not
 *   notice — the flash is a single frame — but it is a
 *   correctness bug that a slower machine could surface as a
 *   visible leak.
 *
 *   Clearing the auth store last ensures that by the time the
 *   redirect fires, every other store is already empty. The
 *   login page mounts against a fully clean state.
 *
 *   Within the non-auth stores, the order does not matter. They
 *   do not depend on each other, and no observer reads two of
 *   them in the same commit. Any order would be correct; the one
 *   used below is grouped by "flow order" (topics → research →
 *   documents → writer → validation → settings → admin →
 *   automation) so a reader tracing the pipeline sees the stores
 *   in the same sequence the pipeline produces them.
 *
 * ── What this module does NOT do ────────────────────────────────
 *
 *   - It does not clear the main process's encrypted store. The
 *     encrypted store lives in the main process and is cleared
 *     through its own IPC path — the `auth:logout` handler calls
 *     `clearAuth()` on `main/store.ts`, which nulls the token
 *     and user fields. This module operates on the RENDERER's
 *     in-memory stores only.
 *
 *   - It does not clear the persisted settings cache in the main
 *     process. The `settings:get` handler in `settingsIPC.ts`
 *     deliberately keeps the encrypted cache across logouts (see
 *     that file's header for the reasoning — the cache is
 *     per-machine state), and this module does not override that
 *     decision. The renderer's `settingsStore` is cleared, so a
 *     fresh session re-fetches from the main-process cache on
 *     the next mount.
 *
 *   - It does not navigate. The redirect to `/login` is the
 *     layout's job (see `Layout.tsx`'s auth gate), and this
 *     module does not know about the router. It clears state;
 *     the layout reacts to the state change.
 *
 *   - It does not log. A caller that wants to audit a reset
 *     should log from the call site, where the reason for the
 *     reset is available.
 *
 * ── The current wiring — and the gap ────────────────────────────
 *
 *   The plan's file-tree annotation for `useAuth.logout` (see
 *   `auth/hooks/useAuth.ts`) describes the logout flow as
 *   "call `window.electronAPI.auth.logout()`" followed by
 *   `clearAuth()` on the renderer's auth store. It does NOT
 *   describe any call to this module. That is the current
 *   state of the code — logging out clears the auth store and
 *   the main process's encrypted store, but leaves every other
 *   renderer store populated.
 *
 *   The gap is real and worth naming: a user who logs out and
 *   then logs back in as a different user would, for one frame
 *   after login, see the previous user's topic list before the
 *   new user's `loadTopics` fetch replaced it. The redirect
 *   through `/login` and back through the layout's auth gate
 *   makes the window small, but it is not zero.
 *
 *   The correct fix is a single line added to `useAuth.logout`:
 *   an `import { resetAllStores } from '../../shared/store/rootStore.js'`
 *   at the top of the file, and a `resetAllStores()` call after
 *   the IPC round trip and before `clearAuth()`. Because that
 *   fix modifies an existing file — `useAuth.ts` — it is out of
 *   scope for the current session's file-creation protocol.
 *
 *   It is logged in the PLAN DELTA section of the execution
 *   response with this file's creation. Until the fix lands, this
 *   module is dormant — no code in the codebase calls either of
 *   its two functions. The module compiles cleanly and its
 *   functions are correct; the wiring is what is missing.
 *
 * Dependencies: the nine feature stores it coordinates. Every
 * one of them is already created and exports the reset action
 * this module calls.
 */

import { useUserStore } from '../../auth/store/userStore.js';
import { useTopicStore } from '../../topics/store/topicStore.js';
import { useResearchStore } from '../../research/store/researchStore.js';
import { useDocumentStore } from '../../documents/store/documentStore.js';
import { useWriterStore } from '../../writer/store/writerStore.js';
import { useValidationStore } from '../../validation/store/validationStore.js';
import { useSettingsStore } from '../../settings/store/settingsStore.js';
import { useAdminStore } from '../../admin/store/adminStore.js';
import { useAutomationStore } from '../../automation/store/automationStore.js';

// ============================================================
//  resetFeatureStores
// ============================================================

/**
 * Clear every feature store's renderer-side state, leaving the
 * auth store untouched.
 *
 * Use this when a user has just logged in and the previous
 * session's state needs to be wiped before the app renders the
 * new session's UI. The auth store is preserved because the
 * caller has just populated it with the new user; clearing it
 * would log the new user out.
 *
 * The stores are cleared in the order the pipeline produces
 * them — topics, research, documents, writer, validation,
 * settings, admin, automation. See the file header for why the
 * order does not matter for correctness but is preserved for
 * readability.
 *
 * The function never throws. Every store's reset action is a
 * synchronous `set(...)` call on an in-memory Zustand store,
 * with no I/O, no async boundary, and no code path that can
 * reject. A caller that wraps this in a try/catch would be
 * handling an error that cannot occur.
 */
export const resetFeatureStores = (): void => {
  useTopicStore.getState().clear();
  useResearchStore.getState().reset();
  useDocumentStore.getState().reset();
  useWriterStore.getState().reset();
  useValidationStore.getState().reset();
  useSettingsStore.getState().reset();
  useAdminStore.getState().reset();
  useAutomationStore.getState().reset();
};

// ============================================================
//  resetAllStores
// ============================================================

/**
 * Clear every store, including the auth store.
 *
 * Use this on logout. The auth store is cleared LAST — see the
 * file header for why the ordering matters. When
 * `useUserStore.clearAuth()` runs, the layout's auth gate
 * observes the null user and redirects to `/login`; by that
 * moment every other store is already empty, so the login page
 * mounts against clean state.
 *
 * The function never throws for the same reason
 * `resetFeatureStores` does not — every reset action is a
 * synchronous in-memory update.
 */
export const resetAllStores = (): void => {
  // Feature stores first — see the file header for the reasoning.
  resetFeatureStores();

  // Auth store last. This is the call that triggers the layout's
  // redirect; by the time it runs, everything else is empty.
  useUserStore.getState().clearAuth();
};

// ============================================================
//  Default export
// ============================================================

/**
 * Both functions bundled under one default object, matching the
 * convention used by the other shared utility modules
 * (`shared/api/client.ts`, `shared/utils/encryption.ts`). A
 * caller that prefers the named form uses
 * `import { resetAllStores } from '.../rootStore.js'`; a caller
 * that prefers the default form uses
 * `import rootStore from '.../rootStore.js'` and destructures.
 *
 * Both forms resolve to the same function objects — there is no
 * wrapper and no indirection, so the default object and the
 * named exports cannot drift apart.
 */
export default {
  resetFeatureStores,
  resetAllStores,
};