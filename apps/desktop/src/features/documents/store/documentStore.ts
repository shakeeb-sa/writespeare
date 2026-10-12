/**
 * documentStore — the renderer's state for the documents feature.
 *
 * Holds the state that drives the Documents tab on the topic-detail
 * page. Every piece of per-topic state is a record keyed by the
 * topic's ID, so switching between topics never clobbers the
 * previous topic's data:
 *
 *   documentsByTopic       — per-topic list of `.md` doc files
 *                            attached to that topic, as
 *                            synthesized by the main process's
 *                            `documentService`.
 *   activeTopicId          — the topic that most recently loaded
 *                            its documents. A tracking field only.
 *   selectedDocumentByTopic — per-topic preview target, or null
 *                            when the topic has no preview open.
 *   statusByTopic          — per-topic async lifecycle state.
 *   errorByTopic           — per-topic last error message, or null.
 *
 * And the actions the components call to drive those operations:
 *
 *   loadDocuments     — fetch the list of doc files for a topic.
 *   deleteDocument    — remove a doc file from disk and from the
 *                       topic's local list.
 *   selectDocument    — set or clear one topic's preview target.
 *   clearDocuments    — empty one topic's list.
 *   clearError        — dismiss one topic's last error.
 *   reset             — return every field to its initial value.
 *
 * ── Why the store is NOT persisted ─────────────────────────────
 *
 *   The list of doc files is derived from the files on disk, which
 *   the extraction pipeline wrote and which the user can delete
 *   at any time via the file system directly. Caching the list
 *   across app restarts would let the renderer show a doc file
 *   that the user deleted while the app was closed, or miss a
 *   file that was added from a previous session's extraction. The
 *   store is therefore transient — it lives for the session and is
 *   repopulated from disk by `loadDocuments` whenever the
 *   Documents tab mounts.
 *
 *   The precedent for that choice is `researchStore.ts`'s: the
 *   candidate list is transient because a re-search produces a
 *   fresh list, and the same reasoning applies here with
 *   "re-load" substituted for "re-search".
 *
 * ── Why the store is a pure state container ────────────────────
 *
 *   The same pattern every other store in the codebase uses: the
 *   store holds values and exposes setters and async actions that
 *   reach the IPC layer; the hook (`useDocuments`) is what
 *   composes those actions with the side effects a component
 *   cares about (a toast on delete, a navigation on load
 *   failure). The store's `deleteDocument` action reaches the IPC
 *   layer because it is a single, co-located operation with a
 *   single state update that follows — the same reason
 *   `topicStore.ts`'s `deleteTopic` reaches the IPC layer.
 *
 * ── The per-topic design ───────────────────────────────────────
 *
 *   Every piece of per-topic state lives in a record keyed by the
 *   topic's ID — `documentsByTopic`, `selectedDocumentByTopic`,
 *   `statusByTopic`, and `errorByTopic`. Switching between topics
 *   does not clobber any previous topic's state; the store simply
 *   holds a slot for every topic that has been loaded this
 *   session.
 *
 *   `activeTopicId` is retained as a tracking field — the topic
 *   that most recently began loading its documents. It is not
 *   read by any action or marker handler; it exists for
 *   diagnostic surfaces and for a future caller that wants to
 *   know which topic the user is currently looking at without
 *   threading that value through component props.
 *
 *   The `activeTopicId` is set at the start of `loadDocuments`.
 *   `clearDocuments` and `reset` do not touch it — the id is a
 *   session-level fact about navigation, not per-topic state.
 *
 * ── What this store does NOT do ────────────────────────────────
 *
 *   - It does not persist. See the file header's note above.
 *
 *   - It does not subscribe to the marker channel. The documents
 *     feature is a pure request-response layer — no streaming
 *     events flow through it, and no module-level listener is
 *     installed. The `research:marker` channel that
 *     `researchStore.ts` subscribes to is not relevant here.
 *
 *   - It does not touch the backend. The main process's
 *     `documentService` reads from disk; the store reads from
 *     the main process. No HTTP client is involved, no bearer
 *     token is attached, and no network errors are possible.
 *
 *   - It does not parse or render the doc file's content. The
 *     store holds the `Document` objects the main process
 *     synthesized; the `DocumentPreview` component is what
 *     interprets the Markdown for display.
 *
 *   - It does not track a selection set. The Documents list is
 *     a display-only list, not a checkbox-selection interface —
 *     the user reviews the docs and moves on to the writer step.
 *     If a future session adds a multi-select for batch delete,
 *     that state belongs here; today it is not needed.
 *
 *   - It does not filter or scope to a single active topic. Every
 *     action takes the topic's ID as an argument, and the store
 *     holds each topic's data independently.
 */

import { create } from 'zustand';

import type { Document } from '../../shared/types/index.js';

// ============================================================
//  Public types
// ============================================================

/**
 * The three-value lifecycle of the store's async activity. Same
 * shape as `TopicStoreStatus` and `ResearchStoreStatus`:
 *
 *   'idle'    — no operation is in progress, and the last one
 *               (if any) succeeded. The default state.
 *   'loading' — an async operation is in flight. Set by every
 *               async action at its start; the corresponding
 *               success or failure path sets it back to 'idle'
 *               or 'error'.
 *   'error'   — the last async operation failed. The `error`
 *               field carries a user-facing message. The next
 *               async action to start resets both fields.
 */
