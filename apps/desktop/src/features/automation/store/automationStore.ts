/**
 * automationStore — the renderer's state for the automation feature.
 *
 * Holds the two pieces of state that drive the app's automation
 * affordances — the tasks that are currently running, and the
 * user-interaction prompts that are currently waiting for the
 * user's response. Both are app-wide, not topic-scoped.
 *
 * ── The two arrays ──────────────────────────────────────────────
 *
 *   `activeTasks` — one entry per pipeline operation that is
 *   currently in flight. Populated from `TASK_START` markers and
 *   pruned on `TASK_END`. The renderer's `RunningTaskIndicator`
 *   component reads this array's length to display its
 *   "N task(s) running" badge; a future "Stop All" affordance
 *   would iterate the array to kill each task in turn.
 *
 *   `promptQueue` — a FIFO queue of pending user-interaction
 *   prompts. Populated from `CAPTCHA_REQUIRED` and
 *   `MANUAL_ACTION` markers; entries are removed when the user
 *   responds to them (via the hook) or when a matching
 *   `CAPTCHA_SOLVED` marker arrives. The renderer's
 *   `CaptchaModal` component reads `promptQueue[0]` to decide
 *   what to show and renders nothing when the queue is empty.
 *
 *   The queue is FIFO because the Python pipeline can block on
 *   at most one interaction at a time per child process, and
 *   the app runs at most one child at a time in the common case.
 *   In the rare case where two children are running and both
 *   emit a captcha prompt, the FIFO ordering means the user
 *   resolves them in the order they arrived — the natural
 *   sequence for a human working through a stack of prompts.
 *
 * ── How the store receives updates ──────────────────────────────
 *
 *   Same pattern as `researchStore.ts`, `documentStore.ts`,
 *   `writerStore.ts`, and `validationStore.ts`. On module load,
 *   the store installs ONE listener on the `research:marker`
 *   channel via the preload's generic `window.electronAPI.on(...)`
 *   API. Every marker the main process emits — from every Python
 *   child, from every service — flows through that one channel.
 *   Each store's handler routes the marker types it cares about
 *   to its own state; this store's handler reacts to exactly five
 *   marker types:
 *
 *     TASK_START        → add an ActiveTask.
 *     TASK_END          → remove the matching ActiveTask.
 *     CAPTCHA_REQUIRED  → push a PromptRequest.
 *     MANUAL_ACTION     → push a PromptRequest.
 *     CAPTCHA_SOLVED    → remove the matching PromptRequest.
 *
 *   Every other marker type is ignored. See the file header of
 *   `listenerBridge.ts` for the full list of types the pipeline
 *   emits.
 *
 * ── Why this store does NOT filter by topic ─────────────────────
 *
 *   Every other feature store in this codebase filters incoming
 *   markers against an `activeTopicId` so a concurrent operation
 *   on a different topic does not corrupt the current topic's
 *   state. The automation store deliberately does NOT do that:
 *
 *     * `TASK_START` and `TASK_END` markers carry a `topicId`
 *       field only when the operation is topic-scoped. Export
 *       operations, for example, may not carry a topic at all.
 *
 *     * `CAPTCHA_REQUIRED`, `MANUAL_ACTION`, and `CAPTCHA_SOLVED`
 *       markers do not carry a `topicId` at all — the payload
 *       from `core/output.py`'s `manual_action_required` is
 *       `{site, step, prompt, isCaptcha}`, with an optional
 *       `rowIdx`. These markers are app-wide: a captcha blocks
 *       the shared Chrome instance, which is not owned by any
 *       one topic.
 *
 *   The consequence is that the store's two arrays hold every
 *   active task and every pending prompt, regardless of which
 *   topic — if any — is currently open in the UI. The UI
 *   components that read the arrays decide what, if anything,
 *   is relevant to display. `RunningTaskIndicator` shows the
 *   total count; `CaptchaModal` shows the top of the queue. Both
 *   are app-wide concerns.
 *
 * ── Why this store has NO IPC actions ───────────────────────────
 *
 *   The plan's file-tree annotation for this file reads "Active
 *   task IDs + FIFO prompt queue" — the store holds state. The
 *   IPC operations that *use* that state — delivering a response
 *   to a blocked child process, hard-killing a running task —
 *   live one layer up, in the hook (`useAutomation.ts`) and in
 *   the modal component (`CaptchaModal.tsx`).
 *
 *   The split matches the pattern `useAuth.ts` follows: the
 *   `userStore` holds the token and the user; the `useAuth`
 *   hook owns the `login` and `logout` actions that reach the
 *   IPC layer and update the store. The store is a state
 *   container; the hook composes it with side effects.
 *
 *   The alternative — putting `submitPromptResponse` and
 *   `cancelTask` on the store — was considered and rejected for
 *   the following reason: those two actions need a preload
 *   surface that does not currently exist (see the PLAN DELTA
 *   below). Placing them on the hook keeps the "store is a pure
 *   state container" invariant intact and isolates the future
 *   preload extension to a single file. If they were on the
 *   store, the eventual preload change would have to be made in
 *   two places instead of one.
 *
 *   The store's own actions are therefore limited to state
 *   mutations that need no IPC:
 *
 *     `dismissPrompt(id?)` — remove a prompt from the queue
 *                            without delivering a response. Used
 *                            by the modal's "Dismiss" affordance
 *                            for a prompt the user has already
 *                            resolved outside the app, or by a
 *                            future "clear stuck prompt" control.
 *
 *     `setError(message)`  — set the store's error field.
 *                            Called by the hook when an IPC action
 *                            fails; the store itself does not
 *                            originate errors.
 *
 *     `clearError()`       — clear the error field.
 *
 *     `clearAll()`         — empty both arrays. Used by a future
 *                            "Stop All" flow after every task has
 *                            been killed, or by a diagnostic
 *                            "reset UI state" control.
 *
 *     `reset()`            — full reset. Called by the root store
 *                            on logout.
 *
 * ── Why the store calls window.notify() on prompt arrival ───────
 *
 *   When the prompt queue grows from empty to non-empty — the
 *   first captcha of a session, or the first after a lull — the
 *   user's attention is elsewhere: they clicked Start and walked
 *   away, or they are reading another window. The taskbar flash
 *   is the standard "come back to this app" signal, and the
 *   moment a prompt arrives is exactly when it should fire.
 *
 *   The call is fire-and-forget (`void`) and its failure is
 *   ignored. A missing notification is a small UX regression;
 *   surfacing an error for it would be noise. The call goes
 *   through `window.electronAPI.window.notify()`, which is the
 *   one preload method the automation feature currently has
 *   available — see the preload's `WindowNamespace` interface
 *   for its declaration.
 *
 * ── What this store does NOT do ─────────────────────────────────
 *
 *   - It does not deliver responses to blocked children. See the
 *     "Why this store has NO IPC actions" section above; the hook
 *     owns that.
 *
 *   - It does not kill tasks. Same reasoning; the hook owns it.
 *
 *   - It does not distinguish "the app is currently notifying the
 *     user" from "the app is waiting silently." The taskbar flash
 *     is the only notification the store triggers; a future
 *     session that wanted a sound, a toast, or a popup would add
 *     those to the same code path.
 *
 *   - It does not persist. The state is transient — a fresh
 *     session starts with no active tasks and no pending prompts.
 *     Any surviving prompt from a previous session would be
 *     stale (its child process has already exited), and any
 *     surviving task entry would be a phantom. The store
 *     therefore uses plain `create()` with no `persist`
 *     middleware.
 *
 *   - It does not expose a `taskFor(promptId)` lookup. The
 *     CAPTCHA_REQUIRED payload does not carry a task identifier,
 *     so the store cannot correlate a prompt to its owning task
 *     with certainty. The hook relies on the assumption that at
 *     most one child is blocked at a time (see the hook's own
 *     header for the reasoning); this store does not try to
 *     solve the correlation problem it cannot solve.
 */

