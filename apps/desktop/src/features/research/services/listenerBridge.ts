/**
 * listenerBridge — the marker-stream bridge for the automation pipeline.
 *
 * Every Python script the main process spawns writes two kinds of
 * output to stdout:
 *
 *   1. Human-readable log lines. Plain text, no prefix. Written by
 *      `core.utils.log_info` / `log_warning` / `log_error`. The
 *      bridge ignores these — they are for the developer who reads
 *      the terminal, not for the GUI.
 *
 *   2. Structured markers. Lines of the exact form
 *
 *          ::ROOKIE::<TYPE>::<compact-json>\n
 *
 *      Written by `core.output.emit_marker`. Every marker carries a
 *      marker type string (`SEARCH_PROGRESS`, `EXTRACT_DONE`,
 *      `CAPTCHA_REQUIRED`, and so on) and a JSON payload whose shape
 *      is documented per-marker-type in `core/output.py`. The bridge
 *      parses these lines and forwards them to the renderer.
 *
 * This module's job is narrow and specific:
 *
 *     ATTACH  → to a spawned Python child process's stdout
 *     BUFFER  → partial lines across stream chunk boundaries
 *     PARSE   → each complete line into {type, payload}
 *     BROADCAST → to every renderer window on one IPC channel
 *
 * It does NOT:
 *
 *   - spawn processes (that is `childProcessManager.ts`)
 *   - know when a process exits (that is the caller's concern; this
 *     module detaches automatically when the child's stdout closes)
 *   - interpret the payload (that is the renderer's concern)
 *   - validate that a marker's payload matches its declared type
 *     (again the renderer's concern — the bridge is a transport)
 *   - handle stderr (Python's log output goes to stdout; stderr is
 *     reserved for uncaught tracebacks, which the caller logs)
 *   - map exit codes to anything (that is the caller's concern —
 *     `childProcessManager` sees the exit event and classifies it;
 *     the bridge only sees stdout)
 *
 * Why the bridge exists as a separate module:
 *
 *   Without it, every service that spawns Python — searchService,
 *   extractionService, and later the writer and validation
 *   services — would duplicate the same parsing logic: buffering
 *   chunks, splitting on `\n`, stripping `\r`, checking for the
 *   `::ROOKIE::` prefix, splitting on the second `::`, calling
 *   `JSON.parse` inside a try/catch, and calling
 *   `webContents.send` on every renderer window. That is roughly
 *   forty lines of fiddly code per service, and it would drift.
 *   The bridge centralises it into one place where it can be
 *   tested once and trusted everywhere.
 *
 * The single-channel design:
 *
 *   The bridge emits every marker over one IPC channel,
 *   `research:marker`, with the marker type carried inside the
 *   event payload as a field rather than encoded in the channel
 *   name. This is deliberate. A design that used one channel per
 *   marker type (`research:progress`, `research:result`,
 *   `research:captcha`, …) would require every new marker type to
 *   be added to three places: `core/output.py`, this file, and the
 *   preload's channel allowlist. The single-channel design requires
 *   adding a new marker type to exactly one place — the renderer's
 *   dispatcher — and everything else flows through unchanged.
 *
 *   The trade-off is that the renderer has to `switch` on the type
 *   string instead of registering a handler per channel. That switch
 *   is a single function in one place, and it is the correct place
 *   for the logic — the renderer is the only layer that knows what
 *   to do with a `SEARCH_RESULT` versus a `CAPTCHA_REQUIRED`.
 *
 * Line buffering — why the bridge does not assume one chunk = one
 * line:
 *
 *   Node's `stream.on('data')` fires whenever the underlying OS
 *   pipe has bytes available. A single `print(...)` in Python can
 *   arrive at the bridge as:
 *
 *     * one chunk (the common case for short lines)
 *     * two or more chunks (a long line split across the OS pipe
 *       buffer boundary)
 *     * a chunk containing the tail of one line and the head of
 *       the next
 *
 *   The bridge therefore maintains a per-stream text buffer. On
 *   each `data` event, it appends the incoming chunk to the buffer
 *   and then drains every complete line (terminated by `\n`) from
 *   the front. Any trailing text without a newline stays in the
 *   buffer until the next chunk arrives — or until the stream
 *   ends, at which point the bridge flushes whatever is left
 *   (a marker emitted without a trailing newline is unusual but
 *   possible if the process is killed mid-write).
 *
 * The CRLF handling:
 *
 *   Python on Windows writes `\r\n` for a `print(...)` by default
 *   when the stream is in text mode. The bridge strips a trailing
 *   `\r` from every line before parsing, so a marker emitted on
 *   Windows parses exactly as it would on Linux.
 *
 * The auto-detach on stream end:
 *
 *   When the child process exits, its stdout stream emits `end`.
 *   The bridge listens for that event and detaches its listeners
 *   automatically. The caller does NOT have to remember to detach
 *   — a spawned child that runs to completion cleans up its
 *   listeners on its own. The `attachToProcess` function still
 *   RETURNS a manual detach function, so a caller that wants to
 *   detach early (a cancellation path that kills the process
 *   before stdout closes) has a way to do so.
 *
 * Why the module is a singleton, and why that is fine:
 *
 *   Node's module cache guarantees that this file is evaluated
 *   exactly once per process. Every service that imports
 *   `attachToProcess` gets the same function, closing over the
 *   same module-level state. There is no class instance to
 *   construct, no `getInstance()` to call, no factory — the module
 *   itself IS the singleton.
 *
 *   The one piece of module-level state is `MARKER_EVENT_CHANNEL`
 *   — a constant string. Every marker emitted by every child
 *   process travels over that one channel. The bridge keeps no
 *   per-process state at the module level; the buffer lives inside
 *   the `attachToProcess` closure, one per spawned process. This
 *   is what lets two searches running in parallel (a user who
 *   starts a second topic while the first is still researching)
 *   have independent buffers without interfering with each other.
 *
 * Contract with the renderer:
 *
 *   The renderer's preload exposes `window.electronAPI.on(channel,
 *   callback)` — a generic listener registration (see
 *   `src/main/preload.ts`). A renderer component that wants to
 *   receive markers calls:
 *
 *       window.electronAPI.on('research:marker', (event) => {
 *         // event is a MarkerEvent: { type, payload }
 *       });
 *
 *   The preload does not type or validate the event — it is passed
 *   through verbatim. Type information flows from this module's
 *   exported `MarkerEvent` interface, which the renderer-side
 *   dispatcher should narrow at runtime before using any payload
 *   field.
 *
 * Contract with `core/output.py`:
 *
 *   The marker type strings this module's `MarkerType` union
 *   declares are the SAME strings that `core/output.py` emits.
 *   That file is the authoritative source — if a new marker type
 *   is ever added to the pipeline, it is added to
 *   `core/output.py` first, then to this file's union, then to the
 *   renderer's dispatcher. The bridge will forward a marker whose
 *   type is not in the union (it uses the type string as an opaque
 *   value), so a new marker type added only to `core/output.py`
 *   will reach the renderer intact — the union in this file is a
 *   documentation aid, not a runtime filter.
 */

