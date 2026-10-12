/**
 * useValidation — the renderer's validation hook.
 *
 * The single entry point through which the app's components read
 * and manipulate the validation feature's state. It sits over
 * `useValidationStore` and mirrors the role `useTopics`,
 * `useResearch`, `useDocuments`, and `useWriter` play for their
 * respective features:
 *
 *   - The store owns the state. The hook does not add any.
 *
 *   - The store owns the async actions that reach the IPC layer
 *     and, through it, the main process. The hook does not
 *     reimplement them.
 *
 *   - The hook's only job is to give a component a single, stable
 *     object with everything the validation feature exposes — the
 *     data fields and the actions — under the names the plan's
 *     Part 1.12 table declares.
 *
 * ── The hook's signature (PR-1) ─────────────────────────────────
 *
 *   `useValidation(topicId)` — the topic ID argument is required.
 *   The hook reads the topic's per-topic slots from the store via
 *   selectors keyed on that ID, so two components rendering
 *   different topics see independent state, and the same
 *   component re-renders only when its own topic's state changes.
 *
 *   This mirrors `useWriter(topicId)`, `useResearch(topicId)`,
 *   and `useDocuments(topicId)`'s shape. Every feature hook that
 *   drives a per-topic pipeline stage takes the topic ID as its
 *   first argument, so the pattern is uniform across the writer,
 *   research, documents, and validation features. The signature
 *   change is the PR-1 store-isolation refactor's consequence for
 *   this file, per Q4.3's "refactor all feature stores to key by
 *   topicId in the same pass."
 *
 * ── The hook's API ──────────────────────────────────────────────
 *
 *   Data fields (all read from the topic passed to the hook):
 *
 *     activeArticleId  The article that most recently began a
 *                      validation run, or null before any run. A
 *                      tracking field only; the marker handler
 *                      routes each marker by its payload's
 *                      `topicId`, not by this value.
 *     activeTopicId    The topic that most recently began a
 *                      validation run. A tracking field only.
 *     isRunning        Whether a validation run is in flight for
 *                      the topic.
 *     progress         The live progress of the running operation
 *                      for the topic, or null when none is running.
 *     report           The topic's last successfully-generated
 *                      Report, or null before the first one.
 *     status           The topic's async lifecycle state.
 *     error            The topic's last error message, or null.
 *
 *   Actions:
 *
 *     runValidation(articleId, topicId)
 *                      Start a validation operation. Resolves with
 *                      the created `Report` on success, or null on
 *                      failure.
 *
 *     revalidate(articleId, topicId)
 *                      Same as `runValidation`, under the name the
 *                      plan's Part 1.12 table uses. See "Why two
 *                      names for one action" below.
 *
 *     loadReport(articleId, topicId)
 *                      Fetch the most recent report for an article
 *                      from the backend without re-running the
 *                      validators. Resolves with the fetched
 *                      `Report`, or null when none exists or the
 *                      fetch failed.
 *
 *     setReport(topicId, report)
 *                      Set the topic's report directly, without a
 *                      network round trip. Pass null to clear.
 *
 *     clearError(topicId)
 *                      Clear the topic's last error message.
 *
 *     reset()          Reset the store to its initial state. A
 *                      store-wide operation, not a per-topic one;
 *                      the root store's logout flow is the caller
 *                      that uses it.
 *
 * ── Why two names for one action ───────────────────────────────
 *
 *   The plan's Part 1.12 table declares the hook's actions as
 *   `runValidation()` and `revalidate()`. That is the
 *   specification this file must honor — a future reader who has
 *   the plan in hand and opens this hook should see the two names
 *   they expect.
 *
 *   Functionally, the two are identical today: both call the
 *   store's `runValidation` action with the same two arguments,
 *   and both produce the same result. The distinction the plan
 *   draws between them is semantic — "run" for the first
 *   validation on an article, "revalidate" for a subsequent one
 *   after an edit — but the underlying operation is the same:
 *   spawn the Python validators and store the resulting report.
 *   The store's `runValidation` action does not distinguish "first
 *   time" from "again" because the operation itself does not — a
 *   second run replaces the previous `report` field with the new
 *   one, exactly as the UI's "Re-validate" button should behave.
 *
 *   The plan's user journey (Stage 6) describes a future
 *   corrective loop where a revalidation passes specific
 *   validation failures back to the writer. When that feature
 *   lands, `revalidate` will gain a second parameter (the
 *   corrective feedback) and will call a different store action
 *   with it, while `runValidation` stays argument-free. Until
 *   then, both are aliases for the same store action.
 *
 *   The `useCallback` wrappers around `runValidation` and
 *   `revalidate` are the one place this hook deviates from the
 *   "select the action directly" pattern the sibling hooks use.
 *   The reason is that the two names must have stable identities
 *   across renders — a component that puts `revalidate` in a
 *   `useEffect` dependency array expects it to be the same
 *   function from one render to the next. Wrapping the store's
 *   stable `runValidation` reference in a `useCallback` that
 *   depends only on that reference produces a wrapper with a
 *   stable identity across renders, which is what the caller
 *   needs.
 *
 *   The `loadReport`, `setReport`, `clearError`, and `reset`
 *   actions are exposed directly — they are already stable
 *   references from the store, and there is no second name for
 *   any of them.
 *
 * ── Why the two arguments on runValidation and revalidate ──────
 *
 *   The store's `runValidation` action takes both an `articleId`
 *   and a `topicId`. The reason is documented in
 *   `validationStore.ts`'s file header: the article ID is what
 *   the IPC channel's `validation:run` takes (matching the
 *   preload's fixed signature), and the topic ID is what the
 *   Python-side markers carry (matching the `emit_marker` calls
 *   in `validate_all.py`). The store needs both to correlate the
 *   IPC call with the marker stream.
 *
 *   The hook preserves the two-argument signature for the same
 *   reason. A caller that reads the article object it already has
 *   in hand (`article._id` and `article.topicId`) passes both —
 *   the two IDs travel together as a natural pair. A future
 *   session that added a preload channel that resolved the topic
 *   ID from the article ID (or that changed the marker payloads
 *   to carry the article ID) could simplify the signature to one
 *   argument; that change is a coordinated update across three
 *   files (the preload, the IPC handler, and this hook) that the
 *   current plan defers.
 *
 * ── Why the hook subscribes to each data field separately ───────
 *
 *   Same reasoning as the sibling hooks. Zustand re-renders a
 *   component when any of the selectors it subscribed to returns
 *   a different value; subscribing per-field gives the
 *   finest-grained re-render behavior. The alternative — one
 *   selector returning the whole state — would re-render on
 *   every store change and need a shallow-equality comparator to
 *   avoid wasted renders.
 *
 * ── What this hook does NOT do ──────────────────────────────────
 *
 *   - It does not call `runValidation` on mount. The hook is a
 *     passive reader; the component that mounts it decides when
 *     to fire a validation. The `ValidationReport` component
 *     (Session 16, step 124) calls `runValidation(article._id,
 *     article.topicId)` from a click handler, not from a mount
 *     effect.
 *
 *   - It does not guard against the "no session" case. The
 *     validation feature is authenticated-only; its components
 *     render inside the layout's auth gate, which does not mount
 *     its children until a session exists.
 *
 *   - It does not expose the store's internal `_handleMarker`
 *     action. That action is called by the module-load listener,
 *     never by a component. Exposing it would give a caller a
 *     way to inject a fake marker event into the store, which
 *     the current code has no reason to support.
 *
 *   - It does not derive a "current report is stale" flag. A
 *     future session that wants to invalidate a report when the
 *     article's content changes would add that derivation here
 *     — comparing the report's `articleId` and the current
 *     article's `_id` is not enough (they are always equal),
 *     so the check would need the article's `updatedAt` field
 *     compared against the report's `createdAt`. That check is
 *     not required by the current plan.
 */

