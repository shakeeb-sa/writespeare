/**
 * settingsStore — the renderer's state for the settings feature.
 *
 * Holds the user's `UserSettingsMap` — the nine cross-topic
 * preferences the backend's `UserSetting` document carries — plus
 * the store's async lifecycle state and the last error message.
 * The store exposes two async actions that reach the main process
 * over the settings IPC channels, and a small set of synchronous
 * setters used by the settings page and by the app's startup
 * sequence.
 *
 * ── The three-layer persistence ────────────────────────────────
 *
 *   The user's settings live in three places, in order of
 *   authority:
 *
 *     1. The BACKEND — the authoritative record. The backend's
 *        `UserSetting` document is where the values ultimately
 *        live, and every other layer is a cache of it.
 *
 *     2. The MAIN PROCESS — a second cache, in the encrypted
 *        `electron-store` that `main/store.ts` wraps. This cache
 *        exists so that on a cold start the main process can
 *        answer a `settings:get` call before its HTTP client has
 *        reached the backend, letting the renderer's first frame
 *        render with the user's actual theme instead of a
 *        default.
 *
 *     3. THE RENDERER — this store, the in-memory mirror that
 *        components read.
 *
 *   The store's two async actions are the paths through which
 *   the three layers stay in sync:
 *
 *     `loadSettings()` calls `window.electronAPI.settings.get()`,
 *     which the settings IPC handler resolves by reading from the
 *     main-process cache first and (if the cache is stale or the
 *     handler decides a refresh is warranted) from the backend.
 *     The handler also writes the fresh value back to the cache.
 *     The store receives the `UserSettingsMap` and holds it.
 *
 *     `saveSettings(patch)` calls
 *     `window.electronAPI.settings.save(patch)`, which the handler
 *     forwards to the backend's PATCH endpoint. On the backend's
 *     success, the handler writes the merged result to the
 *     main-process cache and returns it. The store receives the
 *     merged `UserSettingsMap` and replaces its own copy.
 *
 *   The consequence a reader should be aware of: the store's
 *   `settings` field is NOT persisted to `localStorage`. Unlike
 *   `userStore.ts`, which uses Zustand's `persist` middleware to
 *   write the auth token to `localStorage` for fast cold-start
 *   reads, this store relies entirely on the main process's
 *   encrypted cache. The reasons:
 *
 *     * The settings are non-sensitive. Unlike the auth token,
 *       there is no confidentiality argument for keeping them
 *       encrypted, but there is also no confidentiality argument
 *       for exposing them to `localStorage`.
 *
 *     * The `theme` preference must be readable by the main
 *       process before the renderer's first frame — the main
 *       process is what tells the window whether to start in
 *       dark mode. The main-process cache is where that value
 *       needs to be, and duplicating it into `localStorage` would
 *       create a second source of truth with its own invalidation
 *       problem.
 *
 *     * A single persistent cache keeps the two-layer story
 *       clean: the backend is authoritative, the main process's
 *       encrypted store is the offline cache, and the renderer's
 *       store is a pure in-memory mirror of what the main
 *       process last returned.
 *
 * ── The `settings` field starts null, not with defaults ────────
 *
 *   The store's `settings` field starts as `null`, not as a
 *   full `UserSettingsMap` with placeholder values. The reason
 *   is that the defaults live in two places already — the
 *   backend's schema declares them, and the main process's cache
 *   holds a copy after the first successful fetch — and a third
 *   set baked into this file would eventually drift.
 *
 *   A component that reads the store's `settings` field and
 *   finds `null` treats that as "not yet loaded" and either
 *   renders a loading state or falls back to whatever the app's
 *   `main/index.ts` boot sequence decided was the default theme
 *   (the theme class is applied to `<html>` by the main process
 *   before the renderer mounts, so the null case never produces
 *   a flash of the wrong theme — see "The theme application"
 *   below). A component that wants the defaults explicitly calls
 *   `loadSettings()`, which returns the backend's defaults on a
 *   first-ever fetch.
 *
 * ── The theme application ──────────────────────────────────────
 *
 *   The `theme` field on `UserSettingsMap` is the value the
 *   renderer's root component uses to decide whether to add the
 *   `dark` class to `<html>`. The application of that class is
 *   NOT this store's responsibility — the store holds the value;
 *   the component that applies it is whatever element sits at
 *   the top of the renderer's tree (the `App.tsx` root, or a
 *   small effect in a shared layout).
 *
 *   On the very first render after a cold start, the store's
 *   `settings` field is null and no theme value is available
 *   from this store. In that window, the theme class is whatever
 *   the main process applied to `<html>` before the renderer
 *   loaded — see `main/store.ts`'s "Synced settings" section for
 *   how the main process reads the cached value at boot. Once
 *   `loadSettings()` resolves, the renderer's own value is
 *   available and the component that applies the theme can
 *   reconcile any difference.
 *
 * ── Why this store has no marker subscription ──────────────────
 *
 *   Every other feature store in the app installs a module-load
 *   listener on the `research:marker` channel and reacts to the
 *   marker types its feature owns. This store does not — the
 *   settings feature has no Python stage and therefore no
 *   markers. Its two actions are request-response, and the
 *   store's state changes only when those actions resolve.
 *
 *   The absence is deliberate, not an oversight. Adding a marker
 *   listener here would be a subscription that never receives a
 *   relevant message.
 *
 * ── What this store does NOT do ────────────────────────────────
 *
 *   - It does not persist to `localStorage`. See the "three-layer
 *     persistence" section above.
 *
 *   - It does not apply the theme to the DOM. See "The theme
 *     application" above.
 *
 *   - It does not call the backend directly. The settings IPC
 *     handler is what talks to the backend's HTTP endpoints;
 *     this store talks only to the IPC channel.
 *
 *   - It does not check for updates. The
 *     `window.electronAPI.settings.checkUpdates()` method exists
 *     on the preload, but its caller is the settings page's
 *     "Check for updates" action — a per-action concern, not a
 *     store-level one. A future session that wanted a
 *     store-level `checkUpdates()` action could add it; the
 *     current design leaves the call at the page level where the
 *     UI feedback (a toast, a dialog) lives.
 *
 *   - It does not merge a patch into its own state optimistically.
 *     The `saveSettings` action replaces the store's `settings`
 *     field with the value the backend returned, not with the
 *     locally-merged result. The backend is authoritative, and
 *     its response is the merged value it persisted — using it
 *     as the new state guarantees the renderer cannot drift from
 *     the backend on a validation the backend applies but the
 *     renderer does not.
 */

