/**
 * SearchProgress — the live search panel for the Sources tab.
 *
 * Renders one of four visual states, driven by the research
 * store's `status` field and by whether the candidate list is
 * populated:
 *
 *   1. IDLE (no candidates, no error)
 *      A short invitation with a "Start Search" button. The
 *      button calls `runSearch(topic._id, topic.title,
 *      topic.keywords)` and, on success, the store's marker
 *      handler populates the candidate list — at which point the
 *      component re-renders into the completed state.
 *
 *   2. SEARCHING (status === 'searching')
 *      A spinner with a live progress line — "page N of M,
 *      X candidates found" — updated by the `SEARCH_PROGRESS`
 *      markers the main process emits. A "Cancel" button lets
 *      the user abort; it calls the hook's `cancel` action which
 *      hard-kills the Python child (see `researchIPC.ts` for the
 *      graceful-vs-hard distinction).
 *
 *   3. ERROR (status === 'error')
 *      A red banner with the store's error message and two
 *      buttons: "Retry" (re-runs `runSearch`) and "Dismiss"
 *      (clears the error without retrying).
 *
 *   4. COMPLETE (candidates populated, status back to 'idle')
 *      A green summary line — "N candidates found" — with a
 *      "Search again" button. The candidate list itself is
 *      rendered below this panel by the sibling `SourceList`
 *      component; this panel only reports the count.
 *
 * ── Why this panel is separate from SourceList ──────────────────
 *
 *   The plan's Part 1.9 file tree declares them as separate
 *   components, and the Sources tab renders them stacked (see
 *   `TopicDetail.tsx`). The split is deliberate: `SearchProgress`
 *   owns the ACTION (start a search, cancel it, retry it) and the
 *   live state that belongs to the search itself; `SourceList`
 *   owns the SELECTION UI (checkbox list, "Fetch Selected"
 *   button) once candidates exist. A user who is looking at the
 *   candidate list is past the "start a search" decision, and the
 *   two concerns do not belong in one component.
 *
 * ── Why the runSearch call takes `topic.keywords` ───────────────
 *
 *   The `useResearch().runSearch(topicId, title, keywords?)`
 *   signature takes the topic's keyword array as its third
 *   argument. The Python search script carries the keywords in
 *   its marker payload for the renderer's display but does not
 *   use them to construct the search — the search runs on the
 *   title alone, per the plan's user journey. Passing the
 *   keywords through is what lets the store's candidate payload
 *   carry them; a caller that omitted the keywords would still
 *   get a working search, but the SEARCH_RESULT marker's payload
 *   would lack the `keywords` field and the renderer's metadata
 *   row would show an empty keyword count for the operation.
 *
 * ── Why the component is NOT responsible for its own guard ──────
 *
 *   The Sources tab is only ever mounted inside the topic-detail
 *   page, which the layout's auth gate has already verified. The
 *   component therefore does not check "am I authenticated?" and
 *   does not check "does the topic exist?" — both are guaranteed
 *   by its mount site. The `topic` prop it receives is a
 *   populated `Topic` object from `activeTopic`; a future change
 *   that wanted to render the panel outside the detail page would
 *   need to add those guards.

 * ── What this component does NOT do ────────────────────────────
 *
 *   - It does not render the candidate list. That is
 *     `SourceList`'s job — see the sibling file.
 *
 *   - It does not persist the search results. The backend's
 *     `/api/topics` endpoint is the authoritative record of the
 *     topic's keywords and settings; the candidate list is
 *     transient UI state until the user selects which URLs to
 *     extract (at which point the extraction service turns each
 *     into a Document record on the backend).
 *
 *   - It does not auto-start the search on mount. The user
 *     clicks "Start Search" — the plan's user journey makes the
 *     search a deliberate action, not something that fires the
 *     moment a page opens.
 *
 *   - It does not detect the captcha modal. When the Python script
 *     hits a captcha, the main process emits a `CAPTCHA_REQUIRED`
 *     marker and the automation store opens the modal (Session
 *     20). This component keeps showing the "searching" spinner
 *     underneath — the modal is on top, and dismissing it either
 *     resumes or aborts the search, at which point this panel's
 *     state catches up via the store.
 */

import { useCallback } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  Search,
} from 'lucide-react';

import { useResearch } from '../hooks/useResearch.js';
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
//  SearchProgress
// ============================================================

/**
 * The search panel. See the file header for the four states and
 * the reasoning behind the component's scope.
 */
export const SearchProgress = ({ topic }: SearchProgressProps) => {
  const {
    candidates,
    status,
    searchProgress,
    error,
    runSearch,
    cancel,
    clearError,
  } = useResearch();

  // ---- Start / retry ----
  // The same handler serves both the idle-state "Start Search"
  // button and the error-state "Retry" button — the underlying
  // operation is identical. The `useCallback` dependency on
  // `topic._id`, `topic.title`, and `topic.keywords` gives the
  // handler a stable identity as long as the topic does not
  // change; a component that lists this handler in a `useEffect`
  // dependency array (a future "auto-retry on network recovery"
  // feature) would not re-run the effect on every render.
  //
  // `topic.keywords` is a `readonly string[]` on the type, but
  // `runSearch` accepts a mutable `string[]`. The spread `[...]`
  // produces a mutable copy, which is what the hook expects;
  // passing the readonly array directly would be a type error
  // under `exactOptionalPropertyTypes`' strict readonly handling.
  const handleStart = useCallback((): void => {
    void runSearch(topic._id, topic.title, [...topic.keywords]);
  }, [runSearch, topic._id, topic.title, topic.keywords]);

  // ---- Cancel ----
  const handleCancel = useCallback((): void => {
    void cancel(topic._id);
  }, [cancel, topic._id]);

  // ---- Dismiss error ----
  const handleDismiss = useCallback((): void => {
    clearError();
  }, [clearError]);

  // ---- State 1: SEARCHING ----
  // The live progress panel. Shown while `status === 'searching'`
  // regardless of how many candidates have been collected so far —
  // the whole point is that the user can see partial progress as
  // it happens.
  if (status === 'searching') {
    const progressText = searchProgress
      ? `Page ${searchProgress.page} · ${searchProgress.found} candidates found`
      : 'Starting search…';

    return (
      <div
        role="status"
        aria-live="polite"
        className={
          'flex items-center gap-3 rounded-xl border ' +
          'border-neutral-200 bg-background p-4 ' +
          'dark:border-neutral-800'
        }
      >
        <Loader2
          size={20}
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
            Searching the web…
          </p>
          <p
            className={
              'mt-0.5 text-xs text-neutral-500 ' +
              'dark:text-neutral-400'
            }
          >
            {progressText}
          </p>
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