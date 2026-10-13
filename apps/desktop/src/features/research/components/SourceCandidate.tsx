/**
 * SourceCandidate — one row in the candidate list.
 *
 * Renders a single search result as a selectable list item. Every
 * candidate produced by the search — regardless of engine, platform,
 * or content — has the same four pieces of candidate information
 * the row can show:
 *
 *   url        the source page's absolute URL
 *   title      the page's title, as displayed on the SERP
 *   snippet    a short preview of the page's content
 *   platform   a slug identifying the site — 'reddit', 'quora',
 *              'medium', 'twitter', or 'generic'
 *
 * Plus two pieces of pipeline state the parent supplies:
 *
 *   rangeCount the number of time-range buckets this URL was found
 *              in. A value greater than 1 renders a "found in N
 *              ranges" badge next to the platform badge,
 *              preserving the signal that the URL was deduplicated
 *              from multiple buckets (per the Q8.6 decision).
 *   failure    the URL's last extraction failure record, or null
 *              when the extraction succeeded or has not yet been
 *              attempted. A non-null value switches the row into
 *              its failed visual state — a red border, a
 *              red-tinted background, a reason tooltip on hover,
 *              and a retry icon button in the action group (per
 *              the Q2.2 and Q2.3 decisions).
 *
 * And the row renders those pieces in one consistent layout:
 *
 *   ┌──────────────────────────────────────────────────────────┐
 *   │ ☑  [reddit]  How to garden in a tiny apartment     ↗    │
 *   │              reddit.com/r/gardening/...                  │
 *   │              Living in a rental often means less…        │
 *   └──────────────────────────────────────────────────────────┘
 *
 * ── Fully controlled, no internal state ─────────────────────────
 *
 *   The row owns no state of its own. Its checkbox's checked value
 *   comes from the `selected` prop, and every interaction is
 *   reported back through the props — the parent (`SourceList`)
 *   is what holds the selection set and decides what a click means.
 *
 *   This is the standard controlled-component pattern, and it is
 *   what makes `SourceList`'s auto-select-on-new-search effect
 *   (which rebuilds the whole selection set) work: the parent's
 *   state is the single source of truth, and the rows are pure
 *   renderers of it.
 *
 * ── Click model: row toggles, link opens ────────────────────────
 *
 *   Two clickable affordances in one row, with distinct effects:
 *
 *     1. Clicking anywhere on the row except the title link
 *        toggles the candidate's selection. This is the primary
 *        interaction — the user is triaging a list, and the fastest
 *        way to include or exclude a source is to click the row.
 *
 *     2. Clicking the title link itself opens the URL in the user's
 *        default browser, WITHOUT toggling the selection. The user
 *        is previewing the source before deciding whether to keep
 *        it — a legitimate and common interaction, and toggling
 *        the checkbox as a side effect of previewing would be
 *        surprising.
 *
 *   The distinction is implemented by stopping propagation on the
 *   link's click handler. The link's click bubbles up to the row's
 *   handler by default; the `event.stopPropagation()` call in the
 *   link's handler prevents that, so the row's toggle does not fire
 *   for a click that was meant to open the source.
 *
 *   The link is rendered as a `<button>` (not an `<a href>`) because
 *   the actual navigation goes through `window.electronAPI.utils.openExternal`
 *   — the OS's default browser — not through the Electron window's
 *   own navigation. An `<a href="https://...">` would either try to
 *   navigate the Electron window itself (wrong — the app's window is
 *   the dashboard, not a browser) or require a `target="_blank"`
 *   that Electron does not reliably intercept. The explicit
 *   `openExternal` call is the correct mechanism and works on every
 *   platform.
 *
 * ── The checkbox: a native input, styled ────────────────────────
 *
 *   The checkbox is a real `<input type="checkbox">`, not a
 *   custom-styled `<div>`. This is deliberate: the native input
 *   brings keyboard activation (Space toggles), accessibility
 *   semantics (the browser announces "checked" / "unchecked"), and
 *   focus management for free. A custom-styled div would require
 *   re-implementing all three, and would inevitably get one of them
 *   subtly wrong. The styling sits on top of the native input via
 *   Tailwind's `accent-primary` and standard sizing classes; the
 *   input's semantics are untouched.
 *
 *   The checkbox's `onChange` is wired to the same toggle the row
 *   body uses. A click on the checkbox fires the checkbox's own
 *   handler AND bubbles to the row's handler — but because the
 *   checkbox's handler does not stop propagation, the row's toggle
 *   would fire a second time, producing a net no-op. The fix is the
 *   checkbox's own `event.stopPropagation()` in its handler — the
 *   checkbox handles the toggle, and the row's handler is skipped.
 *
 *   The same reasoning applies to the external-link button, but with
 *   the opposite outcome: the link's handler DOES call
 *   `stopPropagation`, and it does NOT toggle the selection, because
 *   "open this URL" and "select this URL" are different intents.
 *
 * ── Disabled state ──────────────────────────────────────────────
 *
 *   When the `disabled` prop is true (the parent sets it while an
 *   extraction is in flight), every interactive element in the row
 *   is disabled and the row's click handler short-circuits. The
 *   visual treatment is the same `opacity-60` the rest of the app
 *   uses for disabled controls, applied to the whole row, so the
 *   transition into and out of the disabled state reads as a single
 *   unit rather than as several small changes to the checkbox, the
 *   link, and the text.
 * 
 * 
 * ── The failed state ────────────────────────────────────────────
 *
 *   A row whose `failure` prop is non-null renders in the failed
 *   visual state. Three visual changes and one behavioral one:
 *
 *     1. The row's border and background tint switch to red. The
 *        red treatment takes precedence over the selected tint —
 *        a failed candidate can still be selected, but the
 *        failure is the more urgent signal, and the selected
 *        state remains available in the checkbox.
 *
 *     2. The row's `title` attribute (the browser's native
 *        tooltip) carries the failure reason. Hovering the row
 *        surfaces the message without the user having to open a
 *        modal or navigate away. Inner elements with their own
 *        `title` attributes (the candidate title paragraph, the
 *        URL display line, the external-link button) keep their
 *        own tooltips when hovered directly; the failure reason
 *        shows on the row's remaining area.
 *
 *     3. A retry icon button appears in the action group, next to
 *        the external-link button. Clicking it calls the
 *        `onRetry` callback with the candidate's URL. The same
 *        `stopPropagation` pattern the external-link button uses
 *        keeps the row's toggle from firing on a retry click.
 *
 *   The row does NOT block the failed candidate's other
 *   interactions. A user can still toggle its checkbox (a failed
 *   URL that has since been manually re-fetched, or one the user
 *   wants to skip on the next batch), and can still click the
 *   external-link button to look at the source page. The failure
 *   state is a signal, not a lock.
 *
 * ── The multi-range badge ───────────────────────────────────────
 *
 *   A row whose `rangeCount` is greater than 1 renders a small
 *   "N ranges" badge next to the platform badge. The badge
 *   preserves the signal that the URL appeared in multiple
 *   time-range buckets and was deduplicated by the store — see
 *   the Q8.6 decision. A URL found by four buckets is a stronger
 *   source than one found by one, and the badge lets the user see
 *   that without the row appearing four times in the list.
 *
 *   The badge does not appear when `rangeCount` is 1 or less. A
 *   value of 1 is the default — the URL was found by exactly one
 *   bucket — and rendering a "1 range" badge for every row would
 *   be noise.
 *
 * ── What this component does NOT do ────────────────────────────
 *
 *   - It does not hold the selection state. See the "fully
 *     controlled" note above.
 *
 *   - It does not navigate the Electron window. The title link
 *     opens the URL in the user's default browser via the preload's
 *     `utils.openExternal` method. The app's own window is the
 *     dashboard, and it never navigates to external pages.
 *
 *   - It does not fetch or preview the candidate's content. The
 *     "fetch and show the doc file" flow is the Documents feature's
 *     job (Session 12) — this component's link is the escape hatch
 *     for a user who wants to look at the source in a real browser
 *     before deciding whether to include it.
 *
 *   - It does not own the failure state. The parent (`SourceList`)
 *     holds the failed-URL records and decides what a retry click
 *     does — typically a call into the research store's
 *     `retryFailed` action. This component reads the `failure`
 *     prop, renders the failed visual state, and reports the
 *     retry intent through the `onRetry` callback; it never
 *     mutates anything.
 *   - It does not render a favicon, a per-platform icon, or any
 *     image. The platform is surfaced as a text badge in the design
 *     system's neutral palette; a site icon (fetched from a
 *     favicon service, or from a bundled image library) would add
 *     network traffic and an external dependency for a cosmetic
 *     gain. If a future session wants icons, the change is a
 *     `<img src=...>` inserted next to the badge in this file, and
 *     the badge's own rendering is unaffected.
 */

