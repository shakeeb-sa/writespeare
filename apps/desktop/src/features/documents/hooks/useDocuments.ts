/**
 * useDocuments — the renderer's documents hook.
 *
 * The single entry point through which the app's components read
 * and manipulate the documents feature's state for ONE topic. It
 * sits over `useDocumentStore` and mirrors the role
 * `useWriter(topicId)` and `useResearch(topicId)` play for their
 * respective features:
 *
 *   - The store owns the state. The hook does not add any.
 *
 *   - The store owns the async actions that reach the IPC layer
 *     and, through it, the main process. The hook does not
 *     reimplement them.
 *
 *   - The hook's only job is to give a component a single, stable
 *     object with everything the documents feature exposes for
 *     one topic — the per-topic data fields and the actions.
 *
 * ── The hook's signature ────────────────────────────────────────
 *
 *   `useDocuments(topicId)` — the topic ID argument is required.
 *   The hook reads the topic's per-topic slots from the store via
 *   selectors keyed on that ID, so two components rendering
 *   different topics see independent state, and the same
 *   component re-renders only when its own topic's state changes.
 *
 *   This mirrors `useWriter(topicId)` and `useResearch(topicId)`'s
 *   shape. Every feature hook that drives a per-topic pipeline
 *   stage takes the topic ID as its first argument, so the pattern
 *   is uniform across the writer, research, documents, and
 *   validation features.
 *
 * ── The hook's API ──────────────────────────────────────────────
 *
 *   Data fields (all read from the topic passed to the hook):
 *
 *     documents         The topic's list of doc files, as
 *                       synthesized by the main process. Empty
 *                       until the first `loadDocuments` call for
 *                       this topic completes.
 *     selectedDocument  The document the user has clicked for
 *                       preview, or null when no preview is open
 *                       for this topic.
 *     status            The topic's async lifecycle state.
 *     error             The topic's last error message, or null.
 *
 *   Actions:
 *
 *     loadDocuments(topicId)          Fetch the list of doc files
 *                                     for a topic.
 *     deleteDocument(topicId, docId)  Remove a doc file from disk
 *                                     and from the topic's list.
 *     selectDocument(topicId, doc)    Set or clear the topic's
 *                                     preview target.
 *     clearDocuments(topicId)         Empty the topic's list.
 *     clearError(topicId)             Clear the topic's last
 *                                     error.
 *     reset()                         Reset the store.
 *
 * ── Why the hook is a straight re-export of the store's surface ──
 *
 *   The same reasoning as before the PR-1 refactor, with one
 *   adjustment: the store's actions now take a `topicId` argument
 *   because they write to per-topic slots, and the hook forwards
 *   that argument unchanged. The store's `loadDocuments` and
 *   `deleteDocument` actions still do their own IPC calls and
 *   their own state updates; the store's `selectDocument`,
 *   `clearDocuments`, `clearError`, and `reset` actions are still
 *   pure setters. Every action the hook exposes is still a direct
 *   reference to the store's own action.
 *
 *   The consequence is still that this file is a straight
 *   pass-through. Its value is still in two places: giving
 *   components a stable import path, and declaring the
 *   `DocumentHookValue` interface so a helper function can be
 *   typed against the hook's shape without redeclaring it.
 *
 * ── Why the hook no longer exposes `activeTopicId` ──────────────
 *
 *   The store's `activeTopicId` field is a tracking field only —
 *   it records which topic most recently began loading its
 *   documents, for diagnostic surfaces. No action or marker
 *   handler reads it to scope behavior; the marker handler routes
 *   markers to per-topic slots using each marker's own `topicId`
 *   payload field.
 *
 *   Because the tracking field has no behavioral role, the hook
 *   does not expose it. A consumer that needs to know which topic
 *   is "active" already has that information in the topic prop it
 *   passed to the hook. This matches `useResearch`'s and
 *   `useWriter`'s treatment of the same field.
 *
 * ── Why the hook subscribes to each data field separately ───────
 *
 *   Same reasoning as `useTopics` and `useResearch`. Zustand
 *   re-renders a component when any of the selectors it
 *   subscribed to returns a different value, and subscribing
 *   per-field gives the finest-grained re-render behavior.
 *
 *   Every selector additionally keys on the hook's `topicId`
 *   argument — a selector that reads
 *   `s.documentsByTopic[topicId]` changes identity only when that
 *   specific topic's data changes, not when another topic's does.
 *   That per-topic keying is what makes the hook safe to mount
 *   twice for two different topics on the same page.
 *
 * ── Why the actions are selected directly from the store ────────
 *
 *   Zustand's `create` runs its state creator exactly once per
 *   store instance, and the functions returned by that creator
 *   are the same references for the entire life of the store.
 *   That means the action references obtained from
 *   `useDocumentStore((s) => s.loadDocuments)` are already stable
 *   across renders — a `useCallback` wrapper around them would be
 *   redundant. Same reasoning as every other hook in the
 *   codebase.
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
 *   - It does not expose the store's `reset` action as a
 *     per-topic operation. `reset` is a store-wide operation used
 *     by the root store's logout flow, not by any per-topic
 *     caller.
 *
 *   - It does not distinguish `clearDocuments` from `reset` for
 *     the consumer. Both are present in the returned object; a
 *     component that needs to empty one topic's list calls
 *     `clearDocuments(topicId)`, and a component that needs a
 *     full store reset calls `reset()`. The distinction is
 *     documented in the store, not here.
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
 * The shape of the object returned by `useDocuments(topicId)`.
 *
 * Exported so that a helper function that takes "an instance of
 * the documents hook" as a parameter can be typed against the
 * interface without redeclaring the shape. A component that
 * destructures the return value does not need to reference the
 * interface at all.
 *
 * Every data field is read from the topic the hook was called
 * with. Every per-topic action takes the topic ID as its first
 * argument so a caller that holds a topic reference in a callback
 * does not have to close over the hook's own `topicId` — the two
 * are the same value in practice, but passing it explicitly keeps
 * the call site readable and matches the shape `useWriter(topicId)`
 * and `useResearch(topicId)` establish.
 */
