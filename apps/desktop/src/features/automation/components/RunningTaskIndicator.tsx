/**
 * RunningTaskIndicator — the "N tasks running" badge.
 *
 * A small inline badge that reads the automation store's
 * `activeTasks` array and renders a compact status pill showing
 * how many pipeline operations are currently in flight. When the
 * count is zero, the component renders nothing.
 *
 * ── Why a leaf component with no props ──────────────────────────
 *
 *   The component reads everything it needs from the automation
 *   store through `useAutomation`. It takes no props because
 *   there is nothing a caller would usefully configure — the
 *   count is derived from the store, the label is derived from
 *   the count, and the styling is fixed. A caller that wanted a
 *   different variant (a compact icon-only form for a sidebar
 *   footer, an expanded form for a dashboard header) would add a
 *   `variant` prop to this file at that time. The interface is
 *   declared and exported below so such a future addition has a
 *   named home.
 *
 * ── Why the component renders nothing at zero ───────────────────
 *
 *   A badge that says "0 tasks running" is noise. The user's
 *   mental model when they look at the app is either "something
 *   is happening" or "nothing is happening" — and the latter is
 *   the default, unremarkable state. Rendering an explicit "0"
 *   pill would force the eye to process a non-event every time
 *   the user glanced at the area.
 *
 *   The convention this follows is the same one the sidebar uses
 *   for admin-only links: render the affordance only when it is
 *   meaningful. Absence of the badge means nothing is running;
 *   presence of the badge means something is. The state is
 *   legible from the presence or absence alone.
 *
 *   The consequence is that the component's own tree-shaking is
 *   trivial: it returns either `null` (the common case) or a
 *   single `<span>` (the uncommon case). No state, no effects,
 *   no memoization. The store subscription is the only runtime
 *   cost, and it is a single selector read.
 *
 * ── The tooltip ─────────────────────────────────────────────────
 *
 *   When more than one task is running, the badge's `title`
 *   attribute carries a comma-separated list of the operation
 *   names — "search, write" for a topic being searched while a
 *   different topic is being written. This lets a user who is
 *   wondering "why is the app busy?" hover the badge and see
 *   exactly which operations are running without opening a
 *   separate panel.
 *
 *   The tooltip is on the badge itself, not on a child element,
 *   so the entire visible area is the hover target. A tooltip on
 *   a child icon would be harder to trigger and less discoverable.
 *
 * ── Accessibility ───────────────────────────────────────────────
 *
 *   The badge is marked with `role="status"` and
 *   `aria-live="polite"`. This is the standard ARIA treatment for
 *   a piece of UI whose content changes over time and whose
 *   changes are informational rather than urgent — a screen
 *   reader announces the update at the next natural pause, not
 *   by interrupting the user. The alternative `aria-live="assertive"`
 *   is reserved for error conditions (see `Toast.tsx`'s error
 *   variant for the pattern this codebase uses), and a running-
 *   task count is not an error.
 *
 *   The `aria-label` carries the same text as the visible label,
 *   so a user with a screen reader hears "2 tasks running"
 *   whether they navigate to the badge by tab or by reading the
 *   page linearly. The spinning icon is `aria-hidden="true"` — it
 *   is decorative, and a screen reader that announced "loading
 *   icon" alongside the count would be adding noise.
 *
 * ── Where this component is mounted ─────────────────────────────
 *
 *   The plan's Part 1.16 annotation describes this file as a
 *   "Small '1 task running' badge" but does not name the mount
 *   point. The natural candidates are:
 *
 *     * The sidebar's footer, next to the user's email and the
 *       logout button — a persistent, always-visible location.
 *
 *     * The layout's header region (a future addition; `Layout.tsx`
 *       does not currently render a header above the `<Outlet />`).
 *
 *     * The topics page's header, next to the "New Topic" button —
 *       a contextually-relevant location for a user who is
 *       looking at their topic list.
 *
 *   All three are legitimate. The choice belongs to the session
 *   that mounts the component; this file's job is to make the
 *   component correct and self-contained so the mount is a
 *   one-line addition anywhere. The mount-point decision is
 *   logged as a PLAN DELTA below.
 *
 * ── What this component does NOT do ─────────────────────────────
 *
 *   - It does not offer a "Stop all" or "Cancel" action. The
 *     plan's annotation names the component as an indicator, not
 *     a control. A future session that wanted a control would
 *     add a button here (or a sibling component); today the
 *     indicator is purely informational.
 *
 *   - It does not distinguish "the app is searching" from "the
 *     app is writing" in the visible label. The tooltip carries
 *     the operation names; the visible label is a count because
 *     a count is the number the user needs most often ("is
 *     anything running?") and the operation names are the detail
 *     they need occasionally.
 *
 *   - It does not read the prompt queue. The modal
 *     (`CaptchaModal.tsx`) is the affordance for pending prompts;
 *     a task that is blocked waiting for a user response still
 *     counts as running, and the badge shows it as such. A future
 *     session that wanted to distinguish "running" from "blocked
 *     on user" would add a second badge or extend this one with a
 *     blocked-count field — the store's data supports both.
 *
 *   - It does not animate on entry or exit. The badge appears and
 *     disappears as the task count crosses zero; a fade or slide
 *     would be a small flourish that competes with the spinner
 *     for the eye. The component's visual weight is already
 *     minimal by design; the spinner inside is the only motion.
 *
 * Dependencies: lucide-react + the sibling automation hook. Both
 * present.
 */