import { useCallback, type MouseEvent } from 'react';
import { ExternalLink, RotateCcw } from 'lucide-react';

import type {
  FailedUrlRecord,
  SearchCandidate,
} from '../store/researchStore.js';

// ============================================================
//  Public types
// ============================================================

/**
 * The props accepted by `SourceCandidate`.
 *
 * The shape is the contract established by `SourceList.tsx`'s
 * `<SourceCandidate ... />` call site — every field named here is
 * passed by that parent, and every field the parent passes is
 * declared here. A change to either side is a compile-time error
 * at the other, which is exactly the coupling the interface is
 * for.
 */
export interface SourceCandidateProps {
  /** The candidate to render. */
  candidate: SearchCandidate;

  /** Whether the row's checkbox is currently checked. */
  selected: boolean;

  /** Whether every interaction in the row is disabled. True
   *  while an extraction is in flight; the parent sets this so
   *  the user cannot change the selection during extraction. */
  disabled: boolean;

  /** Called when the user toggles the row's selection. The
   *  argument is the candidate's URL — the same value the
   *  parent's `Set<string>` uses as a key. Called with the URL
   *  regardless of whether the toggle turns the selection on or
   *  off; the parent interprets the current state from its own
   *  Set. */
  onToggle: (url: string) => void;

