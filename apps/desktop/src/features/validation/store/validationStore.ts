/**
 * validationStore — the renderer's transient state for the
 * validation feature.
 *
 * Holds the state that drives the Report tab on the topic-detail
 * page while a validation run is in flight and after it finishes:
 *
 *   activeArticleId — which article the state belongs to.
 *   isRunning       — whether a validation operation is in flight.
 *                     Drives the Report tab's progress panel and
 *                     the disabled state of the "Run Validation"
 *                     button.
 *   progress        — the live progress of the running operation
 *                     (which of the six validators is currently
 *                     executing), or null when no run is in
 *                     flight.
 *   report          — the `Report` object the backend returned for
 *                     the last successful validation run, or null
 *                     before the first run. The Report tab's six
 *                     panels render from this object's section
 *                     fields.
 *   status          — a coarse lifecycle flag mirroring the shape
 *                     every other store uses (`'idle'`,
 *                     `'loading'`, `'error'`). `isRunning` is
 *                     derived from this and is exposed as a
 *                     convenience for the UI.
 *   error           — the last error message, or null.
 *
 * And the actions:
 *
 *   runValidation(articleId) — start a validation operation. Sets
 *                              `isRunning: true`, kicks off the
 *                              IPC call, and updates state as the
 *                              operation runs and as markers
 *                              arrive.
 *   loadReport(articleId)    — fetch the most recent report for
 *                              an article from the backend
 *                              without re-running the validators.
 *   setReport(report)        — set the current report directly,
 *                              without a network round trip.
 *   clearError()             — dismiss the last error.
 *   reset()                  — return every field to its initial
 *                              value.
 *
 * ── How the store receives updates ────────────────────────────
 *
 *   Same pattern as `researchStore.ts`, `documentStore.ts`, and
 *   `writerStore.ts`. On module load, the store installs ONE
 *   listener on the `research:marker` channel via the preload's
 *   generic `window.electronAPI.on(...)` API. Every marker the
 *   main process emits — from searchService, extractionService,
 *   writerService, and validationService — flows through that
 *   one channel, and each store's handler routes the marker
 *   types it cares about to its own state.
 *
 *   The validation store's handler reacts to `VALIDATION_PROGRESS`
 *   and `VALIDATION_DONE`. It ignores every other marker type.
 *
 *   The filtering is by article, not by topic, because the
 *   validation IPC handler already resolves the article's topic
 *   internally. The validation markers emitted by
 *   `validate_all.py` carry a `topicId` (matching the store's
 *   `activeTopicId` field) rather than an `articleId` — the
 *   Python side does not know the article's Mongo ID, which is
 *   assigned by the backend. The store therefore tracks both
 *   an `activeArticleId` (the caller's argument, used to
 *   correlate with the report the backend returns) and an
 *   `activeTopicId` (the value the markers carry, used to filter
 *   the marker stream). See `setActiveTopicFromArticle` for the
 *   contract between the two.
 *
 * ── Why the store tracks both an article ID and a topic ID ────
 *
 *   A validation operation is keyed on an article (the IPC
 *   handler's `run` channel takes an `articleId`), but the
 *   Python script that runs the validators is keyed on a topic
 *   (it reads the topic's `sources/` folder for the originality
 *   check and writes its report into the topic's `reports/`
 *   folder). The two identifiers are both required:
 *
 *     * `activeArticleId` is what the renderer passes back to the
 *       `validation:run` and `validation:report` IPC channels.
 *
 *     * `activeTopicId` is what the marker handler compares
 *       against each incoming marker's `topicId` field.
 *
 *   The caller (the Report tab component) knows both values — it
 *   has the `Article` object in hand and can read its `topicId`
 *   field — and passes them to `runValidation` and `loadReport`
 *   together. The store does not attempt to derive one from the
 *   other.
 *
 * ── Why `isRunning` is not flipped by the VALIDATION_DONE marker ─
 *
 *   The `VALIDATION_DONE` marker is emitted by the Python script
 *   BEFORE the validation IPC handler has finished its work.
 *   After the marker arrives, the main process still has to (a)
 *   read the report file from disk, (b) POST it to the backend's
 *   `/api/reports` endpoint, and (c) return the resulting
 *   `Report` to the renderer. Flipping `isRunning` to false on
 *   the marker would tell the UI "we are done" before the report
 *   object is in the store, producing a brief interval where the
 *   Report tab shows neither a progress panel nor a finished
 *   report.
 *
 *   The `runValidation` action therefore owns `isRunning` from
 *   start to finish. The `VALIDATION_DONE` marker handler only
 *   clears the `progress` field — the progress panel is no
 *   longer relevant once the child has exited — and the
 *   `runValidation` action's terminal branch flips both `status`
 *   and `isRunning` when the IPC promise resolves.
 *
 * ── Why the store is NOT persisted ────────────────────────────
 *
 *   Same reasoning as the sibling stores. The report object is
 *   an in-memory mirror of a backend record; a fresh session
 *   repopulates it by running validation again or by fetching
 *   from the backend. The `isRunning`, `progress`, and `error`
 *   fields are ephemeral by definition.
 *
 * ── The single-article design ─────────────────────────────────
 *
 *   The store holds one article's validation state at a time,
 *   identified by `activeArticleId`. Same model as the sibling
 *   stores. A future session that wanted parallel validation
 *   across multiple articles would convert the flat state into a
 *   `Map<articleId, ValidationState>` — a mechanical change
 *   confined to this file.
 *
 * ── Why the type-only import from listenerBridge ──────────────
 *
 *   `MarkerEvent` is declared in `listenerBridge.ts`, a
 *   main-process module that imports `BrowserWindow` from
 *   `electron`. A runtime import would crash the renderer at
 *   bundle time. The `import type` form is erased by the
 *   compiler, so the runtime bundle contains no reference to
 *   `listenerBridge`.
 *
 *   The channel name `'research:marker'` is declared as a local
 *   constant in this file rather than imported, for the same
 *   reason. The two strings must match; the cross-module contract
 *   is documented in both files.
 *
 * ── What this store does NOT do ────────────────────────────────
 *
 *   - It does not persist. See above.
 *
 *   - It does not call the backend directly. The validation IPC
 *     handler (in the main process) is what POSTs the report to
 *     `/api/reports`; the store only invokes the IPC channel and
 *     receives the resulting `Report`.
 *
 *   - It does not handle the captcha or manual-action modals.
 *     Those markers reach the renderer over the same channel and
 *     are routed by the automation store (Session 20). This
 *     store's handler explicitly ignores them.
 *
 *   - It does not distinguish "no report yet" from "the report is
 *     being fetched". Both cases are represented by
 *     `report === null` with `isRunning` being the
 *     differentiator. A component that renders the Report tab
 *     reads both fields.
 */

