/**
 * WriteSpeare — topic detail page.
 *
 * The pipeline view for a single topic. A user arrives here by
 * clicking a card on the Topics home page, or by navigating
 * directly to `/dashboard/topics/:id`. From here they drive the
 * topic through every stage of the pipeline — search, extraction,
 * writing, validation — and view or export the finished article.
 *
 * The layout is a tabbed pipeline. Four tabs, one per stage the
 * user interacts with:
 *
 *   Sources    — the search candidates found for this topic. The
 *                user reviews them, unchecks any they don't want,
 *                and clicks "Fetch Selected" to move to the
 *                extraction stage. The tab hosts <SearchProgress />
 *                (the live search panel and the "Start Search"
 *                action) and <SourceList /> (the candidate rows
 *                with checkboxes).
 *
 *   Documents  — the extracted `.md` files. One row per file, with
 *                word count, platform, and a preview button. The
 *                tab hosts <DocumentList />, which owns the
 *                preview modal internally.
 *
 *   Article    — the writer output. While the writer is running,
 *                this tab shows <WriterProgress />. When an
 *                article exists, it also shows <ArticlePreview />
 *                — a Markdown render with an Edit button, a
 *                Regenerate button, and an export dropdown in its
 *                header. Both components are stacked so the user
 *                can watch progress and read the current draft
 *                without changing tabs.
 *
 *   Report     — the validation report. Six panels — readability,
 *                SEO, keywords, originality, AI markers, grammar.
 *                The tab hosts <ValidationReport />, which owns
 *                the "Run Validation" action and the six-panel
 *                layout.
 *
 * Why tabs and not a wizard:
 *
 *   A wizard — a one-way flow with Back/Next buttons — would
 *   force the user through the pipeline in order every time. But
 *   the real usage pattern is iterative: a user reviews the
 *   article, notices a problem in the report, wants to add a
 *   source, runs extraction again, and re-checks. Tabs let them
 *   jump to any stage without losing their place or having to
 *   click Back several times to reach an earlier step. The user
 *   journey document explicitly calls this out in Stage 8 —
 *   "Any topic can be re-run at any stage" — and a tabbed layout
 *   is the direct expression of that.
 *
 * Tab state — local, and derived from status until the user
 * intervenes:
 *
 *   The active tab is a piece of purely ephemeral UI state. It is
 *   NOT stored in the topic store, and it is NOT persisted. Two
 *   behaviours fall out of that decision, both deliberate:
 *
 *     1. On the first render after the topic becomes available,
 *        the tab is DERIVED from the topic's pipeline status —
 *        see `getDefaultTab` below. A topic that is
 *        `researching` opens on Sources; one that is
 *        `completed` opens on Article. The user always lands on
 *        the stage that is most likely to be useful, without
 *        having to click anything.
 *
 *     2. Once the user clicks a tab, `activeTab` becomes a
 *        concrete value and stops following the status. The user
 *        is now driving; a background status update does not
 *        yank them to a different tab mid-read.
 *
 *   The distinction between "null" (never clicked — follow the
 *   status) and a concrete tab id (user has chosen) is
 *   represented by `activeTab: TabId | null`. When it is null,
 *   `getDefaultTab(topic.status)` supplies the displayed tab.
 *   When it is set, the store's `activeTab` wins.
 *
 *   Navigating away from this topic and back resets `activeTab`
 *   to null, because the component unmounts and remounts. That
 *   is correct — the user's tab choice was scoped to the visit,
 *   not to the topic.
 *
 * Data flow — the two navigation paths:
 *
 *   The page reads `activeTopic` from the topic store. Two paths
 *   lead here:
 *
 *     1. From the Topics list — the card's click handler calls
 *        `setActiveTopic(topic)` before navigating, so the store
 *        already holds the topic by the time this component
 *        mounts. The mount effect sees the store's `activeTopic._id`
 *        matching the route param `:id` and short-circuits; no
 *        network call.
 *
 *     2. Direct navigation (a deep link, a browser refresh, a
 *        bookmark) — the store is empty. The mount effect sees
 *        the mismatch and calls `loadTopic(id)`. While the fetch
 *        is in flight, the page renders a spinner; on success,
 *        the topic renders; on failure, the error branch shows.
 *
 *   The effect is deliberately conditional — it only fires when
 *   the store's topic does not already match the route param.
 *   Unconditionally calling `loadTopic(id)` on every mount would
 *   produce a redundant network round trip on every navigation
 *   from the Topics list, which is the common case.
 *
 * Four render branches:
 *
 *   The page has four terminal states, checked in order:
 *
 *     1. LOADING — no matching topic in the store AND the store's
 *        status is 'loading'. A centered spinner.
 *
 *     2. ERROR — the store's status is 'error' and we still do
 *        not have a matching topic. A red banner with the error
 *        message and a "Back to topics" button.
 *
 *     3. NOT FOUND — the store has settled (status 'idle') but
 *        its `activeTopic` is null or holds a different topic's
 *        id. A neutral panel with "Topic not found" and a "Back
 *        to topics" button.
 *
 *     4. LOADED — the store's `activeTopic._id` matches the route
 *        param. The header, tabs, and tab content render.
 *
 *   The order matters: the loading check must be first (a store
 *   that is loading but has no topic must not fall through to
 *   "not found"); the error check must be second (a store that
 *   failed must not fall through to "not found" and hide the
 *   reason).
 *
 * Forward references — this file is the integration point of the
 * topics feature:
 *
 *   The page is the app's gateway to the research, documents,
 *   writer, and validation features. Every one of those features
 *   contributes a component that renders inside a tab here, and
 *   every one of those components is created in a later session
 *   of the plan:
 *
 *     SearchProgress    — Session 10, step 79
 *     SourceList        — Session 10, step 80
 *     DocumentList      — Session 12, step 96
 *     WriterProgress    — Session 14, step 108
 *     ArticlePreview    — Session 14, step 110
 *     ValidationReport  — Session 16, step 124
 *
 *   Until those files exist, the imports below produce six
 *   `TS2307` errors. This is the same forward-reference shape
 *   that Sessions 4, 5, and 6 have already established — see
 *   `App.tsx`, `Layout.tsx`, `Sidebar.tsx`, and the various
 *   feature pages — and it is the correct pattern. The
 *   alternative, stubbing the components with placeholders so
 *   the file compiles today, would violate the execution
 *   protocol's "no placeholder files" rule and would have to be
 *   replaced anyway when the real components land.
 *
 *   Because this file is created BEFORE the stage components
 *   (Session 7 vs. Sessions 10, 12, 14, 16), the prop interface
 *   is owned here: each stage component is expected to accept a
 *   `topic: Topic` prop when it is created. If a future session
 *   discovers that a stage component needs an additional prop —
 *   say, an `onNavigate` callback or a `readonly` flag — the
 *   change lands in this file at the same time as the stage
 *   component, keeping the interface in sync.
 *
 * What this page does NOT do:
 *
 *   - It does not run the search, extraction, writer, validation,
 *     or export operations directly. Each of those actions is
 *     owned by the corresponding feature's hook (`useResearch`,
 *     `useDocuments`, `useWriter`, `useValidation`, `useExport`),
 *     and the stage components that render inside each tab call
 *     those hooks themselves. This page composes the tabs; it
 *     does not orchestrate the pipeline stages.
 *
 *   - It does not gate stages. A user can, in principle, open the
 *     Report tab before running validation — the tab shows the
 *     "no report yet" state and offers to run one. The page does
 *     not prevent that; the pipeline's real ordering constraints
 *     are enforced by the individual stage components (the
 *     writer cannot run without documents; validation cannot run
 *     without an article) and by the backend's status
 *     transitions.
 *
 *   - It does not persist the active tab. See the discussion
 *     above for why this is deliberate.
 *
 *   - It does not manage the topic's lifecycle. Deleting the
 *     topic, duplicating it, or editing its metadata are actions
 *     on the Topics list page — this page is the read-and-run
 *     view for a topic that already exists.
 *
 *   - It does not render the export menu directly. The
 *     `ExportMenu` component (Session 17) is rendered by
 *     `ArticlePreview`, not by this page — the export affordance
 *     belongs next to the article, not at the page level. The
 *     tabs the user interacts with here are the pipeline stages;
 *     export is an action on the article, and it lives with the
 *     article.
 */

