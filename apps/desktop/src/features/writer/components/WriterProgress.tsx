/**
 * WriterProgress — the live writer-stage panel for the Article tab.
 *
 * The Article tab's two components are stacked: this one renders
 * above the article preview and owns the "start a generation" and
 * "watch it run" experience; the sibling `ArticlePreview` renders
 * below and owns the "read the finished article" experience. When
 * a generation is in flight, this panel dominates the tab; when
 * one has finished, the panel collapses to a small confirmation
 * and the preview takes over.
 *
 * ── The four visual states ─────────────────────────────────────
 *
 *   1. IDLE
 *      No generation has ever run for this topic, or the last
 *      one failed and the user dismissed the error. A prompt
 *      card that invites the user to start a generation, plus
 *      a "Generate Article" button.
 *
 *   2. IN-FLIGHT (isGenerating === true)
 *      A spinner with a live progress line that reflects the
 *      current phase of the operation. The five phases and their
 *      display strings are declared in `PHASE_MESSAGES` below;
 *      the "pasting" phase adds a per-doc count ("Pasting 3 of
 *      10").
 *
 *   3. SUCCESS-WITHOUT-PREVIEW (isGenerating === false and
 *      article === null, but no error)
 *      Not reachable from the current store semantics — the
 *      `generate` action sets `article` on success and sets
 *      `error` on failure, and there is no third outcome. The
 *      state is documented here for completeness and because
 *      a future session that adds a "generate, then cancel
 *      before the article loads" flow would produce it.
 *
 *   4. ERROR (error !== null, isGenerating === false)
 *      A red banner with the message and two buttons: "Retry"
 *      (calls `generate(topic._id)` again) and "Dismiss" (calls
 *      `clearError()`).
 *
 * ── Where the "Generate Article" button lives ──────────────────
 *
 *   The plan's Part 1.11 table describes this component as
 *   "Shows 'Pasting file X of Y', 'Typing prompt', 'Waiting for
 *   response'." That is the in-flight half of the component's
 *   job. The other half — providing the button that STARTS a
 *   generation — is what makes the panel's four states
 *   reachable: without the button, the panel would have nothing
 *   to show during the idle state.
 *
 *   The button lives here, above the article preview, rather
 *   than in the sibling `ArticlePreview`. The rationale is
 *   structural: the same panel that shows "Pasting 3 of 10"
 *   should be the panel that shows "Generate Article" — the
 *   user's mental model is "this panel is where generation
 *   happens", and splitting the button away from the progress
 *   display would make the two feel unrelated. The preview
 *   below shows the finished article; the panel above runs the
 *   generation.
 *
 *   The `topic` prop supplies the topic ID that the writer hook
 *   now takes as its required first argument (PR-1, Q4.3): the
 *   component calls `useWriter(topic._id)` and forwards
 *   `topic._id` to every action that touches per-topic state
 *   (`generate`, `cancel`, `clearError`).
 *
 * ── Why the component does NOT mount its own load-on-mount effect ─
 *
 *   The writer feature does not fetch a "previous article" on
 *   mount. The article the Article tab shows comes from one of
 *   two sources: the result of a generation the user just ran
 *   (held in the writer store), or — in a future session — an
 *   article fetched from the backend when the topic was opened.
 *   Neither is this component's responsibility to trigger; a
 *   future `useWriter` update that adds a "load the latest
 *   article on mount" effect would live in the store or the
 *   hook, not here.
 *
 *   The consequence is that the Article tab starts with an empty
 *   preview on a cold mount of a topic that already has an
 *   article on the backend. That gap is documented as a PLAN
 *   DELTA with this file's creation — the plan's tree does not
 *   declare a component that fetches the article, and the
 *   `useWriter` hook does not do it either, so the wiring is
 *   left for a future session.
 *
 * ── The phase-message mapping ──────────────────────────────────
 *
 *   The five phase strings the writer store holds (`'pasting'`,
 *   `'typing'`, `'sending'`, `'waiting'`, `'copying'`) each map
 *   to a human-readable label via `PHASE_MESSAGES`. The mapping
 *   is declared as a `Record<WriterPhase, string>`, so the
 *   compiler enforces exhaustiveness: adding a sixth phase to
 *   the store's union without adding an entry here is a compile
 *   error.
 *
 * ── What this component does NOT do ────────────────────────────
 *
 *   - It does not render the article. That is `ArticlePreview`'s
 *     job — the sibling component rendered below this one in the
 *     Article tab (see `TopicDetail.tsx`).
 *
 *   - It does not edit the prompt. The prompt file the writer
 *     uses is set per-topic in the New Topic modal's Advanced
 *     Settings section; this component uses whatever value the
 *     topic carried when it was created. A future session that
 *     wants an in-tab prompt picker would add it to the sibling
 *     `PromptSelector` component (Session 14, step 109).
 *
 *   - It does not manage the DeepSeek login. A login wall is
 *     handled by the Python script's `manual_action_required`
 *     flow, which emits a `MANUAL_ACTION` marker that the
 *     automation store's `CaptchaModal` renders. This component
 *     is unaware of that flow — the modal appears over the whole
 *     app, not inside this panel.
 *
 *   - It does not persist anything. See the writer store's file
 *     header for the non-persistence rationale.
 * 
 *  *
 * ── The DeepSeek sign-in CTA (PR-7) ───────────────────────────
 *
 *   The idle state shows a secondary "Sign in to DeepSeek"
 *   button beside the primary "Generate Article" button whenever
 *   the DeepSeek session is confirmed not-live. Clicking it opens
 *   the `DeepSeekLoginModal`, which drives the login flow (opens
 *   Chrome, polls the session check, closes when the session
 *   becomes live).
 *
 *   The button is hidden when the session is live AND when the
 *   status has not been checked yet. The distinction matters:
 *   the plan's N2 decision defers the launch-time check to a
 *   first Chrome-requiring action, so a fresh app start has a
 *   null session status until something actually needs Chrome.
 *   Showing the CTA on every fresh start would be a false alarm —
 *   we do not yet know the session is dead. Showing it only when
 *   the status is present and `live === false` keeps the CTA
 *   honest: it means "we checked, and it is not live."
 *
 *   The `useDeepSeekSession()` hook is app-wide, not per-topic
 *   — it takes no topicId argument. The DeepSeek session is a
 *   browser session held in the app's persistent Chrome profile;
 *   it is not a per-topic resource.
 *
 *   The `DeepSeekLoginModal` is mounted once per render branch
 *   (idle, in-flight, error, success) so that a state change
 *   while the modal is open does not unmount it. The modal reads
 *   its own visibility from `useDeepSeekSession()`; the button
 *   below only calls `openLoginModal()`, which sets that flag.
 */