export interface DocumentHookValue {
  // ---- Data ----

  /** The topic's list of doc files, in the order the main process
   *  returned them. Empty until the first `loadDocuments` call
   *  for this topic completes. */
  documents: Document[];

  /** The document the user has clicked for preview, or null when
   *  no preview is open for this topic. */
  selectedDocument: Document | null;

  /** The topic's async lifecycle state. See
   *  `DocumentStoreStatus` in `documentStore.ts` for the meaning
   *  of each value. */
  status: DocumentStoreStatus;

  /** The topic's last error message from an async action, or
   *  null. */
  error: string | null;

  // ---- Actions ----

  /** Fetch the list of doc files for a topic. Resolves when the
   *  load completes (success or failure). The topic's `status`
   *  and `error` slots reflect the outcome. */
  loadDocuments: (topicId: string) => Promise<void>;

  /** Remove a doc file from disk and from the topic's local list.
   *  Resolves with `true` on success, `false` on failure. */
  deleteDocument: (
    topicId: string,
    documentId: string
  ) => Promise<boolean>;

  /** Set the topic's currently-previewing document, or null to
   *  close the preview. */
  selectDocument: (
    topicId: string,
    document: Document | null
  ) => void;

  /** Empty the topic's document list and clear its selected
   *  document. The store's tracking fields are left as-is. */
  clearDocuments: (topicId: string) => void;

  /** Clear the topic's last error message. */
  clearError: (topicId: string) => void;

  /** Reset the store to its initial state. This is a store-wide
   *  operation, not a per-topic one; the root store's logout flow
   *  is the caller that uses it. */
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
export const useDocuments = (topicId: string): DocumentHookValue => {
  // ---- Data subscriptions ----
  // One selector per data field, each keyed on the hook's
  // `topicId` argument. See the file header for why the fields
  // are read individually and why the keying matters.
  //
  // The raw selectors can each return `undefined` when the topic
  // has no entry in the corresponding record. The derived
  // bindings below apply the fallback values so the interface's
  // non-optional fields always carry a value.
  //
  // The `?? []` / `?? null` / `?? 'idle'` fallbacks produce
  // stable values only when the underlying slot is absent —
  // the empty array literal allocates a new array on every
  // render, which is fine here because the array is only used
  // for the length check and the row iteration in the sibling
  // `DocumentList` component, and because a caller that wants
  // a referentially-stable empty list is better served by
  // checking `documents.length === 0` at the call site.
  const documentsRaw = useDocumentStore(
    (s) => s.documentsByTopic[topicId]
  );
  const selectedDocumentRaw = useDocumentStore(
    (s) => s.selectedDocumentByTopic[topicId]
  );
  const statusRaw = useDocumentStore(
    (s) => s.statusByTopic[topicId]
  );
  const errorRaw = useDocumentStore(
    (s) => s.errorByTopic[topicId]
  );

  // ---- Derived fields ----
  const documents: Document[] = documentsRaw ?? [];
  const selectedDocument: Document | null = selectedDocumentRaw ?? null;
  const status: DocumentStoreStatus = statusRaw ?? 'idle';
  const error: string | null = errorRaw ?? null;

  // ---- Action subscriptions ----
  // Zustand actions are stable references for the life of the
  // store, so selecting them here does not cause re-renders and
  // does not require `useCallback` around them. See the file
  // header for the reasoning.
  //
  // Every action except `reset` takes a `topicId` argument; the
  // hook forwards the arguments its callers provide. The hook
  // does not inject its own `topicId` into the calls — the
  // caller passes it explicitly, matching the shape
  // `useWriter(topicId)` and `useResearch(topicId)` establish.
  const loadDocuments = useDocumentStore((s) => s.loadDocuments);
  const deleteDocument = useDocumentStore((s) => s.deleteDocument);
  const selectDocument = useDocumentStore((s) => s.selectDocument);
  const clearDocuments = useDocumentStore((s) => s.clearDocuments);
  const clearError = useDocumentStore((s) => s.clearError);
  const reset = useDocumentStore((s) => s.reset);

  // ---- Return ----
  // A single object literal with all ten members. The order
  // matches the interface above, so a reader comparing the two
  // does not have to hunt for a member's position.
  return {
    documents,
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