/**
 * useDeepSeekSession — the renderer's hook for the DeepSeek session.
 *
 * Wraps the two IPC channels that the DeepSeek feature exposes on
 * the main process side — `deepseek:checkSession` and
 * `deepseek:openLogin` — and holds the small amount of local state
 * the UI needs to render the session's current status and to
 * control the visibility of the login modal.
 *
 * ── What "session status" means ─────────────────────────────────
 *
 *   The status object is `{ live: boolean; checkedAt: string }`:
 *
 *     live       — true when the DeepSeek chat page is present in
 *                  the app's Chrome window with a valid session
 *                  (the main-process `sessionCheckService` runs a
 *                  triple check: the chat input element is present,
 *                  the URL is not a login URL, and the page does
 *                  not contain the "sign in to continue" text).
 *     checkedAt  — an ISO-8601 timestamp for when the last check
 *                  ran. The Settings page renders this value in
 *                  the "Last checked" line under the session
 *                  status.
 *
 *   The main process owns the authoritative status. This hook is
 *   a reader: it asks via IPC, the main process answers, and the
 *   hook caches the answer for the duration of the app session.
 *
 * ── The module-level cache ──────────────────────────────────────
 *
 *   The last-known status is stored in a module-level variable
 *   (`cachedSession`) so it survives component remounts. The
 *   Settings page's DeepSeek tab unmounts when the user switches
 *   to another tab and remounts when they switch back; without a
 *   cache, each remount would fire a redundant IPC check.
 *
 *   The cache is also the reason the hook does not expose a "reset"
 *   action: the cache's lifetime is the app's session, and there
 *   is no meaningful point at which a caller would want to clear
 *   it other than the app restarting (which clears the module).
 *
 *   Freshness is bounded by `CACHE_TTL_MS`. On mount, if the cache
 *   is missing OR older than the TTL, the hook fires a fresh check
 *   in the background. If the cache is fresh, the hook uses it and
 *   skips the check — the user sees the last-known status without
 *   a network-touching round trip.
 *
 * ── Why there is no Zustand store ───────────────────────────────
 *
 *   Same reasoning as the prompts editor's `usePrompts` hook. The
 *   plan's file tree declares no `deepseekStore.ts` and no
 *   DeepSeek slice in any existing store. The session status has
 *   one primary consumer (the Settings page) and one secondary
 *   consumer (the writer's idle CTA in a later step). A module-
 *   level cache plus per-instance React state is enough to keep
 *   the two consumers in sync without the indirection a store
 *   would add.
 *
 *   A future session that finds three or more consumers — a global
 *   status indicator, a background refresh loop, a session-history
 *   view — would promote the state to a store. The current design
 *   is the correct amount of machinery for the current consumers.
 *
 * ── The openLoginModal / closeLoginModal pair ───────────────────
 *
 *   `openLoginModal()` does two things in sequence:
 *
 *     1. Sets the local `isLoginModalOpen` flag to true. This is
 *        what tells the caller to render the modal.
 *     2. Fires `window.electronAPI.deepseek.openLogin()`. The IPC
 *        handler on the main-process side launches the app's
 *        Chrome on the DeepSeek login URL if it is not already
 *        there. The call is fire-and-forget — the renderer does
 *        not need to await the Chrome launch, because the modal
 *        itself polls the session status and closes when the
 *        session is live.
 *
 *   `closeLoginModal()` sets the flag back to false and fires a
 *   fresh `checkNow()`. The refresh exists because the modal
 *   closes for one of two reasons — the user cancelled (in which
 *   case the status is unchanged and the refresh is a no-op
 *   courtesy) or the session became live (in which case the
 *   hook's cached status is stale and needs to catch up). The
 *   two cases are handled uniformly by always re-checking.
 *
 *   The hook does not render the modal. The `DeepSeekLoginModal`
 *   component is a separate file (`../components/DeepSeekLoginModal.tsx`),
 *   and the caller that invoked `openLoginModal` is the caller
 *   that mounts the modal — driven by the `isLoginModalOpen` flag
 *   the hook exposes. This split follows the plan's file tree:
 *   the hook holds state and actions, the modal is a component.
 *
 * ── Concurrency ─────────────────────────────────────────────────
 *
 *   Two mounts of the hook in the same tick — the Settings page
 *   and the writer tab both rendering at once during a navigation
 *   — would each run the mount effect. Both would read the cache,
 *   both would find it stale (or missing), and both would call
 *   `checkNow`. The resulting IPC calls are idempotent: the main
 *   process's `checkSession` handler runs the check and writes
 *   the result to the encrypted store, and running it twice in
 *   quick succession produces the same cached value.
 *
 *   No in-flight guard is added. A future session that observes
 *   the double-check causing a visible double-fetch in a profiler
 *   would add a module-level `Promise<void> | null` that holds
 *   the in-flight check and returns it to concurrent callers.
 *   The current code does not need the guard.
 *
 * ── What this hook does NOT do ──────────────────────────────────
 *
 *   - It does not poll. The plan's user journey describes the
 *     login modal as polling every 1.5 seconds while it is open;
 *     that poll lives in `DeepSeekLoginModal.tsx`, not here. The
 *     hook's `checkNow` is a one-shot manual trigger.
 *
 *   - It does not cache the modal's open state at module scope.
 *     `isLoginModalOpen` is per-instance local state, so two
 *     concurrent mounts of the hook have independent modal
 *     visibility. The pattern the app follows is that a single
 *     component owns the modal's lifecycle; a future session
 *     that found two components both trying to open the modal
 *     would promote the flag to a store.
 *
 *   - It does not distinguish "the IPC call failed" from "the
 *     session is not live". A failed `checkSession` leaves the
 *     cached status untouched — the alternative, clearing it,
 *     would show the user "Not signed in to DeepSeek" every
 *     time the main process hiccupped, which is misleading.
 *
 *   - It does not expose the individual fields of the status
 *     object as separate hook values. A caller that wants
 *     `session.live` reads it from the object; a caller that
 *     wants the timestamp reads `session.checkedAt`. Two
 *     top-level fields would force every consumer to handle
 *     the "no status yet" case twice instead of once.
 *
 * Dependencies: React only. No store, no service, no other
 * feature. The `window.electronAPI.deepseek` surface is provided
 * by the preload; the two channels it declares
 * (`deepseek:checkSession` and `deepseek:openLogin`) are
 * registered by `deepseekIPC.ts` on the main-process side.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

// ============================================================
//  Public types
// ============================================================

/**
 * The status object returned by `deepseek:checkSession`.
 *
 * The two fields are produced by the main process's
 * `sessionCheckService` (via the `deepseek:checkSession` IPC
 * handler) and forwarded to the renderer unchanged. The renderer
 * treats them as opaque values — `live` for rendering the
 * "Signed in / Not signed in" distinction, `checkedAt` for
 * rendering the "Last checked" line.
 */
