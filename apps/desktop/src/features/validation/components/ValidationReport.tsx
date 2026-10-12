/**
 * ValidationReport — the Report tab's top-level component.
 *
 * Reads the topic's article from the writer store (via
 * `useWriter(topic._id)`) and the topic's latest validation report
 * from the validation hook (via `useValidation(topic._id)`), and
 * renders the six section panels with the report's corresponding
 * sections. A status banner at the top of the component shows the
 * report's aggregate `overallStatus` (good / warning / fail). When
 * no report exists yet, the component shows a "Run Validation"
 * action; when a report exists, it shows a "Re-validate" action.
 * While a run is in flight, a live progress panel replaces the
 * panels' content.
 *
 * ── The two hook signatures (PR-1) ─────────────────────────────
 *
 *   Both hooks this component consumes take the topic ID as their
 *   first argument, per Q4.3's "refactor all feature stores to key
 *   by topicId in the same pass." The `topic` prop supplies that
 *   ID directly (`topic._id`).
 *
 *   The consequence is that the article and the report this
 *   component reads are the ones belonging to the topic it was
 *   mounted for — not whichever topic last wrote to a store-wide
 *   slot. Two `<ValidationReport />` instances mounted for two
 *   different topics would read independent state.
 *
 * ── Where the six panels come from ─────────────────────────────
 *
 *   The six sibling components in this folder — `ReadabilityPanel`,
 *   `SeoPanel`, `OriginalityPanel`, `AiMarkersPanel`,
 *   `GrammarPanel`, `KeywordPanel` — are the six section renderers.
 *   They are forward references: this file is created at Session 16,
 *   step 124, and the panels at steps 125–130. Until those files
 *   exist on disk, the six imports produce six `TS2307` errors. The
 *   error count and its resolution are documented in the TypeScript
 *   Integrity Check below.
 *
 *   Each panel is expected to accept a single prop: the section
 *   object it renders. The prop shape is:
 *
 *     ReadabilityPanel  ←  section: ReadabilityReport
 *     SeoPanel          ←  section: SeoReport
 *     KeywordPanel      ←  section: KeywordReport
 *     OriginalityPanel  ←  section: OriginalityReport
 *     AiMarkersPanel    ←  section: AiMarkersReport
 *     GrammarPanel      ←  section: GrammarReport
 *
 *   This file owns that prop interface — it is the caller, and the
 *   panels will be created to match. A future session that needed
 *   a panel to render from something other than its own section
 *   (a sibling-panel link, a per-user threshold override) would
 *   extend the corresponding panel's props; the call site here
 *   gains a second attribute and no architectural change.
 *
 * ── Where the article comes from ───────────────────────────────
 *
 *   The Report tab needs an article's `_id` and its topic's `_id`
 *   to call `runValidation(articleId, topicId)`. The `topic` prop
 *   supplies the topic ID directly (`topic._id`). The article ID
 *   comes from the writer store's per-topic `articlesByTopic[topic._id]`
 *   slot — the same `Article` object that the sibling
 *   `ArticlePreview` component renders in the Article tab. Both
 *   components read from the same slot because both call
 *   `useWriter(topic._id)`.
 *
 *   The consequence is documented in `WriterProgress.tsx`'s PLAN
 *   DELTA 1: on a cold mount of a topic that has an article on
 *   the backend but no article in the writer store, the Report
 *   tab shows its "no article yet" empty state. The "load the
 *   last article on mount" flow is a future session's addition —
 *   once it lands, `useWriter(topic._id)`'s `loadLatest` action
 *   will be what populates the slot this component reads.
 *
 * ── The five visual states ─────────────────────────────────────
 *
 *   The component renders one of five states:
 *
 *     1. NO ARTICLE — the writer store's `article` field is null.
 *        A neutral message telling the user to generate an
 *        article first. This is the cold-mount case for a topic
 *        whose article has not been generated in this session.
 *
 *     2. NO REPORT — the article exists but no report has been
 *        produced. A prompt card with a "Run Validation" button.
 *
 *     3. RUNNING — `isRunning` is true. A progress panel showing
 *        which of the six validators is currently executing.
 *
 *     4. ERROR — `error` is non-null and `isRunning` is false. A
 *        red banner with the message and two buttons: "Retry"
 *        (re-runs the validation) and "Dismiss" (clears the
 *        error).
 *
 *     5. HAS REPORT — a report exists. The status banner, the
 *        header (with the "Re-validate" button), and the six
 *        panels.
 *
 *   The state checks run in the order above. The `isRunning`
 *   check runs before the `error` check because a validation
 *   operation's error only becomes user-relevant after the
 *   operation has stopped — while it is still running, the
 *   progress panel is the correct visual regardless of what the
 *   store's `error` field happens to hold from a previous run.
 *
 * ── The status banner ──────────────────────────────────────────
 *
 *   The banner's color and icon are driven by the report's
 *   `overallStatus`, which is one of the three values the shared
 *   `ReportStatus` union declares: `'good'`, `'warning'`, or
 *   `'fail'`. The three-color scheme — green, amber, red — is the
 *   one the plan's user-journey mockups show and the one the rest
 *   of the app uses for the same three states.
 *
 *   The banner text is a short sentence that summarises the
 *   aggregate: "Everything checks out", "A few warnings to
 *   review", or "One or more sections failed". The report's six
 *   panels below the banner carry the detail for each section.
 *
 * ── What this component does NOT do ────────────────────────────
 *
 *   - It does not fetch the article from the backend. See "Where
 *     the article comes from" above for the reasoning.
 *
 *   - It does not persist the report. The validation IPC handler
 *     is what POSTs the report to `/api/reports`.
 *
 *   - It does not render any section detail itself. Each panel
 *     owns its own section's rendering; this component is the
 *     composition layer.
 *
 *   - It does not offer a "regenerate with corrections" action.
 *     The plan's user journey (Stage 6) describes that flow as a
 *     future addition that feeds validation failures back to the
 *     writer. The `revalidate` action the hook exposes is an
 *     alias for `runValidation` today; the corrective loop's
 *     wiring will use it once the feedback path is defined.
 *
 * Dependencies: react + lucide-react + the two sibling hooks + the
 * six forward-referenced panels.
 */