import {
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  AlertCircle,
  ArrowLeft,
  FileSearch,
  FileText,
  Loader2,
  PenLine,
  ShieldCheck,
  type LucideIcon,
} from 'lucide-react';

import { useTopics } from '../hooks/useTopics.js';

// ============================================================
//  Forward references — stage components
// ============================================================
//
//  Each of the six imports below resolves to a file that is
//  created in a later session of the plan. Until that file
//  exists, the import produces a TS2307 ("Cannot find module")
//  error. That is EXPECTED and is documented in the file header.
//
//  The imports are grouped with their owning session number in a
//  trailing comment so that a reader who sees a TS2307 on one of
//  these lines knows exactly which session resolves it.

import SearchProgress from '../../research/components/SearchProgress.js'; // Session 10, step 79
import SourceList from '../../research/components/SourceList.js'; // Session 10, step 80
import DocumentList from '../../documents/components/DocumentList.js'; // Session 12, step 96
import WriterProgress from '../../writer/components/WriterProgress.js'; // Session 14, step 108
import ArticlePreview from '../../writer/components/ArticlePreview.js'; // Session 14, step 110
import ValidationReport from '../../validation/components/ValidationReport.js'; // Session 16, step 124

import type { Topic, TopicStatus } from '../../shared/types/index.js';

