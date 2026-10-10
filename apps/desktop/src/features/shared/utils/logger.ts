/// <reference types="vite/client" />

/**
 * Renderer-side logger for the WriteSpeare desktop app.
 *
 * A small, level-tagged logger whose five methods mirror the
 * five log functions of the Python pipeline's `core/utils.py` —
 * `debug`, `info`, `success`, `warning`, `error` — so a developer
 * reading a pipeline log and a renderer log sees the same
 * vocabulary in both places.
 *
 * ── Why this module exists ──────────────────────────────────────
 *
 *   The renderer could call `console.log` directly, and several
 *   files in the codebase do (the store files' error handlers, for
 *   example). But a direct `console.*` call has three problems
 *   that a shared logger solves:
 *
 *     1. NO LEVEL. A developer scanning the DevTools console
 *        cannot tell at a glance which lines are informational,
 *        which are warnings, and which are errors. Every caller
 *        invents its own convention — the codebase currently
 *        contains `[topicStore]`, `[useAuth]`, `[api/client]`,
 *        and `[renderer]` prefixes, all slightly different in
 *        shape and capitalization.
 *
 *     2. NO PRODUCTION FILTERING. A debug line that helps a
 *        developer during iteration becomes noise in a packaged
 *        app. Without a filter, every debug line ships to every
 *        user's DevTools console.
 *
 *     3. NO CONSISTENT VISUAL TREATMENT. There is no way for a
 *        reader to scan the console and instantly distinguish
 *        the severity of a line — the color, the tag, and the
 *        prefix are whatever each individual call site chose.
 *
 *   The logger standardizes all three: a single output format, a
 *   build-time filter for the noisy levels, and a per-level
 *   color scheme drawn from the same palette the rest of the
 *   renderer uses.
 *
 * ── The five levels and where they come from ────────────────────
 *
 *   The Python side's `core/utils.py` exports exactly five log
 *   functions:
 *
 *     log_debug    — the noisiest, the least important
 *     log_info     — normal progress messages
 *     log_success  — completion of a meaningful unit of work
 *     log_warning  — a non-fatal problem worth noting
 *     log_error    — a fatal or near-fatal problem
 *
 *   The renderer's logger exposes the same five under the same
 *   names (`success` rather than `ok`, `warning` rather than
 *   `warn`), so a developer who has internalised the pipeline's
 *   vocabulary does not have to learn a second one for the
 *   renderer.
 *
 *   The `success` level has no equivalent in the console API
 *   (which offers `log`, `info`, `warn`, `error`, `debug`). It
 *   dispatches to `console.log` with a green `[OK]` tag —
 *   matching the terminal output the Python side's
 *   `log_success` produces.
 *
 * ── Colored output ──────────────────────────────────────────────
 *
 *   Chromium's DevTools console supports a `%c` format specifier
 *   that applies a CSS rule to the immediately following text.
 *   The logger uses it to color the level tag — the ONLY colored
 *   part of the line. The message text and any extra arguments
 *   render in the console's default styling, so they are
 *   searchable, copyable, and legible as plain text.
 *
 *   The five tag colors are Tailwind's 600-weight values from
 *   the semantic color families the renderer's design system
 *   uses elsewhere: gray for debug, sky for info, emerald for
 *   success, amber for warning, red for error. On a light
 *   DevTools theme these are vivid and clear; on a dark theme
 *   they remain legible, though a future session that wanted
 *   fully theme-aware colors would need to detect the DevTools
 *   theme (the renderer has no API for that) — one fixed color
 *   per level is the correct trade.
 *
 * ── Production filtering ────────────────────────────────────────
 *
 *   In a development build (`import.meta.env.DEV === true`),
 *   every level is emitted. In a production build (`DEV ===
 *   false`), only `warning` and `error` reach the console; the
 *   other three are suppressed.
 *
 *   The split is deliberate. A packaged Electron app's DevTools
 *   console is not visible to the end user by default. The two
 *   surviving levels are the ones a support engineer with
 *   DevTools open would benefit from seeing during a diagnosis —
 *   a failed request, a rejected promise, a component that
 *   threw. The suppressed three (`debug`, `info`, `success`)
 *   are developer scaffolding whose value does not survive the
 *   trip into a production binary.
 *
 *   The check is a build-time constant — Vite replaces
 *   `import.meta.env.DEV` with `true` or `false` at build time —
 *   so the branch is dead-code-eliminated. In a production
 *   bundle, the `if` condition is the literal `false`, and the
 *   three suppressed methods become near-no-ops that cost a
 *   boolean check and a `Set.has` call before returning.
 *
 * ── Extra arguments ─────────────────────────────────────────────
 *
 *   Every method is variadic: `logger.error(message, ...args)`.
 *   The `message` is a string; everything after it is passed
 *   through to the underlying console method unchanged. A
 *   caller that wants to log an `Error` alongside the message
 *   writes `logger.error('loadTopics failed:', err)` and the
 *   DevTools console renders the error object with its stack —
 *   the same behavior a bare `console.error` call would produce.
 *
 *   This is the reason the message is a separate argument rather
 *   than a concatenation: it lets the caller pass structured
 *   data (an Error, a plain object, a number) alongside a
 *   human-readable label, and lets DevTools render each with its
 *   own inspector.
 *
 * ── What this module does NOT do ────────────────────────────────
 *
 *   - It does not persist logs. The console is the only sink. A
 *     future session that wanted to write a log file would need
 *     a main-process surface, which the plan does not declare.
 *
 *   - It does not transmit logs anywhere. The Python pipeline's
 *     own logs stream to the desktop's log viewer through the
 *     marker channel; renderer-side logs are developer
 *     diagnostics, not user-facing data, and have no reason to
 *     leave the process.
 *
 *   - It does not expose a runtime-configurable verbosity. The
 *     active set is fixed at build time. A future session that
 *     wanted a user-configurable level would add a settings-
 *     backed threshold check inside `isLevelActive`.
 *
 *   - It does not use `console.trace` for any level. Stack traces
 *     are expensive to capture, and an error's own `.stack`
 *     already populates when an `Error` object is passed as one
 *     of the extra arguments — which is the idiomatic call.
 */