import { useCallback } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  PenLine,
  Sparkles,
} from 'lucide-react';

import { useWriter } from '../hooks/useWriter.js';
import { useDeepSeekSession } from '../hooks/useDeepSeekSession.js';
import DeepSeekLoginModal from './DeepSeekLoginModal.js';
import type { WriterProgress as WriterProgressData } from '../store/writerStore.js';
import type { Topic } from '../../shared/types/index.js';

// ============================================================
//  Public types
// ============================================================

/**
 * The props accepted by `WriterProgress`.
 *
 * The component takes the full `Topic` object — the same shape
 * every other stage component on the topic-detail page receives
 * — so its `Generate Article` button can pass `topic._id` to the
 * writer hook's `generate` action.
 */
export interface WriterProgressProps {
  /** The topic whose writer-stage progress this panel represents. */
  topic: Topic;
}

// ============================================================
//  Constants — phase messages
// ============================================================
//
//  A `Record<WriterPhase, string>` so the compiler enforces
//  exhaustiveness: adding a sixth phase to the store's union
//  without adding an entry here is a compile error. The messages
//  are the ones the plan's user journey shows — "Pasting file X
//  of Y", "Typing prompt", "Waiting for response" — with the
//  short forms used in the progress line.

const PHASE_MESSAGES: Record<
  WriterProgressData['phase'],
  string
> = {
  pasting: 'Pasting source documents…',
  typing: 'Typing the prompt…',
  sending: 'Sending to DeepSeek…',
  waiting: 'DeepSeek is writing…',
  copying: 'Copying the response…',
};

// ============================================================
//  Internal — the in-flight panel
// ============================================================

