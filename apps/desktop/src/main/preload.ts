/**
 * Electron preload script for the WriteSpeare desktop app.
 *
 * This file runs in a special context that Electron creates
 * between the main process and each renderer — it has access to
 * the full `ipcRenderer` API but is not visible to the page's own
 * JavaScript except through the objects the script explicitly
 * exposes on `window`. That isolation is the whole point of the
 * preload: it is the only sanctioned bridge between the sandboxed
 * renderer and the capabilities of the Node/Electron environment.
 *
 * The app's golden rule is that the renderer never touches Node
 * or Python directly — everything goes through
 * `window.electronAPI.*`. This file is where that API is defined.
 * Every method on every namespace ultimately calls
 * `ipcRenderer.invoke(channel, ...args)` and awaits the main
 * process's response. The main process registers a handler for
 * each channel via `ipcMain.handle(...)`; the channels are named
 * `namespace:action` and the namespaces here mirror the feature
 * folders under `src/features/` one-for-one.
 *
 * Why the API is typed as `Promise<ApiResponse<T>>`:
 *
 *   The backend's HTTP API and the main process's IPC handlers
 *   both follow the same envelope convention — `{ success,
 *   data?, error? }` — so a caller cannot accidentally treat a
 *   failed operation as a success by checking only for the
 *   presence of `data`. The preload preserves that envelope as
 *   the return type of every `invoke` method, so the renderer's
 *   service layer (`shared/api/client.ts` and the feature-level
 *   `services/*.ts` files) can unwrap it once and return plain
 *   data up the chain. Making the envelope visible at this layer
 *   is what keeps the error-handling contract consistent from
 *   the HTTP boundary all the way to the renderer's stores.
 *
 * The `on` / `off` / `once` registry — why the wrappers:
 *
 *   `ipcRenderer.on(channel, listener)` registers a listener that
 *   receives an `IpcRendererEvent` as its first argument. The
 *   renderer's own callbacks do not want the event object; they
 *   want only the payload the main process sent. The three
 *   wrappers below strip the event and pass the remaining
 *   arguments through, so the renderer sees a callback signature
 *   of `(...args: unknown[]) => void`.
 *
 *   `off` cannot simply call `ipcRenderer.removeListener(channel,
 *   callback)` because `callback` is the renderer's original
 *   function, not the wrapped function that was actually
 *   registered. Without the wrapper, `removeListener` would be
 *   passed a function that was never added to the emitter and the
 *   removal would silently fail — the listener would keep firing
 *   forever. The registry below remembers the wrapped function
 *   for each `(channel, callback)` pair, so `off` can look up the
 *   correct reference and remove it.
 *
 *   `once` uses Electron's own `once` — it removes itself after
 *   the first invocation, so no registry entry is needed.
 *
 * Forward references:
 *
 *   The `../features/shared/types/index.js` module does not yet
 *   exist on disk (it is created in Session 5 of the plan). All
 *   the type imports from it are `import type`, which TypeScript
 *   erases at emit time — the compiled JavaScript never contains
 *   a `require` for that module. As a consequence, the file will
 *   run correctly at runtime even before Session 5 completes;
 *   only the `npm run type-check` pass will complain until the
 *   types file is in place.
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

import type {
  ApiResponse,
  AppVersion,
  Article,
  Document,
  LoginRequest,
  LoginResponse,
  Preset,
  PresetCreatePayload,
  PresetName,
  ProfileName,
  Report,
  Topic,
  TopicCreatePayload,
  TopicStatus,
  TopicUpdatePayload,
  User,
  UserRole,
  UserSetting,
  UserSettingsMap,
} from '../features/shared/types/index.js';

// ============================================================
//  Type definitions
// ============================================================
//
//  The interface below is the single source of truth for the
//  shape of `window.electronAPI`. Every method's signature —
//  argument types and return type — is declared here rather than
//  inferred from the implementation, so the renderer's `Window`
//  augmentation (bottom of this file) can reference it without
//  duplicating any type information. If a method's runtime
//  implementation ever drifted from its signature, the compiler
//  would flag the mismatch at the point of assignment.

/**
 * A listener callback registered through `on`, `off`, or `once`.
 *
 * The parameter type is `unknown[]` rather than a typed payload
 * because the events flowing main→renderer carry different
 * payload shapes per channel (a string for a status update, a
 * number for progress, an object for a candidate list). The
 * renderer's listener is expected to narrow the arguments it
 * receives using a runtime check before using them, since the
 * event source is out of TypeScript's reach. The same trade-off
 * applies at the HTTP boundary, where responses are also
 * untyped until the client narrows them.
 */