// ============================================================
//  Public types
// ============================================================

/**
 * The signature of every level's method on the exported logger
 * object.
 *
 * The first argument is always a human-readable message. Every
 * subsequent argument is forwarded to the underlying console
 * method unchanged, so a caller can log an `Error`, a plain
 * object, a number, or a formatted string alongside the message
 * and let DevTools render each with its own inspector.
 *
 * `unknown[]` rather than `any[]` is deliberate: the logger's
 * implementation treats the extra values as opaque — it forwards
 * them but never inspects or depends on their shape — and
 * `unknown` communicates that contract while still allowing the
 * caller to pass anything.
 */
export type LogMethod = (message: string, ...args: unknown[]) => void;

/**
 * The shape of the exported `logger` object.
 *
 * A caller that wants to type a parameter as "any logger"
 * references this interface rather than redeclaring the five
 * method signatures.
 */
export interface Logger {
  /** Noisiest level. Suppressed in production builds. */
  debug: LogMethod;

  /** Normal progress. Suppressed in production builds. */
  info: LogMethod;

  /** Completion of a meaningful operation. Suppressed in
   *  production builds. */
  success: LogMethod;

  /** A non-fatal problem worth noting. Always emitted. */
  warning: LogMethod;

  /** A fatal or near-fatal problem. Always emitted. */
  error: LogMethod;
}

// ============================================================
//  Internal types
// ============================================================

/**
 * The closed set of log levels. Used as the key type for the
 * per-level styling table and as the input to the level gate.
 *
 * Declared as a string-literal union rather than an enum so the
 * values are the same strings the Python side uses in its own
 * log tags — a reader who has seen `[WARN]` in a pipeline log
 * recognizes it in the renderer's console output without a
 * translation step.
 */
