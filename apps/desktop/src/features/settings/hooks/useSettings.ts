/**
 * useSettings — the renderer's settings hook.
 *
 * The single entry point through which the app's components read
 * and manipulate the settings feature's state. It sits over
 * `useSettingsStore` and mirrors the role the sibling hooks
 * (`useTopics`, `useResearch`, `useDocuments`, `useWriter`,
 * `useValidation`) play for their respective features:
 *
 *   - The store owns the state. The hook does not add any.
 *
 *   - The store owns the async actions that reach the IPC layer
 *     and, through it, the main process. The hook does not
 *     reimplement them.
 *
 *   - The hook's only job is to give a component a single, stable
 *     object with everything the settings feature exposes — the
 *     three data fields and the five actions.
 *
 * ── The hook's API ──────────────────────────────────────────────
 *
 *   Data fields:
 *
 *     settings   The user's cross-topic preferences, or null
 *                before the first `loadSettings()` call completes.
 *     status     The store's async lifecycle state.
 *     error      The last error message, or null.
 *
 *   Actions:
 *
 *     loadSettings()    Fetch the current settings from the main
 *                       process — which resolves them from its own
 *                       cache or, on a cache miss, from the
 *                       backend.
 *     saveSettings(p)   Apply a partial update. Resolves with the
 *                       merged `UserSettingsMap` on success, or
 *                       null on failure.
 *     setSettings(s)    Set the store's `settings` field directly,
 *                       without a network round trip.
 *     clearError()      Clear the last error message.
 *     reset()           Reset the store to its initial state.
 *
 * ── Why the hook is a straight re-export of the store's surface ──
 *
 *   Unlike `useAuth.ts` — whose `login` and `logout` actions are
 *   composed inside the hook because they need to coordinate
 *   between the store and the IPC layer — this hook has no
 *   composition to perform. The store's `loadSettings` and
 *   `saveSettings` actions already do their own IPC calls and
 *   their own state updates; the store's `setSettings`,
 *   `clearError`, and `reset` actions are pure setters. Every
 *   action the hook exposes is a direct reference to the store's
 *   own action.
 *
 *   The consequence is that this file is a straight pass-through.
 *   Its value is in two places: giving components a stable import
 *   path (`useSettings` rather than
 *   `useSettingsStore((s) => ...)` at every call site), and
 *   declaring the `SettingsHookValue` interface so a helper
 *   function can be typed against the hook's shape without
 *   redeclaring it.
 *
 * ── Why the hook subscribes to each data field separately ───────
 *
 *   Same reasoning as `useTopics`, `useResearch`, `useDocuments`,
 *   `useWriter`, and `useValidation`. Zustand re-renders a
 *   component when any of the selectors it subscribed to returns
 *   a different value; subscribing per-field gives the
 *   finest-grained re-render behavior. The alternative — one
 *   selector returning the whole state — would re-render on
 *   every store change and need a shallow-equality comparator to
 *   avoid wasted renders.
 *
 * ── Why the actions are selected directly from the store ────────
 *
 *   Zustand's `create` runs its state creator exactly once per
 *   store instance, and the functions returned by that creator
 *   are the same references for the entire life of the store.
 *   That means the action references obtained from
 *   `useSettingsStore((s) => s.loadSettings)` are already stable
 *   across renders — a `useCallback` wrapper around them would be
 *   redundant. See `useTopics.ts`'s file header for the longer
 *   version of this note.
 *
 * ── What this hook does NOT do ──────────────────────────────────
 *
 *   - It does not call `loadSettings` on mount. The hook is a
 *     passive reader; the component that mounts it decides when
 *     to fetch. The `Settings` page calls `loadSettings()` in its
 *     own `useEffect`; a component that only wants to read the
 *     theme (say, a root-level effect that applies the `dark`
 *     class) reads the store's `settings` field directly and
 *     handles the null case itself.
 *
 *   - It does not guard against the "no session" case. The
 *     settings feature is authenticated-only; its components
 *     render inside the layout's auth gate, which does not mount
 *     its children until a session exists.
 *
 *   - It does not apply the theme to the DOM. The store holds the
 *     `theme` value; the component that applies it is whatever
 *     element sits at the top of the renderer's tree. See
 *     `settingsStore.ts`'s file header for the "theme
 *     application" section that documents the layering.
 *
 *   - It does not expose the store's `setSettings` and `reset`
 *     actions under different names. Both are present on the
 *     returned object with their store-level names. A future
 *     session that wanted public aliases (`applySettings`,
 *     `clearAll`) would add them here; today the store's names
 *     read clearly at the call sites and there is no reason to
 *     rename.
 */