type IpcListener = (...args: unknown[]) => void;

/**
 * The auth namespace — login, logout, and reading the cached
 * user profile.
 */
interface AuthNamespace {
  /**
   * Exchange credentials for a bearer token and a user object.
   * On success the main process also persists both to the
   * encrypted store, so a subsequent cold start can restore the
   * session before the network round trip completes.
   */
  login: (
    credentials: LoginRequest
  ) => Promise<ApiResponse<LoginResponse>>;

  /**
   * Clear the session on the main process side — delete the
   * stored token and the cached user from the encrypted store.
   * The backend has no logout endpoint; sessions are stateless
   * JWTs, and revoking one requires either waiting for its `exp`
   * or rotating the signing secret.
   */
  logout: () => Promise<ApiResponse<null>>;

  /**
   * Read the currently cached user, or null if no session exists.
   * Used by the renderer's cold-start sequence to populate the
   * auth store before any network request is made.
   */
  getUser: () => Promise<ApiResponse<User | null>>;
}

/**
 * The config namespace — read-only access to the desktop app's
 * own configuration: which backend URL it points at, which
 * version is running, and which platform it is on.
 *
 * Nothing in this namespace writes to the config; the settings
 * the user can change live under the `settings` namespace. The
 * config here is the app's own boot-time state, established
 * before any user is signed in and not editable from the UI.
 */
interface ConfigNamespace {
  /** The backend base URL the app is currently pointed at. */
  getApiBaseUrl: () => Promise<ApiResponse<string>>;

  /** The desktop app's own version, as declared in package.json. */
  getAppVersion: () => Promise<ApiResponse<string>>;

  /** The OS platform — 'win32', 'darwin', or 'linux'. */
  getPlatform: () => Promise<ApiResponse<string>>;
}

/**
 * The topics namespace — CRUD over the user's topics.
 *
 * Mirrors the backend's `/api/topics` surface one-for-one. The
 * main-process IPC handlers translate each call into an HTTP
 * request against the backend, so the renderer never needs to
 * know the backend's URL or authentication mechanism — that
 * lives entirely on the main-process side.
 */
interface TopicsNamespace {
  list: (
    status?: TopicStatus
  ) => Promise<ApiResponse<Topic[]>>;
  create: (
    payload: TopicCreatePayload
  ) => Promise<ApiResponse<Topic>>;
  get: (topicId: string) => Promise<ApiResponse<Topic>>;
  update: (
    topicId: string,
    patch: TopicUpdatePayload
  ) => Promise<ApiResponse<Topic>>;
  remove: (topicId: string) => Promise<ApiResponse<Topic>>;
}

/**
 * The research namespace — search and extraction, both of which
 * drive Python child processes on the main-process side. The
 * renderer sees only the async results; the process management,
 * the Chrome window, and the marker parsing live entirely in the
 * main process.
 */
interface ResearchNamespace {
  /**
   * Run the search step for a topic. Resolves once the search
   * has finished and returns the candidate URLs it found. Live
   * progress arrives through the `research:progress` event, not
   * through this promise.
   */
  search: (
    topicId: string,
    title: string,
    keywords?: string[]
  ) => Promise<ApiResponse<{ candidates: string[] }>>;

  /**
   * Fetch and extract the selected candidate URLs. Resolves
   * once every extraction has completed (or failed) and returns
   * the list of documents saved. Live progress arrives through
   * `research:progress`.
   */
  extract: (
    topicId: string,
    urls: string[]
  ) => Promise<ApiResponse<{ savedCount: number }>>;

  /**
   * Cancel any in-flight search or extraction for the topic.
   * Kills the associated Python child process (if one is
   * running) and removes the topic from the automation store's
   * active-task list.
   */
  cancel: (topicId: string) => Promise<ApiResponse<null>>;
}

/**
 * The documents namespace — read the extracted documents
 * attached to a topic. The documents themselves are `.md` files
 * on disk; the main process reads them on the renderer's behalf.
 */
interface DocumentsNamespace {
  list: (topicId: string) => Promise<ApiResponse<Document[]>>;
  read: (path: string) => Promise<ApiResponse<{ content: string }>>;
  remove: (path: string) => Promise<ApiResponse<null>>;
}

