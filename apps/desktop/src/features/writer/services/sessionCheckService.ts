/**
 * sessionCheckService — main-process service that answers
 * "is the DeepSeek session live?".
 *
 * The single consumer-facing export is `checkSession()`, an async
 * function that returns `{ live: boolean; checkedAt: string }`.
 * Every one of the three DeepSeek session consumers — the
 * launch-time check in `main/index.ts`, the writer-run pre-check,
 * and the Settings page's DeepSeek status banner — calls this one
 * function and renders or acts on the result.
 *
 * ── What "session live" means ────────────────────────────────
 *
 *   A live session passes the THREE-SIGNAL check from the plan's
 *   decision N3:
 *
 *     1. The DeepSeek chat page is open in the app's Chrome.
 *        A tab is present whose URL contains `chat.deepseek.com`.
 *
 *     2. The URL is not a login URL. The path segment does not
 *        contain `/login`, `/signin`, `/sign_in`, `/sign-in`, or
 *        `/auth/`. If the user is looking at a sign-in page,
 *        they are not signed in regardless of what the DOM shows.
 *
 *     3. No "sign in to continue" text is present in the page's
 *        body. The phrases checked are `sign in to continue`,
 *        `log in to continue`, `please sign in`, and
 *        `please log in`. These are the four phrasings DeepSeek's
 *        UI has used for its login-wall overlay when the session
 *        expired mid-use (URL still `/`, but an overlay covers
 *        the chat input).
 *
 *   All three signals are evaluated IN the DeepSeek page's own
 *   JavaScript context. The page itself is the only authority on
 *   what its DOM currently contains; the main process cannot
 *   guess at it from outside.
 *
 * ── How the check is performed ───────────────────────────────
 *
 *   Chrome's DevTools Protocol exposes two endpoints the service
 *   uses:
 *
 *     * `http://localhost:<port>/json/list` — returns an array
 *       of every open target (tab) with its URL, title, and a
 *       per-target WebSocket URL for that page's CDP session.
 *       Fetched via Node's global `fetch`; used to find the
 *       DeepSeek page and to obtain its WebSocket URL.
 *
 *     * `ws://localhost:<port>/devtools/page/<targetId>` — a
 *       per-page WebSocket that accepts CDP commands. The
 *       service sends one `Runtime.evaluate` command with the
 *       triple-check expression; Chrome evaluates it in the
 *       page's JavaScript context and returns the result.
 *
 *   Node 20+ ships a global `WebSocket` and a global `fetch`, so
 *   no external dependency is needed. The desktop app's
 *   `package.json` does not declare a WebSocket library, and
 *   adding one would be out of scope for this file.
 *
 * ── Why CDP over WebSocket and not Playwright ────────────────
 *
 *   Playwright is the pipeline's browser-automation library, but
 *   it is a PYTHON dependency. The desktop main process does not
 *   ship Playwright, and adding it would pull in a second
 *   Chromium bundle plus a heavyweight Node-side driver — a
 *   large addition for one query that CDP serves natively.
 *
 *   The Python side still owns every operation that actually
 *   needs Playwright: the search scripts, the extractors, and
 *   the writer itself all spawn `python main.py <subcommand>`
 *   and connect via `core.browser.connect_to_chrome`. This
 *   service is deliberately separate from that pipeline because
 *   it must be able to answer its one question without spawning
 *   a Python process — the Settings banner runs it in the
 *   background on every mount, and the writer-run pre-check
 *   needs it to resolve in tens of milliseconds, not the
 *   hundreds a Python spawn would take.
 *
 * ── The `launchIfNotRunning` option ─────────────────────────
 *
 *   The service exposes one option on its options parameter:
 *
 *     launchIfNotRunning?: boolean
 *
 *   Its default is `false`. When false and Chrome is not already
 *   running, the service returns `{ live: false, checkedAt }`
 *   immediately — no launch is attempted, no side effects.
 *
 *   The default is `false` because two of the three consumers
 *   must NOT launch Chrome on their own:
 *
 *     * The launch-time check in `main/index.ts` follows the
 *       plan's N2 decision ("Check at launch only if Chrome is
 *       already open") and should not spawn a new Chrome just
 *       to look at it.
 *
 *     * The Settings page's banner checks on mount and would
 *       otherwise pop a Chrome window every time the user opens
 *       Settings — an intrusive surprise.
 *
 *   The third consumer — the writer-run pre-check — is the only
 *   one that WANTS Chrome up before the check runs, because the
 *   writer step is about to need Chrome anyway. It passes
 *   `{ launchIfNotRunning: true }` explicitly.
 *
 *   The manifest's line for this file reads "launches or attaches
 *   to Chrome", which is the behavior the option enables. The
 *   option's default leans on the "attaches" half of that phrase
 *   for the common case, and the "launches" half is opt-in.
 *
 * ── Timeouts ──────────────────────────────────────────────────
 *
 *   Both the HTTP list fetch and the WebSocket evaluate are
 *   bounded. A hung CDP endpoint (a Chrome that has been killed
 *   mid-check, a socket that is not accepting reads) must not
 *   leave this function pending forever, because its callers
 *   include the launch-time path that runs before the app's
 *   main window has rendered.
 *
 *   The HTTP fetch uses an `AbortController` with a 2-second
 *   timeout. The WebSocket uses a 3-second timer that closes
 *   the socket and resolves the promise with a not-live result.
 *   Both are generous for a localhost round trip — the nominal
 *   case completes in single-digit milliseconds — while
 *   remaining short enough that a hung endpoint does not stall
 *   the caller noticeably.
 *
 * ── What this service does NOT do ────────────────────────────
 *
 *   - It does not navigate Chrome. If Chrome is running but no
 *     DeepSeek tab is open, the service reports not-live. The
 *     act of navigating to the DeepSeek chat page is the login
 *     flow's job, driven by `deepseek:openLogin` on the IPC
 *     layer.
 *
 *   - It does not distinguish "the check failed" from "the
 *     session is not live" in its return value. Both produce
 *     `{ live: false, checkedAt }`. The distinction matters for
 *     logging, not for the caller's UI: the caller either shows
 *     the sign-in CTA or does not, and a failed check has the
 *     same user-facing consequence as a checked-and-negative
 *     one.
 *
 *   - It does not cache. Each call performs a fresh check. The
 *     caller that wants caching (the renderer's session hook)
 *     implements it at its own layer; the service stays a
 *     stateless "ask the current question" function.
 *
 *   - It does not poll. The renderer's login modal polls this
 *     service's IPC channel on a 1.5-second interval while the
 *     modal is open; the service itself does not schedule
 *     repeated calls.
 *
 *   - It does not persist its result. The IPC handler that calls
 *     this service is what writes to the encrypted store's
 *     `deepseekSessionStatus` cache field.
 *
 *   - It does not emit markers. The check is a request-response
 *     operation with no progress to stream — the entire
 *     inspection completes in under a second in every
 *     realistic case.
 *
 * Dependencies: electron (for `app.getPath('userData')`),
 * `node:path`, and the sibling `research/services/chromeLauncher`
 * module. Node globals `fetch`, `AbortController`, `WebSocket`,
 * and `TextDecoder` are all available in the Electron main
 * process runtime.
 */

