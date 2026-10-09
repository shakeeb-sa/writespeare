/**
 * WriteSpeare — topic card.
 *
 * One card in the topics grid. Renders the topic's title, its
 * current pipeline status, a compact metadata row (source target,
 * word target, relative age), an optional preview of its keywords,
 * and a three-button action bar.
 *
 * The card is the user's entry point into a topic. Two ways to
 * open it:
 *
 *   1. Click the card body (anywhere in the title / metadata /
 *      keyword area). The card body is a keyboard-focusable,
 *      `role="button"` region — pressing Enter or Space opens the
 *      topic the same way a click does.
 *
 *   2. Click the "Open" button in the action bar.
 *
 * Both paths call the same handler. The handler does two things,
 * in order: writes the topic into the store via `setActiveTopic`
 * (so the detail page does not have to refetch it), then
 * navigates to `/dashboard/topics/:id`. The `setActiveTopic`
 * call is what makes the navigation instant — the detail page's
 * mount effect sees the store already holds a matching topic and
 * short-circuits its `loadTopic` call. Without it, every open
 * would pay for a redundant round trip.
 *
 * The Duplicate action:
 *
 *   Calls `duplicateTopic(topic)` from the store, which builds a
 *   `TopicCreatePayload` from the original's configuration fields
 *   (with " (copy)" appended to the title), POSTs it to the
 *   backend, and prepends the new topic to the list. The card
 *   does NOT navigate to the duplicate — the new card appears at
 *   the top of the grid because the store prepends, and the user
 *   can see it appear without losing their place in the list. A
 *   toast confirms the action.
 *
 *   The `duplicateTopic` action returns the created `Topic | null`
 *   — null on failure. The card uses the truthiness of that
 *   return value to pick between a success toast and an error
 *   toast. The store's `error` field already carries a
 *   human-readable message on failure; the card could read that
 *   directly, but using the return value keeps the two branches
 *   co-located with the call that produced them.
 *
 * The Delete action:
 *
 *   Opens a confirmation modal rather than deleting immediately.
 *   Deletion is irreversible from the UI's perspective (there is
 *   no undo path), and an accidental click on a card's Delete
 *   button — the button is directly adjacent to Duplicate — is a
 *   realistic failure mode. The modal is the standard
 *   confirmation pattern: a short prompt naming the topic, a
 *   Cancel button, and a red Delete button.
 *
 *   The modal is opened through the imperative `useModal()` API
 *   rather than the declarative `<Modal>` component because the
 *   card has no need to hold the modal's open state in React —
 *   the modal lives only as long as the confirmation does. Using
 *   the imperative form keeps the card's own state to a minimum.
 *
 *   On confirmation, the card calls `deleteTopic(topic._id)`.
 *   The store removes the topic from the list on success and the
 *   card unmounts (React drops it from the grid because the
 *   parent's `topics.map` no longer yields it). A toast confirms.
 *
 * Status badge — why this file duplicates the label and class
 * tables declared in TopicDetail.tsx:
 *
 *   `TopicDetail.tsx` declares its own `STATUS_LABELS` and
 *   `STATUS_CLASSES` maps plus a `StatusBadge` component, and
 *   this file declares its own copies of the same. The
 *   duplication is forced by the plan: the plan's file tree
 *   declares no shared status component, and the two files live
 *   in different feature folders (`topics/pages/` vs.
 *   `topics/components/`) with no natural common parent for a
 *   shared module. The alternative — importing the `StatusBadge`
 *   from `TopicDetail.tsx` into `TopicCard.tsx` — would invert
 *   the dependency direction (a card is a leaf of the page, not
 *   a consumer of it) and would couple two independent
 *   presentation modules.
 *
 *   The duplication is bounded: two `Record<TopicStatus, string>`
 *   maps and a six-line component. If a future session adds a
 *   ninth status to the union, both files must be updated, and
 *   the compiler enforces that — the `Record<TopicStatus, ...>`
 *   type rejects a map with a missing key. So the drift risk is
 *   caught at compile time, not at runtime.
 *
 * What this card does NOT do:
 *
 *   - It does not fetch or own the topic. The `topic` prop is
 *     supplied by the parent (`Topics.tsx`'s grid), which reads
 *     the list from the store. The card is a pure presentation
 *     of one item.
 *
 *   - It does not manage the topics list. Adding the duplicate,
 *     removing the deleted topic, and updating the loading state
 *     are all store concerns; the card only calls the store's
 *     actions and reads their results.
 *
 *   - It does not navigate to the duplicate after creating it.
 *     See the Duplicate discussion above for the rationale.
 *
 *   - It does not show a "quality score" or any validation-derived
 *     number. The plan's journey document illustrates a card with
 *     a quality badge, but the `Topic` type carries no quality
 *     field — a topic's quality is a property of its latest
 *     validation report, which is a separate entity fetched by
 *     the validation feature. Showing it here would require an
 *     N+1 fetch on every card render. The status badge is the
 *     correct summary of where the topic is in its pipeline; the
 *     quality score is shown inside the topic, on the Report tab.
 */

