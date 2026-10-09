/**
 * useResearch — the renderer's research hook.
 *
 * The single entry point through which the app's components read
 * and manipulate the research feature's state. It sits over
 * `useResearchStore` (created in the previous step) and mirrors
 * the role `useTopics` plays for the topics feature and `useAuth`
 * plays for the auth feature:
 *
 *   - The store owns the state. The hook does not add any.
 *
 *   - The store owns the async actions that reach the IPC layer
 *     and, through it, the main process. The hook does not
 *     reimplement them.
 *
 *   - The hook's only job is to give a component a single, stable
 *     object with everything the research feature exposes — the
 *     data fields and the actions.
 *
 * ── The hook's API ──────────────────────────────────────────────
 *
 *   Data fields:
 *
 *     candidates        The current topic's search-candidate list.
 *     status            The store's lifecycle state — 'idle',
 *                       'searching', 'extracting', or 'error'.
 *     searchProgress    Live progress during a search, or null.
 *     extractProgress   Live progress during an extraction, or null.
 *     extractedCount    How many docs the last extraction saved.
 *     error             The last error message, or null.
 *
 *   Actions:
 *
 *     runSearch(topicId, title, keywords?)
 *                       Run a search. Wraps the store's
 *                       `startSearch` action; resolves with a
 *                       boolean (true on success). The plan's
 *                       Part 1.9 names this action `runSearch`.
 *
 *     fetchSelected(topicId, urls)
 *                       Extract the selected URLs. Wraps the
 *                       store's `runExtraction` action; resolves
 *                       with the number of docs saved. The plan's
 *                       Part 1.9 names this action `fetchSelected`.
 *
 *     cancel(topicId)   Cancel whatever research operation is
 *                       running for the topic.
 *
 *     clearCandidates() Empty the candidate list.
 *
 *     clearError()      Clear the last error message.
 *
 * ── Why the hook renames the store's actions ────────────────────
 *
 *   The plan's Part 1.9 annotation for this file reads: "Two
 *   actions: runSearch(), fetchSelected(urls)." The store's own
 *   actions are named `startSearch` and `runExtraction` — the
 *   names it uses internally and in its own documentation.
 *
 *   The hook exposes the plan-mandated names (`runSearch`,
 *   `fetchSelected`) so that a future reader who has the plan in
 *   hand and opens this file sees the names they expect. The hook
 *   does the mapping in one place — a one-line
 *   `useCallback`-wrapped wrapper around the store action — so
 *   the two names never diverge in component code.
 *
 *   The alternative (renaming the store's actions to match the
 *   plan) was rejected: the store's names describe what the
 *   actions do at the state layer ("start a search" writes the
 *   store's search state; "run an extraction" writes the extract
 *   state), while the hook's names describe what they do at the
 *   user's layer ("run a search", "fetch the selected URLs").
 *   Both readings are correct, and keeping them separate lets each
 *   name be idiomatic at its own layer.
 *
 * ── Why the actions are `useCallback`-wrapped ───────────────────
 *
 *   Zustand stores return stable action references for the life of
 *   the store, so selecting `startSearch` from the store and
 *   returning it directly would already be stable. But `runSearch`
 *   and `fetchSelected` are NOT direct references — they are thin
 *   adapter functions that exist to apply the plan-mandated names
 *   and to normalise the argument order (see `fetchSelected`
 *   below). A freshly-defined function inside a hook body has a
 *   new identity on every render; without `useCallback` a
 *   component that put `fetchSelected` in a `useEffect` dependency
 *   array would re-run the effect on every render.
 *
 *   `useCallback` with the store's action as its sole dependency
 *   gives the wrapper a stable identity for as long as the store
 *   is alive — which is the app's whole lifetime. The wrapper and
 *   the store action are effectively the same function at runtime;
 *   the wrapper is just what a caller passes as a value and the
 *   store action is what actually runs.
 *
 * ── Why `fetchSelected` takes `(topicId, urls)` and not just `urls` ─
 *
 *   The plan's Part 1.9 annotation is `fetchSelected(urls)`. That
 *   signature is missing the topic ID, which the store needs:
 *   `runExtraction(topicId, urls)` writes `activeTopicId` and
 *   passes the topic to the IPC handler, which the main process
 *   uses to name the output folder on disk. Dropping the topic ID
 *   from the hook's signature would force the hook to read it
 *   from the store's `activeTopicId` — the value written by the
 *   last `runSearch` call.
 *
 *   Reading the topic ID from the store would work in the common
 *   case (the user searches topic A, then extracts topic A's
 *   selected URLs), but it would be wrong under the less common
 *   case where the user navigates between topics without
 *   searching — the store's `activeTopicId` would still name the
 *   first topic, and the extraction would write to the wrong
 *   folder.
 *
 *   The hook's signature therefore takes the topic ID explicitly.
 *   The component that calls it has the topic in hand (it was
 *   rendered from the topic's detail page), so passing it through
 *   is not friction — it is the correct amount of information for
 *   the operation to be unambiguous.
 *
 * ── Why the hook subscribes to each field separately ────────────
 *
 *   Same reasoning as `useTopics`: Zustand re-renders a component
 *   when any of the selectors it subscribed to return a
 *   different value. Subscribing to each field individually gives
 *   the finest-grained re-render behaviour — a change to
 *   `searchProgress` does not re-render a component whose only
 *   visible effect was `candidates`, because `candidates`
 *   didn't change.
 *
 *   The alternative — a single `useResearchStore((s) => s)` call
 *   — would re-render on every store change and would need a
 *   shallow-equality comparator to avoid wasted renders. The
 *   per-field form is the recommended Zustand pattern.
 *
 * ── What this hook does NOT do ──────────────────────────────────
 *
 *   - It does not call `runSearch` on mount. The hook is a
 *     passive reader; the component that mounts it decides when
 *     to fire a search. The Sources tab's "Start Search" button
 *     calls `runSearch` from a click handler, not from a mount
 *     effect.
 *
 *   - It does not guard against the "no session" case. The
 *     research feature is authenticated-only; its components
 *     render inside the layout's auth gate, which does not mount
 *     its children until a session exists. The hook trusts that
 *     invariant.
 *
 *   - It does not persist anything. The store is transient by
 *     design — see `researchStore.ts`'s file header.
 *
 *   - It does not expose `activeTopicId` or the internal
 *     `_handleMarker` dispatcher. The former is a store-internal
 *     bookkeeping field the components do not need; the latter is
 *     called by the module-load listener, never by a component.
 */

