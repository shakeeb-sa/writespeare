/**
 * WriteSpeare — topics store.
 *
 * This is the renderer's in-memory record of the user's topics —
 * the list shown on the Topics home page, the active topic shown
 * on the Topic Detail page, and the transient loading/error state
 * that both pages render around their content.
 *
 * The store is populated by the two async load actions
 * (`loadTopics`, `loadTopic`) that the `useTopics` hook calls on
 * mount, and mutated by three further async actions
 * (`createTopic`, `deleteTopic`, `duplicateTopic`) that the topics
 * feature's UI invokes directly through the hook. Every async
 * action ultimately reaches the backend through
 * `window.electronAPI.topics.*`, which the preload installs and
 * which resolves to the main process's IPC handlers (see
 * `ipc/topicsIPC.ts`, item #55 of Session 7).
 *
 * Why the store's actions do IPC rather than the hook:
 *
 *   The plan's file-tree description of this module names three
 *   actions — `createTopic`, `deleteTopic`, `duplicateTopic` — as
 *   members of the store. That naming is read here literally: the
 *   store exposes these operations as callable actions, and a
 *   caller who invokes `useTopicStore.getState().createTopic(…)`
 *   gets the full operation — the IPC round-trip, the state
 *   update, and the error capture.
 *
 *   The alternative — putting the IPC calls in the `useTopics`
 *   hook and limiting the store to pure state mutations — would
 *   contradict the plan's explicit "Actions:" list. It would also
 *   split each topic mutation across two files: the hook would
 *   own the IPC call, the store would own the state update, and
 *   the two would have to agree on a narrow interface between
 *   them. Keeping the operation co-located with the state it
 *   mutates means there is one place to look for "what happens
 *   when a topic is created".
 *
 * Why the store is not persisted:
 *
 *   The topics list is server-authoritative. It is owned by the
 *   backend's `Topic` collection, and its contents change whenever
 *   another device the user owns (a second workstation, a mobile
 *   client that a future session might add) creates or deletes a
 *   topic. Caching the list across app restarts would let the
 *   renderer show stale data — a topic that was deleted from
 *   another device would still appear until the next refresh, and
 *   a topic that was added from another device would be absent
 *   until the next refresh.
 *
 *   The auth store (see `auth/store/userStore.ts`) IS persisted,
 *   because the user's identity and token are stable across
 *   restarts and the renderer needs them to render the
 *   authenticated shell before the first network round-trip.
 *   Topics are different — the user's expectation when they open
 *   the app is to see the current state of their topics, not a
 *   cached snapshot. The store therefore does not use Zustand's
 *   `persist` middleware.
 *
 * The `status` field — why the store has one:
 *
 *   The plan names `status` as a data field of this store,
 *   alongside `topics` and `activeTopic`. Its role is to reflect
 *   whether the store is currently performing an async operation,
 *   so that a page can render a spinner (during `loading`), a
 *   message (during `error`), or the content (during `idle`)
 *   without having to track its own per-operation loading flag.
 *
 *   The three states are:
 *
 *     'idle'    — no operation is in progress, and the last one
 *                 (if any) succeeded. The default state.
 *
 *     'loading' — an async operation is in flight. Set by every
 *                 async action at its start; the corresponding
 *                 success or failure path sets it back to
 *                 'idle' or 'error'.
 *
 *     'error'   — the last async operation failed. The `error`
 *                 field carries a user-facing message. The next
 *                 async action to start resets both fields.
 *
 *   The field is deliberately NOT called `isLoading`. A single
 *   boolean would not distinguish "the store is idle" from "the
 *   store is in an error state that has not yet been cleared" —
 *   both would read as `false` and the page would have to consult
 *   the `error` field separately to tell them apart. The
 *   three-valued status collapses the two checks into one.
 *
 *   Note that `status` here is the STORE's status, not a Topic's
 *   pipeline status. The two share a name but not a domain — the
 *   `Topic` type itself has a `status: TopicStatus` field whose
 *   value is one of the eight pipeline states. The store's
 *   `status` is a page-lifecycle signal. The two live on
 *   different objects and never collide.
 *
 * Why `duplicateTopic` takes a full `Topic` rather than an id:
 *
 *   The caller of `duplicateTopic` is always a component that is
 *   rendering a specific topic — a card in the list, a header on
 *   the detail page. The topic object is already in the caller's
 *   hands. Accepting the full object avoids a second lookup (the
 *   store would have to find it in `topics[]`) and avoids a
 *   network call in the case where the topic is not in the list
 *   (for example, if the detail page loaded it directly via
 *   `loadTopic` without the list being populated).
 *
 *   The alternative signature — `duplicateTopic(topicId: string)`
 *   — would look cleaner in isolation but would force the store to
 *   either assume the topic is in the list (fragile) or fetch it
 *   from the backend (slow, and duplicates information the caller
 *   already has). The full-object signature is the honest one for
 *   the actual call site.
 *
 * The title suffix:
 *
 *   `duplicateTopic` appends `" (copy)"` to the original topic's
 *   title. The plan does not specify a suffix — it says only that
 *   duplicate makes "a copy and start a new variant from the same
 *   research." The suffix is a small, conventional choice: it
 *   makes the duplicate visually distinguishable from its source
 *   in the topics list, and it signals to the user that the two
 *   topics are related. A user who wants a different title edits
 *   the duplicate after creating it — the same flow they would use
 *   for any other topic.
 *
 * What this store does NOT do:
 *
 *   - It does not run the research, extraction, or writer steps.
 *     Those are separate operations driven by the pipeline's
 *     later stages and by separate stores (`researchStore`,
 *     `writerStore`, `validationStore`). The topics store is
 *     concerned only with the topic's metadata, not with its
 *     pipeline state machine.
 *
 *   - It does not cascade deletes to the topic's child records
 *     (documents, articles, reports). The backend does not cascade
 *     either, and the renderer's job is to reflect the backend's
 *     behaviour, not to invent a cascade. A future cleanup
 *     migration — or a future explicit cascade endpoint on the
 *     backend — would be the correct place for that logic.
 *
 *   - It does not implement an `updateTopic` action. The plan
 *     names three actions for this store, and update is not among
 *     them. The renderer's topic-editing flows (if any) are
 *     covered by the backend's PATCH endpoint and by the API
 *     layer's `updateTopic` function (File 27), but the store
 *     does not expose it as an action. A future session that
 *     needs topic editing in the UI adds the action here.
 */