import { BrowserWindow } from 'electron';
import type { ChildProcess } from 'node:child_process';

// =============================================================================
//  Public types
// =============================================================================

/**
 * The marker types the WriteSpeare pipeline currently emits.
 *
 * Every string in this union is a constant declared in
 * `apps/desktop/src/resources/scripts/core/output.py`. That file is
 * the authoritative source for these strings; this union is a
 * mirror that exists so a TypeScript consumer — the renderer's
 * dispatcher, a test, a future admin tool — has a named type to
 * switch on.
 *
 * A marker whose type is not a member of this union is still
 * forwarded by the bridge. The bridge uses `MarkerType | string`
 * as the type of the `type` field specifically so that a marker
 * added to `core/output.py` without a corresponding update here
 * does not get silently dropped.
 */
export type MarkerType =
  | 'TASK_START'
  | 'TASK_END'
  | 'SEARCH_PROGRESS'
  | 'SEARCH_RESULT'
  | 'EXTRACT_PROGRESS'
  | 'EXTRACT_DONE'
  | 'WRITER_PROGRESS'
  | 'WRITER_DONE'
  | 'VALIDATION_PROGRESS'
  | 'VALIDATION_DONE'
  | 'CAPTCHA_REQUIRED'
  | 'CAPTCHA_SOLVED'
  | 'MANUAL_ACTION';

