/**
 * DeepSeekLoginModal — the manual DeepSeek sign-in modal.
 *
 * Rendered by whichever component triggered the sign-in flow via
 * `useDeepSeekSession().openLoginModal()`. The modal is a
 * controlled child of that caller: the caller reads its own
 * hook instance's `isLoginModalOpen` flag and passes it down as
 * the `open` prop, and it passes its own instance's
 * `closeLoginModal` function down as the `onClose` prop. The
 * modal itself uses a fresh `useDeepSeekSession()` instance
 * internally, from which it reads `session` (for the auto-close
 * detection) and `checkNow` (for the polling loop).
 *
 * ── Why the modal is a controlled child ────────────────────────
 *
 *   `isLoginModalOpen` is per-instance local state on the hook.
 *   If the parent component (Settings page's DeepSeek tab, or the
 *   writer tab's idle-state "Sign in to DeepSeek" CTA) calls
 *   `openLoginModal()`, only the parent's hook instance has
 *   `isLoginModalOpen = true`. A modal that read its own hook
 *   instance's flag would see `false` and never render.
 *
 *   The correct arrangement is therefore the same one the shared
 *   `Modal` component itself uses for every other modal in the
 *   app: the parent owns the open/closed state, the child is a
 *   controlled presenter that receives `open` and reports back
 *   through `onClose`. The modal being a child of the parent —
 *   not a self-contained entry point — is what makes the flag
 *   visible to it.
 *
 *   See `useDeepSeekSession.ts`'s file header for the hook's own
 *   statement of this contract ("the caller that invoked
 *   `openLoginModal` is the caller that mounts the modal").
 *
 * ── Why the modal does NOT open Chrome ─────────────────────────
 *
 *   The plan's manifest line describes this file as "Modal that
 *   opens Chrome", but the Chrome launch is already performed by
 *   the hook's `openLoginModal()` action, which the CALLER runs
 *   when it decides to open the flow. The modal's role is the
 *   waiting UI: it shows the status, it polls the session, and
 *   it dismisses itself when the user has signed in. Adding a
 *   second `openLogin()` call inside this component would be
 *   redundant at best, and at worst would fire a second Chrome
 *   navigation while the first is still resolving.
 *
 *   The manifest's phrasing is read here as "the modal that is
 *   part of the flow that opens Chrome" — the modal's existence
 *   in the tree is what the CALLER relies on for the flow to
 *   feel complete. The Chrome launch remains the hook's job.
 *
 * ── The polling loop ───────────────────────────────────────────
 *
 *   While `open` is true, the modal fires a check immediately
 *   and then every 1500 ms. The interval is cleared when the
 *   modal closes or unmounts. The 1500 ms cadence matches the
 *   plan's user-journey description ("polling every 1.5
 *   seconds") and is a balance between two failure modes:
 *
 *     * Too fast — the check spawns a Playwright-driven
 *       inspection of the Chrome window; a 500 ms cadence would
 *       run the inspection twice per second and add measurable
 *       CPU load to a modal that the user may leave open while
 *       they read the sign-in page.
 *
 *     * Too slow — a user who signs in quickly should not wait
 *       more than a couple of seconds before the modal
 *       disappears. 1500 ms is comfortably below the threshold
 *       at which the delay becomes visible.
 *
 *   The immediate `checkNow()` on open is what makes the modal
 *   feel responsive: if the session is already live (a returning
 *   user who signed in through Chrome directly before opening
 *   the modal), the auto-close effect below fires on the first
 *   render after that check resolves, and the modal closes
 *   without the user having to wait for a full polling cycle.
 *
 * ── The auto-close detection ───────────────────────────────────
 *
 *   A second effect watches `session?.live` and calls `onClose()`
 *   as soon as it becomes true while the modal is open. The
 *   `open &&` guard in the effect prevents a spurious close
 *   when the modal is already closed but a stale `session`
 *   value happens to be live — the effect would otherwise fire
 *   `onClose()` on every render of a closed modal whose session
 *   was live.
 *
 *   The `onClose()` call goes up to the parent, which owns the
 *   flag and flips it. The modal itself does not set its own
 *   open state — it has none. The two-layer arrangement is what
 *   makes the modal a pure function of the parent's state: the
 *   parent decides when to open it, the modal's own logic
 *   decides when to request a close, and the parent is the only
 *   thing that actually changes the flag.
 *
 * ── The Cancel button ──────────────────────────────────────────
 *
 *   Cancel closes the modal without any other side effect. The
 *   Chrome window the hook opened stays open — it is the app's
 *   shared persistent-profile instance, and closing it would
 *   destroy the very session the user was about to create. A
 *   user who cancels and later changes their mind can reopen
 *   the modal from the same entry point; the Chrome window is
 *   still there, waiting.
 *
 *   The Cancel button is the only explicit action on the modal.
 *   Escape and overlay-click, both of which the shared Modal
 *   component enables by default, also route through `onClose`
 *   and are therefore equivalent to clicking Cancel.
 *
 * ── What this component does NOT do ────────────────────────────
 *
 *   - It does not open Chrome. See "Why the modal does NOT open
 *     Chrome" above.
 *
 *   - It does not render itself conditionally. The shared Modal
 *     component handles the mount/unmount and the enter/exit
 *     animation based on its `open` prop. This component is
 *     always in the parent's JSX; the parent's `open` prop
 *     decides whether the modal is visible.
 *
 *   - It does not distinguish "the IPC check failed" from "the
 *     session is not live". A failed check leaves `session` at
 *     its last value; the modal keeps polling and the user keeps
 *     waiting. The hook's file header documents why a transient
 *     failure does not clear the cached status.
 *
 *   - It does not offer a "Retry" or "Reopen Chrome" action. The
 *     Chrome window was opened by the hook and is on the user's
 *     desktop; if it is closed, opening it again is what the
 *     hook's `openLoginModal` does, and the user can invoke that
 *     by closing and reopening the modal from the same entry
 *     point.
 *
 *   - It does not show the timestamp of the last check. The
 *     `session.checkedAt` field is available but is not needed
 *     for the waiting message — a timestamp updated every 1.5
 *     seconds would flicker and add visual noise without giving
 *     the user any actionable information. A future session
 *     that wanted a diagnostic line could read `session.checkedAt`
 *     without changing the hook.
 *
 * Dependencies: react + lucide-react + the shared Modal + the
 * sibling `useDeepSeekSession` hook. All present in the
 * codebase.
 */