/**
 * The writer namespace — the DeepSeek automation step.
 */
interface WriterNamespace {
  /**
   * Kick off a generate-the-article run for the topic. Resolves
   * once the writer process has finished and the article has
   * been persisted. Live progress arrives through
   * `writer:progress`.
   */
  generate: (
    topicId: string
  ) => Promise<ApiResponse<Article>>;

  /** Cancel any in-flight writer run for the topic. */
  cancel: (topicId: string) => Promise<ApiResponse<null>>;
}

/**
 * The validation namespace — run the six-validator suite against
 * an article and read the resulting report.
 */
interface ValidationNamespace {
  run: (articleId: string) => Promise<ApiResponse<Report>>;
  report: (articleId: string) => Promise<ApiResponse<Report>>;
}

/**
 * The export namespace — write the article to disk in one of the
 * supported formats.
 *
 * Each method opens a native Save-As dialog on the main-process
 * side and calls the corresponding Python export script. The
 * resolved value is the path the user chose, or `null` if they
 * cancelled the dialog.
 */
interface ExportNamespace {
  docx: (articleId: string) => Promise<ApiResponse<string | null>>;
  md: (articleId: string) => Promise<ApiResponse<string | null>>;
  txt: (articleId: string) => Promise<ApiResponse<string | null>>;
}

/**
 * The settings namespace — the user's app-level preferences,
 * which are cached on the main process side and mirrored to the
 * backend's UserSetting document.
 */
interface SettingsNamespace {
  /**
   * Read the current settings. If none have ever been saved,
   * the main process returns the schema's defaults, so this
   * method never returns null in practice.
   */
  get: () => Promise<ApiResponse<UserSettingsMap>>;

  /**
   * Save a partial update to the settings. Fields omitted from
   * the patch are left unchanged on both the local cache and the
   * backend.
   */
  save: (
    patch: Partial<UserSettingsMap>
  ) => Promise<ApiResponse<UserSettingsMap>>;

  /**
   * Ask the update service to check whether a newer desktop
   * build exists. Returns the latest version, or null if the
   * app is up to date.
   */
  checkUpdates: () => Promise<ApiResponse<AppVersion | null>>;
}

/**
 * The admin namespace — user management, available only to
 * callers whose cached user has `role === 'admin'`.
 */
interface AdminNamespace {
  listUsers: () => Promise<ApiResponse<User[]>>;
  createUser: (payload: {
    email: string;
    password: string;
    role?: UserRole;
    active?: boolean;
  }) => Promise<ApiResponse<User>>;
  updateUser: (
    userId: string,
    patch: {
      email?: string;
      password?: string;
      role?: UserRole;
      active?: boolean;
    }
  ) => Promise<ApiResponse<User>>;
  deleteUser: (userId: string) => Promise<ApiResponse<User>>;
}

/**
 * The utils namespace — small capabilities that do not belong to
 * a feature but that the renderer needs occasionally. Every one
 * of them maps to an Electron API that is only reachable from
 * the main process.
 */
interface UtilsNamespace {
  /** Open a URL in the user's default browser. */
  openExternal: (url: string) => Promise<ApiResponse<null>>;
  /** Show the given path in the OS's file browser, highlighting the file. */
  showItemInFolder: (path: string) => Promise<ApiResponse<null>>;
}

/**
 * The window namespace — operations on the app's own window,
 * used by the automation layer when a task needs to draw the
 * user's attention.
 */
interface WindowNamespace {
  /** Flash the taskbar icon / bounce the dock icon to notify the user. */
  notify: () => Promise<ApiResponse<null>>;
}

/**
 * The full API surface exposed on `window.electronAPI`.
 *
 * Adding a namespace here without a corresponding runtime
 * implementation would be caught by the compiler at the point
 * where the runtime object is assigned to this interface — the
 * same guarantee that every other typed object in the codebase
 * benefits from.
 */
export interface ElectronAPI {
  auth: AuthNamespace;
  config: ConfigNamespace;
  topics: TopicsNamespace;
  research: ResearchNamespace;
  documents: DocumentsNamespace;
  writer: WriterNamespace;
  validation: ValidationNamespace;
  export: ExportNamespace;
  settings: SettingsNamespace;
  admin: AdminNamespace;
  utils: UtilsNamespace;
  window: WindowNamespace;

