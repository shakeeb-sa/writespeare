/**
 * writerStore — the renderer's transient state for the writer
 * feature.
 *
 * Holds the state that drives the Article tab on the topic-detail
 * page while a DeepSeek generation is running and after it
 * finishes. Every piece of per-topic state is a record keyed by
 * the topic's ID, so switching between topics never clobbers the
 * previous topic's data:
 *
 *   activeTopicId        — the topic that most recently started a
 *                          generation. A tracking field only; the
 *                          marker handler no longer filters on it.
 *   articlesByTopic      — per-topic article cache. The value is
 *                          the `Article` object the backend
 *                          returned for the last successful
 *                          generation, or null when the topic has
 *                          been loaded and confirmed to have no
 *                          article. Absence of a key means "not
 *                          yet loaded".
 *   progressByTopic      — per-topic live progress of a running
 *                          generation, or null when none is
 *                          running.
 *   isGeneratingByTopic  — per-topic in-flight flag. Drives the
 *                          Article tab's progress panel and the
 *                          disabled state of the "Generate"
 *                          button.
 *   statusByTopic        — per-topic lifecycle flag mirroring the
 *                          shape every other store uses (`'idle'`,
 *                          `'loading'`, `'error'`). Absence of a
 *                          key is treated as `'idle'`.
 *   errorByTopic         — per-topic last error message, or null.
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
 *   `WRITER_DONE`. It ignores every other marker type. Each
 *   marker is routed to its own topic's slot using the `topicId`
 *   field on the payload — so a marker that arrives for a topic
 *   other than the one the user is currently viewing updates the
 *   correct slot in the background rather than being dropped.
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
 *   backend. The per-topic `isGeneratingByTopic`,
 *   `progressByTopic`, and `errorByTopic` records are ephemeral
 *   by definition.
 *
 * ── The per-topic design ──────────────────────────────────────
 *
 *   Every piece of per-topic state lives in a record keyed by
 *   the topic's ID — `articlesByTopic`, `progressByTopic`,
 *   `isGeneratingByTopic`, `statusByTopic`, and `errorByTopic`.
 *   Switching between topics does not clobber any previous
 *   topic's state; the store simply holds a slot for every topic
 *   that has been loaded or generated for this session.
 *
 *   The marker handler routes each incoming marker to its own
 *   topic's slot using the `topicId` on the payload, so markers
 *   that arrive while the user is viewing a different topic are
 *   still applied to the correct slot. When the user navigates
 *   back, the state is already there.
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

  /** The topic that most recently started a generation, or null
   *  before any generation. A tracking field only — the marker
   *  handler routes each incoming marker to its own topic's slot
   *  using the payload's `topicId` field, not this value. */
  activeTopicId: string | null;

  /** Per-topic article cache. Keyed by the topic's ID. The value
   *  is the `Article` object from the last successful generation,
   *  or null when the topic has been loaded and confirmed to have
   *  no article. Absence of a key means "not yet loaded". */
  articlesByTopic: Record<string, Article | null>;

  /** Per-topic live progress of the running operation, or null
   *  when no operation is running. */
  progressByTopic: Record<string, WriterProgress | null>;

  /** Per-topic in-flight flag. Absence of a key is treated as
   *  `false`. */
  isGeneratingByTopic: Record<string, boolean>;

  /** Per-topic async lifecycle state. See `WriterStoreStatus`.
   *  Absence of a key is treated as `'idle'`. */
  statusByTopic: Record<string, WriterStoreStatus>;

  /** Per-topic last error message, or null. */
  errorByTopic: Record<string, string | null>;

  // ---- Actions ----

  /**
   * Run a writer operation for a topic. Invokes
   * `window.electronAPI.writer.generate(topicId)` and updates
   * this topic's slots as the operation runs. Progress arrives
   * through the marker channel; the final `Article` arrives as
   * this action's return value.
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
   * Resolves once the IPC call has returned. The per-topic
   * `isGeneratingByTopic` and `statusByTopic` entries are NOT
   * flipped by this action — the `generate` action's in-flight
   * promise is what flips them when the cancellation causes the
   * child to exit.
   */
  cancel: (topicId: string) => Promise<void>;

  /**
   * Load the latest article for a topic from the backend, and
   * cache it in the topic's slot. Called by the hook on first
   * open of a topic; subsequent calls for a topic that already
   * has a slot are no-ops.
   */
  loadLatest: (topicId: string) => Promise<void>;

  /**
   * Set a topic's article directly, without a network round trip.
   * Used by a caller that has an article in hand — the
   * ArticlePreview's inline edit save, or a caller that fetched
   * the article through some other path. Pass null to clear.
   */
  setArticle: (topicId: string, article: Article | null) => void;

  /** Clear the last error message for a topic. */
  clearError: (topicId: string) => void;

  /** Reset every field to its initial value. */
  reset: () => void;

  // ---- Per-topic getters ----

  /** Return the cached article for a topic, or null when none is
   *  loaded or the topic has no article. */
  getArticle: (topicId: string) => Article | null;

  /** Return the live progress for a topic, or null when none. */
  getProgress: (topicId: string) => WriterProgress | null;

  /** Return whether a generation is in flight for a topic. */
  getIsGenerating: (topicId: string) => boolean;

  /** Return the async lifecycle state for a topic. */
  getStatus: (topicId: string) => WriterStoreStatus;

  /** Return the last error message for a topic, or null. */
  getError: (topicId: string) => string | null;

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
  articlesByTopic: {} as Record<string, Article | null>,
  progressByTopic: {} as Record<string, WriterProgress | null>,
  isGeneratingByTopic: {} as Record<string, boolean>,
  statusByTopic: {} as Record<string, WriterStoreStatus>,
  errorByTopic: {} as Record<string, string | null>,
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
  //
  // Each marker is routed to its own topic's slot using the
  // `topicId` on the payload. The handler does NOT filter on
  // `activeTopicId` — a marker that arrives for a topic the
  // user is not currently viewing must still update that
  // topic's slot, so that navigating back to it shows the
  // correct state.
  _handleMarker: (event: MarkerEvent): void => {
    const topicId = readTopicId(event.payload);
    if (topicId === null) return;

    switch (event.type) {
      case 'WRITER_PROGRESS': {
        const progress = narrowWriterProgress(event.payload);
        if (progress !== null) {
          set((state) => ({
            progressByTopic: {
              ...state.progressByTopic,
              [topicId]: progress,
            },
          }));
        }
        return;
      }

      case 'WRITER_DONE': {
        // The child has exited. Clear the progress panel — the
        // panel is no longer relevant — but leave
        // `isGeneratingByTopic` and `statusByTopic` for the
        // `generate` action's in-flight promise to flip. See
        // the file header's "Why isGenerating is not flipped
        // by the WRITER_DONE marker" section.
        set((state) => ({
          progressByTopic: {
            ...state.progressByTopic,
            [topicId]: null,
          },
        }));
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
    // Flip the in-flight flags for this topic. The
    // `articlesByTopic[topicId]` slot is NOT cleared here — a
    // re-generate keeps the previous article visible until the
    // new one lands, so the user is never staring at an empty
    // tab while the operation runs.
    set((state) => ({
      activeTopicId: topicId,
      isGeneratingByTopic: {
        ...state.isGeneratingByTopic,
        [topicId]: true,
      },
      progressByTopic: {
        ...state.progressByTopic,
        [topicId]: null,
      },
      statusByTopic: {
        ...state.statusByTopic,
        [topicId]: 'loading',
      },
      errorByTopic: {
        ...state.errorByTopic,
        [topicId]: null,
      },
    }));

    try {
      const result = await window.electronAPI.writer.generate(topicId);

      if (result.success && result.data) {
        const article = result.data;
        set((state) => ({
          articlesByTopic: {
            ...state.articlesByTopic,
            [topicId]: article,
          },
          isGeneratingByTopic: {
            ...state.isGeneratingByTopic,
            [topicId]: false,
          },
          progressByTopic: {
            ...state.progressByTopic,
            [topicId]: null,
          },
          statusByTopic: {
            ...state.statusByTopic,
            [topicId]: 'idle',
          },
        }));
        return article;
      }

      set((state) => ({
        isGeneratingByTopic: {
          ...state.isGeneratingByTopic,
          [topicId]: false,
        },
        progressByTopic: {
          ...state.progressByTopic,
          [topicId]: null,
        },
        statusByTopic: {
          ...state.statusByTopic,
          [topicId]: 'error',
        },
        errorByTopic: {
          ...state.errorByTopic,
          [topicId]: result.error ?? 'Article generation failed.',
        },
      }));
      return null;
    } catch (err) {
      // An IPC rejection is unusual — the preload resolves
      // business failures into envelopes — but can happen if
      // the channel is unregistered or the renderer's context
      // has been torn down.
      console.error('[writerStore] generate failed:', err);
      set((state) => ({
        isGeneratingByTopic: {
          ...state.isGeneratingByTopic,
          [topicId]: false,
        },
        progressByTopic: {
          ...state.progressByTopic,
          [topicId]: null,
        },
        statusByTopic: {
          ...state.statusByTopic,
          [topicId]: 'error',
        },
        errorByTopic: {
          ...state.errorByTopic,
          [topicId]:
            err instanceof Error
              ? err.message
              : 'Unable to reach the writer service.',
        },
      }));
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
    // `isGeneratingByTopic[topicId]` and `statusByTopic[topicId]`
    // are flipped by the `generate` action's in-flight promise
    // when it resolves. This action does not optimistically set
    // them, because doing so would race the terminal marker
    // that arrives a moment later.
  },

    // ---- loadLatest ----
  loadLatest: async (topicId: string): Promise<void> => {
    // "Fetch on first open" semantics: if the topic already has
    // a loaded slot (even a `null` one), do not refetch. The
    // check is `!== undefined` rather than a truthy check
    // because `null` is a legitimate cached value meaning
    // "loaded, no article yet".
    if (get().articlesByTopic[topicId] !== undefined) {
      return;
    }

    try {
      const result = await window.electronAPI.writer.getLatest(topicId);

      if (result.success) {
        // Success with `data` non-null means an article exists.
        // Success with `data` null or undefined means the
        // backend responded but has no article for this topic —
        // which is a legitimate state that must be cached so
        // subsequent calls skip the fetch. Both cases write a
        // defined value.
        set((state) => ({
          articlesByTopic: {
            ...state.articlesByTopic,
            [topicId]: result.data ?? null,
          },
        }));
      } else {
        // The backend refused the request (a 404 for an unknown
        // topic, a 401 for an expired session, a 500 for a
        // server-side failure). We do NOT write a slot — the
        // caller's mount effect will retry on next mount, and a
        // cached null would falsely imply "we checked and there
        // is no article".
        //
        // The error is logged for the developer; the UI does
        // not surface it, because a missing article is the
        // normal state for a topic that has not been generated
        // yet.
        console.error(
          '[writerStore] loadLatest failed:',
          result.error ?? 'Unknown error'
        );
      }
    } catch (err) {
      // An IPC rejection — the channel is unregistered, or the
      // renderer's context has been torn down. Same policy as
      // the `!result.success` branch: no slot is written.
      console.error('[writerStore] loadLatest IPC failed:', err);
    }
  },


  // ---- setArticle ----
  setArticle: (topicId: string, article: Article | null): void => {
    set((state) => ({
      articlesByTopic: {
        ...state.articlesByTopic,
        [topicId]: article,
      },
    }));
  },

  // ---- Clear helpers ----
  clearError: (topicId: string): void => {
    set((state) => ({
      errorByTopic: {
        ...state.errorByTopic,
        [topicId]: null,
      },
    }));
    if (get().statusByTopic[topicId] === 'error') {
      set((state) => ({
        statusByTopic: {
          ...state.statusByTopic,
          [topicId]: 'idle',
        },
      }));
    }
  },

  reset: (): void => {
    set({ ...INITIAL_STATE });
  },

  
  // ---- Per-topic getters ----
  // Each getter reads the current value for a topic from the
  // corresponding per-topic record. The `?? default` fallback
  // covers the case of a topic that has not yet had any
  // operation — a status of 'idle', no article, no error.
  //
  // The getters exist so that a caller which needs a specific
  // topic's value can read it without having to know the exact
  // record field name. They are convenience wrappers over the
  // records, not a second source of truth.

  getArticle: (topicId: string): Article | null => {
    return get().articlesByTopic[topicId] ?? null;
  },

  getProgress: (topicId: string): WriterProgress | null => {
    return get().progressByTopic[topicId] ?? null;
  },

  getIsGenerating: (topicId: string): boolean => {
    return get().isGeneratingByTopic[topicId] ?? false;
  },

  getStatus: (topicId: string): WriterStoreStatus => {
    return get().statusByTopic[topicId] ?? 'idle';
  },

  getError: (topicId: string): string | null => {
    return get().errorByTopic[topicId] ?? null;
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