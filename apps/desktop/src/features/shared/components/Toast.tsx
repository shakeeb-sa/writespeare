/**
 * WriteSpeare — toast notification system.
 *
 * This module provides the app's toast notifications: brief,
 * non-blocking messages that appear in a corner of the window in
 * response to an action. A toast is what a component uses to say
 * "the topic was created", "the export failed", "the DeepSeek
 * session expired" — a message the user should see but that does
 * not warrant a modal dialog blocking their work.
 *
 * Two pieces compose the module:
 *
 *   `ToastProvider` — the context provider. Mounted once, at the
 *     root of the renderer's component tree (see `App.tsx`). It
 *     owns the toast state, renders the viewport, and exposes
 *     the imperative API to its descendants through a React
 *     context.
 *
 *   `useToast()` — the hook. A component calls it to obtain the
 *     API object, then calls `toast.success(...)`,
 *     `toast.error(...)`, or one of the other two variant
 *     methods to fire a toast. The hook is defined here and
 *     re-exported from `hooks/useToast.ts` so that a future
 *     refactor can move the implementation without touching the
 *     import site.
 *
 * Four variants — what each is for:
 *
 *   success — an action completed successfully. "Topic created",
 *             "Article exported to Documents", "Settings saved".
 *             Rendered with a green check icon. Never interrupts
 *             the user — the operation succeeded and the toast
 *             is confirmation, not alarm.
 *
 *   error   — an action failed. "Unable to reach the server",
 *             "Invalid credentials", "Export failed: permission
 *             denied". Rendered with a red X icon. Uses
 *             `role="alert"` and `aria-live="assertive"` so
 *             screen readers announce it immediately rather than
 *             at the next polite pause.
 *
 *   warning — an action succeeded but produced a caveat. "Saved
 *             — but the backend did not acknowledge the change".
 *             Rendered with an amber triangle icon.
 *
 *   info    — neutral information. "DeepSeek is now connected",
 *             "Source extraction started". Rendered with a blue
 *             circle-i icon.
 *
 * Auto-dismiss:
 *
 *   Every toast dismisses itself after a default duration of five
 *   seconds. The duration is overridable per toast — a caller
 *   that knows its message is more important than usual can pass
 *   `{ duration: 10000 }`. Passing `{ duration: 0 }` produces a
 *   toast that never auto-dismisses; the user must close it
 *   manually. That escape hatch exists for messages that demand
 *   acknowledgement, though the plan does not currently call for
 *   any.
 *
 *   Five seconds is long enough for a user reading at a normal
 *   pace to finish a short message, and short enough that the
 *   viewport does not accumulate a wall of toasts during a burst
 *   of activity. When more than five toasts are fired in rapid
 *   succession, the oldest is dropped to keep the viewport
 *   readable.
 *
 * Why the API is imperative and not declarative:
 *
 *   The alternative design — a `<Toast variant="success">`
 *   component a caller renders conditionally — would require the
 *   caller to manage the toast's lifecycle: mount it, keep it
 *   mounted until the duration elapses, then unmount it. Every
 *   caller would re-implement the timer, the animation, and the
 *   cleanup. The imperative API centralizes all of that in the
 *   provider: the caller writes one line, and the provider owns
 *   the toast from birth to dismissal.
 *
 *   The imperative form also matches how the caller usually
 *   wants to fire a toast — from the `.then()` or `.catch()` of
 *   an async operation, or from an event handler, where a
 *   declarative component would require extra state to track
 *   whether the toast is currently visible.
 *
 * Why the file uses `framer-motion` for animations and not CSS
 * transitions alone:
 *
 *   The `AnimatePresence` wrapper from framer-motion solves a
 *   problem that CSS transitions cannot: keeping a component
 *   mounted after it has been removed from the parent's state,
 *   so that its exit animation can play before the DOM node is
 *   destroyed. Without `AnimatePresence`, a CSS-only solution
 *   would require the provider to track a "dismissing" flag on
 *   every toast and remove it from state only after a
 *   `transitionend` listener fired. `AnimatePresence` is the
 *   standard solution to that problem, and it is already a
 *   dependency of the app (declared in `package.json`).
 *
 * Accessibility:
 *
 *   The viewport is a `region` with `aria-label` describing its
 *   purpose. Each toast carries a `role` and an `aria-live`
 *   value appropriate to its variant (see the variant table
 *   above). The close button has an `aria-label`. The toast
 *   content — title and message — is plain text, so a screen
 *   reader announces it without any additional markup.
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
 * The four variants a toast can take. See the file header for
 * the semantic meaning of each.
 */
