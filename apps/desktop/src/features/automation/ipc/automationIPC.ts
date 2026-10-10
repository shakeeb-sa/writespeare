/**
 * automationIPC — IPC handlers for the automation feature.
 *
 * Registers the three channels the plan's Part 1.16 annotation
 * names:
 *
 *   automation:status  — read the main process's child-process
 *                        registry and return a summary of every
 *                        currently-running task. Used by the
 *                        renderer to reconcile its own task
 *                        list (populated from markers) against
 *                        the main process's ground truth, and by
 *                        a future "recover state after reload"
 *                        flow.
 *
 *   automation:kill    — hard-kill the Python child process
 *                        tree for a given task ID. Used by a
 *                        future "Stop" / "Cancel" affordance on
 *                        a running task card.
 *
 *   window:notify      — flash the taskbar (Windows/Linux) or
 *                        bounce the dock icon (macOS) to draw
 *                        the user's attention. Invoked by the
 *                        automation store when a blocking prompt
 *                        first arrives and the user may be
 *                        looking elsewhere.
 *
 * ── The channel-per-file mismatch ──────────────────────────────
 *
 *   The third channel — `window:notify` — is scoped to the
 *   `WindowNamespace` on the preload, not to an `automation`
 *   namespace. Its presence in this file is dictated by the
 *   plan's Part 1.16 annotation, which lists it as a channel
 *   `automationIPC.ts` registers. The channel name is the one the
 *   preload's `window.notify()` method resolves to, so the
 *   renderer's call site is what the preload declares — this
 *   file's job is to register the handler that makes that call
 *   resolve.
 *
 *   A future session that wanted to reorganise the channel
 *   grouping (moving `window:notify` into a `windowIPC.ts`, for
 *   example) would relocate this one handler and update the
 *   registration call in `main/index.ts`. The channel name would
 *   not change, and the preload's `window.notify()` method would
 *   keep working.
 *
 * ── What "scheduler state" means here ───────────────────────────
 *
 *   The plan's annotation says `automation:status() → scheduler
 *   state`, but the plan's file tree declares no `scheduler`
 *   module. The word "scheduler" in the plan's vocabulary refers
 *   collectively to the child-process manager's registry — the
 *   `processManagers` map that `childProcessManager.ts` owns and
 *   exposes through `getAllRunning()`. That registry is the
 *   authoritative, real-time list of what is currently running.
 *
 *   This handler therefore reads `getAllRunning()` and maps each
 *   entry to a `RunningTaskSummary` — the same four fields the
 *   renderer's automation store tracks on its own `ActiveTask`
 *   entries (`taskId` in place of the store's generated `id`,
 *   plus the process's PID for diagnostics). The store can
 *   compare the two lists to detect stale entries.
 *
 * ── What "kill Python+Chrome" means here ────────────────────────
 *
 *   The plan's annotation says `automation:kill(taskId) → kill
 *   Python+Chrome`. That phrasing is a leftover from ROOKIE,
 *   where each task owned its own Chrome instance and killing the
 *   task meant killing the browser too.
 *
 *   WriteSpeare's architecture is different: Chrome is a single
 *   shared instance, launched by the Electron main process
 *   (`chromeLauncher.ts`) and reused across every topic and every
 *   task. Killing it would destroy the user's DeepSeek login —
 *   the persistent session the plan's Stage 0 setup was built
 *   around — and force a re-authentication on the next writer
 *   operation.
 *
 *   This handler therefore kills only the Python child process
 *   tree, via the `ChildProcessManager.kill()` method that uses
 *   `tree-kill` to terminate the child and every descendant it
 *   spawned. In the current architecture, Chrome is not a
 *   descendant of any Python child (the main process launches it
 *   directly), so Chrome survives a task kill intact. Chrome's
 *   lifecycle is managed by `main/index.ts`'s `before-quit`
 *   handler, which closes it when the app itself is shutting
 *   down.
 *
 *   If a future session changes the architecture to give each
 *   task its own Chrome instance (a possible design for a future
 *   "run several searches in parallel on isolated profiles"
 *   feature), this handler would need to also kill that task's
 *   Chrome. The current design does not warrant it.
 *
 * ── Why the kill handler returns success for a missing task ─────
 *
 *   `automation:kill(taskId)` returns `{ success: true, data:
 *   null }` whether or not a manager was found for the ID. A
 *   missing manager means the task is no longer running — either
 *   it finished on its own, or a previous kill call already
 *   terminated it. The user's intent ("this task should not be
 *   running") is satisfied either way. Reporting a failure for a
 *   missing manager would produce a spurious error toast on the
 *   renderer, which is worse than the tiny information loss of
 *   not distinguishing the two cases.
 *
 * ── The renderer-side reconciliation this file does not do ──────
 *
 *   When a task is hard-killed, its Python child does not get a
 *   chance to emit the closing `TASK_END` marker that the
 *   renderer's automation store uses to prune its `activeTasks`
 *   list. The killed task therefore lingers in the renderer's
 *   store until the store reconciles against `automation:status`.
 *
 *   That reconciliation is not this file's concern — this file
 *   registers handlers, it does not drive state changes in the
 *   renderer. Two paths exist for a future session to close the
 *   gap:
 *
 *     1. The renderer could poll `automation:status` after a
 *        successful kill and reconcile. The `useAutomation`
 *        hook would call it; the store would expose a `reconcile`
 *        action.
 *
 *     2. The preload's `window.notify()` could be paired with a
 *        new `automation:kill` method that resolves with the
 *        killed task's ID, and the hook could optimistically
 *        remove the entry.
 *
 *   Neither path is implemented today. The gap is logged in the
 *   PLAN DELTA section below alongside the preload's missing
 *   `automation` namespace.
 *
 * ── The preload's missing namespace ─────────────────────────────
 *
 *   The preload's `ElectronAPI` interface declares a `window`
 *   namespace (with the `notify()` method this file's third
 *   handler serves) but no `automation` namespace. So today, only
 *   the third channel has a renderer-reachable invocation path;
 *   the first two — `automation:status` and `automation:kill` —
 *   register handlers that no renderer code can yet call.
 *
 *   This is the same PLAN DELTA that `automationStore.ts` and
 *   `useAutomation.ts` logged in the preceding two steps. Adding
 *   the `automation` namespace to `src/main/preload.ts` is a
 *   coordinated modification to an existing file, which the
 *   current file-creation protocol forbids. It is logged below,
 *   not performed here.
 *
 *   The registration of the channels is still valuable today: it
 *   makes the handlers exist so that when the preload extension
 *   lands, the IPC surface is ready to receive calls. The
 *   alternative — leaving the channels unregistered until the
 *   preload exists — would force the eventual preload change to
 *   be accompanied by a second change to this file, splitting the
 *   feature's integration across two sessions instead of one.
 *
 * ── What this file does NOT do ──────────────────────────────────
 *
 *   - It does not touch the automation store. The store lives in
 *     the renderer's memory; the main process cannot reach it.
 *     The store reconciles itself from markers and, once the
 *     preload extension lands, from the two channels this file
 *     registers.
 *
 *   - It does not kill Chrome. See the "What 'kill Python+Chrome'
 *     means here" section above.
 *
 *   - It does not emit markers. The automation IPC layer is a
 *     request-response surface — the renderer asks a question,
 *     receives an envelope, and decides what to do. There is no
 *     streaming progress to broadcast.
 *
 *   - It does not validate the shape of a `taskId` beyond its
 *     type and non-emptiness. The `childProcessManager`'s
 *     registry lookup is O(1) and treats any non-empty string as
 *     a valid key; a task ID that does not match any running
 *     manager produces the missing-manager path, which is the
 *     same success response a matching task would produce after
 *     a successful kill. There is no schema for a task ID to
 *     validate against.
 *
 * Dependencies: electron + the shared child-process manager +
 * the shared `ApiResponse` type. All present.
 */