import { useCallback } from 'react';

import {
  useValidationStore,
  type ValidationStoreStatus,
  type ValidationProgress,
} from '../store/validationStore.js';
import type { Report } from '../../shared/types/index.js';

// ============================================================
//  Public types
// ============================================================

/**
 * The shape of the object returned by `useValidation()`.
 *
 * Exported so that a helper function that takes "an instance of
 * the validation hook" as a parameter can be typed against the
 * interface without redeclaring the shape. A component that
 * destructures the return value does not need to reference the
 * interface at all.
 */
export interface ValidationHookValue {
  // ---- Data ----

  /** The article that most recently began a validation run, or
   *  null before any run. A tracking field only; the marker
   *  handler routes each marker by its payload's `topicId`, not
   *  by this value. */
  activeArticleId: string | null;

  /** The topic that most recently began a validation run. A
   *  tracking field only. */
  activeTopicId: string | null;

  /** Whether a validation run is currently in flight for the
   *  topic passed to the hook. */
  isRunning: boolean;

  /** The live progress of the running operation for the topic, or
   *  null when none is running. */
  progress: ValidationProgress | null;

  /** The topic's last successfully-generated report, or null
   *  before the first one. */
  report: Report | null;

  /** The topic's async lifecycle state. See `ValidationStoreStatus`
   *  in `validationStore.ts` for the meaning of each value. */
  status: ValidationStoreStatus;

  /** The topic's last error message from an async action, or
   *  null. */
  error: string | null;

  // ---- Actions ----

  /** Start a validation operation for an article. Resolves with
   *  the created `Report` on success, or null on failure. The
   *  `topicId` argument identifies which per-topic slot the
   *  store updates — see the file header for the reasoning. */
  runValidation: (
    articleId: string,
    topicId: string
  ) => Promise<Report | null>;

