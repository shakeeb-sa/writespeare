/**
 * SeoPanel — the SEO section of the Report tab.
 *
 * Renders the six structural metrics the Python side's
 * `validation/seo_check.py` produces, plus a status badge
 * carrying the section's good / warning / fail classification.
 *
 * The panel is a pure renderer: it reads everything it needs from
 * the `section` prop that `ValidationReport.tsx` passes it and
 * holds no state, calls no hooks, and reaches no store. The same
 * pattern applies to all six sibling panels.
 *
 * ── The six metrics ────────────────────────────────────────────
 *
 *   Word Count           Total words in the article. The plan's
 *                        user journey shows "1,247 (target 1200)"
 *                        — a number compared against the topic's
 *                        target word count.
 *
 *   H2 Sections          Number of H2 headings. Three or more is
 *                        the general guidance for a scannable
 *                        article.
 *
 *   H3 Subsections       Number of H3 headings. Zero is fine for
 *                        a short article; some sections subdivide
 *                        further.
 *
 *   Avg Paragraph        Average words per paragraph. The
 *                        comfortable range for web prose is
 *                        twenty to a hundred words.
 *
 *   Passive Voice        Fraction of sentences that use the
 *                        classical English passive. Target: under
 *                        10% of sentences.
 *
 *   Transition Words     Fraction of sentences containing a
 *                        transition word or phrase. Target: at
 *                        least 20% of sentences.
 *
 *   Two of the six metrics — `passiveVoicePercent` and
 *   `transitionWordsPercent` — are stored as fractions in the
 *   range [0, 1] on the `SeoReport` type, matching the backend's
 *   Mongoose schema (`min: 0, max: 1`). The panel multiplies by
 *   100 and appends a percent sign for display.
 *
 *   The other four are counts and averages. `wordCount`,
 *   `h2Count`, and `h3Count` are integers; `avgParagraphWords` is
 *   a float. All four are rendered as-is, with thousand separators
 *   on the word count and one decimal place on the average.
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
 *   Same bordered-card structure as `ReadabilityPanel.tsx`: a
 *   header row (title + status badge) and a body of metric rows
 *   separated by thin dividers. The identical structure across
 *   the six panels is what makes the report read as a single
 *   document rather than as six widgets.
 *
 * ── What this panel does NOT do ────────────────────────────────
 *
 *   - It does not compute anything. Every number comes from the
 *     Python-side validator that produced the report.
 *
 *   - It does not compare the word count against a target. The
 *     report carries the article's actual word count; the
 *     topic's target is not part of the report (it is a field on
 *     the topic itself). A future session that wanted to show
 *     the comparison would add the target as a prop passed by
 *     `ValidationReport`, which already has the `topic` object in
 *     hand.
 *
 *   - It does not distinguish "passive voice fraction is 0.06"
 *     from "passive voice could not be measured". The Python
 *     side reports zero in both cases, and the report does not
 *     carry a separate "why" field — see `readability.py`'s
 *     empty-article handling for the analogous situation.
 *
 * Dependencies: lucide-react + the shared types.
 */

import {
  AlertTriangle,
  CheckCircle2,
  XCircle,
} from 'lucide-react';

import type {
  SeoReport,
  ReportStatus,
} from '../../shared/types/index.js';

// ============================================================
//  Public types
// ============================================================

/**
 * The props accepted by `SeoPanel`.
 *
 * The component takes a single `section` prop — the SEO section
 * from the report. The parent (`ValidationReport.tsx`) passes
 * `report.seo` directly, so the prop is typed as the section type
 * from the shared `Report` interface.
 */
export interface SeoPanelProps {
  /** The SEO section of the report. */
  section: SeoReport;
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
//  Internal helpers — formatting
// ============================================================

/**
 * Convert a [0, 1] fraction into a display percentage string
 * with one decimal place — "0.06" becomes "6.0%".
 *
 * The multiplication by 100 and the `%` suffix are the panel's
 * responsibility, not the validator's: the `SeoReport` type
 * declares the field as a fraction because that is what the
 * backend's schema stores and what the Python script produces.
 * The display form is a UI concern.
 *
 * A value outside [0, 1] is clamped to that range before
 * formatting, so a bug in the Python side that produced 1.5
 * does not render as "150.0%" — a value that would confuse the
 * reader without being any more truthful.
 */
const formatPercent = (fraction: number): string => {
  const clamped = Math.max(0, Math.min(1, fraction));
  return `${(clamped * 100).toFixed(1)}%`;
};

// ============================================================
//  SeoPanel
// ============================================================

/**
 * The SEO section panel. See the file header for the panel's
 * responsibilities, its six metrics, and the reasoning behind
 * the layout choices.
 */
export const SeoPanel = ({ section }: SeoPanelProps) => {
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
          SEO Structure
        </h3>
        <StatusBadge status={section.status} />
      </header>

      {/* ---- Metrics ---- */}
      <div className="divide-y divide-neutral-100 px-4 dark:divide-neutral-800/60">
        <MetricRow
          label="Word Count"
          value={section.wordCount.toLocaleString()}
          hint="Total words in the article body."
        />
        <MetricRow
          label="H2 Sections"
          value={String(section.h2Count)}
          hint="Three or more reads as well-structured."
        />
        <MetricRow
          label="H3 Subsections"
          value={String(section.h3Count)}
          hint="Fine to leave at zero for a short article."
        />
        <MetricRow
          label="Avg Paragraph Length"
          value={`${section.avgParagraphWords.toFixed(1)} words`}
          hint="Comfortable range: 20–100 words per paragraph."
        />
        <MetricRow
          label="Passive Voice"
          value={formatPercent(section.passiveVoicePercent)}
          hint="Fraction of sentences. Target: under 10%."
        />
        <MetricRow
          label="Transition Words"
          value={formatPercent(section.transitionWordsPercent)}
          hint="Fraction of sentences with a connective. Target: 20%+."
        />
      </div>
    </section>
  );
};

// ============================================================
//  Default export
// ============================================================

/**
 * The `SeoPanel` component as the default export.
 * `ValidationReport.tsx` imports it with the default form
 * (`import SeoPanel from './SeoPanel.js'`), so this is the export
 * that resolves that file's forward reference.
 */
export default SeoPanel;