import { useCallback } from 'react';

import {
  useResearchStore,
  type SearchCandidate,
  type ResearchStoreStatus,
  type SearchProgress,
  type ExtractProgress,
} from '../store/researchStore.js';

// ============================================================
//  Public types
// ============================================================

/**
 * The shape of the object returned by `useResearch()`.
 *
 * Exported so that a helper function that takes "an instance of
 * the research hook" as a parameter can be typed against the
 * interface without redeclaring the shape. A component that
 * destructures the return value does not need to reference the
 * interface at all.
 */
export interface ResearchHookValue {
  // ---- Data ----

  /** The current topic's search-candidate list. Empty until the
   *  first search completes. */
  candidates: SearchCandidate[];

  /** The store's lifecycle state. See `ResearchStoreStatus` in
   *  `researchStore.ts` for the meaning of each value. */
  status: ResearchStoreStatus;

  /** Live progress during a search, or null when no search is in
   *  flight. Updated by the `SEARCH_PROGRESS` markers the main
   *  process emits. */
  searchProgress: SearchProgress | null;

  /** Live progress during an extraction, or null when no
   *  extraction is in flight. Updated by the `EXTRACT_PROGRESS`
   *  markers. */
  extractProgress: ExtractProgress | null;

  /** How many doc files the last extraction saved. Zero before
   *  the first extraction and after `clearCandidates`/`reset`. */
  extractedCount: number;

