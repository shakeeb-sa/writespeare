/**
 * writerStore — the renderer's transient state for the writer
 * feature.
 *
 * Holds the state that drives the Article tab on the topic-detail
 * page while a DeepSeek generation is running and after it
 * finishes:
 *
 *   activeTopicId     — which topic the state belongs to.
 *   isGenerating      — whether a writer operation is currently
 *                       in flight. Drives the Article tab's
 *                       progress panel and the disabled state
 *                       of the "Generate" button.
 *   progress          — the live progress of the running
 *                       generation (which doc is being pasted,
 *                       which phase is active), or null when
 *                       no generation is running.
 *   article           — the `Article` object the backend returned
 *                       for the last successful generation, or
 *                       null before the first generation. The
 *                       Article tab renders this object's
 *                       `content` field; a reader that wants to
 *                       see the last-generated article without
 *                       re-generating reads this field.
 *   status            — a coarse lifecycle flag mirroring the
 *                       shape every other store uses (`'idle'`,
 *                       `'loading'`, `'error'`). `isGenerating`
 *                       is derived from this and is exposed as a
 *                       convenience for the UI.
 *   error             — the last error message, or null.
 *
 * And the actions:
 *
 *   generate(topicId) — start a writer operation. Sets
 *                       `isGenerating: true`, kicks off the IPC
 *                       call, and updates state as the operation
 *                       runs and as markers arrive.
 *   cancel(topicId)   — cancel the running operation via the IPC
 *                       layer. Fire-and-forget; the operation's
 *                       terminal state is observed through the
 *                       IPC promise's resolution.
 *   setArticle(art)   — set the current article directly. Used
 *                       by a caller that fetched the article
 *                       from the backend outside of a generate
 *                       call.
 *   clearError()      — dismiss the last error.
 *   reset()           — return every field to its initial value.
 *
 * ── How the store receives updates ────────────────────────────
 *
 *   Same pattern as `researchStore.ts`. On module load, the store
 *   installs ONE listener on the `research:marker` channel via
 *   the preload's generic `window.electronAPI.on(...)` API. Every
 *   marker the main process emits — from searchService,
 *   extractionService, writerService, and later validationService
 *   — flows through that one channel, and each store's handler
 *   routes the marker types it cares about to its own state.
 *
 *   The writer store's handler reacts to `WRITER_PROGRESS` and
 *   `WRITER_DONE`. It ignores every other marker type. A marker
 *   whose `topicId` does not match the store's `activeTopicId` is
 *   dropped, so a concurrent operation on a different topic does
 *   not clobber this store's state.
 *
 * ── Why `isGenerating` is not flipped by the WRITER_DONE marker ─
 *
 *   The `WRITER_DONE` marker is emitted by the Python script
 *   BEFORE the writer IPC handler has finished its work. After
 *   the marker arrives, the main process still has to (a) read
 *   the draft file from disk, (b) POST it to the backend's
 *   `/api/articles` endpoint, and (c) return the resulting
 *   `Article` to the renderer. Flipping `isGenerating` to false
 *   on the marker would tell the UI "we are done" before the
 *   article object is in the store, producing a brief interval
 *   where the Article tab shows neither a progress panel nor a
 *   finished article.
 *
 *   The `generate` action therefore owns `isGenerating` from
 *   start to finish. The `WRITER_DONE` marker handler only
 *   clears the `progress` field — the progress panel is no
 *   longer relevant once the child has exited — and the `generate`
 *   action's terminal branch flips both `status` and
 *   `isGenerating` when the IPC promise resolves.
 *
 * ── Why the store is NOT persisted ────────────────────────────
 *
 *   Same reasoning as `researchStore.ts`. The article object is
 *   an in-memory mirror of a backend record; a fresh session
 *   repopulates it by generating again or by fetching from the
 *   backend. The `isGenerating`, `progress`, and `error` fields
 *   are ephemeral by definition.
 *
 * ── The single-topic design ───────────────────────────────────
 *
 *   The store holds one topic's generation state at a time,
 *   identified by `activeTopicId`. Same model as `researchStore`.
 *   A future session that wanted parallel generation across
 *   multiple topics would convert the flat state into a
 *   `Map<topicId, WriterState>` — a mechanical change confined
 *   to this file.
 *
 * ── Why the type-only import from listenerBridge ──────────────
 *
 *   `MarkerEvent` is declared in `listenerBridge.ts`, a
 *   main-process module that imports `BrowserWindow` from
 *   `electron`. A runtime import would crash the renderer at
 *   bundle time. The `import type` form is erased by the
 *   compiler, so the runtime bundle contains no reference to
 *   `listenerBridge` — the type is available to the compiler and
 *   unavailable to the runtime, which is exactly what is wanted.
 *
 *   The channel name `'research:marker'` is declared as a local
 *   constant in this file rather than imported, for the same
 *   reason. The two strings must match; the cross-module contract
 *   is documented in both files.
 *
 * ── What this store does NOT do ────────────────────────────────
 *
 *   - It does not persist. See above.
 *
 *   - It does not call the backend directly. The
 *     `writer:generate` IPC handler (in the main process) is what
 *     POSTs the article to `/api/articles`; the store only
 *     invokes the IPC channel and receives the resulting
 *     `Article`.
 *
 *   - It does not handle the captcha or manual-action modals.
 *     Those markers (`CAPTCHA_REQUIRED`, `CAPTCHA_SOLVED`,
 *     `MANUAL_ACTION`) reach the renderer over the same channel
 *     and are routed by the automation store (Session 20). This
 *     store's handler explicitly ignores them.
 *
 *   - It does not distinguish "no article yet" from "the article
 *     is being fetched". Both cases are represented by
 *     `article === null` with `isGenerating` being the
 *     differentiator. A component that renders the Article tab
 *     reads both fields.
 */