import { app } from 'electron';
import path from 'node:path';

import {
  getRunningInstances,
  launchChrome,
} from '../../research/services/chromeLauncher.js';

// ============================================================
//  Public types
// ============================================================

/**
 * The result of a session check. Every call to `checkSession`
 * resolves with one of these — never throws, never returns null.
 *
 * The `checkedAt` timestamp is always populated, even when the
 * check could not be performed. That is deliberate: the caller's
 * UI shows the timestamp as "Last checked <time>", and a
 * timestamp that is present but coupled with `live: false` is
 * more informative than a null timestamp that would force the
 * caller to render a "never checked" state it does not have.
 */
export interface SessionCheckResult {
  /**
   * True when all three signals of the triple check passed. See
   * the file header for the exact criteria.
   */
  live: boolean;

  /**
   * An ISO-8601 timestamp for when the check completed. Always
   * populated, including on the not-live path.
   */
  checkedAt: string;
}

/**
 * The options accepted by `checkSession`. Both fields are
 * optional; the default behavior is documented on each.
 */
export interface SessionCheckOptions {
  /**
   * When true and Chrome is not currently running, launch a
   * fresh instance (with the app's persistent chrome-profile
   * directory) before running the check.
   *
   * Defaults to `false`. See the file header's
   * "The `launchIfNotRunning` option" section for the reasoning
   * behind the default and the list of which consumers opt in.
   */
  launchIfNotRunning?: boolean;
}