import { create } from 'zustand';

import type {
  Topic,
  TopicCreatePayload,
  TopicStatus,
} from '../../shared/types/index.js';

// ============================================================
//  Public types
// ============================================================

/**
 * The three-value lifecycle of the store's async activity. See
 * the file header for what each value means.
 */
export type TopicStoreStatus = 'idle' | 'loading' | 'error';

/**
 * The full shape of the topics store's state, including both the
 * data fields and the actions. Exported so that a consumer that
 * wants to type a parameter or a helper function can reference
 * the shape without redeclaring it.
 */
export interface TopicStoreState {
  // ---- Data ----

  /** The topics visible on the home page, in the order the
   *  backend returned them (newest first). */
  topics: Topic[];

  /** The topic currently being viewed on the detail page, or
   *  null if no detail page is open. */
  activeTopic: Topic | null;

  /** The store's async lifecycle state. See the file header. */
  status: TopicStoreStatus;

  /** The last error message from an async action, or null. */
  error: string | null;

  // ---- Async actions ----

  /**
   * Load the topics list. Called by `useTopics` on the Topics
   * page's mount, and by any component that wants to refresh the
   * list after an external change.
   *
   * @param statusFilter - Optional pipeline-state filter,
   *                        matching the backend's `?status=`
   *                        query parameter.
   */
  loadTopics: (statusFilter?: TopicStatus) => Promise<void>;