/**
 * A parsed marker event, ready to cross the IPC boundary.
 *
 * The `type` field is typed as `MarkerType | string` rather than
 * `MarkerType` alone, for the forward-compatibility reason
 * documented on `MarkerType` above: a marker emitted by a script
 * that adds a type this union does not yet know about will still
 * reach the renderer with its type string intact.
 *
 * The `payload` field is typed as `unknown`, not a discriminated
 * union over `type`. A discriminated union would force the bridge
 * to know the shape of every marker's payload — a coupling that
 * would require editing this file every time `core/output.py`
 * changes a payload. Instead, the payload is opaque at this layer
 * and each consumer narrows it: the renderer's dispatcher knows
 * that a `SEARCH_RESULT` carries a `candidates` array, the
 * `CAPTCHA_REQUIRED` handler knows it carries a `prompt` string,
 * and so on. The bridge does not need to know any of that.
 */
export interface MarkerEvent {
  type: MarkerType | string;
  payload: unknown;
}

// =============================================================================
//  Constants
// =============================================================================

/**
 * The single IPC channel over which every marker reaches the
 * renderer. See the file header for the rationale behind using one
 * channel instead of one-per-marker-type.
 *
 * The channel name is namespaced to `research` because the majority
 * of markers come from the search and extraction stages, and because
 * the plan's file tree places this module under
 * `features/research/services/`. The `writer` and `validation`
 * stages ALSO emit markers over this same channel — the renderer's
 * dispatcher routes them to their respective stores by marker type,
 * not by channel.
 *
 * Exported so that the preload and any test can reference the
 * channel by name without hard-coding the string literal. Under
 * the current architecture, the preload's `on(channel, callback)`
 * method is a generic listener that takes the channel as an
 * argument, so no code outside this module and the renderer's
 * subscription call needs to name the channel — but exporting the
 * constant is the correct hygiene for the day a wrapper like
 * `onMarker(callback)` is added on top of the generic listener.
 */
export const MARKER_EVENT_CHANNEL = 'research:marker';

/**
 * The literal prefix that every marker line starts with. Must match
 * `core/output.py`'s marker emission, which writes
 * `f"::ROOKIE::{marker_type}::{json_payload}"`.
 *
 * Declared as a local constant rather than imported from a shared
 * location because the two sides of this contract are one Python
 * file and one TypeScript file, and the plan's tree provides no
 * shared constants module that spans the two languages. If the
 * prefix ever changes, both files change in the same commit — a
 * fact that is worth the small duplication.
 */
const MARKER_PREFIX = '::ROOKIE::';

// =============================================================================
//  Public API
// =============================================================================

/**
 * Attach the bridge to a spawned Python child process's stdout,
 * and return a cleanup function that detaches it.
 *
 * The child is expected to have been spawned with its stdout piped
 * — the `stdio: ['pipe', 'pipe', 'pipe']` configuration (or its
 * equivalent). A child with no stdout stream (a process spawned
 * with `stdio: 'ignore'`, or one whose stdout was set to `null`)
 * produces a no-op cleanup function and no listeners.
 *
 * Behavior:
 *
 *   1. Attaches a `data` listener to the child's stdout. Each time
 *      the underlying pipe delivers bytes, the bridge appends them
 *      to a per-process buffer, then drains every complete line
 *      from the front of the buffer. Each complete line is passed
 *      to the parser; a parsed marker is forwarded to every
 *      renderer window.
 *
 *   2. Attaches an `end` listener that fires when the child's
 *      stdout closes (which happens when the child exits, or when
 *      the parent closes its end of the pipe). On `end`, the
 *      bridge flushes whatever partial line remains in the buffer,
 *      then removes both listeners.
 *
 *   3. Returns a cleanup function that removes the listeners
 *      immediately, without waiting for `end`. A caller that kills
 *      the child early (a user cancellation, a timeout) can call
 *      this to release the listeners right away. After the
 *      cleanup function has been called once, calling it again is
 *      a no-op.
 *
 * The bridge does NOT listen for the child's `exit` or `close`
 * events. Those are the caller's concern — `childProcessManager`
 * (a sibling of this module in the plan's file tree) classifies
 * the exit code and reports a terminal status. The bridge only
 * cares about stdout's content.
 *
 * Concurrency:
 *
 *   A caller that spawns two Python processes in parallel (two
 *   topics researching simultaneously) calls `attachToProcess`
 *   twice — once per child. Each call creates an independent
 *   buffer that closes over its own locals; the two calls do not
 *   interfere. The bridge broadcasts on the same channel either
 *   way — the renderer distinguishes the two streams by the
 *   `topicId` field carried in each marker's payload.
 *
 * @param child - The spawned Python child process.
 * @returns A cleanup function that detaches the bridge's
 *          listeners. Safe to call more than once.
 */