export type ToastVariant = 'success' | 'error' | 'warning' | 'info';

/**
 * Optional per-toast configuration. Every field is optional; a
 * caller that passes no options object gets the defaults
 * documented on the fields below.
 */
export interface ToastOptions {
  /**
   * An optional short title rendered in bold above the message.
   * Useful for a two-line toast — "Export failed" as the title,
   * "Permission denied for this folder" as the message. A caller
   * that omits it gets a single-line toast.
   */
  title?: string;

  /**
   * How long the toast stays visible, in milliseconds. Defaults
   * to `DEFAULT_DURATION` (5000 ms). Passing `0` produces a
   * toast that never auto-dismisses — the user must close it
   * manually.
   */
  duration?: number;
}

/**
 * The imperative API returned by `useToast()`. A caller obtains
 * an instance of this object once at the top of its component
 * and calls the variant methods whenever a toast needs to fire.
 *
 * The four variant methods all share the same signature —
 * `(message, options?)` — and all return the id of the toast
 * they created. The id can be passed to `dismiss` to close the
 * toast before its auto-dismiss timer fires; the typical reason
 * is that the operation the toast was reporting has been
 * resolved in the meantime (say, the user reconnected and the
 * "offline" toast is now misleading).
 */
export interface ToastAPI {
  success: (message: string, options?: ToastOptions) => string;
  error: (message: string, options?: ToastOptions) => string;
  warning: (message: string, options?: ToastOptions) => string;
  info: (message: string, options?: ToastOptions) => string;

  /**
   * Dismiss a single toast by its id. A no-op if the id is not
   * currently visible — the toast may have already auto-dismissed,
   * which is not an error.
   */
  dismiss: (id: string) => void;

  /**
   * Dismiss every visible toast. Used on logout (to clear any
   * session-scoped messages) and by the Settings page's "test
   * notifications" button.
   */
  clear: () => void;
}

// ============================================================
//  Internal types
// ============================================================

/**
 * The shape of a toast as the provider stores it. This is the
 * public shape plus an id and a resolved variant. The `title`
 * field appears here only when the caller supplied one; the
 * object is built with a conditional spread so that
 * `exactOptionalPropertyTypes` is satisfied without assigning
 * `undefined`.
 */
interface ToastRecord {
  id: string;
  variant: ToastVariant;
  message: string;
  title?: string;
}

// ============================================================
//  Constants
// ============================================================

/**
 * The default duration of a toast, in milliseconds. See the file
 * header for why five seconds was chosen.
 */
const DEFAULT_DURATION = 5000;

/**
 * The maximum number of toasts visible at once. When a new toast
 * arrives and this many are already on screen, the oldest is
 * dismissed first. See the file header for the reasoning.
 */
const MAX_TOASTS = 5;

// ============================================================
//  Variant styles
// ============================================================
//
//  One entry per variant, holding the lucide icon used in the
//  toast and the two Tailwind class strings that give the
//  container and the icon their color treatment. Declaring this
//  as a `Record<ToastVariant, ...>` forces the compiler to
//  enforce exhaustiveness: adding a fifth variant to the
//  `ToastVariant` union without adding an entry here is a
//  compile error, which is exactly the desired failure mode.
//
//  The colors are the standard Tailwind semantic palettes
//  (emerald, red, amber, sky) rather than the app's brand
//  palette. Status colors are a semantic axis — the app's brand
//  palette is an identity axis — and mixing the two would make
//  the toasts look like they belong to a different design
//  system than the rest of the app. The brand palette is
//  reserved for the app's primary actions and surfaces; status
//  feedback uses the color the user already associates with the
//  status.

