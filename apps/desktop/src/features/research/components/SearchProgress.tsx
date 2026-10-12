/**
 * SearchProgress — the live search panel for the Sources tab.
 *
 * Renders one of four visual states, driven by the research
 * hook's `status` field for the topic this panel was given:
 *
 *   1. IDLE (no candidates in any bucket, no error)
 *      A short invitation with a "Start Search" button. The
 *      button calls `runFullSearch(topic._id, topic.title,
 *      topic.keywords, bucketConfig)`, which runs four searches
 *      — one per time-range bucket — sequentially. As each
 *      search's markers arrive, the store's per-bucket handlers
 *      populate the candidate record and clear that bucket's
 *      progress slot, and this panel re-renders into the
 *      SEARCHING state until every bucket has finished.
 *
 *   2. SEARCHING (status === 'searching')
 *      A spinner with an overall progress bar ("N of M across
 *      four buckets — X%") and a secondary line naming the
 *      currently-active bucket and its own progress. The
 *      progress data comes from the hook's `searchProgress`
 *      field, which is a four-bucket record — each bucket's
 *      slot is either `null` (not running) or a live
 *      `SearchProgress` object carrying the page count, the
 *      count found so far, and the count requested. A "Cancel"
 *      button lets the user abort; it calls the hook's `cancel`
 *      action, which hard-kills the Python child (see
 *      `researchIPC.ts` for the graceful-vs-hard distinction).
 *
 *   3. ERROR (status === 'error')
 *      A red banner with the topic's error message and two
 *      buttons: "Retry" (re-runs `runFullSearch`) and "Dismiss"
 *      (clears the error without retrying).
 *
 *   4. COMPLETE (any candidates exist, status back to 'idle')
 *      A green summary line — "N candidates found" — with a
 *      "Search again" button. The candidate list itself is
 *      rendered below this panel by the sibling `SourceList`
 *      component; this panel only reports the count.
 *
 * ── Why the hook call now takes `topic._id` ─────────────────────
 *
 *   PR-1 of the store-isolation refactor (Q4.3: "refactor all
 *   feature stores to key by topicId in the same pass") changed
 *   `useResearch`'s signature from `useResearch()` to
 *   `useResearch(topicId)`. The hook now reads per-topic slots
 *   from the research store — `candidatesByTopic[topicId]`,
 *   `searchProgressByTopic[topicId]`, `statusByTopic[topicId]`,
 *   `errorByTopic[topicId]` — so two components rendering
 *   different topics see independent state and the same
 *   component re-renders only when its own topic's data changes.
 *
 *   This component always has the topic in hand — it receives
 *   the `Topic` object as its only prop — so passing `topic._id`
 *   to the hook is zero-friction.
 *
 * ── The bucket config derivation — a transient PR-1 measure ─────
 *
 *   `runFullSearch` takes a `BucketConfig` that names how many
 *   candidates each of the four time-range buckets should
 *   collect. The definitive source of that config is the
 *   topic's own `searchBuckets` field, which lands in PR-2's
 *   schema change (Item 3 / C2 — the bucket layout is the
 *   single source of truth for how many sources to collect).
 *
 *   Until PR-2 ships, this component derives a config from the
 *   topic's existing `sourceCount`: the total is split evenly
 *   across the four buckets, with any remainder placed on the
 *   first bucket so the four counts always sum to the topic's
 *   `sourceCount`. That even-split rule is the same rule PR-2's
 *   migration script uses for legacy topics ("synthesize
 *   searchBuckets from sourceCount split evenly across four
 *   buckets"), so the transient derivation here is consistent
 *   with the eventual schema value. When PR-2 lands, this
 *   derivation is replaced with a direct read of
 *   `topic.searchBuckets`; the rest of the component is
 *   unchanged.
 *
 * ── Why this panel is separate from SourceList ──────────────────
 *
 *   Same reasoning as before the refactor. The plan's Part 1.9
 *   file tree declares them as separate components, and the
 *   Sources tab renders them stacked (see `TopicDetail.tsx`).
 *   `SearchProgress` owns the ACTION (start a search, cancel it,
 *   retry it) and the live state that belongs to the search
 *   itself; `SourceList` owns the SELECTION UI (checkbox list,
 *   "Fetch Selected" button) and — per PR-3 — the four
 *   collapsible per-bucket sections. A user who is looking at
 *   the candidate list is past the "start a search" decision,
 *   and the two concerns do not belong in one component.
 *
 * ── Why the runFullSearch call takes `topic.keywords` ───────────
 *
 *   Same reasoning as before the refactor. The Python search
 *   script carries the keywords in its marker payload for the
 *   renderer's display but does not use them to construct the
 *   search — the search runs on the title alone, per the plan's
 *   user journey. Passing the keywords through lets the
 *   `SEARCH_RESULT` marker's payload stay complete so the
 *   renderer's metadata row can render a keyword count for the
 *   operation.
 *
 * ── Why the component is NOT responsible for its own guard ──────
 *
 *   Same reasoning as before the refactor. The Sources tab is
 *   only ever mounted inside the topic-detail page, which the
 *   layout's auth gate has already verified. The `topic` prop
 *   it receives is a populated `Topic` object from
 *   `activeTopic`.
 *
 * ── What this component does NOT do ────────────────────────────
 *
 *   - It does not render the candidate list. That is
 *     `SourceList`'s job — see the sibling file.
 *
 *   - It does not persist the search results. See the store's
 *     file header for the non-persistence rationale.
 *
 *   - It does not auto-start the search on mount. The user
 *     clicks "Start Search" — the plan's user journey makes the
 *     search a deliberate action, not something that fires the
 *     moment a page opens.
 *
 *   - It does not call `loadCandidates` on mount. The topic-
 *     detail page owns the fetch-on-open behavior; this panel
 *     only renders state the page (or the panel's own "Start
 *     Search") has already populated.
 *
 *   - It does not detect the captcha modal. When the Python
 *     script hits a captcha, the main process emits a
 *     `CAPTCHA_REQUIRED` marker and the automation store opens
 *     the modal. This panel keeps showing the SEARCHING state
 *     underneath — the modal is on top, and dismissing it either
 *     resumes or aborts the search, at which point this panel's
 *     state catches up via the store.
 */

