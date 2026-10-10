/**
 * CaptchaModal — the blocking modal for automation prompts.
 *
 * When the Python pipeline blocks on a `CAPTCHA_REQUIRED` or
 * `MANUAL_ACTION` marker, the automation store pushes a
 * `PromptRequest` onto its `promptQueue`. This component renders
 * the head of that queue as a modal that cannot be dismissed by
 * any means other than a deliberate response from the user.
 *
 * ── Why "blocking" is enforced visually ─────────────────────────
 *
 *   The plan's user journey is explicit: "The app pauses and asks
 *   the user to solve it in the Chrome window, exactly like
 *   ROOKIE's captcha modal." A user who ignored the modal would
 *   leave the Python child blocked on stdin, and the pipeline
 *   would stall without any indication of why. The modal
 *   therefore:
 *
 *     * Refuses overlay-click dismissal (`closeOnOverlay={false}`).
 *     * Refuses Escape-key dismissal (`closeOnEscape={false}`).
 *     * Hides its own close button (`showCloseButton={false}`).
 *
 *   The only ways to dismiss it are the three footer buttons,
 *   each of which represents a response the Python side's
 *   `_read_command` function recognizes: Skip, Stop, or Continue.
 *   A fourth path — dismissal by a `CAPTCHA_SOLVED` marker for
 *   the same prompt — exists at the store level (the user solved
 *   the captcha in Chrome and the Python script continued without
 *   going through this modal). When that happens, the store's
 *   `CAPTCHA_SOLVED` handler removes the prompt from the queue,
 *   `promptQueue[0]` changes, and this modal re-renders with the
 *   next prompt or closes.
 *
 * ── The three responses and what they map to ────────────────────
 *
 *   The Python side's `core/control_mode.py` recognizes three
 *   commands on the child's stdin:
 *
 *     `'CONTINUE'` or an empty line  → resume the pipeline
 *     `'SKIP'`                       → skip the current URL,
 *                                      the pipeline continues
 *                                      with the next one
 *     `'STOP'`                       → abort the whole run
 *
 *   The three footer buttons in this modal correspond one-to-one.
 *   `Continue` is the visual focus (primary-filled) because the
 *   overwhelming majority of captcha prompts are resolved by
 *   solving the captcha and continuing. `Skip` and `Stop` are
 *   outlined alternatives in a neutral and a danger tone
 *   respectively.
 *
 * ── The PLAN DELTA — response delivery is not yet wired ────────
 *
 *   Clicking one of the three buttons calls the store's
 *   `dismissPrompt(promptId)` action, which removes the prompt
 *   from the renderer's queue and either advances to the next
 *   prompt or closes the modal. That part is complete.
 *
 *   What is NOT yet complete is the delivery of the response to
 *   the blocked Python child. The delivery requires an IPC
 *   channel that reaches the specific child process that emitted
 *   the marker and calls its `writeStdin()` method. The preload's
 *   `ElectronAPI` interface declares no `automation` namespace,
 *   and no existing method on any other namespace can deliver a
 *   stdin command to a child process:
 *
 *     * The existing per-feature cancel channels (`research.cancel`,
 *       `writer.cancel`) take a `topicId`, not a task id. The
 *       CAPTCHA_REQUIRED marker's payload does not carry a
 *       topicId, so this modal cannot use those channels without
 *       additional correlation.
 *
 *     * The `childProcessManager`'s `writeStdin()` method is the
 *       correct delivery primitive, but no IPC channel currently
 *       exposes it.
 *
 *   This is the same PLAN DELTA that `automationStore.ts`,
 *   `useAutomation.ts`, and `automationIPC.ts` logged in the
 *   preceding three steps. When the preload's `automation`
 *   namespace is added — a coordinated change that touches
 *   `src/main/preload.ts`, an existing file — the fix in THIS
 *   file is a one-line addition inside `handleResponse`: an
 *   awaited call to the new preload method before (or after)
 *   `dismissPrompt`. The rest of this file — the store
 *   subscription, the modal shell, the button styling, the
 *   response semantics — is already correct and does not change.
 *
 *   Until the delivery lands, `handleResponse` logs a
 *   console-warning naming the response and the pending gap, and
 *   fires a toast reflecting the user's intent. The toast is
 *   deliberately worded in the present-tense action form
 *   ("Continuing…") rather than as a completed action
 *   ("Continued."), so the UI is honest about the state without
 *   being alarmist.
 *
 * ── What this component does NOT do ─────────────────────────────
 *
 *   - It does not render its own modal shell. The shared `Modal`
 *     component owns the backdrop, the header with its
 *     variant-driven icon, the body container, the footer
 *     container, and the focus trap. This file supplies the
 *     content and the footer buttons; the shell is the same one
 *     every other modal in the app uses.
 *
 *   - It does not distinguish "the modal should be open" from
 *     "the modal should be closed" as its own state. Visibility
 *     is derived from `promptQueue.length > 0`. When the queue
 *     empties, the modal closes automatically; when a new prompt
 *     arrives while the modal is open, its content updates in
 *     place. This is the same pattern the shared modal uses for
 *     every other controlled modal in the app.
 *
 *   - It does not focus the Chrome window. A future session
 *     could add a "Bring Chrome to front" button next to the
 *     three response buttons; the operation would need an IPC
 *     channel (`window:focusChrome` or similar) that does not
 *     exist today. The plan does not call for one.
 *
 *   - It does not show a "waiting for the script to resume"
 *     spinner after a click. The response is synchronous from
 *     the renderer's perspective — the store removes the prompt
 *     from the queue, the modal advances or closes. The Python
 *     side's own resume time is invisible to the renderer in the
 *     current architecture, and once delivery is wired the modal
 *     still will not have a state to show for it — the pipeline
 *     will simply continue emitting progress markers.
 *
 *   - It does not queue-dismiss en masse. A future "Dismiss all"
 *     affordance would call `clearAll` on the store; today the
 *     three buttons operate on the head of the queue only.
 *
 * Dependencies: react + lucide-react + the shared Modal + the
 * shared toast hook + the automation hook. All present.
 */