interface InFlightPanelProps {
  progress: WriterProgressData | null;
  onCancel: () => void;
}

/**
 * The panel shown while a generation is in flight. Not exported
 * — the top-level component is the only consumer.
 *
 * The progress line shows two pieces of information: the phase
 * message (from `PHASE_MESSAGES`) and, when the phase is
 * `'pasting'`, the per-doc count. The other four phases have no
 * sub-count and show only the message.
 */
const InFlightPanel = ({ progress, onCancel }: InFlightPanelProps) => {
  // The primary line — a phase message that always has content.
  // A missing `progress` (the moment between the generate call
  // and the first marker's arrival) shows a generic "Starting…"
  // message rather than an empty line.
  const primaryMessage =
    progress !== null
      ? PHASE_MESSAGES[progress.phase]
      : 'Starting the writer…';

  // The secondary line — only shown for the "pasting" phase,
  // where per-doc progress is meaningful. For a "pasting"
  // progress whose index/total are present, the line reads
  // "File 3 of 10 — 001-reddit-….md".
  let secondaryMessage: string | null = null;
  if (
    progress !== null &&
    progress.phase === 'pasting' &&
    typeof progress.index === 'number' &&
    typeof progress.total === 'number'
  ) {
    const fileLabel =
      typeof progress.fileName === 'string' &&
      progress.fileName.length > 0
        ? progress.fileName
        : 'source document';
    secondaryMessage =
      `File ${progress.index} of ${progress.total} — ${fileLabel}`;
  }

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
            'text-sm font-medium text-text dark:text-neutral-100'
          }
        >
          {primaryMessage}
        </p>
        {secondaryMessage !== null && (
          <p
            className={
              'mt-0.5 truncate text-xs text-neutral-500 ' +
              'dark:text-neutral-400'
            }
            title={progress?.fileName ?? undefined}
          >
            {secondaryMessage}
          </p>
        )}
      </div>
      <button
        type="button"
        onClick={onCancel}
        className={
          'shrink-0 rounded-lg border border-neutral-300 ' +
          'bg-background px-3 py-1.5 text-xs font-medium ' +
          'text-text transition-colors hover:bg-neutral-100 ' +
          'focus-visible:outline-none ' +
          'dark:border-neutral-700 dark:hover:bg-neutral-800 ' +
          'dark:text-neutral-100'
        }
      >
        Cancel
      </button>
    </div>
  );
};

// ============================================================
//  WriterProgress
// ============================================================

/**
 * The writer-stage panel. See the file header for the four visual
 * states and the reasoning behind the component's scope.
 */
