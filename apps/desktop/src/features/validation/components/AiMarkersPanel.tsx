/**
 * AiMarkersPanel — the AI-marker section of the Report tab.
 *
 * Renders the aggregate marker count the Python side's
 * `validation/ai_markers.py` produces, plus the list of specific
 * phrases that appeared above their per-phrase threshold. The
 * list is what makes the count actionable: a user who sees "11
 * markers found" needs to know which phrases to rewrite, not just
 * that the total is high.
 *
 * The panel is a pure renderer: it reads everything it needs from
 * the `section` prop that `ValidationReport.tsx` passes it and
 * holds no state, calls no hooks, and reaches no store. The same
 * pattern applies to all six sibling panels.
 *
 * ── The two pieces of information ──────────────────────────────
 *
 *   Marker Count     The total number of AI-tell phrase
 *                    occurrences across the whole article. The
 *                    Python side counts every occurrence of every
 *                    phrase in its curated list, so a phrase that
 *                    appears twice contributes 2 to the total and
 *                    appears once in the list below with
 *                    `count: 2`.
 *
 *   Markers List     One entry per phrase that appeared at least
 *                    once, ordered by descending count (the most
 *                    overused phrases first). Each entry has the
 *                    phrase text and how many times it occurred.
 *
 *   A phrase that never appeared in the article does not get an
 *   entry — the Python side's builder only includes entries with
 *   `count > 0`. An empty list is therefore a fully-successful
 *   result: the article uses none of the flagged phrases.
 *
 * ── The status badge ───────────────────────────────────────────
 *
 *   Same three-color scheme as the sibling panels and the
 *   `ValidationReport` header's banner: green for good, amber for
 *   warning, red for fail.
 *
 * ── Layout ─────────────────────────────────────────────────────
 *
 *   Same bordered-card structure as the other panels: a header
 *   row (title + status badge) followed by the aggregate count
 *   metric and, when the list is non-empty, the phrase chips. An
 *   empty list shows a short confirmation line in the same place
 *   a non-empty list would show the chips — the user reads
 *   either "no AI-tell phrases found" (the success state) or the
 *   specific phrases to rewrite (the flagged state), with no
 *   ambiguity about which state the panel is in.
 *
 *   Each phrase is rendered as a small pill: the phrase text in
 *   monospace with a small count badge. The pill's left edge is
 *   amber-tinted to match the panel's warning semantic — AI
 *   markers are a "review this" signal, not a "this is broken"
 *   signal — while still reading as a distinct element from the
 *   plain-text body of the panel.
 *
 * ── What this panel does NOT do ────────────────────────────────
 *
 *   - It does not offer a "replace all" action. The plan's user
 *     journey describes the corrective loop as a future feature
 *     that feeds the specific failures back to the writer as a
 *     follow-up prompt; the panel's role is to display, not to
 *     act. A future session that added the corrective loop's
 *     wiring would provide the actionable control from the
 *     `ValidationReport` header (where the "Re-validate" button
 *     already lives) rather than from this panel.
 *
 *   - It does not distinguish "the phrase was flagged because it
 *     appeared in a paragraph that also discussed its use" from
 *     "the phrase was flagged because it genuinely appears in the
 *     article's prose". The Python side's detection is a plain
 *     count of occurrences of each phrase in the article's
 *     stripped text; it does not attempt to detect meta-mentions
 *     (an article about AI writing that discusses "moreover"
 *     would flag "moreover"). A future session that wanted to
 *     suppress meta-mentions would extend the Python side's
 *     detection rules.
 *
 *   - It does not link a phrase to its position in the article.
 *     The `AiMarkerEntry` type carries only the phrase text and
 *     the count — no offsets. A future session that wanted
 *     in-article highlighting would add an offsets array to the
 *     shared type and populate it from the Python side; this
 *     panel would then render each pill as an anchor that scrolls
 *     the Article tab to the first occurrence.
 *
 * Dependencies: lucide-react + the shared types.
 */

import {
  AlertTriangle,
  CheckCircle2,
  XCircle,
} from 'lucide-react';

import type {
  AiMarkersReport,
  ReportStatus,
} from '../../shared/types/index.js';

// ============================================================
//  Public types
// ============================================================

/**
 * The props accepted by `AiMarkersPanel`.
 *
 * The component takes a single `section` prop — the AI-markers
 * section from the report. The parent (`ValidationReport.tsx`)
 * passes `report.aiMarkers` directly, so the prop is typed as
 * the section type from the shared `Report` interface.
 */
export interface AiMarkersPanelProps {
  /** The AI-markers section of the report. */
  section: AiMarkersReport;
}

// ============================================================
//  Internal — status badge
// ============================================================
//
//  Same three-color scheme as the sibling panels. See
//  `ReadabilityPanel.tsx`'s `StatusBadge` for the design
//  rationale on the icon and label choices.

interface StatusBadgeProps {
  status: ReportStatus;
}

