/**
 * useResearch — the renderer's research hook.
 *
 * The single entry point through which the app's components read
 * and manipulate the research feature's state for ONE topic. It
 * sits over `useResearchStore` and mirrors the role
 * `useWriter(topicId)` and `useValidation()` play for their
 * respective features:
 *
 *   - The store owns the state. The hook does not add any.
 *
 *   - The store owns the async actions that reach the IPC layer
 *     and, through it, the main process. The hook does not
 *     reimplement them.
 *
 *   - The hook's only job is to give a component a single, stable
 *     object with everything the research feature exposes for one
 *     topic — the per-topic data fields and the actions.
 *
 * ── The hook's signature ────────────────────────────────────────
 *
 *   `useResearch(topicId)` — the topic ID argument is required.
 *   The hook reads the topic's per-topic slots from the store via
 *   selectors keyed on that ID, so two components rendering
 *   different topics see independent state, and the same
 *   component re-renders only when its own topic's state changes.
 *
 *   This mirrors `useWriter(topicId)`'s shape. Every feature hook
 *   that drives a per-topic pipeline stage takes the topic ID as
 *   its first argument, so the pattern is uniform across the
 *   writer, research, documents, and validation features.
 *
 * ── The hook's API ──────────────────────────────────────────────
 *
 *   Data fields (all read from the topic passed to the hook):
 *
 *     candidates         The topic's candidates, flattened across
 *                        all four time-range buckets.
 *     candidatesByBucket The topic's per-bucket candidate record
 *                        (each bucket key present; empty array
 *                        for a bucket the search has not touched).
 *     status             The topic's lifecycle state — 'idle',
 *                        'searching', 'extracting', or 'error'.
 *     searchProgress     The topic's per-bucket live search
 *                        progress.
 *     extractProgress    The topic's live extraction progress, or
 *                        null when no extraction is in flight.
 *     extractedCount     How many doc files the topic's last
 *                        extraction saved.
 *     failed             The topic's failed-URL records, loaded
 *                        from `failures.json` on first open.
 *     error              The topic's last error message, or null.
 *
 *   Actions:
 *
 *     runFullSearch(topicId, title, keywords, bucketConfig)
 *                        Run the four-bucket search. Wraps the
 *                        store's `runFullSearch` action; resolves
 *                        with a boolean (true on success).
 *
 *     runSearch(topicId, title, keywords?, bucket?)
 *                        Backward-compat single-bucket search,
 *                        kept for the "Search again" flow that
 *                        re-searches one time range without
 *                        touching the others. Wraps
 *                        `runFullSearch` with a single-bucket
 *                        config; the bucket argument defaults to
 *                        'anytime' when omitted.
 *
 *     fetchSelected(topicId, urls)
 *                        Extract the selected URLs. Wraps the
 *                        store's `runExtraction` action; resolves
 *                        with the number of docs saved.
 *
 *     retryFailed(topicId)
 *                        Re-run extraction for the topic's failed
 *                        URLs only. Wraps the store's
 *                        `retryFailed` action.
 *
 *     loadCandidates(topicId)
 *                        Read the topic's saved candidates and
 *                        failures from disk on first open. Wraps
 *                        the store's `loadCandidates` action.
 *
 *     cancel(topicId)    Cancel whatever research operation is
 *                        running for the topic.
 *
 *     clearCandidates(topicId)
 *                        Empty the topic's candidate list.
 *
 *     clearError(topicId)
 *                        Clear the topic's last error message.
 *
 * ── Why the hook has both `runFullSearch` and `runSearch` ───────
 *
 *   The store's `runFullSearch` action searches every configured
 *   bucket in sequence. It is the primary search action and the
 *   one the Sources tab's "Start Search" button uses.
 *
 *   The hook also keeps `runSearch` for the "Search again" flow
 *   within a single bucket. That flow wants to re-run one time
 *   range without touching the others; `runSearch` implements it
 *   by calling `runFullSearch` with a config that puts the
 *   default count in the requested bucket and zero everywhere
 *   else. The store's `runFullSearch` treats a zero-count bucket
 *   as "skip", so only the requested bucket actually searches.
 *
 *   Keeping both names lets the single-bucket flow continue to
 *   read as "a search" at the call site, while the code underneath
 *   is the same machinery in both cases.
 *
 * ── Why the hook exposes per-bucket state ───────────────────────
 *
 *   The store holds a four-bucket candidate record and a four-
 *   bucket progress record per topic, and the hook surfaces the
 *   specific topic's slot for each. `candidatesByBucket` carries
 *   the full record so a caller that wants to render four
 *   collapsible sections (one per bucket) has everything in one
 *   place. `candidates` is the flattened view across all four
 *   buckets, for callers that want a single list.
 *
 *   `searchProgress` is likewise a per-bucket record — the UI can
 *   show per-bucket progress bars and an overall progress bar
 *   (derived by summing the four buckets' counts) from the same
 *   field.
 *
 * ── Why the hook renames the store's actions ────────────────────
 *
 *   The plan's Part 1.9 annotation names two actions — `runSearch`
 *   and `fetchSelected`. The store's own actions are named
 *   `runFullSearch`, `runExtraction`, and `retryFailed` — the
 *   names it uses internally and in its own documentation. The
 *   hook exposes the plan-mandated names where the plan names
 *   them, and the store's names everywhere else.
 *
 * ── Why the actions are `useCallback`-wrapped ───────────────────
 *
 *   Zustand stores return stable action references for the life
 *   of the store, so returning them directly would already be
 *   stable. But the adapters that rename or reshape the store's
 *   actions (`runFullSearch`, `runSearch`) are thin wrappers, and
 *   a freshly-defined function inside a hook body has a new
 *   identity on every render. `useCallback` with the store's
 *   action as its sole dependency gives the wrapper a stable
 *   identity for as long as the store is alive.
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
 *   last `runFullSearch` call.
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
 *   Same reasoning as `useTopics` and `useWriter`: Zustand
 *   re-renders a component when any of the selectors it
 *   subscribed to returns a different value, and subscribing
 *   per-field gives the finest-grained re-render behaviour.
 *
 *   Every selector additionally keys on the hook's `topicId`
 *   argument — a selector that reads
 *   `s.candidatesByTopic[topicId]` changes identity only when
 *   that specific topic's data changes, not when another topic's
 *   does. That per-topic keying is what makes the hook safe to
 *   mount twice for two different topics on the same page.
 *
 * ── What this hook does NOT do ──────────────────────────────────
 *
 *   - It does not call `runFullSearch` or `loadCandidates` on
 *     mount. The hook is a passive reader; the component that
 *     mounts it decides when to fetch. The Sources tab calls
 *     `runFullSearch` from a click handler and `loadCandidates`
 *     from a mount effect on the topic detail page.
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

import { useCallback, useMemo } from 'react';

import {
  useResearchStore,
  type BucketConfig,
  type BucketKey,
  type CandidatesByBucket,
  type ExtractProgress,
  type FailedUrlRecord,
  type ResearchStoreStatus,
  type SearchCandidate,
  type SearchProgress,
} from '../store/researchStore.js';

// ============================================================
//  Public types
// ============================================================

/**
 * The shape of the object returned by `useResearch(topicId)`.
 *
 * Exported so that a helper function that takes "an instance of
 * the research hook" as a parameter can be typed against the
 * interface without redeclaring the shape. A component that
 * destructures the return value does not need to reference the
 * interface at all.
 *
 * Every data field is read from the topic the hook was called
 * with. Every action takes the topic ID as its first argument so
 * a caller that holds a topic reference in a callback does not
 * have to close over the hook's own `topicId` — the two are the
 * same value in practice, but passing it explicitly keeps the
 * call site readable and matches the shape `useWriter(topicId)`
 * establishes.
 */