// ============================================================
//  Internal types
// ============================================================

/**
 * One entry in Chrome's CDP target list, narrowed to the fields
 * this service reads. Every field is present in the real
 * `/json/list` response — the narrow shape exists so the
 * consumers of this type do not have to handle a wider one.
 */
interface CdpTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

// ============================================================
//  Constants
// ============================================================

/**
 * The DeepSeek hostname whose presence in a tab's URL marks the
 * tab as a candidate for the session check.
 *
 * Substring match against the tab's URL — a tab at
 * `https://chat.deepseek.com/`, `https://chat.deepseek.com/a/...`,
 * or `https://chat.deepseek.com/login` all match. The URL path
 * check (below) is what distinguishes a chat page from a login
 * page within the matching tab.
 */
const DEEPSEEK_HOSTNAME = 'chat.deepseek.com';

/**
 * The URL path fragments that indicate a sign-in or auth page.
 * A DeepSeek tab whose URL contains any of these is not the chat
 * page and its session cannot be live.
 *
 * The list covers every variant DeepSeek has shipped:
 *   /login      — the classic path
 *   /signin     — an alternate spelling used on some landing pages
 *   /sign_in    — the underscore-separated variant
 *   /sign-in    — the hyphen-separated variant
 *   /auth/      — a generic auth namespace DeepSeek uses for its
 *                 OAuth callback path
 */
const LOGIN_URL_FRAGMENTS: readonly string[] = [
  '/login',
  '/signin',
  '/sign_in',
  '/sign-in',
  '/auth/',
];

/**
 * The JavaScript fragment-check expression built from
 * `LOGIN_URL_FRAGMENTS`.
 *
 * `CHECK_EXPRESSION` below is evaluated in the DeepSeek page's
 * own JavaScript context, so it cannot reference a TypeScript
 * constant directly. This intermediate builds the JS expression
 * — a chain of `href.indexOf("...") !== -1` clauses joined by
 * `||` — at module load, from the same array that documents the
 * fragment list. Interpolating it into `CHECK_EXPRESSION` keeps
 * the array as the single source of truth for which URL paths
 * count as a login page; adding a fragment to the array is all a
 * future change needs to do.
 *
 * `JSON.stringify` is used to quote each fragment rather than
 * embedding it in a hand-written `'...'` because the stringify
 * form escapes any character that would break the resulting JS
 * string literal. The fragment values are hardcoded URL paths
 * that cannot contain such characters today, but the defensive
 * form costs nothing and does not rely on that invariant.
 *
 * The join separator `' ||\n      '` places each subsequent
 * clause on its own line with the same six-space indentation the
 * hand-written form used, so the emitted JavaScript reads the
 * same way in a DevTools console or a log dump.
 */
const LOGIN_URL_JS_CHECK = LOGIN_URL_FRAGMENTS
  .map(
    (fragment) =>
      `href.indexOf(${JSON.stringify(fragment)}) !== -1`
  )
  .join(' ||\n      ');

/**
 * The HTTP timeout for the `/json/list` fetch, in milliseconds.
 * See the file header's "Timeouts" section for the reasoning.
 */
const CDP_HTTP_TIMEOUT_MS = 2_000;

/**
 * The WebSocket timeout for the `Runtime.evaluate` round trip, in
 * milliseconds. See the file header's "Timeouts" section for the
 * reasoning.
 */
const CDP_WS_TIMEOUT_MS = 3_000;

/**
 * The Chrome profile directory name under the app's userData
 * folder. The same convention every other service that launches
 * Chrome uses (`searchService.ts`, `extractionService.ts`,
 * `writerService.ts`), so a Chrome launched by any of them shares
 * the same DeepSeek session with a Chrome launched by this one.
 */
