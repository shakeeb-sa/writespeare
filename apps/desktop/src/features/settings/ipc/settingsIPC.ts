/**
 * settingsIPC — IPC handlers for the settings feature.
 *
 * Registers the three channels the renderer's
 * `window.electronAPI.settings.*` methods invoke:
 *
 *   settings:get           — read the authenticated user's
 *                            settings, returning the cached copy
 *                            when one exists and fetching from
 *                            the backend when the cache is empty.
 *
 *   settings:save          — apply a partial update. The patch is
 *                            forwarded to the backend, and the
 *                            backend's merged response (not the
 *                            locally-merged value) is written to
 *                            the cache, so the two layers cannot
 *                            drift.
 *
 *   settings:checkUpdates  — ask the update service whether a
 *                            newer desktop build exists. Delegates
 *                            to `../services/updateService.js`,
 *                            which handles the backend version
 *                            fetch and the running-build
 *                            comparison.
 *
 * The three channels correspond one-to-one with the three methods
 * the preload declares on `window.electronAPI.settings` — `get`,
 * `save`, and `checkUpdates`. There is no fourth channel here and
 * no fourth preload method; the two sides stay in lockstep by
 * construction.
 *
 * ── The three-layer settings model ──────────────────────────────
 *
 *   A user's `UserSettingsMap` lives in three places, in order of
 *   authority:
 *
 *     1. THE BACKEND — the authoritative record. The backend's
 *        `UserSetting` document is what every other machine and
 *        every future feature reads from. Nothing in this file
 *        can override the backend's value.
 *
 *     2. THE MAIN PROCESS — a cache, in the encrypted
 *        `electron-store` that `main/store.ts` wraps. The cache
 *        exists for two purposes:
 *
 *          * Cold-start speed. The main process applies the
 *            user's theme class to `<html>` before the renderer
 *            mounts, so the first paint is already in the right
 *            theme. That boot-time read comes from the cache,
 *            not from a network round trip.
 *
 *          * Offline resilience. If the backend is temporarily
 *            unreachable, `settings:get` can still return the
 *            last-known good value rather than failing the
 *            renderer's settings load entirely. A user who
 *            opens the app on a plane still gets their theme.
 *
 *     3. THE RENDERER — an in-memory mirror held by the
 *        `settingsStore` (Zustand), populated from the main
 *        process via this file's channels. It is not persisted
 *        to `localStorage`; the main process's encrypted cache
 *        is the persistence surface.
 *
 * ── Cache-first for `settings:get` ──────────────────────────────
 *
 *   `settings:get` reads from the main-process cache first, and
 *   only fetches from the backend when the cache is empty. This
 *   is the design the settings store's own header documents, and
 *   the reason is structural: the renderer's cold-start sequence
 *   calls `settings:get` immediately on mount, and waiting for a
 *   network round trip before the first paint would produce a
 *   visible flash of the wrong theme. A cache hit answers in
 *   single-digit milliseconds; a backend fetch answers in tens
 *   to hundreds.
 *
 *   The trade-off is documented here rather than assumed: a
 *   settings change made on ANOTHER device will not be visible
 *   here until the cache is refreshed. The refresh paths are:
 *
 *     (a) `settings:save` — every successful save writes the
 *         backend's merged response into the cache, so this
 *         device always has the freshest value it has ever
 *         written.
 *
 *     (b) `clearSettings` in `main/store.ts` — a future "reset
 *         app data" flow can empty the cache, and the next
 *         `settings:get` will fetch fresh.
 *
 *   Multi-device settings sync is a future feature. When it
 *   lands, the change is to add a `forceRefresh: boolean` flag
 *   to the `settings:get` signature (and the corresponding
 *   preload method), and check it before the cache read. Today
 *   the flag does not exist because no caller needs it, and
 *   adding one speculatively would give future code a place to
 *   write a branch that nothing currently exercises.
 *
 * ── Why `settings:save` writes the BACKEND's response ───────────
 *
 *   On a successful save, the handler writes the value the
 *   BACKEND returned to the cache, not a locally-merged copy.
 *   The backend is authoritative, and its response is the
 *   value it actually persisted — using it as the new cache
 *   contents guarantees the cache cannot drift from the backend
 *   on a validation the backend applies but this process does
 *   not (a range clamp, a default substitution, a schema-level
 *   transformation).
 *
 *   A locally-merged cache would be correct in the common case
 *   and silently wrong in the edge case, which is the worst kind
 *   of wrong: the divergence would only surface when a future
 *   caller read the cached value and acted on it as though it
 *   matched the backend.
 *
 * ── Why the empty-patch save is not rejected ────────────────────
 *
 *   The handler forwards whatever patch the renderer supplies to
 *   the backend, including an empty object. The backend treats an
 *   empty patch as a no-op and returns the current settings
 *   unchanged. This handler deliberately does not pre-check the
 *   patch's contents for two reasons:
 *
 *     1. The controller on the backend is the authoritative
 *        validator for what fields are legal and what their
 *        ranges are. Duplicating any of those rules here would
 *        create a second source of truth that could drift from
 *        the first.
 *
 *     2. A "no-op save" is a legitimate call. A renderer that
 *        wants to ensure the cache is fresh without changing
 *        anything can call `settings:save({})`. The backend's
 *        no-op response and this handler's cache write produce
 *        exactly that outcome.
 *
 *   What the handler DOES check is the patch's top-level type:
 *   it must be a plain object. A caller that supplies a string,
 *   a number, `null`, or an array has made a mistake the
 *   backend would also reject, and catching it here produces a
 *   clearer error than forwarding a value the schema is not
 *   designed to receive.
 *
 * ── Why `settings:checkUpdates` goes through the service ────────
 *
 *   The version-check operation has real logic in it — reading
 *   the running build's version, fetching the latest published
 *   version from the backend, comparing them, and deciding what
 *   to do about a newer release. That logic belongs in a
 *   service, not in an IPC handler. The handler's job is to
 *   invoke the service and convert its result (or its thrown
 *   error) into the standard `ApiResponse` envelope.
 *
 *   The service (`../services/updateService.js`) is a forward
 *   reference at this point in the runbook — it is created in
 *   step 138 of this same session. Until it exists on disk, the
 *   import produces a single `TS2307` error. That is EXPECTED
 *   and is logged as STATE B in the TypeScript Integrity Check
 *   below.
 *
 * ── What this file does NOT do ──────────────────────────────────
 *
 *   - It does not validate field-level types. The backend's
 *     controller is the authoritative validator; this handler
 *     checks only the top-level shape (object vs non-object) and
 *     forwards everything else. A field-level check here would
 *     duplicate the controller's rules and drift from them.
 *
 *   - It does not touch the renderer's Zustand store. The store
 *     is populated by the renderer's `settingsStore.loadSettings`
 *     action from the envelope this handler returns. The handler
 *     is one layer below that — it does not know the store
 *     exists.
 *
 *   - It does not clear the cached settings on logout. The
 *     `clearAuth` helper in `main/store.ts` deliberately leaves
 *     the settings cache in place (see that file's header for the
 *     rationale — it is per-machine state that survives a
 *     logout/login cycle for the same user), and this handler
 *     does not second-guess that decision.
 *
 *   - It does not register the `config:*` channels that also
 *     appear in the preload's surface. Those channels
 *     (`config:getApiBaseUrl`, `config:getAppVersion`,
 *     `config:getPlatform`) belong to a config feature that the
 *     plan's file tree does not declare, and no session of the
 *     runbook is scheduled to create the corresponding module.
 *     They are logged as a PLAN DELTA below, and they will
 *     continue to reject with "no handler registered for
 *     'config:*'" until a future session assigns them a home.
 */

