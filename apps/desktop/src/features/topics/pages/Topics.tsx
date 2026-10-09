/**
 * WriteSpeare — topics home page.
 *
 * This is the app's default authenticated view — the screen a
 * signed-in user lands on immediately after logging in, and the
 * one they see every time they open the app with an active
 * session. It has one job: show the user's topics, and give them
 * a way to create a new one.
 *
 * The page has four visual states, driven by the store's `status`
 * and `error` fields and by whether the `topics` array is empty:
 *
 *   1. Loading      — `status === 'loading'` and no topics are
 *                     currently shown. A centered spinner.
 *
 *   2. Error        — `status === 'error'`. A banner with the
 *                     error message and a "Try again" button that
 *                     re-runs `loadTopics()`.
 *
 *   3. Empty        — `status === 'idle'` and `topics.length === 0`.
 *                     A friendly empty state with a call to
 *                     action that opens the New Topic modal.
 *
 *   4. Populated    — `status === 'idle'` and `topics.length > 0`.
 *                     A responsive grid of `<TopicCard />`.
 *
 * The distinction between (1) and (3) matters: a list that is
 * empty while a fetch is in progress is not the same as a list
 * that is empty because the user has no topics. The former should
 * show a spinner; the latter should invite the user to create
 * their first topic. This page keys off `status === 'loading'`
 * for the spinner, not off `topics.length === 0`.
 *
 * What the page does NOT do:
 *
 *   - It does not open the topic's detail view. That is the
 *     `<TopicCard />`'s job — the card renders a link (or a
 *     button that navigates) to `/dashboard/topics/:id`. The
 *     page composes the cards into a grid and stops there.
 *
 *   - It does not delete or duplicate topics. Those operations
 *     are invoked from the card's own menu — the card has the
 *     topic object in hand and the actions are colocated with
 *     it. The page's role is to render the list, not to mediate
 *     every operation a topic can undergo.
 *
 *   - It does not paginate. The plan's topics endpoint returns
 *     the user's full list, and the plan does not describe a
 *     paginated view. A user with hundreds of topics would see
 *     all of them; if a future session wants pagination, the
 *     correct change is a new endpoint parameter and a pager
 *     component, not a change to this page's layout.
 *
 *   - It does not filter. The topics API accepts an optional
 *     `?status=` filter, and the store's `loadTopics` forwards
 *     it, but the plan does not describe a filter UI on the
 *     home page. If a future session adds one, the state for
 *     the current filter lives here and the fetch call grows
 *     the argument.
 *
 * The empty-state copy:
 *
 *   The empty state invites the user to create their first
 *   topic with a short prompt — "Create your first topic" —
 *   and a button that opens the same New Topic modal the
 *   header button opens. The design uses the same primary
 *   color and the same iconography as the rest of the app, so
 *   the empty state reads as part of the product rather than as
 *   a placeholder screen.
 *
 * Modal ownership:
 *
 *   The `NewTopicModal` is a controlled child of this page —
 *   the page owns the boolean that determines whether it is
 *   open, and the modal reports back through `onClose` when
 *   the user dismisses it or completes the create flow. This
 *   mirrors the pattern of `Sidebar` in `Layout` (the parent
 *   owns the state, the child is presentational), and it means
 *   the page can open the modal from two places (the header
 *   button and the empty-state button) without threading an
 *   imperative API through a ref.
 *
 *   If a future session wants to open the modal from a
 *   component outside this page, the correct change is to
 *   promote the modal to an imperative API (via the modal
 *   context that `shared/components/Modal.tsx` already
 *   provides) — but the two-call-sites-in-one-page case does
 *   not justify that yet.
 *
 * Forward references:
 *
 *   This file imports `TopicCard` and `NewTopicModal` from the
 *   siblings `../components/TopicCard.js` and
 *   `../components/NewTopicModal.js`. Both are scheduled for
 *   later steps in this session (#58 and #59 respectively) and
 *   do not exist yet. Their absence produces two `TS2307`
 *   errors on the import lines until they are created. This is
 *   the same forward-reference pattern that appeared in
 *   Session 5 (Sidebar and Layout waiting on `useAuth`) and in
 *   Session 4 (App.tsx waiting on every feature page).
 */

import { useEffect, useState } from 'react';
import {
  AlertCircle,
  FileText,
  Loader2,
  Plus,
} from 'lucide-react';

import { useTopics } from '../hooks/useTopics.js';
import TopicCard from '../components/TopicCard.js';
import NewTopicModal from '../components/NewTopicModal.js';

// ============================================================
//  Public types
// ============================================================

/**
 * The props accepted by `Topics`. Currently empty — the page
 * takes no props and derives everything from the store and the
 * router context.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface TopicsProps {
  // Reserved for future additions. See file header.
}

// ============================================================
//  Topics
// ============================================================

/**
 * The topics home page. See the file header for the page's four
 * visual states, its scope, and the reasoning behind the modal
 * ownership and the empty-state design.
 */