type LogLevel = 'debug' | 'info' | 'success' | 'warning' | 'error';

/**
 * The per-level presentation metadata. Each level carries the
 * bracketed tag prepended to the message, the CSS color applied
 * to that tag, and the console method the emission dispatches to.
 */
interface LevelStyle {
  /** The bracketed, uppercase tag shown before the message. */
  readonly tag: string;

  /** A CSS color string applied to the tag via `%c`. */
  readonly color: string;

  /**
   * The `console` method name to dispatch to. See
   * `LEVEL_STYLES` for the choice rationale per level.
   */
  readonly method: 'debug' | 'info' | 'log' | 'warn' | 'error';
}

// ============================================================
//  Per-level styling table
// ============================================================
//
//  A `Record<LogLevel, LevelStyle>` so the compiler enforces
//  exhaustiveness: adding a sixth level to the `LogLevel` union
//  without adding an entry here is a compile-time error, not a
//  silent runtime surprise.
//
//  The `method` choice per level is driven by what the DevTools
//  console's own filtering UI expects. The console offers level
//  checkboxes (Verbose, Info, Warnings, Errors) that toggle
//  visibility of whole classes of output, and the checkbox that
//  hides a given class is the one matched by the console method
//  the level dispatches to:
//
//    - `debug`   → `console.debug` → hidden by the "Verbose"
//                  checkbox (the checkbox some users keep off by
//                  default to suppress framework noise).
//    - `info`    → `console.info`  → hidden by "Info".
//    - `success` → `console.log`   → filtered by "Info" as well,
//                  since `console.log` sits in the "Info" class.
//                  A distinct success method does not exist, so
//                  this is the closest match.
//    - `warning` → `console.warn`  → hidden by "Warnings".
//    - `error`   → `console.error` → hidden by "Errors".
//
//  The colors are Tailwind's 600-weight values from the five
//  semantic families the design system already uses for status
//  text on light backgrounds. See the module docstring for why
//  the 600 weights were chosen over the 400 or 500 weights.

const LEVEL_STYLES: Record<LogLevel, LevelStyle> = {
  debug: {
    tag: '[DEBUG]',
    // Tailwind gray-500. A slightly lighter weight than the
    // other four, because debug is the level a reader's eye
    // should skip over.
    color: '#6b7280',
    method: 'debug',
  },
  info: {
    tag: '[INFO]',
    // Tailwind sky-600, matching the info variant of the toast
    // component.
    color: '#0284c7',
    method: 'info',
  },
  success: {
    tag: '[OK]',
    // Tailwind emerald-600, matching the success variant of the
    // toast component and the "good" status of the validation
    // report's badges.
    color: '#059669',
    method: 'log',
  },
  warning: {
    tag: '[WARN]',
    // Tailwind amber-600, matching the warning variant of the
    // toast component and the "warning" status of the validation
    // report's badges.
    color: '#d97706',
    method: 'warn',
  },
  error: {
    tag: '[ERROR]',
    // Tailwind red-600, matching the error variant of the toast
    // component and the "fail" status of the validation report's
    // badges.
    color: '#dc2626',
    method: 'error',
  },
};

// ============================================================
//  Production filter
// ============================================================
//
//  The two levels that survive a production build. Every other
//  level is suppressed when `import.meta.env.DEV` is `false`.
//
//  Declared as a `ReadonlySet<LogLevel>` rather than a boolean
//  per level so that a future addition of a sixth level has
//  exactly one place to make the "should this level emit in
//  production?" decision — the set's membership.
//
//  The set is module-level so it is constructed once at load
//  rather than on every emission; the gate is called on every
//  log line, and allocation per call would be wasteful for a
//  value that never changes.

const PRODUCTION_ACTIVE_LEVELS: ReadonlySet<LogLevel> = new Set<LogLevel>([
  'warning',
  'error',
]);