  /**
   * Register a persistent listener for a main→renderer event.
   *
   * The `off` counterpart must be called with the same
   * `(channel, callback)` pair when the listener is no longer
   * needed; the registry below uses the pair as a key to look
   * up the wrapped function that was actually registered.
   */
  on: (channel: string, callback: IpcListener) => void;

  /** Remove a listener that was previously registered via `on`. */
  off: (channel: string, callback: IpcListener) => void;

  /** Register a one-shot listener that fires at most once. */
  once: (channel: string, callback: IpcListener) => void;
}

// ============================================================
//  Event listener registry
// ============================================================
//
//  See the file header for why this exists. The map is keyed by
//  channel, then by the renderer's original callback, and its
//  values are the wrapped functions that were actually registered
//  with `ipcRenderer.on`. This lets `off` find and remove the
//  correct reference.

const listenerRegistry = new Map<
  string,
  Map<IpcListener, (event: IpcRendererEvent, ...args: unknown[]) => void>
>();

/**
 * Register a listener and remember the wrapped function so
 * `off` can remove it later. The wrapped function is what
 * `ipcRenderer` actually calls; it discards the `IpcRendererEvent`
 * first argument before invoking the renderer's callback.
 */
const on = (channel: string, callback: IpcListener): void => {
  const wrapped = (_event: IpcRendererEvent, ...args: unknown[]): void => {
    callback(...args);
  };

  let channelMap = listenerRegistry.get(channel);
  if (!channelMap) {
    channelMap = new Map();
    listenerRegistry.set(channel, channelMap);
  }

  // If the same callback is registered twice on the same channel
  // without an intervening `off`, the earlier registration is
  // discarded here. That matches `ipcRenderer`'s own behaviour
  // when the same listener reference is added twice.
  const existing = channelMap.get(callback);
  if (existing) {
    ipcRenderer.removeListener(channel, existing);
  }

  channelMap.set(callback, wrapped);
  ipcRenderer.on(channel, wrapped);
};

/**
 * Remove a listener that was previously registered via `on`.
 * A no-op if the pair was never registered — the removal is
 * best-effort and a caller who calls `off` with an unknown pair
 * has not caused a bug that would benefit from a throw.
 */
const off = (channel: string, callback: IpcListener): void => {
  const channelMap = listenerRegistry.get(channel);
  if (!channelMap) {
    return;
  }
  const wrapped = channelMap.get(callback);
  if (!wrapped) {
    return;
  }
  ipcRenderer.removeListener(channel, wrapped);
  channelMap.delete(callback);
  if (channelMap.size === 0) {
    listenerRegistry.delete(channel);
  }
};

/**
 * Register a one-shot listener. Electron's own `once` removes
 * the listener after the first invocation, so no registry entry
 * is needed — but the wrapper still strips the event argument.
 */
const once = (channel: string, callback: IpcListener): void => {
  ipcRenderer.once(
    channel,
    (_event: IpcRendererEvent, ...args: unknown[]): void => {
      callback(...args);
    }
  );
};

// ============================================================
//  Runtime API
// ============================================================
//
//  The object below is the concrete value that gets exposed on
//  `window.electronAPI`. Its type is asserted to `ElectronAPI`
//  by the assignment that follows — a type error at that line
//  would mean a method's signature drifted from the interface
//  declared above, which is exactly the failure mode the type
//  annotation exists to catch.
//
//  The generic `invoke<T>` helper erases the boilerplate of
//  `ipcRenderer.invoke(channel, ...args) as Promise<ApiResponse<T>>`.
//  Because `ipcRenderer.invoke` returns `Promise<any>` in
//  Electron's types, the assertion is required — but it is a
//  single, localized assertion with a clearly documented
//  contract, not a scatter of `any` casts throughout the file.
//  The contract is: every IPC handler registered by the main
//  process returns an `ApiResponse<T>` for the corresponding
//  channel; a handler that violated that contract would be a
//  bug in the main process, not in the renderer's consumption
//  of it.

const invoke = <T>(
  channel: string,
  ...args: unknown[]
): Promise<ApiResponse<T>> => {
  return ipcRenderer.invoke(channel, ...args) as Promise<ApiResponse<T>>;
};