export interface ResearchHookValue {
  // ---- Data ----

  /** The topic's candidates, flattened across all four time-range
   *  buckets. Empty until the first search completes for this
   *  topic. */
  candidates: SearchCandidate[];

  /** The topic's per-bucket candidate record. Every bucket key is
   *  present; a bucket the search has not touched holds an empty
   *  array. */
  candidatesByBucket: CandidatesByBucket;

  /** The topic's lifecycle state. See `ResearchStoreStatus` in
   *  `researchStore.ts` for the meaning of each value. */
  status: ResearchStoreStatus;

  /** The topic's per-bucket live search progress. A bucket's slot
   *  is null when that bucket is not currently searching. */
  searchProgress: Record<BucketKey, SearchProgress | null>;

  /** The topic's live extraction progress, or null when no
   *  extraction is in flight for this topic. */
  extractProgress: ExtractProgress | null;

  /** How many doc files the topic's last extraction saved. Zero
   *  before the first extraction and after a clear. */
  extractedCount: number;

  /** The topic's failed-URL records, loaded from the topic's
   *  `failures.json` file on first open. Empty until loaded, and
   *  when the file is absent. */
  failed: FailedUrlRecord[];

  /** The topic's last error message from a search or extraction,
   *  or null. */
  error: string | null;