/**
 * Return whether a level should be emitted in the current build.
 *
 * A level is active when either the build is a development build
 * (`import.meta.env.DEV === true`), or the level is one of the
 * two always-on levels in `PRODUCTION_ACTIVE_LEVELS`.
 *
 * The `import.meta.env.DEV` reference is replaced by Vite with
 * the literal `true` or `false` at build time, so in a production
 * bundle the entire `if` branch is dead-code-eliminated and the
 * function reduces to a single `Set.has` check.
 */
const isLevelActive = (level: LogLevel): boolean => {
  if (import.meta.env.DEV) {
    return true;
  }
  return PRODUCTION_ACTIVE_LEVELS.has(level);
};

// ============================================================
//  Emission
// ============================================================

/**
 * Emit one log line at the given level.
 *
 * The format string is `%c[LEVEL]%c <message>`. The first `%c`
 * applies the level's color and bold weight to the tag; the
 * second `%c` resets any inherited styling with an empty CSS
 * rule, so the message text renders in the console's default
 * styling and the tag's color does not bleed into it.
 *
 * Every extra argument passed by the caller is appended after
 * the two style strings. DevTools renders each with its own
 * inspector — an `Error` object shows its stack, a plain object
 * shows its properties, a string shows verbatim.
 *
 * The dispatch to the correct console method uses bracket
 * notation on `console` so that the method's `this` binding is
 * preserved — a bare `const fn = console[style.method]; fn(...)`
 * would strip the receiver on some DevTools builds and produce
 * "Illegal invocation" errors on those builds.
 *
 * Never throws. A caller that passes a message with `%c`
 * sequences in it will see the console interpret those
 * sequences — the caller's own `%c` markers are not escaped,
 * because doing so would require a scan of every message on
 * every call to catch a case that essentially never arises. A
 * caller that needs a literal `%c` in its message should use
 * the console's `%c` escaping rules or split the message across
 * arguments.
 */
const emit = (
  level: LogLevel,
  message: string,
  args: readonly unknown[]
): void => {
  if (!isLevelActive(level)) {
    return;
  }

  const style = LEVEL_STYLES[level];

  // The tag gets the level's color and a bold weight; the
  // message resets to default styling. The trailing empty
  // string is the reset rule — DevTools applies each `%c`
  // argument to the text between the specifier and the next
  // `%c`, and an empty rule means "inherit nothing in
  // particular".
  const format = `%c${style.tag}%c ${message}`;
  const tagStyle = `color: ${style.color}; font-weight: 600;`;
  const resetStyle = '';

  console[style.method](
    format,
    tagStyle,
    resetStyle,
    ...args
  );
};

// ============================================================
//  Public API — the logger object
// ============================================================
//
//  The five methods are thin curried wrappers around `emit`.
//  Each fixes the level and forwards the remaining arguments
//  unchanged, so the per-level methods have no logic of their
//  own — the entire emission pipeline lives in one place.
//
//  The arrow functions create a new closure per method, but the
//  object literal itself is evaluated exactly once (at module
//  load), so every method reference on `logger` is stable across
//  renders. A consumer that puts `logger.debug` in a
//  `useEffect` dependency array will not see the reference
//  change on every re-render.

export const logger: Logger = {
  debug: (message, ...args) => {
    emit('debug', message, args);
  },
  info: (message, ...args) => {
    emit('info', message, args);
  },
  success: (message, ...args) => {
    emit('success', message, args);
  },
  warning: (message, ...args) => {
    emit('warning', message, args);
  },
  error: (message, ...args) => {
    emit('error', message, args);
  },
};

// ============================================================
//  Default export
// ============================================================

/**
 * The logger object as the default export, matching the
 * convention used by the sibling shared utility module
 * (`shared/api/client.ts`). Consumers that prefer the named
 * form use `import { logger } from '...'`; consumers that
 * prefer the default form use `import logger from '...'`. Both
 * resolve to the same object — there is no wrapper, so the two
 * forms cannot drift.
 */
export default logger;