interface VariantStyle {
  icon: LucideIcon;
  containerClass: string;
  iconClass: string;
}

const VARIANT_STYLES: Record<ToastVariant, VariantStyle> = {
  success: {
    icon: CheckCircle,
    containerClass:
      'bg-emerald-50 border-emerald-200 text-emerald-900 ' +
      'dark:bg-emerald-950/60 dark:border-emerald-900 ' +
      'dark:text-emerald-100',
    iconClass: 'text-emerald-600 dark:text-emerald-400',
  },
  error: {
    icon: XCircle,
    containerClass:
      'bg-red-50 border-red-200 text-red-900 ' +
      'dark:bg-red-950/60 dark:border-red-900 ' +
      'dark:text-red-100',
    iconClass: 'text-red-600 dark:text-red-400',
  },
  warning: {
    icon: AlertTriangle,
    containerClass:
      'bg-amber-50 border-amber-200 text-amber-900 ' +
      'dark:bg-amber-950/60 dark:border-amber-900 ' +
      'dark:text-amber-100',
    iconClass: 'text-amber-600 dark:text-amber-400',
  },
  info: {
    icon: Info,
    containerClass:
      'bg-sky-50 border-sky-200 text-sky-900 ' +
      'dark:bg-sky-950/60 dark:border-sky-900 ' +
      'dark:text-sky-100',
    iconClass: 'text-sky-600 dark:text-sky-400',
  },
};

// ============================================================
//  Context
// ============================================================

/**
 * The React context that carries the toast API down the tree.
 *
 * The context's value is `ToastAPI | null` rather than
 * `ToastAPI` so that `useToast()` can distinguish "the hook was
 * called inside a `ToastProvider`" from "the hook was called
 * outside one" — a distinction that produces a clear error
 * message when the second case happens, rather than a null
 * dereference at the first method call.
 */
const ToastContext = createContext<ToastAPI | null>(null);

// ============================================================
//  useToast hook
// ============================================================

/**
 * Return the toast API from the enclosing `ToastProvider`.
 *
 * Throws when called outside a provider. The throw is
 * deliberate — a component that expects to fire toasts but is
 * somehow rendered outside the provider has a programming error
 * that would otherwise manifest as a silent "my toasts never
 * appear" bug. The error message names the hook and the
 * provider so the fix is obvious.
 *
 * Every consumer of this hook is a component that lives inside
 * the app's provider tree (which is the entire app, since
 * `ToastProvider` mounts at the root). The throw is therefore
 * unreachable in normal use; it exists to catch a refactor
 * mistake at the moment it happens, not to handle a runtime
 * condition.
 */
export const useToast = (): ToastAPI => {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error(
      'useToast() was called outside a <ToastProvider>. ' +
        'Make sure the component is rendered inside the app root.'
    );
  }
  return ctx;
};

// ============================================================
//  Toast item
// ============================================================

/**
 * Props for the internal `ToastItem` component. Not exported —
 * no consumer outside this module ever renders a toast item
 * directly; the provider renders them.
 */
interface ToastItemProps {
  toast: ToastRecord;
  onDismiss: (id: string) => void;
}

/**
 * Render a single toast. The container is a `motion.div` so
 * that `AnimatePresence` can play its enter and exit animations;
 * the `layout` prop tells framer-motion to animate the sibling
 * toasts' positions when this one is added or removed, which is
 * what produces the smooth "push down / pull up" effect when a
 * stack of toasts grows or shrinks.
 *
 * The toast's `role` and `aria-live` are chosen by variant:
 * errors interrupt (`role="alert"`, `aria-live="assertive"`);
 * the other three use the polite channel (`role="status"`,
 * `aria-live="polite"`). This is the same convention assistive
 * technology uses for form validation — a fatal error deserves
 * the user's immediate attention, a confirmation does not.
 */