export interface DeepSeekSessionStatus {
  /** True when the DeepSeek chat page is present in the app's
   *  Chrome window with a valid, signed-in session. */
  live: boolean;

  /** ISO-8601 timestamp for when the check ran. */
  checkedAt: string;
}

/**
 * The shape of the object returned by `useDeepSeekSession()`.
 *
 * Exported so that a helper function that takes "an instance of
 * the DeepSeek session hook" as a parameter can be typed against
 * the interface without redeclaring the shape. A component that
 * destructures the return value does not need to reference the
 * interface at all.
 */
export interface DeepSeekSessionHookValue {
  // ---- Data ----

  /** The last-known session status, or null before the first
   *  check has completed. */
  session: DeepSeekSessionStatus | null;

  /** True while a `checkNow()` call is in flight. Drives a spinner
   *  on the Settings page's session-status row. */
  isChecking: boolean;

  /** True when the login modal should be visible. The caller that
   *  invoked `openLoginModal` reads this flag and conditionally
   *  mounts the modal. */
  isLoginModalOpen: boolean;

  // ---- Actions ----

  /** Run a fresh session check now. Resolves when the check
   *  completes. A failed check leaves `session` at its last
   *  value — see the file header for the rationale. */
  checkNow: () => Promise<void>;

  /** Open the login modal and launch Chrome on the DeepSeek login
   *  URL if it is not already there. Fire-and-forget — the caller
   *  does not await the Chrome launch. */
  openLoginModal: () => void;

  /** Close the login modal and run a fresh session check. Called
   *  by the modal on both its Cancel path and its
   *  session-became-live path. */
  closeLoginModal: () => void;
}

// ============================================================
//  Module-level cache
// ============================================================
//
//  The last-known session status, shared across every mount of the
//  hook within the current app session. See the file header for
//  the reasoning on why the cache lives at module scope rather
//  than in a store.
//
//  The cache is written by `checkNow` on every successful IPC
//  response. It is never cleared; the app's session is the cache's
//  natural lifetime, and a fresh app launch starts with a fresh
//  module and therefore a fresh cache.

let cachedSession: DeepSeekSessionStatus | null = null;

/**
 * How long a cached status remains "fresh" before a mount of the
 * hook triggers a background re-check.
 *
 * Thirty seconds is chosen as a balance between two failure modes:
 *
 *   * Too short — the Settings page's DeepSeek tab, which the
 *     user is likely to switch away from and back to within a
 *     minute or two, would fire a check on every remount. The
 *     check is a Playwright-driven inspection of the Chrome
 *     window, and running it repeatedly is wasteful.
 *
 *   * Too long — a status that was cached just before the user
 *     logged out of DeepSeek in Chrome would remain showing
 *     "Signed in" for the full TTL, which is misleading. Thirty
 *     seconds bounds that window to a duration a user is
 *     unlikely to notice before taking another action (clicking
 *     Generate, opening the login modal) that forces a fresh
 *     check anyway.
 */
const CACHE_TTL_MS = 30_000;

// ============================================================
//  The hook
// ============================================================

/**
 * Return the DeepSeek session's state and its actions. See the
 * file header for the hook's role, its relationship to the IPC
 * layer, and the reasoning behind the design choices.
 */
