/**
 * SourceList — the candidate list for the Sources tab.
 *
 * Renders the topic's search candidates as four collapsible
 * sections, one per time-range bucket, each showing the
 * candidates that bucket's search found. Above the sections sits
 * a header row with the total candidate count and a "Select
 * all" / "Clear selection" toggle; below them, a footer with the
 * selected count and a "Fetch Selected" button.
 *
 * When the topic's `failures.json` has at least one record, a
 * failed-URL banner appears between the header row and the four
 * sections. The banner carries a "Retry all failed (N)" action
 * that re-runs extraction for the failed URLs only.
 *
 * During extraction the footer swaps to a live progress panel —
 * "Extracting 3 of 10 · <current URL>" — driven by the store's
 * `extractProgress` field. On completion the footer becomes a
 * short green summary ("N documents saved") with a hint that
 * moves the user toward the Documents tab.
 *
 * ── The hook signature (PR-1) ───────────────────────────────────
 *
 *   `useResearch(topic._id)` — the hook now takes the topic ID as
 *   its required first argument so this component reads the
 *   store's per-topic slots for the topic it was given. See
 *   `useResearch.ts`'s file header for the full rationale on the
 *   signature change; the short version is Q4.3's "refactor all
 *   feature stores to key by topicId in the same pass."
 *
 * ── The four collapsible sections (PR-3 / Q8.4) ─────────────────
 *
 *   The candidates are rendered under four section headers, one
 *   per bucket: "Any time", "Past year", "Past month", "Past
 *   week". Each section is a `<section>` element with a
 *   disclosure button and, when expanded, the bucket's
 *   `SourceCandidate` rows. All four sections default to
 *   expanded after a search, matching Q8.4's "Default to
 *   expanded after a search."
 *
 *   The collapsed/expanded state is component-local: a
 *   `Record<BucketKey, boolean>` held in `useState`, with each
 *   bucket's slot toggled independently. The state is not
 *   persisted — navigating away and back resets all four
 *   sections to expanded, which is the correct default.
 *
 *   An empty bucket (a search that returned no results for that
 *   time range, or a bucket the user configured with a zero
 *   count and the store skipped, per Q8.3) renders its header
 *   with "(0 candidates)" and, when expanded, a short "No
 *   candidates in this time range" line. Rendering all four
 *   buckets regardless of count keeps the four-section structure
 *   stable across searches; a bucket that returned nothing this
 *   time may return results on the next search, and its section
 *   should not have to reappear.
 *
 * ── The failed-URL banner (PR-4 / Q2.2) ─────────────────────────
 *
 *   When the topic's failed-URL list has at least one record — a
 *   previous extraction attempt failed on at least one URL — a
 *   banner appears above the sections with the count and a
 *   "Retry all failed (N)" button. The button calls the hook's
 *   `retryFailed(topic._id)` action, which re-runs extraction
 *   for the failed URLs only; successful docs already on disk are
 *   not touched (Q2.3 — "Retry only the failed URLs, keep
 *   successful docs").
 *
 *   The banner is hidden during an extraction so the user has
 *   exactly one active action row at a moment. It reappears after
 *   the operation completes if any failures remain — which is the
 *   correct behavior, because a retry that fails again leaves the
 *   failure in `failures.json` and the banner should say so.
 *
 * ── Auto-select on new candidates ───────────────────────────────
 *
 *   The plan's user journey is explicit: "Every candidate is
 *   checked by default." The user's job is to UNCHECK the ones
 *   they don't want, not to check the ones they do — the tool
 *   optimises for the common case (most candidates are useful),
 *   not for a cautious user.
 *
 *   The auto-selection is implemented as a `useEffect` keyed on
 *   the hook's `candidates` field — the flattened view across all
 *   four buckets. Whenever that array changes identity — a search
 *   that just completed, a "Search again" that cleared the list,
 *   a page refresh that reset the store — the selection set is
 *   rebuilt to contain every current candidate URL. A user who
 *   unchecks some candidates and then runs another search gets
 *   the new search's fresh selections; their old manual choices
 *   do not persist across searches, which is the correct
 *   behaviour — the two candidate lists are different
 *   populations.
 *
 *   The hook memoizes the flattened array on the per-topic bucket
 *   record's identity, so the effect's dependency is stable across
 *   unrelated store updates (a marker for another topic does not
 *   produce a new flattened array here).
 *
 * ── Why selection is a Set<string> keyed by URL ─────────────────
 *
 *   The candidates' identity is their URL. Two candidates with
 *   the same URL from different buckets are the same source; the
 *   store deduplicates them before they reach this component, so
 *   the URL is unique across the flattened list. A `Set<string>`
 *   of URLs gives O(1) membership tests for the per-row "is this
 *   one checked" question, and O(1) toggles.
 *
 *   The alternative — a `Set<number>` of candidate indices — would
 *   require the effect to recompute the index of every candidate
 *   on every list mutation, and would produce bugs whenever the
 *   list was re-sorted or a section was collapsed. URLs are the
 *   stable identity, and the same selection set spans all four
 *   sections.
 *
 * ── The "Fetch Selected" call ───────────────────────────────────
 *
 *   Calls the hook's `fetchSelected(topic._id, urls)` with the
 *   selected URLs as a `string[]` (converted from the Set via
 *   `Array.from`). The store's `runExtraction` action flips the
 *   topic's `status` to `'extracting'`, kicks off the IPC call to
 *   the main process, and updates state as `EXTRACT_PROGRESS` /
 *   `EXTRACT_DONE` markers arrive. This component does not await
 *   the returned promise — the store's state transitions are what
 *   re-render the panel into the progress view.
 *
 *   The order in which `Array.from(selectedUrls)` returns the
 *   URLs is the insertion order of the Set. Because the set is
 *   rebuilt from scratch in the auto-select effect (iterating
 *   `candidates` in the flattened bucket order), the insertion
 *   order matches the candidate list order. The extraction
 *   therefore processes the URLs in the same order the user saw
 *   them, which is what makes the "Extracting 3 of 10" progress
 *   indicator correspond to what the user is looking at.
 *
 * ── Why this component is not the source of the `topic` prop ────
 *
 *   The `topic` prop is passed down from `TopicDetail.tsx` through
 *   `SourcesTab` (the internal composition inside `TopicDetail`).
 *   The `SourceList` component needs the topic's `_id` for three
 *   reasons: the hook call (`useResearch(topic._id)`), the fetch
 *   call (`fetchSelected(topic._id, urls)`), and the retry call
 *   (`retryFailed(topic._id)`). All three take the topic ID as
 *   their first argument, and the topic prop is where this
 *   component reads it from.
 *
 * ── What this component does NOT do ────────────────────────────
 *
 *   - It does not render the individual candidate rows. That is
 *     `SourceCandidate`'s job (a forward-referenced component —
 *     see the imports). This component owns the list container,
 *     the sections, the selection state, and the actions; the
 *     row is a leaf that receives `{ candidate, selected,
 *     disabled, onToggle }` and renders one item's UI.
 *
 *   - It does not manage the search itself. That is
 *     `SearchProgress`'s job — the sibling component rendered
 *     above this list in the Sources tab. `SourceList` renders
 *     nothing until the topic has at least one candidate (or at
 *     least one failed URL — see the early return below), at
 *     which point the search is already done.
 *
 *   - It does not persist the selection. The selected URLs are
 *     component-local state that lives for the lifetime of this
 *     component's mount. Navigating away from the Sources tab
 *     unmounts the component and loses the selection. That is
 *     the intended behaviour — a selection made against one
 *     version of the candidate list should not survive a
 *     re-search that produced a different list.
 *
 *   - It does not clear the candidates after a successful
 *     extraction. The store's candidate record persists until
 *     the next search or an explicit clear call. Keeping the
 *     list visible after extraction lets the user review what
 *     they extracted from, which matches the plan's user
 *     journey ("A summary line reads… The user can now click
 *     any doc to preview it").
 *
 *   - It does not persist the collapsed/expanded state of the
 *     four sections. A remount resets all four to expanded,
 *     matching the plan's default.
 *
 *   - It does not fetch the topic's saved candidates or failures
 *     on mount. That is the topic-detail page's job (via the
 *     hook's `loadCandidates` action). This component is a pure
 *     renderer over the state the hook exposes.
 */