import { create } from 'zustand';

import type { MarkerEvent } from '../../research/services/listenerBridge.js';

// =============================================================================
//  Channel name
// =============================================================================
//
//  The IPC channel the main process emits every marker on. Must
//  match `listenerBridge.ts`'s exported `MARKER_EVENT_CHANNEL`
//  constant and the sibling stores' local declarations of the
//  same value. Declared locally because the bridge module cannot
//  be imported at runtime — it imports `BrowserWindow` from
//  `electron`, which is a main-process-only export.

const MARKER_CHANNEL = 'research:marker';

// =============================================================================
//  Public types
// =============================================================================

/**
 * A single pipeline operation that is currently in flight, as
 * tracked by the `TASK_START` and `TASK_END` markers that
 * `main.py` emits around every subcommand invocation.
 *
 * The `id` field is generated by this store — it is not present
 * in the marker payload. Its sole purpose is to give React a
 * stable key when the `RunningTaskIndicator` renders the list of
 * running tasks, and to give the hook a way to identify a
 * specific entry when it wants to remove one after a successful
 * kill.
 *
 * The `operation` field is the subcommand name — one of
 * `'search'`, `'extract'`, `'write'`, `'validate'`, `'export'`.
 * See `main.py`'s `_classify_status` docstring for the complete
 * set.
 *
 * The `topicId` field is present for every operation that was
 * invoked with a topic, and absent for operations that were not
 * (there are none in the current pipeline, but the type allows
 * for one so a future ad-hoc operation does not have to lie about
 * its identity).
 */