  /** The number of time-range buckets this URL was found in. A
   *  value greater than 1 renders the "found in N ranges" badge
   *  next to the platform badge. A value of 1 — the default the
   *  parent supplies when the URL was found by exactly one
   *  bucket — renders no badge. */
  rangeCount: number;

  /** The URL's last extraction failure record, or null when the
   *  extraction succeeded, has not been attempted, or the
   *  failure record is not available. A non-null value switches
   *  the row into its failed visual state — see the file
   *  header's "The failed state" section. */
  failure: FailedUrlRecord | null;

  /** Called when the user clicks the retry icon button on a
   *  failed row. The argument is the candidate's URL — the same
   *  key the parent's failed-URL record uses. The callback is
   *  never invoked on a non-failed row because the retry button
   *  is not rendered. */
  onRetry: (url: string) => void;
}

// ============================================================
//  Platform badge
// ============================================================

/**
 * The per-platform display label for the badge. Falls back to the
 * raw `platform` string when the platform is not one of the known
 * slugs — a value the search might legitimately produce (a future
 * extractor for a site the mapping does not yet know about) would
 * render as the raw slug rather than as an empty string.
 */
const PLATFORM_LABELS: Record<string, string> = {
  reddit: 'Reddit',
  quora: 'Quora',
  medium: 'Medium',
  twitter: 'Twitter',
  generic: 'Web',
};

