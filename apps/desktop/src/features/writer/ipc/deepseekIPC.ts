/**
 * deepseekIPC — IPC handlers for the DeepSeek session feature.
 *
 * Registers the two channels the renderer's
 * `window.electronAPI.deepseek.*` methods invoke:
 *
 *   deepseek:checkSession  — run the "is the session live?" triple
 *                            check, write the result to the
 *                            encrypted store's cached
 *                            `deepseekSessionStatus` field, and
 *                            return it in the standard envelope.
 *
 *   deepseek:openLogin     — ensure the app's persistent-profile
 *                            Chrome is running, then open a new
 *                            tab on the DeepSeek chat URL. The
 *                            user signs in by hand in that tab;
 *                            the login modal's polling loop
 *                            (via checkSession) detects when the
 *                            session becomes live.
 *
 * The two channels correspond one-to-one with the two methods
 * the preload declares on `window.electronAPI.deepseek` —
 * `checkSession` and `openLogin`. There is no third channel here
 * and no third preload method; the two sides stay in lockstep by
 * construction.
 *
 * ── Why the checkSession handler writes to the encrypted store ──
 *
 *   Two layers cache the session status:
 *
 *     1. THE MAIN-PROCESS ENCRYPTED STORE — this handler writes
 *        to it on every successful check. The store's
 *        `deepseekSessionStatus` field is the launch-time cache
 *        that `main/index.ts` reads on cold start, per the
 *        plan's N2 decision ("check at launch only if Chrome is
 *        already open").
 *
 *     2. THE RENDERER'S MODULE CACHE — the `useDeepSeekSession`
 *        hook maintains its own module-level cache, independent
 *        of the store, with a 30-second TTL. That cache is what
 *        keeps the Settings page's DeepSeek tab from firing a
 *        check on every remount.
 *
 *   The two caches serve different consumers and have different
 *   lifetimes. The store's cache survives app restarts (it is
 *   the launch-time input); the renderer's cache lives for the
 *   app session (it is the UI's read model). Both are populated
 *   from the same source of truth — this handler's call to
 *   `sessionCheckService.checkSession()`.
 *
 *   A failure to write the store cache is logged but does not
 *   fail the IPC call. The check itself succeeded; the cache is
 *   a secondary optimization. The renderer still receives the
 *   fresh result and renders the correct state.
 *
 * ── Why the openLogin handler opens the tab via CDP ────────────
 *
 *   Chrome accepts a URL as a positional argument on its command
 *   line (`chrome.exe <url>`), but the `chromeLauncher` module's
 *   `launchChrome` API does not expose a way to pass extra
 *   arguments. Adding that option is not in the plan's PR-7
 *   scope (the manifest declares no `chromeLauncher` modification
 *   for this PR), so this handler opens the tab via the Chrome
 *   DevTools Protocol instead — the same transport the sibling
 *   `sessionCheckService` already uses.
 *
 *   The flow:
 *
 *     1. Ensure Chrome is running. If `chromeLauncher` reports
 *        an existing instance, use its port. Otherwise launch
 *        one with the app's persistent profile directory — the
 *        same profile the search, extraction, and writer
 *        services use, so the DeepSeek login performed in this
 *        tab persists for every future operation.
 *
 *     2. Fetch `http://localhost:<port>/json/version` to obtain
 *        the browser-level WebSocket debugger URL. The `/json/
 *        list` endpoint the session check uses gives per-page
 *        WebSockets; `/json/version` gives the browser-level one
 *        that exposes the `Target` domain.
 *
 *     3. Open a WebSocket to that URL and send a single
 *        `Target.createTarget` command with the DeepSeek URL.
 *        Chrome opens a new tab at that URL and replies with the
 *        new target's id. A non-empty `targetId` in the response
 *        is the success signal.
 *
 *   The `Target.createTarget` path is preferred over Chrome's
 *   `/json/new?url=...` HTTP endpoint because that endpoint now
 *   requires a PUT request (a CSRF-mitigation change in Chrome
 *   111+) and is documented as deprecated. The WebSocket command
 *   is the modern, future-proof path and requires no HTTP-method
 *   gymnastics.
 *
 * ── Why the profile directory is duplicated from the sibling
 *    services ────────────────────────────────────────────────────
 *
 *   `searchService.ts`, `extractionService.ts`, and
 *   `writerService.ts` each compute the app's persistent Chrome
 *   profile path as `<userData>/writespeare-desktop/chrome-profile`
 *   via a small local helper. The `sessionCheckService.ts` file
 *   (created in the previous step) does the same.
 *
 *   This file follows the same convention. The path is a
 *   cross-file contract — every service that launches Chrome
 *   must agree on it, or two of them would launch two Chromes
 *   with two different profiles and the DeepSeek login would
 *   only exist in one. The plan declares no shared layout
 *   constants module for the desktop main process, so the
 *   contract is documented by the identical comment in every
 *   file that touches it. A future session that promoted the
 *   path to a shared helper would update all five files
 *   together.
 *
 * ── Error handling ─────────────────────────────────────────────
 *
 *   `checkSession` never rejects — its service contract is
 *   "always resolve with a result". The handler therefore wraps
 *   the whole call in a defensive try/catch for the "unexpected
 *   throw" case (a bug in the service, an out-of-memory during
 *   the check) and converts it into an error envelope, matching
 *   the pattern every other IPC module follows.
 *
 *   `openLogin` can fail at two points — the Chrome launch and
 *   the CDP tab-creation call — and each produces a specific
 *   error message the renderer can surface. A partial success
 *   (Chrome launched but the tab did not open) reports the tab
 *   failure; the user can open the DeepSeek URL manually in the
 *   Chrome window that is now on their desktop.
 *
 * ── What this file does NOT do ─────────────────────────────────
 *
 *   - It does not poll. The renderer's login modal drives the
 *     1.5-second polling loop by calling `deepseek:checkSession`
 *     repeatedly. This handler responds to individual calls.
 *
 *   - It does not navigate an EXISTING DeepSeek tab. If a tab on
 *     `chat.deepseek.com` is already open, `openLogin` still
 *     creates a new tab — the user is expected to close the
 *     extra tab if they do not want it. Reusing an existing tab
 *     would require tracking the target id between calls, which
 *     is state this stateless handler deliberately does not
 *     hold.
 *
 *   - It does not read the cached status on its own. The
 *     launch-time read lives in `main/index.ts`; the settings
 *     banner reads via the renderer's own hook cache, which is
 *     populated by this handler's return value.
 *
 *   - It does not distinguish "the check failed" from "the
 *     session is not live" in its return envelope. Both produce
 *     a `live: false` result. See the sibling
 *     `sessionCheckService.ts` header for the reasoning.
 *
 * Dependencies: electron + Node stdlib + the sibling
 * `sessionCheckService` + the sibling `chromeLauncher` + the
 * main-process `store` module.
 */