import type { KeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowRight,
  Copy,
  Trash2,
  type LucideIcon,
} from 'lucide-react';

import { useTopics } from '../hooks/useTopics.js';
import { useToast } from '../../shared/hooks/useToast.js';
import { useModal } from '../../shared/components/Modal.js';
import type { Topic, TopicStatus } from '../../shared/types/index.js';

// ============================================================
//  Public types
// ============================================================

/**
 * The props accepted by `TopicCard`.
 *
 * The card takes exactly one prop — the topic it represents. It
 * is deliberately a controlled component with no internal data
 * state; everything it displays comes from the topic it was
 * given, and everything it does is routed through the topics
 * hook and the shared toast / modal contexts.
 */
export interface TopicCardProps {
  /** The topic to render. */
  topic: Topic;
}

// ============================================================
//  Status label and class tables
// ============================================================
//
//  Duplicated from TopicDetail.tsx — see the file header for why.
//  Both tables are typed as `Record<TopicStatus, ...>` so the
//  compiler rejects a map that is missing a status. Adding a
//  ninth status to the union requires updating both this file
//  and TopicDetail.tsx, and the compiler catches the miss.

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
 * The pipeline-status pill rendered in the card's top-right
 * corner. Not exported — the badge has no consumer outside this
 * file.
 */
const StatusBadge = ({ status }: { status: TopicStatus }) => (
  <span
    className={
      'inline-flex shrink-0 items-center rounded-full px-2 py-0.5 ' +
      'text-xs font-medium ' +
      STATUS_CLASSES[status]
    }
  >
    {STATUS_LABELS[status]}
  </span>
);

// ============================================================
//  Internal: formatRelativeTime
// ============================================================

/**
 * Format an ISO-8601 timestamp as a short relative label — "5m
 * ago", "3h ago", "2d ago" — or, for anything older than a week,
 * a plain locale date.
 *
 * The thresholds are:
 *
 *   < 60 seconds   → "just now"
 *   < 60 minutes   → "Nm ago"
 *   < 24 hours     → "Nh ago"
 *   < 7 days       → "Nd ago"
 *   older          → locale date (e.g. "3/14/2025")
 *
 * The "older" fallback uses `toLocaleDateString()` with no
 * explicit locale, so the browser's own locale settings apply.
 * That matches what the user's OS is configured for and avoids
 * hard-coding a date format that would read as wrong in most of
 * the world.
 *
 * `Math.floor` is used for all three divisions so that a value
 * of "3.7 hours ago" reads as "3h ago" rather than rounding up
 * to "4h ago" — floor is the convention every relative-time
 * formatter follows, because it never claims more elapsed time
 * than has actually passed.
 *
 * The function is total — every string that parses to a valid
 * `Date` produces a well-formed label, and no throw is possible
 * once `new Date(iso).getTime()` has produced a finite number.
 * A malformed input (which the `Topic` type's `createdAt: string`
 * does not prevent at the type level, because `string` cannot be
 * narrowed to "ISO-8601 string" in TypeScript) would produce
 * `NaN` from `.getTime()`, and every comparison against `NaN`
 * is `false`, so the function would fall through to the
 * `toLocaleDateString()` branch. `new Date(NaN).toLocaleDateString()`
 * returns "Invalid Date" — a legible fallback, not a crash.
 */