import { useCallback } from 'react';
import {
  Check,
  ShieldAlert,
  SkipForward,
  Square,
  type LucideIcon,
} from 'lucide-react';

import Modal from '../../shared/components/Modal.js';
import { useToast } from '../../shared/hooks/useToast.js';
import { useAutomation } from '../hooks/useAutomation.js';
import type { PromptRequest } from '../store/automationStore.js';

// ============================================================
//  Public types
// ============================================================

/**
 * The props accepted by `CaptchaModal`. Currently empty — the
 * component reads everything it needs from the automation store
 * through `useAutomation`, and the store's `promptQueue` is what
 * drives its visibility.
 *
 * The interface is declared anyway so that a future addition (for
 * example, a `renderExtraFooter` prop for injecting a
 * diagnostic-only affordance, or a `blocking` boolean for a
 * non-blocking variant) has a named, exported home.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface CaptchaModalProps {
  // Reserved for future additions. See interface docstring.
}

// ============================================================
//  Response action shape
// ============================================================

/**
 * The three responses this modal can produce. Each one maps
 * one-to-one to a command the Python side's `_read_command`
 * function recognizes on the child's stdin.
 *
 *   `'continue'` → `'CONTINUE\n'` or `'\n'`
 *   `'skip'`     → `'SKIP\n'`
 *   `'stop'`     → `'STOP\n'`
 *
 * The union is declared as a string-literal type rather than an
 * enum for the same reason every other closed set in the codebase
 * is: string literals serialise naturally, compare cleanly, and
 * have no runtime representation to keep in sync with a
 * separately-declared runtime array.
 */
type ResponseAction = 'continue' | 'skip' | 'stop';

/**
 * The user-facing toast message for each response action. Wording
 * is present-tense ("Continuing…") rather than completed
 * ("Continued.") because the pipeline has not necessarily resumed
 * by the time the toast fires — the Python side's resume time is
 * not observable to the renderer in the current architecture.
 *
 * A `Record<ResponseAction, string>` rather than a plain object
 * literal so the compiler enforces exhaustiveness: adding a
 * fourth action to the union without adding a message here is a
 * compile error.
 */
const RESPONSE_TOASTS: Record<ResponseAction, string> = {
  continue: 'Continuing…',
  skip: 'Skipping this one…',
  stop: 'Stopping the run…',
};

// ============================================================
//  Footer button definition
// ============================================================

/**
 * A single footer button's static shape. Declared as an interface
 * so the button-loop below is exhaustive over the three actions
 * and can be written in one pass.
 */
interface FooterButtonSpec {
  readonly action: ResponseAction;
  readonly label: string;
  readonly icon: LucideIcon;
  readonly variant: 'primary' | 'neutral' | 'danger';
}

/**
 * The three footer buttons, in display order: Stop, Skip,
 * Continue. The order places the destructive action on the left
 * and the primary action on the right — the conventional
 * "destructive on the far side, primary on the near side"
 * arrangement that keeps the most likely click from landing
 * adjacent to the most dangerous one.
 */