export interface ActiveTask {
  /** Store-generated identifier. Unique within the session. */
  id: string;

  /** The subcommand name — `'search'`, `'extract'`, `'write'`,
   *  `'validate'`, or `'export'`. */
  operation: string;

  /** The topic the task belongs to, if the operation was
   *  topic-scoped. Absent otherwise. */
  topicId?: string;

  /** ISO-8601 timestamp of when the store first saw the task. */
  startedAt: string;
}

/**
 * A single user-interaction prompt that is currently waiting for
 * the user's response, as tracked by the `CAPTCHA_REQUIRED`,
 * `MANUAL_ACTION`, and `CAPTCHA_SOLVED` markers.
 *
 * The `id` field is generated by this store — the marker payload
 * does not carry one. React uses it as a key when the modal
 * renders; the store uses it to remove a specific entry when
 * `CAPTCHA_SOLVED` fires or when the user responds out of band.
 *
 * The `site` and `step` fields are the two-part identifier the
 * Python side emits — see `core/output.py`'s `manual_action_required`
 * for the payload shape. Together they identify a prompt well
 * enough for the `CAPTCHA_SOLVED` handler to find the matching
 * entry. Two prompts with the same `(site, step)` pair cannot
 * be pending simultaneously, because the Python child that
 * emitted the first one is blocked until the first prompt is
 * resolved.
 */
export interface PromptRequest {
  /** Store-generated identifier. Unique within the session. */
  id: string;

  /** The site the prompt is for — a platform slug or the engine
   *  name. Matches the `site` field of the marker payload. */
  site: string;

  /** The pipeline step or sub-operation name. Matches the `step`
   *  field of the marker payload. */
  step: string;

  /** The user-facing message. Matches the `prompt` field of the
   *  marker payload; falls back to the `step` value when the
   *  Python side emitted an empty prompt. */
  prompt: string;

  /** Whether the prompt is a captcha (from `CAPTCHA_REQUIRED`)
   *  or a general manual action (from `MANUAL_ACTION`). The
   *  modal uses this to decide its icon and its copy. */
  isCaptcha: boolean;

  /** ISO-8601 timestamp of when the store first saw the prompt. */
  receivedAt: string;
}

/**
 * The full shape of the automation store's state, including both
 * the data fields and the actions.
 */
export interface AutomationStoreState {
  // ---- Data ----

  /** Every pipeline operation that is currently in flight,
   *  across every topic. Populated from `TASK_START` markers
   *  and pruned on `TASK_END`. */
  activeTasks: ActiveTask[];

  /** Every pending user-interaction prompt, in arrival order.
   *  The modal renders `promptQueue[0]`; the rest wait their
   *  turn. */
  promptQueue: PromptRequest[];

  /** The last error this store recorded — set by the hook when
   *  an IPC action fails, cleared by the user dismissing the
   *  error. `null` when there is nothing to surface. */
  error: string | null;

  // ---- Sync actions ----

  /**
   * Remove a prompt from the queue without delivering a response
   * to the blocked child. Used by the modal's "Dismiss" affordance
   * and by a future "clear stuck prompt" control.
   *
   * With no argument, removes the head of the queue (the prompt
   * the modal is currently showing). With an explicit `id`,
   * removes that specific entry — a use case that does not arise
   * today but that a future "dismiss a specific queued prompt"
   * affordance would need.
   */
  dismissPrompt: (id?: string) => void;