import {
  useCallback,
  useEffect,
} from 'react';
import { Loader2, LogIn } from 'lucide-react';

import Modal from '../../shared/components/Modal.js';
import { useDeepSeekSession } from '../hooks/useDeepSeekSession.js';

// ============================================================
//  Public types
// ============================================================

/**
 * The props accepted by `DeepSeekLoginModal`.
 *
 * The shape is deliberately minimal. The modal is a controlled
 * presenter: the parent owns the open/closed state and the modal
 * reports a request to close. Everything else the modal needs
 * (the current session status, the ability to trigger a fresh
 * check) comes from the hook that the modal calls internally.
 */
export interface DeepSeekLoginModalProps {
  /**
   * Whether the modal is currently visible.
   *
   * The parent reads this value from its own `useDeepSeekSession`
   * instance's `isLoginModalOpen` field. See the file header for
   * why the modal cannot read it from its own hook instance.
   */
  open: boolean;

  /**
   * Called when the modal should close — by the user clicking
   * Cancel or the shared Modal's close button, by pressing
   * Escape, by clicking the backdrop, or by the modal's own
   * auto-close effect firing after the session becomes live.
   *
   * The parent is responsible for actually flipping its
   * `isLoginModalOpen` flag in response. The typical
   * implementation is to pass the parent's own
   * `useDeepSeekSession().closeLoginModal` function directly,
   * which flips the flag AND fires a fresh check.
   */
  onClose: () => void;
}

// ============================================================
//  Constants
// ============================================================

/**
 * The interval between session checks while the modal is open,
 * in milliseconds. See the file header's "polling loop" section
 * for the reasoning behind the 1500 ms value.
 */
const POLL_INTERVAL_MS = 1500;

// ============================================================
//  DeepSeekLoginModal
// ============================================================

/**
 * The manual DeepSeek sign-in modal. See the file header for the
 * modal's responsibilities, its controlled-child contract with
 * the parent, and the reasoning behind its design choices.
 */
