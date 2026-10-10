/**
 * useAutomation — the renderer's automation hook.
 *
 * The single entry point through which the app's components read
 * the automation feature's state — the list of currently-active
 * pipeline tasks, the FIFO queue of pending user-interaction
 * prompts, and the last error the store recorded.
 *
 * ── The hook's role ─────────────────────────────────────────────
 *
 *   The hook is a straight pass-through over `useAutomationStore`,
 *   following the same shape as every sibling hook in the
 *   codebase — `useTopics`, `useSettings`, `useDocuments`,
 *   `useWriter`, `useValidation`. The store owns the state and the
 *   actions; the hook gives components a single, stable object
 *   that exposes both.
 *
 *   Every data field is read through its own Zustand selector, so
 *   a component that only cares about `activeTasks` does not
 *   re-render when `promptQueue` changes. Every action is a
 *   direct reference to the store's own action — Zustand actions
 *   are stable references for the life of the store, so wrapping
 *   them in `useCallback` would be redundant.
 *
 * ── The hook's API ──────────────────────────────────────────────
 *
 *   Data fields:
 *
 *     activeTasks   — one entry per pipeline operation currently
 *                     in flight, across every topic. Populated
 *                     from `TASK_START` markers and pruned on
 *                     `TASK_END`.
 *
 *     promptQueue   — a FIFO queue of pending user-interaction
 *                     prompts. The modal (see `CaptchaModal.tsx`)
 *                     renders `promptQueue[0]`.
 *
 *     error         — the last error the store recorded, or null.
 *
 *   Actions (all direct references to the store's actions):
 *
 *     dismissPrompt(id?)  — remove a prompt from the queue. With
 *                            no argument, removes the head; with
 *                            an explicit id, removes that entry.
 *
 *     setError(message)   — set the error field. Exposed so that
 *                            a future IPC action's failure path
 *                            (once the preload extension lands —
 *                            see the PLAN DELTA below) can write
 *                            to it without reaching past the
 *                            hook.
 *
 *     clearError()        — clear the error field.
 *
 *     clearAll()          — empty both arrays. Used by a future
 *                            "Stop All" flow after every task has
 *                            been killed.
 *
 *     reset()             — full reset. Called by the root store
 *                            on logout.
 *
 * ── What this hook does NOT do — and the PLAN DELTA ────────────
 *
 *   The hook exposes no IPC actions. Specifically, it does not
 *   expose a `cancelTask` action (to kill a running pipeline
 *   operation) or a `submitPromptResponse` action (to deliver a
 *   SKIP/STOP/CONTINUE command to a blocked Python child
 *   process). The reason is that the preload's `ElectronAPI`
 *   interface declares no `automation` namespace, and neither of
 *   those two operations can be performed through any of the
 *   existing preload methods:
 *
 *     * `cancelTask` would need a general "kill any task by id"
 *       channel. The existing cancel paths (`research.cancel`,
 *       `writer.cancel`) are per-feature and take a `topicId`
 *       rather than a task id; the automation store's `ActiveTask`
 *       entries carry an operation name that does not map cleanly
 *       onto either of those two specific cancel paths.
 *
 *     * `submitPromptResponse` would need a channel that reaches
 *       the specific child process that emitted the
 *       `CAPTCHA_REQUIRED` or `MANUAL_ACTION` marker and calls
 *       its `writeStdin()` method. The marker payload does not
 *       carry a task id, so the handler would need the
 *       `childProcessManager` registry to identify the currently
 *       blocked child — a correlation that the main process
 *       currently has no channel to expose.
 *
 *   The plan's file-tree annotation for the automation IPC module
 *   (`automationIPC.ts`, step 150) declares exactly three
 *   channels — `automation:status`, `automation:kill`, and
 *   `window:notify` — and the first two do not have corresponding
 *   methods on the preload. Adding the `automation` namespace to
 *   the preload is a coordinated change that touches
 *   `src/main/preload.ts`, an existing file that this session's
 *   file-creation protocol forbids modifying.
 *
 *   This is logged as a PLAN DELTA with this file's creation. A
 *   future session that lands the coordinated preload extension
 *   will add the two missing hook actions — `cancelTask` and
 *   `submitPromptResponse` — to this file at that time. The
 *   `setError` action exposed above is the piece that future
 *   session will need for those two actions' failure paths.
 *
 *   Until the extension lands, the automation feature's
 *   interactive components read the store's state and use the
 *   store's pure-state actions (dismiss a prompt, clear an
 *   error). The IPC-dependent actions are the missing piece.
 *
 * ── Why this hook has no derived values ─────────────────────────
 *
 *   Some hooks in other codebases expose convenience values like
 *   `hasActiveTasks: boolean` or `currentPrompt: PromptRequest`.
 *   This hook does not, matching the sibling hooks in this
 *   codebase: `useTopics` exposes `topics` but not `hasTopics`,
 *   `useSettings` exposes `settings` but not `hasSettings`. The
 *   hook's API is a one-to-one reflection of the store's surface.
 *
 *   A consumer that wants a derived value computes it inline —
 *   `activeTasks.length > 0` is O(1) and reading it at the call
 *   site keeps the hook's API small. If a future session finds
 *   that the same derived value is being computed in more than
 *   two places, the promotion is a local change to this file.
 *
 * Dependencies: the sibling store module. No third-party imports;
 * no `react` import beyond the implicit JSX transform.
 */