  /** Re-run validation on an article. Same behavior as
   *  `runValidation` — see the file header for why the two names
   *  exist and when they will diverge. */
  revalidate: (
    articleId: string,
    topicId: string
  ) => Promise<Report | null>;

  /** Fetch the most recent report for an article from the
   *  backend without re-running the validators. Resolves with
   *  the fetched `Report`, or null when none exists or the fetch
   *  failed. The `topicId` argument identifies which per-topic
   *  slot the store caches the result in. */
  loadReport: (
    articleId: string,
    topicId: string
  ) => Promise<Report | null>;

  /** Set the topic's report directly, without a network round
   *  trip. Pass null to clear. */
  setReport: (topicId: string, report: Report | null) => void;

  /** Clear the topic's last error message. */
  clearError: (topicId: string) => void;

  /** Reset the store to its initial state. A store-wide operation,
   *  not a per-topic one; the root store's logout flow is the
   *  caller that uses it. */
  reset: () => void;
}

// ============================================================
//  The hook
// ============================================================

/**
 * Return the validation feature's state and its actions. See the
 * file header for the hook's role, its relationship to the store,
 * and the reasoning behind the design choices.
 */
export const useValidation = (topicId: string): ValidationHookValue => {
  // ---- Data subscriptions ----
  // One selector per data field, each keyed on the hook's
  // `topicId` argument. See the file header for why the fields
  // are read individually and why the keying matters.
  //
  // `activeArticleId` and `activeTopicId` are store-wide tracking
  // fields — the article and topic that most recently began a
  // validation run — so they are selected directly, not through
  // a per-topic record.
  //
  // The remaining five fields are per-topic records. Each raw
  // selector can return `undefined` when the topic has no entry
  // yet; the derived bindings below apply the store's documented
  // fallback values so the interface's non-optional fields always
  // carry a well-typed value.
  const activeArticleId = useValidationStore((s) => s.activeArticleId);
  const activeTopicId = useValidationStore((s) => s.activeTopicId);
  const isRunningRaw = useValidationStore(
    (s) => s.isRunningByTopic[topicId]
  );
  const progressRaw = useValidationStore(
    (s) => s.progressByTopic[topicId]
  );
  const reportRaw = useValidationStore(
    (s) => s.reportByTopic[topicId]
  );
  const statusRaw = useValidationStore(
    (s) => s.statusByTopic[topicId]
  );
  const errorRaw = useValidationStore(
    (s) => s.errorByTopic[topicId]
  );

  // ---- Derived fields ----
  // The `?? default` fallbacks mirror the store's own getters
  // (`getIsRunning`, `getProgress`, `getReport`, `getStatus`,
  // `getError`) so a caller reading through the hook sees the
  // same values a caller reading through `useValidationStore`
  // directly would see.
  const isRunning: boolean = isRunningRaw ?? false;
  const progress: ValidationProgress | null = progressRaw ?? null;
  const report: Report | null = reportRaw ?? null;
  const status: ValidationStoreStatus = statusRaw ?? 'idle';
  const error: string | null = errorRaw ?? null;

  // ---- Action subscriptions ----
  // Zustand actions are stable references for the life of the
  // store, so selecting them here does not cause re-renders.
  const storeRunValidation = useValidationStore((s) => s.runValidation);
  const loadReport = useValidationStore((s) => s.loadReport);
  const setReport = useValidationStore((s) => s.setReport);
  const clearError = useValidationStore((s) => s.clearError);
  const reset = useValidationStore((s) => s.reset);

  // ---- Adapters ----
  // The `runValidation` and `revalidate` adapters are thin
  // wrappers whose sole purpose is to give the two public action
  // names stable identities across renders. See the file
  // header's "Why two names for one action" section for the full
  // reasoning.
  const runValidation = useCallback(
    async (
      articleId: string,
      topicId: string
    ): Promise<Report | null> => {
      return storeRunValidation(articleId, topicId);
    },
    [storeRunValidation]
  );

  const revalidate = useCallback(
    async (
      articleId: string,
      topicId: string
    ): Promise<Report | null> => {
      return storeRunValidation(articleId, topicId);
    },
    [storeRunValidation]
  );

  // ---- Return ----
  // A single object literal with all fourteen members. The order
  // matches the interface above, so a reader comparing the two
  // does not have to hunt for a member's position.
  return {
    activeArticleId,
    activeTopicId,
    isRunning,
    progress,
    report,
    status,
    error,
    runValidation,
    revalidate,
    loadReport,
    setReport,
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
 * prefer the named form use `import { useValidation } from ...`;
 * consumers that prefer the default form use
 * `import useValidation from ...`. Both resolve to the same hook.
 */
export default useValidation;