// ============================================================
//  Public types
// ============================================================

/**
 * The props accepted by `TopicDetail`. Currently empty — the page
 * takes no props and derives everything from the route param and
 * the topic store.
 *
 * The interface is declared anyway so that a future addition (for
 * example, an `initialTab` prop for a programmatic deep link that
 * wants to open a specific stage) has a named, exported home.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface TopicDetailProps {
  // Reserved for future additions. See file header.
}

// ============================================================
//  Tab definitions
// ============================================================

/**
 * The four stage identifiers. A string-literal union rather than
 * an enum — the values are used as React keys and (potentially)
 * as part of a future URL query string for tab persistence, and
 * a plain string is the natural representation for both.
 */
type TabId = 'sources' | 'documents' | 'article' | 'report';

/**
 * The shape of one tab's static metadata. The `icon` field is
 * typed as `LucideIcon` — the same type the codebase's other
 * icon-bearing tables use — so that swapping an icon is a change
 * to this one table, not a change to the render code.
 */
interface TabDefinition {
  readonly id: TabId;
  readonly label: string;
  readonly icon: LucideIcon;
}

/**
 * The tab table, in display order. Declared as a
 * `readonly TabDefinition[]` so the array is not mutated by any
 * consumer and the compiler enforces the field types.
 *
 * The order matches the pipeline's logical progression —
 * Sources, Documents, Article, Report — so the visual left-to-
 * right reading of the tab bar is also the pipeline's sequence.
 */
const TABS: readonly TabDefinition[] = [
  { id: 'sources', label: 'Sources', icon: FileSearch },
  { id: 'documents', label: 'Documents', icon: FileText },
  { id: 'article', label: 'Article', icon: PenLine },
  { id: 'report', label: 'Report', icon: ShieldCheck },
];

// ============================================================
//  Status → default tab
// ============================================================