import { create } from 'zustand';

import type { MarkerEvent } from '../../research/services/listenerBridge.js';
import type { Article } from '../../shared/types/index.js';

// =============================================================================
//  Channel name
// =============================================================================
//
//  The IPC channel the main process emits every marker on. Must
//  match `listenerBridge.ts`'s exported `MARKER_EVENT_CHANNEL`
//  constant and `researchStore.ts`'s local declaration of the
//  same value. Declared locally because the bridge module cannot
//  be imported at runtime — see the file header.

const MARKER_CHANNEL = 'research:marker';

// =============================================================================
//  Public types
// =============================================================================

/**
 * The five phases a generation passes through, as reported by
 * `deepseek_writer.py`'s `WRITER_PROGRESS` markers. Each phase
 * has its own display string in the `WriterProgress` panel.
 */
export type WriterPhase =
  | 'pasting'
  | 'typing'
  | 'sending'
  | 'waiting'
  | 'copying';

/**
 * Live progress of a running generation. The three optional
 * fields (`index`, `total`, `fileName`) are populated only during
 * the `'pasting'` phase — the other phases do not have per-item
 * progress to report. A consumer that renders the panel reads the
 * `phase` to pick the display string and uses the three optional
 * fields when the phase is `'pasting'`.
 */
export interface WriterProgress {
  /** Which phase of the writer is currently running. */
  phase: WriterPhase;

  /** The 1-based index of the doc currently being pasted.
   *  Present only when `phase === 'pasting'`. */
  index?: number;

  /** The total number of docs being pasted.
   *  Present only when `phase === 'pasting'`. */
  total?: number;

  /** The filename of the doc currently being pasted.
   *  Present only when `phase === 'pasting'`. */
  fileName?: string;
}

/**
 * The store's async lifecycle state. Same shape as the other
 * stores' status types.
 *
 *   'idle'    — no operation is running, and the last one (if
 *               any) succeeded. The default state.
 *   'loading' — a generation is in flight. Also reflected in
 *               the `isGenerating` boolean, which exists as a
 *               convenience for consumers that only care about
 *               that one boolean.
 *   'error'   — the last operation failed. The `error` field
 *               carries a user-facing message.
 */
export type WriterStoreStatus = 'idle' | 'loading' | 'error';

/**
 * The full shape of the writer store's state, including both the
 * data fields and the actions.
 */
export interface WriterStoreState {
  // ---- Data ----

  /** The topic the state belongs to, or null before any
   *  generation. Markers whose `topicId` does not match this
   *  value are dropped by the marker handler. */
  activeTopicId: string | null;

