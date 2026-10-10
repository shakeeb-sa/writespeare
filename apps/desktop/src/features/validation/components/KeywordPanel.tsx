/**
 * KeywordPanel — the keywords section of the Report tab.
 *
 * Renders the per-keyword analysis the Python side's
 * `validation/keyword_check.py` produces: one row for each of
 * the user's keywords, showing its total occurrence count, its
 * density as a fraction of the article's word count, its
 * priority (primary / secondary / supporting), and its placement
 * across three structural positions — the article's title, its
 * intro paragraph, and its H2 headings.
 *
 * The panel is a pure renderer: it reads everything it needs from
 * the `section` prop that `ValidationReport.tsx` passes it and
 * holds no state, calls no hooks, and reaches no store. The same
 * pattern applies to all six sibling panels.
 *
 * ── The per-keyword row ────────────────────────────────────────
 *
 *   Each entry in the `keywords` array becomes one row. The row
 *   is composed of four visual elements, left to right:
 *
 *     1. Priority chip — a small colored pill that identifies
 *        the keyword's priority. Primary keywords get the
 *        brand-primary tint; supporting keywords get a neutral
 *        tint. The chip's presence is what makes the panel
 *        scannable: a user who wants to check "did I cover my
 *        main keywords?" reads the primary chip's rows and
 *        ignores the rest.
 *
 *     2. Keyword text — the phrase itself, in medium weight.
 *
 *     3. Placement icons — three small icons in a row, one
 *        each for the three placement checks:
 *
 *          "T"    in the title
 *          "I"    in the intro (first 100 words)
 *          "H2"   in at least one H2 heading
 *
 *        Each icon is filled (a colored dot) when the check
 *        passes, outlined (a thin border) when it does not. The
 *        icon's `title` attribute carries the expanded label
 *        ("In title", "In intro", "In H2 headings") for a hover
 *        tooltip. A one-letter glyph plus a hover tooltip is
 *        the pattern the plan's user-journey mockup's compact
 *        placement column implies.
 *
 *     4. Count and density — two numbers on the right, stacked
 *        vertically. The count is the raw occurrence count
 *        ("4 uses"); the density is the fraction expressed as
 *        a percentage ("0.32%"). Both use `tabular-nums` so
 *        numbers align across rows.
 *
 *   The row's status determines the accent color of the whole
 *   row's left border — a thin colored strip that runs the
 *   height of the row and reads as a per-keyword status
 *   indicator, distinct from the section's overall status badge
 *   in the header.
 *
 * ── The two density displays ───────────────────────────────────
 *
 *   The `density` field on `KeywordReportEntry` is a fraction in
 *   `[0, 1]` — matching the backend's schema (`min: 0, max: 1`)
 *   and the Python side's output. The panel multiplies by 100 to
 *   render a whole percentage.
 *
 *   The count and the density are shown together because they
 *   answer two different questions. The count ("4 uses") is what
 *   the user sees in their article when they search for the
 *   keyword; the density ("0.32%") is what the section's status
 *   thresholds compare against. A keyword with a count of 4 in a
 *   1200-word article has a density of 0.33%; the same count in
 *   a 2000-word article has a density of 0.20%. The user needs
 *   both numbers to reason about which is out of range.
 *
 * ── The status badge ───────────────────────────────────────────
 *
 *   Same three-color scheme as the sibling panels and the
 *   `ValidationReport` header's banner: green for good, amber for
 *   warning, red for fail.
 *
 * ── The empty case ─────────────────────────────────────────────
 *
 *   A `KeywordReport` with an empty `keywords` array — the case
 *   when the topic has no keywords defined, or when the user's
 *   keyword set was empty at validation time — renders a short
 *   confirmation line in place of the rows. The section's status
 *   for this case is `'good'` (per the Python side's
 *   `_empty_result`), and the message tells the user that there
 *   were no keywords to check rather than pretending the check
 *   ran and passed.
 *
 * ── What this panel does NOT do ────────────────────────────────
 *
 *   - It does not offer a "add keyword" or "remove keyword"
 *     action. The keyword set is part of the topic's
 *     configuration, changed through the topic-edit flow (a
 *     future session's UI, or the New Topic modal before the
 *     topic is created). The panel is a read-only report of what
 *     was checked.
 *
 *   - It does not compare the density against a target. The
 *     Python side's `keyword_check.py` uses the topic's preset to
 *     decide the thresholds, and reports the section's status
 *     based on whether each keyword met them. The panel shows
 *     the density number and the section status; the specific
 *     thresholds are not carried on the report. A future session
 *     that wanted to show "target: 0.5%–2%" per row would pass
 *     the preset through as a second prop.
 *
 *   - It does not sort or filter the keywords. The Python side
 *     preserves the user's order; the panel renders the list in
 *     the same order. A future session that wanted to sort by
 *     status or filter to failing keywords would add that
 *     derivation to the panel's body — the data is all present
 *     on each entry.
 *
 * Dependencies: lucide-react + the shared types.
 */

