/**
 * useDocuments — the renderer's documents hook.
 *
 * The single entry point through which the app's components read
 * and manipulate the documents feature's state. It sits over
 * `useDocumentStore` and mirrors the role `useTopics` plays for
 * the topics feature and `useResearch` plays for the research
 * feature:
 *
 *   - The store owns the state. The hook does not add any.
 *
 *   - The store owns the async actions that reach the IPC layer
 *     and, through it, the main process. The hook does not
 *     reimplement them.
 *
 *   - The hook's only job is to give a component a single, stable
 *     object with everything the documents feature exposes — the
 *     data fields and the actions.
 *
 * ── The hook's API ──────────────────────────────────────────────
 *
 *   Data fields:
 *
 *     documents         The active topic's list of doc files, as
 *                       synthesized by the main process.
 *     activeTopicId     Which topic the list belongs to, or null.
 *     selectedDocument  The document the user has clicked for
 *                       preview, or null when no preview is open.
 *     status            The store's async lifecycle state.
 *     error             The last error message, or null.
 *
 *   Actions:
 *
 *     loadDocuments(topicId)     Fetch the list of doc files for a
 *                                topic. Awaits the IPC round trip;
 *                                store state reflects the outcome.
 *     deleteDocument(documentId) Remove a doc file from disk and
 *                                from the local list. Resolves with
 *                                `true` on success.
 *     selectDocument(doc | null) Set or clear the preview target.
 *     clearDocuments()           Empty the list.
 *     clearError()               Clear the last error message.
 *     reset()                    Reset the store.
 *
 * ── Why the hook is a straight re-export of the store's surface ──
 *
 *   Unlike `useAuth.ts` — whose `login` and `logout` actions are
 *   composed inside the hook because they need to coordinate
 *   between the store and the IPC layer — this hook has no
 *   composition to perform. The store's `loadDocuments` and
 *   `deleteDocument` actions already do their own IPC calls and
 *   their own state updates; the store's `selectDocument`,
 *   `clearDocuments`, `clearError`, and `reset` actions are pure
 *   setters. Every action the hook exposes is a direct reference
 *   to the store's own action.
 *
 *   The consequence is that this file is a straight pass-through.
 *   Its value is in two places: giving components a stable import
 *   path (`useDocuments` rather than
 *   `useDocumentStore((s) => ...)` at every call site), and
 *   declaring the `DocumentHookValue` interface so a helper
 *   function can be typed against the hook's shape without
 *   redeclaring it.
 *
 * ── Why the hook subscribes to each data field separately ───────
 *
 *   Same reasoning as `useTopics`: Zustand re-renders a component
 *   when any of the selectors it subscribed to returns a
 *   different value. Subscribing to each field individually gives
 *   the finest-grained re-render behavior — a change to
 *   `selectedDocument` does not re-render a component whose only
 *   visible effect was `documents`, because `documents` did not
 *   change.
 *
 *   The per-field form is the recommended Zustand pattern and the
 *   one every hook in this codebase follows.
 *
 * ── Why the actions are selected directly from the store ────────
 *
 *   Zustand's `create` runs its state creator exactly once per
 *   store instance, and the functions returned by that creator
 *   are the same references for the entire life of the store.
 *   That means the action references obtained from
 *   `useDocumentStore((s) => s.loadDocuments)` are already stable
 *   across renders — a `useCallback` wrapper around them would be
 *   redundant. See `useTopics.ts`'s file header for the longer
 *   version of this note.
 *
 * ── What this hook does NOT do ──────────────────────────────────
 *
 *   - It does not call `loadDocuments` on mount. The hook is a
 *     passive reader; the component that mounts it decides when
 *     to fetch. The `DocumentList` component calls
 *     `loadDocuments(topic._id)` in its own `useEffect`, on the
 *     topic it is rendering for.
 *
 *   - It does not guard against the "no session" case. The
 *     documents feature is authenticated-only; its components
 *     render inside the layout's auth gate, which does not mount
 *     its children until a session exists.
 *
 *   - It does not expose `clearDocuments` and `reset` as separate
 *     concepts to the consumer. Both are present in the returned
 *     object; a component that needs to empty the list calls
 *     `clearDocuments`, and a component that needs a full store
 *     reset (the root store's logout flow) calls `reset`. The
 *     distinction is documented in the store, not here.
 */