import { ipcMain, type IpcMainInvokeEvent } from 'electron';

import {
  apiGet,
  apiPatch,
} from '../../shared/api/client.js';
import {
  getSettings,
  setSettings,
} from '../../../main/store.js';
import { checkForUpdates } from '../services/updateService.js';

import type {
  ApiResponse,
  AppVersion,
  UserSettingsMap,
} from '../../shared/types/index.js';

// ============================================================
//  Channel name constants
// ============================================================
//
// The three channel names are declared as constants so a future
// refactor that renames them (or a test that spies on them) has
// one place to change. The preload's `src/main/preload.ts`
// declares the same strings on the renderer side of the bridge —
// the two must stay in sync, but neither file imports from the
// other, because the preload is a renderer-context module and
// this file is a main-context module.

const CHANNEL_GET = 'settings:get';
const CHANNEL_SAVE = 'settings:save';
const CHANNEL_CHECK_UPDATES = 'settings:checkUpdates';

// ============================================================
//  registerSettingsIPC
// ============================================================

/**
 * Register the settings feature's IPC handlers.
 *
 * Called once, from `main/index.ts`, inside the
 * `app.whenReady().then(...)` callback — the same place the
 * auth, topics, documents, articles, reports, and version
 * features' registration functions are called. The function is
 * not idempotent: `ipcMain.handle` refuses to register a second
 * handler for the same channel, and a second call would therefore
 * produce Electron errors. The single-call contract is the same
 * one every other feature's `register*IPC()` function follows.
 *
 * Registration order across features is documented in
 * `main/index.ts`'s commented block, which lists each
 * `register*IPC()` call in the order the plan's sessions create
 * them. This function's turn comes immediately after the six
 * features already wired (auth through version).
 */