const FOOTER_BUTTONS: readonly FooterButtonSpec[] = [
  { action: 'stop', label: 'Stop', icon: Square, variant: 'danger' },
  {
    action: 'skip',
    label: 'Skip this one',
    icon: SkipForward,
    variant: 'neutral',
  },
  { action: 'continue', label: 'Continue', icon: Check, variant: 'primary' },
];

// ============================================================
//  Internal: class strings for the three button variants
// ============================================================
//
// Pulled out of the render body so the button-loop below stays
// readable. The three variants differ only in their color
// treatment; sizing and shape are identical across all three.

const BUTTON_BASE_CLASS =
  'inline-flex items-center gap-1.5 rounded-lg px-4 py-2 ' +
  'text-sm font-medium transition-colors ' +
  'focus-visible:outline-none';

const BUTTON_VARIANT_CLASSES: Record<
  FooterButtonSpec['variant'],
  string
> = {
  primary:
    'bg-primary text-white hover:bg-primary-dark',
  neutral:
    'border border-neutral-300 bg-background text-text ' +
    'hover:bg-neutral-100 ' +
    'dark:border-neutral-700 dark:hover:bg-neutral-800 ' +
    'dark:text-neutral-100',
  danger:
    'border border-red-300 bg-transparent text-red-700 ' +
    'hover:bg-red-50 ' +
    'dark:border-red-800 dark:text-red-400 ' +
    'dark:hover:bg-red-950/60',
};

// ============================================================
//  Internal: prompt body
// ============================================================

/**
 * The body of the modal — the message from the Python side plus
 * a small diagnostic footer naming the site and step.
 *
 * Rendered as a separate component (rather than inline) so the
 * main component's JSX stays a two-level structure: the Modal
 * shell, and one body block. The body block is the same shape
 * regardless of which prompt is currently at the head of the
 * queue.
 */
const PromptBody = ({ prompt }: { prompt: PromptRequest }) => {
  // The Python side's prompt copy already describes the situation
  // in the user's terms ("Google is showing an 'unusual traffic'
  // check. Solve it in the Chrome window, then click Continue.").
  // The modal renders it verbatim; no additional framing is
  // required for the common case.
  //
  // The site/step line below is diagnostic — it lets a user who
  // is looking at the Chrome window confirm that the modal is
  // asking about the same site they are looking at, which matters
  // when the pipeline is driving several sites in sequence.
  return (
    <div className="space-y-4">
      <p
        className={
          'text-sm leading-relaxed text-text ' +
          'dark:text-neutral-100'
        }
      >
        {prompt.prompt}
      </p>

      <div
        className={
          'flex items-center gap-2 border-t border-neutral-200 ' +
          'pt-3 text-xs text-neutral-500 ' +
          'dark:border-neutral-800 dark:text-neutral-400'
        }
      >
        <span className="font-medium">From:</span>
        <code className="font-mono">{prompt.site}</code>
        <span aria-hidden="true">·</span>
        <code className="font-mono">{prompt.step}</code>
      </div>
    </div>
  );
};

// ============================================================
//  CaptchaModal — the main component
// ============================================================

/**
 * The blocking prompt modal. See the file header for the
 * component's responsibilities, the "blocking" contract, and the
 * PLAN DELTA that documents the pending preload extension.
 */