/**
 * Map a topic's pipeline status to the tab that is most likely
 * to be useful when the user first lands on this page.
 *
 * The mapping is grounded in the pipeline's own semantics:
 *
 *   - `draft`        — no work has started. Sources is where the
 *                      user clicks "Start Search", so it is the
 *                      natural landing point.
 *   - `researching`  — search is in flight. Sources shows the
 *                      live progress.
 *   - `extracting`   — extraction is in flight. Sources still
 *                      owns the progress panel (the extraction
 *                      panel lives inside the same stage flow).
 *   - `extracted`    — documents are ready. Documents is where
 *                      the user reviews what was fetched.
 *   - `writing`      — the writer is running. Article shows the
 *                      live progress.
 *   - `validating`   — validation is running. Report shows the
 *                      live progress.
 *   - `completed`    — everything is done. Article is the
 *                      finished output the user wants to read.
 *   - `failed`       — something broke. Sources is the safest
 *                      default; the user can inspect earlier
 *                      stages to diagnose.
 *
 * The function is total over `TopicStatus` — every member of the
 * union is handled by a case. If a future session adds a status
 * to the union, TypeScript's exhaustiveness checking will report
 * a "not all code paths return a value" error here, which is the
 * correct prompt to extend the switch.
 */
const getDefaultTab = (status: TopicStatus): TabId => {
  switch (status) {
    case 'researching':
    case 'extracting':
      return 'sources';
    case 'extracted':
      return 'documents';
    case 'writing':
    case 'completed':
      return 'article';
    case 'validating':
      return 'report';
    case 'draft':
    case 'failed':
      return 'sources';
  }
};

// ============================================================
//  Status badge
// ============================================================

/**
 * Human-readable labels for each pipeline status. Rendered inside
 * the status badge in the page header so the user can see at a
 * glance where the topic is.
 *
 * `Record<TopicStatus, string>` rather than a plain object so the
 * compiler enforces exhaustiveness — adding a status to the union
 * without adding a label here is a compile error, not a runtime
 * `undefined`.
 */
const STATUS_LABELS: Record<TopicStatus, string> = {
  draft: 'Draft',
  researching: 'Researching',
  extracting: 'Extracting',
  extracted: 'Extracted',
  writing: 'Writing',
  validating: 'Validating',
  completed: 'Completed',
  failed: 'Failed',
};

/**
 * Tailwind class sets for the status badge. Same exhaustiveness
 * guarantee as `STATUS_LABELS`.
 *
 * The color mapping is semantic:
 *   - draft        → neutral (no activity yet)
 *   - researching  → sky (a read-only phase in flight)
 *   - extracting   → sky (same reason)
 *   - extracted    → sky (a checkpoint, not yet done)
 *   - writing      → amber (a write phase in flight)
 *   - validating   → amber (a write phase in flight)
 *   - completed    → emerald (done)
 *   - failed       → red (a problem)
 */
const STATUS_CLASSES: Record<TopicStatus, string> = {
  draft:
    'bg-neutral-100 text-neutral-700 ' +
    'dark:bg-neutral-800 dark:text-neutral-300',
  researching:
    'bg-sky-100 text-sky-800 ' +
    'dark:bg-sky-950 dark:text-sky-200',
  extracting:
    'bg-sky-100 text-sky-800 ' +
    'dark:bg-sky-950 dark:text-sky-200',
  extracted:
    'bg-sky-100 text-sky-800 ' +
    'dark:bg-sky-950 dark:text-sky-200',
  writing:
    'bg-amber-100 text-amber-800 ' +
    'dark:bg-amber-950 dark:text-amber-200',
  validating:
    'bg-amber-100 text-amber-800 ' +
    'dark:bg-amber-950 dark:text-amber-200',
  completed:
    'bg-emerald-100 text-emerald-800 ' +
    'dark:bg-emerald-950 dark:text-emerald-200',
  failed:
    'bg-red-100 text-red-800 ' +
    'dark:bg-red-950 dark:text-red-200',
};

// ============================================================
//  Internal: StatusBadge
// ============================================================

/**
 * The status badge rendered in the page header next to the topic
 * title. Not exported — it has no consumer outside this file.
 */
