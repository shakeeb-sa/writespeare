/**
 * ReadabilityPanel — the readability section of the Report tab.
 *
 * Renders the six metrics the Python side's
 * `validation/readability.py` produces, plus a status badge
 * carrying the section's good / warning / fail classification.
 *
 * The panel is a pure renderer: it reads everything it needs from
 * the `section` prop that `ValidationReport.tsx` passes it and
 * holds no state, calls no hooks, and reaches no store. The same
 * pattern applies to all six sibling panels.
 *
 * ── The six metrics ────────────────────────────────────────────
 *
 *   Flesch Reading Ease      0–100, higher is easier to read.
 *                            Plain-English target: 60–70.
 *
 *   Flesch-Kincaid Grade     Approximate US school grade level.
 *                            The plan's user journey targets 7–9.
 *
 *   Gunning Fog              Another grade-level index. Lower is
 *                            easier. Target under 12.
 *
 *   SMOG Index               Grade-level index. Target under 12.
 *
 *   Avg Sentence Length      Words per sentence. Fifteen to
 *                            twenty is a comfortable range for
 *                            English prose.
 *
 *   Reading Time             Estimated seconds at 250 words per
 *                            minute. Formatted here as "M min S
 *                            sec" for readability.
 *
 *   Each metric is rendered as a labeled row: the metric's name
 *   on the left, its value on the right, and — where the metric
 *   has a known "good" band — a small muted hint of the target
 *   range beneath the label.
 *
 * ── The status badge ───────────────────────────────────────────
 *
 *   The section's `status` field is one of the three values the
 *   shared `ReportStatus` union declares. The badge uses the same
 *   color and icon vocabulary as the sibling panels and the
 *   `ValidationReport` header's banner, so a user scanning the
 *   six panels for their statuses sees a consistent visual
 *   signal across all seven.
 *
 * ── Layout ─────────────────────────────────────────────────────
 *
 *   The panel is a bordered card with a header row (icon, title,
 *   status badge) and a body of metric rows separated by thin
 *   dividers. The whole card is styled the same as every other
 *   section panel; the shared visual treatment is what makes the
 *   six panels read as one report rather than as six unrelated
 *   widgets stacked vertically.
 *
 * ── What this panel does NOT do ────────────────────────────────
 *
 *   - It does not compute anything. Every number comes from the
 *     Python-side validator that produced the report. The panel
 *     formats them for display; it does not re-derive them.
 *
 *   - It does not distinguish "the metric was computed" from
 *     "the metric was zero because the article was empty" — the
 *     validator reports zero for both, and the report does not
 *     carry a separate "why" field. A future session that wanted
 *     that distinction would add a `note` field to the
 *     `ReadabilityReport` type and populate it from the Python
 *     side.
 *
 *   - It does not offer any interactive affordance. The metrics
 *     are informational. An article with a readability issue is
 *     fixed in the writer's edit flow (the Article tab's
 *     `ArticlePreview` component's Edit mode), not from this
 *     panel.
 *
 * Dependencies: react (no hooks used, but the JSX transform pulls
 * the runtime in) + lucide-react + the shared types.
 */

import {
  AlertTriangle,
  CheckCircle2,
  XCircle,
} from 'lucide-react';

import type {
  ReadabilityReport,
  ReportStatus,
} from '../../shared/types/index.js';

// ============================================================
//  Public types
// ============================================================

/**
 * The props accepted by `ReadabilityPanel`.
 *
 * The component takes a single `section` prop — the readability
 * section from the report. The parent (`ValidationReport.tsx`)
 * passes `report.readability` directly, so the prop is typed
 * as the section type from the shared `Report` interface.
 */
export interface ReadabilityPanelProps {
  /** The readability section of the report. */
  section: ReadabilityReport;
}

// ============================================================
//  Internal — status badge
// ============================================================
//
//  Same three-color scheme as the header banner in
//  `ValidationReport.tsx`: green for good, amber for warning, red
//  for fail. The label text matches the icon's semantic meaning
//  rather than the raw enum value, so a user who has never seen
//  the report's internal vocabulary still reads the badge
//  correctly.

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
//
//  One labeled metric. The `hint` prop carries the target range
//  or the interpretation guide the user reads to know whether the
//  number is good, since the raw values (a Flesch score, a grade
//  level) are not self-explanatory.

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
//  Internal helpers — formatting
// ============================================================

/**
 * Format a number of seconds as a human-readable "M min S sec"
 * string. Rounds to the nearest second, which is the granularity
 * the reading time was computed at.
 *
 * An input of zero returns "0 sec" — this is the case for an
 * empty article, and the string is the correct reading for it.
 */
const formatReadingTime = (seconds: number): string => {
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  const remaining = total % 60;
  if (minutes === 0) {
    return `${remaining} sec`;
  }
  if (remaining === 0) {
    return `${minutes} min`;
  }
  return `${minutes} min ${remaining} sec`;
};

// ============================================================
//  ReadabilityPanel
// ============================================================

/**
 * The readability section panel. See the file header for the
 * panel's responsibilities, its six metrics, and the reasoning
 * behind the layout choices.
 */
export const ReadabilityPanel = ({ section }: ReadabilityPanelProps) => {
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
          Readability
        </h3>
        <StatusBadge status={section.status} />
      </header>

      {/* ---- Metrics ---- */}
      <div className="divide-y divide-neutral-100 px-4 dark:divide-neutral-800/60">
        <MetricRow
          label="Flesch Reading Ease"
          value={section.fleschReadingEase.toFixed(1)}
          hint="0–100. Higher is easier. Plain English: 60–70."
        />
        <MetricRow
          label="Flesch-Kincaid Grade"
          value={section.fleschKincaidGrade.toFixed(1)}
          hint="US school grade level. Target: 7–9."
        />
        <MetricRow
          label="Gunning Fog"
          value={section.gunningFog.toFixed(1)}
          hint="Grade-level index. Target: under 12."
        />
        <MetricRow
          label="SMOG Index"
          value={section.smogIndex.toFixed(1)}
          hint="Grade-level index. Target: under 12."
        />
        <MetricRow
          label="Avg Sentence Length"
          value={`${section.avgSentenceLength.toFixed(1)} words`}
          hint="Comfortable range: 15–20 words per sentence."
        />
        <MetricRow
          label="Reading Time"
          value={formatReadingTime(section.readingTimeSeconds)}
          hint="Estimated at 250 words per minute."
        />
      </div>
    </section>
  );
};

// ============================================================
//  Default export
// ============================================================

/**
 * The `ReadabilityPanel` component as the default export.
 * `ValidationReport.tsx` imports it with the default form
 * (`import ReadabilityPanel from './ReadabilityPanel.js'`), so
 * this is the export that resolves that file's forward
 * reference.
 */
export default ReadabilityPanel;