import { create } from 'zustand';

import type { MarkerEvent } from '../../research/services/listenerBridge.js';
import type { Report } from '../../shared/types/index.js';

// =============================================================================
//  Channel name
// =============================================================================
//
//  The IPC channel the main process emits every marker on. Must
//  match `listenerBridge.ts`'s exported `MARKER_EVENT_CHANNEL`
//  constant and the sibling stores' local declarations of the
//  same value. Declared locally because the bridge module cannot
//  be imported at runtime — see the file header.

const MARKER_CHANNEL = 'research:marker';

// =============================================================================
//  Public types
// =============================================================================

/**
 * Live progress of a running validation. Reported by the Python
 * script's `VALIDATION_PROGRESS` markers, one per validator. The
 * six validators the Python side runs are the six section names
 * on the `Report` interface, in the same order: readability, seo,
 * keywords, originality, ai_markers, grammar.
 *
 * The `phase` string is the validator's name as the Python side
 * spells it (with underscores, matching the `_PHASES` tuple in
 * `validation/validate_all.py`). The `index` and `total` fields
 * give the panel enough information to render a "3 of 6" line.
 */
export interface ValidationProgress {
  /** Which validator is currently running. One of the six
   *  underscore-separated phase names. */
  phase: string;

  /** The 1-based index of the validator in the run. */
  index: number;

  /** The total number of validators (currently six). */
  total: number;
}

/**
 * The store's async lifecycle state. Same shape as the sibling
 * stores' status types.
 *
 *   'idle'    — no operation is running, and the last one (if
 *               any) succeeded. The default state.
 *   'loading' — a validation run is in flight. Also reflected in
 *               the `isRunning` boolean, which exists as a
 *               convenience for consumers that only care about
 *               that one boolean.
 *   'error'   — the last operation failed. The `error` field
 *               carries a user-facing message.
 */
export type ValidationStoreStatus = 'idle' | 'loading' | 'error';

/**
 * The full shape of the validation store's state, including both
 * the data fields and the actions.
 */
export interface ValidationStoreState {
  // ---- Data ----

  /** The article whose report the store holds, or null before any
   *  validation run. */
  activeArticleId: string | null;

  /** The topic whose markers the store filters on. Populated by
   *  the caller when starting a validation run, so the marker
   *  handler can match the `topicId` field that the Python-side
   *  markers carry. */
  activeTopicId: string | null;

  /** Whether a validation run is currently in flight. */
  isRunning: boolean;

  /** The live progress of the running validation, or null when
   *  no run is in flight. */
  progress: ValidationProgress | null;

  /** The `Report` object from the last successful validation, or
   *  null before the first one. */
  report: Report | null;

  /** The store's async lifecycle state. */
  status: ValidationStoreStatus;

