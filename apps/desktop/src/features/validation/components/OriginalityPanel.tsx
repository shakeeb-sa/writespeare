/**
 * OriginalityPanel — the originality section of the Report tab.
 *
 * Renders the two similarity signals the Python side's
 * `validation/originality.py` produces — the highest TF-IDF
 * cosine similarity and the highest semantic (embedding) cosine
 * similarity — plus the list of article sentences that exceeded
 * either signal's threshold, each with the source title it
 * matched most closely.
 *
 * The panel is a pure renderer: it reads everything it needs from
 * the `section` prop that `ValidationReport.tsx` passes it and
 * holds no state, calls no hooks, and reaches no store. The same
 * pattern applies to all six sibling panels.
 *
 * ── The two similarity signals ─────────────────────────────────
 *
 *   Max TF-IDF Similarity     The highest cosine similarity
 *                             between any article sentence and
 *                             any source chunk, measured on a
 *                             TF-IDF vectorization. High values
 *                             mean the article reuses the
 *                             source's exact vocabulary —
 *                             verbatim copying or near-verbatim
 *                             paraphrasing.
 *
 *   Max Semantic Similarity   The highest cosine similarity
 *                             between the article's sentence
 *                             embeddings and the source
 *                             embeddings. High values mean the
 *                             article expresses the same ideas
 *                             as the source, even when the words
 *                             differ — paraphrase.
 *
 *   A section that reports both numbers low is genuinely original;
 *   a section that reports either number high is flagged. See the
 *   Python module's file header for the reasoning on why both
 *   signals exist.
 *
 * ── The flagged sentences list ─────────────────────────────────
 *
 *   The `flaggedSentences` array carries one entry per article
 *   sentence that exceeded either threshold. Each entry has
 *   three fields:
 *
 *     text         The sentence's own text.
 *     similarity   The score that triggered the flag (0–1).
 *     sourceTitle  A label identifying which source document
 *                  the sentence matched most closely.
 *
 *   The panel renders the list as a series of small cards, each
 *   showing the sentence, its similarity score, and the source
 *   title. The list is capped visually — the panel shows the
 *   full list because a report with many flagged sentences is
 *   exactly the report the user most needs to see, and truncating
 *   it would hide the problem.
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
 *   row (title + status badge) followed by the two similarity
 *   rows and, when there are any, the flagged-sentences list.
 *   When the list is empty, the panel shows a short "no
 *   sentences flagged" message in its place — the user needs to
 *   see explicitly that the check found nothing rather than
 *   infer it from an empty space.
 *
 * ── What this panel does NOT do ────────────────────────────────
 *
 *   - It does not link the flagged sentence to its position in
 *     the article. The report carries the sentence text and the
 *     source title but not a character offset — the Python
 *     side's `FlaggedSentence` shape does not include an
 *     `offset` field (unlike the grammar section's
 *     `GrammarIssue`). A future session that wanted in-article
 *     highlighting would add an `offset` field to the shared
 *     `FlaggedSentence` type and populate it from the Python
 *     script; this panel would then wrap the sentence in an
 *     anchor that scrolls the Article tab to that position.
 *
 *   - It does not re-run the check on its own. The panel renders
 *     the section the parent passes it; re-running is the
 *     `ValidationReport` header's "Re-validate" action's job.
 *
 *   - It does not distinguish "the sentence scored 0.4 on the
 *     TF-IDF signal" from "the sentence scored 0.4 on the
 *     semantic signal" in the flagged entry. The Python side's
 *     `_build_flagged_sentence` reports whichever signal was
 *     higher — the strongest signal of "this sentence is too
 *     close to something" — and the report carries only that
 *     score. A future session that wanted per-signal scores on
 *     the flagged entries would extend the shared
 *     `FlaggedSentence` type and the Python side's builder
 *     together.
 *
 * Dependencies: lucide-react + the shared types.
 */

import {
  AlertTriangle,
  CheckCircle2,
  XCircle,
} from 'lucide-react';

import type {
  OriginalityReport,
  ReportStatus,
} from '../../shared/types/index.js';

// ============================================================
//  Public types
// ============================================================

/**
 * The props accepted by `OriginalityPanel`.
 *
 * The component takes a single `section` prop — the originality
 * section from the report. The parent (`ValidationReport.tsx`)
 * passes `report.originality` directly, so the prop is typed as
 * the section type from the shared `Report` interface.
 */