const CHROME_PROFILE_DIRNAME = 'chrome-profile';

/**
 * The triple-check expression, evaluated inside the DeepSeek
 * page's own JavaScript context via CDP `Runtime.evaluate`.
 *
 * Written as an IIFE that returns a JSON-serializable object.
 * The `returnByValue: true` flag on the CDP command tells Chrome
 * to serialize the return value (rather than a remote object
 * reference), so the service receives the plain object directly.
 *
 * The `try/catch` inside the IIFE is a defensive guard against
 * a page that is mid-navigation when the expression runs — a
 * `document.body === null` state during the brief window between
 * a top-level navigation and the body being attached. In that
 * window, the expression should report not-live rather than
 * throw, because the throw would be indistinguishable from a
 * legitimate check failure at the CDP layer.
 *
 * The expression avoids regular expressions — plain `indexOf`
 * checks are unambiguous, do not depend on any escaping rules,
 * and cannot be defeated by a regex-metacharacter in a URL.
 */
const CHECK_EXPRESSION = `
(function () {
  try {
    var hasChatInput =
      document.querySelector('textarea') !== null ||
      document.querySelector('[contenteditable="true"]') !== null;

    var href = window.location.href;
    var isLoginUrl =
      ${LOGIN_URL_JS_CHECK};

    var bodyText = '';
    if (document.body && typeof document.body.innerText === 'string') {
      bodyText = document.body.innerText.toLowerCase();
    }
    var hasSignInText =
      bodyText.indexOf('sign in to continue') !== -1 ||
      bodyText.indexOf('log in to continue') !== -1 ||
      bodyText.indexOf('please sign in') !== -1 ||
      bodyText.indexOf('please log in') !== -1;

    return {
      live: hasChatInput && !isLoginUrl && !hasSignInText,
      hasChatInput: hasChatInput,
      isLoginUrl: isLoginUrl,
      hasSignInText: hasSignInText,
      url: href
    };
  } catch (err) {
    return { live: false, error: String(err) };
  }
})()
`;

// ============================================================
//  Path helper
// ============================================================

/**
 * Return the absolute path to the app's persistent Chrome
 * profile. The same value every other service that launches
 * Chrome computes — see the file header's `CHROME_PROFILE_DIRNAME`
 * note for the cross-service contract.
 */
const getChromeProfilePath = (): string => {
  return path.join(app.getPath('userData'), CHROME_PROFILE_DIRNAME);
};

// ============================================================
//  Chrome launch / attach
// ============================================================

/**
 * Return the debug port of a running Chrome instance, launching
 * one if needed and the caller allows it.
 *
 * The returned promise resolves with a port number when a Chrome
 * is available (either pre-existing or freshly launched) or with
 * `null` when Chrome is not running and `launchIfNotRunning` is
 * false. It never rejects — a launch failure is logged and
 * treated identically to "Chrome is not running".
 *
 * The function is the sole place in this module that talks to
 * `chromeLauncher`. Everything downstream of it works with a
 * plain port number and does not need to know whether the Chrome
 * it is talking to was already running or was launched by this
 * call.
 */
const resolveChromePort = async (
  launchIfNotRunning: boolean
): Promise<number | null> => {
  const running = getRunningInstances();
  const first = running[0];
  if (first !== undefined) {
    return first.port;
  }

  if (!launchIfNotRunning) {
    return null;
  }

  try {
    const instance = await launchChrome({
      userDataDir: getChromeProfilePath(),
    });
    return instance.port;
  } catch (err) {
    console.error(
      '[sessionCheckService] could not launch Chrome:',
      err
    );
    return null;
  }
};

// ============================================================
//  CDP — HTTP target list
// ============================================================

