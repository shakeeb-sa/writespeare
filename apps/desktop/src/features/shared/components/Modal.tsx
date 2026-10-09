/**
 * WriteSpeare — reusable modal system.
 *
 * This module provides the app's modals — dialogs that block
 * interaction with the rest of the UI while the user reads the
 * message and acts on it. Two entry points compose the system:
 *
 *   `<Modal open={...} onClose={...}>` — the declarative
 *     component. Used by a component that wants to control a
 *     modal's visibility with its own state. This is the direct
 *     interpretation of the plan's description of this file.
 *
 *   `useModal()` — the imperative hook. Used by a component that
 *     wants to fire a modal — typically a confirmation, a
 *     warning, an informational notice — from an event handler
 *     or an async flow where threading a boolean state through
 *     the tree would be noise. The hook's `open(options)` method
 *     accepts the modal's content and configuration, and returns
 *     an id that can later be passed to `close(id)`.
 *
 * Both entry points share the internal `ModalShell` component —
 * the visual structure (backdrop, container, header, body,
 * footer) and the accessibility behaviours (focus trap, Escape
 * key, click-outside). Two entry points, one shell: the design
 * and the behaviours cannot drift between them because they are
 * the same code.
 *
 * What "handles Escape, overlay click, focus trap" means:
 *
 *   Escape — pressing the Escape key closes the modal, unless
 *     the caller has opted out via `closeOnEscape: false`. The
 *     listener runs in the capture phase and stops the event's
 *     propagation, so an inner component that also listens for
 *     Escape (a nested dropdown, for example) does not
 *     accidentally intercept the key.
 *
 *   Overlay click — clicking the backdrop (the dark area around
 *     the modal's content) closes the modal, unless the caller
 *     has opted out via `closeOnOverlay: false`. Clicks inside
 *     the modal's content area do NOT close — the content
 *     stops propagation, so a click on a form field or a button
 *     is not interpreted as a dismiss.
 *
 *   Focus trap — when the modal opens, focus moves into it.
 *     Pressing Tab cycles forward through the focusable
 *     elements inside the modal, wrapping from the last back to
 *     the first. Shift+Tab cycles backward, wrapping from the
 *     first to the last. The modal's container has `tabIndex
 *     ={-1}` so it can itself receive focus when the modal has
 *     no focusable children, in which case the trap is a no-op
 *     (there is nothing to cycle through) but focus is still
 *     kept inside the modal.
 *
 *   On close, focus is restored to whichever element had focus
 *   before the modal opened. That is the standard "focus
 *   restoration" behaviour — without it, keyboard users would
 *   find themselves at the top of the document after dismissing
 *   a modal, having to navigate back to wherever they were.
 *
 * Body scroll lock:
 *
 *   While any modal is open, the page behind it is prevented
 *   from scrolling. Without this, a user who scrolls the
 *   mouse-wheel while a modal is open would scroll the
 *   underlying content, which is disorienting when the modal
 *   covers most of the viewport. The lock is implemented with a
 *   module-level counter: the first modal to open sets
 *   `document.body.style.overflow = 'hidden'`, the last one to
 *   close restores it. The counter is what makes the lock
 *   correct when two modals stack — closing the top one does
 *   not unlock the body while the bottom one is still open.
 *
 * Variants — what each conveys:
 *
 *   info    — neutral information. Blue circle-i icon. Used
 *             for "here is what is about to happen" dialogs
 *             before a non-destructive action.
 *
 *   warning — a caution. Amber triangle icon. Used for "this
 *             will overwrite your existing work" dialogs that
 *             the user should read carefully but that are not
 *             irreversible.
 *
 *   danger  — a destructive action. Red circle-x icon. Used
 *             for delete confirmations and other irreversible
 *             operations.
 *
 *   success — a completed action worth acknowledging. Green
 *             check icon. Used sparingly — most completions
 *             are better handled by a toast than a modal, but
 *             a modal that reports the outcome of a long-
 *             running operation (an article export, a bulk
 *             delete) can be appropriate.
 *
 *   The variant affects the icon and its color at the top of
 *   the modal's header. It does not affect the modal's size,
 *   the buttons in the footer, or any other visual element.
 *   The caller chooses those independently, so a danger modal
 *   with a "Cancel" button whose color comes from the button's
 *   own styling is a natural composition.
 *
 * Sizes — what each is for:
 *
 *   sm   — confirmations. "Delete this topic?" A message and
 *          two buttons. 24rem wide.
 *   md   — the default. Short forms, informational dialogs,
 *          anything that fits in a few lines. 32rem wide.
 *   lg   — the standard for form-like dialogs. 42rem wide.
 *   xl   — the standard for dialogs with substantial content —
 *          a document preview, a settings pane. 56rem wide.
 *   full — a dialog that takes almost the whole viewport, for
 *          content that needs the room — a full-page document
 *          reader, a data-heavy report. 95vw by 95vh.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import {
  AlertTriangle,
  CheckCircle,
  Info,
  X,
  XCircle,
  type LucideIcon,
} from 'lucide-react';

// ============================================================
//  Public types
// ============================================================

/**
 * The four variants a modal can take. See the file header for
 * the semantic meaning of each.
 */