const StatusBadge = ({ status }: StatusBadgeProps) => {
  if (status === 'good') {
    return (
      <span
        className={
          'inline-flex shrink-0 items-center gap-1 rounded-full ' +
          'bg-emerald-100 px-2 py-0.5 text-xs font-medium ' +
          'text-emerald-800 dark:bg-emerald-950 ' +
          'dark:text-emerald-200'
        }
      >
        <CheckCircle2 size={12} aria-hidden="true" />
        <span>Good</span>
      </span>
    );
  }
  if (status === 'warning') {
    return (
      <span
        className={
          'inline-flex shrink-0 items-center gap-1 rounded-full ' +
          'bg-amber-100 px-2 py-0.5 text-xs font-medium ' +
          'text-amber-800 dark:bg-amber-950 ' +
          'dark:text-amber-200'
        }
      >
        <AlertTriangle size={12} aria-hidden="true" />
        <span>Warning</span>
      </span>
    );
  }
  return (
    <span
      className={
        'inline-flex shrink-0 items-center gap-1 rounded-full ' +
        'bg-red-100 px-2 py-0.5 text-xs font-medium ' +
        'text-red-800 dark:bg-red-950 ' +
        'dark:text-red-200'
      }
    >
      <XCircle size={12} aria-hidden="true" />
      <span>Fail</span>
    </span>
  );
};

// ============================================================
//  Internal — metric row
// ============================================================

interface MetricRowProps {
  label: string;
  value: string;
  hint: string;
}

const MetricRow = ({ label, value, hint }: MetricRowProps) => (
  <div className="flex items-baseline justify-between gap-4 py-2">
    <div className="min-w-0 flex-1">
      <p
        className={
          'text-sm font-medium text-text dark:text-neutral-100'
        }
      >
        {label}
      </p>
      <p
        className={
          'mt-0.5 text-xs text-neutral-500 ' +
          'dark:text-neutral-400'
        }
      >
        {hint}
      </p>
    </div>
    <p
      className={
        'shrink-0 text-sm font-semibold tabular-nums ' +
        'text-text dark:text-neutral-100'
      }
    >
      {value}
    </p>
  </div>
);

// ============================================================
//  Internal — phrase pill
// ============================================================

interface PhrasePillProps {
  phrase: string;
  count: number;
}

const PhrasePill = ({ phrase, count }: PhrasePillProps) => (
  <span
    className={
      'inline-flex items-center gap-2 rounded-lg border ' +
      'border-amber-200 bg-amber-50 px-2.5 py-1 ' +
      'dark:border-amber-900 dark:bg-amber-950/40'
    }
  >
    <span
      className={
        'font-mono text-xs text-amber-900 dark:text-amber-100'
      }
    >
      {phrase}
    </span>
    <span
      className={
        'shrink-0 rounded-full bg-amber-200 px-1.5 py-0.5 ' +
        'text-[10px] font-semibold tabular-nums ' +
        'text-amber-900 dark:bg-amber-900 ' +
        'dark:text-amber-100'
      }
    >
      ×{count}
    </span>
  </span>
);

// ============================================================
//  AiMarkersPanel
// ============================================================

/**
 * The AI-marker section panel. See the file header for the
 * panel's responsibilities, its two pieces of information, and
 * the reasoning behind the phrase-pill layout.
 */
export const AiMarkersPanel = ({ section }: AiMarkersPanelProps) => {
  const markers = section.markers;
  const hasMarkers = markers.length > 0;

  return (
    <section className="rounded-xl border border-neutral-200 bg-background dark:border-neutral-800">
      {/* ---- Header ---- */}
      <header
        className={
          'flex items-center justify-between gap-3 ' +
          'border-b border-neutral-200 px-4 py-3 ' +
          'dark:border-neutral-800'
        }
      >
        <h3
          className={
            'text-sm font-semibold text-text ' +
            'dark:text-neutral-100'
          }
        >
          AI Marker Check
        </h3>
        <StatusBadge status={section.status} />
      </header>

      {/* ---- Aggregate metric ---- */}
      <div className="divide-y divide-neutral-100 px-4 dark:divide-neutral-800/60">
        <MetricRow
          label="AI-tell Phrases Found"
          value={section.markerCount.toLocaleString()}
          hint="Total occurrences across all phrases. Target: 10 or fewer."
        />
      </div>

      {/* ---- Phrase list ---- */}
      {/* Shown only when at least one phrase appeared. An empty
          list is the section's success state — a short
          confirmation line replaces the pills. */}
      {hasMarkers ? (
        <div className="space-y-2 border-t border-neutral-200 px-4 py-4 dark:border-neutral-800">
          <p
            className={
              'text-xs font-medium uppercase tracking-wide ' +
              'text-neutral-500 dark:text-neutral-400'
            }
          >
            Phrases to rewrite
          </p>
          <div className="flex flex-wrap gap-2">
            {markers.map((entry) => (
              <PhrasePill
                key={entry.phrase}
                phrase={entry.phrase}
                count={entry.count}
              />
            ))}
          </div>
        </div>
      ) : (
        <div
          className={
            'border-t border-neutral-200 px-4 py-4 ' +
            'dark:border-neutral-800'
          }
        >
          <p
            className={
              'text-sm text-neutral-600 ' +
              'dark:text-neutral-300'
            }
          >
            No AI-tell phrases were found. The article's prose
            reads as human-written.
          </p>
        </div>
      )}
    </section>
  );
};

// ============================================================
//  Default export
// ============================================================

/**
 * The `AiMarkersPanel` component as the default export.
 * `ValidationReport.tsx` imports it with the default form
 * (`import AiMarkersPanel from './AiMarkersPanel.js'`), so this
 * is the export that resolves that file's forward reference.
 */
export default AiMarkersPanel;