import { useCallback } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Loader2,
  ShieldCheck,
  XCircle,
} from 'lucide-react';

import { useValidation } from '../hooks/useValidation.js';
import { useWriter } from '../../writer/hooks/useWriter.js';

import ReadabilityPanel from './ReadabilityPanel.js';
import SeoPanel from './SeoPanel.js';
import OriginalityPanel from './OriginalityPanel.js';
import AiMarkersPanel from './AiMarkersPanel.js';
import GrammarPanel from './GrammarPanel.js';
import KeywordPanel from './KeywordPanel.js';

import type {
  ReportStatus,
  Topic,
} from '../../shared/types/index.js';

// ============================================================
//  Public types
// ============================================================

/**
 * The props accepted by `ValidationReport`.
 *
 * The component takes the full `Topic` object — the same shape
 * every other stage component on the topic-detail page receives
 * — so its validation action can pass `topic._id` as the
 * `topicId` argument to the hook.
 */
export interface ValidationReportProps {
  /** The topic whose report this view represents. */
  topic: Topic;
}

// ============================================================
//  Constants — status banner styling
// ============================================================
//
//  A `Record<ReportStatus, {...}>` so the compiler enforces
//  exhaustiveness: adding a fourth value to the union without
//  adding an entry here is a compile error. Each entry carries
//  the icon, the color classes for the banner container and the
//  icon, and the banner's headline text.

interface StatusStyle {
  icon: typeof CheckCircle2;
  containerClass: string;
  iconClass: string;
  headline: string;
}