const StatusBadge = ({ status }: { status: TopicStatus }) => (
  <span
    className={
      'inline-flex items-center rounded-full px-2 py-0.5 ' +
      'text-xs font-medium ' +
      STATUS_CLASSES[status]
    }
  >
    {STATUS_LABELS[status]}
  </span>
);

// ============================================================
//  Internal: TabButton
// ============================================================

interface TabButtonProps {
  tab: TabDefinition;
  active: boolean;
  onSelect: (id: TabId) => void;
}

/**
 * One button in the tab bar. The active state is expressed both
 * visually (a `border-primary` underline) and semantically
 * (`aria-selected="true"` on the button, `role="tab"` on the
 * button's role), so an assistive technology announces the
 * current stage correctly.
 */
const TabButton = ({ tab, active, onSelect }: TabButtonProps) => {
  const Icon = tab.icon;

  const handleClick = (): void => {
    onSelect(tab.id);
  };

  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={handleClick}
      className={
        'flex items-center gap-2 border-b-2 px-4 py-3 text-sm ' +
        'font-medium transition-colors focus-visible:outline-none ' +
        (active
          ? 'border-primary text-primary'
          : 'border-transparent text-neutral-500 ' +
            'hover:border-neutral-300 hover:text-neutral-700 ' +
            'dark:text-neutral-400 dark:hover:border-neutral-600 ' +
            'dark:hover:text-neutral-200')
      }
    >
      <Icon size={16} aria-hidden="true" />
      <span>{tab.label}</span>
    </button>
  );
};

// ============================================================
//  Internal: renderTabContent
// ============================================================

/**
 * Render the currently-selected tab's content.
 *
 * A module-level function rather than a component so the tab
 * table above and the switch below are the only two places the
 * four stage names appear — a reader who wants to know "what
 * renders inside the Documents tab?" has exactly one answer to
 * find.
 *
 * Each branch passes the FULL topic object rather than just the
 * id. The stage components need different subsets of the topic's
 * fields — the search flow needs `title` and `keywords`, the
 * writer needs `wordCount` and `promptFile`, the export flow
 * needs `title` for the default filename — and passing the whole
 * object keeps the interface uniform across all six components.
 * See the file header for the rationale on why this file owns
 * that interface (it is created before the stage components).
 */
const renderTabContent = (topic: Topic, tab: TabId): ReactNode => {
  switch (tab) {
    case 'sources':
      return (
        <div className="space-y-6">
          <SearchProgress topic={topic} />
          <SourceList topic={topic} />
        </div>
      );
    case 'documents':
      return <DocumentList topic={topic} />;
    case 'article':
      return (
        <div className="space-y-6">
          <WriterProgress topic={topic} />
          <ArticlePreview topic={topic} />
        </div>
      );
    case 'report':
      return <ValidationReport topic={topic} />;
  }
};

// ============================================================
//  TopicDetail
// ============================================================

/**
 * The topic detail page. See the file header for the page's
 * responsibilities, its four render branches, and the reasoning
 * behind the tab structure and the derived-default-tab model.
 */