const formatRelativeTime = (iso: string): string => {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const diffMs = now - then;

  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffSec < 60) {
    return 'just now';
  }
  if (diffMin < 60) {
    return `${diffMin}m ago`;
  }
  if (diffHour < 24) {
    return `${diffHour}h ago`;
  }
  if (diffDay < 7) {
    return `${diffDay}d ago`;
  }
  return new Date(iso).toLocaleDateString();
};

// ============================================================
//  Internal: ActionButton
// ============================================================

interface ActionButtonProps {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  variant?: 'default' | 'danger';
}

/**
 * One button in the card's action bar. Not exported — the action
 * bar is the only consumer, and its three buttons all take this
 * shape.
 *
 * The two variants differ only in their hover color: the default
 * variant hovers to a neutral background with primary-colored
 * text; the danger variant hovers to a soft red with red text.
 * The label stays legible in both light and dark modes — the
 * `dark:` classes mirror the light-mode pair.
 */
const ActionButton = ({
  icon: Icon,
  label,
  onClick,
  variant = 'default',
}: ActionButtonProps) => {
  const hoverClass =
    variant === 'danger'
      ? 'hover:bg-red-50 hover:text-red-700 ' +
        'dark:hover:bg-red-950/60 dark:hover:text-red-400'
      : 'hover:bg-neutral-100 hover:text-primary ' +
        'dark:hover:bg-neutral-800 dark:hover:text-primary-light';

  return (
    <button
      type="button"
      onClick={onClick}
      className={
        'flex items-center justify-center gap-1.5 px-3 py-2 ' +
        'text-xs font-medium text-neutral-600 ' +
        'transition-colors focus-visible:outline-none ' +
        'dark:text-neutral-300 ' +
        hoverClass
      }
    >
      <Icon size={14} aria-hidden="true" />
      <span>{label}</span>
    </button>
  );
};

// ============================================================
//  TopicCard
// ============================================================

/**
 * One card in the topics grid. See the file header for the
 * component's responsibilities, its two open paths, and the
 * reasoning behind the Duplicate and Delete behaviors.
 */
