/**
 * Local persistent store for the WriteSpeare desktop app.
 *
 * This module wraps `electron-store` — the standard key-value
 * persistence layer for Electron apps — and exposes a small,
 * typed API for the three kinds of data the desktop client
 * needs to keep across restarts:
 *
 *   1. Authentication state — the JWT bearer token the backend
 *      issued at login, plus a cached copy of the user object.
 *      Both are cleared on logout.
 *
 *   2. Synced settings — a cached copy of the user's
 *      `UserSettingsMap`, mirrored from the backend's
 *      UserSetting document. The cache lets the app render the
 *      correct theme and defaults on the very first frame after
 *      a cold start, before the network round trip to fetch
 *      the settings completes.
 *
 *   3. Session state — the user's last-selected preset, kept
 *      across restarts so the "New Topic" modal pre-populates
 *      with what they used last time.
 *
 * This file runs in the MAIN process only. The renderer never
 * touches it directly — all access flows through IPC handlers
 * (`authIPC.ts`, `settingsIPC.ts`, etc.) which call the helpers
 * exported below. That boundary is what keeps the file path,
 * the encryption key, and the raw store object out of the
 * renderer's reach.
 *
 * Encryption — why and how:
 *
 *   electron-store's `encryptionKey` option applies AES-256 to
 *   the entire store file. Without a key, the file would be
 *   plain JSON on disk, readable by anything that can open the
 *   app's userData directory. That would be fine for the cached
 *   settings and the last-used preset — both are non-sensitive
 *   — but the JWT is a live credential. Anyone with read access
 *   to the file could use the token to make authenticated API
 *   requests until the token's `exp` claim expired. Encrypting
 *   the store closes that window.
 *
 *   The key is derived from the OS's per-installation userData
 *   path, which is stable for a given installation on a given
 *   machine but unique across machines. That gives two
 *   properties:
 *
 *     - Stability: the key is the same on every launch of the
 *       app on the same machine, so the store can be read back.
 *
 *     - Isolation: a store file copied to a different machine
 *       (or a different user's account on the same machine)
 *       cannot be decrypted with the key derived there, so a
 *       leaked store file is not portable.
 *
 *   The key is not user-password-protected and not stored in the
 *   OS keychain. That is deliberate — the file's confidentiality
 *   protects against casual inspection of the userData directory,
 *   not against a determined attacker with local code execution.
 *   A future session that wants stronger protection would replace
 *   this scheme with `safeStorage.encryptString` from Electron,
 *   which uses the OS's credential vault.
 *
 * Schema:
 *
 *   `token`           — the JWT bearer token from a successful
 *                       login, or `null` when logged out.
 *   `user`            — a cached copy of the current user
 *                       object, or `null`.
 *   `settings`        — the last-known `UserSettingsMap` fetched
 *                       from the backend, or `null` before the
 *                       first successful fetch.
 *   `lastUsedPreset`  — the preset name the user selected on the
 *                       most recent topic, or `null` before any
 *                       topic has been created.
 *
 *   Every field defaults to `null`. That means a
 *   freshly-installed app has a valid, fully-typed store from
 *   the moment the module loads, and every helper below can
 *   return a well-typed value without needing to distinguish
 *   "not set" from "null". The two are the same thing in this
 *   schema.
 *
 * Why the store is instantiated at module load:
 *
 *   The `store` instance is created once, when this module is
 *   first imported. Every subsequent import (from any other
 *   main-process module) receives the same instance, because
 *   Node's module cache guarantees that a module's top-level
 *   statements run exactly once. The alternative — lazily
 *   creating the store on first access — would add a race
 *   condition risk for concurrent IPC calls without providing
 *   any benefit; the store's construction is cheap and has no
 *   side effect on disk until the first write.
 */

import Store from 'electron-store';
import { app } from 'electron';
import type {
  User,
  UserSettingsMap,
  PresetName,
} from '../features/shared/types/index.js';

// ============================================================
//  Schema
// ============================================================

/**
 * The shape of the persisted store. Every key is nullable
 * because every key represents "state that may not exist yet" —
 * a freshly-installed app has no token, no user, no cached
 * settings, and no last-used preset, and none of those is an
 * error condition.
 */
interface StoreSchema {
  token: string | null;
  user: User | null;
  settings: UserSettingsMap | null;
  lastUsedPreset: PresetName | null;
}

// ============================================================
//  Encryption key
// ============================================================

/**
 * The app slug used both as the store's filename and as the
 * static prefix of the derived encryption key.
 *
 * Using one constant for both purposes keeps the two in sync: a
 * future rename of the app would change this string, and the
 * change would propagate to both the filename and the key
 * without needing a second edit.
 */
const APP_SLUG = 'writespeare';

/**
 * Derive the store's encryption key from the OS's per-installation
 * userData path. See the file header for the design rationale.
 *
 * `app.getPath('userData')` is safe to call before `app.whenReady()`
 * — Electron resolves it from the app's name and the platform's
 * standard user-data directory, both of which are known by the
 * time the main script is loaded. The function that wraps this
 * call is invoked once, at module load, from the `new Store(...)`
 * line below.
 */
const buildEncryptionKey = (): string => {
  const userDataPath = app.getPath('userData');
  return `${APP_SLUG}-v1:${userDataPath}`;
};

// ============================================================
//  Store instance
// ============================================================

/**
 * The single store instance, shared by every consumer in the
 * main process. See the file header for why this is created at
 * module load rather than lazily.
 *
 * The `defaults` object satisfies the schema fully — every key
 * is present with its nullable default — so the store is
 * readable and writable from the moment the module loads, even
 * on a fresh install with no persisted state.
 */
