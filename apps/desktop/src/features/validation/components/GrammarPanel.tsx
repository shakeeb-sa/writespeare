/**
 * GrammarPanel — the grammar section of the Report tab.
 *
 * Renders the aggregate grammar issue count the Python side's
 * `validation/grammar.py` produces, plus the list of individual
 * issues LanguageTool reported. Each issue shows its rule id,
 * its human-readable message, and — when LanguageTool provided
 * any — an ordered list of suggested replacement strings.
 *
 * The panel is a pure renderer: it reads everything it needs from
 * the `section` prop that `ValidationReport.tsx` passes it and
 * holds no state, calls no hooks, and reaches no store. The same
 * pattern applies to all six sibling panels.
 *
 * ── The two pieces of information ──────────────────────────────
 *
 *   Issue Count      The total number of issues LanguageTool
 *                    flagged. The count is what the section's
 *                    status is derived from — a small count is
 *                    a warning, a large one is a failure.
 *
 *   Issues List      One entry per issue, each with its rule id
 *                    (for a developer-facing identifier), its
 *                    message (the human-readable description), a
 *                    `replacements` list (LanguageTool's own
 *                    suggested rewrites), and — as internal
 *                    metadata this panel does not render — a
 *                    character `offset` and `length` that a
 *                    future session could use to highlight the
 *                    issue in the article body.
 *
 * ── The offset and length fields ───────────────────────────────
 *
 *   The `GrammarIssue` type carries `offset` and `length` fields
 *   — the character positions of the issue in the article's
 *   stripped text. This panel does NOT use them. The reason is
 *   structural: the panel is a standalone renderer with no
 *   reference to the article's text, so there is nothing to
 *   highlight or scroll to. A future session that wanted the
 *   report to be an interactive overlay on the Article tab would
 *   pass the article text (or a read function) as a second prop
 *   and use the offsets to place highlights; that change is a
 *   coordinated update across this panel and its parent.
 *
 *   Until then, the offsets are retained on the report for any
 *   future consumer — the `GrammarIssue` type declares them, the
 *   Python side produces them, the backend stores them, and this
 *   panel's absence of usage is the only place where the
 *   retention chain would be broken if a session later decided
 *   the fields were dead weight.
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
 *   metric and the list of issues. Each issue is rendered as a
 *   small card with three lines: the rule id, the message, and —
 *   when there are any — the suggested replacements as small
 *   pills.
 *
 *   A cap on the rendered list: the panel shows the first
 *   `MAX_RENDERED_ISSUES` (twenty) issues and, when there are
 *   more, a small "+N more" line below the last card. The cap
 *   exists so that an article with two hundred language-tool
 *   warnings does not render a two-hundred-card list that
 *   forces the user to scroll for minutes. The count metric at
 *   the top always reflects the true total; the cap only limits
 *   how many individual cards the panel renders.
 *
 * ── What this panel does NOT do ────────────────────────────────
 *
 *   - It does not offer a "apply all fixes" action. LanguageTool
 *     suggestions are advisory; the user edits the article
 *     through the Article tab's `ArticlePreview` edit mode.
 *
 *   - It does not distinguish "the issue is a spelling mistake"
 *     from "the issue is a stylistic suggestion" in the card's
 *     visual treatment. The rule id (`EN_QUOTES`,
 *     `MORFOLOGIK_RULE_EN_US`) and the message carry the
 *     distinction for a reader who wants it, and a future
 *     session that wanted a per-rule color or icon would add
 *     that decision to the card's rendering.
 *
 *   - It does not link the issue to its position in the article.
 *     See "The offset and length fields" above.
 *
 * Dependencies: lucide-react + the shared types.
 */

import {
  AlertTriangle,
  CheckCircle2,
  XCircle,
} from 'lucide-react';

import type {
  GrammarReport,
  ReportStatus,
} from '../../shared/types/index.js';

// ============================================================
//  Public types
// ============================================================

/**
 * The props accepted by `GrammarPanel`.
 *
 * The component takes a single `section` prop — the grammar
 * section from the report. The parent (`ValidationReport.tsx`)
 * passes `report.grammar` directly, so the prop is typed as the
 * section type from the shared `Report` interface.
 */
export interface GrammarPanelProps {
  /** The grammar section of the report. */
  section: GrammarReport;
}

// ============================================================
//  Constants
// ============================================================
//
//  The maximum number of individual issue cards the panel
//  renders. See the file header's "Layout" section for the
//  rationale on why this cap exists and how the "+N more" line
//  below the list handles the truncation.
//
//  Twenty is a judgement value: enough that a typical article's
//  issue list is shown in full, few enough that a pathological
//  article with hundreds of warnings does not render an
//  unusably-long page.