const ToastItem = ({ toast, onDismiss }: ToastItemProps) => {
  const { icon: Icon, containerClass, iconClass } =
    VARIANT_STYLES[toast.variant];

  const isError = toast.variant === 'error';

  return (
    <motion.div
      layout
      initial={{ opacity: 0, x: 48 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 48 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
      role={isError ? 'alert' : 'status'}
      aria-live={isError ? 'assertive' : 'polite'}
      className={
        'pointer-events-auto flex items-start gap-3 rounded-xl ' +
        'border p-4 shadow-medium ' +
        containerClass
      }
    >
      <Icon size={20} className={`mt-0.5 shrink-0 ${iconClass}`} />

      <div className="min-w-0 flex-1">
        {toast.title !== undefined && (
          <p className="text-sm font-semibold leading-snug">
            {toast.title}
          </p>
        )}
        <p className="text-sm leading-snug break-words">
          {toast.message}
        </p>
      </div>

      <button
        type="button"
        onClick={() => onDismiss(toast.id)}
        aria-label="Dismiss notification"
        className={
          'shrink-0 opacity-60 transition-opacity hover:opacity-100 ' +
          'focus-visible:opacity-100'
        }
      >
        <X size={16} />
      </button>
    </motion.div>
  );
};

// ============================================================
//  Toast viewport
// ============================================================

/**
 * Props for the internal `ToastViewport` component.
 */
interface ToastViewportProps {
  toasts: readonly ToastRecord[];
  onDismiss: (id: string) => void;
}

/**
 * Render the stack of visible toasts in the fixed top-right
 * corner of the window.
 *
 * The container is `fixed` and uses `pointer-events-none` so
 * that the empty area around the toasts does not intercept
 * clicks on the underlying application UI. Each individual
 * toast re-enables pointer events on itself so its close button
 * and any interactive content is clickable.
 *
 * The `z-50` class places the viewport above every other element
 * in the app. Tailwind's default scale runs from `z-0` to
 * `z-50`; the app does not currently declare any stacking
 * context higher than this, so `z-50` is the topmost value the
 * viewport needs.
 *
 * `AnimatePresence` tracks its direct children by their `key`
 * prop. Each toast has a unique id as its key, so when the
 * provider removes a toast from the `toasts` array,
 * `AnimatePresence` keeps the corresponding `ToastItem`
 * mounted until its exit animation completes and then
 * unmounts it. The `initial={false}` option suppresses the
 * enter animation on the very first render — it does not
 * matter here since the toasts array is empty on mount, but
 * the option is set to make the intent explicit.
 */
const ToastViewport = ({ toasts, onDismiss }: ToastViewportProps) => {
  return (
    <div
      role="region"
      aria-label="Notifications"
      className={
        'pointer-events-none fixed right-4 top-4 z-50 ' +
        'flex w-full max-w-sm flex-col gap-2'
      }
    >
      <AnimatePresence initial={false}>
        {toasts.map((toast) => (
          <ToastItem key={toast.id} toast={toast} onDismiss={onDismiss} />
        ))}
      </AnimatePresence>
    </div>
  );
};

// ============================================================
//  Provider
// ============================================================

/**
 * The context provider that owns the app's toast state and
 * renders the viewport.
 *
 * Mounted once, at the root of the renderer's component tree
 * (see `App.tsx`). Everything below it can call `useToast()` to
 * fire toasts.
 *
 * State:
 *
 *   `toasts` — the visible toasts, in display order (oldest
 *     first). New toasts are appended and appear at the bottom
 *     of the viewport; the oldest sits at the top and is the
 *     first to be dropped when the stack overflows.
 *
 *   `timersRef` — a Map from toast id to the `setTimeout`
 *     handle that will auto-dismiss it. The Map is what allows
 *     `dismiss` to cancel a pending timer when the user closes
 *     a toast manually — without it, the timer would fire
 *     later, find the toast already gone, and produce a
 *     harmless but noisy state update. The ref (rather than a
 *     state variable) is correct here because the Map's
 *     contents are not part of any render — mutating it does
 *     not and should not trigger a re-render.
 *
 * Cleanup:
 *
 *   The `useEffect` with an empty dependency array installs a
 *   cleanup function that clears every pending timer when the
 *   provider unmounts. Without it, a timer that was still
 *   pending at unmount time would fire after the component
 *   tree was gone and produce a React warning about a state
 *   update on an unmounted component. The provider normally
 *   lives for the app's entire lifetime and never unmounts,
 *   but StrictMode's double-invocation in development — and
 *   any future test that mounts and unmounts the provider —
 *   makes the cleanup non-optional.
 *
 * The `api` object is memoized with `useMemo` so that its
 * identity is stable across renders. Consumers of `useToast()`
 * receive the same object reference on every render unless
 * one of the underlying callbacks changes. This matters because
 * a consumer that lists the `toast` object in a `useEffect`
 * dependency array (a common pattern for firing a toast when a
 * piece of state changes) would otherwise re-run its effect on
 * every render.
 */
export const ToastProvider = ({ children }: { children: ReactNode }) => {
  const [toasts, setToasts] = useState<ToastRecord[]>([]);
  const timersRef = useRef<
    Map<string, ReturnType<typeof setTimeout>>
  >(new Map());

  /**
   * Dismiss a toast by id — remove it from state and cancel its
   * pending auto-dismiss timer, if any.
   */
  const dismiss = useCallback((id: string) => {
    const timer = timersRef.current.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  /**
   * The internal "add a toast" function. The four public variant
   * methods on the API all delegate to this one, passing their
   * variant as an argument. Centralizing the logic here means
   * the id-generation, the overflow-trimming, and the timer
   * installation happen in exactly one place.
   *
   * The id is generated from the current time plus a random
   * suffix. The time component is included for human readability
   * during debugging — two toasts fired in the same millisecond
   * would still be distinguished by the random suffix, so
   * collisions are effectively impossible in practice.
   */
  const add = useCallback(
    (
      variant: ToastVariant,
      message: string,
      options?: ToastOptions
    ): string => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      const duration = options?.duration ?? DEFAULT_DURATION;

      const record: ToastRecord = {
        id,
        variant,
        message,
        ...(options?.title !== undefined ? { title: options.title } : {}),
      };

      setToasts((prev) => {
        const next = [...prev, record];
        if (next.length <= MAX_TOASTS) {
          return next;
        }
        // Drop the oldest toasts and cancel their pending timers
        // — otherwise those timers would fire later against ids
        // that are no longer in the state, which is harmless but
        // produces noise in the console.
        const dropped = next.slice(0, next.length - MAX_TOASTS);
        for (const toast of dropped) {
          const timer = timersRef.current.get(toast.id);
          if (timer !== undefined) {
            clearTimeout(timer);
            timersRef.current.delete(toast.id);
          }
        }
        return next.slice(next.length - MAX_TOASTS);
      });

      if (duration > 0) {
        const timer = setTimeout(() => {
          setToasts((prev) => prev.filter((t) => t.id !== id));
          timersRef.current.delete(id);
        }, duration);
        timersRef.current.set(id, timer);
      }

      return id;
    },
    []
  );

  /**
   * Clear every visible toast and cancel every pending timer.
   * The public API exposes this as `toast.clear()`.
   */
  const clear = useCallback(() => {
    for (const timer of timersRef.current.values()) {
      clearTimeout(timer);
    }
    timersRef.current.clear();
    setToasts([]);
  }, []);

  /**
   * Clear all pending timers on unmount. See the component's
   * docstring for why this is required.
   */
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const timer of timers.values()) {
        clearTimeout(timer);
      }
      timers.clear();
    };
  }, []);

  /**
   * The stable, memoized API object exposed to consumers. The
   * four variant methods are thin curried wrappers around the
   * `add` callback — they fix the variant and forward the
   * remaining arguments. The `dismiss` and `clear` methods are
   * exposed directly.
   */
  const api = useMemo<ToastAPI>(
    () => ({
      success: (message, options) => add('success', message, options),
      error: (message, options) => add('error', message, options),
      warning: (message, options) => add('warning', message, options),
      info: (message, options) => add('info', message, options),
      dismiss,
      clear,
    }),
    [add, dismiss, clear]
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
};

// ============================================================
//  Default export
// ============================================================

/**
 * Same component as the named export, provided for consumers
 * that prefer the default-import form. `App.tsx` uses the named
 * form (`import { ToastProvider } from ...`), so this default
 * is a convenience rather than a load-bearing export.
 */
export default ToastProvider;