export const registerSettingsIPC = (): void => {
  // ---- settings:get ----
  //
  // Read the authenticated user's settings. Cache-first: if the
  // main-process encrypted store already holds a settings object,
  // return it immediately; only on a cache miss does this handler
  // contact the backend.
  //
  // On a cache miss, the backend fetch is wrapped in a try/catch
  // so that an unexpected throw — a network stack error the axios
  // client's own wrapper did not convert, an IPC-internal
  // exception — becomes a well-formed error envelope rather than
  // an unhandled rejection that would surface in the renderer as
  // a cryptic promise error. The `apiGet` wrapper already converts
  // every business failure (a 4xx or 5xx response, a timeout, a
  // DNS failure) into a `{ success: false }` envelope, so the
  // catch block is a defence against the genuinely unexpected.
  ipcMain.handle(
    CHANNEL_GET,
    async (
      _event: IpcMainInvokeEvent
    ): Promise<ApiResponse<UserSettingsMap>> => {
      // ---- 1. Cache path ----
      // A non-null cache value is returned as-is. The cached
      // object is already in the shape the renderer expects; no
      // transformation is needed. See the file header for why
      // this read-before-fetch ordering is deliberate.
      const cached = getSettings();
      if (cached !== null) {
        return {
          success: true,
          data: cached,
        };
      }

      // ---- 2. Backend path (cache miss) ----
      try {
        const result = await apiGet<UserSettingsMap>('/settings');
        if (result.success && result.data) {
          // Cache the fresh value so the next cold start can
          // take the fast path. The cache update happens only
          // on a genuinely successful fetch — a failed fetch
          // leaves the (empty) cache untouched, and the next
          // call retries the backend.
          setSettings(result.data);
        }
        return result;
      } catch (err) {
        const message =
          err instanceof Error ? err.message : String(err);
        return {
          success: false,
          error: `Could not load settings: ${message}`,
        };
      }
    }
  );

  // ---- settings:save ----
  //
  // Apply a partial update to the authenticated user's settings.
  // The patch is forwarded to the backend, and the backend's
  // merged response is written to the cache on success. See the
  // file header for why the BACKEND's response is cached rather
  // than a locally-merged copy.
  //
  // The handler's own validation is limited to one check: the
  // patch must be a plain object. Everything else — field names,
  // field types, numeric ranges, closed-set membership on the
  // preset and profile fields — is the backend's job, and a
  // field-level check here would duplicate the controller's
  // rules and eventually drift from them.
  ipcMain.handle(
    CHANNEL_SAVE,
    async (
      _event: IpcMainInvokeEvent,
      patch: unknown
    ): Promise<ApiResponse<UserSettingsMap>> => {
      // ---- 1. Top-level shape check ----
      if (
        typeof patch !== 'object' ||
        patch === null ||
        Array.isArray(patch)
      ) {
        return {
          success: false,
          error: 'Settings patch must be a JSON object.',
        };
      }

      // ---- 2. Forward to the backend ----
      // The `patch` argument is narrowed to `object` by the check
      // above; the cast to `Partial<UserSettingsMap>` tells the
      // compiler to trust the shape for the axios call. The
      // backend's controller is the authoritative validator for
      // each field's type — see the file header.
      try {
        const result = await apiPatch<UserSettingsMap>(
          '/settings',
          patch as Partial<UserSettingsMap>
        );
        if (result.success && result.data) {
          // Cache the backend's merged response. See the file
          // header for why this value is used rather than the
          // locally-known patch.
          setSettings(result.data);
        }
        return result;
      } catch (err) {
        const message =
          err instanceof Error ? err.message : String(err);
        return {
          success: false,
          error: `Could not save settings: ${message}`,
        };
      }
    }
  );

  // ---- settings:checkUpdates ----
  //
  // Ask the update service whether a newer desktop build exists.
  // The service handles the running-build comparison and the
  // backend version fetch; this handler's only job is to convert
  // the service's return value (or its thrown error) into the
  // standard envelope.
  //
  // The service returns `AppVersion | null`:
  //
  //   * A non-null `AppVersion` means a newer build is published
  //     and the renderer should offer the update.
  //   * `null` means the running build is already the latest (or
  //     the backend has no published version yet), and the
  //     renderer should show the "up to date" state.
  //
  // A thrown error from the service — an unreachable backend, a
  // malformed response — is caught and converted to a
  // `{ success: false }` envelope. The renderer's settings page
  // displays the failure as a "could not check for updates"
  // message rather than crashing.
  //
  // ── Forward reference ──
  // The `checkForUpdates` symbol imported above lives in
  // `../services/updateService.js`, which is step 138 of this
  // same session. Until that file exists on disk, the import at
  // the top of this module produces a single `TS2307` error.
  // That is EXPECTED and is logged as STATE B below — the
  // handler is already correct and needs no change once the
  // service lands.
  ipcMain.handle(
    CHANNEL_CHECK_UPDATES,
    async (): Promise<ApiResponse<AppVersion | null>> => {
      try {
        const latest = await checkForUpdates();
        return {
          success: true,
          data: latest,
        };
      } catch (err) {
        const message =
          err instanceof Error ? err.message : String(err);
        return {
          success: false,
          error: `Update check failed: ${message}`,
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
 * (`import { registerSettingsIPC } from ...`), so the default
 * form is a convenience rather than a load-bearing export.
 */
export default registerSettingsIPC;