export interface OriginalityPanelProps {
  /** The originality section of the report. */
  section: OriginalityReport;
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
 * Format a cosine similarity value (0–1) as a display string
 * with two decimal places — "0.22" stays "0.22", "0.31" stays
 * "0.31".
 *
 * Two decimal places is the precision the plan's user-journey
 * mockup shows ("Closest source (TF-IDF): 0.22", "Closest source
 * (semantic): 0.31"). The underlying value can carry more digits;
 * two is the displayed precision.
 *
 * A value outside [0, 1] is clamped to that range before
 * formatting, so a bug on the Python side that produced a value
 * outside the range does not render as a nonsensical number.
 */
const formatSimilarity = (value: number): string => {
  const clamped = Math.max(0, Math.min(1, value));
  return clamped.toFixed(2);
};

// ============================================================
//  Internal — flagged-sentence card
// ============================================================

interface FlaggedSentenceCardProps {
  text: string;
  similarity: number;
  sourceTitle: string;
}

const FlaggedSentenceCard = ({
  text,
  similarity,
  sourceTitle,
}: FlaggedSentenceCardProps) => (
  <div
    className={
      'rounded-lg border border-amber-200 bg-amber-50 p-3 ' +
      'dark:border-amber-900 dark:bg-amber-950/40'
    }
  >
    <p
      className={
        'text-sm leading-snug text-amber-900 ' +
        'dark:text-amber-100'
      }
    >
      {text}
    </p>
    <p
      className={
        'mt-2 flex flex-wrap items-center gap-x-2 gap-y-0.5 ' +
        'text-xs text-amber-800/80 dark:text-amber-200/80'
      }
    >
      <span>
        Similarity <span className="font-medium tabular-nums">
          {formatSimilarity(similarity)}
        </span>
      </span>
      <span aria-hidden="true">·</span>
      <span className="truncate" title={sourceTitle}>
        Matched: {sourceTitle}
      </span>
    </p>
  </div>
);

// ============================================================
//  OriginalityPanel
// ============================================================

/**
 * The originality section panel. See the file header for the
 * panel's responsibilities, its two similarity signals, and the
 * reasoning behind the flagged-sentences layout.
 */
export const OriginalityPanel = ({
  section,
}: OriginalityPanelProps) => {
  const flagged = section.flaggedSentences;
  const hasFlagged = flagged.length > 0;

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
          Originality
        </h3>
        <StatusBadge status={section.status} />
      </header>

      {/* ---- Similarity metrics ---- */}
      <div className="divide-y divide-neutral-100 px-4 dark:divide-neutral-800/60">
        <MetricRow
          label="Max TF-IDF Similarity"
          value={formatSimilarity(section.maxTfidfSimilarity)}
          hint="Closest lexical match against any source. Limit: 0.30."
        />
        <MetricRow
          label="Max Semantic Similarity"
          value={formatSimilarity(section.maxSemanticSimilarity)}
          hint="Closest meaning-level match against any source. Limit: 0.35."
        />
      </div>

      {/* ---- Flagged sentences ---- */}
      {/* The list is shown only when at least one sentence was
          flagged. An empty list is the section's success state —
          it deserves a short confirmation line rather than a
          blank space the user might mistake for a rendering bug. */}
      {hasFlagged ? (
        <div className="space-y-2 border-t border-neutral-200 px-4 py-4 dark:border-neutral-800">
          <p
            className={
              'text-xs font-medium uppercase tracking-wide ' +
              'text-neutral-500 dark:text-neutral-400'
            }
          >
            {flagged.length}{' '}
            {flagged.length === 1
              ? 'sentence flagged'
              : 'sentences flagged'}
          </p>
          <div className="space-y-2">
            {flagged.map((entry, index) => (
              <FlaggedSentenceCard
                key={`${entry.sourceTitle}-${index}`}
                text={entry.text}
                similarity={entry.similarity}
                sourceTitle={entry.sourceTitle}
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
            No sentences were close enough to any source to be
            flagged. The article reads as original writing.
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
 * The `OriginalityPanel` component as the default export.
 * `ValidationReport.tsx` imports it with the default form
 * (`import OriginalityPanel from './OriginalityPanel.js'`), so
 * this is the export that resolves that file's forward reference.
 */
export default OriginalityPanel;