import {
  AlertTriangle,
  CheckCircle2,
  XCircle,
} from 'lucide-react';

import type {
  KeywordReport,
  KeywordReportEntry,
  ReportStatus,
} from '../../shared/types/index.js';

// ============================================================
//  Public types
// ============================================================

/**
 * The props accepted by `KeywordPanel`.
 *
 * The component takes a single `section` prop — the keywords
 * section from the report. The parent (`ValidationReport.tsx`)
 * passes `report.keywords` directly, so the prop is typed as the
 * section type from the shared `Report` interface.
 */
export interface KeywordPanelProps {
  /** The keywords section of the report. */
  section: KeywordReport;
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
//  Internal — priority chip
// ============================================================
//
//  A small colored pill identifying the keyword's priority. The
//  three priorities get three visual treatments:
//
//    primary      brand-primary tint — the strongest signal
//    secondary    a light neutral tint
//    supporting   a fully neutral, muted tint
//
//  The chip's label is the priority's name, first letter
//  uppercased. The `title` attribute carries the full label for
//  a hover tooltip.

interface PriorityChipProps {
  priority: KeywordReportEntry['priority'];
}

const PriorityChip = ({ priority }: PriorityChipProps) => {
  const label =
    priority.charAt(0).toUpperCase() + priority.slice(1);

  if (priority === 'primary') {
    return (
      <span
        title={label}
        className={
          'inline-flex shrink-0 items-center rounded px-1.5 ' +
          'py-0.5 text-[10px] font-semibold uppercase ' +
          'tracking-wide ' +
          'bg-primary/15 text-primary-dark ' +
          'dark:bg-primary-light/20 dark:text-primary-light'
        }
      >
        {priority}
      </span>
    );
  }

  if (priority === 'secondary') {
    return (
      <span
        title={label}
        className={
          'inline-flex shrink-0 items-center rounded px-1.5 ' +
          'py-0.5 text-[10px] font-semibold uppercase ' +
          'tracking-wide ' +
          'bg-neutral-200 text-neutral-700 ' +
          'dark:bg-neutral-700 dark:text-neutral-200'
        }
      >
        {priority}
      </span>
    );
  }

  return (
    <span
      title={label}
      className={
        'inline-flex shrink-0 items-center rounded px-1.5 ' +
        'py-0.5 text-[10px] font-semibold uppercase ' +
        'tracking-wide ' +
        'bg-neutral-100 text-neutral-500 ' +
        'dark:bg-neutral-800 dark:text-neutral-400'
      }
    >
      {priority}
    </span>
  );
};

// ============================================================
//  Internal — placement icon
// ============================================================
//
//  A single placement check rendered as a small lettered badge.
//  The badge is filled when the check passes and outlined when
//  it does not. The `title` attribute carries the expanded
//  label for a hover tooltip — the letter alone is not
//  self-explanatory, but the tooltip plus the header row's
//  labeled columns give the user enough context.

interface PlacementIconProps {
  label: string;
  passed: boolean;
  title: string;
}

const PlacementIcon = ({ label, passed, title }: PlacementIconProps) => {
  const base =
    'inline-flex h-5 w-6 items-center justify-center rounded ' +
    'text-[10px] font-semibold tabular-nums';
  const passedClass =
    'bg-emerald-100 text-emerald-800 ' +
    'dark:bg-emerald-950 dark:text-emerald-200';
  const failedClass =
    'border border-neutral-200 text-neutral-400 ' +
    'dark:border-neutral-700 dark:text-neutral-500';

  return (
    <span
      title={title}
      className={`${base} ${passed ? passedClass : failedClass}`}
    >
      {label}
    </span>
  );
};

// ============================================================
//  Internal — keyword row
// ============================================================

interface KeywordRowProps {
  entry: KeywordReportEntry;
}

/**
 * One keyword's analysis. The row's left border carries a thin
 * colored strip in the row's per-keyword status color — a small
 * visual cue that a user scanning the list can use to spot the
 * failing keywords without reading every row.
 */
const KeywordRow = ({ entry }: KeywordRowProps) => {
  // Density is a fraction in [0, 1]; the display multiplies by
  // 100 and shows two decimal places — "0.32%", "1.20%".
  const densityPercent = (
    Math.max(0, Math.min(1, entry.density)) * 100
  ).toFixed(2);

  // The row's accent color, driven by the per-keyword status.
  const accentClass =
    entry.status === 'good'
      ? 'border-l-emerald-400 dark:border-l-emerald-600'
      : entry.status === 'warning'
        ? 'border-l-amber-400 dark:border-l-amber-600'
        : 'border-l-red-400 dark:border-l-red-600';

  return (
    <div
      className={
        'flex items-center gap-3 border-l-4 py-2 pl-3 ' +
        accentClass
      }
    >
      {/* ---- Priority chip ---- */}
      <PriorityChip priority={entry.priority} />

      {/* ---- Keyword ---- */}
      <div className="min-w-0 flex-1">
        <p
          className={
            'truncate text-sm font-medium text-text ' +
            'dark:text-neutral-100'
          }
          title={entry.keyword}
        >
          {entry.keyword}
        </p>
      </div>

      {/* ---- Placement checks ---- */}
      <div className="flex shrink-0 items-center gap-1">
        <PlacementIcon
          label="T"
          passed={entry.inTitle}
          title="In the article title"
        />
        <PlacementIcon
          label="I"
          passed={entry.inIntro}
          title="In the intro (first 100 words)"
        />
        <PlacementIcon
          label="H2"
          passed={entry.inH2Count > 0}
          title={
            entry.inH2Count > 0
              ? `In ${entry.inH2Count} H2 heading${
                  entry.inH2Count === 1 ? '' : 's'
                }`
              : 'Not in any H2 heading'
          }
        />
      </div>

      {/* ---- Count and density ---- */}
      <div className="flex shrink-0 flex-col items-end">
        <span
          className={
            'text-sm font-semibold tabular-nums ' +
            'text-text dark:text-neutral-100'
          }
        >
          {entry.count}{' '}
          <span className="font-normal text-neutral-500 dark:text-neutral-400">
            {entry.count === 1 ? 'use' : 'uses'}
          </span>
        </span>
        <span
          className={
            'text-xs tabular-nums text-neutral-500 ' +
            'dark:text-neutral-400'
          }
        >
          {densityPercent}%
        </span>
      </div>
    </div>
  );
};

// ============================================================
//  KeywordPanel
// ============================================================

/**
 * The keywords section panel. See the file header for the
 * panel's responsibilities, its per-keyword row structure, and
 * the reasoning behind the two density displays.
 */
export const KeywordPanel = ({ section }: KeywordPanelProps) => {
  const keywords = section.keywords;
  const hasKeywords = keywords.length > 0;

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
          Keywords
        </h3>
        <StatusBadge status={section.status} />
      </header>

      {/* ---- Column header row ---- */}
      {/* A small labeled row above the list that gives the four
          columns their names. The placement icons' letters are
          self-describing with their tooltips, but the header
          row is what a user reads once to know what the letters
          mean. */}
      {hasKeywords && (
        <div
          className={
            'flex items-center gap-3 border-b border-neutral-100 ' +
            'bg-neutral-50 px-4 py-1.5 text-[10px] font-medium ' +
            'uppercase tracking-wide text-neutral-500 ' +
            'dark:border-neutral-800/60 dark:bg-neutral-900/40 ' +
            'dark:text-neutral-400'
          }
        >
          <span className="w-14 shrink-0">Priority</span>
          <span className="min-w-0 flex-1">Keyword</span>
          <span className="shrink-0" title="Title, Intro, H2">
            Placement
          </span>
          <span className="shrink-0 text-right">Uses · Density</span>
        </div>
      )}

      {/* ---- Keyword rows ---- */}
      {hasKeywords ? (
        <div className="divide-y divide-neutral-100 px-2 py-2 dark:divide-neutral-800/60">
          {keywords.map((entry) => (
            <KeywordRow key={entry.keyword} entry={entry} />
          ))}
        </div>
      ) : (
        <div className="px-4 py-4">
          <p
            className={
              'text-sm text-neutral-600 ' +
              'dark:text-neutral-300'
            }
          >
            No keywords were requested for this topic. Add a
            keyword list to the topic to have the article's
            keyword coverage measured on the next validation run.
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
 * The `KeywordPanel` component as the default export.
 * `ValidationReport.tsx` imports it with the default form
 * (`import KeywordPanel from './KeywordPanel.js'`), so this is
 * the export that resolves that file's forward reference.
 */
export default KeywordPanel;