import { create } from 'zustand';

import type { UserSettingsMap } from '../../shared/types/index.js';

// ============================================================
//  Public types
// ============================================================

/**
 * The three-value lifecycle of the store's async activity. Same
 * shape as the sibling stores' status types.
 *
 *   'idle'    — no operation is in progress, and the last one
 *               (if any) succeeded. The default state.
 *   'loading' — a load or a save is in flight.
 *   'error'   — the last operation failed. The `error` field
 *               carries a user-facing message. The next operation
 *               to start resets both fields.
 */
export type SettingsStoreStatus = 'idle' | 'loading' | 'error';

/**
 * The full shape of the settings store's state, including both
 * the data fields and the actions. Exported so that a consumer
 * that wants to type a parameter or a helper function can
 * reference the shape without redeclaring it.
 */
export interface SettingsStoreState {
  // ---- Data ----

  /**
   * The user's cross-topic preferences, or null before the first
   * `loadSettings()` call completes. See the file header's
   * "The `settings` field starts null" section for the reasoning
   * on why null is the correct initial value rather than a set
   * of baked-in defaults.
   */
  settings: UserSettingsMap | null;

  /** The store's async lifecycle state. */
  status: SettingsStoreStatus;

  /** The last error message, or null. */
  error: string | null;

  // ---- Async actions ----

  /**
   * Fetch the current settings from the main process — which
   * resolves them from its own cache or, on a cache miss, from
   * the backend. On success, the returned `UserSettingsMap` is
   * stored on the `settings` field.
   *
   * The action is idempotent. A caller that invokes it while a
   * previous call is in flight will have its call superseded by
   * whichever response arrives last; the store does not attempt
   * to sequence the two, because the settings read is
   * read-only and the two responses are equivalent.
   *
   * Resolves when the operation completes (success or failure).
   * The store's `status` and `error` fields reflect the outcome.
   */
  loadSettings: () => Promise<void>;

  /**
   * Apply a partial update to the settings. The patch is sent to
   * the main process, which forwards it to the backend; the
   * backend merges the patch onto the existing document, applies
   * schema validation, and returns the merged result. That result
   * becomes the store's new `settings` value.
   *
   * Returns the merged `UserSettingsMap` on success, or null on
   * failure. The caller can use the return value to decide
   * whether to fire a success toast.
   */
  saveSettings: (
    patch: Partial<UserSettingsMap>
  ) => Promise<UserSettingsMap | null>;