  /** Whether a writer operation is currently in flight. */
  isGenerating: boolean;

  /** The live progress of the running operation, or null when
   *  no operation is running. */
  progress: WriterProgress | null;

  /** The `Article` object from the last successful generation,
   *  or null before the first generation. */
  article: Article | null;

  /** The store's async lifecycle state. See `WriterStoreStatus`. */
  status: WriterStoreStatus;

  /** The last error message, or null. */
  error: string | null;

  // ---- Actions ----

  /**
   * Run a writer operation for a topic. Invokes
   * `window.electronAPI.writer.generate(topicId)` and updates
   * state as the operation runs. Progress arrives through the
   * marker channel; the final `Article` arrives as this action's
   * return value.
   *
   * Returns the created `Article` on success, or null on
   * failure. The caller (`useWriter`) can use the truthiness of
   * the return value to decide whether to fire a success toast.
   */
  generate: (topicId: string) => Promise<Article | null>;

  /**
   * Cancel the running generation for a topic. Invokes
   * `window.electronAPI.writer.cancel(topicId)`.
   *
   * Resolves once the IPC call has returned. The store's
   * `isGenerating` and `status` fields are NOT flipped by this
   * action — the `generate` action's in-flight promise is what
   * flips them when the cancellation causes the child to exit.
   */
  cancel: (topicId: string) => Promise<void>;

  /**
   * Set the current article directly. Used by a caller that
   * fetched the article from the backend outside a generate
   * call — for example, the useWriter hook's "load the last
   * saved article on mount" flow.
   */
  setArticle: (article: Article | null) => void;

  /** Clear the last error message. */
  clearError: () => void;

  /** Reset every field to its initial value. */
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
  activeTopicId: null as string | null,
  isGenerating: false,
  progress: null as WriterProgress | null,
  article: null as Article | null,
  status: 'idle' as WriterStoreStatus,
  error: null as string | null,
};

// =============================================================================
//  Marker payload narrowing
// =============================================================================
//
//  The marker handler's payloads arrive as `unknown`. The
//  helpers below narrow the ones this store cares about. A
//  malformed payload is silently ignored rather than throwing —
//  a broken marker must not crash the UI.

/**
 * Read the `topicId` field from a marker's payload, or return
 * null. Used by every marker handler to filter out markers that
 * belong to a different topic.
 */
const readTopicId = (payload: unknown): string | null => {
  if (typeof payload !== 'object' || payload === null) {
    return null;
  }
  const t = (payload as { topicId?: unknown }).topicId;
  return typeof t === 'string' && t.length > 0 ? t : null;
};

/**
 * The set of legal `phase` values, as a runtime array. Used by
 * `narrowWriterProgress` to validate the phase before narrowing.
 */
const VALID_PHASES: readonly WriterPhase[] = [
  'pasting',
  'typing',
  'sending',
  'waiting',
  'copying',
];

const isWriterPhase = (value: unknown): value is WriterPhase =>
  typeof value === 'string' &&
  (VALID_PHASES as readonly string[]).includes(value);

/**
 * Narrow a `WRITER_PROGRESS` payload into a `WriterProgress`.
 * Returns null for a payload without a recognizable phase, or
 * for a `'pasting'` payload missing any of the three per-doc
 * fields.
 *
 * The three per-doc fields are required when the phase is
 * `'pasting'`, because a "pasting" progress panel with no
 * index/total/fileName would have nothing to display — the
 * payload is more likely to be a bug than a legitimate partial
 * state.
 */
const narrowWriterProgress = (
  payload: unknown
): WriterProgress | null => {
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as Record<string, unknown>;
  const phase = p['phase'];
  if (!isWriterPhase(phase)) return null;

  if (phase !== 'pasting') {
    return { phase };
  }

  const index = p['index'];
  const total = p['total'];
  const fileName = p['fileName'];
  if (
    typeof index !== 'number' ||
    typeof total !== 'number' ||
    typeof fileName !== 'string'
  ) {
    return null;
  }

  return { phase, index, total, fileName };
};

// =============================================================================
//  Store
// =============================================================================

/**
 * The writer store. See the file header for its responsibilities,
 * its subscription model, and the reasoning behind its design.
 *
 * Created without middleware — no `persist` (the store is
 * transient), no `devtools`, no Immer. Same shape as
 * `researchStore.ts`.
 */