export const attachToProcess = (child: ChildProcess): (() => void) => {
  const stdout = child.stdout;
  if (!stdout) {
    // The child was spawned without a piped stdout. Nothing to
    // bridge; return a no-op cleanup so the caller's uniform
    // "detach when done" pattern does not need a null check.
    return () => undefined;
  }

  // ---- Per-process state ----
  // The buffer and the `detached` flag live inside this closure,
  // so a second call to `attachToProcess` gets its own copy. See
  // the "Concurrency" note above.
  let buffer = '';
  let detached = false;

  // ---- Drain helper ----
  // Given the accumulated buffer text, split it on `\n` and process
  // every complete line. Returns the trailing (unterminated) text
  // that should remain in the buffer for the next chunk.
  //
  // The function is written as a loop rather than a `split('\n')`
  // because `split` allocates a temporary array for the whole
  // buffer on every chunk — a small but unnecessary allocation when
  // a large chunk carries many short lines. The loop slices the
  // buffer one line at a time and discards each after processing.
  const drain = (text: string): string => {
    let remaining = text;
    while (true) {
      const newlineIndex = remaining.indexOf('\n');
      if (newlineIndex === -1) {
        // No complete line remains. Everything from here to the
        // end of the buffer stays for the next chunk.
        return remaining;
      }
      // Extract the line (without its terminating \n).
      let line = remaining.slice(0, newlineIndex);
      // Strip a trailing \r (CRLF from Windows Python's text mode).
      if (line.endsWith('\r')) {
        line = line.slice(0, -1);
      }
      remaining = remaining.slice(newlineIndex + 1);
      // Process the line — non-marker lines are ignored inside.
      processLine(line);
    }
  };

  // ---- Data handler ----
  const onData = (chunk: string | Buffer): void => {
    if (detached) return;
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
    buffer += text;
    buffer = drain(buffer);
  };

  // ---- End handler ----
  // When the child's stdout closes, flush whatever partial text
  // remains (a marker written without a trailing newline, which
  // happens if the process was killed mid-write). Then detach the
  // listeners so the stream can be garbage-collected.
  const onEnd = (): void => {
    if (detached) return;
    if (buffer.length > 0) {
      let line = buffer;
      if (line.endsWith('\r')) {
        line = line.slice(0, -1);
      }
      buffer = '';
      processLine(line);
    }
    detach();
  };

  // ---- Detach ----
  // Idempotent: the `detached` flag makes a second call a no-op.
  // The `off` calls (rather than `removeListener` or `removeAllListeners`)
  // remove only the two listeners this specific attachment added,
  // leaving any other listeners on the stream untouched. That
  // matters because a caller may have attached its own `data`
  // handler to the same stdout (for logging, or for a progress
  // counter) — this module must not remove them.
  const detach = (): void => {
    if (detached) return;
    detached = true;
    stdout.off('data', onData);
    stdout.off('end', onEnd);
  };

  // ---- Attach ----
  stdout.on('data', onData);
  stdout.on('end', onEnd);

  return detach;
};

// =============================================================================
//  Internal — line processing
// =============================================================================

/**
 * Process one complete line of child-process stdout.
 *
 * Non-marker lines are silently ignored. A line is a marker if and
 * only if it starts with `::ROOKIE::`. Everything else — the log
 * lines produced by `core.utils.log_info` / `log_warning` /
 * `log_error`, blank lines, Python's own tracebacks on stdout (if
 * any) — is skipped without any action.
 *
 * Silently skipping non-marker lines is the correct behavior
 * because:
 *
 *   1. The bridge is not a logger. Its job is to route structured
 *      progress, not to reproduce the developer-facing log in the
 *      GUI. The renderer has its own logging (`shared/utils/logger.ts`)
 *      for anything that belongs in the GUI.
 *
 *   2. The alternative — forwarding every line as a generic
 *      "output" event — would drown the renderer's dispatcher in
 *      noise that has no defined shape and no consumer.
 */