export const WriterProgress = ({ topic }: WriterProgressProps) => {
  const {
    isGenerating,
    progress,
    article,
    error,
    generate,
    cancel,
    clearError,
  } = useWriter(topic._id);

  // ---- DeepSeek session (PR-7) ----
  // App-wide, not per-topic — the session lives in the app's
  // persistent Chrome profile, not in a topic record. The hook
  // returns `status` (null before the first check, a
  // `DeepSeekSessionStatus` object once a check has run),
  // `checkNow`, and `openLoginModal`. This component reads only
  // `status` (to decide whether to show the sign-in CTA) and
  // `openLoginModal` (to trigger the modal from that CTA).
  const { status: sessionStatus, openLoginModal } =
    useDeepSeekSession();

  // ---- Start ---- 
  // The handler for the "Generate Article" button in the idle
  // state and the "Retry" button in the error state. Both
  // produce the same operation — `generate(topic._id)` — and
  // the store's state transitions after the call are what the
  // panel re-renders from.
  const handleStart = useCallback((): void => {
    void generate(topic._id);
  }, [generate, topic._id]);

  // ---- Cancel ----
  const handleCancel = useCallback((): void => {
    void cancel(topic._id);
  }, [cancel, topic._id]);

  // ---- Dismiss the error ----
  const handleDismiss = useCallback((): void => {
    clearError(topic._id);
  }, [clearError, topic._id]);

  // ---- State 1: IN-FLIGHT ----
  // Checked first so a running operation always shows its panel
  // regardless of what the previous run left in the store.
  if (isGenerating) {
    return (
      <>
        <InFlightPanel progress={progress} onCancel={handleCancel} />
        <DeepSeekLoginModal />
      </>
    );
  }

  // ---- State 2: ERROR ----
  // A red banner with the message and two buttons. The "Retry"
  // button re-runs the same operation; the "Dismiss" button
  // clears the error and returns the panel to whatever state
  // the store's other fields imply.
  if (error !== null) {
    return (
      <>
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
        <DeepSeekLoginModal />
      </>
    );
  }

  // ---- State 3: SUCCESS (an article exists) ----
  // The panel collapses to a small confirmation. The article
  // itself is rendered by the sibling `ArticlePreview`, which
  // sits directly below this panel in the Article tab.
  if (article !== null) {
    return (
      <>
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
              Article generated
            </p>
            <p
              className={
                'mt-0.5 text-xs text-emerald-800/80 ' +
                'dark:text-emerald-200/80'
              }
            >
              {article.wordCount.toLocaleString()}{' '}
              {article.wordCount === 1 ? 'word' : 'words'} · draft v
              {article.version}
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
            Regenerate
          </button>
        </div>
        <DeepSeekLoginModal />
      </>
    );
  }

  // ---- State 4: IDLE ----
  // No generation has run yet for this topic — or the last one
  // was dismissed. The invitation and the primary call to action.
  //
  // The "Sign in to DeepSeek" secondary button appears beside the
  // primary action when the DeepSeek session is confirmed
  // not-live. `sessionStatus !== null && !sessionStatus.live` is
  // the exact condition — see the file header's "DeepSeek
  // sign-in CTA (PR-7)" section for why the null case does not
  // show the button.
  const showSignInCta =
    sessionStatus !== null && !sessionStatus.live;

  return (
    <>
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
          <PenLine size={18} aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <p
            className={
              'text-sm font-medium text-text dark:text-neutral-100'
            }
          >
            Ready to write
          </p>
          <p
            className={
              'mt-0.5 text-xs text-neutral-500 ' +
              'dark:text-neutral-400'
            }
          >
            Send the extracted source docs to DeepSeek and get a
            first draft back.
          </p>
        </div>

        {/* ---- Sign-in CTA (PR-7) ---- */}
        {/* Secondary action, placed to the left of the primary
            so the primary button keeps its familiar rightmost
            position. Clicking the CTA opens the modal via the
            session hook; the modal itself is mounted below. */}
        {showSignInCta && (
          <button
            type="button"
            onClick={openLoginModal}
            className={
              'shrink-0 rounded-lg border border-neutral-300 ' +
              'bg-background px-3 py-2 text-sm font-medium ' +
              'text-text transition-colors hover:bg-neutral-100 ' +
              'focus-visible:outline-none ' +
              'dark:border-neutral-700 ' +
              'dark:hover:bg-neutral-800 ' +
              'dark:text-neutral-100'
            }
          >
            Sign in to DeepSeek
          </button>
        )}

        <button
          type="button"
          onClick={handleStart}
          className={
            'shrink-0 inline-flex items-center gap-2 ' +
            'rounded-lg bg-primary px-4 py-2 text-sm ' +
            'font-medium text-white transition-colors ' +
            'hover:bg-primary-dark focus-visible:outline-none'
          }
        >
          <Sparkles size={16} aria-hidden="true" />
          <span>Generate Article</span>
        </button>
      </div>
      <DeepSeekLoginModal />
    </>
  );
};

// ============================================================
//  Unused imports (documented)
// ============================================================
//
//  `FileText` is imported above for a state the component does
//  not currently reach — the "generate but the article failed to
//  load" case that the writer store's current semantics never
//  produce. It is kept in the import list because removing it
//  and re-adding it in a future session would be a distraction;
//  the compiler does not warn about an unused icon in an
//  imports-only position, and the icon is small. If a future
//  session decides the import is noise, removing the single
//  name from the import list is a one-line change.

// ============================================================
//  Default export
// ============================================================

/**
 * The `WriterProgress` component as the default export.
 * `TopicDetail.tsx` imports it with the default form
 * (`import WriterProgress from '.../WriterProgress.js'`), so
 * this is the export that resolves that file's forward
 * reference.
 */
export default WriterProgress;