export const DeepSeekLoginModal = ({
  open,
  onClose,
}: DeepSeekLoginModalProps) => {
  // ---- Hook for session state and the check action ----
  // The modal uses a fresh `useDeepSeekSession()` instance rather
  // than receiving `session` and `checkNow` as props. The
  // module-level cache inside the hook is shared across
  // instances, so the modal's `session` value reflects the same
  // underlying state the parent observes; the local
  // `isLoginModalOpen` flag is per-instance and is deliberately
  // NOT what the modal reads for its own visibility (that comes
  // from the `open` prop). See the file header for the full
  // reasoning.
  const { session, checkNow } = useDeepSeekSession();

  // ---- Polling loop ----
  // While the modal is open, fire a check immediately and then
  // every POLL_INTERVAL_MS. The cleanup function clears the
  // interval whenever the effect re-runs or the component
  // unmounts, so a closed or unmounted modal never leaves a
  // background timer running.
  //
  // `checkNow` is a stable `useCallback` from the hook (its
  // only dependency is `applySession`, which itself has empty
  // deps), so listing it in the dependency array does not cause
  // the effect to re-run when unrelated state changes. The
  // effect therefore fires exactly on the `open` transition —
  // once when the modal opens, and never again until it closes
  // and reopens.
  useEffect(() => {
    if (!open) {
      return;
    }
    void checkNow();
    const intervalId = window.setInterval(() => {
      void checkNow();
    }, POLL_INTERVAL_MS);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [open, checkNow]);

  // ---- Auto-close when the session becomes live ----
  // The effect watches `session?.live` and requests a close as
  // soon as it becomes true while the modal is open. The `open`
  // guard prevents a spurious close when the modal has already
  // been dismissed but the module-level `session` cache happens
  // to be live — without the guard, the effect would fire
  // `onClose()` on every re-render of a closed modal whose
  // cached session was live, which the parent would interpret
  // as a new close request on an already-closed modal.
  //
  // The optional chaining `session?.live` is required because
  // `session` is `DeepSeekSessionStatus | null`. A null session
  // — the state before the first check has resolved — is not
  // live, and the effect correctly does nothing.
  useEffect(() => {
    if (open && session?.live === true) {
      onClose();
    }
  }, [open, session, onClose]);

  // ---- Cancel handler ----
  // The Cancel button's click handler is the `onClose` callback
  // directly. Declaring the callback as a `useCallback` here
  // would be redundant — `onClose` is already a stable
  // reference supplied by the parent (typically the hook's
  // `closeLoginModal`, which is itself a `useCallback`). Using
  // it directly makes the call site a one-line reference.
  const handleCancel = useCallback((): void => {
    onClose();
  }, [onClose]);

  // ---- Render ----
  return (
    <Modal
      open={open}
      onClose={onClose}
      variant="info"
      size="sm"
      title="Sign in to DeepSeek"
      footer={
        <button
          type="button"
          onClick={handleCancel}
          className={
            'rounded-lg border border-neutral-300 bg-background ' +
            'px-4 py-2 text-sm font-medium text-text ' +
            'transition-colors hover:bg-neutral-100 ' +
            'focus-visible:outline-none ' +
            'dark:border-neutral-700 dark:hover:bg-neutral-800 ' +
            'dark:text-neutral-100'
          }
        >
          Cancel
        </button>
      }
    >
      {/* ---- Icon ---- */}
      {/* A large, prominent icon above the message gives the
          modal the visual weight of an interruption — the user
          needs to look away from the app to sign in, and the
          modal is the only place they will see that instruction
          until they return. The icon uses the brand-primary
          tint, matching the "user's main path forward" semantic
          that the rest of the app applies to primary actions. */}
      <div className="mb-5 flex justify-center">
        <div
          className={
            'flex h-14 w-14 items-center justify-center ' +
            'rounded-2xl bg-primary/10 text-primary ' +
            'dark:bg-primary-light/10 dark:text-primary-light'
          }
        >
          <LogIn size={28} aria-hidden="true" />
        </div>
      </div>

      {/* ---- Heading + instruction ---- */}
      <div className="mb-5 text-center">
        <p
          className={
            'text-sm font-medium text-text ' +
            'dark:text-neutral-100'
          }
        >
          Sign in to DeepSeek
        </p>
        <p
          className={
            'mx-auto mt-2 max-w-xs text-sm leading-relaxed ' +
            'text-neutral-600 dark:text-neutral-300'
          }
        >
          A Chrome window has opened for you to sign in. Once
          your session is active, WriteSpeare will continue
          automatically — you can leave this modal open or close
          it with Cancel.
        </p>
      </div>

      {/* ---- Waiting status ---- */}
      {/* `role="status"` + `aria-live="polite"` tells a screen
          reader that the contents of this region change over
          time and should be announced at the next natural pause.
          The spinner's animation is the visual equivalent for a
          sighted user — the message is static, the spinner is
          what conveys "something is happening". */}
      <div
        role="status"
        aria-live="polite"
        className={
          'flex items-center justify-center gap-2 rounded-lg ' +
          'border border-neutral-200 bg-neutral-50 px-3 py-2 ' +
          'text-xs text-neutral-600 ' +
          'dark:border-neutral-800 dark:bg-neutral-900/40 ' +
          'dark:text-neutral-300'
        }
      >
        <Loader2
          size={14}
          className="shrink-0 animate-spin text-primary"
          aria-hidden="true"
        />
        <span>Waiting for you to sign in…</span>
      </div>
    </Modal>
  );
};

// ============================================================
//  Default export
// ============================================================

/**
 * The `DeepSeekLoginModal` component as the default export,
 * matching the convention used by every other component file in
 * the codebase. The Settings page's DeepSeek tab and the
 * WriterProgress idle state both import it with the default
 * form (`import DeepSeekLoginModal from '.../DeepSeekLoginModal.js'`)
 * when their PR-7 modifications land.
 */
export default DeepSeekLoginModal;