/**
 * The badge's Tailwind class set, keyed by platform. Each
 * platform gets its own tint so a mixed list is scannable at a
 * glance — a reader who is looking specifically for Reddit
 * threads can find them without reading every row.
 *
 * The fallback (for an unknown platform) is the neutral class
 * set, which is the same treatment `generic` gets. An unknown
 * platform does not deserve its own color — its identity is
 * unclear, and giving it one would imply a classification the
 * codebase has not actually made.
 */
const PLATFORM_CLASSES: Record<string, string> = {
  reddit:
    'bg-orange-100 text-orange-800 ' +
    'dark:bg-orange-950/60 dark:text-orange-200',
  quora:
    'bg-red-100 text-red-800 ' +
    'dark:bg-red-950/60 dark:text-red-200',
  medium:
    'bg-neutral-200 text-neutral-800 ' +
    'dark:bg-neutral-800 dark:text-neutral-200',
  twitter:
    'bg-sky-100 text-sky-800 ' +
    'dark:bg-sky-950/60 dark:text-sky-200',
  generic:
    'bg-neutral-100 text-neutral-700 ' +
    'dark:bg-neutral-800 dark:text-neutral-300',
};

/**
 * The fallback class set for an unknown platform — identical to
 * the `generic` entry above. Kept as a separate constant so a
 * future change to the generic styling does not silently change
 * the unknown-platform styling as a side effect.
 */
const FALLBACK_BADGE_CLASS =
  'bg-neutral-100 text-neutral-700 ' +
  'dark:bg-neutral-800 dark:text-neutral-300';

// ============================================================
//  Helpers
// ============================================================

/**
 * Return a shortened display form of a URL suitable for the
 * row's single-line URL display — the host plus a truncated
 * path.
 *
 * The full URL is available in the `title` attribute on the
 * element that renders this string, so the user can hover to see
 * the entire address. The displayed form is deliberately short:
 * the row is dense, and a full 200-character URL would either
 * wrap to a second line or force the row to scroll horizontally.
 *
 * The function never throws — a malformed URL (which the search
 * service's own normalization should have rejected) falls back to
 * the raw input, so the row still shows something readable.
 */
const shortenUrl = (url: string): string => {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, '');
    const path = parsed.pathname;
    const search = parsed.search;

    // The host by itself, for a bare domain.
    let display = host;

    // A truncated path — the first segment (or two) plus an
    // ellipsis when the path is longer than the budget.
    if (path && path !== '/') {
      const segments = path.split('/').filter((s) => s.length > 0);
      const head = segments.slice(0, 2).join('/');
      display += '/' + head;
      if (segments.length > 2 || head.length < path.length - 1) {
        display += '/…';
      }
    }

    // A query string is not shown at all — it is almost never
    // meaningful to the user deciding whether to extract the
    // page.
    void search;

    return display;
  } catch {
    return url;
  }
};

// ============================================================
//  SourceCandidate
// ============================================================

/**
 * One row in the candidate list. See the file header for the
 * component's responsibilities, its click model, and the reasoning
 * behind the checkbox and link treatments.
 */