  /** The last error message from a search or extraction, or null. */
  error: string | null;

  // ---- Actions ----

  /** Run a search for a topic. Resolves with `true` on success
   *  (candidates populated), `false` on failure (`error` set). */
  runSearch: (
    topicId: string,
    title: string,
    keywords?: string[]
  ) => Promise<boolean>;

  /** Extract the selected URLs into doc files. Resolves with the
   *  number of docs saved (zero on failure, with `error` set). */
  fetchSelected: (
    topicId: string,
    urls: string[]
  ) => Promise<number>;

  /** Cancel whatever research operation is running for the topic. */
  cancel: (topicId: string) => Promise<void>;

  /** Empty the candidate list. */
  clearCandidates: () => void;

  /** Clear the last error message. */
  clearError: () => void;
}

// ============================================================
//  The hook
// ============================================================

/**
 * Return the research feature's state and its actions. See the
 * file header for the hook's role, its relationship to the store,
 * and the reasoning behind the design choices.
 */
export const useResearch = (): ResearchHookValue => {
  // ---- Data subscriptions ----
  // One selector per data field. See the file header for why
  // the fields are read individually rather than as one object.
  const candidates = useResearchStore((s) => s.candidates);
  const status = useResearchStore((s) => s.status);
  const searchProgress = useResearchStore((s) => s.searchProgress);
  const extractProgress = useResearchStore((s) => s.extractProgress);
  const extractedCount = useResearchStore((s) => s.extractedCount);
  const error = useResearchStore((s) => s.error);

  // ---- Action subscriptions ----
  // Zustand actions are stable references for the life of the
  // store, so selecting them here does not cause re-renders.
  const startSearch = useResearchStore((s) => s.startSearch);
  const runExtraction = useResearchStore((s) => s.runExtraction);
  const cancelOperation = useResearchStore((s) => s.cancelOperation);
  const clearCandidatesAction = useResearchStore(
    (s) => s.clearCandidates
  );
  const clearErrorAction = useResearchStore((s) => s.clearError);

  // ---- Adapters ----
  // Each adapter wraps a store action to give it the name the
  // plan's Part 1.9 annotation declares (or a stable identity, for
  // the ones whose names already match). See the file header for
  // why the two naming systems exist side by side.

  const runSearch = useCallback(
    async (
      topicId: string,
      title: string,
      keywords?: string[]
    ): Promise<boolean> => {
      return startSearch(topicId, title, keywords);
    },
    [startSearch]
  );

  const fetchSelected = useCallback(
    async (topicId: string, urls: string[]): Promise<number> => {
      return runExtraction(topicId, urls);
    },
    [runExtraction]
  );

  const cancel = useCallback(
    async (topicId: string): Promise<void> => {
      return cancelOperation(topicId);
    },
    [cancelOperation]
  );

  const clearCandidates = useCallback((): void => {
    clearCandidatesAction();
  }, [clearCandidatesAction]);

  const clearError = useCallback((): void => {
    clearErrorAction();
  }, [clearErrorAction]);

  // ---- Return ----
  // A single object literal with all eleven members. The order
  // matches the interface above so a reader comparing the two
  // does not have to hunt for a member's position.
  return {
    candidates,
    status,
    searchProgress,
    extractProgress,
    extractedCount,
    error,
    runSearch,
    fetchSelected,
    cancel,
    clearCandidates,
    clearError,
  };
};

// ============================================================
//  Default export
// ============================================================

/**
 * The hook as the default export, matching the convention used by
 * every other hook and store in the codebase. Consumers that
 * prefer the named form use `import { useResearch } from ...`;
 * consumers that prefer the default form use
 * `import useResearch from ...`. Both resolve to the same hook.
 */
export default useResearch;