import {
  app,
  BrowserWindow,
  ipcMain,
  type IpcMainInvokeEvent,
} from 'electron';

import {
  getAllRunning,
  getByTaskId,
} from '../../research/services/childProcessManager.js';

import type { ApiResponse } from '../../shared/types/index.js';

// ============================================================
//  Channel name constants
// ============================================================
//
// The three channel names are declared as constants so a future
// refactor that renames them (or a test that spies on them) has
// one place to change. The preload's `src/main/preload.ts`
// declares the same strings on the renderer side of the bridge —
// two of them under an `automation` namespace that the preload
// does not yet declare (see the file header's PLAN DELTA), and
// one under the `window` namespace that already exists.

const CHANNEL_STATUS = 'automation:status';
const CHANNEL_KILL = 'automation:kill';
const CHANNEL_WINDOW_NOTIFY = 'window:notify';

// ============================================================
//  Public types
// ============================================================

/**
 * A single running task, as reported by the `automation:status`
 * handler.
 *
 * The shape is a summary of the main process's view of a task,
 * not the same shape as the renderer's `ActiveTask` (see
 * `automationStore.ts`). The two are deliberately distinct:
 *
 *   * The renderer's `ActiveTask` carries a store-generated `id`
 *     (for React keys), the operation name, an optional topic ID,
 *     and the timestamp when the store first saw the marker. It
 *     is populated from `TASK_START` markers, which are broadcast
 *     to every renderer window in arrival order.
 *
 *   * This `RunningTaskSummary` carries the task ID (the
 *     deterministic key the main process uses to register the
 *     manager — e.g., `${topicId}-search`), and the process's PID
 *     for diagnostics. It is populated from the manager registry,
 *     which is the main process's ground truth.
 *
 *   The renderer's reconciliation logic (not implemented here —
 *   see the file header) would compare the two lists to detect
 *   divergence: a task present in the summary but absent from the
 *   store means a task was started before the renderer subscribed
 *   (a reload during a running task); a task present in the store
 *   but absent from the summary means a hard-killed task whose
 *   `TASK_END` marker never fired.
 *
 *   `pid` is `null` for a manager whose child process has no
 *   assigned PID — a rare state that occurs only during the
 *   brief window between spawn and the OS assigning a PID, or for
 *   a manager whose spawn failed after registration. It is
 *   exposed because a future diagnostic view (a "running tasks"
 *   panel with per-task PID) would want it; the current renderer
 *   does not consume it.
 */