  /** Set the store's error field. Called by the hook when an
   *  IPC action fails. */
  setError: (message: string | null) => void;

  /** Clear the error field. */
  clearError: () => void;

  /** Empty both arrays. Keeps the error field as-is. */
  clearAll: () => void;

  /** Reset every field, including the error, to its initial
   *  value. Called by the root store on logout. */
  reset: () => void;

  /**
   * Internal — route one marker event to the correct state
   * update. Called by the module-level listener installed at
   * import time; not intended for direct use by components.
   */
  _handleMarker: (event: MarkerEvent) => void;
}

// =============================================================================
//  Initial state
// =============================================================================

/**
 * The store's initial data fields. Extracted as a constant so
 * `reset` can spread it into a new state object without
 * duplicating the literals.
 */
const INITIAL_STATE = {
  activeTasks: [] as ActiveTask[],
  promptQueue: [] as PromptRequest[],
  error: null as string | null,
};

// =============================================================================
//  ID generators
// =============================================================================
//
//  The store generates the `id` for every ActiveTask and every
//  PromptRequest. The marker payloads do not carry identifiers,
//  and the store needs stable keys for React and a way to
//  address a specific entry for removal. A monotonic counter is
//  sufficient — the store's state is not persisted across
//  sessions, and within a session the counter never repeats.
//
//  The counters are module-level (not part of the store's state)
//  because they are bookkeeping, not data the UI reads. A store
//  reset does not reset them — that would be wrong if a component
//  held a reference to an old task ID that it planned to use
//  after the reset. Monotonic-forever guarantees uniqueness.

let nextTaskId = 0;
let nextPromptId = 0;

const makeTaskId = (): string => {
  nextTaskId += 1;
  return `task-${nextTaskId}`;
};

const makePromptId = (): string => {
  nextPromptId += 1;
  return `prompt-${nextPromptId}`;
};

// =============================================================================
//  Payload narrowing
// =============================================================================
//
//  Every marker's payload arrives as `unknown`. The helpers below
//  narrow the ones this store cares about. A malformed payload is
//  silently ignored rather than throwing — a broken marker must
//  not crash the UI.

/**
 * Read the task identity fields from a `TASK_START` or
 * `TASK_END` marker's payload.
 *
 * Returns `null` for a payload that is not an object, or that
 * lacks a usable `operation` string. Returns an object with the
 * `operation` and an optional `topicId` otherwise.
 *
 * The `topicId` is read from either the marker payload's
 * `topicId` field — the shape `main.py` emits — or its
 * `topic_id` field, in case a future session's marker uses the
 * Python-side snake_case spelling. The current pipeline uses
 * `topicId`; the alternative is defensive.
 */
const readTaskIdentity = (
  payload: unknown
): { operation: string; topicId?: string } | null => {
  if (typeof payload !== 'object' || payload === null) {
    return null;
  }
  const p = payload as Record<string, unknown>;

  const operation = p['operation'];
  if (typeof operation !== 'string' || operation.length === 0) {
    return null;
  }

  const topicIdRaw = p['topicId'] ?? p['topic_id'];
  if (typeof topicIdRaw === 'string' && topicIdRaw.length > 0) {
    return { operation, topicId: topicIdRaw };
  }
  return { operation };
};

/**
 * Read the prompt fields from a `CAPTCHA_REQUIRED`,
 * `MANUAL_ACTION`, or `CAPTCHA_SOLVED` marker's payload.
 *
 * Returns `null` for a payload that is not an object, or that
 * lacks usable `site` and `step` strings. The `prompt` field is
 * optional — when the marker omits it or sends an empty string,
 * the `step` value is used as a fallback (matching the
 * `core/output.py` behavior where `prompt or step` is emitted).
 * The `isCaptcha` field is likewise optional and defaults to
 * `true` for a captcha-shaped marker.
 */