  /**
   * Load a single topic into `activeTopic`. Called by
   * `useTopics` on the Topic Detail page's mount.
   *
   * @param topicId - The topic's id.
   */
  loadTopic: (topicId: string) => Promise<void>;

  /**
   * Create a new topic. On success, the new topic is prepended
   * to the `topics` list (matching the backend's newest-first
   * sort) and set as the `activeTopic`, so the caller can
   * immediately navigate to the detail page.
   *
   * @returns The created topic on success, or null on failure.
   *          The caller can use the return value to decide
   *          whether to navigate.
   */
  createTopic: (payload: TopicCreatePayload) => Promise<Topic | null>;

  /**
   * Delete a topic. On success, the topic is removed from the
   * `topics` list, and `activeTopic` is cleared if it was the
   * topic being deleted.
   *
   * @returns `true` on success, `false` on failure.
   */
  deleteTopic: (topicId: string) => Promise<boolean>;

  /**
   * Create a copy of the given topic, with " (copy)" appended to
   * the title and every other configuration field preserved. On
   * success, the new topic is prepended to the `topics` list and
   * set as the `activeTopic`.
   *
   * @returns The created topic on success, or null on failure.
   */
  duplicateTopic: (topic: Topic) => Promise<Topic | null>;

  // ---- Sync setters ----

  /**
   * Set the active topic directly, without a network call. Used
   * by the Topics page when it wants to hand off a topic it
   * already has in memory to the detail page — avoids a
   * redundant `loadTopic` round-trip on navigation.
   */
  setActiveTopic: (topic: Topic | null) => void;

  /**
   * Reset the store to its initial state. Called by the root
   * store's `reset` action during logout.
   */
  clear: () => void;
}

// ============================================================
//  Initial state
// ============================================================

/**
 * The store's initial data fields. Extracted as a constant so
 * that the `clear` action can reference the same values without
 * duplicating them.
 */
const INITIAL_STATE = {
  topics: [] as Topic[],
  activeTopic: null as Topic | null,
  status: 'idle' as TopicStoreStatus,
  error: null as string | null,
};

// ============================================================
//  Store
// ============================================================

/**
 * The topics store.
 *
 * Created without any middleware — see the file header for why
 * the store is not persisted. The state creator receives only
 * `set` and `get`: `set` for the synchronous updates, `get` for
 * the one action (`duplicateTopic`) that needs to call another
 * action (`createTopic`) on the same store.
 */
