/**
 * validationStore — the renderer's transient state for the
 * validation feature.
 *
 * Holds the state that drives the Report tab on the topic-detail
 * page while a validation run is in flight and after it finishes.
 * Every piece of per-topic state is a record keyed by the topic's
 * ID, so switching between topics never clobbers the previous
 * topic's data:
 *
 *   activeArticleId      — the article that most recently began a
 *                          validation run. A tracking field only.
 *   activeTopicId        — the topic that most recently began a
 *                          validation run. A tracking field only.
 *   reportByTopic        — per-topic `Report` object the backend
 *                          returned for the last successful
 *                          validation run, or null when the topic
 *                          has been checked and has no report.
 *                          Absence of a key means "not yet loaded".
 *   isRunningByTopic     — per-topic in-flight flag. Drives the
 *                          Report tab's progress panel and the
 *                          disabled state of the "Run Validation"
 *                          button for the topic being viewed.
 *   progressByTopic      — per-topic live progress of the running
 *                          operation (which of the six validators
 *                          is currently executing), or null when
 *                          no run is in flight for that topic.
 *   statusByTopic        — per-topic lifecycle flag mirroring the
 *                          shape every other store uses (`'idle'`,
 *                          `'loading'`, `'error'`). Absence of a
 *                          key is treated as `'idle'`.
 *   errorByTopic         — per-topic last error message, or null.
 *
 * And the actions:
 *
 *   runValidation(articleId, topicId) — start a validation
 *                              operation for one topic. Sets that
 *                              topic's `isRunningByTopic` slot to
 *                              true, kicks off the IPC call, and
 *                              updates state as the operation runs
 *                              and as markers arrive.
 *   loadReport(articleId, topicId) — fetch the most recent report
 *                              for an article from the backend
 *                              without re-running the validators.
 *   setReport(topicId, report) — set a topic's report directly,
 *                              without a network round trip.
 *   clearError(topicId)        — dismiss one topic's last error.
 *   reset()                    — return every field to its initial
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
 *     * The `articleId` argument to `runValidation` and
 *       `loadReport` is what the store passes back to the
 *       `validation:run` and `validation:report` IPC channels.
 *
 *     * The `topicId` argument identifies which per-topic slot
 *       the operation's state belongs to. It also matches the
 *       `topicId` field on every Python-emitted marker, so the
 *       marker handler can route a marker to the correct topic's
 *       slot even when the user is viewing a different topic.
 *
 *   The caller (the Report tab component) knows both values — it
 *   has the `Article` object in hand and can read its `topicId`
 *   field — and passes them together. The store does not attempt
 *   to derive one from the other.
 *
 *   `activeArticleId` and `activeTopicId` are retained as
 *   tracking fields reflecting the most recent `runValidation`
 *   call. They are not read by the marker handler or by any
 *   action to scope behavior; they exist for diagnostic surfaces.
 *
 * ── Why `isRunningByTopic` is not flipped by VALIDATION_DONE ───
 *
 *   The `VALIDATION_DONE` marker is emitted by the Python script
 *   BEFORE the validation IPC handler has finished its work.
 *   After the marker arrives, the main process still has to (a)
 *   read the report file from disk, (b) POST it to the backend's
 *   `/api/reports` endpoint, and (c) return the resulting
 *   `Report` to the renderer. Flipping the topic's
 *   `isRunningByTopic` slot to false on the marker would tell the
 *   UI "we are done" before the report object is in the store,
 *   producing a brief interval where the Report tab shows neither
 *   a progress panel nor a finished report.
 *
 *   The `runValidation` action therefore owns the topic's
 *   `isRunningByTopic` slot from start to finish. The
 *   `VALIDATION_DONE` marker handler only clears the topic's
 *   `progressByTopic` slot — the progress panel is no longer
 *   relevant once the child has exited — and the
 *   `runValidation` action's terminal branch flips both the
 *   topic's `statusByTopic` and `isRunningByTopic` entries when
 *   the IPC promise resolves.
 *
 * ── Why the store is NOT persisted ────────────────────────────
 *
 *   Same reasoning as the sibling stores. The report object is
 *   an in-memory mirror of a backend record; a fresh session
 *   repopulates it by running validation again or by fetching
 *   from the backend. The `isRunning`, `progress`, and `error`
 *   fields are ephemeral by definition.
 *
 * ── The per-topic design ───────────────────────────────────────
 *
 *   The store holds per-topic validation state — one slot per
 *   topic, keyed by the topic's ID. A validation run for topic B
 *   does not clobber a previous report for topic A; the store
 *   simply holds a slot for every topic that has been validated
 *   this session. When the user navigates back to topic A, its
 *   report is already in the store.
 *
 *   The marker handler routes each incoming marker to its own
 *   topic's slot using the `topicId` on the payload, so markers
 *   that arrive while the user is viewing a different topic are
 *   still applied to the correct slot.
 *
 *   A topic can own multiple article versions; the store
 *   currently keys the report by topic rather than by article, so
 *   validating a second article of the same topic overwrites the
 *   first article's cached report. A future session that wanted
 *   per-article keying would change the record key from `topicId`
 *   to `articleId` — a mechanical change confined to this file.
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
 *     being fetched". Both cases are represented by the topic's
 *     `reportByTopic` slot being null, with the topic's
 *     `isRunningByTopic` slot being the differentiator. A
 *     component that renders the Report tab reads both.
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

  /** The article that most recently began a validation run, or
   *  null before any run. A tracking field only — the marker
   *  handler routes each marker to its own topic's slot using
   *  the payload's `topicId`, not this value. */
  activeArticleId: string | null;

  /** The topic that most recently began a validation run, or
   *  null before any run. A tracking field only. */
  activeTopicId: string | null;

  /** Per-topic `Report` from the last successful validation, or
   *  null when the topic has been checked and has no report.
   *  Absence of a key means "not yet loaded". */
  reportByTopic: Record<string, Report | null>;

  /** Per-topic in-flight flag. Absence of a key is treated as
   *  `false`. */
  isRunningByTopic: Record<string, boolean>;

  /** Per-topic live progress of the running validation, or null
   *  when no run is in flight for that topic. */
  progressByTopic: Record<string, ValidationProgress | null>;

  /** Per-topic async lifecycle state. Absence of a key is treated
   *  as `'idle'`. */
  statusByTopic: Record<string, ValidationStoreStatus>;

  /** Per-topic last error message, or null. */
  errorByTopic: Record<string, string | null>;

  // ---- Actions ----

  /**
   * Run a validation on an article. Invokes
   * `window.electronAPI.validation.run(articleId)` and updates
   * the topic's slots as the operation runs. Progress arrives
   * through the marker channel; the final `Report` arrives as
   * this action's return value.
   *
   * The `topicId` argument identifies which per-topic slot the
   * operation's state belongs to. The caller has the `Article`
   * object in hand and reads its `topicId` field. See the file
   * header for the reasoning on tracking both IDs.
   *
   * Returns the created `Report` on success, or null on failure.
   */
  runValidation: (
    articleId: string,
    topicId: string
  ) => Promise<Report | null>;

  /**
   * Fetch the most recent report for an article from the backend,
   * and cache it in the topic's slot. Does not re-run the
   * validators. Used by the Report tab's "load existing report
   * on mount" flow.
   *
   * Returns the fetched `Report` on success, or null on failure.
   * A 404 (no report yet for this article) resolves as a null
   * return with the topic's error slot set — the caller treats
   * that as "no report yet" rather than as a hard failure.
   */
  loadReport: (
    articleId: string,
    topicId: string
  ) => Promise<Report | null>;

  /**
   * Set a topic's report directly, without a network round trip.
   * Used by a caller that produced a Report through some other
   * path, or that wants to restore a previously-cached report.
   */
  setReport: (topicId: string, report: Report | null) => void;

  /** Clear one topic's last error message. */
  clearError: (topicId: string) => void;

  /** Reset every field to its initial value. */
  reset: () => void;

  // ---- Per-topic getters ----

  /** Return the cached report for a topic, or null when none is
   *  loaded or the topic has no report. */
  getReport: (topicId: string) => Report | null;

  /** Return whether a validation run is in flight for a topic. */
  getIsRunning: (topicId: string) => boolean;

  /** Return the live progress for a topic, or null when none. */
  getProgress: (topicId: string) => ValidationProgress | null;

  /** Return the async lifecycle state for a topic. */
  getStatus: (topicId: string) => ValidationStoreStatus;

  /** Return the last error message for a topic, or null. */
  getError: (topicId: string) => string | null;

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
  reportByTopic: {} as Record<string, Report | null>,
  isRunningByTopic: {} as Record<string, boolean>,
  progressByTopic: {} as Record<string, ValidationProgress | null>,
  statusByTopic: {} as Record<string, ValidationStoreStatus>,
  errorByTopic: {} as Record<string, string | null>,
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
    //
    // Each marker is routed to its own topic's slot using the
    // `topicId` on the payload. The handler does NOT filter on
    // `activeTopicId` — a marker that arrives for a topic the
    // user is not currently viewing must still update that
    // topic's slot, so that navigating back to it shows the
    // correct state.
    _handleMarker: (event: MarkerEvent): void => {
      const topicId = readTopicId(event.payload);
      if (topicId === null) return;

      switch (event.type) {
        case 'VALIDATION_PROGRESS': {
          const progress = narrowValidationProgress(event.payload);
          if (progress !== null) {
            set((state) => ({
              progressByTopic: {
                ...state.progressByTopic,
                [topicId]: progress,
              },
            }));
          }
          return;
        }

        case 'VALIDATION_DONE': {
          // The child has exited. Clear this topic's progress
          // panel — the panel is no longer relevant — but leave
          // the topic's `isRunningByTopic` and `statusByTopic`
          // for the `runValidation` action's in-flight promise to
          // flip. See the file header's "Why isRunningByTopic is
          // not flipped by VALIDATION_DONE" section.
          set((state) => ({
            progressByTopic: {
              ...state.progressByTopic,
              [topicId]: null,
            },
          }));
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
      // Set the tracking IDs and flip the in-flight flags for
      // this topic. The topic's `reportByTopic` slot is NOT
      // cleared here — a re-run keeps the previous report
      // visible until the new one lands, so the user is never
      // staring at an empty tab while the operation runs.
      set((state) => ({
        activeArticleId: articleId,
        activeTopicId: topicId,
        isRunningByTopic: {
          ...state.isRunningByTopic,
          [topicId]: true,
        },
        progressByTopic: {
          ...state.progressByTopic,
          [topicId]: null,
        },
        statusByTopic: {
          ...state.statusByTopic,
          [topicId]: 'loading',
        },
        errorByTopic: {
          ...state.errorByTopic,
          [topicId]: null,
        },
      }));

      try {
        const result =
          await window.electronAPI.validation.run(articleId);

        if (result.success && result.data) {
          const report = result.data;
          set((state) => ({
            reportByTopic: {
              ...state.reportByTopic,
              [topicId]: report,
            },
            isRunningByTopic: {
              ...state.isRunningByTopic,
              [topicId]: false,
            },
            progressByTopic: {
              ...state.progressByTopic,
              [topicId]: null,
            },
            statusByTopic: {
              ...state.statusByTopic,
              [topicId]: 'idle',
            },
          }));
          return report;
        }

        set((state) => ({
          isRunningByTopic: {
            ...state.isRunningByTopic,
            [topicId]: false,
          },
          progressByTopic: {
            ...state.progressByTopic,
            [topicId]: null,
          },
          statusByTopic: {
            ...state.statusByTopic,
            [topicId]: 'error',
          },
          errorByTopic: {
            ...state.errorByTopic,
            [topicId]: result.error ?? 'Validation failed.',
          },
        }));
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
        set((state) => ({
          isRunningByTopic: {
            ...state.isRunningByTopic,
            [topicId]: false,
          },
          progressByTopic: {
            ...state.progressByTopic,
            [topicId]: null,
          },
          statusByTopic: {
            ...state.statusByTopic,
            [topicId]: 'error',
          },
          errorByTopic: {
            ...state.errorByTopic,
            [topicId]:
              err instanceof Error
                ? err.message
                : 'Unable to reach the validation service.',
          },
        }));
        return null;
      }
    },

    // ---- loadReport ----
    loadReport: async (
      articleId: string,
      topicId: string
    ): Promise<Report | null> => {
      // The `loadReport` action does not flip the topic's
      // `isRunningByTopic` slot, for the same reason
      // `topicStore.loadTopics` is the only action that flips
      // `status: 'loading'` in the topics store — a read of
      // existing data should not lock the UI's other controls
      // the way a long-running operation does. The caller can
      // manage its own loading indicator if it wants one.
      try {
        const result =
          await window.electronAPI.validation.report(articleId);

        if (result.success && result.data) {
          const report = result.data;
          set((state) => ({
            activeArticleId: articleId,
            activeTopicId: topicId,
            reportByTopic: {
              ...state.reportByTopic,
              [topicId]: report,
            },
            errorByTopic: {
              ...state.errorByTopic,
              [topicId]: null,
            },
          }));
          return report;
        }

        // A 404 ("no report yet for this article") arrives here
        // as `{ success: false, error: 'No report found...' }`.
        // Setting this topic's error slot is correct — the
        // caller sees the message — but the store does not flip
        // the topic's `statusByTopic` slot to 'error', because
        // "no report yet" is a legitimate state for the Report
        // tab's idle view, not a hard failure.
        set((state) => ({
          errorByTopic: {
            ...state.errorByTopic,
            [topicId]:
              result.error ?? 'No report found for this article.',
          },
        }));
        return null;
      } catch (err) {
        console.error(
          '[validationStore] loadReport failed:',
          err
        );
        set((state) => ({
          errorByTopic: {
            ...state.errorByTopic,
            [topicId]:
              err instanceof Error
                ? err.message
                : 'Unable to load the report.',
          },
        }));
        return null;
      }
    },

    // ---- setReport ----
    setReport: (topicId: string, report: Report | null): void => {
      set((state) => ({
        reportByTopic: {
          ...state.reportByTopic,
          [topicId]: report,
        },
      }));
    },

    // ---- Clear helpers ----
    clearError: (topicId: string): void => {
      set((state) => ({
        errorByTopic: {
          ...state.errorByTopic,
          [topicId]: null,
        },
      }));
      if (get().statusByTopic[topicId] === 'error') {
        set((state) => ({
          statusByTopic: {
            ...state.statusByTopic,
            [topicId]: 'idle',
          },
        }));
      }
    },

    reset: (): void => {
      set({ ...INITIAL_STATE });
    },
    
    // ---- Per-topic getters ----
    // Each getter reads one topic's value from the corresponding
    // per-topic record, with a safe default for a topic that has
    // no entry yet. The getters are convenience wrappers over
    // the records, not a second source of truth.

    getReport: (topicId: string): Report | null => {
      return get().reportByTopic[topicId] ?? null;
    },

    getIsRunning: (topicId: string): boolean => {
      return get().isRunningByTopic[topicId] ?? false;
    },

    getProgress: (topicId: string): ValidationProgress | null => {
      return get().progressByTopic[topicId] ?? null;
    },

    getStatus: (topicId: string): ValidationStoreStatus => {
      return get().statusByTopic[topicId] ?? 'idle';
    },

    getError: (topicId: string): string | null => {
      return get().errorByTopic[topicId] ?? null;
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