const readPromptPayload = (
  payload: unknown,
  fallbackIsCaptcha: boolean
): {
  site: string;
  step: string;
  prompt: string;
  isCaptcha: boolean;
} | null => {
  if (typeof payload !== 'object' || payload === null) {
    return null;
  }
  const p = payload as Record<string, unknown>;

  const site = p['site'];
  const step = p['step'];
  if (typeof site !== 'string' || site.length === 0) {
    return null;
  }
  if (typeof step !== 'string' || step.length === 0) {
    return null;
  }

  const promptRaw = p['prompt'];
  const prompt =
    typeof promptRaw === 'string' && promptRaw.length > 0
      ? promptRaw
      : step;

  const isCaptchaRaw = p['isCaptcha'];
  const isCaptcha =
    typeof isCaptchaRaw === 'boolean' ? isCaptchaRaw : fallbackIsCaptcha;

  return { site, step, prompt, isCaptcha };
};

// =============================================================================
//  Store
// =============================================================================

/**
 * The automation store. See the file header for its
 * responsibilities, its marker subscription model, and the
 * reasoning behind its design.
 *
 * Created without middleware — no `persist` (the store is
 * transient), no `devtools`, no Immer. Same shape as the sibling
 * stores.
 */
export const useAutomationStore = create<AutomationStoreState>(
  (set, get) => ({
    // ---- Initial data ----
    ...INITIAL_STATE,

    // ============================================================
    //  Marker handler
    // ============================================================

    /**
     * Route one marker event to the correct state update. See the
     * file header for the five marker types this store reacts to
     * and the reasoning behind the routing.
     *
     * The handler is intentionally tolerant of malformed payloads:
     * a marker whose payload cannot be narrowed is dropped without
     * an error, because a bug in the Python side's emission should
     * not crash the renderer.
     */
    _handleMarker: (event: MarkerEvent): void => {
      switch (event.type) {
        // ---- TASK_START ----
        // Add a new entry to the active-tasks list. The
        // operation and optional topicId come from the payload;
        // the id and the startedAt timestamp are generated here.
        case 'TASK_START': {
          const identity = readTaskIdentity(event.payload);
          if (identity === null) {
            return;
          }
          const task: ActiveTask = {
            id: makeTaskId(),
            operation: identity.operation,
            ...(identity.topicId !== undefined
              ? { topicId: identity.topicId }
              : {}),
            startedAt: new Date().toISOString(),
          };
          set((state) => ({
            activeTasks: [...state.activeTasks, task],
          }));
          return;
        }

        // ---- TASK_END ----
        // Remove the first entry that matches the payload's
        // (operation, topicId) tuple. The tuple is the only
        // stable identity the marker payload carries; the
        // store's own id is not present in the TASK_END payload,
        // so the match is done on the two shared fields.
        //
        // If multiple tasks share the same tuple — which the
        // current pipeline does not produce, but which a future
        // session could — the first match is removed. That is
        // the correct behavior for a strict queue: the earliest-
        // started task is the earliest-finished.
        case 'TASK_END': {
          const identity = readTaskIdentity(event.payload);
          if (identity === null) {
            return;
          }
          set((state) => {
            const idx = state.activeTasks.findIndex(
              (t) =>
                t.operation === identity.operation &&
                (t.topicId ?? '') === (identity.topicId ?? '')
            );
            if (idx === -1) {
              return state;
            }
            return {
              activeTasks: [
                ...state.activeTasks.slice(0, idx),
                ...state.activeTasks.slice(idx + 1),
              ],
            };
          });
          return;
        }

        // ---- CAPTCHA_REQUIRED ----
        // Push a new prompt onto the FIFO queue. If the queue
        // was empty before this push, the user is being asked
        // for the first time in this lull — fire the taskbar
        // notification so a user who is looking at another
        // window knows to come back.
        case 'CAPTCHA_REQUIRED': {
          const payload = readPromptPayload(event.payload, true);
          if (payload === null) {
            return;
          }
          const wasEmpty = get().promptQueue.length === 0;
          const prompt: PromptRequest = {
            id: makePromptId(),
            site: payload.site,
            step: payload.step,
            prompt: payload.prompt,
            isCaptcha: payload.isCaptcha,
            receivedAt: new Date().toISOString(),
          };
          set((state) => ({
            promptQueue: [...state.promptQueue, prompt],
          }));
          if (wasEmpty) {
            void window.electronAPI.window.notify();
          }
          return;
        }

        // ---- MANUAL_ACTION ----
        // Same shape and same handling as CAPTCHA_REQUIRED. The
        // Python side emits these for non-captcha interaction
        // prompts (an overlay to close, a login wall to clear).
        // The store treats them uniformly; the modal distinguishes
        // them for its copy and icon.
        case 'MANUAL_ACTION': {
          const payload = readPromptPayload(event.payload, false);
          if (payload === null) {
            return;
          }
          const wasEmpty = get().promptQueue.length === 0;
          const prompt: PromptRequest = {
            id: makePromptId(),
            site: payload.site,
            step: payload.step,
            prompt: payload.prompt,
            isCaptcha: payload.isCaptcha,
            receivedAt: new Date().toISOString(),
          };
          set((state) => ({
            promptQueue: [...state.promptQueue, prompt],
          }));
          if (wasEmpty) {
            void window.electronAPI.window.notify();
          }
          return;
        }

        // ---- CAPTCHA_SOLVED ----
        // The Python side has confirmed the user cleared the
        // captcha. Remove the first queue entry that matches the
        // payload's (site, step) pair. When the user responded
        // through the modal, the hook has already removed the
        // entry optimistically and this handler is a no-op; when
        // the user solved the captcha in Chrome and the Python
        // script continued without going through the modal, this
        // handler is what cleans up the stale entry.
        case 'CAPTCHA_SOLVED': {
          const payload = readPromptPayload(event.payload, true);
          if (payload === null) {
            return;
          }
          set((state) => {
            const idx = state.promptQueue.findIndex(
              (p) => p.site === payload.site && p.step === payload.step
            );
            if (idx === -1) {
              return state;
            }
            return {
              promptQueue: [
                ...state.promptQueue.slice(0, idx),
                ...state.promptQueue.slice(idx + 1),
              ],
            };
          });
          return;
        }

        // ---- Everything else ----
        // Every other marker type is a different store's concern.
        // See the file header for the routing rules.
        default:
          return;
      }
    },

    // ============================================================
    //  Sync actions
    // ============================================================

    /**
     * Remove a prompt from the queue. With no argument, removes
     * the head (the prompt the modal is currently showing); with
     * an explicit id, removes that specific entry.
     *
     * This action does NOT deliver a response to the blocked
     * child process — see the file header for why the store has
     * no IPC actions. The hook's `submitPromptResponse` composes
     * the IPC delivery with a call to this action.
     */
    dismissPrompt: (id?: string): void => {
      if (id === undefined) {
        set((state) => ({
          promptQueue: state.promptQueue.slice(1),
        }));
        return;
      }
      set((state) => ({
        promptQueue: state.promptQueue.filter((p) => p.id !== id),
      }));
    },

    /** Set the store's error field. Called by the hook. */
    setError: (message: string | null): void => {
      set({ error: message });
    },

    /** Clear the error field. */
    clearError: (): void => {
      set({ error: null });
    },

    /** Empty both arrays. The error field is left as-is. */
    clearAll: (): void => {
      set({
        activeTasks: [],
        promptQueue: [],
      });
    },

    /** Reset every field to its initial value. */
    reset: (): void => {
      set({ ...INITIAL_STATE });
    },
  })
);

