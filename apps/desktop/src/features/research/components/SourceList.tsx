/**
 * SourceList — the checkbox list of candidate sources.
 *
 * Renders one `SourceCandidate` row per candidate the search
 * produced, plus the three controls that drive the Sources tab's
 * extraction stage:
 *
 *   • A header row with the total candidate count and a
 *     "Select all" / "Clear selection" toggle.
 *   • The scrolling list of `SourceCandidate` rows themselves.
 *   • A footer with the selected count and a "Fetch Selected"
 *     button.
 *
 * During extraction the footer swaps to a live progress panel —
 * "Extracting 3 of 10 · <current URL>" — driven by the store's
 * `extractProgress` field. On completion the footer becomes a
 * short green summary ("N documents saved") with a hint that
 * moves the user toward the Documents tab.
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
 *   `candidates`. Whenever the candidates array changes identity
 *   — a search that just completed, a "Search again" that cleared
 *   the list, a page refresh that reset the store — the selection
 *   set is rebuilt to contain every current candidate URL. A user
 *   who unchecks some candidates and then runs another search
 *   gets the new search's fresh selections; their old manual
 *   choices do not persist across searches, which is the correct
 *   behaviour — the two candidate lists are different populations.
 *
 *   The candidates array's identity is what the effect keys on,
 *   not its length. The store sets `candidates` to a new array
 *   reference on every change (the `_handleMarker` handler
 *   assigns the parsed payload's array directly, and `startSearch`
 *   assigns a fresh `[]`), so an identity check is equivalent to
 *   a content check for the operations that matter.
 *
 * ── Why selection is a Set<string> keyed by URL ─────────────────
 *
 *   The candidates' identity is their URL. Two candidates with
 *   the same URL from different search pages are the same source;
 *   the store deduplicates them before they reach this component,
 *   so the URL is unique across the list. A `Set<string>` of URLs
 *   gives O(1) membership tests for the per-row "is this one
 *   checked" question, and O(1) toggles.
 *
 *   The alternative — a `Set<number>` of candidate indices — would
 *   require the effect to recompute the index of every candidate
 *   on every list mutation, and would produce bugs whenever the
 *   list was re-sorted. URLs are the stable identity.
 *
 * ── The "Fetch Selected" call ───────────────────────────────────
 *
 *   Calls the hook's `fetchSelected(topic._id, urls)` with the
 *   selected URLs as a `string[]` (converted from the Set via
 *   `Array.from`). The store's `runExtraction` action flips
 *   `status` to `'extracting'`, kicks off the IPC call to the
 *   main process, and updates state as `EXTRACT_PROGRESS` /
 *   `EXTRACT_DONE` markers arrive. This component does not await
 *   the returned promise — the store's state transitions are what
 *   re-render the panel into the progress view.
 *
 *   The order in which `Array.from(selectedUrls)` returns the
 *   URLs is the insertion order of the Set. Because the set is
 *   rebuilt from scratch in the auto-select effect (iterating
 *   `candidates` in order), the insertion order matches the
 *   candidate list order. The extraction therefore processes the
 *   URLs in the same order the user saw them, which is what makes
 *   the "Extracting 3 of 10" progress indicator correspond to
 *   what the user is looking at.
 *
 * ── Why this component is not the source of the `topic` prop ────
 *
 *   The `topic` prop is passed down from `TopicDetail.tsx` through
 *   `SourcesTab` (the internal composition inside `TopicDetail`).
 *   The `SourceList` component needs the topic's `_id` because
 *   `fetchSelected` takes it as its first argument — the topic ID
 *   is what names the extraction's output folder on disk and what
 *   routes the extraction markers back to this component's store
 *   subscription.
 *
 * ── What this component does NOT do ────────────────────────────
 *
 *   - It does not render the individual candidate rows. That is
 *     `SourceCandidate`'s job (a forward-referenced component —
 *     see the imports). This component owns the list container,
 *     the selection state, and the actions; the row is a leaf
 *     that receives `{ candidate, selected, disabled, onToggle }`
 *     and renders one item's UI.
 *
 *   - It does not manage the search itself. That is
 *     `SearchProgress`'s job — the sibling component rendered
 *     above this list in the Sources tab. `SourceList` renders
 *     nothing until `candidates.length > 0`, at which point the
 *     search is already done and the list is what the user is
 *     looking at.
 *
 *   - It does not persist the selection. The selected URLs are
 *     component-local state that lives for the lifetime of this
 *     component's mount. Navigating away from the Sources tab
 *     (to the Documents tab, or back to the Topics list) unmounts
 *     the component and loses the selection. That is the intended
 *     behaviour — a selection made against one version of the
 *     candidate list should not survive a re-search that produced
 *     a different list.
 *
 *   - It does not clear the candidates after a successful
 *     extraction. The store's `candidates` array persists until
 *     the next search or an explicit `clearCandidates()` call.
 *     Keeping the list visible after extraction lets the user
 *     review what they extracted from, which matches the plan's
 *     user journey ("A summary line reads… The user can now click
 *     any doc to preview it").
 */

import {
  useCallback,
  useEffect,
  useState,
} from 'react';
import {
  AlertCircle,
  CheckSquare,
  Download,
  Loader2,
  Square,
} from 'lucide-react';

import { useResearch } from '../hooks/useResearch.js';
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
    status,
    extractProgress,
    extractedCount,
    error,
    fetchSelected,
  } = useResearch();

  // ---- Local selection state ----
  // A Set of selected URLs, rebuilt from `candidates` by the
  // effect below every time the candidate list changes identity.
  // See the file header for why a URL-keyed Set is the right
  // representation.
  const [selectedUrls, setSelectedUrls] = useState<Set<string>>(
    new Set<string>()
  );

  // ---- Auto-select on new candidates ----
  // See the file header's "Auto-select on new candidates" section
  // for the full rationale. The short version: the plan's user
  // journey makes "every candidate checked by default" the correct
  // behaviour, and the effect keyed on `candidates`'s identity
  // produces it without any per-candidate bookkeeping.
  useEffect(() => {
    setSelectedUrls(new Set(candidates.map((c) => c.url)));
  }, [candidates]);

  // ---- Derived counts ----
  // `useMemo` so the counts are recomputed only when the
  // underlying sets change. Both are O(n) over the candidate list,
  // which is at most a few dozen elements — cheap, but avoiding
  // the recomputation on unrelated re-renders is the correct
  // hygiene.
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

  // ---- Flags ----
  // `isExtracting` gates every interaction while an extraction is
  // in flight. `canFetch` is the "is the action currently
  // meaningful" predicate for the Fetch button.
  const isExtracting = status === 'extracting';
  const canFetch = selectedCount > 0 && !isExtracting;

  // ---- Nothing to show ----
  // When the search has not produced any candidates yet, this
  // component renders nothing. The `SearchProgress` panel above
  // is what the user sees in that state — an empty list under a
  // "ready to search" prompt would be noise.
  if (totalCount === 0) {
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

      {/* ---- Candidate list ---- */}
      {/* `space-y-2` gives each row breathing room; the container
          caps its own height so a very long list scrolls rather
          than pushing the footer below the fold. The `pr-1` on
          the scroll container leaves a sliver of space for the
          scrollbar so it does not overlap the row content. */}
      <div
        className={
          'max-h-[28rem] space-y-2 overflow-y-auto pr-1'
        }
      >
        {candidates.map((candidate) => (
          <SourceCandidate
            key={candidate.url}
            candidate={candidate}
            selected={selectedUrls.has(candidate.url)}
            disabled={isExtracting}
            onToggle={handleToggle}
          />
        ))}
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