const STATUS_STYLES: Record<ReportStatus, StatusStyle> = {
  good: {
    icon: CheckCircle2,
    containerClass:
      'bg-emerald-50 border-emerald-200 text-emerald-900 ' +
      'dark:bg-emerald-950/60 dark:border-emerald-900 ' +
      'dark:text-emerald-100',
    iconClass: 'text-emerald-600 dark:text-emerald-400',
    headline: 'Everything checks out.',
  },
  warning: {
    icon: AlertTriangle,
    containerClass:
      'bg-amber-50 border-amber-200 text-amber-900 ' +
      'dark:bg-amber-950/60 dark:border-amber-900 ' +
      'dark:text-amber-100',
    iconClass: 'text-amber-600 dark:text-amber-400',
    headline: 'A few warnings to review.',
  },
  fail: {
    icon: XCircle,
    containerClass:
      'bg-red-50 border-red-200 text-red-900 ' +
      'dark:bg-red-950/60 dark:border-red-900 ' +
      'dark:text-red-100',
    iconClass: 'text-red-600 dark:text-red-400',
    headline: 'One or more sections failed.',
  },
};

// ============================================================
//  Internal — progress line for the running state
// ============================================================

interface ProgressLineProps {
  phase: string | null;
  index: number | null;
  total: number | null;
}

/**
 * The progress line shown during a validation run. The line
 * combines the current phase (the validator's name, humanised)
 * with the "N of M" position. Both parts fall back to a generic
 * "Starting validation…" when the store's `progress` field is
 * still null — the moment between the click and the first
 * marker's arrival.
 */
const ProgressLine = ({
  phase,
  index,
  total,
}: ProgressLineProps) => {
  if (phase === null || index === null || total === null) {
    return <span>Starting validation…</span>;
  }
  // The phase strings the Python side emits are snake_case
  // (`ai_markers`, `keyword_check`'s `keywords`). Convert to a
  // display form: underscores to spaces, capitalized first
  // letter. The string is otherwise passed through unchanged.
  const humanised = phase
    .replace(/_/g, ' ')
    .replace(/^\w/, (c) => c.toUpperCase());
  return (
    <span>
      Running {humanised} · {index} of {total}
    </span>
  );
};

// ============================================================
//  ValidationReport
// ============================================================

/**
 * The Report tab. See the file header for the component's
 * responsibilities, its five visual states, and the reasoning
 * behind the design choices.
 */