export const useDeepSeekSession = (): DeepSeekSessionHookValue => {
  // ---- Data ----
  // The initial `session` value comes from the module cache, not
  // from `null`. If a previous mount of the hook (from the
  // Settings page, or from the writer tab in a later step) already
  // populated the cache, this mount renders with the cached value
  // immediately — no null-then-update flash.
  const [session, setSessionState] =
    useState<DeepSeekSessionStatus | null>(cachedSession);
  const [isChecking, setIsChecking] = useState(false);
  const [isLoginModalOpen, setLoginModalOpen] = useState(false);

  // ---- Mounted guard ----
  // Guards every state-setting path in this hook against the
  // "component unmounted during an async check" case. Without it,
  // a check that resolves after the component has unmounted would
  // produce a React warning ("Cannot update state on an unmounted
  // component") and, worse, a stale local state update that is
  // harmless in this hook's case but a bad habit to leave
  // unchecked.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // ---- Internal applySession ----
  // Writes both the module cache and the local state. Every
  // successful check funnels through this so the two stores stay
  // in sync.
  const applySession = useCallback(
    (next: DeepSeekSessionStatus): void => {
      cachedSession = next;
      if (mountedRef.current) {
        setSessionState(next);
      }
    },
    []
  );

  // ---- checkNow ----
  const checkNow = useCallback(async (): Promise<void> => {
    // Flip `isChecking` before the await so a component that
    // renders the hook's state sees the spinner immediately.
    if (mountedRef.current) {
      setIsChecking(true);
    }

    try {
      const result =
        await window.electronAPI.deepseek.checkSession();

      if (result.success && result.data) {
        // The IPC handler returns the status object directly. The
        // two fields are copied explicitly (rather than spread) so
        // that a future addition to the IPC payload does not
        // silently become part of the cached object.
        applySession({
          live: result.data.live,
          checkedAt: result.data.checkedAt,
        });
      }
      // On a non-success envelope, the cached session is left at
      // its previous value. See the file header for the rationale
      // on why a transient failure does not clear the status.
    } catch (err) {
      // An IPC rejection — the channel is unregistered, or the
      // renderer's context has been torn down. Same policy as the
      // non-success envelope: log and leave the cache untouched.
      console.error(
        '[useDeepSeekSession] checkNow failed:',
        err
      );
    } finally {
      if (mountedRef.current) {
        setIsChecking(false);
      }
    }
  }, [applySession]);

  // ---- openLoginModal ----
  const openLoginModal = useCallback((): void => {
    // Show the modal first so the user sees immediate feedback
    // (the modal's own spinner appears before the Chrome launch
    // has had time to complete).
    setLoginModalOpen(true);

    // Launch Chrome on the login URL. Fire-and-forget — the
    // modal polls the session status and closes itself when the
    // session is live, so this call does not need to resolve
    // before anything else happens.
    void window.electronAPI.deepseek
      .openLogin()
      .catch((err: unknown) => {
        console.error(
          '[useDeepSeekSession] openLogin failed:',
          err
        );
      });
  }, []);

  // ---- closeLoginModal ----
  const closeLoginModal = useCallback((): void => {
    setLoginModalOpen(false);
    // Refresh the status — the modal closes either because the
    // user cancelled (status unchanged, refresh is a courtesy)
    // or because the session became live (status is stale). The
    // two cases are handled uniformly.
    void checkNow();
  }, [checkNow]);

  // ---- Bootstrap check on mount ----
  // Runs once per mount. The decision to fire a check is driven
  // by the cache's freshness:
  //
  //   * Cache missing     → check.
  //   * Cache stale       → check.
  //   * Cache fresh       → skip; the initial state already has
  //                          the cached value.
  //
  // The `checkNow` reference is stable (a `useCallback` whose
  // only dependency is `applySession`, which itself has empty
  // deps), so the effect fires exactly once per mount — the
  // dependency array does not trigger re-runs when other state
  // in this hook changes.
  useEffect(() => {
    const now = Date.now();
    const cachedAt =
      cachedSession !== null
        ? new Date(cachedSession.checkedAt).getTime()
        : 0;
    const cacheIsFresh =
      cachedSession !== null && now - cachedAt < CACHE_TTL_MS;

    if (!cacheIsFresh) {
      void checkNow();
    }
  }, [checkNow]);

  // ---- Return ----
  // A single object literal with all six members. The order
  // matches the interface above, so a reader comparing the two
  // does not have to hunt for a member's position.
  return {
    session,
    isChecking,
    isLoginModalOpen,
    checkNow,
    openLoginModal,
    closeLoginModal,
  };
};

// ============================================================
//  Default export
// ============================================================

/**
 * The hook as the default export, matching the convention used
 * by every other hook in the codebase. Consumers that prefer the
 * named form use `import { useDeepSeekSession } from ...`;
 * consumers that prefer the default form use
 * `import useDeepSeekSession from ...`. Both resolve to the same
 * hook.
 */
export default useDeepSeekSession;