import { ipcMain, app, type IpcMainInvokeEvent } from 'electron';
import path from 'node:path';

import {
  checkSession,
  type SessionCheckResult,
} from '../services/sessionCheckService.js';
import { setDeepSeekSessionStatus } from '../../../main/store.js';
import {
  getRunningInstances,
  launchChrome,
} from '../../research/services/chromeLauncher.js';
import type { ApiResponse } from '../../shared/types/index.js';

// ============================================================
//  Channel name constants
// ============================================================
//
// The two channel names are declared as constants so a future
// refactor that renames them (or a test that spies on them) has
// one place to change. The preload's `src/main/preload.ts`
// declares the same strings on the renderer side of the bridge —
// the two must stay in sync, but neither file imports from the
// other, because the preload is a renderer-context module and
// this file is a main-context module.

const CHANNEL_CHECK_SESSION = 'deepseek:checkSession';
const CHANNEL_OPEN_LOGIN = 'deepseek:openLogin';

// ============================================================
//  Layout constants
// ============================================================
//
// Same value every other service that launches Chrome computes.
// See the file header's "Why the profile directory is
// duplicated" section for the cross-file contract rationale.

/** The Chrome profile directory name under the app's userData
 *  folder. The same convention `searchService.ts`,
 *  `extractionService.ts`, `writerService.ts`, and
 *  `sessionCheckService.ts` use. */
const CHROME_PROFILE_DIRNAME = 'chrome-profile';

/**
 * The DeepSeek URL the openLogin handler navigates Chrome to.
 *
 * The root URL of the DeepSeek chat application. Chrome follows
 * DeepSeek's own redirect to the login wall if the session is
 * not live; if the session IS live, the root URL lands directly
 * on the chat page and the user's next action (typing a message,
 * clicking Generate in the writer) proceeds without a further
 * navigation.
 *
 * Using the root URL rather than a hard-coded `/sign_in` path is
 * deliberate — DeepSeek's login-wall routing has changed between
 * path spellings before, and the root URL's redirect is
 * maintained by DeepSeek itself.
 */
const DEEPSEEK_LOGIN_URL = 'https://chat.deepseek.com/';

// ============================================================
//  CDP timeouts
// ============================================================
//
// Both bounded so a hung CDP endpoint cannot leave an IPC call
// pending indefinitely. See the file header's "Why the openLogin
// handler opens the tab via CDP" section for the flow.