export const SourceCandidate = ({
  candidate,
  selected,
  disabled,
  onToggle,
  rangeCount,
  failure,
  onRetry,
}: SourceCandidateProps) => {
  // ---- Toggle the selection ----
  // Called by the row's click handler and by the checkbox's own
  // onChange handler (see the file header for the
  // stopPropagation dance that keeps the two from double-firing).
  const handleToggle = useCallback((): void => {
    if (disabled) return;
    onToggle(candidate.url);
  }, [disabled, onToggle, candidate.url]);

  // ---- Row click ----
  // A click anywhere on the row that was not intercepted by an
  // inner handler toggles the selection. The `disabled` check
  // inside `handleToggle` short-circuits the call when the row
  // is disabled.
  const handleRowClick = useCallback((): void => {
    handleToggle();
  }, [handleToggle]);

  // ---- Checkbox change ----
  // The native input fires `change` when the user activates it
  // (by clicking or by pressing Space while focused). The
  // `stopPropagation` prevents the event from bubbling to the
  // row's click handler, which would toggle the selection a
  // second time and produce a net no-op.
  const handleCheckboxChange = useCallback(
    (event: MouseEvent<HTMLInputElement>): void => {
      event.stopPropagation();
      handleToggle();
    },
    [handleToggle]
  );

  // ---- External link click ----
  // Opens the URL in the user's default browser. The
  // `stopPropagation` prevents the row's click handler from also
  // firing — the user wanted to LOOK at the source, not to
  // select or deselect it.
  const handleLinkClick = useCallback(
    (event: MouseEvent<HTMLButtonElement>): void => {
      event.stopPropagation();
      if (disabled) return;
      void window.electronAPI.utils.openExternal(candidate.url);
    },
    [disabled, candidate.url]
  );

  
  // ---- Retry click ----
  // Opens the retry flow for a failed row. The `stopPropagation`
  // prevents the row's click handler from also firing — the user
  // wanted to RETRY the extraction, not to toggle the row's
  // selection. Same pattern as the external-link button above.
  const handleRetryClick = useCallback(
    (event: MouseEvent<HTMLButtonElement>): void => {
      event.stopPropagation();
      if (disabled) return;
      onRetry(candidate.url);
    },
    [disabled, onRetry, candidate.url]
  );

  // ---- Derived display values ----
  const platformLabel =
    PLATFORM_LABELS[candidate.platform] ?? candidate.platform;
  const platformClass =
    PLATFORM_CLASSES[candidate.platform] ?? FALLBACK_BADGE_CLASS;
  const displayUrl = shortenUrl(candidate.url);

  // Whether the row renders in its failed visual state. See the
  // file header's "The failed state" section for the full set of
  // effects this flag drives.
  const isFailed = failure !== null;

  // Whether the row renders its multi-range badge. A `rangeCount`
  // of 1 (or less, which cannot occur but is defended against
  // here) is the default state and renders no badge. See the file
  // header's "The multi-range badge" section.
  const showRangeBadge = rangeCount > 1;

  // The row's native tooltip. When the row is failed, the
  // tooltip carries the failure reason so a user who wonders why
  // the row is red can read the message without opening a modal.
  // A non-failed row has no tooltip at this level — the inner
  // elements' own `title` attributes serve their own purposes.
  const rowTitle = isFailed
    ? `Extraction failed: ${failure.reason}`
    : undefined;

  return (
    <div
      role="checkbox"
      aria-checked={selected}
      aria-disabled={disabled}
      tabIndex={disabled ? -1 : 0}
      onClick={handleRowClick}
      title={rowTitle}
      className={
        'flex cursor-pointer gap-3 rounded-xl border p-3 ' +
        'transition-colors ' +
        (disabled
          ? 'cursor-not-allowed opacity-60 '
          : '') +
        (isFailed
          ? 'border-red-300 bg-red-50 ' +
            'dark:border-red-900 dark:bg-red-950/40 '
          : selected
            ? 'border-primary bg-primary/5 ' +
              'dark:border-primary-light dark:bg-primary-light/5 '
            : 'border-neutral-200 bg-background ' +
              'hover:border-neutral-300 hover:bg-neutral-50 ' +
              'dark:border-neutral-800 ' +
              'dark:hover:border-neutral-700 ' +
              'dark:hover:bg-neutral-800/40')
      }
    >
      {/* ---- Checkbox ---- */}
      {/* Wrapped in a small flex container so the checkbox sits on
          the first text line rather than being vertically centred
          against a multi-line content block — the standard list-
          item convention (the control aligns with the first line
          of text, not with the row's middle). */}
      <div className="flex shrink-0 items-start pt-0.5">
        <input
          type="checkbox"
          checked={selected}
          onChange={() => {
            /* The `onChange` is required for the controlled input
             *  to update its checked state, but the actual toggle
             *  logic lives in the click handler — see the file
             *  header. The empty callback here is intentional; the
             *  real work is done by the sibling `onClick` and the
             *  row's `onClick`, both of which are wired to
             *  `handleToggle`. */
          }}
          onClick={handleCheckboxChange}
          disabled={disabled}
          className={
            'h-4 w-4 cursor-pointer rounded border-neutral-300 ' +
            'text-primary accent-primary ' +
            'disabled:cursor-not-allowed ' +
            'focus-visible:outline-none ' +
            'dark:border-neutral-600 dark:bg-neutral-950'
          }
          aria-hidden="true"
        />
      </div>

      {/* ---- Content ---- */}
      <div className="min-w-0 flex-1">
        {/* Title + platform badge + range badge + action buttons */}
        <div className="flex items-start gap-2">
          <span
            className={
              'shrink-0 rounded-full px-2 py-0.5 text-[10px] ' +
              'font-medium uppercase tracking-wide ' +
              platformClass
            }
          >
            {platformLabel}
          </span>
          {showRangeBadge && (
            <span
              className={
                'shrink-0 rounded-full bg-primary/10 ' +
                'px-2 py-0.5 text-[10px] font-medium ' +
                'uppercase tracking-wide text-primary-dark ' +
                'dark:bg-primary-light/20 ' +
                'dark:text-primary-light'
              }
              title={`Found in ${rangeCount} time ranges`}
            >
              {rangeCount} ranges
            </span>
          )}
          <p
            className={
              'line-clamp-2 min-w-0 flex-1 text-sm font-medium ' +
              'text-text dark:text-neutral-100'
            }
            title={candidate.title}
          >
            {candidate.title}
          </p>
          {isFailed && (
            <button
              type="button"
              onClick={handleRetryClick}
              disabled={disabled}
              aria-label="Retry extraction"
              title={`Retry extraction (${failure.reason})`}
              className={
                'shrink-0 rounded-md p-1 text-red-600 ' +
                'transition-colors ' +
                'hover:bg-red-100 hover:text-red-800 ' +
                'disabled:cursor-not-allowed ' +
                'focus-visible:outline-none ' +
                'dark:text-red-400 ' +
                'dark:hover:bg-red-950/60 ' +
                'dark:hover:text-red-200'
              }
            >
              <RotateCcw size={14} aria-hidden="true" />
            </button>
          )}
          <button
            type="button"
            onClick={handleLinkClick}
            disabled={disabled}
            aria-label="Open source in browser"
            title="Open source in browser"
            className={
              'shrink-0 rounded-md p-1 text-neutral-400 ' +
              'transition-colors ' +
              'hover:bg-neutral-100 hover:text-primary ' +
              'disabled:cursor-not-allowed ' +
              'focus-visible:outline-none ' +
              'dark:hover:bg-neutral-800 ' +
              'dark:hover:text-primary-light'
            }
          >
            <ExternalLink size={14} aria-hidden="true" />
          </button>
        </div>

        {/* URL display */}
        <p
          className={
            'mt-0.5 truncate text-xs text-neutral-500 ' +
            'dark:text-neutral-400'
          }
          title={candidate.url}
        >
          {displayUrl}
        </p>

        {/* Snippet */}
        {candidate.snippet.length > 0 && (
          <p
            className={
              'mt-1 line-clamp-2 text-xs leading-snug ' +
              'text-neutral-600 dark:text-neutral-300'
            }
          >
            {candidate.snippet}
          </p>
        )}
      </div>
    </div>
  );
};

// ============================================================
//  Default export
// ============================================================

/**
 * The `SourceCandidate` component as the default export.
 * `SourceList.tsx` imports it with the default form
 * (`import SourceCandidate from './SourceCandidate.js'`), so
 * this is the export that resolves that file's forward
 * reference.
 */
export default SourceCandidate;