import {
  useCallback,
  useEffect,
  useState,
} from 'react';
import {
  AlertCircle,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  Download,
  Loader2,
  RotateCcw,
  Square,
} from 'lucide-react';

import { useResearch } from '../hooks/useResearch.js';
import type { BucketKey } from '../store/researchStore.js';
import SourceCandidate from './SourceCandidate.js';
import type { Topic } from '../../shared/types/index.js';

// ============================================================
//  Public types
// ============================================================

/**
 * The props accepted by `SourceList`.
 *
 * The component takes the full `Topic` object because it needs
 * the topic's `_id` for the `fetchSelected` call. Passing the id
 * alone would work, but the `Topic` shape is what the parent
 * (`TopicDetail`'s Sources tab) already has in hand, so passing
 * it through is zero friction.
 */
export interface SourceListProps {
  /** The topic whose candidates this list represents. */
  topic: Topic;
}

// ============================================================
//  Internal constants
// ============================================================
//  The four bucket keys, in the order the sections render. The
//  array is typed as `readonly BucketKey[]` so the compiler
//  guarantees every string is a legal member of the union — a
//  typo would be a type error, not a silent runtime surprise.
//
//  `BUCKET_LABELS` maps each key to the display label the
//  section headers use. Declared as a
//  `Record<BucketKey, string>` so the compiler enforces
//  exhaustiveness.
//
//  The order matches the sequence `runFullSearch` runs the four
//  buckets in, so the sections stack in the order the searches
//  completed.

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