export const useTopicStore = create<TopicStoreState>((set, get) => ({
  // ---- Initial data ----
  ...INITIAL_STATE,

  // ============================================================
  //  Async actions
  // ============================================================

  loadTopics: async (statusFilter) => {
    // Flip the status to loading and clear any previous error.
    // The error clear is deliberate — a page that was showing an
    // error from the previous load attempt should not still show
    // it while a new attempt is in flight.
    set({ status: 'loading', error: null });

    try {
      const result = await window.electronAPI.topics.list(statusFilter);

      if (result.success && result.data) {
        set({ topics: result.data, status: 'idle' });
      } else {
        set({
          status: 'error',
          error: result.error ?? 'Failed to load topics.',
        });
      }
    } catch (err) {
      // The `window.electronAPI.topics.list` call itself can
      // reject if the IPC channel is unregistered — for example,
      // during the window between the app's startup and the
      // `registerTopicsIPC()` call in the main process. The
      // catch converts that rejection into the same error state
      // the response-envelope failure path produces, so the
      // page's render logic does not need two cases.
      console.error('[topicStore] loadTopics failed:', err);
      set({ status: 'error', error: 'Unable to load topics.' });
    }
  },

  loadTopic: async (topicId) => {
    set({ status: 'loading', error: null });

    try {
      const result = await window.electronAPI.topics.get(topicId);

      if (result.success && result.data) {
        set({ activeTopic: result.data, status: 'idle' });
      } else {
        set({
          status: 'error',
          error: result.error ?? 'Topic not found.',
        });
      }
    } catch (err) {
      console.error('[topicStore] loadTopic failed:', err);
      set({ status: 'error', error: 'Unable to load topic.' });
    }
  },

  createTopic: async (payload) => {
    set({ status: 'loading', error: null });

    try {
      const result = await window.electronAPI.topics.create(payload);

      if (result.success && result.data) {
        const created = result.data;
        // Prepend to the list — the backend sorts newest first,
        // so a newly-created topic belongs at the top. Setting
        // `activeTopic` here means a caller that navigates to
        // the detail page right after creation finds the topic
        // already loaded.
        set((state) => ({
          topics: [created, ...state.topics],
          activeTopic: created,
          status: 'idle',
        }));
        return created;
      }

      set({
        status: 'error',
        error: result.error ?? 'Failed to create topic.',
      });
      return null;
    } catch (err) {
      console.error('[topicStore] createTopic failed:', err);
      set({ status: 'error', error: 'Unable to create topic.' });
      return null;
    }
  },

  deleteTopic: async (topicId) => {
    // Unlike the load and create actions, `deleteTopic` does not
    // flip `status` to `loading`. The reason is that a delete is
    // usually initiated from a row in the topics list, and the
    // list should stay visible during the operation — a full
    // page-level loading state would replace the list with a
    // spinner, which is more disruptive than the operation
    // warrants. The caller is responsible for showing a
    // row-level spinner or disabled state.
    try {
      const result = await window.electronAPI.topics.remove(topicId);

      if (result.success) {
        set((state) => ({
          topics: state.topics.filter((t) => t._id !== topicId),
          // Clear the active topic if it was the one being
          // deleted — otherwise the detail page would keep
          // showing a topic that no longer exists on the
          // backend.
          activeTopic:
            state.activeTopic !== null &&
            state.activeTopic._id === topicId
              ? null
              : state.activeTopic,
        }));
        return true;
      }

      set({ error: result.error ?? 'Failed to delete topic.' });
      return false;
    } catch (err) {
      console.error('[topicStore] deleteTopic failed:', err);
      set({ error: 'Unable to delete topic.' });
      return false;
    }
  },

  duplicateTopic: async (topic) => {
    // Build the create payload from the original's configuration
    // fields. The id, userId, timestamps, status, and error are
    // deliberately omitted — the backend assigns a new id, the
    // authenticated session provides the userId, Mongoose
    // supplies the timestamps, and the new topic starts its
    // lifecycle at the schema's default status. The keywords
    // array is copied (spread) rather than shared by reference so
    // that mutating the duplicate's keywords cannot accidentally
    // affect the original.
    const payload: TopicCreatePayload = {
      title: `${topic.title} (copy)`,
      keywords: [...topic.keywords],
      preset: topic.preset,
      profile: topic.profile,
      promptFile: topic.promptFile,
      wordCount: topic.wordCount,
      sourceCount: topic.sourceCount,
    };

    // Delegate to `createTopic` rather than reimplementing the
    // IPC call and the state update. The two actions share the
    // entire create-topic behavior — the only difference is how
    // the payload is built.
    return get().createTopic(payload);
  },

  // ============================================================
  //  Sync setters
  // ============================================================

  setActiveTopic: (topic) => {
    set({ activeTopic: topic });
  },

  clear: () => {
    set({
      topics: [],
      activeTopic: null,
      status: 'idle',
      error: null,
    });
  },
}));

// ============================================================
//  Default export
// ============================================================

/**
 * The hook as the default export, matching the convention used
 * by every other store in the codebase. Consumers that prefer
 * the named form use `import { useTopicStore } from ...`;
 * consumers that prefer the default form use
 * `import useTopicStore from ...`. Both resolve to the same
 * hook.
 */
export default useTopicStore;