import { useCallback, useMemo } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  Search,
} from 'lucide-react';

import { useResearch } from '../hooks/useResearch.js';
import type {
  BucketConfig,
  BucketKey,
} from '../store/researchStore.js';
import type { Topic } from '../../shared/types/index.js';

// ============================================================
//  Public types
// ============================================================

/**
 * The props accepted by `SearchProgress`.
 *
 * The panel takes the full `Topic` object rather than a set of
 * individual fields, because every field it uses — `_id` (as the
 * topic identifier for the search), `title` (as the query), and
 * `keywords` (as the payload metadata) — travels together as one
 * unit. A caller that somehow had the title but not the id would
 * have a different problem that no amount of prop-splitting would
 * solve.
 */
export interface SearchProgressProps {
  /** The topic whose search this panel represents. */
  topic: Topic;
}

// ============================================================
//  Internal constants
// ============================================================
//  The four bucket keys, in run order. The array is typed as
//  `readonly BucketKey[]` so the compiler guarantees every
//  string is a legal member of the union — a typo would be a
//  type error, not a silent runtime surprise.
//
//  The same order is what `runFullSearch` uses when it runs the
//  four buckets sequentially; keeping the array here in the same
//  order means the panel's "current bucket" line names the
//  bucket the user would expect to see next.
//
//  `BUCKET_LABELS` maps each key to the display label the panel
//  and the user journey use — "Any time", "Past year", etc. —
//  declared as a `Record<BucketKey, string>` so the compiler
//  enforces exhaustiveness.
//
//  `BUCKET_CONFIG_FIELD` maps each bucket key to the
//  corresponding field name on `BucketConfig`. The two type
//  systems use different casing on purpose — the keys are
//  lowercase slugs matching the marker protocol, and the config
//  fields are the camelCase names the store declares — and this
//  map is the single place where the two are associated.

const BUCKET_KEYS: readonly BucketKey[] = [
  'anytime',
  'year',
  'month',
  'week',
];

const BUCKET_LABELS: Record<BucketKey, string> = {
  anytime: 'Any time',
  year: 'Past year',
  month: 'Past month',
  week: 'Past week',
};

const BUCKET_CONFIG_FIELD: Record<BucketKey, keyof BucketConfig> = {
  anytime: 'anyTime',
  year: 'pastYear',
  month: 'pastMonth',
  week: 'pastWeek',
};