// ============================================================
//  SourceList
// ============================================================

/**
 * The candidate list. See the file header for the component's
 * responsibilities, the auto-select behaviour, and the reasoning
 * behind the Set-based selection.
 */
export const SourceList = ({ topic }: SourceListProps) => {
  const {
    candidates,
    candidatesByBucket,
    status,
    extractProgress,
    extractedCount,
    failed,
    error,
    fetchSelected,
    retryFailed,
  } = useResearch(topic._id);

  // ---- Local selection state ----
  // A Set of selected URLs, rebuilt from `candidates` by the
  // effect below every time the candidate list changes identity.
  // See the file header for why a URL-keyed Set is the right
  // representation, and why the selection set spans all four
  // sections.
  const [selectedUrls, setSelectedUrls] = useState<Set<string>>(
    new Set<string>()
  );

  // ---- Local per-bucket collapsed state ----
  // All four buckets start expanded (Q8.4 — "Default to expanded
  // after a search"). The record holds a boolean per bucket key,
  // so toggling one section does not affect the others. The
  // state is reset on unmount — see the file header for why that
  // is the correct default.
  const [collapsedByBucket, setCollapsedByBucket] = useState<
    Record<BucketKey, boolean>
  >({
    anytime: false,
    year: false,
    month: false,
    week: false,
  });

  // ---- Auto-select on new candidates ----
  // See the file header's "Auto-select on new candidates" section
  // for the full rationale. The short version: the plan's user
  // journey makes "every candidate checked by default" the correct
  // behaviour, and the effect keyed on `candidates`'s identity
  // produces it without any per-candidate bookkeeping.
  //
  // The hook memoizes the flattened `candidates` array on the
  // per-topic bucket record's identity, so a marker for a
  // different topic does not produce a new flattened array here
  // and does not re-fire this effect.
  useEffect(() => {
    setSelectedUrls(new Set(candidates.map((c) => c.url)));
  }, [candidates]);

  // ---- Derived counts ----
  // Both are O(n) over the flattened candidate list, which is at
  // most a few dozen elements — cheap, and the values are read
  // during render so no memoization is warranted.
  const selectedCount = selectedUrls.size;
  const totalCount = candidates.length;
  const allSelected = totalCount > 0 && selectedCount === totalCount;

  // ---- Toggle one candidate ----
  const handleToggle = useCallback((url: string): void => {
    setSelectedUrls((prev) => {
      const next = new Set(prev);
      if (next.has(url)) {
        next.delete(url);
      } else {
        next.add(url);
      }
      return next;
    });
  }, []);

  // ---- Toggle all ----
  // When every candidate is selected, the control deselects them
  // all. Otherwise it selects them all. This is the standard
  // "one button, two states" pattern for a select-all control.
  const handleToggleAll = useCallback((): void => {
    setSelectedUrls((prev) => {
      if (prev.size === candidates.length) {
        return new Set<string>();
      }
      return new Set(candidates.map((c) => c.url));
    });
  }, [candidates]);

  // ---- Toggle one section ----
  // Flips the collapsed flag for one bucket. The functional
  // updater reads the previous record so the toggle is a pure
  // function of it — a rapid double-click produces two distinct
  // state updates rather than one.
  const handleToggleBucket = useCallback(
    (bucket: BucketKey): void => {
      setCollapsedByBucket((prev) => ({
        ...prev,
        [bucket]: !prev[bucket],
      }));
    },
    []
  );

  // ---- Fetch selected ----
  // Fires the extraction. The `void` discards the returned
  // promise — the store's `status` transitions drive the UI, not
  // this handler's resolution.
  const handleFetch = useCallback((): void => {
    const urls = Array.from(selectedUrls);
    if (urls.length === 0) {
      return;
    }
    void fetchSelected(topic._id, urls);
  }, [fetchSelected, topic._id, selectedUrls]);

  // ---- Retry failed ----
  // Re-runs extraction for the topic's failed URLs only. The
  // store's `retryFailed` action reads the topic's failed list,
  // invokes the extraction flow with only those URLs, and
  // refreshes the failed list from disk afterwards.
  const handleRetryFailed = useCallback((): void => {
    void retryFailed(topic._id);
  }, [retryFailed, topic._id]);

  // ---- Flags ----
  // `isExtracting` gates every interaction while an extraction is
  // in flight. `canFetch` is the "is the action currently
  // meaningful" predicate for the Fetch button. `hasFailures` is
  // what the failed-URL banner is conditioned on.
  const isExtracting = status === 'extracting';
  const canFetch = selectedCount > 0 && !isExtracting;
  const hasFailures = failed.length > 0;

  // ---- Nothing to show ----
  // When the topic has neither candidates nor failed URLs, this
  // component renders nothing. The `SearchProgress` panel above
  // is what the user sees in that state — an empty list under a
  // "ready to search" prompt would be noise.
  //
  // The `hasFailures` half of the condition matters: a topic
  // whose candidates were all cleared by a re-search but whose
  // `failures.json` still has records must still render the
  // failed-URL banner so the user can retry or dismiss them.
  if (totalCount === 0 && !hasFailures) {
    return null;
  }

  return (
    <div className="space-y-3">
      {/* ---- Header row ---- */}
      <div className="flex items-center justify-between gap-3">
        <p
          className={
            'text-sm text-neutral-600 dark:text-neutral-300'
          }
        >
          {totalCount}{' '}
          {totalCount === 1 ? 'candidate' : 'candidates'}
        </p>
        <button
          type="button"
          onClick={handleToggleAll}
          disabled={isExtracting}
          className={
            'inline-flex items-center gap-1.5 rounded-md px-2 ' +
            'py-1 text-xs font-medium text-neutral-600 ' +
            'transition-colors hover:bg-neutral-100 ' +
            'hover:text-primary ' +
            'disabled:cursor-not-allowed disabled:opacity-60 ' +
            'focus-visible:outline-none ' +
            'dark:text-neutral-300 dark:hover:bg-neutral-800 ' +
            'dark:hover:text-primary-light'
          }
        >
          {allSelected ? (
            <>
              <Square size={14} aria-hidden="true" />
              <span>Clear selection</span>
            </>
          ) : (
            <>
              <CheckSquare size={14} aria-hidden="true" />
              <span>Select all</span>
            </>
          )}
        </button>
      </div>

            {/* ---- Failed-URL banner ---- */}
      {/* Shown when the topic's failed-URL list has at least one
          record and no extraction is currently in flight. The
          banner's Retry button re-runs extraction for the failed
          URLs only — see the file header's "failed-URL banner"
          section for the full rationale. Hidden during an
          extraction so the user has exactly one active action
          row at any moment. */}
      {hasFailures && !isExtracting && (
        <div
          role="alert"
          className={
            'flex items-center gap-3 rounded-xl border ' +
            'border-amber-200 bg-amber-50 p-3 ' +
            'dark:border-amber-900 dark:bg-amber-950/60'
          }
        >
          <AlertCircle
            size={16}
            className={
              'shrink-0 text-amber-600 dark:text-amber-400'
            }
            aria-hidden="true"
          />
          <p
            className={
              'min-w-0 flex-1 text-sm text-amber-900 ' +
              'dark:text-amber-100'
            }
          >
            {failed.length}{' '}
            {failed.length === 1 ? 'URL' : 'URLs'} failed to
            extract.
          </p>
          <button
            type="button"
            onClick={handleRetryFailed}
            className={
              'shrink-0 inline-flex items-center gap-1.5 ' +
              'rounded-lg border border-amber-300 bg-transparent ' +
              'px-3 py-1.5 text-xs font-medium text-amber-800 ' +
              'transition-colors hover:bg-amber-100 ' +
              'focus-visible:outline-none ' +
              'dark:border-amber-800 dark:text-amber-200 ' +
              'dark:hover:bg-amber-900/40'
            }
          >
            <RotateCcw size={14} aria-hidden="true" />
            <span>Retry all failed ({failed.length})</span>
          </button>
        </div>
      )}

      {/* ---- Four collapsible sections, one per bucket ---- */}
      {/* See the file header's "four collapsible sections"
          section for the full rationale. The outer wrapper
          carries the scroll constraint so the whole stack of
          sections scrolls as a unit; each section is a card
          whose header is a disclosure button. */}
      <div className="max-h-[36rem] space-y-3 overflow-y-auto pr-1">
        {BUCKET_KEYS.map((bucketKey) => {
          const bucketCandidates = candidatesByBucket[bucketKey];
          const collapsed = collapsedByBucket[bucketKey];
          const Chevron = collapsed ? ChevronRight : ChevronDown;
          const bucketCount = bucketCandidates.length;
          return (
            <section
              key={bucketKey}
              className={
                'overflow-hidden rounded-xl border ' +
                'border-neutral-200 bg-background ' +
                'dark:border-neutral-800'
              }
            >
              {/* ---- Section header (disclosure button) ---- */}
              <button
                type="button"
                onClick={() => handleToggleBucket(bucketKey)}
                aria-expanded={!collapsed}
                className={
                  'flex w-full items-center gap-2 px-3 py-2 ' +
                  'text-left transition-colors ' +
                  'hover:bg-neutral-50 ' +
                  'focus-visible:outline-none ' +
                  'dark:hover:bg-neutral-800/40'
                }
              >
                <Chevron
                  size={16}
                  className={
                    'shrink-0 text-neutral-500 ' +
                    'dark:text-neutral-400'
                  }
                  aria-hidden="true"
                />
                <span
                  className={
                    'min-w-0 flex-1 truncate text-sm ' +
                    'font-medium text-text ' +
                    'dark:text-neutral-100'
                  }
                >
                  {BUCKET_LABELS[bucketKey]}
                </span>
                <span
                  className={
                    'shrink-0 text-xs text-neutral-500 ' +
                    'dark:text-neutral-400'
                  }
                >
                  {bucketCount}{' '}
                  {bucketCount === 1 ? 'candidate' : 'candidates'}
                </span>
              </button>

              {/* ---- Section body ---- */}
              {/* Rendered only when the section is expanded. The
                  list of rows and the empty-state message are
                  mutually exclusive — a bucket with at least one
                  candidate gets rows; an empty bucket gets the
                  message. */}
              {!collapsed && bucketCount > 0 && (
                <div
                  className={
                    'space-y-2 border-t border-neutral-200 p-2 ' +
                    'dark:border-neutral-800'
                  }
                >
                  {bucketCandidates.map((candidate) => (
                    <SourceCandidate
                      key={candidate.url}
                      candidate={candidate}
                      selected={selectedUrls.has(candidate.url)}
                      disabled={isExtracting}
                      onToggle={handleToggle}
                    />
                  ))}
                </div>
              )}

              {!collapsed && bucketCount === 0 && (
                <p
                  className={
                    'border-t border-neutral-200 px-3 py-3 ' +
                    'text-center text-xs text-neutral-500 ' +
                    'dark:border-neutral-800 ' +
                    'dark:text-neutral-400'
                  }
                >
                  No candidates in this time range.
                </p>
              )}
            </section>
          );
        })}
      </div>

      {/* ---- Extraction progress ---- */}
      {/* Shown only while an extraction is in flight. The panel
          takes the place of the footer action row because the
          footer's button has nothing to do while the extraction
          is running. */}
      {isExtracting && (
        <div
          role="status"
          aria-live="polite"
          className={
            'flex items-center gap-3 rounded-xl border ' +
            'border-neutral-200 bg-background p-3 ' +
            'dark:border-neutral-800'
          }
        >
          <Loader2
            size={18}
            className="shrink-0 animate-spin text-primary"
            aria-hidden="true"
          />
          <div className="min-w-0 flex-1">
            <p
              className={
                'text-sm font-medium text-text ' +
                'dark:text-neutral-100'
              }
            >
              {extractProgress
                ? `Extracting ${extractProgress.index} of ` +
                  `${extractProgress.total}…`
                : 'Preparing extraction…'}
            </p>
            {extractProgress && (
              <p
                className={
                  'mt-0.5 truncate text-xs text-neutral-500 ' +
                  'dark:text-neutral-400'
                }
                title={extractProgress.url}
              >
                {extractProgress.url}
              </p>
            )}
          </div>
        </div>
      )}

      {/* ---- Extraction success summary ---- */}
      {/* Shown after extraction completes successfully. The
          `extractedCount > 0` check is what gates it — an
          extraction that ran but saved nothing is not a success
          in the user's mental model, and the store's `status`
          will have flipped to `'error'` in that case. The
          `!isExtracting` guard prevents a stale count from
          displaying during a subsequent extraction. */}
      {!isExtracting && extractedCount > 0 && (
        <div
          className={
            'flex items-start gap-2 rounded-xl border ' +
            'border-emerald-200 bg-emerald-50 p-3 ' +
            'dark:border-emerald-900 dark:bg-emerald-950/60'
          }
        >
          <Download
            size={16}
            className={
              'mt-0.5 shrink-0 text-emerald-600 ' +
              'dark:text-emerald-400'
            }
            aria-hidden="true"
          />
          <div className="min-w-0 flex-1">
            <p
              className={
                'text-sm font-medium text-emerald-900 ' +
                'dark:text-emerald-100'
              }
            >
              {extractedCount}{' '}
              {extractedCount === 1 ? 'document' : 'documents'}{' '}
              saved
            </p>
            <p
              className={
                'mt-0.5 text-xs text-emerald-800/80 ' +
                'dark:text-emerald-200/80'
              }
            >
              Open the Documents tab to review them.
            </p>
          </div>
        </div>
      )}

      {/* ---- Extraction error ---- */}
      {/* A store-level error that arrives during extraction is
          already rendered by the sibling SearchProgress panel —
          see `SearchProgress.tsx`'s ERROR branch. To avoid
          duplicating the message, this component only shows an
          error line when one is present AND the extraction did
          not save anything AND no progress panel is currently
          active. That triple condition is narrower than
          `SearchProgress`'s and does not overlap it in practice. */}
      {!isExtracting &&
        error !== null &&
        extractedCount === 0 && (
          <div
            role="alert"
            className={
              'flex items-start gap-2 rounded-xl border ' +
              'border-red-200 bg-red-50 p-3 ' +
              'dark:border-red-900 dark:bg-red-950/60'
            }
          >
            <AlertCircle
              size={16}
              className={
                'mt-0.5 shrink-0 text-red-600 ' +
                'dark:text-red-400'
              }
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
        )}

      {/* ---- Footer: selection count + fetch action ---- */}
      {/* The footer is the primary action row for the tab. It
          stays hidden during extraction (the progress panel
          above replaces it) and reappears when the operation
          finishes. */}
      {!isExtracting && (
        <div
          className={
            'flex items-center justify-between gap-3 border-t ' +
            'border-neutral-200 pt-3 ' +
            'dark:border-neutral-800'
          }
        >
          <p
            className={
              'text-xs text-neutral-500 dark:text-neutral-400'
            }
          >
            {selectedCount} of {totalCount} selected
          </p>
          <button
            type="button"
            onClick={handleFetch}
            disabled={!canFetch}
            className={
              'inline-flex items-center gap-2 rounded-lg ' +
              'bg-primary px-4 py-2 text-sm font-medium ' +
              'text-white transition-colors ' +
              'hover:bg-primary-dark ' +
              'disabled:cursor-not-allowed disabled:opacity-60 ' +
              'focus-visible:outline-none'
            }
          >
            <Download size={16} aria-hidden="true" />
            <span>Fetch Selected</span>
          </button>
        </div>
      )}
    </div>
  );
};

// ============================================================
//  Default export
// ============================================================

/**
 * The `SourceList` component as the default export.
 * `TopicDetail.tsx` imports it with the default form — see that
 * file's forward reference at Session 7, step 57 — so this is the
 * export that resolves the reference.
 */
export default SourceList;