  // ---- Sync actions ----

  /**
   * Set the store's `settings` field directly, without a network
   * round trip. Used by a caller that already has a
   * `UserSettingsMap` from some other source — the main-process
   * boot sequence, a settings fetch the caller made outside this
   * store — and wants to seed the store with it.
   *
   * Passing null clears the field, which resets the store to its
   * "not yet loaded" state.
   */
  setSettings: (settings: UserSettingsMap | null) => void;

  /** Clear the last error message. */
  clearError: () => void;

  /** Reset every field to its initial value. */
  reset: () => void;
}

// ============================================================
//  Initial state
// ============================================================

/**
 * The store's initial data fields. Extracted as a constant so
 * `reset` can spread it into a new state object without
 * duplicating the literals.
 *
 * Note that `settings` starts as `null`, not as a default
 * `UserSettingsMap`. See the file header for the reasoning.
 */
const INITIAL_STATE = {
  settings: null as UserSettingsMap | null,
  status: 'idle' as SettingsStoreStatus,
  error: null as string | null,
};

// ============================================================
//  Store
// ============================================================

/**
 * The settings store. See the file header for its
 * responsibilities, the three-layer persistence model, and the
 * reasoning behind the design choices.
 *
 * Created without middleware — no `persist` (see the file
 * header), no `devtools`, no Immer. The `create<...>()` form
 * with the extra `()` after the generic is required for
 * Zustand's type inference to work correctly when a store has
 * both state and actions; it is the same pattern every other
 * store in the codebase uses.
 */
export const useSettingsStore = create<SettingsStoreState>((set, get) => ({
  // ---- Initial data ----
  ...INITIAL_STATE,

  // ============================================================
  //  Async actions
  // ============================================================

  loadSettings: async (): Promise<void> => {
    set({ status: 'loading', error: null });

    try {
      const result = await window.electronAPI.settings.get();

      if (result.success && result.data) {
        set({
          settings: result.data,
          status: 'idle',
        });
      } else {
        set({
          status: 'error',
          error: result.error ?? 'Failed to load settings.',
        });
      }
    } catch (err) {
      // The `window.electronAPI.settings.get` call itself can
      // reject if the IPC channel is unregistered — for example,
      // during the window between the app's startup and the
      // `registerSettingsIPC()` call in the main process. The
      // catch converts that rejection into the same error state
      // the response-envelope failure path produces.
      console.error('[settingsStore] loadSettings failed:', err);
      set({
        status: 'error',
        error:
          err instanceof Error
            ? err.message
            : 'Unable to load settings.',
      });
    }
  },

  saveSettings: async (
    patch: Partial<UserSettingsMap>
  ): Promise<UserSettingsMap | null> => {
    set({ status: 'loading', error: null });

    try {
      const result = await window.electronAPI.settings.save(patch);

      if (result.success && result.data) {
        const merged = result.data;
        // Replace the store's copy with the value the backend
        // returned. The backend is authoritative — see the file
        // header's "What this store does NOT do" section for
        // the reasoning on not merging the patch optimistically.
        set({
          settings: merged,
          status: 'idle',
        });
        return merged;
      }

      set({
        status: 'error',
        error: result.error ?? 'Failed to save settings.',
      });
      return null;
    } catch (err) {
      console.error('[settingsStore] saveSettings failed:', err);
      set({
        status: 'error',
        error:
          err instanceof Error
            ? err.message
            : 'Unable to save settings.',
      });
      return null;
    }
  },

  // ============================================================
  //  Sync actions
  // ============================================================

  setSettings: (settings: UserSettingsMap | null): void => {
    set({ settings });
  },

  clearError: (): void => {
    set({ error: null });
    if (get().status === 'error') {
      set({ status: 'idle' });
    }
  },

  reset: (): void => {
    set({ ...INITIAL_STATE });
  },
}));

// ============================================================
//  Default export
// ============================================================

/**
 * The hook as the default export, matching the convention used
 * by every other store in the codebase. Consumers that prefer
 * the named form use `import { useSettingsStore } from ...`;
 * consumers that prefer the default form use
 * `import useSettingsStore from ...`. Both resolve to the same
 * hook.
 */
export default useSettingsStore;