  // ---- Actions ----

  /** Run the four-bucket search for a topic. Resolves with `true`
   *  when every configured bucket's IPC call succeeded, `false` on
   *  any failure. */
  runFullSearch: (
    topicId: string,
    title: string,
    keywords: string[],
    bucketConfig: BucketConfig
  ) => Promise<boolean>;

  /** Backward-compat single-bucket search. Re-runs one time-range
   *  bucket without touching the others (the store's
   *  `runFullSearch` skips zero-count buckets). The `bucket`
   *  argument defaults to `'anytime'` when omitted. */
  runSearch: (
    topicId: string,
    title: string,
    keywords?: string[],
    bucket?: BucketKey
  ) => Promise<boolean>;

  /** Extract the selected URLs into doc files. Resolves with the
   *  number of docs saved (zero on failure, with `error` set). */
  fetchSelected: (
    topicId: string,
    urls: string[]
  ) => Promise<number>;

  /** Re-run extraction for the topic's failed URLs only. Resolves
   *  with the number of docs saved by the retry. */
  retryFailed: (topicId: string) => Promise<number>;

  /** Read the topic's saved candidates and failed-URL records
   *  from disk. Resolves once the load completes. Subsequent
   *  calls for a topic that already has a candidates slot are
   *  no-ops. */
  loadCandidates: (topicId: string) => Promise<void>;

  /** Cancel whatever research operation is running for the topic. */
  cancel: (topicId: string) => Promise<void>;

  /** Empty the topic's candidate list. */
  clearCandidates: (topicId: string) => void;

  /** Clear the topic's last error message. */
  clearError: (topicId: string) => void;
}

// ============================================================
//  Internal constants
// ============================================================
//  Shared empty containers with stable module-level identity.
//  The hook returns these when a topic has no data yet — a fresh
//  object per render would change identity on every render, which
//  would defeat memoization on the consumer side and would make
//  any `useEffect` keyed on the field re-run on every render.
//
//  The objects are never mutated by this module or (by contract)
//  by any consumer. A consumer that wants to add to one of the
//  arrays is expected to build a new array — the same rule that
//  applies to every other container the store hands out.

const EMPTY_BUCKETS: CandidatesByBucket = {
  anytime: [],
  year: [],
  month: [],
  week: [],
};

const EMPTY_PROGRESS_BUCKETS: Record<
  BucketKey,
  SearchProgress | null
> = {
  anytime: null,
  year: null,
  month: null,
  week: null,
};

const EMPTY_FAILED: FailedUrlRecord[] = [];

// ============================================================
//  The hook
// ============================================================

/**
 * Return the research feature's state and its actions. See the
 * file header for the hook's role, its relationship to the store,
 * and the reasoning behind the design choices.
 */
