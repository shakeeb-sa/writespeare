/**
 * WriteSpeare — topics hook.
 *
 * This is the renderer's single entry point for reading and
 * mutating the user's topics from a component. It is a thin
 * wrapper over `useTopicStore` (the Zustand store created in the
 * previous step), mirroring the shape and the role of `useAuth`
 * in the auth feature:
 *
 *   - The store owns the state. The hook does not add any.
 *
 *   - The store owns the async actions that reach the backend.
 *     The hook does not reimplement them or wrap them.
 *
 *   - The hook's only job is to give a component a single,
 *     stable object with everything the topics feature exposes —
 *     the four data fields and the seven actions. A component
 *     that wants the whole surface calls `useTopics()`; a
 *     component that wants one slice calls
 *     `useTopicStore((s) => s.topics)` directly, if it prefers.
 *
 * Why there is a hook at all, if the store's hook already
 * exposes everything:
 *
 *   Three reasons:
 *
 *     1. Interface stability. Components import from a single
 *        symbol (`useTopics`) whose surface is documented and
 *        typed as `TopicHookValue`. If the store's internal
 *        shape changes — a field is renamed, an action is
 *        composed differently — the hook's shape is what the
 *        consumers depend on, and the store can be refactored
 *        behind it.
 *
 *     2. Composition. The hook is the natural place for a
 *        future composition the store cannot provide — a
 *        derived value (the count of topics grouped by status),
 *        a memoized selector, a chain that calls two actions in
 *        sequence for a specific workflow. Today the hook is a
 *        straight re-export; tomorrow it may not be.
 *
 *     3. Naming symmetry. `useAuth` is the auth feature's
 *        hook. `useTopics` is the topics feature's hook.
 *        `useDocuments` will be the documents feature's hook.
 *        The convention is that every feature exposes a
 *        `use<Feature>` hook over its store, so a reader who
 *        has seen one feature can predict the shape of every
 *        other.
 *
 * Why the actions are selected directly from the store rather
 * than wrapped in `useCallback`:
 *
 *   Zustand's `create` runs its state creator exactly once per
 *   store instance, and the functions returned by that creator
 *   are the same references for the entire life of the store.
 *   That means the action references obtained from
 *   `useTopicStore((s) => s.loadTopics)` are already stable
 *   across renders — a `useCallback` wrapper around them would
 *   be redundant.
 *
 *   The auth hook (`useAuth.ts`) DID use `useCallback`, but for
 *   a different reason: its `login` and `logout` actions are
 *   composed functions defined inside the hook body, not
 *   references pulled straight from the store. Composed
 *   functions need `useCallback` to be stable. A straight
 *   reference does not.
 *
 *   If a future change makes one of these actions a composed
 *   function rather than a store reference, the correct fix at
 *   that point is to add `useCallback` (with the appropriate
 *   dependencies) around the composed version. Until then, the
 *   direct selection is both simpler and correct.
 *
 * Why the hook subscribes to each data field separately:
 *
 *   Zustand re-renders a component when any of the values it
 *   has selected from the store change. By subscribing to each
 *   of the four data fields through its own selector, the hook
 *   gets the finest-grained re-render behaviour that Zustand
 *   supports for a multi-field read: a change to `topics` does
 *   not re-render a component whose only visible effect was
 *   `status`, because that component's `status` selection did
 *   not change.
 *
 *   The alternative — a single `useTopicStore((s) => s)` call —
 *   would re-render on every store change and would require a
 *   shallow-equality check to avoid wasted renders. The
 *   per-field form is the recommended Zustand pattern and the
 *   one this hook follows.
 *
 * What this hook does NOT do:
 *
 *   - It does not call `loadTopics` on mount. The hook is a
 *     passive reader; the component that mounts it decides when
 *     to fetch. The Topics page calls `loadTopics()` in its own
 *     `useEffect`; the Topic Detail page calls `loadTopic(id)`
 *     in its own `useEffect`. Centralizing the fetch in the
 *     hook would fire it from every component that ever calls
 *     `useTopics()`, including ones that only want to read the
 *     error state or invoke `duplicateTopic`.
 *
 *   - It does not guard against the "no session" case. The
 *     topics feature is authenticated-only; its pages render
 *     inside the layout's auth gate, which does not mount its
 *     children until a session exists. The hook trusts that
 *     invariant — the same way the store does.
 *
 *   - It does not expose the raw `set` from Zustand. Components
 *     that need to mutate state go through the store's named
 *     actions, which are the ones that carry the correct
 *     semantics (clear the error, flip status, update the list).
 */

