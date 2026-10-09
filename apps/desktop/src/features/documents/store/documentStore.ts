/**
 * documentStore — the renderer's state for the documents feature.
 *
 * Holds the state that drives the Documents tab on the topic-detail
 * page:
 *
 *   documents         — the list of `.md` doc files attached to
 *                       the active topic, as synthesized by the
 *                       main process's `documentService`.
 *   activeTopicId     — which topic the list belongs to, so a
 *                       second topic's documents do not
 *                       accidentally replace the first's.
 *   selectedDocument  — the document the user has clicked for
 *                       preview, or null when no preview modal
 *                       is open.
 *   status            — the store's async lifecycle state.
 *   error             — the last error message, or null.
 *
 * And the actions the components call to drive those operations:
 *
 *   loadDocuments     — fetch the list of doc files for a topic.
 *   deleteDocument    — remove a doc file from disk and from the
 *                       local list.
 *   selectDocument    — set or clear the preview target.
 *   clearDocuments    — empty the list (a "topic closed" action).
 *   clearError        — dismiss the last error.
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
 * ── Why `activeTopicId` is tracked ─────────────────────────────
 *
 *   The store is single-topic-scoped by design — the Documents
 *   tab shows one topic's docs at a time. Tracking which topic
 *   the list belongs to lets `loadDocuments` skip a re-fetch when
 *   the same topic is already loaded, and it lets a future
 *   "navigate to topic B without reloading A's docs" flow
 *   distinguish the two cases. Today the only caller is the
 *   Documents tab on mount, which always passes the same topic
 *   the tab was opened for; the field is present for the cases
 *   where that invariant might not hold.
 *
 *   The `activeTopicId` is set at the start of `loadDocuments`
 *   and is NOT cleared by `clearDocuments` — a caller that
 *   explicitly clears the list without changing topics is
 *   signalling "the list is empty for the current topic", not
 *   "no topic is active". `reset` is what clears the id.
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

  /** The documents for the active topic, in the order the main
   *  process returned them (which preserves the extraction
   *  pipeline's batch order). */
  documents: Document[];

  /** The topic the list belongs to, or null when no topic has
   *  been loaded. Set at the start of `loadDocuments`. */
  activeTopicId: string | null;

  /** The document the user has clicked for preview, or null when
   *  no preview is open. */
  selectedDocument: Document | null;

  /** The store's async lifecycle state. */
  status: DocumentStoreStatus;

  /** The last error message, or null. */
  error: string | null;

  // ---- Async actions ----

  /**
   * Load the list of doc files for a topic. Invokes the main
   * process's `documents:list` IPC channel via the preload,
   * updates `documents` and `activeTopicId` on success, and sets
   * `status` / `error` on both success and failure.
   *
   * An empty list is a legitimate result — a topic whose
   * extraction has not run yet has no doc files. The store
   * distinguishes that case from a failure by the `status` field:
   * `'idle'` with `documents.length === 0` is "loaded and empty",
   * `'error'` is "loading failed".
   */
  loadDocuments: (topicId: string) => Promise<void>;

  /**
   * Delete a single doc file. Invokes the main process's
   * `documents:delete` IPC channel via the preload; on success,
   * removes the document from `documents` and clears
   * `selectedDocument` if it was the deleted one.
   *
   * Resolves with `true` on success, `false` on failure. The
   * boolean lets the caller decide whether to fire a success
   * toast.
   *
   * @param documentId - The document's `_id` field, which the
   *                     main process's service sets to the file's
   *                     absolute path. See `documentService.ts`'s
   *                     header for the rationale on `_id`
   *                     carrying a path.
   */
  deleteDocument: (documentId: string) => Promise<boolean>;

  // ---- Sync actions ----

  /**
   * Set the document the user is currently previewing, or null
   * to close the preview. Does not read the file — the
   * `Document` object already carries the file's `content`
   * field, which the main process populated from disk when the
   * list was fetched.
   */
  selectDocument: (document: Document | null) => void;

  /**
   * Empty the document list and clear the selected document. The
   * `activeTopicId` is left as-is — see the file header for why.
   */
  clearDocuments: () => void;

  /** Clear the last error message and, if the status was
   *  `'error'`, return it to `'idle'`. */
  clearError: () => void;

  /** Reset every field to its initial value. */
  reset: () => void;
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
  documents: [] as Document[],
  activeTopicId: null as string | null,
  selectedDocument: null as Document | null,
  status: 'idle' as DocumentStoreStatus,
  error: null as string | null,
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
    // Flip the status to loading and clear any previous error.
    // The `activeTopicId` is set immediately, before the IPC
    // round trip — so a caller that inspects the store while
    // the fetch is in flight sees the correct topic ID rather
    // than the previous topic's.
    set({
      activeTopicId: topicId,
      status: 'loading',
      error: null,
    });

    try {
      const result = await window.electronAPI.documents.list(topicId);

      if (result.success && result.data) {
        // Replace the entire list. Unlike `topicStore.loadTopics`,
        // there is no "prepend" case — the documents list is
        // always the complete set for the topic, not an
        // append-only collection.
        set({
          documents: result.data,
          status: 'idle',
        });
      } else {
        set({
          status: 'error',
          error: result.error ?? 'Failed to load documents.',
        });
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
      set({
        status: 'error',
        error:
          err instanceof Error
            ? err.message
            : 'Unable to load documents.',
      });
    }
  },

  deleteDocument: async (documentId: string): Promise<boolean> => {
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
        set((state) => ({
          documents: state.documents.filter(
            (doc) => doc._id !== documentId
          ),
          // Clear the selected document if it was the one
          // being deleted — otherwise the preview modal would
          // keep showing a document that no longer exists on
          // disk.
          selectedDocument:
            state.selectedDocument !== null &&
            state.selectedDocument._id === documentId
              ? null
              : state.selectedDocument,
        }));
        return true;
      }

      set({ error: result.error ?? 'Failed to delete document.' });
      return false;
    } catch (err) {
      console.error('[documentStore] deleteDocument failed:', err);
      set({
        error:
          err instanceof Error
            ? err.message
            : 'Unable to delete document.',
      });
      return false;
    }
  },

  // ============================================================
  //  Sync actions
  // ============================================================

  selectDocument: (document: Document | null): void => {
    set({ selectedDocument: document });
  },

  clearDocuments: (): void => {
    set({
      documents: [],
      selectedDocument: null,
    });
  },

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