// =============================================================================
//  Marker listener installation
// =============================================================================
//
//  The listener is installed ONCE at module load. See the file
//  header for why the subscription lives at the store level
//  rather than per-component.
//
//  The guard `typeof window !== 'undefined'` protects against a
//  non-renderer context (a future test harness that imports the
//  store to exercise its reducers). When the guard fails, the
//  store still works as a pure state container — actions write
//  state, components read state — but the marker stream never
//  arrives. In the app, the guard always passes.

if (
  typeof window !== 'undefined' &&
  typeof window.electronAPI === 'object' &&
  window.electronAPI !== null
) {
  window.electronAPI.on(MARKER_CHANNEL, (raw: unknown) => {
    // The preload passes the marker through unchanged. Its
    // runtime shape is `{ type: string, payload: unknown }`.
    // The type assertion here is safe because the channel is
    // owned by the main process's services, which emit exactly
    // that shape for every message.
    useAutomationStore.getState()._handleMarker(raw as MarkerEvent);
  });
}

// =============================================================================
//  Default export
// =============================================================================

/**
 * The hook as the default export, matching the convention used
 * by every other store in the codebase. Consumers that prefer
 * the named form use `import { useAutomationStore } from ...`;
 * consumers that prefer the default form use
 * `import useAutomationStore from ...`. Both resolve to the same
 * hook.
 */
export default useAutomationStore;