export const TopicDetail = (_props: TopicDetailProps = {}) => {
  const params = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { activeTopic, status, error, loadTopic } = useTopics();

  /**
   * The route's `:id` parameter. `useParams` types it as
   * `string | undefined` because the route pattern's `:id`
   * segment could theoretically be absent if the router matched
   * a different route — the guard below narrows the value before
   * any use.
   */
  const topicId = params['id'];

  /**
   * The user's tab selection, or `null` when the user has not yet
   * clicked a tab on this visit. See the file header for why the
   * distinction between `null` and a concrete value matters.
   */
  const [activeTab, setActiveTab] = useState<TabId | null>(null);

  // ---- Load the topic if the store does not already hold it ----
  //
  // The effect fires on mount and on any change to the three
  // inputs. The two early-return guards implement the "don't
  // refetch what we already have" rule:
  //
  //   1. No route param — nothing to load; the render branches
  //      below handle the missing id.
  //   2. The store already holds a topic whose `_id` matches the
  //      route param — the common case when navigating from the
  //      Topics list. Nothing to do.
  //
  // The `void` on the `loadTopic` call discards the returned
  // promise; the store's `status` field is what the render reacts
  // to, and this effect has no further work to do when the
  // promise resolves.
  useEffect(() => {
    if (!topicId) {
      return;
    }
    if (activeTopic !== null && activeTopic._id === topicId) {
      return;
    }
    void loadTopic(topicId);
  }, [topicId, activeTopic, loadTopic]);

  // ---- Back navigation ----
  //
  // The only navigation this page performs on its own is the back
  // button. Stage-specific navigations (say, "open this document's
  // preview") are owned by the stage components themselves.
  const handleBack = (): void => {
    navigate('/dashboard/topics');
  };

  // ---- Resolve the displayed tab ----
  //
  // If the user has clicked a tab this visit, use their choice.
  // Otherwise, derive the default from the loaded topic's status.
  // See the file header for the full rationale.
  //
  // The resolution happens against the LOADED topic below, since
  // the derived branch needs a topic to read the status from.
  // The three non-loaded branches do not need a tab id.

  // ---- Branch 1: loading ----
  //
  // The store is loading AND we do not have a matching topic yet.
  // The `activeTopic._id !== topicId` check is what keeps a
  // background refresh (which flips `status` to 'loading' while
  // the existing topic is still in the store) from hiding the
  // page behind a spinner.
  const isInitialLoad =
    status === 'loading' &&
    (activeTopic === null || activeTopic._id !== topicId);

  if (isInitialLoad) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2
          size={28}
          className="animate-spin text-primary"
          aria-hidden="true"
        />
        <span className="sr-only">Loading topic…</span>
      </div>
    );
  }

  // ---- Branch 2: error ----
  //
  // The store reports an error AND we still do not have a matching
  // topic. Once a topic is loaded, a subsequent error from a
  // background refresh does not hide the page — it is up to the
  // individual stage components to surface their own errors.
  const isUnrecoverableError =
    status === 'error' &&
    (activeTopic === null || activeTopic._id !== topicId);

  if (isUnrecoverableError) {
    return (
      <div
        role="alert"
        className={
          'mx-auto mt-12 flex max-w-lg flex-col items-center gap-3 ' +
          'rounded-xl border border-red-200 bg-red-50 p-6 text-center ' +
          'dark:border-red-900 dark:bg-red-950/60'
        }
      >
        <AlertCircle
          size={24}
          className="text-red-600 dark:text-red-400"
          aria-hidden="true"
        />
        <p className="text-sm text-red-900 dark:text-red-100">
          {error ?? 'Unable to load topic.'}
        </p>
        <button
          type="button"
          onClick={handleBack}
          className={
            'rounded-lg bg-red-600 px-4 py-2 text-sm font-medium ' +
            'text-white transition-colors hover:bg-red-700 ' +
            'focus-visible:outline-none'
          }
        >
          Back to topics
        </button>
      </div>
    );
  }

  // ---- Branch 3: not found ----
  //
  // The store has settled (status is 'idle') but `activeTopic` is
  // null or holds a different topic's id. This is the state a user
  // reaches by typing an arbitrary id into the URL — the backend
  // returned a 404 (or the initial load never ran because the
  // route param was empty), and the store has not populated
  // `activeTopic`. The message is neutral rather than an error
  // because "the topic you asked for does not exist" is a
  // legitimate answer, not a failure.
  if (activeTopic === null || activeTopic._id !== topicId) {
    return (
      <div
        className={
          'mx-auto mt-12 flex max-w-lg flex-col items-center gap-3 ' +
          'rounded-xl border border-neutral-200 bg-background p-6 ' +
          'text-center dark:border-neutral-800'
        }
      >
        <p className="text-sm text-neutral-600 dark:text-neutral-300">
          Topic not found.
        </p>
        <button
          type="button"
          onClick={handleBack}
          className={
            'rounded-lg bg-primary px-4 py-2 text-sm font-medium ' +
            'text-white transition-colors hover:bg-primary-dark ' +
            'focus-visible:outline-none'
          }
        >
          Back to topics
        </button>
      </div>
    );
  }

  // ---- Branch 4: loaded ----
  //
  // At this point `activeTopic` is non-null and matches the route
  // param. The tab is resolved here — either the user's choice
  // (`activeTab !== null`) or the status-derived default.
  const displayedTab: TabId =
    activeTab !== null
      ? activeTab
      : getDefaultTab(activeTopic.status);

  return (
    <div className="flex h-full flex-col">
      {/* ---- Header ---- */}
      {/* The header carries the back button, the topic title, and
          a compact metadata row: status badge, keyword count,
          source-count target, word-count target. Everything the
          user needs to confirm "this is the topic I meant to
          open" without scrolling. The header is fixed
          (`shrink-0`) so a long tab body scrolls beneath it. */}
      <header
        className={
          'shrink-0 border-b border-neutral-200 bg-background ' +
          'dark:border-neutral-800'
        }
      >
        <div className="mx-auto flex w-full max-w-6xl items-center gap-3 px-6 pt-4">
          <button
            type="button"
            onClick={handleBack}
            aria-label="Back to topics"
            className={
              'shrink-0 rounded-md p-1 text-neutral-500 ' +
              'transition-colors hover:bg-neutral-100 ' +
              'hover:text-neutral-800 ' +
              'dark:text-neutral-400 dark:hover:bg-neutral-800 ' +
              'dark:hover:text-neutral-100 focus-visible:outline-none'
            }
          >
            <ArrowLeft size={18} aria-hidden="true" />
          </button>

          <div className="min-w-0 flex-1">
            <h1 className="truncate text-lg font-semibold text-text dark:text-neutral-100">
              {activeTopic.title}
            </h1>
            <div
              className={
                'mt-1 flex flex-wrap items-center gap-2 ' +
                'text-xs text-neutral-500 dark:text-neutral-400'
              }
            >
              <StatusBadge status={activeTopic.status} />
              <span aria-hidden="true">·</span>
              <span>{activeTopic.keywords.length} keywords</span>
              <span aria-hidden="true">·</span>
              <span>{activeTopic.sourceCount} sources target</span>
              <span aria-hidden="true">·</span>
              <span>{activeTopic.wordCount} words target</span>
            </div>
          </div>
        </div>

        {/* ---- Tab bar ---- */}
        {/* `role="tablist"` on the nav, `role="tab"` on each
            button, `aria-selected` reflecting the current tab.
            The bar sits at the bottom edge of the header so the
            active-tab underline reads as a continuation of the
            header's own bottom border. */}
        <nav
          role="tablist"
          aria-label="Pipeline stages"
          className="mx-auto flex w-full max-w-6xl gap-1 px-6"
        >
          {TABS.map((tab) => (
            <TabButton
              key={tab.id}
              tab={tab}
              active={tab.id === displayedTab}
              onSelect={setActiveTab}
            />
          ))}
        </nav>
      </header>

      {/* ---- Tab content ---- */}
      {/* `min-h-0` is required so that a child with a height
          constraint (a document preview modal, a scrollable
          report panel) can shrink below its content height inside
          the flex column. Without it, the flex layout would
          expand to fit the child's content, and `overflow-y-auto`
          below would never actually scroll. */}
      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-6xl px-6 py-6">
          {renderTabContent(activeTopic, displayedTab)}
        </div>
      </main>
    </div>
  );
};

// ============================================================
//  Default export
// ============================================================

/**
 * The `TopicDetail` component as the default export. The router
 * in `renderer/App.tsx` imports it with the default form
 * (`import TopicDetail from '.../TopicDetail.js'`), so this is
 * the export that keeps the route tree resolving.
 */
export default TopicDetail;