// ============================================================
//  SearchProgress
// ============================================================

/**
 * The search panel. See the file header for the four states and
 * the reasoning behind the component's scope.
 */
export const SearchProgress = ({ topic }: SearchProgressProps) => {
  const {
    candidates,
    candidatesByBucket,
    status,
    searchProgress,
    error,
    runFullSearch,
    cancel,
    clearError,
  } = useResearch(topic._id);

  // ---- Bucket config derivation ----
  // See the file header's "bucket config derivation" note for
  // why this is derived from `topic.sourceCount` today and will
  // read `topic.searchBuckets` once PR-2 lands. The even split
  // with remainder on the first bucket guarantees the four
  // counts always sum to `topic.sourceCount`.
  const bucketConfig = useMemo((): BucketConfig => {
    const total = topic.sourceCount;
    const per = Math.floor(total / 4);
    const remainder = total - per * 4;
    return {
      anyTime: per + remainder,
      pastYear: per,
      pastMonth: per,
      pastWeek: per,
    };
  }, [topic.sourceCount]);

  // ---- Start / retry ----
  // The same handler serves both the idle-state "Start Search"
  // button, the error-state "Retry" button, and the complete
  // state's "Search again" button — the underlying operation is
  // identical in all three cases: run the four-bucket search.
  //
  // The `useCallback` dependencies are all stable references —
  // `runFullSearch` is a `useCallback`-wrapped adapter from the
  // hook, and the four topic fields are read from the immutable
  // `Topic` prop. The handler therefore has a stable identity
  // across renders, so a component that listed it in a
  // `useEffect` dependency array would not re-run the effect on
  // every render.
  //
  // `topic.keywords` is a `readonly string[]` on the type, but
  // `runFullSearch` accepts a mutable `string[]`. The spread
  // `[...]` produces a mutable copy, which is what the hook
  // expects; passing the readonly array directly would be a
  // type error under `exactOptionalPropertyTypes`' strict
  // readonly handling.
  const handleStart = useCallback((): void => {
    void runFullSearch(
      topic._id,
      topic.title,
      [...topic.keywords],
      bucketConfig
    );
  }, [
    runFullSearch,
    topic._id,
    topic.title,
    topic.keywords,
    bucketConfig,
  ]);

  // ---- Cancel ----
  const handleCancel = useCallback((): void => {
    void cancel(topic._id);
  }, [cancel, topic._id]);

  // ---- Dismiss error ----
  const handleDismiss = useCallback((): void => {
    clearError(topic._id);
  }, [clearError, topic._id]);

  // ---- Derived per-bucket progress ----
  //
  // `searchProgress` from the hook is a four-bucket record: each
  // bucket's slot is either `null` (not running) or a live
  // `SearchProgress` object. The `runFullSearch` action runs the
  // four buckets sequentially, so at most one slot is non-null
  // at any moment — the currently-active bucket.
  //
  // `currentBucket` is the key of that bucket, or `null` when no
  // bucket is currently running (which happens only in the
  // transition between two buckets' runs, a sub-second window).
  //
  // `foundTotal` sums the completed buckets' candidate counts
  // (from `candidatesByBucket`) plus the currently-active
  // bucket's live count (from its progress slot). The two
  // sources are mutually exclusive per bucket: a completed
  // bucket's progress is cleared and its candidates are in the
  // candidates record; a running bucket's candidates record is
  // empty and its count is in the progress slot.
  //
  // `requestedTotal` is the sum of the four configured counts
  // from `bucketConfig`. It does not change during a run.
  const currentBucket: BucketKey | null = useMemo(() => {
    for (const key of BUCKET_KEYS) {
      if (searchProgress[key] !== null) {
        return key;
      }
    }
    return null;
  }, [searchProgress]);

  const foundTotal = useMemo((): number => {
    let total = 0;
    for (const key of BUCKET_KEYS) {
      total += candidatesByBucket[key].length;
      total += searchProgress[key]?.found ?? 0;
    }
    return total;
  }, [candidatesByBucket, searchProgress]);

  const requestedTotal = useMemo((): number => {
    return (
      bucketConfig.anyTime +
      bucketConfig.pastYear +
      bucketConfig.pastMonth +
      bucketConfig.pastWeek
    );
  }, [bucketConfig]);

  // ---- State 1: SEARCHING ----
  // The live progress panel. Shown while `status === 'searching'`
  // regardless of how many candidates have been collected so far —
  // the whole point is that the user can see partial progress as
  // it happens.
  //
  // Two progress indicators are shown side by side:
  //
  //   * The overall progress bar. Its numerator is `foundTotal`
  //     (sum of completed buckets' candidate counts plus the
  //     running bucket's live count) and its denominator is
  //     `requestedTotal` (the sum of the four configured bucket
  //     counts). The percentage is derived from the ratio and
  //     clamped to 100.
  //
  //   * The current bucket's own line. The bucket is the one
  //     whose progress slot is non-null; its own count comes
  //     from that slot's `found` field, and its requested count
  //     comes from the corresponding field on `bucketConfig`.
  //     The bucket's label is looked up from `BUCKET_LABELS`.
  //
  // A user who has configured one bucket with zero candidates
  // will not see that bucket's progress — `runFullSearch` skips
  // zero-count buckets entirely (Q8.3), and the skipped buckets
  // contribute zero to both the numerator and the denominator.
  if (status === 'searching') {
    const currentBucketProgress =
      currentBucket !== null ? searchProgress[currentBucket] : null;
    const currentRequested =
      currentBucket !== null
        ? bucketConfig[BUCKET_CONFIG_FIELD[currentBucket]]
        : 0;
    const overallPercent =
      requestedTotal > 0
        ? Math.min(
            100,
            Math.round((foundTotal / requestedTotal) * 100)
          )
        : 0;

    return (
      <div
        role="status"
        aria-live="polite"
        className={
          'flex items-start gap-3 rounded-xl border ' +
          'border-neutral-200 bg-background p-4 ' +
          'dark:border-neutral-800'
        }
      >
        <Loader2
          size={20}
          className="mt-0.5 shrink-0 animate-spin text-primary"
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <p
            className={
              'text-sm font-medium text-text ' +
              'dark:text-neutral-100'
            }
          >
            Searching the web…
          </p>

          {/* ---- Overall progress ---- */}
          <div className="mt-2">
            <div
              className={
                'flex items-center justify-between text-xs ' +
                'text-neutral-500 dark:text-neutral-400'
              }
            >
              <span>Overall</span>
              <span className="tabular-nums">
                {foundTotal} of {requestedTotal} · {overallPercent}%
              </span>
            </div>
            <div
              className={
                'mt-1 h-1.5 w-full overflow-hidden rounded-full ' +
                'bg-neutral-200 dark:bg-neutral-800'
              }
              role="progressbar"
              aria-valuenow={overallPercent}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div
                className="h-full bg-primary transition-all duration-300"
                style={{ width: `${overallPercent}%` }}
              />
            </div>
          </div>

          {/* ---- Current bucket progress ---- */}
          {currentBucket !== null && currentBucketProgress !== null && (
            <p
              className={
                'mt-2 text-xs text-neutral-500 ' +
                'dark:text-neutral-400'
              }
            >
              {BUCKET_LABELS[currentBucket]}:{' '}
              <span className="tabular-nums">
                {currentBucketProgress.found} of {currentRequested}
              </span>
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={handleCancel}
          className={
            'shrink-0 rounded-lg border border-neutral-300 ' +
            'bg-background px-3 py-1.5 text-xs font-medium ' +
            'text-text transition-colors ' +
            'hover:bg-neutral-100 ' +
            'focus-visible:outline-none ' +
            'dark:border-neutral-700 dark:hover:bg-neutral-800 ' +
            'dark:text-neutral-100'
          }
        >
          Cancel
        </button>
      </div>
    );
  }

  // ---- State 2: ERROR ----
  // The store's error field is set by every failure path: a
  // rejected IPC promise, a search service that returned
  // `{ success: false }`, a captcha-driven user skip, or a
  // timeout. All of them produce a user-facing message, and all of
  // them are handled the same way — show the banner, offer Retry
  // and Dismiss.
  if (status === 'error' && error !== null) {
    return (
      <div
        role="alert"
        className={
          'flex flex-col gap-3 rounded-xl border ' +
          'border-red-200 bg-red-50 p-4 ' +
          'dark:border-red-900 dark:bg-red-950/60'
        }
      >
        <div className="flex items-start gap-2">
          <AlertCircle
            size={18}
            className="mt-0.5 shrink-0 text-red-600 dark:text-red-400"
            aria-hidden="true"
          />
          <p
            className={
              'min-w-0 flex-1 text-sm text-red-900 ' +
              'dark:text-red-100'
            }
          >
            {error}
          </p>
        </div>
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={handleDismiss}
            className={
              'rounded-lg border border-red-300 bg-transparent ' +
              'px-3 py-1.5 text-xs font-medium text-red-800 ' +
              'transition-colors hover:bg-red-100 ' +
              'focus-visible:outline-none ' +
              'dark:border-red-800 dark:text-red-200 ' +
              'dark:hover:bg-red-900/40'
            }
          >
            Dismiss
          </button>
          <button
            type="button"
            onClick={handleStart}
            className={
              'rounded-lg bg-red-600 px-3 py-1.5 text-xs ' +
              'font-medium text-white transition-colors ' +
              'hover:bg-red-700 focus-visible:outline-none'
            }
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  // ---- State 3: COMPLETE ----
  // Candidates exist in the store and the operation is not
  // running. The panel reports the count and offers a re-search
  // (useful when the topic's title or keywords have changed, or
  // when the user wants to refresh the candidate list from a
  // different angle).
  if (candidates.length > 0) {
    return (
      <div
        className={
          'flex items-center gap-3 rounded-xl border ' +
          'border-emerald-200 bg-emerald-50 p-4 ' +
          'dark:border-emerald-900 dark:bg-emerald-950/60'
        }
      >
        <CheckCircle2
          size={20}
          className="shrink-0 text-emerald-600 dark:text-emerald-400"
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <p
            className={
              'text-sm font-medium text-emerald-900 ' +
              'dark:text-emerald-100'
            }
          >
            {candidates.length}{' '}
            {candidates.length === 1 ? 'candidate' : 'candidates'} found
          </p>
          <p
            className={
              'mt-0.5 text-xs text-emerald-800/80 ' +
              'dark:text-emerald-200/80'
            }
          >
            Review the list below and pick the sources to extract.
          </p>
        </div>
        <button
          type="button"
          onClick={handleStart}
          className={
            'shrink-0 rounded-lg border ' +
            'border-emerald-300 bg-transparent px-3 py-1.5 ' +
            'text-xs font-medium text-emerald-800 ' +
            'transition-colors hover:bg-emerald-100 ' +
            'focus-visible:outline-none ' +
            'dark:border-emerald-800 dark:text-emerald-200 ' +
            'dark:hover:bg-emerald-900/40'
          }
        >
          Search again
        </button>
      </div>
    );
  }

  // ---- State 4: IDLE ----
  // Nothing has been searched yet. The invitation and the primary
  // call to action.
  return (
    <div
      className={
        'flex items-center gap-3 rounded-xl border ' +
        'border-neutral-200 bg-background p-4 ' +
        'dark:border-neutral-800'
      }
    >
      <div
        className={
          'flex h-10 w-10 shrink-0 items-center justify-center ' +
          'rounded-full bg-neutral-100 text-neutral-500 ' +
          'dark:bg-neutral-800 dark:text-neutral-400'
        }
      >
        <Search size={18} aria-hidden="true" />
      </div>
      <div className="min-w-0 flex-1">
        <p
          className={
            'text-sm font-medium text-text ' +
            'dark:text-neutral-100'
          }
        >
          Ready to search
        </p>
        <p
          className={
            'mt-0.5 text-xs text-neutral-500 ' +
            'dark:text-neutral-400'
          }
        >
          Find candidate source pages for this topic on the web.
        </p>
      </div>
      <button
        type="button"
        onClick={handleStart}
        className={
          'shrink-0 rounded-lg bg-primary px-4 py-2 text-sm ' +
          'font-medium text-white transition-colors ' +
          'hover:bg-primary-dark focus-visible:outline-none'
        }
      >
        Start Search
      </button>
    </div>
  );
};

// ============================================================
//  Default export
// ============================================================

/**
 * The `SearchProgress` component as the default export.
 * `TopicDetail.tsx` imports it with the default form
 * (`import SearchProgress from '.../SearchProgress.js'`) — see the
 * forward reference in that file's imports — so this is the
 * export that resolves the reference.
 */
export default SearchProgress;