import { Loader2 } from 'lucide-react';

import { useAutomation } from '../hooks/useAutomation.js';

// ============================================================
//  Public types
// ============================================================

/**
 * The props accepted by `RunningTaskIndicator`. Currently empty —
 * the component reads everything it needs from the automation
 * store, and there is nothing a caller would usefully configure.
 *
 * The interface is declared anyway so that a future addition (for
 * example, a `variant: 'compact' | 'default'` prop for a
 * sidebar-footer form versus a header form, or a `showOperations`
 * boolean to render the operation names inline instead of in a
 * tooltip) has a named, exported home.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface RunningTaskIndicatorProps {
  // Reserved for future additions. See interface docstring.
}

// ============================================================
//  RunningTaskIndicator — the main component
// ============================================================

/**
 * The running-task badge. See the file header for the
 * component's responsibilities, its zero-count behavior, and the
 * reasoning behind the tooltip and accessibility treatments.
 */
export const RunningTaskIndicator = (
  _props: RunningTaskIndicatorProps = {}
) => {
  // ---- Store subscription ----
  // One selector for the one field this component reads. The
  // component re-renders only when `activeTasks` changes
  // identity — a `TASK_START` or `TASK_END` marker arrival. A
  // marker for a different field (a captcha prompt, a writer
  // progress update) does not re-render this component, because
  // its selector's return value did not change.
  const { activeTasks } = useAutomation();

  const count = activeTasks.length;

  // ---- Zero-count: render nothing ----
  // See the file header for why the empty state is `null` rather
  // than an empty badge. This is the common case — the badge is
  // only visible while a pipeline operation is in flight — and
  // returning `null` here is what keeps the component's render
  // tree from carrying a hidden element on every page.
  if (count === 0) {
    return null;
  }

  // ---- Compose the visible label and the tooltip ----
  //
  // The visible label is a count, in the form the plan's
  // annotation names: "1 task running" for the singular, "N tasks
  // running" for the plural. The number itself is at the start of
  // the string so a glancing reader sees it first — the count is
  // the piece of information the badge is communicating.
  //
  // The tooltip carries the operation names, one per task, joined
  // by a comma. When there is only one task, the tooltip and the
  // visible label carry the same information (the operation name
  // is the interesting detail in that case); the tooltip still
  // appears so the interaction is consistent between the two
  // cases.
  const label = count === 1 ? '1 task running' : `${count} tasks running`;
  const operations = activeTasks.map((t) => t.operation).join(', ');
  const title =
    count === 1 ? `Running: ${operations}` : `Running: ${operations}`;

  // ---- Render ----
  return (
    <span
      role="status"
      aria-live="polite"
      aria-label={label}
      title={title}
      className={
        'inline-flex items-center gap-1.5 rounded-full ' +
        'bg-sky-100 px-2.5 py-0.5 text-xs font-medium ' +
        'text-sky-800 ' +
        'dark:bg-sky-950/60 dark:text-sky-200'
      }
    >
      <Loader2
        size={12}
        className="shrink-0 animate-spin"
        aria-hidden="true"
      />
      <span>{label}</span>
    </span>
  );
};

// ============================================================
//  Default export
// ============================================================

/**
 * The `RunningTaskIndicator` component as the default export,
 * matching the convention used by every other component file in
 * the codebase. A future mount in the sidebar, the layout, or a
 * page header will import it with the default form
 * (`import RunningTaskIndicator from '.../RunningTaskIndicator.js'`),
 * so this is the export that keeps that mount resolving.
 */
export default RunningTaskIndicator;