/** Timeout for the `/json/version` fetch, in milliseconds. */
const CDP_VERSION_TIMEOUT_MS = 2_000;

/** Timeout for the browser-level WebSocket round trip, in
 *  milliseconds. */
const CDP_BROWSER_COMMAND_TIMEOUT_MS = 2_000;

// ============================================================
//  Path helper
// ============================================================

/**
 * Return the absolute path to the app's persistent Chrome
 * profile. Same value every other service that launches Chrome
 * computes. See the file header for the cross-service contract.
 */
const getChromeProfilePath = (): string => {
  return path.join(app.getPath('userData'), CHROME_PROFILE_DIRNAME);
};

// ============================================================
//  CDP — browser-level WebSocket URL
// ============================================================

/**
 * Fetch Chrome's browser-level WebSocket debugger URL from the
 * CDP `/json/version` endpoint.
 *
 * The endpoint returns a small JSON object describing the running
 * Chrome; the field of interest is `webSocketDebuggerUrl`,
 * pointing at the browser-level WebSocket through which the
 * `Target` domain's commands (including `Target.createTarget`)
 * are issued.
 *
 * Returns `null` on any failure — a non-2xx response, a timeout,
 * a connection refused, a malformed JSON body, a body that lacks
 * the `webSocketDebuggerUrl` field. The caller treats a null
 * return as "cannot open a new tab" and reports the failure to
 * the renderer.
 */
const fetchBrowserWebSocketUrl = async (
  port: number
): Promise<string | null> => {
  const url = `http://localhost:${port}/json/version`;
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    CDP_VERSION_TIMEOUT_MS
  );

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      return null;
    }
    const parsed: unknown = await response.json();
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return null;
    }
    const wsUrl = (parsed as Record<string, unknown>)[
      'webSocketDebuggerUrl'
    ];
    if (typeof wsUrl !== 'string' || wsUrl.length === 0) {
      return null;
    }
    return wsUrl;
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
};

// ============================================================
//  CDP — send a browser-level command
// ============================================================

/**
 * Open a WebSocket to the browser-level CDP endpoint, send one
 * command, and resolve with the command's `result` object — or
 * `null` if the round trip fails for any reason.
 *
 * The command id is fixed at `1` because exactly one command is
 * sent per WebSocket connection. The browser-level endpoint
 * occasionally emits unsolicited events (a `Target.targetCreated`
 * when another tab opens, for example); a message whose `id` is
 * not `1` is not the response to our command and is ignored,
 * with the timeout continuing to run.
 *
 * The promise resolves exactly once, on the first of: a matching
 * response, the timeout firing, an error event, a close event.
 * The `settled` flag makes the resolution idempotent so a late
 * event after a timeout does not produce a second resolution.
 */