/**
 * Fetch Chrome's CDP target list and return the entries that
 * describe a page target.
 *
 * The list endpoint is `http://localhost:<port>/json/list`. Its
 * response is a JSON array of target descriptors — one per open
 * tab, service worker, extension background page, and so on. The
 * filter to `type === 'page'` narrows the list to actual browser
 * tabs, which are the only targets the DeepSeek session check
 * can be attached to.
 *
 * Returns an empty array on any failure — a non-2xx response, a
 * timeout, a connection refused (the port is bound but Chrome
 * has exited), a response body that does not parse as JSON, or a
 * parsed value that is not an array. Every one of those cases
 * means "no usable target list", and the caller treats it as
 * not-live. The function never throws.
 */
const fetchCdpPageTargets = async (
  port: number
): Promise<CdpTarget[]> => {
  const url = `http://localhost:${port}/json/list`;
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    CDP_HTTP_TIMEOUT_MS
  );

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      return [];
    }
    const parsed: unknown = await response.json();
    if (!Array.isArray(parsed)) {
      return [];
    }
    const targets: CdpTarget[] = [];
    for (const entry of parsed) {
      if (typeof entry !== 'object' || entry === null) {
        continue;
      }
      const e = entry as Record<string, unknown>;
      if (e['type'] !== 'page') {
        continue;
      }
      const id = e['id'];
      const entryUrl = e['url'];
      if (typeof id !== 'string' || typeof entryUrl !== 'string') {
        continue;
      }
      const title = typeof e['title'] === 'string' ? e['title'] : '';
      const wsUrl = e['webSocketDebuggerUrl'];
      const target: CdpTarget = {
        id,
        type: 'page',
        title,
        url: entryUrl,
      };
      if (typeof wsUrl === 'string' && wsUrl.length > 0) {
        target.webSocketDebuggerUrl = wsUrl;
      }
      targets.push(target);
    }
    return targets;
  } catch {
    return [];
  } finally {
    clearTimeout(timeoutId);
  }
};

// ============================================================
//  CDP — WebSocket evaluate
// ============================================================

/**
 * Open a CDP WebSocket to a page target and evaluate a JavaScript
 * expression in that page's context. Returns the expression's
 * return value (deserialized by CDP's `returnByValue`), or `null`
 * if the round trip fails for any reason.
 *
 * The promise resolves exactly once. Four terminal conditions are
 * covered, and the first one to fire wins:
 *
 *   1. A message arrives with the matching command id and a
 *      `result.result.value` field — the normal success path.
 *      The value is resolved.
 *
 *   2. A message arrives with the matching command id and an
 *      `exceptionDetails` field — the expression threw inside
 *      the page. `null` is resolved.
 *
 *   3. The timeout fires. The socket is closed and `null` is
 *      resolved.
 *
 *   4. The socket emits an `error` or `close` event before a
 *      message is seen. `null` is resolved.
 *
 * The command id is a fixed `1` because exactly one command is
 * sent per WebSocket connection. A future session that needed to
 * multiplex commands over one socket would replace this constant
 * with a counter; today the fixed value is the honest shape.
 */