import {
  useTopicStore,
  type TopicStoreStatus,
} from '../store/topicStore.js';
import type {
  Topic,
  TopicCreatePayload,
  TopicStatus,
} from '../../shared/types/index.js';

// ============================================================
//  Public types
// ============================================================

/**
 * The shape of the object returned by `useTopics()`.
 *
 * The interface is exported so that a helper function that takes
 * "an instance of the topics hook" as a parameter can be typed
 * against the interface without redeclaring the shape. A
 * component that destructures the return value does not need to
 * reference the interface at all.
 *
 * The interface mirrors `TopicStoreState`'s members one-to-one
 * with two differences: it omits nothing, and it adds no members.
 * The hook is a straight exposure of the store's public surface.
 * The only reason it is a distinct type is so that a consumer
 * can name the shape — `TopicStoreState` is the store's
 * interface, and a component should be able to refer to what it
 * receives from the hook by a type that matches the hook's own
 * name.
 */
export interface TopicHookValue {
  // ---- Data ----

  /** The list of topics for the current user, sorted newest
   *  first by the backend. */
  topics: Topic[];

  /** The topic currently being viewed on the detail page, or
   *  null if no detail page is open. */
  activeTopic: Topic | null;

  /** The store's async lifecycle state. See `topicStore.ts` for
   *  the meaning of the three values. */
  status: TopicStoreStatus;

  /** The last error message from an async action, or null. */
  error: string | null;

  // ---- Actions ----

  /** Load the topics list, optionally filtered by pipeline
   *  status. Resolves when the load completes (success or
   *  failure). The store's `status` and `error` fields reflect
   *  the outcome. */
  loadTopics: (statusFilter?: TopicStatus) => Promise<void>;

  /** Load a single topic into `activeTopic`. Resolves when the
   *  load completes. */
  loadTopic: (topicId: string) => Promise<void>;

  /** Create a new topic. Resolves with the created topic, or
   *  null on failure. */
  createTopic: (payload: TopicCreatePayload) => Promise<Topic | null>;

  /** Delete a topic. Resolves with `true` on success, `false` on
   *  failure. */
  deleteTopic: (topicId: string) => Promise<boolean>;

  /** Create a copy of the given topic. Resolves with the created
   *  topic, or null on failure. */
  duplicateTopic: (topic: Topic) => Promise<Topic | null>;

  /** Set the active topic directly, without a network call. */
  setActiveTopic: (topic: Topic | null) => void;

  /** Reset the store to its initial state. */
  clear: () => void;
}

// ============================================================
//  The hook
// ============================================================

/**
 * Return the topics feature's state and its actions. See the
 * file header for the hook's role, its relationship to the
 * store, and the reasoning behind the design choices.
 */
export const useTopics = (): TopicHookValue => {
  // ---- Data subscriptions ----
  // One selector per data field. See the file header for why the
  // fields are read individually rather than as one object.
  const topics = useTopicStore((s) => s.topics);
  const activeTopic = useTopicStore((s) => s.activeTopic);
  const status = useTopicStore((s) => s.status);
  const error = useTopicStore((s) => s.error);

  // ---- Action subscriptions ----
  // Zustand actions are stable references for the life of the
  // store, so selecting them here does not cause re-renders and
  // does not require `useCallback` around them. See the file
  // header for the reasoning.
  const loadTopics = useTopicStore((s) => s.loadTopics);
  const loadTopic = useTopicStore((s) => s.loadTopic);
  const createTopic = useTopicStore((s) => s.createTopic);
  const deleteTopic = useTopicStore((s) => s.deleteTopic);
  const duplicateTopic = useTopicStore((s) => s.duplicateTopic);
  const setActiveTopic = useTopicStore((s) => s.setActiveTopic);
  const clear = useTopicStore((s) => s.clear);

  // ---- Return ----
  // A single object literal with all eleven members. The order
  // matches the interface above, so a reader comparing the two
  // does not have to hunt for a member's position.
  return {
    topics,
    activeTopic,
    status,
    error,
    loadTopics,
    loadTopic,
    createTopic,
    deleteTopic,
    duplicateTopic,
    setActiveTopic,
    clear,
  };
};

// ============================================================
//  Default export
// ============================================================

/**
 * The hook as the default export, matching the convention used
 * by every other hook and store in the codebase. Consumers that
 * prefer the named form use `import { useTopics } from ...`;
 * consumers that prefer the default form use
 * `import useTopics from ...`. Both resolve to the same hook.
 */
export default useTopics;