import {
  useAutomationStore,
  type ActiveTask,
  type PromptRequest,
} from '../store/automationStore.js';

// ============================================================
//  Public types
// ============================================================

/**
 * The shape of the object returned by `useAutomation()`.
 *
 * Exported so that a helper function that takes "an instance of
 * the automation hook" as a parameter can be typed against the
 * interface without redeclaring the shape. A component that
 * destructures the return value does not need to reference the
 * interface at all.
 *
 * The interface mirrors `AutomationStoreState`'s public surface
 * one-to-one — three data fields and five actions. The store's
 * internal `_handleMarker` action is deliberately not exposed:
 * it is called by the module-load listener, never by a component.
 */
export interface AutomationHookValue {
  // ---- Data ----

  /** Every pipeline operation currently in flight, across every
   *  topic. Empty when no operation is running. */
  activeTasks: ActiveTask[];

  /** Every pending user-interaction prompt, in arrival order.
   *  The modal renders `promptQueue[0]`; the rest wait their
   *  turn. Empty when no prompt is waiting. */
  promptQueue: PromptRequest[];

  /** The last error the store recorded, or null. */
  error: string | null;

  // ---- Actions ----

  /** Remove a prompt from the queue. With no argument, removes
   *  the head (the prompt the modal is currently showing); with
   *  an explicit id, removes that specific entry. */
  dismissPrompt: (id?: string) => void;

  /** Set the store's error field. Exposed so that a future IPC
   *  action's failure path can write to it without reaching past
   *  the hook — see the file header's PLAN DELTA section. */
  setError: (message: string | null) => void;

  /** Clear the store's error field. */
  clearError: () => void;

  /** Empty both arrays. The error field is left as-is. */
  clearAll: () => void;

  /** Reset every field to its initial value. */
  reset: () => void;
}

// ============================================================
//  The hook
// ============================================================

/**
 * Return the automation feature's state and its pure-state
 * actions. See the file header for the hook's role, the reasoning
 * behind its design, and the PLAN DELTA that documents the
 * currently-missing IPC actions.
 */
export const useAutomation = (): AutomationHookValue => {
  // ---- Data subscriptions ----
  // One selector per data field. See the file header for why the
  // fields are read individually rather than as one object.
  const activeTasks = useAutomationStore((s) => s.activeTasks);
  const promptQueue = useAutomationStore((s) => s.promptQueue);
  const error = useAutomationStore((s) => s.error);

  // ---- Action subscriptions ----
  // Zustand actions are stable references for the life of the
  // store, so selecting them here does not cause re-renders and
  // does not require `useCallback` around them. This matches the
  // pattern every sibling hook in the codebase follows.
  const dismissPrompt = useAutomationStore((s) => s.dismissPrompt);
  const setError = useAutomationStore((s) => s.setError);
  const clearError = useAutomationStore((s) => s.clearError);
  const clearAll = useAutomationStore((s) => s.clearAll);
  const reset = useAutomationStore((s) => s.reset);

  // ---- Return ----
  // A single object literal with all eight members. The order
  // matches the interface above, so a reader comparing the two
  // does not have to hunt for a member's position.
  return {
    activeTasks,
    promptQueue,
    error,
    dismissPrompt,
    setError,
    clearError,
    clearAll,
    reset,
  };
};

// ============================================================
//  Default export
// ============================================================

/**
 * The hook as the default export, matching the convention used
 * by every other hook and store in the codebase. Consumers that
 * prefer the named form use `import { useAutomation } from ...`;
 * consumers that prefer the default form use
 * `import useAutomation from ...`. Both resolve to the same hook.
 */
export default useAutomation;