const sendBrowserCommand = (
  wsUrl: string,
  method: string,
  params: Record<string, unknown>
): Promise<Record<string, unknown> | null> => {
  return new Promise<Record<string, unknown> | null>((resolve) => {
    let settled = false;
    const finish = (value: Record<string, unknown> | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    let socket: WebSocket;
    try {
      socket = new WebSocket(wsUrl);
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
    }, CDP_BROWSER_COMMAND_TIMEOUT_MS);

    socket.addEventListener('open', () => {
      try {
        socket.send(JSON.stringify({ id: 1, method, params }));
      } catch {
        clearTimeout(timer);
        finish(null);
      }
    });

    socket.addEventListener('message', (event: MessageEvent) => {
      const raw: unknown = event.data;
      let text: string | null = null;
      if (typeof raw === 'string') {
        text = raw;
      } else if (raw instanceof ArrayBuffer) {
        text = new TextDecoder().decode(raw);
      }
      if (text === null) {
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return;
      }
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        return;
      }
      const msg = parsed as Record<string, unknown>;

      // Filter out unsolicited events — they carry a `method`
      // field and either no `id` or an id that is not the one
      // we sent.
      if (msg['id'] !== 1) {
        return;
      }

      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // Swallow — the response is already received, whether
        // the close succeeds or not does not change the result.
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
      finish(result as Record<string, unknown>);
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
//  CDP — open a new tab at a URL
// ============================================================

/**
 * Open a new tab at the given URL in the Chrome listening on the
 * given debug port. Returns `true` on success, `false` on any
 * failure.
 *
 * Flow:
 *
 *   1. Fetch the browser-level WebSocket URL from `/json/version`.
 *   2. Send `Target.createTarget` with `{ url }`.
 *   3. Check that the response carries a non-empty `targetId`.
 *
 * A response with no `targetId` is treated as a failure — the
 * CDP spec requires the field on success, and its absence means
 * Chrome did not actually create the tab.
 */
const openNewTab = async (
  port: number,
  url: string
): Promise<boolean> => {
  const wsUrl = await fetchBrowserWebSocketUrl(port);
  if (wsUrl === null) {
    return false;
  }

  const response = await sendBrowserCommand(
    wsUrl,
    'Target.createTarget',
    { url }
  );
  if (response === null) {
    return false;
  }

  const targetId = response['targetId'];
  return typeof targetId === 'string' && targetId.length > 0;
};

// ============================================================
//  registerDeepSeekIPC
// ============================================================

/**
 * Register the DeepSeek feature's IPC handlers.
 *
 * Called once, from `main/index.ts`, inside the
 * `app.whenReady().then(...)` callback — the same place every
 * other feature's registration function is called. The function
 * is not idempotent: `ipcMain.handle` refuses to register a
 * second handler for the same channel, and a second call would
 * therefore produce Electron errors. The single-call contract is
 * the same one every other feature's `register*IPC()` function
 * follows.
 */
export const registerDeepSeekIPC = (): void => {
  // ---- deepseek:checkSession ----
  //
  // Run the triple check via the session check service, write
  // the result to the encrypted store's cached field, and return
  // it in the standard envelope.
  //
  // The service call is wrapped in a defensive try/catch even
  // though the service's contract is "never throws". A
  // genuinely unexpected throw from the service (a bug in the
  // service, an out-of-memory during the CDP evaluate) is
  // converted into an error envelope rather than an unhandled
  // rejection in the IPC layer.
  //
  // The store write is wrapped in its own try/catch so a write
  // failure does not discard the freshly computed result. The
  // caller receives the correct `live` and `checkedAt` values
  // regardless of whether the cache was updated; the cache is
  // a launch-time optimization, not the primary purpose of this
  // call.
  ipcMain.handle(
    CHANNEL_CHECK_SESSION,
    async (
      _event: IpcMainInvokeEvent
    ): Promise<ApiResponse<SessionCheckResult>> => {
      try {
        const result = await checkSession();

        try {
          setDeepSeekSessionStatus(result);
        } catch (cacheErr) {
          console.error(
            '[deepseekIPC] failed to cache session status:',
            cacheErr
          );
          // Continue — the check itself succeeded.
        }

        return { success: true, data: result };
      } catch (err) {
        const message =
          err instanceof Error ? err.message : String(err);
        return {
          success: false,
          error: `Session check failed: ${message}`,
        };
      }
    }
  );

  // ---- deepseek:openLogin ----
  //
  // Ensure Chrome is running with the app's persistent profile,
  // then open a new tab on the DeepSeek URL via CDP.
  //
  // A failure at either step — the Chrome launch, the tab
  // creation — is reported with a specific message. If Chrome
  // was launched but the tab did not open, the error still
  // reports the tab failure; the user can open the DeepSeek
  // URL manually in the Chrome window that is now on their
  // desktop.
  ipcMain.handle(
    CHANNEL_OPEN_LOGIN,
    async (
      _event: IpcMainInvokeEvent
    ): Promise<ApiResponse<null>> => {
      // ---- Step 1: ensure Chrome is running ----
      let port: number;

      const running = getRunningInstances();
      const first = running[0];

      if (first !== undefined) {
        port = first.port;
      } else {
        try {
          const instance = await launchChrome({
            userDataDir: getChromeProfilePath(),
          });
          port = instance.port;
        } catch (err) {
          const message =
            err instanceof Error ? err.message : String(err);
          return {
            success: false,
            error: `Could not launch Chrome: ${message}`,
          };
        }
      }

      // ---- Step 2: open the DeepSeek tab ----
      try {
        const opened = await openNewTab(port, DEEPSEEK_LOGIN_URL);
        if (!opened) {
          return {
            success: false,
            error:
              'Could not open the DeepSeek login page in Chrome.',
          };
        }
        return { success: true, data: null };
      } catch (err) {
        const message =
          err instanceof Error ? err.message : String(err);
        return {
          success: false,
          error: `Could not open the DeepSeek login page: ${message}`,
        };
      }
    }
  );
};

// ============================================================
//  Default export
// ============================================================

/**
 * The registration function as the default export, matching the
 * convention used by every other IPC module in the codebase.
 * `main/index.ts` uses the named import
 * (`import { registerDeepSeekIPC } from ...`), so the default
 * form is a convenience rather than a load-bearing export.
 */
export default registerDeepSeekIPC;