export type DocumentStoreStatus = 'idle' | 'loading' | 'error';

/**
 * The full shape of the documents store's state, including both
 * the data fields and the actions. Exported so that a consumer
 * that wants to type a parameter or a helper function can
 * reference the shape without redeclaring it.
 */
export interface DocumentStoreState {
  // ---- Data ----

  /** The topic that most recently began loading its documents,
   *  or null before any load. A tracking field only; no action
   *  or handler reads it to scope behavior. */
  activeTopicId: string | null;

  /** Per-topic document lists, in the order the main process
   *  returned them (which preserves the extraction pipeline's
   *  batch order). Absence of a topic's key means "not yet
   *  loaded". */
  documentsByTopic: Record<string, Document[]>;

  /** Per-topic preview target — the document the user clicked
   *  for preview, or null when no preview is open for that
   *  topic. Absence of a key is treated as null. */
  selectedDocumentByTopic: Record<string, Document | null>;

  /** Per-topic async lifecycle state. Absence of a key is
   *  treated as `'idle'`. */
  statusByTopic: Record<string, DocumentStoreStatus>;

  /** Per-topic last error message, or null. */
  errorByTopic: Record<string, string | null>;

  // ---- Async actions ----

  /**
   * Load the list of doc files for a topic. Invokes the main
   * process's `documents:list` IPC channel via the preload and
   * writes this topic's slots on success.
   *
   * An empty list is a legitimate result — a topic whose
   * extraction has not run yet has no doc files. The store
   * distinguishes that case from a failure by the status:
   * `'idle'` with an empty list is "loaded and empty",
   * `'error'` is "loading failed".
   */
  loadDocuments: (topicId: string) => Promise<void>;

  /**
   * Delete a single doc file for a topic. Invokes the main
   * process's `documents:delete` IPC channel via the preload;
   * on success, removes the document from the topic's list and
   * clears the topic's selected document if it was the one
   * being deleted.
   *
   * Resolves with `true` on success, `false` on failure. The
   * boolean lets the caller decide whether to fire a success
   * toast.
   *
   * @param topicId    - The owning topic's ID. Identifies which
   *                     per-topic slot to mutate.
   * @param documentId - The document's `_id` field, which the
   *                     main process's service sets to the file's
   *                     absolute path. See `documentService.ts`'s
   *                     header for the rationale on `_id`
   *                     carrying a path.
   */
  deleteDocument: (
    topicId: string,
    documentId: string
  ) => Promise<boolean>;

  // ---- Sync actions ----

  /**
   * Set one topic's currently-previewing document, or null to
   * close the preview for that topic. Does not read the file —
   * the `Document` object already carries the file's `content`
   * field, which the main process populated from disk when the
   * list was fetched.
   */
  selectDocument: (topicId: string, document: Document | null) => void;

  /**
   * Empty one topic's document list and clear its selected
   * document.
   */
  clearDocuments: (topicId: string) => void;

  /** Clear one topic's last error message and, if that topic's
   *  status was `'error'`, return it to `'idle'`. */
  clearError: (topicId: string) => void;

  /** Reset every field to its initial value. */
  reset: () => void;

  // ---- Per-topic getters ----

  /** Return the topic's document list, or an empty array when
   *  none is loaded. */
  getDocuments: (topicId: string) => Document[];

  /** Return the topic's currently-selected document, or null. */
  getSelectedDocument: (topicId: string) => Document | null;

  /** Return the topic's async lifecycle state. */
  getStatus: (topicId: string) => DocumentStoreStatus;

  /** Return the topic's last error message, or null. */
  getError: (topicId: string) => string | null;
}

// ============================================================
//  Initial state
// ============================================================

/**
 * The store's initial data fields. Extracted as a constant so
 * `reset` can spread it into a new state object without
 * duplicating the literals.
 */
const INITIAL_STATE = {
  activeTopicId: null as string | null,
  documentsByTopic: {} as Record<string, Document[]>,
  selectedDocumentByTopic: {} as Record<string, Document | null>,
  statusByTopic: {} as Record<string, DocumentStoreStatus>,
  errorByTopic: {} as Record<string, string | null>,
};

// ============================================================
//  Store
// ============================================================

/**
 * The documents store. See the file header for its
 * responsibilities and the reasoning behind its design.
 *
 * Created without any middleware — the store is not persisted
 * (see the file header), does not use Immer, and does not use
 * `devtools`. The `create<...>()` form with the extra `()` after
 * the generic is required for Zustand's type inference to work
 * correctly when a store has both state and actions; it is the
 * same pattern every other store in the codebase uses.
 */