const processLine = (line: string): void => {
  if (line.length === 0) return;
  if (!line.startsWith(MARKER_PREFIX)) return;
  const event = parseMarkerLine(line);
  if (event !== null) {
    broadcast(event);
  }
};

// =============================================================================
//  Internal — marker parsing
// =============================================================================

/**
 * Parse a single `::ROOKIE::<TYPE>::<json>` line into a
 * `MarkerEvent`.
 *
 * Returns `null` (and logs to the main-process console) if the
 * line is malformed in any way:
 *
 *   * No second `::` separator (a prefix but no type boundary).
 *   * An empty type string (`::ROOKIE::::<json>`, which the
 *     emitter never produces but a hand-written test might).
 *   * A JSON payload that does not parse.
 *
 * A malformed marker is dropped, not forwarded. The alternative —
 * forwarding a marker with an empty type or a garbage payload —
 * would push the validation burden into the renderer's dispatcher,
 * where a malformed marker would either be silently ignored (a
 * second failure point, harder to debug) or throw (a crash the
 * bridge could have prevented).
 *
 * The main-process console is the correct destination for these
 * errors. It is visible to the developer via the terminal that
 * launched Electron, it does not interrupt the renderer, and it
 * does not count against the renderer's error budget.
 *
 * Parsing algorithm:
 *
 *   Given the line `::ROOKIE::SEARCH_RESULT::{"topicId":"abc",...}`:
 *
 *     1. Strip the leading `::ROOKIE::` prefix.
 *     2. Find the next `::` — everything before it is the type.
 *        Everything after it is the JSON payload text.
 *     3. Parse the payload text with `JSON.parse`. The text is
 *        compact JSON, no trailing whitespace, no comments.
 *     4. Return `{ type, payload }`.
 */
const parseMarkerLine = (line: string): MarkerEvent | null => {
  const afterPrefix = line.slice(MARKER_PREFIX.length);
  const typeEnd = afterPrefix.indexOf('::');
  if (typeEnd === -1) {
    console.error(
      '[listenerBridge] malformed marker — no type separator:',
      line
    );
    return null;
  }

  const type = afterPrefix.slice(0, typeEnd);
  if (type.length === 0) {
    console.error(
      '[listenerBridge] malformed marker — empty type:',
      line
    );
    return null;
  }

  const jsonText = afterPrefix.slice(typeEnd + 2);
  let payload: unknown;
  try {
    payload = jsonText.length > 0 ? JSON.parse(jsonText) : {};
  } catch (err) {
    console.error(
      '[listenerBridge] malformed marker — invalid JSON:',
      err,
      'line:',
      line
    );
    return null;
  }

  return { type, payload };
};

// =============================================================================
//  Internal — broadcast
// =============================================================================

/**
 * Send a parsed marker to every renderer window.
 *
 * The loop over `BrowserWindow.getAllWindows()` handles the
 * multi-window case. The current app has exactly one window, but
 * the plan's architecture does not forbid a future session from
 * opening a second (a DevTools-only window, a side-by-side preview,
 * a modal window). The loop is cheap, and the alternative —
 * assuming a single window via `getAllWindows()[0]` — would
 * silently stop delivering events to a second window the moment
 * one exists.
 *
 * Each window is checked for `isDestroyed()` before `.send(...)`.
 * Electron throws if a message is sent to a destroyed webContents,
 * and the check is a one-line guard against an async race (a window
 * closing between the `getAllWindows()` call and the `send`).
 *
 * The send is fire-and-forget. Electron's IPC does not provide
 * delivery guarantees, and the bridge has no useful response to a
 * failure — the renderer's listener is either attached or it is
 * not, and there is no retry that would help. A failure is
 * therefore not caught; an Electron-internal error during `send`
 * would indicate a bug in Electron or a violation of its API
 * contract, not a runtime condition this module can recover from.
 */
const broadcast = (event: MarkerEvent): void => {
  const windows = BrowserWindow.getAllWindows();
  for (const win of windows) {
    if (win.isDestroyed()) continue;
    win.webContents.send(MARKER_EVENT_CHANNEL, event);
  }
};