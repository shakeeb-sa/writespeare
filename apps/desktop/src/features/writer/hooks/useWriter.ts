/**
 * useWriter — the renderer's writer hook.
 *
 * The single entry point through which the app's components read
 * and manipulate the writer feature's state. It sits over
 * `useWriterStore` and mirrors the role `useTopics`,
 * `useResearch`, and `useDocuments` play for their respective
 * features:
 *
 *   - The store owns the state. The hook does not add any.
 *
 *   - The store owns the async actions that reach the IPC layer
 *     and, through it, the main process. The hook does not
 *     reimplement them.
 *
 *   - The hook's only job is to give a component a single, stable
 *     object with everything the writer feature exposes — the
 *     data fields and the actions — under the names the plan's
 *     Part 1.11 table declares.
 *
 * ── The hook's signature ───────────────────────────────────────
 *
 *   `useWriter(topicId)` — the topic ID argument is required. The
 *   hook reads the topic's per-topic slots from the store via
 *   selectors keyed on that ID, so two components rendering
 *   different topics see independent state, and the same
 *   component re-renders only when its own topic's state changes.
 *
 * ── The hook's API ──────────────────────────────────────────────
 *
 *   Data fields (all read from the topic passed to `useWriter`):
 *
 *     activeTopicId   The topic that most recently began a
 *                     generation. A tracking field only; the
 *                     marker handler routes each marker by its
 *                     payload's `topicId`, not by this value.
 *     isGenerating    Whether a writer operation is in flight for
 *                     the topic.
 *     progress        The live progress of the running operation
 *                     for the topic, or null when none is
 *                     running.
 *     article         The last successfully-generated Article for
 *                     the topic, or null when none exists yet.
 *     status          The topic's async lifecycle state.
 *     error           The topic's last error message, or null.
 *
 *   Actions:
 *
 *     generate(topicId)     Start a writer operation. Resolves
 *                           with the created `Article` on
 *                           success, or null on failure.
 *
 *     regenerate(topicId)   Same as `generate`, under the name
 *                           the plan's Part 1.11 table uses.
 *                           See "Why two names for one action"
 *                           below.
 *
 *     cancel(topicId)       Cancel the running generation.
 *
 *     loadLatest(topicId)   Fetch the topic's latest article from
 *                           the backend, and cache it in the
 *                           topic's slot. Called by the topic-
 *                           detail page on first open of each
 *                           topic; subsequent calls for a topic
 *                           that already has a slot are no-ops.
 *
 *     setArticle(topicId, article)
 *                           Set the topic's article directly,
 *                           without a network round trip. Pass
 *                           null to clear.
 *
 *     clearError(topicId)   Clear the topic's last error.
 *
 *     reset()               Reset the store to its initial state.
 *
 * ── Why two names for one action ───────────────────────────────
 *
 *   The plan's Part 1.11 table declares the hook's actions as
 *   `generate()` and `regenerate()`. That is the specification
 *   this file must honor — a future reader who has the plan in
 *   hand and opens this hook should see the two names they
 *   expect.
 *
 *   Functionally, the two are identical today: both call the
 *   store's `generate` action with the same argument, and both
 *   produce the same result. The distinction the plan draws
 *   between them is semantic — "generate" for the first article
 *   on a topic, "regenerate" for a subsequent one — but the
 *   underlying operation is the same: run the writer and store
 *   the result. The store's `generate` action does not
 *   distinguish "first time" from "again" because the operation
 *   itself does not — a second run replaces the previous
 *   `article` field with the new one, exactly as the UI's
 *   "Regenerate" button should behave.
 *
 *   The plan's user journey (Stage 6) describes a future
 *   corrective loop where a regeneration passes specific
 *   validation failures back to the writer as extra prompt
 *   content. When that feature lands, `regenerate` will gain a
 *   second argument (the corrective feedback) and will call the
 *   store with it, while `generate` stays argument-free. Until
 *   then, both are aliases for the same store action.
 *
 *   The alternative — exposing only one name and asking the
 *   caller to know which one is "really" correct — would
 *   produce a hook that disagrees with the plan on its public
 *   surface, which is exactly the drift the plan warns against.
 *
 *   The `useCallback` wrappers around `generate` and `regenerate`
 *   are the one place this hook deviates from the "select the
 *   action directly" pattern the other hooks use. The reason is
 *   that the two names must have stable identities across
 *   renders — a component that puts `regenerate` in a
 *   `useEffect` dependency array expects it to be the same
 *   function from one render to the next. Wrapping the store's
 *   stable `generate` reference in a `useCallback` that depends
 *   only on that reference produces a wrapper with a stable
 *   identity across renders, which is what the caller needs.
 *
 *   The other actions (`cancel`, `setArticle`, `clearError`,
 *   `reset`) are exposed directly — they are already stable
 *   references from the store, and there is no second name for
 *   any of them.
 *
 * ── Why the hook subscribes per-field, per-topic ───────────────
 *
 *   Each data field is read through a selector that indexes into
 *   the per-topic record using the topic ID the hook received.
 *   Zustand re-renders a component when any of its selectors
 *   returns a different value, so a component reading topic A
 *   re-renders when A's state changes and does NOT re-render when
 *   topic B's state changes.
 *
 *   The alternative — subscribing to the entire per-topic record
 *   and reading the topic's slot inline — would re-render on
 *   every write to any topic, forcing every component to also
 *   pay the cost of a shallow-equality comparator. The per-field
 *   per-topic form gives the finest-grained re-render behavior
 *   Zustand supports.
 *
 * ── What this hook does NOT do ──────────────────────────────────
 *
 *   - It does not call `generate` on mount. The hook is a
 *     passive reader; the component that mounts it decides when
 *     to fire a generation. The `WriterProgress` panel's
 *     "Generate Article" button calls `generate(topic._id)` from
 *     a click handler, not from a mount effect.
 *
 *   - It does not guard against the "no session" case. The
 *     writer feature is authenticated-only; its components
 *     render inside the layout's auth gate, which does not
 *     mount its children until a session exists.
 *
 *   - It does not expose the store's internal `_handleMarker`
 *     action. That action is called by the module-load listener,
 *     never by a component. Exposing it would give a caller a
 *     way to inject a fake marker event into the store, which
 *     the current code has no reason to support.
 */