const api: ElectronAPI = {
  // ---- Auth ----
  auth: {
    login: (credentials) => invoke<LoginResponse>('auth:login', credentials),
    logout: () => invoke<null>('auth:logout'),
    getUser: () => invoke<User | null>('auth:getUser'),
  },

  // ---- Config ----
  config: {
    getApiBaseUrl: () => invoke<string>('config:getApiBaseUrl'),
    getAppVersion: () => invoke<string>('config:getAppVersion'),
    getPlatform: () => invoke<string>('config:getPlatform'),
  },

  // ---- Topics ----
  topics: {
    list: (status) => invoke<Topic[]>('topics:list', status),
    create: (payload) => invoke<Topic>('topics:create', payload),
    get: (topicId) => invoke<Topic>('topics:get', topicId),
    update: (topicId, patch) => invoke<Topic>('topics:update', topicId, patch),
    remove: (topicId) => invoke<Topic>('topics:delete', topicId),
  },

  // ---- Research ----
  research: {
    search: (topicId, title, keywords) =>
      invoke<{ candidates: string[] }>(
        'research:search',
        topicId,
        title,
        keywords
      ),
    extract: (topicId, urls) =>
      invoke<{ savedCount: number }>('research:extract', topicId, urls),
    cancel: (topicId) => invoke<null>('research:cancel', topicId),
  },

  // ---- Documents ----
  documents: {
    list: (topicId) => invoke<Document[]>('documents:list', topicId),
    read: (path) => invoke<{ content: string }>('documents:read', path),
    remove: (path) => invoke<null>('documents:delete', path),
  },

  // ---- Writer ----
  writer: {
    generate: (topicId) => invoke<Article>('writer:generate', topicId),
    cancel: (topicId) => invoke<null>('writer:cancel', topicId),
  },

  // ---- Validation ----
  validation: {
    run: (articleId) => invoke<Report>('validation:run', articleId),
    report: (articleId) => invoke<Report>('validation:report', articleId),
  },

  // ---- Export ----
  export: {
    docx: (articleId) => invoke<string | null>('export:docx', articleId),
    md: (articleId) => invoke<string | null>('export:md', articleId),
    txt: (articleId) => invoke<string | null>('export:txt', articleId),
  },

  // ---- Settings ----
  settings: {
    get: () => invoke<UserSettingsMap>('settings:get'),
    save: (patch) => invoke<UserSettingsMap>('settings:save', patch),
    checkUpdates: () => invoke<AppVersion | null>('settings:checkUpdates'),
  },

  // ---- Admin ----
  admin: {
    listUsers: () => invoke<User[]>('admin:getUsers'),
    createUser: (payload) => invoke<User>('admin:createUser', payload),
    updateUser: (userId, patch) =>
      invoke<User>('admin:updateUser', userId, patch),
    deleteUser: (userId) => invoke<User>('admin:deleteUser', userId),
  },

  // ---- Utils ----
  utils: {
    openExternal: (url) => invoke<null>('utils:openExternal', url),
    showItemInFolder: (path) => invoke<null>('utils:showItemInFolder', path),
  },

  // ---- Window ----
  window: {
    notify: () => invoke<null>('window:notify'),
  },

  // ---- Event registry ----
  on,
  off,
  once,
};

// ============================================================
//  Expose
// ============================================================

/**
 * Hand the API to the renderer through the contextBridge.
 *
 * `contextBridge.exposeInMainWorld` installs the object at the
 * given name on the renderer's `window`, with the deep-cloning
 * and function-serialization machinery of the bridge handling the
 * context crossing. From the renderer's point of view,
 * `window.electronAPI` looks and behaves like an ordinary
 * JavaScript object with methods that return promises.
 *
 * The methods cannot leak anything from this file's own scope
 * into the renderer — the bridge copies the API surface across
 * the context boundary. That is what lets this file import
 * `ipcRenderer` and `contextBridge` at the top without exposing
 * either of them.
 */
contextBridge.exposeInMainWorld('electronAPI', api);

// ============================================================
//  Global type augmentation
// ============================================================
//
//  Declare `window.electronAPI` as a known property of the DOM's
//  `Window` interface so that every renderer file can write
//  `window.electronAPI.auth.login(...)` with full type
//  information and no `any` cast. The `declare global` block
//  lives in the preload script because that is where the runtime
//  value actually gets installed on `window` — keeping the type
//  and the value side by side makes it obvious that they are two
//  halves of the same contract.
//
//  Because the desktop app is compiled as a single TypeScript
//  project (one tsconfig, `include: ['src/**/*']`), a global
//  augmentation declared in any file applies to every other file
//  in the same compilation. In particular, the renderer's `.tsx`
//  files see the `electronAPI` property without needing their own
//  declaration file.

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}