const store = new Store<StoreSchema>({
  name: APP_SLUG,
  encryptionKey: buildEncryptionKey(),
  defaults: {
    token: null,
    user: null,
    settings: null,
    lastUsedPreset: null,
  },
});

// ============================================================
//  Auth helpers
// ============================================================

/**
 * Return the stored JWT bearer token, or `null` when there is
 * no active session.
 *
 * The IPC handler that reads this uses `null` as the signal for
 * "not logged in" and returns a `{ success: false }` envelope to
 * the renderer, which in turn redirects to the login screen. The
 * null is not an error state — it is the correct representation
 * of "no session yet".
 */
export const getToken = (): string | null => store.get('token');

/**
 * Persist a JWT issued by the backend at login.
 *
 * The token is written encrypted — see the file header for the
 * encryption scheme. A second login overwrites the previous
 * token; there is no history of tokens and no way to retrieve a
 * superseded one.
 */
export const setToken = (token: string): void => {
  store.set('token', token);
};

/**
 * Clear the stored token without touching anything else.
 *
 * The auth IPC handler uses this during a successful logout. It
 * is deliberately narrower than `clearAuth` — a logout that
 * wants to also clear the cached user object calls `clearAuth`
 * instead.
 */
export const clearToken = (): void => {
  store.set('token', null);
};

/**
 * Return the cached user object, or `null` when there is no
 * active session.
 *
 * The cached user is written once at login and refreshed on
 * every successful call to `GET /api/auth/me`. It is the source
 * of truth for the renderer's "who am I?" question between
 * network round trips; the auth store in the renderer is
 * populated from this cache on cold start before the `me`
 * request completes.
 */
export const getUser = (): User | null => store.get('user');

/**
 * Persist the current user object.
 *
 * Called at login (with the user returned by `POST /api/auth/login`)
 * and on every successful `GET /api/auth/me`. The value replaces
 * whatever was previously cached.
 */
export const setUser = (user: User): void => {
  store.set('user', user);
};

/**
 * Clear the cached user object without touching the token.
 *
 * Used when the cached user is known to be stale — for example,
 * after an admin deactivates the account and the next API call
 * returns a 403 — but before the token itself is invalidated.
 * The usual sequence is `clearToken` then `clearUser` via
 * `clearAuth`.
 */
export const clearUser = (): void => {
  store.set('user', null);
};

/**
 * Clear both the token and the cached user object — the standard
 * logout sequence.
 *
 * The cached settings and last-used preset are deliberately left
 * in place. They are per-user data, but if the same user logs
 * back in, keeping them avoids a network round trip before the
 * UI can render correctly. If a different user logs in, the
 * login handler overwrites the settings cache on the first
 * `getUserSettings` call. The last-used preset is left alone
 * across users on the same machine for the same reason — it
 * pre-populates a convenience field that the user can override
 * with one click.
 */
export const clearAuth = (): void => {
  store.set('token', null);
  store.set('user', null);
};

// ============================================================
//  Settings helpers
// ============================================================

/**
 * Return the cached `UserSettingsMap`, or `null` before the
 * first successful fetch from the backend.
 *
 * The renderer reads this on cold start to apply the user's
 * theme preference and defaults before the network request for
 * the live settings has completed. A `null` means "use the
 * app's built-in defaults" — the same defaults the backend
 * would apply on a first-ever call.
 */
export const getSettings = (): UserSettingsMap | null =>
  store.get('settings');

/**
 * Cache a `UserSettingsMap` that was fetched from the backend.
 *
 * Called after every successful `getUserSettings` or
 * `updateUserSettings` IPC call. The cached copy is not
 * authoritative — the backend is — but it lets the renderer
 * skip a network round trip on the next cold start.
 */
export const setSettings = (settings: UserSettingsMap): void => {
  store.set('settings', settings);
};

/**
 * Clear the cached settings.
 *
 * Exposed for a future "reset to defaults" flow. Not called
 * anywhere today.
 */
export const clearSettings = (): void => {
  store.set('settings', null);
};

// ============================================================
//  Preset helpers
// ============================================================

/**
 * Return the last-used preset name, or `null` before the user
 * has created any topic.
 *
 * "Last used" means the preset the user selected on the most
 * recent topic-creation modal. It is a per-machine convenience,
 * not a per-user preference — it does not sync to the backend
 * and it does not change when the user's `defaultPreset`
 * preference changes.
 */
export const getLastUsedPreset = (): PresetName | null =>
  store.get('lastUsedPreset');

/**
 * Record the preset the user selected on the most recent topic
 * creation.
 *
 * Called by the topic-creation IPC handler after a successful
 * `POST /api/topics`. Failures to write are silently ignored by
 * the caller — the last-used preset is a convenience, and its
 * absence does not break any flow.
 */
export const setLastUsedPreset = (preset: PresetName): void => {
  store.set('lastUsedPreset', preset);
};

// ============================================================
//  Bulk operations
// ============================================================

/**
 * Wipe every key from the store, returning it to its default
 * state.
 *
 * Used by a "reset app data" flow if one is ever added, and by
 * tests that need a clean slate between cases. It is
 * deliberately not called by `clearAuth` — logging out does
 * not erase the user's cached settings.
 */
export const clearAll = (): void => {
  store.clear();
};

// ============================================================
//  Default export
// ============================================================

/**
 * The raw `electron-store` instance, exported for consumers that
 * need direct access to a key not covered by the helper
 * functions above.
 *
 * The plan's IPC handlers use the named helpers wherever
 * possible — they are typed against `StoreSchema` and free of
 * string-literal key names. The raw store is exported as an
 * escape hatch, not as the recommended interface.
 */
export default store;