import {
  useDocumentStore,
  type DocumentStoreStatus,
} from '../store/documentStore.js';
import type { Document } from '../../shared/types/index.js';

// ============================================================
//  Public types
// ============================================================

/**
 * The shape of the object returned by `useDocuments()`.
 *
 * Exported so that a helper function that takes "an instance of
 * the documents hook" as a parameter can be typed against the
 * interface without redeclaring the shape. A component that
 * destructures the return value does not need to reference the
 * interface at all.
 */
export interface DocumentHookValue {
  // ---- Data ----

  /** The active topic's list of doc files, in the order the main
   *  process returned them. Empty until the first
   *  `loadDocuments` call for a topic completes. */
  documents: Document[];

  /** The topic the list belongs to, or null before the first
   *  load. */
  activeTopicId: string | null;

  /** The document the user has clicked for preview, or null when
   *  no preview is open. */
  selectedDocument: Document | null;

  /** The store's async lifecycle state. See
   *  `DocumentStoreStatus` in `documentStore.ts` for the meaning
   *  of each value. */
  status: DocumentStoreStatus;

  /** The last error message from an async action, or null. */
  error: string | null;

  // ---- Actions ----

  /** Fetch the list of doc files for a topic. Resolves when the
   *  load completes (success or failure). The store's `status`
   *  and `error` fields reflect the outcome. */
  loadDocuments: (topicId: string) => Promise<void>;

  /** Remove a doc file from disk and from the local list.
   *  Resolves with `true` on success, `false` on failure. */
  deleteDocument: (documentId: string) => Promise<boolean>;

  /** Set the document the user is previewing, or null to close
   *  the preview. */
  selectDocument: (document: Document | null) => void;

  /** Empty the document list and clear the selected document.
   *  The `activeTopicId` is left as-is. */
  clearDocuments: () => void;

  /** Clear the last error message. */
  clearError: () => void;

  /** Reset the store to its initial state. */
  reset: () => void;
}

// ============================================================
//  The hook
// ============================================================

/**
 * Return the documents feature's state and its actions. See the
 * file header for the hook's role, its relationship to the store,
 * and the reasoning behind the design choices.
 */
export const useDocuments = (): DocumentHookValue => {
  // ---- Data subscriptions ----
  // One selector per data field. See the file header for why
  // the fields are read individually rather than as one object.
  const documents = useDocumentStore((s) => s.documents);
  const activeTopicId = useDocumentStore((s) => s.activeTopicId);
  const selectedDocument = useDocumentStore((s) => s.selectedDocument);
  const status = useDocumentStore((s) => s.status);
  const error = useDocumentStore((s) => s.error);

  // ---- Action subscriptions ----
  // Zustand actions are stable references for the life of the
  // store, so selecting them here does not cause re-renders and
  // does not require `useCallback` around them. See the file
  // header for the reasoning.
  const loadDocuments = useDocumentStore((s) => s.loadDocuments);
  const deleteDocument = useDocumentStore((s) => s.deleteDocument);
  const selectDocument = useDocumentStore((s) => s.selectDocument);
  const clearDocuments = useDocumentStore((s) => s.clearDocuments);
  const clearError = useDocumentStore((s) => s.clearError);
  const reset = useDocumentStore((s) => s.reset);

  // ---- Return ----
  // A single object literal with all eleven members. The order
  // matches the interface above, so a reader comparing the two
  // does not have to hunt for a member's position.
  return {
    documents,
    activeTopicId,
    selectedDocument,
    status,
    error,
    loadDocuments,
    deleteDocument,
    selectDocument,
    clearDocuments,
    clearError,
    reset,
  };
};

// ============================================================
//  Default export
// ============================================================

/**
 * The hook as the default export, matching the convention used by
 * every other hook and store in the codebase. Consumers that
 * prefer the named form use `import { useDocuments } from ...`;
 * consumers that prefer the default form use
 * `import useDocuments from ...`. Both resolve to the same hook.
 */
export default useDocuments;