export const Topics = (_props: TopicsProps = {}) => {
  const { topics, status, error, loadTopics } = useTopics();

  // Whether the New Topic modal is currently open. Owned here
  // and passed to the modal as a controlled prop — see the file
  // header for the reasoning.
  const [isNewTopicModalOpen, setIsNewTopicModalOpen] = useState(false);

  // ---- Initial fetch ----
  // Load the user's topics on mount. The empty dependency array
  // means this runs once per mount of the Topics page. Navigating
  // between topics and their detail views unmounts and remounts
  // this page each time, so a subsequent visit re-fetches — a
  // deliberate choice for the current design. The store is not
  // persisted and the backend is the source of truth for the
  // list, so a fresh fetch on every mount keeps the view in sync
  // with whatever changes might have happened elsewhere.
  //
  // The `void` on the call discards the promise; the store's
  // `status` field is what the render reacts to, and the caller
  // has no further work to do when the promise resolves.
  useEffect(() => {
    void loadTopics();
  }, [loadTopics]);

  // ---- Modal handlers ----

  const openNewTopicModal = (): void => {
    setIsNewTopicModalOpen(true);
  };

  const closeNewTopicModal = (): void => {
    setIsNewTopicModalOpen(false);
  };

  // ---- Render ----
  return (
    <div className="mx-auto flex h-full w-full max-w-6xl flex-col px-6 py-8">
      {/* ---- Header ---- */}
      <header className="mb-8 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-text dark:text-neutral-100">
            Topics
          </h1>
          <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
            Research, write, and validate your articles.
          </p>
        </div>

        <button
          type="button"
          onClick={openNewTopicModal}
          className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-primary-dark focus-visible:outline-none"
        >
          <Plus size={18} aria-hidden="true" />
          <span>New Topic</span>
        </button>
      </header>

      {/* ---- Body ---- */}
      <div className="flex-1">
        <TopicsBody
          topics={topics}
          status={status}
          error={error}
          onRetry={() => void loadTopics()}
          onNewTopic={openNewTopicModal}
        />
      </div>

      {/* ---- New Topic modal ---- */}
      <NewTopicModal
        open={isNewTopicModalOpen}
        onClose={closeNewTopicModal}
      />
    </div>
  );
};

// ============================================================
//  TopicsBody — internal view
// ============================================================
//
//  The four visual states (loading, error, empty, populated) are
//  expressed as a small internal component rather than as a
//  sequence of ternaries in the page's JSX. The split keeps the
//  page's return value to two sections (header, body) and lets
//  the body's rendering be read as a flat sequence of
//  `if`-style early returns.

interface TopicsBodyProps {
  topics: ReturnType<typeof useTopics>['topics'];
  status: ReturnType<typeof useTopics>['status'];
  error: ReturnType<typeof useTopics>['error'];
  onRetry: () => void;
  onNewTopic: () => void;
}

const TopicsBody = ({
  topics,
  status,
  error,
  onRetry,
  onNewTopic,
}: TopicsBodyProps) => {
  // ---- 1. Loading ----
  // Shown when a fetch is in flight and there are no topics to
  // display. If topics are already loaded (a re-fetch is in
  // progress), the existing list is shown instead — see the
  // populated branch below.
  if (status === 'loading' && topics.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2
          size={28}
          className="animate-spin text-primary"
          aria-hidden="true"
        />
        <span className="sr-only">Loading topics…</span>
      </div>
    );
  }

  // ---- 2. Error ----
  // Shown when the last fetch failed. The banner carries the
  // error message the store captured; the button re-runs the
  // fetch.
  if (status === 'error' && error) {
    return (
      <div
        role="alert"
        className="mx-auto flex max-w-lg flex-col items-center gap-3 rounded-xl border border-red-200 bg-red-50 p-6 text-center dark:border-red-900 dark:bg-red-950/60"
      >
        <AlertCircle
          size={24}
          className="text-red-600 dark:text-red-400"
          aria-hidden="true"
        />
        <p className="text-sm text-red-900 dark:text-red-100">{error}</p>
        <button
          type="button"
          onClick={onRetry}
          className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-700 focus-visible:outline-none"
        >
          Try again
        </button>
      </div>
    );
  }

  // ---- 3. Empty ----
  // Shown when the fetch succeeded but the user has no topics.
  // The call to action opens the same modal the header button
  // opens.
  if (topics.length === 0) {
    return (
      <div className="mx-auto flex max-w-md flex-col items-center gap-4 py-16 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
          <FileText size={28} aria-hidden="true" />
        </div>
        <div>
          <h2 className="text-lg font-semibold text-text dark:text-neutral-100">
            No topics yet
          </h2>
          <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
            Create your first topic to start the research and
            writing pipeline.
          </p>
        </div>
        <button
          type="button"
          onClick={onNewTopic}
          className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-primary-dark focus-visible:outline-none"
        >
          <Plus size={18} aria-hidden="true" />
          <span>New Topic</span>
        </button>
      </div>
    );
  }

  // ---- 4. Populated ----
  // A responsive grid of topic cards. The grid collapses to one
  // column on narrow windows and expands to two or three columns
  // on wider ones — the app runs at a minimum of 1024 px per the
  // window's minWidth setting, which comfortably fits two
  // columns, and can expand to three on a large monitor.
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {topics.map((topic) => (
        <TopicCard key={topic._id} topic={topic} />
      ))}
    </div>
  );
};

// ============================================================
//  Default export
// ============================================================

/**
 * The `Topics` component as the default export. `renderer/App.tsx`
 * imports this with the default form
 * (`import Topics from '.../Topics.js'`), so this is the export
 * that keeps the route tree resolving.
 */
export default Topics;