export const useDocumentStore = create<DocumentStoreState>((set, get) => ({
  // ---- Initial data ----
  ...INITIAL_STATE,

  // ============================================================
  //  Async actions
  // ============================================================

  loadDocuments: async (topicId: string): Promise<void> => {
    // Flip this topic's status to loading and clear its previous
    // error. The `activeTopicId` tracking field is set to the
    // topic being loaded.
    set((state) => ({
      activeTopicId: topicId,
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
      const result = await window.electronAPI.documents.list(topicId);

      if (result.success && result.data) {
        // Replace this topic's entire list. Unlike
        // `topicStore.loadTopics`, there is no "prepend" case —
        // the documents list is always the complete set for the
        // topic, not an append-only collection.
        set((state) => ({
          documentsByTopic: {
            ...state.documentsByTopic,
            [topicId]: result.data ?? [],
          },
          statusByTopic: {
            ...state.statusByTopic,
            [topicId]: 'idle',
          },
        }));
      } else {
        set((state) => ({
          statusByTopic: {
            ...state.statusByTopic,
            [topicId]: 'error',
          },
          errorByTopic: {
            ...state.errorByTopic,
            [topicId]: result.error ?? 'Failed to load documents.',
          },
        }));
      }
    } catch (err) {
      // The `window.electronAPI.documents.list` call itself can
      // reject if the IPC channel is unregistered — for example,
      // during the window between the app's startup and the
      // `registerDocumentsIPC()` call in the main process. The
      // catch converts that rejection into the same error state
      // the response-envelope failure path produces, so the
      // component's render logic does not need two cases.
      console.error('[documentStore] loadDocuments failed:', err);
      set((state) => ({
        statusByTopic: {
          ...state.statusByTopic,
          [topicId]: 'error',
        },
        errorByTopic: {
          ...state.errorByTopic,
          [topicId]:
            err instanceof Error
              ? err.message
              : 'Unable to load documents.',
        },
      }));
    }
  },

  deleteDocument: async (
    topicId: string,
    documentId: string
  ): Promise<boolean> => {
    // Unlike the load and search actions, `deleteDocument` does
    // not flip `status` to `loading`. A delete is usually
    // initiated from a row in the documents list, and the list
    // should stay visible during the operation — a full
    // page-level loading state would replace the list with a
    // spinner, which is more disruptive than the operation
    // warrants. The caller is responsible for showing a
    // row-level spinner or disabled state.
    try {
      const result = await window.electronAPI.documents.remove(documentId);

      if (result.success) {
        set((state) => {
          const topicDocs = state.documentsByTopic[topicId] ?? [];
          const topicSelected =
            state.selectedDocumentByTopic[topicId] ?? null;
          return {
            documentsByTopic: {
              ...state.documentsByTopic,
              [topicId]: topicDocs.filter(
                (doc) => doc._id !== documentId
              ),
            },
            // Clear this topic's selected document if it was the
            // one being deleted — otherwise the preview modal
            // would keep showing a document that no longer exists
            // on disk.
            selectedDocumentByTopic: {
              ...state.selectedDocumentByTopic,
              [topicId]:
                topicSelected !== null &&
                topicSelected._id === documentId
                  ? null
                  : topicSelected,
            },
          };
        });
        return true;
      }

      set((state) => ({
        errorByTopic: {
          ...state.errorByTopic,
          [topicId]: result.error ?? 'Failed to delete document.',
        },
      }));
      return false;
    } catch (err) {
      console.error('[documentStore] deleteDocument failed:', err);
      set((state) => ({
        errorByTopic: {
          ...state.errorByTopic,
          [topicId]:
            err instanceof Error
              ? err.message
              : 'Unable to delete document.',
        },
      }));
      return false;
    }
  },

  // ============================================================
  //  Sync actions
  // ============================================================

  selectDocument: (topicId: string, document: Document | null): void => {
    set((state) => ({
      selectedDocumentByTopic: {
        ...state.selectedDocumentByTopic,
        [topicId]: document,
      },
    }));
  },

  clearDocuments: (topicId: string): void => {
    set((state) => ({
      documentsByTopic: {
        ...state.documentsByTopic,
        [topicId]: [],
      },
      selectedDocumentByTopic: {
        ...state.selectedDocumentByTopic,
        [topicId]: null,
      },
    }));
  },

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
  // Each getter reads one topic's value from the corresponding
  // per-topic record, with a safe default for a topic that has
  // no entry yet. The getters are convenience wrappers over the
  // records, not a second source of truth.

  getDocuments: (topicId: string): Document[] => {
    return get().documentsByTopic[topicId] ?? [];
  },

  getSelectedDocument: (topicId: string): Document | null => {
    return get().selectedDocumentByTopic[topicId] ?? null;
  },

  getStatus: (topicId: string): DocumentStoreStatus => {
    return get().statusByTopic[topicId] ?? 'idle';
  },

  getError: (topicId: string): string | null => {
    return get().errorByTopic[topicId] ?? null;
  },
}));

// ============================================================
//  Default export
// ============================================================

/**
 * The hook as the default export, matching the convention used
 * by every other store in the codebase. Consumers that prefer
 * the named form use `import { useDocumentStore } from ...`;
 * consumers that prefer the default form use
 * `import useDocumentStore from ...`. Both resolve to the same
 * hook.
 */
export default useDocumentStore;