export const ValidationReport = ({ topic }: ValidationReportProps) => {
  const { article } = useWriter(topic._id);
  const {
    report,
    isRunning,
    progress,
    error,
    runValidation,
    clearError,
  } = useValidation(topic._id);

  // ---- Start / retry ----
  // The handler for the "Run Validation" button, the
  // "Re-validate" button, and the error state's "Retry" button.
  // All three trigger the same operation — a validation run on
  // the current article, tagged with its topic's ID for the
  // marker stream filter.
  const handleStart = useCallback((): void => {
    if (article === null) return;
    void runValidation(article._id, topic._id);
  }, [article, topic._id, runValidation]);

  // ---- Dismiss ----
  const handleDismiss = useCallback((): void => {
    clearError(topic._id);
  }, [clearError, topic._id]);

  // ---- State 1: NO ARTICLE ----
  // The writer store has no article for the current session.
  // The most likely explanation for the user is "you have not
  // generated one yet in this session" — the sibling WriterProgress
  // panel in the Article tab is where generation happens.
  if (article === null) {
    return (
      <div className="mx-auto flex max-w-md flex-col items-center gap-4 py-12 text-center">
        <div
          className={
            'flex h-14 w-14 items-center justify-center ' +
            'rounded-2xl bg-neutral-100 text-neutral-500 ' +
            'dark:bg-neutral-800 dark:text-neutral-400'
          }
        >
          <ShieldCheck size={28} aria-hidden="true" />
        </div>
        <div>
          <h2
            className={
              'text-lg font-semibold text-text ' +
              'dark:text-neutral-100'
            }
          >
            No article to validate
          </h2>
          <p
            className={
              'mt-1 text-sm text-neutral-500 ' +
              'dark:text-neutral-400'
            }
          >
            Open the Article tab and click &ldquo;Generate
            Article&rdquo; first. The validation runs against the
            generated draft.
          </p>
        </div>
      </div>
    );
  }

  // ---- State 3: RUNNING ----
  // Checked before the error state so a running operation shows
  // its progress panel regardless of what a previous run left in
  // the store's `error` field.
  if (isRunning) {
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
            <ProgressLine
              phase={progress?.phase ?? null}
              index={progress?.index ?? null}
              total={progress?.total ?? null}
            />
          </p>
        </div>
      </div>
    );
  }

  // ---- State 4: ERROR ----
  // Shown when the last validation failed. A red banner with the
  // message and two buttons: Retry and Dismiss.
  if (error !== null) {
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
            className={
              'mt-0.5 shrink-0 text-red-600 dark:text-red-400'
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

  // ---- State 2: NO REPORT ----
  // The article exists but no validation has run. A prompt card
  // with the "Run Validation" action.
  if (report === null) {
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
          <ShieldCheck size={18} aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <p
            className={
              'text-sm font-medium text-text ' +
              'dark:text-neutral-100'
            }
          >
            Ready to validate
          </p>
          <p
            className={
              'mt-0.5 text-xs text-neutral-500 ' +
              'dark:text-neutral-400'
            }
          >
            Check readability, SEO, keywords, originality, AI
            markers, and grammar.
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
          Run Validation
        </button>
      </div>
    );
  }

  // ---- State 5: HAS REPORT ----
  // The report exists. Render the status banner, the header with
  // the Re-validate action, and the six panels.
  const statusStyle = STATUS_STYLES[report.overallStatus];
  const StatusIcon = statusStyle.icon;

  return (
    <div className="space-y-6">
      {/* ---- Status banner ---- */}
      <div
        className={
          'flex items-start gap-3 rounded-xl border p-4 ' +
          statusStyle.containerClass
        }
      >
        <StatusIcon
          size={22}
          className={
            'mt-0.5 shrink-0 ' + statusStyle.iconClass
          }
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold leading-snug">
            {statusStyle.headline}
          </p>
          <p className="mt-0.5 text-xs opacity-80">
            {report.readability.status === 'good' ? '✓' : '⚠'}{' '}
            Readability · {report.seo.status === 'good' ? '✓' : '⚠'}{' '}
            SEO ·{' '}
            {report.keywords.status === 'good' ? '✓' : '⚠'}{' '}
            Keywords ·{' '}
            {report.originality.status === 'good' ? '✓' : '⚠'}{' '}
            Originality ·{' '}
            {report.aiMarkers.status === 'good' ? '✓' : '⚠'}{' '}
            AI markers ·{' '}
            {report.grammar.status === 'good' ? '✓' : '⚠'}{' '}
            Grammar
          </p>
        </div>
      </div>

      {/* ---- Header row: timestamp + re-validate action ---- */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          Validated{' '}
          {new Date(report.createdAt).toLocaleString()}
        </p>
        <button
          type="button"
          onClick={handleStart}
          className={
            'rounded-lg border border-neutral-300 ' +
            'bg-background px-3 py-1.5 text-xs font-medium ' +
            'text-text transition-colors hover:bg-neutral-100 ' +
            'focus-visible:outline-none ' +
            'dark:border-neutral-700 dark:hover:bg-neutral-800 ' +
            'dark:text-neutral-100'
          }
        >
          Re-validate
        </button>
      </div>

      {/* ---- The six panels ---- */}
      {/* Each panel is a pure renderer of one section. The order
          matches the plan's user-journey Stage 6 mockup: the
          readability numbers first, then the structural SEO
          shape, then the per-keyword placement, then the
          originality and AI-marker signals, then the grammar
          issues. A reader scanning the report top-to-bottom sees
          the article's prose quality before its stylistic
          fingerprints. */}
      <div className="space-y-4">
        <ReadabilityPanel section={report.readability} />
        <SeoPanel section={report.seo} />
        <KeywordPanel section={report.keywords} />
        <OriginalityPanel section={report.originality} />
        <AiMarkersPanel section={report.aiMarkers} />
        <GrammarPanel section={report.grammar} />
      </div>
    </div>
  );
};

// ============================================================
//  Default export
// ============================================================

/**
 * The `ValidationReport` component as the default export.
 * `TopicDetail.tsx` imports it with the default form
 * (`import ValidationReport from '.../ValidationReport.js'`), so
 * this is the export that resolves that file's forward reference.
 */
export default ValidationReport;