export type ModalVariant = 'info' | 'warning' | 'danger' | 'success';

/**
 * The five sizes a modal can take. See the file header for the
 * recommended use of each.
 */
export type ModalSize = 'sm' | 'md' | 'lg' | 'xl' | 'full';

/**
 * The props accepted by the `Modal` component — the declarative
 * entry point. Every field except `open`, `onClose`, and
 * `children` is optional.
 */
export interface ModalProps {
  /** Whether the modal is currently visible. */
  open: boolean;

  /** Called when the modal should close, by any of the three
   *  paths (Escape, overlay click, or a caller-triggered
   *  dismissal). The caller is responsible for flipping its own
   *  `open` state in response. */
  onClose: () => void;

  /** Visual variant. Defaults to `'info'`. */
  variant?: ModalVariant;

  /** Size class. Defaults to `'md'`. */
  size?: ModalSize;

  /** Optional title shown at the top of the modal's header. */
  title?: string;

  /** Whether clicking the backdrop closes the modal. Defaults
   *  to `true`. */
  closeOnOverlay?: boolean;

  /** Whether pressing Escape closes the modal. Defaults to
   *  `true`. */
  closeOnEscape?: boolean;

  /** Whether to render the X button in the top-right corner of
   *  the header. Defaults to `true`. */
  showCloseButton?: boolean;

  /** Extra Tailwind classes appended to the modal's content
   *  container. Useful for a caller that needs to widen the
   *  container past the size preset, or to add a per-instance
   *  background. */
  className?: string;

  /** Optional footer content — typically the modal's action
   *  buttons. Rendered below the body, separated by a border
   *  and given the horizontal alignment the plan's mockups
   *  specify (right-aligned on desktop). */
  footer?: ReactNode;

  /** The modal's body. */
  children: ReactNode;
}

/**
 * The options accepted by `useModal().open(...)`. Structurally
 * the same set of fields as `ModalProps` minus `open` (always
 * true for an imperatively-opened modal) and minus `children`
 * (renamed to `content` so the shape reads naturally as an
 * options object rather than as JSX attributes).
 */
export interface ModalOptions {
  title?: string;
  variant?: ModalVariant;
  size?: ModalSize;
  content: ReactNode;
  footer?: ReactNode;
  closeOnOverlay?: boolean;
  closeOnEscape?: boolean;
  showCloseButton?: boolean;
  className?: string;

  /** Called when the modal is dismissed, by any of the three
   *  paths. This is a notification, not a veto — by the time it
   *  fires, the modal is already closing. */
  onClose?: () => void;
}

/**
 * The shape of the object returned by `useModal()`.
 */
export interface ModalAPI {
  /**
   * Open a modal imperatively. Returns an id that can be passed
   * to `close(id)` to dismiss that specific modal — useful when
   * a modal is opened from an async flow and the flow resolves
   * before the user acts, at which point the modal is stale.
   */
  open: (options: ModalOptions) => string;

  /**
   * Close a specific modal by id, or the topmost modal when no
   * id is given. A no-op if no modal is currently open, or if
   * the id does not match a visible modal.
   */
  close: (id?: string) => void;

  /** Close every visible modal at once. */
  closeAll: () => void;
}

// ============================================================
//  Internal types
// ============================================================

/**
 * A modal record held by the provider's state. `closing` is set
 * to `true` when the modal is being dismissed — the record stays
 * in the state array during the exit animation and is removed
 * once the animation completes.
 */
interface ModalRecord {
  id: string;
  options: ModalOptions;
  closing: boolean;
}