  /** The last error message, or null. */
  error: string | null;

  // ---- Actions ----

  /**
   * Run a validation on an article. Invokes
   * `window.electronAPI.validation.run(articleId)` and updates
   * state as the operation runs. Progress arrives through the
   * marker channel; the final `Report` arrives as this action's
   * return value.
   *
   * The `topicId` argument is required so the store can filter
   * the marker stream. The caller has the `Article` object in
   * hand and reads its `topicId` field. See the file header for
   * the reasoning on tracking both IDs.
   *
   * Returns the created `Report` on success, or null on failure.
   */
  runValidation: (
    articleId: string,
    topicId: string
  ) => Promise<Report | null>;

  /**
   * Fetch the most recent report for an article from the backend.
   * Does not re-run the validators. Used by the Report tab's
   * "load existing report on mount" flow.
   *
   * Returns the fetched `Report` on success, or null on failure.
   * A 404 (no report yet for this article) resolves as a null
   * return with `error` set — the caller treats that as "no
   * report yet" rather than as a hard failure.
   */
  loadReport: (articleId: string) => Promise<Report | null>;

  /**
   * Set the current report directly, without a network round
   * trip. Used by a caller that produced a Report through some
   * other path or wants to restore a previously-cached report.
   */
  setReport: (report: Report | null) => void;

  /** Clear the last error message. */
  clearError: () => void;

  /** Reset every field to its initial value. */
  reset: () => void;

  /**
   * Internal — route one marker event to the correct state
   * update. Called by the module-level listener installed at
   * import time; not intended for direct use by components.
   */
  _handleMarker: (event: MarkerEvent) => void;
}

// =============================================================================
//  Initial state
// =============================================================================

/**
 * The store's initial data fields. Extracted as a constant so
 * `reset` can spread it into a new state object without
 * duplicating the literals.
 */
const INITIAL_STATE = {
  activeArticleId: null as string | null,
  activeTopicId: null as string | null,
  isRunning: false,
  progress: null as ValidationProgress | null,
  report: null as Report | null,
  status: 'idle' as ValidationStoreStatus,
  error: null as string | null,
};

// =============================================================================
//  Marker payload narrowing
// =============================================================================
//
//  The marker handler's payloads arrive as `unknown`. The helpers
//  below narrow the ones this store cares about. A malformed
//  payload is silently ignored rather than throwing — a broken
//  marker must not crash the UI.

/**
 * Read the `topicId` field from a marker's payload, or return
 * null. Used by the marker handler to filter out markers that
 * belong to a different topic.
 */
const readTopicId = (payload: unknown): string | null => {
  if (typeof payload !== 'object' || payload === null) {
    return null;
  }
  const t = (payload as { topicId?: unknown }).topicId;
  return typeof t === 'string' && t.length > 0 ? t : null;
};

/**
 * Narrow a `VALIDATION_PROGRESS` payload into a `ValidationProgress`.
 * Returns null for a payload missing any of the three required
 * fields, or with a non-string phase.
 */
const narrowValidationProgress = (
  payload: unknown
): ValidationProgress | null => {
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as Record<string, unknown>;
  const phase = p['phase'];
  const index = p['index'];
  const total = p['total'];
  if (
    typeof phase !== 'string' ||
    phase.length === 0 ||
    typeof index !== 'number' ||
    typeof total !== 'number'
  ) {
    return null;
  }
  return { phase, index, total };
};

// =============================================================================
//  Store
// =============================================================================

/**
 * The validation store. See the file header for its
 * responsibilities, its subscription model, and the reasoning
 * behind its design.
 *
 * Created without middleware — no `persist` (the store is
 * transient), no `devtools`, no Immer. Same shape as the sibling
 * stores.
 */