export interface RunningTaskSummary {
  /** The deterministic task ID — e.g., `${topicId}-search` or
   *  `${topicId}-write`. Matches the ID the corresponding service
   *  uses to register the manager. */
  taskId: string;

  /** The child process's PID, or `null` when none is available. */
  pid: number | null;
}

// ============================================================
//  registerAutomationIPC
// ============================================================

/**
 * Register the automation feature's IPC handlers.
 *
 * Called once, from `main/index.ts`, inside the
 * `app.whenReady().then(...)` callback — the same place every
 * other feature's registration function is called. The function
 * is not idempotent: `ipcMain.handle` refuses to register a
 * second handler for the same channel, and a second call would
 * therefore produce Electron errors. The single-call contract is
 * the same one every other feature's `register*IPC()` function
 * follows.
 */
export const registerAutomationIPC = (): void => {
  // ---- automation:status ----
  //
  // Read the child-process manager's registry and return a
  // summary of every currently-running task.
  //
  // A rejection here would be unexpected — `getAllRunning()` is a
  // synchronous read of an in-memory Map — but the try/catch is
  // defensive against a future change to the manager module that
  // introduced an async path or a validation step. The catch
  // returns a well-formed error envelope rather than letting the
  // exception escape as an unhandled rejection.
  ipcMain.handle(
    CHANNEL_STATUS,
    async (
      _event: IpcMainInvokeEvent
    ): Promise<ApiResponse<RunningTaskSummary[]>> => {
      try {
        const managers = getAllRunning();
        const summaries: RunningTaskSummary[] = managers.map((m) => ({
          taskId: m.taskId,
          pid: m.getPid(),
        }));
        return { success: true, data: summaries };
      } catch (err) {
        const message =
          err instanceof Error ? err.message : String(err);
        return {
          success: false,
          error: `Could not read scheduler state: ${message}`,
        };
      }
    }
  );

  // ---- automation:kill ----
  //
  // Hard-kill the Python child process tree registered under the
  // supplied task ID. A missing manager — the task has already
  // finished, or a previous kill already terminated it — is not
  // an error; see the file header for the rationale.
  //
  // The `manager.kill()` call is fire-and-forget: the
  // `ChildProcessManager` class's own implementation dispatches
  // the tree-kill and returns. The renderer's `killed` event (and
  // therefore its state update path) is not this handler's
  // concern — the store reconciles from markers and, once the
  // preload extension lands, from a `automation:status` refresh
  // that the hook performs after a kill resolves.
  ipcMain.handle(
    CHANNEL_KILL,
    async (
      _event: IpcMainInvokeEvent,
      taskId: unknown
    ): Promise<ApiResponse<null>> => {
      // ---- 1. Validate the argument ----
      if (typeof taskId !== 'string' || taskId.length === 0) {
        return {
          success: false,
          error: 'taskId is required.',
        };
      }

      // ---- 2. Look up the manager ----
      // A `null` return from `getByTaskId` means no manager is
      // registered under that ID. This is a legitimate state:
      // the task has already finished, or was never started, or
      // was already killed. Treat it as success — see the file
      // header.
      try {
        const manager = getByTaskId(taskId);
        if (manager !== null) {
          manager.kill();
        }
        return { success: true, data: null };
      } catch (err) {
        const message =
          err instanceof Error ? err.message : String(err);
        return {
          success: false,
          error: `Could not kill task: ${message}`,
        };
      }
    }
  );

  // ---- window:notify ----
  //
  // Flash the taskbar (Windows/Linux) and bounce the dock icon
  // (macOS) to draw the user's attention. Invoked by the
  // automation store when a blocking prompt first arrives and
  // the user may be looking at another window.
  //
  // The two platform-specific behaviors are wrapped in a single
  // try/catch because either can throw in an unusual state:
  // `flashFrame` on a window that is mid-destruction, `dock.bounce`
  // on a macOS system where the dock process is not reachable.
  // The handler returns a success envelope regardless — a failed
  // notification is a small UX regression, not a state the
  // renderer needs to know about.
  //
  // The `app.dock?.bounce(...)` form uses optional chaining
  // because Electron's types declare `app.dock` as
  // `Dock | undefined` on non-macOS platforms. The optional
  // chaining is what makes the call a no-op on Windows and Linux
  // without a runtime platform check.
  ipcMain.handle(
    CHANNEL_WINDOW_NOTIFY,
    async (_event: IpcMainInvokeEvent): Promise<ApiResponse<null>> => {
      try {
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) {
            win.flashFrame(true);
          }
        }
        app.dock?.bounce('informational');
      } catch (err) {
        // Log for the operator. The envelope is still success —
        // see the comment above for the rationale.
        console.error('[automationIPC] window:notify failed:', err);
      }
      return { success: true, data: null };
    }
  );
};

// ============================================================
//  Default export
// ============================================================

/**
 * The registration function as the default export, matching the
 * convention used by every other IPC module in the codebase.
 * `main/index.ts` uses the named import
 * (`import { registerAutomationIPC } from ...`), so the default
 * form is a convenience rather than a load-bearing export.
 */
export default registerAutomationIPC;