export const CaptchaModal = (_props: CaptchaModalProps = {}) => {
  const { promptQueue, dismissPrompt } = useAutomation();
  const toast = useToast();

  // ---- Current prompt ----
  // The modal renders the head of the FIFO queue. When the queue
  // is empty, `current` is null and the modal renders nothing
  // (the shared `Modal` component short-circuits on `open={false}`).
  const current = promptQueue[0] ?? null;
  const isOpen = current !== null;
  const total = promptQueue.length;

  // ---- Response handler ----
  // Called by each of the three footer buttons. The single handler
  // owns the response-classification logic so the three buttons
  // differ only by which `ResponseAction` they pass.
  //
  // The handler does three things, in order:
  //
  //   1. Logs a warning naming the response and the pending
  //      delivery gap. The warning is developer-facing — it fires
  //      to the Chromium DevTools console, not to the user. See
  //      the file header for why the actual delivery to the
  //      Python child is not wired.
  //
  //   2. Removes the prompt from the store's queue via
  //      `dismissPrompt`. This is what actually advances the UI —
  //      the modal re-renders with the next prompt, or closes if
  //      the queue is now empty.
  //
  //   3. Fires a toast reflecting the user's intent. The wording
  //      is present-tense ("Continuing…"); see `RESPONSE_TOASTS`
  //      above for the rationale.
  //
  // When the preload's `automation` namespace lands, the correct
  // change to this handler is to insert an `await` call to the
  // namespace's response-delivery method between steps 1 and 2 —
  // before the dismiss, so the delivery failure path (if any) can
  // be handled without losing the reference to the prompt that
  // was being resolved.
  const handleResponse = useCallback(
    (action: ResponseAction): void => {
      if (current === null) {
        return;
      }

      // Step 1 — developer-facing log of the pending gap.
      console.warn(
        `[CaptchaModal] User responded "${action}" to prompt ` +
          `(${current.site}, ${current.step}). Response delivery ` +
          `to the Python child is pending the preload automation ` +
          `namespace — see the PLAN DELTA in this file's header.`
      );

      // Step 2 — advance the queue.
      dismissPrompt(current.id);

      // Step 3 — user-facing acknowledgment.
      toast.info(RESPONSE_TOASTS[action]);
    },
    [current, dismissPrompt, toast]
  );

  // ---- Handler for the modal's own `onClose` ----
  // The shared `Modal` component requires an `onClose` prop even
  // when the modal is configured to block every dismissible path.
  // This handler is a no-op — the modal is intentionally
  // undismissable via Escape or overlay click, and neither path
  // can fire given the `closeOnOverlay={false}` and
  // `closeOnEscape={false}` props. It exists to satisfy the
  // component's props contract and to log a diagnostic if a
  // future change to the shared modal ever exposes a dismissal
  // path that this file did not account for.
  const handleModalClose = useCallback((): void => {
    console.warn(
      '[CaptchaModal] onClose fired on a blocking modal. This ' +
        'should not happen — the modal is configured to block ' +
        'Escape and overlay-click dismissal. If you see this log, ' +
        'check the shared Modal component for a change that ' +
        'exposes a new dismissal path.'
    );
  }, []);

  // ---- Modal title ----
  // The title distinguishes captchas from generic manual actions so
  // the user reads the right urgency in the header. A captcha
  // ("Solve this challenge") reads differently from an overlay to
  // close ("Clear this dialog"), and the modal's visual treatment
  // already carries a variant-specific icon in the header row
  // (the shared `Modal` renders an `AlertTriangle` for the
  // `warning` variant this modal uses for both cases).
  const modalTitle =
    current?.isCaptcha === true ? 'Captcha required' : 'Action required';

  // ---- Render ----
  return (
    <Modal
      open={isOpen}
      onClose={handleModalClose}
      variant="warning"
      size="md"
      title={modalTitle}
      closeOnOverlay={false}
      closeOnEscape={false}
      showCloseButton={false}
      footer={
        <div className="flex w-full items-center justify-between gap-2">
          {/* ---- Queue indicator ---- */}
          {/* Shown only when the queue holds more than one prompt.
              A single-entry queue is the common case, and rendering
              "1 of 1" for it would be noise. */}
          <span
            className={
              'text-xs text-neutral-500 dark:text-neutral-400'
            }
          >
            {total > 1 ? `1 of ${total} pending` : ''}
          </span>

          {/* ---- Response buttons ---- */}
          <div className="flex items-center gap-2">
            {FOOTER_BUTTONS.map((spec) => {
              const Icon = spec.icon;
              return (
                <button
                  key={spec.action}
                  type="button"
                  onClick={() => handleResponse(spec.action)}
                  className={
                    `${BUTTON_BASE_CLASS} ` +
                    BUTTON_VARIANT_CLASSES[spec.variant]
                  }
                >
                  <Icon size={16} aria-hidden="true" />
                  <span>{spec.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      }
    >
      {current !== null && (
        <>
          {/* ---- Icon ---- */}
          {/* A large, prominent icon above the message gives the
              modal a stronger visual signal than the small icon
              the shared Modal already renders in the header
              row. The two icons are not redundant — the header
              one is the variant marker for every modal in the
              app; this one is the size that makes the modal feel
              like the interruption it is. */}
          <div className="mb-4 flex justify-center">
            <div
              className={
                'flex h-14 w-14 items-center justify-center ' +
                'rounded-2xl bg-amber-100 text-amber-700 ' +
                'dark:bg-amber-950/60 dark:text-amber-400'
              }
            >
              <ShieldAlert size={28} aria-hidden="true" />
            </div>
          </div>

          {/* ---- Message body ---- */}
          <PromptBody prompt={current} />
        </>
      )}
    </Modal>
  );
};

// ============================================================
//  Default export
// ============================================================

/**
 * The `CaptchaModal` component as the default export, matching
 * the convention used by every other component file in the
 * codebase. A future layout-level mount (in `renderer/App.tsx`
 * or a top-level provider) will import it with the default form
 * (`import CaptchaModal from '.../CaptchaModal.js'`), so this is
 * the export that keeps the component's eventual registration
 * resolving.
 */
export default CaptchaModal;