const MAX_RENDERED_ISSUES = 20;

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
//  Internal — issue card
// ============================================================

interface IssueCardProps {
  ruleId: string;
  message: string;
  replacements: string[];
}

const IssueCard = ({
  ruleId,
  message,
  replacements,
}: IssueCardProps) => (
  <div
    className={
      'rounded-lg border border-neutral-200 bg-neutral-50 p-3 ' +
      'dark:border-neutral-800 dark:bg-neutral-900/40'
    }
  >
    {/* ---- Rule id + message ---- */}
    <div className="flex flex-wrap items-baseline gap-2">
      <span
        className={
          'rounded bg-neutral-200 px-1.5 py-0.5 font-mono ' +
          'text-[10px] font-medium text-neutral-700 ' +
          'dark:bg-neutral-800 dark:text-neutral-300'
        }
        title={ruleId}
      >
        {ruleId}
      </span>
      <p
        className={
          'min-w-0 flex-1 text-sm leading-snug text-text ' +
          'dark:text-neutral-100'
        }
      >
        {message}
      </p>
    </div>

    {/* ---- Suggested replacements ---- */}
    {/* Only rendered when LanguageTool provided at least one
        replacement. A rule that flagged an issue without
        suggesting a fix (some spelling rules, most style
        rules) renders with just the message. */}
    {replacements.length > 0 && (
      <div className="mt-2 flex flex-wrap gap-1.5">
        {replacements.map((replacement, index) => (
          <span
            key={`${replacement}-${index}`}
            className={
              'inline-flex items-center rounded ' +
              'bg-emerald-50 px-1.5 py-0.5 text-xs ' +
              'text-emerald-800 ' +
              'dark:bg-emerald-950/60 dark:text-emerald-200'
            }
          >
            {replacement}
          </span>
        ))}
      </div>
    )}
  </div>
);

// ============================================================
//  GrammarPanel
// ============================================================

/**
 * The grammar section panel. See the file header for the panel's
 * responsibilities, its two pieces of information, and the
 * reasoning behind the issue-card layout.
 */
export const GrammarPanel = ({ section }: GrammarPanelProps) => {
  const issues = section.issues;
  const hasIssues = issues.length > 0;

  // The list is capped for rendering. See the file header's
  // "Layout" section for the rationale.
  const rendered = issues.slice(0, MAX_RENDERED_ISSUES);
  const hiddenCount = issues.length - rendered.length;

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
          Grammar
        </h3>
        <StatusBadge status={section.status} />
      </header>

      {/* ---- Aggregate metric ---- */}
      <div className="divide-y divide-neutral-100 px-4 dark:divide-neutral-800/60">
        <MetricRow
          label="Issues Found"
          value={section.issueCount.toLocaleString()}
          hint="LanguageTool's total. Target: 5 or fewer."
        />
      </div>

      {/* ---- Issues list ---- */}
      {hasIssues ? (
        <div className="space-y-2 border-t border-neutral-200 px-4 py-4 dark:border-neutral-800">
          <p
            className={
              'text-xs font-medium uppercase tracking-wide ' +
              'text-neutral-500 dark:text-neutral-400'
            }
          >
            {issues.length}{' '}
            {issues.length === 1 ? 'issue' : 'issues'}
          </p>
          <div className="space-y-2">
            {rendered.map((issue, index) => (
              <IssueCard
                key={`${issue.ruleId}-${issue.offset}-${index}`}
                ruleId={issue.ruleId}
                message={issue.message}
                replacements={issue.replacements}
              />
            ))}
          </div>

          {/* ---- Truncation notice ---- */}
          {/* Shown only when the list was capped. The count is the
              difference between the true total and the number
              actually rendered. */}
          {hiddenCount > 0 && (
            <p
              className={
                'pt-2 text-xs text-neutral-500 ' +
                'dark:text-neutral-400'
              }
            >
              +{hiddenCount} more{' '}
              {hiddenCount === 1 ? 'issue' : 'issues'} not shown.
            </p>
          )}
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
            LanguageTool found no grammar, style, or spelling
            issues in the article.
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
 * The `GrammarPanel` component as the default export.
 * `ValidationReport.tsx` imports it with the default form
 * (`import GrammarPanel from './GrammarPanel.js'`), so this is
 * the export that resolves that file's forward reference.
 */
export default GrammarPanel;