// ============================================================
//  Constants
// ============================================================

/**
 * The selector that matches any element that can receive focus.
 * Used by the focus trap to enumerate the candidates inside the
 * modal's content container.
 *
 * The `:not([disabled])` and `:not([tabindex="-1"])` guards
 * exclude elements that are technically focusable per the DOM
 * but that the user cannot reach with the keyboard. A
 * `<button disabled>` is not tabbable, and neither is an
 * element with an explicit `tabindex="-1"` (which is how the
 * modal's own container is made programmatically focusable
 * without becoming a tab stop).
 */
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), ' +
  'textarea:not([disabled]), select:not([disabled]), ' +
  '[tabindex]:not([tabindex="-1"])';

/**
 * The duration, in milliseconds, of the modal's enter and exit
 * animations. Must match the `transition.duration` values passed
 * to the framer-motion elements below. Named as a constant so
 * the two places that reference it — the animation and the
 * imperative provider's post-animation cleanup timeout — stay in
 * sync.
 */
const ANIMATION_DURATION_MS = 200;

/**
 * The size classes, keyed by `ModalSize`. Declared as a
 * `Record<ModalSize, string>` so that the compiler enforces
 * exhaustiveness: adding a sixth size to the union without
 * adding an entry here is a compile error.
 */
const SIZE_CLASSES: Record<ModalSize, string> = {
  sm: 'w-full max-w-sm',
  md: 'w-full max-w-lg',
  lg: 'w-full max-w-2xl',
  xl: 'w-full max-w-4xl',
  full: 'w-[95vw] h-[95vh]',
};

/**
 * The variant-specific icon and icon color. Same exhaustiveness
 * guarantee as `SIZE_CLASSES`. The color is deliberately the
 * icon's only variant-driven styling; a modal's overall container
 * background is neutral, so the same layout reads as "danger" or
 * "info" purely from the icon at the top of the header.
 */
const VARIANT_ICONS: Record<
  ModalVariant,
  { icon: LucideIcon; className: string }
> = {
  info: {
    icon: Info,
    className: 'text-sky-600 dark:text-sky-400',
  },
  warning: {
    icon: AlertTriangle,
    className: 'text-amber-600 dark:text-amber-400',
  },
  danger: {
    icon: XCircle,
    className: 'text-red-600 dark:text-red-400',
  },
  success: {
    icon: CheckCircle,
    className: 'text-emerald-600 dark:text-emerald-400',
  },
};

// ============================================================
//  Body scroll lock
// ============================================================
//
//  Module-level counter. See the file header for why a counter
//  is required rather than a simple boolean.

let scrollLockCount = 0;

/**
 * Acquire the body scroll lock. The first acquisition sets
 * `overflow: hidden` on the body; subsequent acquisitions are
 * no-ops that only increment the counter.
 */
const acquireScrollLock = (): void => {
  scrollLockCount += 1;
  if (scrollLockCount === 1) {
    document.body.style.overflow = 'hidden';
  }
};

/**
 * Release the body scroll lock. The last release restores the
 * body's default overflow; earlier releases are no-ops that only
 * decrement the counter. The `Math.max(0, ...)` guard prevents
 * the counter from going negative if release is called more
 * times than acquire (which would be a bug in this module, not
 * in a caller, but the guard keeps the failure mode harmless).
 */
const releaseScrollLock = (): void => {
  scrollLockCount = Math.max(0, scrollLockCount - 1);
  if (scrollLockCount === 0) {
    document.body.style.overflow = '';
  }
};

// ============================================================
//  ModalShell — shared visual structure and behaviours
// ============================================================
//
//  Both `Modal` (declarative) and `ModalProvider` (imperative)
//  render a `ModalShell`. The shell owns the backdrop, the
//  content container, the header, the body, the footer, and the
//  three accessibility behaviours (Escape, focus trap, focus
//  restoration). Nothing about the shell is animated — the
//  animation is applied by whichever parent renders it (the
//  declarative `Modal` or the provider's item).

interface ModalShellProps {
  variant: ModalVariant;
  size: ModalSize;
  title: string | undefined;
  closeOnOverlay: boolean;
  closeOnEscape: boolean;
  showCloseButton: boolean;
  className: string | undefined;
  footer: ReactNode;
  onClose: () => void;
  children: ReactNode;
}