import {
  useSettingsStore,
  type SettingsStoreStatus,
} from '../store/settingsStore.js';
import type { UserSettingsMap } from '../../shared/types/index.js';

// ============================================================
//  Public types
// ============================================================

/**
 * The shape of the object returned by `useSettings()`.
 *
 * Exported so that a helper function that takes "an instance of
 * the settings hook" as a parameter can be typed against the
 * interface without redeclaring the shape. A component that
 * destructures the return value does not need to reference the
 * interface at all.
 */
export interface SettingsHookValue {
  // ---- Data ----

  /** The user's cross-topic preferences, or null before the
   *  first `loadSettings()` call completes. See the store's file
   *  header for the reasoning on why null is the correct initial
   *  value rather than a set of baked-in defaults. */
  settings: UserSettingsMap | null;

  /** The store's async lifecycle state. See `SettingsStoreStatus`
   *  in `settingsStore.ts` for the meaning of each value. */
  status: SettingsStoreStatus;

  /** The last error message from an async action, or null. */
  error: string | null;

  // ---- Actions ----

  /** Fetch the current settings from the main process. Resolves
   *  when the operation completes; the store's `status` and
   *  `error` fields reflect the outcome. */
  loadSettings: () => Promise<void>;

  /** Apply a partial update to the settings. Resolves with the
   *  merged `UserSettingsMap` on success, or null on failure. */
  saveSettings: (
    patch: Partial<UserSettingsMap>
  ) => Promise<UserSettingsMap | null>;

  /** Set the store's `settings` field directly, without a
   *  network round trip. Pass null to clear. */
  setSettings: (settings: UserSettingsMap | null) => void;

  /** Clear the last error message. */
  clearError: () => void;

  /** Reset the store to its initial state. */
  reset: () => void;
}

// ============================================================
//  The hook
// ============================================================

/**
 * Return the settings feature's state and its actions. See the
 * file header for the hook's role, its relationship to the store,
 * and the reasoning behind the design choices.
 */
export const useSettings = (): SettingsHookValue => {
  // ---- Data subscriptions ----
  // One selector per data field. See the file header for why
  // the fields are read individually rather than as one object.
  const settings = useSettingsStore((s) => s.settings);
  const status = useSettingsStore((s) => s.status);
  const error = useSettingsStore((s) => s.error);

  // ---- Action subscriptions ----
  // Zustand actions are stable references for the life of the
  // store, so selecting them here does not cause re-renders and
  // does not require `useCallback` around them. See the file
  // header for the reasoning.
  const loadSettings = useSettingsStore((s) => s.loadSettings);
  const saveSettings = useSettingsStore((s) => s.saveSettings);
  const setSettings = useSettingsStore((s) => s.setSettings);
  const clearError = useSettingsStore((s) => s.clearError);
  const reset = useSettingsStore((s) => s.reset);

  // ---- Return ----
  // A single object literal with all eight members. The order
  // matches the interface above, so a reader comparing the two
  // does not have to hunt for a member's position.
  return {
    settings,
    status,
    error,
    loadSettings,
    saveSettings,
    setSettings,
    clearError,
    reset,
  };
};

// ============================================================
//  Default export
// ============================================================

/**
 * The hook as the default export, matching the convention used
 * by every other hook and store in the codebase. Consumers that
 * prefer the named form use `import { useSettings } from ...`;
 * consumers that prefer the default form use
 * `import useSettings from ...`. Both resolve to the same hook.
 */
export default useSettings;