export const TopicCard = ({ topic }: TopicCardProps) => {
  const navigate = useNavigate();
  const toast = useToast();
  const modal = useModal();
  const { setActiveTopic, deleteTopic, duplicateTopic } = useTopics();

  // ---- Open ----
  //
  // Write the topic into the store before navigating so the
  // detail page can skip its `loadTopic` fetch. See the file
  // header for why this matters.
  const handleOpen = (): void => {
    setActiveTopic(topic);
    navigate(`/dashboard/topics/${topic._id}`);
  };

  // ---- Keyboard activation for the clickable card body ----
  //
  // A `role="button"` element is expected to respond to Enter and
  // Space, the same as a native `<button>`. Space is handled with
  // `preventDefault` to suppress the browser's default scroll
  // behavior on a focused non-input element.
  const handleCardKeyDown = (
    event: KeyboardEvent<HTMLDivElement>
  ): void => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      handleOpen();
    }
  };

  // ---- Duplicate ----
  //
  // The store prepends the new topic to the list on success, so
  // the new card appears at the top of the grid without the user
  // having to change tabs or scroll. See the file header for why
  // the card does not navigate to the duplicate.
  const handleDuplicate = (): void => {
    void (async (): Promise<void> => {
      const created = await duplicateTopic(topic);
      if (created) {
        toast.success(`Created "${created.title}"`);
      } else {
        toast.error('Failed to duplicate topic.');
      }
    })();
  };

  // ---- Delete ----
  //
  // Opens a confirmation modal. The modal's "Delete" button
  // calls `confirmDelete` and closes the modal on the same
  // click. `modal.close()` with no argument closes the topmost
  // modal — this modal, since it is the only one open when the
  // user clicked the card's Delete button.
  const confirmDelete = (): void => {
    void (async (): Promise<void> => {
      const ok = await deleteTopic(topic._id);
      if (ok) {
        toast.success(`Deleted "${topic.title}"`);
      } else {
        toast.error('Failed to delete topic.');
      }
    })();
  };

  const handleDelete = (): void => {
    modal.open({
      title: 'Delete topic?',
      variant: 'danger',
      size: 'sm',
      content: (
        <p>
          Are you sure you want to delete{' '}
          <strong className="font-semibold">{topic.title}</strong>?
          This cannot be undone.
        </p>
      ),
      footer: (
        <>
          <button
            type="button"
            onClick={() => modal.close()}
            className={
              'rounded-lg border border-neutral-300 bg-background ' +
              'px-4 py-2 text-sm font-medium text-text ' +
              'transition-colors hover:bg-neutral-100 ' +
              'dark:border-neutral-700 dark:hover:bg-neutral-800 ' +
              'focus-visible:outline-none'
            }
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => {
              modal.close();
              confirmDelete();
            }}
            className={
              'rounded-lg bg-red-600 px-4 py-2 text-sm font-medium ' +
              'text-white transition-colors hover:bg-red-700 ' +
              'focus-visible:outline-none'
            }
          >
            Delete
          </button>
        </>
      ),
    });
  };

  return (
    <article
      className={
        'flex flex-col overflow-hidden rounded-2xl ' +
        'border border-neutral-200 bg-background shadow-soft ' +
        'transition-shadow hover:shadow-medium ' +
        'dark:border-neutral-800'
      }
    >
      {/* ---- Card body (clickable) ---- */}
      <div
        role="button"
        tabIndex={0}
        onClick={handleOpen}
        onKeyDown={handleCardKeyDown}
        aria-label={`Open topic: ${topic.title}`}
        className="flex-1 cursor-pointer p-5 focus-visible:outline-none"
      >
        {/* Title + status */}
        <div className="flex items-start justify-between gap-3">
          <h3
            className={
              'line-clamp-2 text-base font-semibold ' +
              'text-text dark:text-neutral-100'
            }
          >
            {topic.title}
          </h3>
          <StatusBadge status={topic.status} />
        </div>

        {/* Metadata row */}
        <div
          className={
            'mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 ' +
            'text-xs text-neutral-500 dark:text-neutral-400'
          }
        >
          <span>{topic.sourceCount} sources</span>
          <span aria-hidden="true">·</span>
          <span>{topic.wordCount} words</span>
          <span aria-hidden="true">·</span>
          <span>{formatRelativeTime(topic.createdAt)}</span>
        </div>

        {/* Keywords preview */}
        {topic.keywords.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1">
            {topic.keywords.slice(0, 3).map((keyword) => (
              <span
                key={keyword}
                className={
                  'rounded-full bg-neutral-100 px-2 py-0.5 ' +
                  'text-xs text-neutral-600 ' +
                  'dark:bg-neutral-800 dark:text-neutral-300'
                }
              >
                {keyword}
              </span>
            ))}
            {topic.keywords.length > 3 && (
              <span
                className={
                  'rounded-full bg-neutral-100 px-2 py-0.5 ' +
                  'text-xs text-neutral-600 ' +
                  'dark:bg-neutral-800 dark:text-neutral-300'
                }
              >
                +{topic.keywords.length - 3}
              </span>
            )}
          </div>
        )}

        {/* Failure detail — only when the topic actually failed */}
        {topic.status === 'failed' && topic.error !== undefined && (
          <p
            className={
              'mt-3 line-clamp-2 text-xs ' +
              'text-red-600 dark:text-red-400'
            }
          >
            {topic.error}
          </p>
        )}
      </div>

      {/* ---- Action bar ---- */}
      <div
        className={
          'grid grid-cols-3 divide-x divide-neutral-200 ' +
          'border-t border-neutral-200 ' +
          'dark:divide-neutral-800 dark:border-neutral-800'
        }
      >
        <ActionButton
          icon={ArrowRight}
          label="Open"
          onClick={handleOpen}
        />
        <ActionButton
          icon={Copy}
          label="Duplicate"
          onClick={handleDuplicate}
        />
        <ActionButton
          icon={Trash2}
          label="Delete"
          onClick={handleDelete}
          variant="danger"
        />
      </div>
    </article>
  );
};

// ============================================================
//  Default export
// ============================================================

/**
 * The `TopicCard` component as the default export. `Topics.tsx`
 * imports it with the default form
 * (`import TopicCard from '../components/TopicCard.js'`), so this
 * is the export that keeps the grid resolving.
 */
export default TopicCard;