export const useValidationStore = create<ValidationStoreState>(
  (set, get) => ({
    // ---- Initial data ----
    ...INITIAL_STATE,

    // ---- Marker handler ----
    //
    // Reacts to the two validation-stage marker types. Every
    // other marker is ignored — CAPTCHA_REQUIRED, MANUAL_ACTION,
    // SEARCH_*, EXTRACT_*, WRITER_*, and the task-boundary
    // markers all belong to other stores.
    _handleMarker: (event: MarkerEvent): void => {
      const topicId = readTopicId(event.payload);
      if (topicId === null) return;
      if (topicId !== get().activeTopicId) return;

      switch (event.type) {
        case 'VALIDATION_PROGRESS': {
          const progress = narrowValidationProgress(event.payload);
          if (progress !== null) {
            set({ progress });
          }
          return;
        }

        case 'VALIDATION_DONE': {
          // The child has exited. Clear the progress panel — the
          // panel is no longer relevant — but leave `isRunning`
          // and `status` for the `runValidation` action's
          // in-flight promise to flip. See the file header's
          // "Why isRunning is not flipped by the VALIDATION_DONE
          // marker" section.
          set({ progress: null });
          return;
        }

        default:
          // TASK_START, TASK_END, CAPTCHA_REQUIRED,
          // CAPTCHA_SOLVED, MANUAL_ACTION, SEARCH_*, EXTRACT_*,
          // WRITER_*, and any future marker this store does not
          // yet know about.
          return;
      }
    },

    // ---- runValidation ----
    runValidation: async (
      articleId: string,
      topicId: string
    ): Promise<Report | null> => {
      // Set the active IDs and flip the in-flight flags. The
      // `report` field is NOT cleared here — a re-run keeps the
      // previous report visible until the new one lands, so the
      // user is never staring at an empty tab while the
      // operation runs.
      set({
        activeArticleId: articleId,
        activeTopicId: topicId,
        isRunning: true,
        progress: null,
        status: 'loading',
        error: null,
      });

      try {
        const result =
          await window.electronAPI.validation.run(articleId);

        if (result.success && result.data) {
          const report = result.data;
          set({
            report,
            isRunning: false,
            progress: null,
            status: 'idle',
          });
          return report;
        }

        set({
          isRunning: false,
          progress: null,
          status: 'error',
          error: result.error ?? 'Validation failed.',
        });
        return null;
      } catch (err) {
        // An IPC rejection is unusual — the preload resolves
        // business failures into envelopes — but can happen if
        // the channel is unregistered or the renderer's context
        // has been torn down.
        console.error(
          '[validationStore] runValidation failed:',
          err
        );
        set({
          isRunning: false,
          progress: null,
          status: 'error',
          error:
            err instanceof Error
              ? err.message
              : 'Unable to reach the validation service.',
        });
        return null;
      }
    },

    // ---- loadReport ----
    loadReport: async (
      articleId: string
    ): Promise<Report | null> => {
      // The `loadReport` action does not flip `isRunning`, for
      // the same reason `topicStore.loadTopics` is the only
      // action that flips `status: 'loading'` in the topics
      // store — a read of existing data should not lock the
      // UI's other controls the way a long-running operation
      // does. The caller can manage its own loading indicator
      // if it wants one.
      try {
        const result =
          await window.electronAPI.validation.report(articleId);

        if (result.success && result.data) {
          set({
            activeArticleId: articleId,
            report: result.data,
            error: null,
          });
          return result.data;
        }

        // A 404 ("no report yet for this article") arrives here
        // as `{ success: false, error: 'No report found...' }`.
        // Setting `error` is correct — the caller sees the
        // message — but the store does not flip `status` to
        // 'error', because "no report yet" is a legitimate
        // state for the Report tab's idle view, not a hard
        // failure.
        set({
          error: result.error ?? 'No report found for this article.',
        });
        return null;
      } catch (err) {
        console.error(
          '[validationStore] loadReport failed:',
          err
        );
        set({
          error:
            err instanceof Error
              ? err.message
              : 'Unable to load the report.',
        });
        return null;
      }
    },

    // ---- setReport ----
    setReport: (report: Report | null): void => {
      set({ report });
    },

    // ---- Clear helpers ----
    clearError: (): void => {
      set({ error: null });
      if (get().status === 'error') {
        set({ status: 'idle' });
      }
    },

    reset: (): void => {
      set({ ...INITIAL_STATE });
    },
  })
);

// =============================================================================
//  Marker listener installation
// =============================================================================
//
//  The listener is installed ONCE at module load. See the file
//  header for why the subscription lives at the store level
//  rather than per-component.
//
//  The guard `typeof window !== 'undefined'` protects against a
//  non-renderer context (a future test harness that imports the
//  store to exercise its reducers). When the guard fails, the
//  store still works as a pure state container — actions write
//  state, components read state — but the marker stream never
//  arrives. In the app, the guard always passes.

if (
  typeof window !== 'undefined' &&
  typeof window.electronAPI === 'object' &&
  window.electronAPI !== null
) {
  window.electronAPI.on(MARKER_CHANNEL, (raw: unknown) => {
    // The preload passes the marker through unchanged. Its
    // runtime shape is `{ type: string, payload: unknown }`.
    // The type assertion here is safe because the channel is
    // owned by the main process's services, which emit exactly
    // that shape for every message.
    useValidationStore
      .getState()
      ._handleMarker(raw as MarkerEvent);
  });
}

// =============================================================================
//  Default export
// =============================================================================

/**
 * The hook as the default export, matching the convention used
 * by every other store in the codebase. Consumers that prefer
 * the named form use `import { useValidationStore } from ...`;
 * consumers that prefer the default form use
 * `import useValidationStore from ...`. Both resolve to the same
 * hook.
 */
export default useValidationStore;