export const useResearch = (topicId: string): ResearchHookValue => {
  // ---- Data subscriptions ----
  // One selector per data field, each keyed on the hook's
  // `topicId` argument. See the file header for why the fields
  // are read individually and why the keying matters.
  //
  // The raw selectors can each return `undefined` when the topic
  // has no entry in the corresponding record. The derived
  // bindings below apply the module-level fallback constants so
  // the interface's non-optional fields always carry a value.
  const candidatesByBucketRaw = useResearchStore(
    (s) => s.candidatesByTopic[topicId]
  );
  const statusRaw = useResearchStore(
    (s) => s.statusByTopic[topicId]
  );
  const searchProgressRaw = useResearchStore(
    (s) => s.searchProgressByTopic[topicId]
  );
  const extractProgressRaw = useResearchStore(
    (s) => s.extractProgressByTopic[topicId]
  );
  const extractedCountRaw = useResearchStore(
    (s) => s.extractedCountByTopic[topicId]
  );
  const failedRaw = useResearchStore(
    (s) => s.failedByTopic[topicId]
  );
  const errorRaw = useResearchStore(
    (s) => s.errorByTopic[topicId]
  );

  // ---- Derived fields ----
  const candidatesByBucket: CandidatesByBucket =
    candidatesByBucketRaw ?? EMPTY_BUCKETS;
  const status: ResearchStoreStatus = statusRaw ?? 'idle';
  const searchProgress: Record<
    BucketKey,
    SearchProgress | null
  > = searchProgressRaw ?? EMPTY_PROGRESS_BUCKETS;
  const extractProgress: ExtractProgress | null =
    extractProgressRaw ?? null;
  const extractedCount: number = extractedCountRaw ?? 0;
  const failed: FailedUrlRecord[] = failedRaw ?? EMPTY_FAILED;
  const error: string | null = errorRaw ?? null;

  // The flattened view across all four buckets. Memoized on the
  // per-topic bucket record's identity so a consumer that
  // depends on `candidates` does not see a new array on every
  // render — the memo's dependency is stable across unrelated
  // store updates because the raw per-topic slot's identity does
  // not change when another topic's data changes.
  const candidates = useMemo((): SearchCandidate[] => {
    return [
      ...candidatesByBucket.anytime,
      ...candidatesByBucket.year,
      ...candidatesByBucket.month,
      ...candidatesByBucket.week,
    ];
  }, [candidatesByBucket]);

  // ---- Action subscriptions ----
  // Zustand actions are stable references for the life of the
  // store, so selecting them here does not cause re-renders.
  const storeRunFullSearch = useResearchStore(
    (s) => s.runFullSearch
  );
  const storeRunExtraction = useResearchStore(
    (s) => s.runExtraction
  );
  const storeRetryFailed = useResearchStore((s) => s.retryFailed);
  const storeCancelOperation = useResearchStore(
    (s) => s.cancelOperation
  );
  const storeLoadCandidates = useResearchStore(
    (s) => s.loadCandidates
  );
  const storeClearCandidates = useResearchStore(
    (s) => s.clearCandidates
  );
  const storeClearError = useResearchStore((s) => s.clearError);

  // ---- Adapters ----
  // Each adapter wraps a store action to give it a stable
  // identity across renders. See the file header for why.

  const runFullSearch = useCallback(
    async (
      id: string,
      title: string,
      keywords: string[],
      bucketConfig: BucketConfig
    ): Promise<boolean> => {
      return storeRunFullSearch(id, title, keywords, bucketConfig);
    },
    [storeRunFullSearch]
  );

  // The backward-compat single-bucket search. The default bucket
  // is 'anytime' and the default count is 20 — the same value
  // the IPC handler's pre-bucketed `DEFAULT_MAX_RESULTS` used,
  // so an existing caller that provided only a title gets the
  // same behavior it used to. The store's `runFullSearch` skips
  // zero-count buckets, so only the requested bucket searches.
  const runSearch = useCallback(
    async (
      id: string,
      title: string,
      keywords?: string[],
      bucket: BucketKey = 'anytime'
    ): Promise<boolean> => {
      const bucketConfig: BucketConfig = {
        anyTime: bucket === 'anytime' ? 20 : 0,
        pastYear: bucket === 'year' ? 20 : 0,
        pastMonth: bucket === 'month' ? 20 : 0,
        pastWeek: bucket === 'week' ? 20 : 0,
      };
      return storeRunFullSearch(
        id,
        title,
        keywords ?? [],
        bucketConfig
      );
    },
    [storeRunFullSearch]
  );

  const fetchSelected = useCallback(
    async (id: string, urls: string[]): Promise<number> => {
      return storeRunExtraction(id, urls);
    },
    [storeRunExtraction]
  );

  const retryFailed = useCallback(
    async (id: string): Promise<number> => {
      return storeRetryFailed(id);
    },
    [storeRetryFailed]
  );

  const loadCandidates = useCallback(
    async (id: string): Promise<void> => {
      return storeLoadCandidates(id);
    },
    [storeLoadCandidates]
  );

  const cancel = useCallback(
    async (id: string): Promise<void> => {
      return storeCancelOperation(id);
    },
    [storeCancelOperation]
  );

  const clearCandidates = useCallback(
    (id: string): void => {
      storeClearCandidates(id);
    },
    [storeClearCandidates]
  );

  const clearError = useCallback(
    (id: string): void => {
      storeClearError(id);
    },
    [storeClearError]
  );

  // ---- Return ----
  // A single object literal with all sixteen members. The order
  // matches the interface above so a reader comparing the two
  // does not have to hunt for a member's position.
  return {
    candidates,
    candidatesByBucket,
    status,
    searchProgress,
    extractProgress,
    extractedCount,
    failed,
    error,
    runFullSearch,
    runSearch,
    fetchSelected,
    retryFailed,
    loadCandidates,
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