/**
 * The internal modal structure. Not exported — no consumer
 * outside this module should render it directly.
 *
 * The shell is deliberately unaware of its own visibility state;
 * its parent decides when to mount and unmount it. This is what
 * lets the two parent components (declarative Modal, imperative
 * provider) share the shell while owning their own animation and
 * lifecycle logic.
 */
const ModalShell = ({
  variant,
  size,
  title,
  closeOnOverlay,
  closeOnEscape,
  showCloseButton,
  className,
  footer,
  onClose,
  children,
}: ModalShellProps) => {
  const contentRef = useRef<HTMLDivElement>(null);

  const { icon: Icon, className: iconClass } = VARIANT_ICONS[variant];
  const sizeClass = SIZE_CLASSES[size];

  // ---- Body scroll lock ----
  // Runs once per mounted shell. See the file header for why
  // the lock uses a counter rather than a boolean.
  useEffect(() => {
    acquireScrollLock();
    return () => {
      releaseScrollLock();
    };
  }, []);

  // ---- Focus management ----
  // On mount: save the currently-focused element, focus the
  // modal's content container (which is programmatically
  // focusable via tabIndex={-1}), and restore the previous focus
  // on unmount. The restoration runs in the cleanup so it fires
  // regardless of which path caused the unmount.
  //
  // The saved element is stored in a ref rather than state
  // because nothing about its identity needs to trigger a
  // re-render.
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const previouslyFocused = document.activeElement;
    previouslyFocusedRef.current =
      previouslyFocused instanceof HTMLElement ? previouslyFocused : null;

    // Focus the modal container. If the modal contains a
    // focusable element, `contentRef.current.focus()` moves
    // focus to the container itself; the browser's default
    // behavior on subsequent Tab presses then proceeds into
    // the first focusable descendant. Focusing the container
    // first (rather than the first focusable descendant
    // directly) is the standard behaviour — it ensures that
    // Escape works immediately on open, without the user having
    // to Tab first.
    contentRef.current?.focus();

    return () => {
      previouslyFocusedRef.current?.focus();
    };
  }, []);

  // ---- Keyboard handling ----
  // One listener covers Escape and Tab (for the focus trap).
  // Attached in the capture phase so it runs before React's
  // synthetic event system; the stopPropagation on Escape
  // prevents an inner component's own Escape handler from also
  // firing.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      // ---- Escape ----
      if (event.key === 'Escape' && closeOnEscape) {
        event.stopPropagation();
        onClose();
        return;
      }

      // ---- Tab (focus trap) ----
      if (event.key !== 'Tab') {
        return;
      }

      const container = contentRef.current;
      if (!container) {
        return;
      }

      const focusables =
        container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);

      // No focusable elements inside the modal. The container
      // itself is focusable (tabIndex={-1}), so we prevent Tab
      // from leaving it by keeping focus where it is.
      if (focusables.length === 0) {
        event.preventDefault();
        container.focus();
        return;
      }

      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (!first || !last) {
        return;
      }

      const active = document.activeElement;

      if (event.shiftKey) {
        // Shift+Tab: if focus is on the first focusable (or
        // outside the modal), wrap to the last.
        if (active === first || !container.contains(active)) {
          event.preventDefault();
          last.focus();
        }
      } else {
        // Tab: if focus is on the last focusable (or outside
        // the modal), wrap to the first.
        if (active === last || !container.contains(active)) {
          event.preventDefault();
          first.focus();
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [closeOnEscape, onClose]);

  // ---- Overlay click ----
  // The overlay click is distinguished from a click inside the
  // modal by comparing the event target to the current target.
  // A click on the backdrop's own surface (not on a descendant)
  // has `target === currentTarget`; a click on any child of the
  // modal content does not.
  const handleBackdropClick = (
    event: React.MouseEvent<HTMLDivElement>
  ): void => {
    if (!closeOnOverlay) {
      return;
    }
    if (event.target !== event.currentTarget) {
      return;
    }
    onClose();
  };

  return (
    <div
      onClick={handleBackdropClick}
      className={
        'fixed inset-0 z-40 flex items-center justify-center ' +
        'bg-black/50 p-4 backdrop-blur-sm'
      }
    >
      <div
        ref={contentRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title !== undefined ? 'modal-title' : undefined}
        className={
          'relative flex max-h-[90vh] flex-col overflow-hidden ' +
          'rounded-2xl bg-background shadow-medium outline-none ' +
          `${sizeClass} ` +
          (className ?? '')
        }
      >
        {/* ---- Header ---- */}
        {(title !== undefined || showCloseButton) && (
          <div className="flex items-start gap-3 border-b border-neutral-200 px-6 py-4 dark:border-neutral-800">
            <Icon size={22} className={`mt-0.5 shrink-0 ${iconClass}`} />

            {title !== undefined && (
              <h2
                id="modal-title"
                className="min-w-0 flex-1 text-base font-semibold leading-snug text-text dark:text-neutral-100"
              >
                {title}
              </h2>
            )}

            {title === undefined && <div className="flex-1" />}

            {showCloseButton && (
              <button
                type="button"
                onClick={onClose}
                aria-label="Close dialog"
                className={
                  'shrink-0 rounded-md p-1 text-neutral-500 ' +
                  'transition-colors hover:bg-neutral-100 hover:text-neutral-800 ' +
                  'dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100 ' +
                  'focus-visible:outline-none'
                }
              >
                <X size={18} />
              </button>
            )}
          </div>
        )}

        {/* ---- Body ---- */}
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5 text-sm leading-relaxed text-text dark:text-neutral-100">
          {children}
        </div>

        {/* ---- Footer ---- */}
        {footer !== undefined && (
          <div className="flex items-center justify-end gap-2 border-t border-neutral-200 px-6 py-4 dark:border-neutral-800">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
};

// ============================================================
//  Modal — declarative component
// ============================================================

/**
 * The declarative modal component. Renders a `ModalShell` inside
 * a `motion.div` wrapped by `AnimatePresence`, so that opening
 * and closing the modal plays an entrance and exit animation.
 *
 * The `open` prop controls visibility. When it flips from `true`
 * to `false`, `AnimatePresence` keeps the underlying content
 * mounted until the exit animation completes, then unmounts it.
 * The caller's `onClose` fires when the user dismisses the
 * modal (via Escape, backdrop click, or the close button) — the
 * caller is expected to flip its own `open` state in response,
 * which is what triggers the exit animation.
 *
 * When `open` is `false` on the first render, nothing is
 * rendered — no backdrop, no portal, no listeners. That is what
 * keeps a component that conditionally shows a modal from paying
 * any cost for the modal when it is not shown.
 */
export const Modal = ({
  open,
  onClose,
  variant = 'info',
  size = 'md',
  title,
  closeOnOverlay = true,
  closeOnEscape = true,
  showCloseButton = true,
  className,
  footer,
  children,
}: ModalProps) => {
  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          key="modal-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: ANIMATION_DURATION_MS / 1000 }}
        >
          <ModalShell
            variant={variant}
            size={size}
            title={title}
            closeOnOverlay={closeOnOverlay}
            closeOnEscape={closeOnEscape}
            showCloseButton={showCloseButton}
            className={className}
            footer={footer}
            onClose={onClose}
          >
            {children}
          </ModalShell>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
};

// ============================================================
//  Context
// ============================================================

const ModalContext = createContext<ModalAPI | null>(null);

// ============================================================
//  useModal hook
// ============================================================

/**
 * Return the imperative modal API from the enclosing
 * `ModalProvider`.
 *
 * Throws when called outside a provider — the same contract as
 * `useToast`. A component that expects to open modals but is
 * rendered outside the provider has a programming error that
 * would otherwise manifest as silently no-op calls.
 */
export const useModal = (): ModalAPI => {
  const ctx = useContext(ModalContext);
  if (!ctx) {
    throw new Error(
      'useModal() was called outside a <ModalProvider>. ' +
        'Make sure the component is rendered inside the app root.'
    );
  }
  return ctx;
};

// ============================================================
//  Provider
// ============================================================

/**
 * The context provider that owns the imperative modal stack and
 * renders the currently-open modals as portals.
 *
 * Mounted once, at the root of the renderer's component tree.
 * Everything below it can call `useModal().open({...})` to open
 * a modal imperatively.
 *
 * The provider keeps its modals in an array so that a second
 * modal can be opened on top of the first — a common pattern
 * for a confirmation dialog that appears over a form dialog.
 * Escape and overlay-click are handled by the topmost modal
 * only, because the `ModalShell` inside the topmost modal is
 * the last to attach its capture-phase listener.
 *
 * Exit animation timing:
 *
 *   When a modal is closed, the record's `closing` flag is set
 *   to `true` and the record is removed from the state array
 *   only after `ANIMATION_DURATION_MS + 50` milliseconds. The
 *   extra fifty milliseconds is a safety margin — it ensures
 *   the record is not removed before the animation has finished
 *   rendering, which would cause a visible flicker.
 */
export const ModalProvider = ({
  children,
}: {
  children: ReactNode;
}) => {
  const [records, setRecords] = useState<ModalRecord[]>([]);

  // A ref that always mirrors the latest records array. The
  // `close` callback below reads from this ref rather than from
  // the closure-captured state so that its identity stays stable
  // across renders — a consumer that lists `modal.close` in a
  // `useEffect` dependency array will not see it change on every
  // provider render.
  const recordsRef = useRef<ModalRecord[]>(records);
  recordsRef.current = records;

  /**
   * Generate a unique id for a new modal record. Same shape as
   * the id generator in `Toast.tsx`: a timestamp plus a random
   * suffix.
   */
  const generateId = (): string =>
    `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

  /**
   * Mark a modal as closing and schedule its removal from the
   * state array after the exit animation completes. Called by
   * `close` (for a user-initiated close) and directly by the
   * `onClose` path when a modal dismisses itself.
   */
  const dismiss = useCallback((id: string): void => {
    setRecords((prev) =>
      prev.map((r) => (r.id === id ? { ...r, closing: true } : r))
    );
    setTimeout(() => {
      setRecords((prev) => prev.filter((r) => r.id !== id));
    }, ANIMATION_DURATION_MS + 50);
  }, []);

  /**
   * Open a modal and return its id.
   */
  const open = useCallback((options: ModalOptions): string => {
    const id = generateId();
    setRecords((prev) => [...prev, { id, options, closing: false }]);
    return id;
  }, []);

  /**
   * Close the modal with the given id, or the topmost modal when
   * no id is supplied. Invokes the caller's `onClose` before
   * starting the exit animation, so the caller's cleanup logic
   * (if any) runs before the modal starts to fade.
   */
  const close = useCallback(
    (id?: string): void => {
      const current = recordsRef.current;
      const target =
        id !== undefined
          ? current.find((r) => r.id === id)
          : current[current.length - 1];

      if (!target || target.closing) {
        return;
      }

      target.options.onClose?.();
      dismiss(target.id);
    },
    [dismiss]
  );

  /**
   * Close every visible modal. Unlike `close`, which respects
   * the caller's `onClose` and plays each modal's exit animation
   * separately, `closeAll` removes every record immediately —
   * the effect is an abrupt dismissal, which is the correct
   * behaviour when the app is logging out or resetting its
   * state.
   */
  const closeAll = useCallback((): void => {
    for (const record of recordsRef.current) {
      record.options.onClose?.();
    }
    setRecords([]);
  }, []);

  const api = useMemo<ModalAPI>(
    () => ({ open, close, closeAll }),
    [open, close, closeAll]
  );

  return (
    <ModalContext.Provider value={api}>
      {children}

      {records.map((record) => (
        <Modal
          key={record.id}
          open={!record.closing}
          onClose={() => close(record.id)}
          {...(record.options.title !== undefined
            ? { title: record.options.title }
            : {})}
          {...(record.options.variant !== undefined
            ? { variant: record.options.variant }
            : {})}
          {...(record.options.size !== undefined
            ? { size: record.options.size }
            : {})}
          {...(record.options.footer !== undefined
            ? { footer: record.options.footer }
            : {})}
          {...(record.options.closeOnOverlay !== undefined
            ? { closeOnOverlay: record.options.closeOnOverlay }
            : {})}
          {...(record.options.closeOnEscape !== undefined
            ? { closeOnEscape: record.options.closeOnEscape }
            : {})}
          {...(record.options.showCloseButton !== undefined
            ? { showCloseButton: record.options.showCloseButton }
            : {})}
          {...(record.options.className !== undefined
            ? { className: record.options.className }
            : {})}
        >
          {record.options.content}
        </Modal>
      ))}
    </ModalContext.Provider>
  );
};

// ============================================================
//  Default export
// ============================================================

/**
 * The `Modal` component as the default export, matching the
 * convention used by every other component file in the
 * codebase. Consumers that prefer the named form use
 * `import { Modal } from ...`; consumers that prefer the
 * default form use `import Modal from ...`. Both resolve to
 * the same component.
 */
export default Modal;