const evaluateInPage = (
  webSocketDebuggerUrl: string,
  expression: string
): Promise<unknown> => {
  return new Promise<unknown>((resolve) => {
    let settled = false;
    const finish = (value: unknown): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    // A malformed WebSocket URL — the CDP response carried a
    // string we cannot connect to — resolves to null rather than
    // throwing. The caller reports not-live, which is the
    // correct answer for a browser that cannot be reached.
    let socket: WebSocket;
    try {
      socket = new WebSocket(webSocketDebuggerUrl);
    } catch {
      finish(null);
      return;
    }

    const timer = setTimeout(() => {
      try {
        socket.close();
      } catch {
        // Swallow — the socket is already in a bad state.
      }
      finish(null);
    }, CDP_WS_TIMEOUT_MS);

    socket.addEventListener('open', () => {
      const command = {
        id: 1,
        method: 'Runtime.evaluate',
        params: {
          expression,
          returnByValue: true,
          awaitPromise: false,
        },
      };
      try {
        socket.send(JSON.stringify(command));
      } catch {
        clearTimeout(timer);
        finish(null);
      }
    });

    socket.addEventListener('message', (event: MessageEvent) => {
      clearTimeout(timer);
      const raw: unknown = event.data;
      let text: string | null = null;
      if (typeof raw === 'string') {
        text = raw;
      } else if (raw instanceof ArrayBuffer) {
        text = new TextDecoder().decode(raw);
      }
      if (text === null) {
        finish(null);
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        finish(null);
        return;
      }
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        finish(null);
        return;
      }
      const msg = parsed as Record<string, unknown>;
      if (msg['id'] !== 1) {
        // A message for a different command — the CDP session
        // sends unsolicited events the reader is not interested
        // in. Ignore them.
        return;
      }
      const result = msg['result'];
      if (
        typeof result !== 'object' ||
        result === null ||
        Array.isArray(result)
      ) {
        finish(null);
        return;
      }
      const r = result as Record<string, unknown>;
      if ('exceptionDetails' in r) {
        finish(null);
        return;
      }
      const inner = r['result'];
      if (
        typeof inner !== 'object' ||
        inner === null ||
        Array.isArray(inner)
      ) {
        finish(null);
        return;
      }
      const innerObj = inner as Record<string, unknown>;
      if (!('value' in innerObj)) {
        finish(null);
        return;
      }
      finish(innerObj['value']);
    });

    socket.addEventListener('error', () => {
      clearTimeout(timer);
      finish(null);
    });

    socket.addEventListener('close', () => {
      clearTimeout(timer);
      finish(null);
    });
  });
};

// ============================================================
//  Public entry point
// ============================================================

/**
 * Answer "is the DeepSeek session live?" and return the result
 * with a timestamp. See the file header for the full description
 * of the triple check, the CDP transport, and the option's
 * semantics.
 *
 * The function never throws. Every failure mode — Chrome not
 * running, no DeepSeek tab, a CDP HTTP timeout, a CDP WebSocket
 * timeout, an exception thrown by the evaluated expression inside
 * the page — resolves to `{ live: false, checkedAt }`.
 *
 * @param options - Optional configuration. See
 *                  `SessionCheckOptions` for the fields and the
 *                  `launchIfNotRunning` default.
 */
export const checkSession = async (
  options?: SessionCheckOptions
): Promise<SessionCheckResult> => {
  const checkedAt = new Date().toISOString();
  const launchIfNotRunning = options?.launchIfNotRunning === true;

  // ---- 1. Ensure a Chrome is available to check ----
  const port = await resolveChromePort(launchIfNotRunning);
  if (port === null) {
    return { live: false, checkedAt };
  }

  // ---- 2. Enumerate Chrome's open tabs ----
  const targets = await fetchCdpPageTargets(port);
  if (targets.length === 0) {
    return { live: false, checkedAt };
  }

  // ---- 3. Find a DeepSeek tab ----
  // The filter is a case-insensitive substring match against the
  // tab's URL. The login-URL check is NOT performed here — it is
  // one of the three signals the check expression evaluates
  // inside the page, and doing it here as well would create a
  // second source of truth for the same rule.
  const deepseekTarget = targets.find((t) => {
    return t.url.toLowerCase().indexOf(DEEPSEEK_HOSTNAME) !== -1;
  });
  if (
    deepseekTarget === undefined ||
    deepseekTarget.webSocketDebuggerUrl === undefined
  ) {
    return { live: false, checkedAt };
  }

  // ---- 4. Run the triple check inside the page ----
  const result = await evaluateInPage(
    deepseekTarget.webSocketDebuggerUrl,
    CHECK_EXPRESSION
  );

  if (
    typeof result !== 'object' ||
    result === null ||
    Array.isArray(result)
  ) {
    return { live: false, checkedAt };
  }
  const r = result as Record<string, unknown>;
  const live = r['live'] === true;

  return { live, checkedAt };
};

// ============================================================
//  Default export
// ============================================================

/**
 * Every export bundled under one default object, matching the
 * convention used by the sibling main-process services
 * (`searchService.ts`, `extractionService.ts`, `writerService.ts`,
 * `chromeLauncher.ts`). A caller that prefers named imports uses
 * `import { checkSession } from ...`; a caller that prefers the
 * default form uses `import sessionCheckService from ...` and
 * destructures.
 */
export default {
  checkSession,
};