export const useWriterStore = create<WriterStoreState>((set, get) => ({
  // ---- Initial data ----
  ...INITIAL_STATE,

  // ---- Marker handler ----
  //
  // Reacts to the two writer-stage marker types. Every other
  // marker is ignored — CAPTCHA_REQUIRED, MANUAL_ACTION,
  // SEARCH_*, EXTRACT_*, and the task-boundary markers all
  // belong to other stores.
  _handleMarker: (event: MarkerEvent): void => {
    const topicId = readTopicId(event.payload);
    if (topicId === null) return;
    if (topicId !== get().activeTopicId) return;

    switch (event.type) {
      case 'WRITER_PROGRESS': {
        const progress = narrowWriterProgress(event.payload);
        if (progress !== null) {
          set({ progress });
        }
        return;
      }

      case 'WRITER_DONE': {
        // The child has exited. Clear the progress panel — the
        // panel is no longer relevant — but leave
        // `isGenerating` and `status` for the `generate`
        // action's in-flight promise to flip. See the file
        // header's "Why isGenerating is not flipped by the
        // WRITER_DONE marker" section.
        set({ progress: null });
        return;
      }

      default:
        // TASK_START, TASK_END, CAPTCHA_REQUIRED,
        // CAPTCHA_SOLVED, MANUAL_ACTION, SEARCH_*,
        // EXTRACT_*, and the validation markers. None of these
        // are this store's concern.
        return;
    }
  },

  // ---- generate ----
  generate: async (topicId: string): Promise<Article | null> => {
    // Set the active topic and flip the in-flight flags. The
    // `article` field is NOT cleared here — a re-generate
    // keeps the previous article visible until the new one
    // lands, so the user is never staring at an empty tab
    // while the operation runs.
    set({
      activeTopicId: topicId,
      isGenerating: true,
      progress: null,
      status: 'loading',
      error: null,
    });

    try {
      const result = await window.electronAPI.writer.generate(topicId);

      if (result.success && result.data) {
        const article = result.data;
        set({
          article,
          isGenerating: false,
          progress: null,
          status: 'idle',
        });
        return article;
      }

      set({
        isGenerating: false,
        progress: null,
        status: 'error',
        error: result.error ?? 'Article generation failed.',
      });
      return null;
    } catch (err) {
      // An IPC rejection is unusual — the preload resolves
      // business failures into envelopes — but can happen if
      // the channel is unregistered or the renderer's context
      // has been torn down.
      console.error('[writerStore] generate failed:', err);
      set({
        isGenerating: false,
        progress: null,
        status: 'error',
        error:
          err instanceof Error
            ? err.message
            : 'Unable to reach the writer service.',
      });
      return null;
    }
  },

  // ---- cancel ----
  cancel: async (topicId: string): Promise<void> => {
    try {
      await window.electronAPI.writer.cancel(topicId);
    } catch (err) {
      // Cancelling is a best-effort operation. A failure here
      // means the channel was unreachable, which is itself the
      // sign that the operation has already stopped (the main
      // process is gone). Log for a developer; do not surface
      // to the user.
      console.error('[writerStore] cancel failed:', err);
    }
    // `isGenerating` and `status` are flipped by the
    // `generate` action's in-flight promise when it resolves.
    // This action does not optimistically set them, because
    // doing so would race the terminal marker that arrives a
    // moment later.
  },

  // ---- setArticle ----
  setArticle: (article: Article | null): void => {
    set({ article });
  },

  // ---- Clear helpers ----
  clearError: (): void => {
    set({ error: null });
    if (get().status === 'error') {
      set({ status: 'idle' });
    }
  },

  reset: (): void => {
    set({ ...INITIAL_STATE });
  },
}));

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
    useWriterStore
      .getState()
      ._handleMarker(raw as MarkerEvent);
  });
}

// =============================================================================
//  Default export
// =============================================================================

/**
 * The hook as the default export, matching the convention used
 * by every other store in the codebase. Consumers that prefer
 * the named form use `import { useWriterStore } from ...`;
 * consumers that prefer the default form use
 * `import useWriterStore from ...`. Both resolve to the same
 * hook.
 */
export default useWriterStore;