import { useCallback } from 'react';

import {
  useWriterStore,
  type WriterStoreStatus,
  type WriterProgress,
} from '../store/writerStore.js';
import type { Article } from '../../shared/types/index.js';

// ============================================================
//  Public types
// ============================================================

/**
 * The shape of the object returned by `useWriter()`.
 *
 * Exported so that a helper function that takes "an instance of
 * the writer hook" as a parameter can be typed against the
 * interface without redeclaring the shape. A component that
 * destructures the return value does not need to reference the
 * interface at all.
 */
export interface WriterHookValue {
  // ---- Data ----

  /** The topic that most recently began a generation, or null
   *  before any generation. A tracking field only. */
  activeTopicId: string | null;

  /** Whether a writer operation is currently in flight for the
   *  topic passed to `useWriter`. */
  isGenerating: boolean;

  /** The live progress of the running operation for the topic,
   *  or null when none is running. */
  progress: WriterProgress | null;

  /** The last successfully-generated article for the topic, or
   *  null when none exists yet. */
  article: Article | null;

  /** The topic's async lifecycle state. See `WriterStoreStatus`
   *  in `writerStore.ts` for the meaning of each value. */
  status: WriterStoreStatus;

  /** The topic's last error message from an async action, or
   *  null. */
  error: string | null;

  // ---- Actions ----

  /** Start a writer operation for a topic. Resolves with the
   *  created `Article` on success, or null on failure. */
  generate: (topicId: string) => Promise<Article | null>;

  /** Regenerate the article for a topic. Same behavior as
   *  `generate` — see the file header for why the two names
   *  exist and when they will diverge. */
  regenerate: (topicId: string) => Promise<Article | null>;

  /** Cancel the running generation for a topic. Resolves once
   *  the IPC call has returned. */
  cancel: (topicId: string) => Promise<void>;

  /** Load the topic's latest article from the backend. Resolves
   *  once the operation completes. The topic's `article` slot is
   *  populated (or set to null when the backend confirms no
   *  article exists). */
  loadLatest: (topicId: string) => Promise<void>;

  /** Set a topic's article directly, without a network round
   *  trip. Pass null to clear. */
  setArticle: (topicId: string, article: Article | null) => void;

  /** Clear a topic's last error message. */
  clearError: (topicId: string) => void;

  /** Reset the store to its initial state. */
  reset: () => void;
}

// ============================================================
//  The hook
// ============================================================

/**
 * Return the writer feature's state and its actions. See the
 * file header for the hook's role, its relationship to the store,
 * and the reasoning behind the design choices.
 */
export const useWriter = (topicId: string): WriterHookValue => {
  // ---- Data subscriptions ----
  // One selector per data field, each keyed by the topic ID the
  // hook received. See the file header for why the fields are
  // read individually and per-topic rather than as one object.
  //
  // The `?? default` fallback covers a topic that has no entry
  // in the record yet — the state a fresh session has for a
  // topic the user has not interacted with. The literal
  // defaults are the same values the store's getters return.
  const activeTopicId = useWriterStore((s) => s.activeTopicId);
  const isGenerating = useWriterStore(
    (s) => s.isGeneratingByTopic[topicId] ?? false
  );
  const progress = useWriterStore(
    (s) => s.progressByTopic[topicId] ?? null
  );
  const article = useWriterStore(
    (s) => s.articlesByTopic[topicId] ?? null
  );
  const status = useWriterStore(
    (s) => s.statusByTopic[topicId] ?? 'idle'
  );
  const error = useWriterStore(
    (s) => s.errorByTopic[topicId] ?? null
  );

  // ---- Action subscriptions ----
  // Zustand actions are stable references for the life of the
  // store, so selecting them here does not cause re-renders.
  const storeGenerate = useWriterStore((s) => s.generate);
  const cancel = useWriterStore((s) => s.cancel);
  const loadLatest = useWriterStore((s) => s.loadLatest);
  const setArticle = useWriterStore((s) => s.setArticle);
  const clearError = useWriterStore((s) => s.clearError);
  const reset = useWriterStore((s) => s.reset);

  // ---- Adapters ----
  // The `generate` adapter is a thin wrapper whose sole purpose
  // is to give the two public action names (`generate` and
  // `regenerate`) stable identities across renders. See the
  // file header's "Why two names for one action" section for
  // the full reasoning.
  const generate = useCallback(
    async (id: string): Promise<Article | null> => {
      return storeGenerate(id);
    },
    [storeGenerate]
  );

  const regenerate = useCallback(
    async (id: string): Promise<Article | null> => {
      return storeGenerate(id);
    },
    [storeGenerate]
  );

  // ---- Return ----
  // A single object literal with all thirteen members. The order
  // matches the interface above, so a reader comparing the two
  // does not have to hunt for a member's position.
  return {
    activeTopicId,
    isGenerating,
    progress,
    article,
    status,
    error,
    generate,
    regenerate,
    cancel,
    loadLatest,
    setArticle,
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
 * prefer the named form use `import { useWriter } from ...`;
 * consumers that prefer the default form use
 * `import useWriter from ...`. Both resolve to the same hook.
 */
export default useWriter;