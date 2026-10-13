/**
 * researchIPC — IPC handlers for the research feature (main process).
 *
 * Registers the six channels the renderer's
 * `window.electronAPI.research.*` methods invoke:
 *
 *   research:search        — run a search operation on a topic.
 *                            Delegates to `searchService.runSearch`.
 *   research:extract       — fetch and extract a batch of URLs.
 *                            Delegates to `extractionService.runExtract`.
 *   research:getCandidates — read the topic's saved candidate list
 *                            from `<topicFolder>/candidates.json`.
 *   research:getFailures   — read the topic's failed-URL records
 *                            from `<topicFolder>/failures.json`.
 *   research:clearFailures — delete the topic's `failures.json`
 *                            file.
 *   research:cancel        — stop the currently-running research
 *                            operation for a topic.
 *
 * Each handler:
 *
 *   1. Validates the arguments the renderer sent. A malformed
 *      argument — a non-string topicId, an empty URL array, a
 *      missing title — is rejected with a specific error message
 *      before any service is called. The service would also
 *      reject these (each service validates its own inputs), but
 *      the handler's check produces a clearer error and avoids
 *      the overhead of a service call that is guaranteed to
 *      fail.
 *
 *   2. Delegates to the service. The service is where the
 *      interesting work happens — spawning Python, watching
 *      markers, waiting for a terminal result. The handler does
 *      not duplicate any of that logic.
 *
 *   3. Returns the result in the shared `ApiResponse<T>` envelope.
 *      `{ success: true, data }` on success, `{ success: false,
 *      error }` on failure. The renderer's preload passes this
 *      envelope through unchanged, so the renderer's service
 *      layer sees the same shape it would see from the backend's
 *      HTTP API.
 *
 * Why the `research:search` handler's return value does not
 * carry the full candidate list:
 *
 *   The search service returns a `SearchServiceResult` whose
 *   `candidates` field carries the full list of `SearchCandidate`
 *   objects (url, title, snippet, platform). But the renderer
 *   receives that list through a DIFFERENT path — the
 *   `research:marker` event stream that the search service
 *   broadcasts as the Python script emits `SEARCH_RESULT`. The
 *   renderer's `researchStore` listens on that channel and
 *   populates the candidate list from the marker payload.
 *
 *   The handler's IPC return value is therefore a SUMMARY, not
 *   the data itself: it carries the list of URLs as a convenience
 *   for callers that only want the URLs (a test, a diagnostic
 *   tool), and it carries the terminal success/failure status. If
 *   the marker channel and the IPC return value disagree — a race
 *   where the marker was not yet delivered when the IPC resolved
 *   — the marker channel's data wins, because the marker channel
 *   is the streaming source of truth and the IPC return value is
 *   a summary.
 *
 *   The full candidate list, in its bucket-keyed shape, is
 *   available via the separate `research:getCandidates` channel,
 *   which reads the `candidates.json` file that the search service
 *   writes after a successful search. That channel is what the
 *   renderer's `loadCandidates` action uses on topic open; the
 *   `research:search` return value is not used for that purpose.
 *
 * The cancel path:
 *
 *   `research:cancel` looks up the process manager for the
 *   topic's search operation and calls its `kill()`, which
 *   tree-kills the Python subprocess (and any child processes it
 *   spawned). This is a HARD cancel — the graceful path, which
 *   writes a `STOP` command to the child's stdin, is available
 *   via `manager.writeStdin('STOP\n')` and is used internally by
 *   the automation store's Stop button. The IPC cancel is the
 *   escape hatch for the case where the graceful path is not
 *   working (the script is hung on a network call) or where the
 *   user wants the operation to end immediately.
 *
 *   The handler returns `{ success: true, data: null }` whether
 *   or not a manager was found. Cancelling an operation that has
 *   already finished is not an error — the user's intent ("the
 *   operation should not be running") is satisfied either way.
 *
 * The extractionService forward reference:
 *
 *   The `research:extract` handler imports `runExtract` from
 *   `../services/extractionService.js`. That file is created in
 *   Session 12, step 91 — a later session than this one. Until it
 *   exists, the import at the top of this file produces a single
 *   `TS2307` error. That is EXPECTED and documented in the
 *   TypeScript Integrity Check below.
 *
 *   The alternative — writing the handler with a stub body that
 *   throws "not yet implemented" — is forbidden by the strict
 *   protocol's "no stubs" rule. The handler is written in full,
 *   referencing the module that will exist; the forward-reference
 *   pattern is the same one used throughout this codebase.
 *
 * What this file does NOT do:
 *
 *   - It does not parse markers. Marker parsing and forwarding is
 *     the search service's job (and eventually the extraction
 *     service's job). The IPC handler sees only the terminal
 *     result.
 *
 *   - It does not manage Chrome. Chrome lifecycle is owned by
 *     `chromeLauncher.ts`, which the services call. The IPC
 *     handler has no visibility into Chrome.
 *
 *   - It does not touch the encrypted store. Research operations
 *     are stateless from the main process's perspective; any
 *     persistence happens through the backend's HTTP API, which
 *     the services call directly when they need to.
 *
 *   - It does not validate the schema of the service's result.
 *     The service is written to always resolve with a
 *     well-formed `SearchServiceResult` or `ExtractionServiceResult`;
 *     the handler trusts that contract and forwards the shape.
 */

import { ipcMain, app, type IpcMainInvokeEvent } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  runSearch,
  getSearchTaskId,
  type BucketKey,
  type CandidatesByBucket,
  type SearchCandidate,
} from '../services/searchService.js';
import { runExtract } from '../services/extractionService.js';
import { getByTaskId } from '../services/childProcessManager.js';
import { apiGet } from '../../shared/api/client.js';
import type {
  ApiResponse,
  Topic,
} from '../../shared/types/index.js';

// =============================================================================
//  Channel name constants
// =============================================================================
//
//  The six channel names are declared as constants so a future
//  refactor that renames them (or a test that spies on them) has
//  one place to change. The preload's `src/main/preload.ts`
//  declares the same strings on the renderer side of the bridge —
//  the two must stay in sync, but neither file imports from the
//  other, because the preload is a renderer-context module and this
//  file is a main-context module.

const CHANNEL_SEARCH = 'research:search';
const CHANNEL_EXTRACT = 'research:extract';
const CHANNEL_GET_CANDIDATES = 'research:getCandidates';
const CHANNEL_GET_FAILURES = 'research:getFailures';
const CHANNEL_CLEAR_FAILURES = 'research:clearFailures';
const CHANNEL_CANCEL = 'research:cancel';

// ============================================================
//  On-disk layout
// ============================================================
//
//  The topic folder convention. Same values every other
//  main-process module that touches the topic folder uses
//  (`writerIPC.ts`, `validationIPC.ts`, `documentService.ts`).
//  Duplicated across files because the convention is a cross-file
//  contract and the plan's tree declares no shared layout module
//  for the desktop main process. A change here must be reflected
//  in the sibling files and on the Python side in the same commit.

/** The app slug used as the top-level folder under the user's
 *  application-data directory. Must match the Electron side's
 *  `main/store.ts` slug and the Python side's
 *  `core/file_io._APP_SLUG`. */
const APP_SLUG = 'writespeare';

/** The subfolder under the app slug that holds every topic. */
const TOPICS_SUBFOLDER = 'topics';

/** The filename of the per-topic candidate list, written by the
 *  search service after a successful search. */
const CANDIDATES_FILE = 'candidates.json';

/** The filename of the per-topic failed-URL records, written by
 *  the Python extraction dispatcher when a batch finishes with
 *  at least one failure. */
const FAILURES_FILE = 'failures.json';

/** The set of legal time-range bucket identifiers, as a runtime
 *  array. Its type is `readonly BucketKey[]`, which guarantees at
 *  compile time that every string is a legal member of the union
 *  the search service declares — a typo would be a type error,
 *  not a silent runtime surprise. */
const BUCKET_KEYS: readonly BucketKey[] = [
  'anytime',
  'year',
  'month',
  'week',
];

/** Narrow an `unknown` value to one of the four legal bucket
 *  identifiers. Used by `handleSearch` to validate the
 *  `timeRange` argument the renderer sends. */
const isBucketKey = (value: unknown): value is BucketKey =>
  typeof value === 'string' &&
  (BUCKET_KEYS as readonly string[]).includes(value);

// ============================================================
//  Shared types
// ============================================================

/**
 * One failed-extraction record, as stored in the topic's
 * `failures.json` file.
 *
 * The shape mirrors what the Python extraction dispatcher writes
 * (`research/extract_dispatch.py`) and what the renderer's
 * research store declares
 * (`features/research/store/researchStore.ts`). All three
 * declarations must stay in sync; the duplication is the same
 * pattern `SearchCandidate` follows between `searchService.ts`
 * and the renderer's store.
 */
export interface FailedUrlRecord {
  /** The URL that failed to extract. */
  url: string;

  /** A short classification of the failure — e.g. `'timeout'`,
   *  `'site_returned_404'`, `'empty_content'`. */
  reason: string;

  /** How many times this URL has been attempted across runs. */
  attemptCount: number;

  /** ISO-8601 timestamp of the most recent attempt. */
  lastAttemptAt: string;

  /** The full error message from the most recent attempt, if the
   *  dispatcher captured one. Empty string when none was. */
  errorMessage: string;
}

// ============================================================
//  Path helpers
// ============================================================

/**
 * Return the absolute path to a topic's folder. Same layout every
 * other main-process module that touches the topic folder uses.
 */
const getTopicFolder = (topicId: string): string => {
  return path.join(
    app.getPath('appData'),
    APP_SLUG,
    TOPICS_SUBFOLDER,
    topicId
  );
};

/**
 * Return the absolute path to a topic's `candidates.json` file.
 */
const getCandidatesPath = (topicId: string): string => {
  return path.join(getTopicFolder(topicId), CANDIDATES_FILE);
};

/**
 * Return the absolute path to a topic's `failures.json` file.
 */
const getFailuresPath = (topicId: string): string => {
  return path.join(getTopicFolder(topicId), FAILURES_FILE);
};

// ============================================================
//  File I/O helpers
// ============================================================

/**
 * Read a JSON file and return its parsed value, or null when the
 * file does not exist or cannot be parsed.
 *
 * Never throws. A missing file is a legitimate state — a fresh
 * topic has no `candidates.json` until its first search and no
 * `failures.json` until its first failed extraction — and a
 * malformed file is a bug in whatever wrote it, not something
 * the caller can act on. Both cases collapse to "no data", which
 * is what the callers expect.
 */
const readJsonFileOrNull = async (
  filepath: string
): Promise<unknown> => {
  try {
    const raw = await fs.readFile(filepath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

/**
 * Delete a file if it exists, swallowing ENOENT.
 *
 * Used by the `clearFailures` handler. The caller's intent is
 * "the file should not exist"; a file that is already gone
 * satisfies that intent, and reporting a failure for it would
 * produce a spurious error toast on the renderer. Any other
 * filesystem error (a permission denial, a directory in the
 * file's place) IS propagated so the caller can surface it.
 */
const deleteFileIfExists = async (filepath: string): Promise<void> => {
  try {
    await fs.unlink(filepath);
  } catch (err) {
    // ENOENT is the "file does not exist" code. Node surfaces it
    // as the `code` field on the thrown error; the narrow cast
    // reaches the field without widening the type of `err`.
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return;
    }
    throw err;
  }
};

// ============================================================
//  Backend helpers
// ============================================================

/**
 * Fetch the topic's `sourceCount` from the backend.
 *
 * The value is used as the search's `maxResults` — the number of
 * candidates to collect. The plan's preset-wiring work (PR-2 of
 * the approved runbook) replaced the previous hard-coded
 * `DEFAULT_MAX_RESULTS = 20` with a per-topic value read from
 * the topic's own record. Once PR-3 lands and the search runs
 * once per time-range bucket, the value the caller needs becomes
 * the topic's per-bucket configuration rather than the aggregate
 * `sourceCount`; the change is to this helper's return shape and
 * the caller's use of it.
 *
 * Throws when the topic cannot be fetched — a backend error, an
 * expired session, a 404 for an unknown topic. The caller
 * (`handleSearch`) catches and converts the throw into an error
 * envelope. A search whose source count is unknown cannot be run
 * meaningfully, so failing fast is the honest behavior.
 */
const fetchTopicSourceCount = async (topicId: string): Promise<number> => {
  const result = await apiGet<Topic>(
    `/topics/${encodeURIComponent(topicId)}`
  );
  if (result.success && result.data) {
    return result.data.sourceCount;
  }
  throw new Error(result.error ?? 'Topic could not be loaded.');
};

// ============================================================
//  research:search
// ============================================================

/**
 * Run a search operation on a topic.
 *
 * Arguments sent by the renderer:
 *
 *   topicId   — the topic's ID. Required, non-empty string.
 *   title     — the search query, normally the topic's title.
 *               Required, non-empty string.
 *   keywords  — the user's keywords. Optional; an empty or
 *               missing list means the search runs on the title
 *               alone.
 *   timeRange — which time-range bucket this search invocation
 *               is for. Required; one of `'anytime'`, `'year'`,
 *               `'month'`, or `'week'`. The value is validated
 *               below and passed through to the search service,
 *               which forwards it to the Python script as the
 *               `--time-range` argument.
 *
 * Returns:
 *
 *   `{ success: true, data: { candidates: string[] } }` when the
 *   search produced at least one candidate. The `candidates` array
 *   is the list of URLs — the full candidate objects (title,
 *   snippet, platform) arrive separately through the marker
 *   stream's `SEARCH_RESULT` payload.
 *
 *   `{ success: false, error: string }` on any failure. The error
 *   string is user-facing — the renderer's research store displays
 *   it in the SearchProgress panel.
 */
const handleSearch = async (
  _event: IpcMainInvokeEvent,
  topicId: unknown,
  title: unknown,
  keywords: unknown,
  timeRange: unknown
): Promise<ApiResponse<{ candidates: string[] }>> => {
  // ---- Validate ----
  if (typeof topicId !== 'string' || topicId.trim().length === 0) {
    return { success: false, error: 'topicId is required.' };
  }
  if (typeof title !== 'string' || title.trim().length === 0) {
    return { success: false, error: 'title is required.' };
  }

  // The timeRange argument identifies which time-range bucket
  // this search invocation is for. It is validated against the
  // closed set the search service's `BucketKey` union declares,
  // and the validated value is passed through to `runSearch`
  // (below), which forwards it to the Python script as the
  // `--time-range` argument. An invalid value is rejected here,
  // before any service call runs.
  if (!isBucketKey(timeRange)) {
    return {
      success: false,
      error:
        'timeRange must be one of: anytime, year, month, week.',
    };
  }

  // The keywords argument is optional and may arrive as
  // `undefined` (the renderer omits it) or as an array of strings.
  // Any non-array, non-undefined value is a malformed call and is
  // rejected rather than coerced.
  let normalizedKeywords: string[] = [];
  if (keywords !== undefined) {
    if (!Array.isArray(keywords)) {
      return { success: false, error: 'keywords must be an array.' };
    }
    for (const k of keywords) {
      if (typeof k !== 'string') {
        return {
          success: false,
          error: 'keywords must contain only strings.',
        };
      }
      const trimmed = k.trim();
      if (trimmed.length > 0) {
        normalizedKeywords.push(trimmed);
      }
    }
  }

  // ---- Fetch the topic's source count ----
  // The search's max-results value comes from the topic's own
  // record rather than a hard-coded constant. See the
  // `fetchTopicSourceCount` helper for the reasoning and for the
  // PR-3 follow-up.
  let maxResults: number;
  try {
    maxResults = await fetchTopicSourceCount(topicId.trim());
  } catch (err) {
    const message =
      err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: `Could not load the topic: ${message}`,
    };
  }

  // ---- Delegate ----
  const result = await runSearch({
    query: title.trim(),
    keywords: normalizedKeywords,
    maxResults,
    topicId: topicId.trim(),
    timeRange,
  });

  // ---- Envelope ----
  if (result.kind === 'success') {
    return {
      success: true,
      data: {
        candidates: result.candidates.map((c) => c.url),
      },
    };
  }

  return {
    success: false,
    error: result.error ?? 'Search failed.',
  };
};

// ============================================================
//  research:extract
// ============================================================

/**
 * Fetch and extract a batch of URLs into doc files.
 *
 * Arguments sent by the renderer:
 *
 *   topicId  — the topic's ID. Required, non-empty string.
 *   urls     — the URLs the user selected for extraction.
 *               Required, non-empty array of non-empty strings.
 *
 * Returns:
 *
 *   `{ success: true, data: { savedCount: number } }` when the
 *   extraction completed. `savedCount` is the number of doc files
 *   successfully written; it may be less than `urls.length` if
 *   some pages failed, and the renderer's document list reflects
 *   the actual set of saved files (delivered via the marker
 *   stream).
 *
 *   `{ success: false, error: string }` on any failure.
 *
 * Forward reference: `runExtract` is imported from
 * `../services/extractionService.js`, which is created in
 * Session 12, step 91. Until that file exists, the import at the
 * top of this module produces a single `TS2307`. See the file
 * header for why the handler is written in full rather than
 * stubbed.
 */
const handleExtract = async (
  _event: IpcMainInvokeEvent,
  topicId: unknown,
  urls: unknown
): Promise<ApiResponse<{ savedCount: number }>> => {
  // ---- Validate ----
  if (typeof topicId !== 'string' || topicId.trim().length === 0) {
    return { success: false, error: 'topicId is required.' };
  }
  if (!Array.isArray(urls) || urls.length === 0) {
    return {
      success: false,
      error: 'urls must be a non-empty array.',
    };
  }
  const normalizedUrls: string[] = [];
  for (const u of urls) {
    if (typeof u !== 'string' || u.trim().length === 0) {
      return {
        success: false,
        error: 'urls must contain only non-empty strings.',
      };
    }
    normalizedUrls.push(u.trim());
  }

  // ---- Delegate ----
  const result = await runExtract({
    topicId: topicId.trim(),
    urls: normalizedUrls,
  });

  // ---- Envelope ----
  if (result.success) {
    return {
      success: true,
      data: { savedCount: result.savedCount },
    };
  }

  return {
    success: false,
    error: result.error ?? 'Extraction failed.',
  };
};

// ============================================================
//  research:getCandidates
// ============================================================

/**
 * Read the topic's saved candidate list from disk.
 *
 * The list is written by `searchService.runSearch` after every
 * successful search. Its shape is the bucket-keyed
 * `CandidatesByBucket` record the renderer's research store
 * expects — four buckets, each an array of `SearchCandidate`
 * objects. In this session, all candidates land under the
 * `anytime` bucket and the other three are empty; PR-3 changes
 * the writer to route each per-bucket search's results to its
 * own slot.
 *
 * A missing file — a topic that has never had a search run, or
 * whose `candidates.json` was deleted — is a legitimate state,
 * not an error. The handler returns a fully-populated bucket
 * record with empty arrays in that case, matching the renderer's
 * `loadCandidates` action's expectation that an un-searched
 * topic populates its slot with an empty bucket record rather
 * than leaving it undefined.
 *
 * A malformed file — content that does not parse, or parses to
 * something other than an object — is also treated as "no saved
 * candidates". The alternative (surfacing the malformed file as
 * an error) would leave the user's Sources tab unable to load
 * until the file was deleted by hand, which is a worse outcome
 * than silently ignoring a corrupt cache.
 */
const handleGetCandidates = async (
  _event: IpcMainInvokeEvent,
  topicId: unknown
): Promise<ApiResponse<CandidatesByBucket>> => {
  // ---- Validate ----
  if (typeof topicId !== 'string' || topicId.trim().length === 0) {
    return { success: false, error: 'topicId is required.' };
  }

  const empty: CandidatesByBucket = {
    anytime: [],
    year: [],
    month: [],
    week: [],
  };

  // ---- Read the file ----
  const filepath = getCandidatesPath(topicId.trim());
  const raw = await readJsonFileOrNull(filepath);

  // A missing or unparseable file → empty bucket record. See
  // the docstring for why this is not an error.
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { success: true, data: empty };
  }

  // ---- Narrow the parsed value into CandidatesByBucket ----
  // Each bucket must be an array; a bucket whose value is not an
  // array falls back to an empty array. Individual candidates
  // that do not match the `SearchCandidate` shape are skipped.
  const record = raw as Record<string, unknown>;
  const narrowBucket = (value: unknown): SearchCandidate[] => {
    if (!Array.isArray(value)) {
      return [];
    }
    const out: SearchCandidate[] = [];
    for (const entry of value) {
      if (typeof entry !== 'object' || entry === null) continue;
      const e = entry as Record<string, unknown>;
      const url = e['url'];
      const title = e['title'];
      if (typeof url !== 'string' || url.length === 0) continue;
      if (typeof title !== 'string' || title.length === 0) continue;
      const snippet =
        typeof e['snippet'] === 'string' ? e['snippet'] : '';
      const platform =
        typeof e['platform'] === 'string' ? e['platform'] : 'generic';
      out.push({ url, title, snippet, platform });
    }
    return out;
  };

  return {
    success: true,
    data: {
      anytime: narrowBucket(record['anytime']),
      year: narrowBucket(record['year']),
      month: narrowBucket(record['month']),
      week: narrowBucket(record['week']),
    },
  };
};

// ============================================================
//  research:getFailures
// ============================================================

/**
 * Read the topic's failed-URL records from disk.
 *
 * The list is written by the Python extraction dispatcher
 * (`research/extract_dispatch.py`) at the end of a batch that
 * had at least one failure. Each record carries the URL, a
 * short reason code, an attempt count, the last attempt's
 * timestamp, and the most recent error message.
 *
 * A missing file — a topic whose extractions have all
 * succeeded, or whose `failures.json` was deleted — returns an
 * empty array. The alternative (surfacing "no file" as an
 * error) would make the renderer's failed-URL banner appear for
 * every topic that has never had a failure, which is the wrong
 * visual state.
 *
 * A malformed file is treated the same as a missing one. A
 * corrupt cache should not leave the Sources tab permanently
 * unable to load.
 */
const handleGetFailures = async (
  _event: IpcMainInvokeEvent,
  topicId: unknown
): Promise<ApiResponse<FailedUrlRecord[]>> => {
  // ---- Validate ----
  if (typeof topicId !== 'string' || topicId.trim().length === 0) {
    return { success: false, error: 'topicId is required.' };
  }

  // ---- Read the file ----
  const filepath = getFailuresPath(topicId.trim());
  const raw = await readJsonFileOrNull(filepath);

  if (!Array.isArray(raw)) {
    return { success: true, data: [] };
  }

  // ---- Narrow the parsed value into FailedUrlRecord[] ----
  const out: FailedUrlRecord[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const url = e['url'];
    const reason = e['reason'];
    const attemptCount = e['attemptCount'];
    const lastAttemptAt = e['lastAttemptAt'];
    const errorMessage = e['errorMessage'];
    if (typeof url !== 'string' || url.length === 0) continue;
    if (typeof reason !== 'string') continue;
    if (typeof attemptCount !== 'number') continue;
    if (typeof lastAttemptAt !== 'string') continue;
    if (typeof errorMessage !== 'string') continue;
    out.push({
      url,
      reason,
      attemptCount,
      lastAttemptAt,
      errorMessage,
    });
  }
  return { success: true, data: out };
};

// ============================================================
//  research:clearFailures
// ============================================================

/**
 * Delete the topic's `failures.json` file.
 *
 * Called by the renderer when the user dismisses the last failed
 * URL from the Sources tab's failed-URL banner, or when the user
 * deletes a candidate and no other failures remain. The file's
 * absence is the state the UI is moving toward; deleting the
 * file is what makes the next `research:getFailures` call
 * return an empty list.
 *
 * A file that is already gone is a success — the caller's
 * intent ("the file should not exist") is satisfied either way.
 * Any other filesystem error (a permission denial, a directory
 * sitting in the file's place) is surfaced as an error envelope
 * so the caller can display a message.
 */
const handleClearFailures = async (
  _event: IpcMainInvokeEvent,
  topicId: unknown
): Promise<ApiResponse<null>> => {
  // ---- Validate ----
  if (typeof topicId !== 'string' || topicId.trim().length === 0) {
    return { success: false, error: 'topicId is required.' };
  }

  // ---- Delete the file ----
  try {
    await deleteFileIfExists(getFailuresPath(topicId.trim()));
  } catch (err) {
    const message =
      err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: `Could not clear failures: ${message}`,
    };
  }

  return { success: true, data: null };
};

// ============================================================
//  research:cancel
// ============================================================

/**
 * Cancel the currently-running research operation for a topic.
 *
 * The cancel is a HARD kill — the process manager's `kill()`
 * method, which uses `tree-kill` to terminate the Python
 * subprocess and every child it spawned. The graceful path (a
 * `STOP` command written to the child's stdin, which the Python
 * script's checkpoint detects and acts on at its next safe point)
 * is available via the manager's `writeStdin` method; a caller
 * that wants the graceful behaviour uses that method directly
 * (it is what the automation store's Stop button does). The IPC
 * cancel is the escape hatch for the cases where the graceful
 * path does not apply — a hung script, an unresponsive network
 * call, or a user who wants the operation to end immediately.
 *
 * Arguments sent by the renderer:
 *
 *   topicId  — the topic's ID. Required, non-empty string.
 *
 * Returns:
 *
 *   Always `{ success: true, data: null }`. Cancelling an
 *   operation that has already finished — or that never started —
 *   is not an error; the user's intent ("this operation should
 *   not be running") is satisfied either way. Reporting a
 *   failure because there was nothing to cancel would produce a
 *   spurious error toast on the renderer.
 */
const handleCancel = async (
  _event: IpcMainInvokeEvent,
  topicId: unknown
): Promise<ApiResponse<null>> => {
  // ---- Validate ----
  if (typeof topicId !== 'string' || topicId.trim().length === 0) {
    return { success: false, error: 'topicId is required.' };
  }

  // ---- Look up the manager and kill ----
  // The task ID is derived from the topic ID by the same helper
  // the search service uses, so the two agree on the key. A
  // missing manager (no operation has ever started for this topic,
  // or the previous one finished and was disposed) is a no-op.
  const taskId = getSearchTaskId(topicId.trim());
  const manager = getByTaskId(taskId);
  if (manager !== null) {
    manager.kill();
  }

  return { success: true, data: null };
};

// ============================================================
//  registerResearchIPC
// ============================================================

/**
 * Register the research feature's IPC handlers.
 *
 * Called once, from `main/index.ts`, inside the
 * `app.whenReady().then(...)` callback — the same place the auth
 * and topics features' registration functions are called. The
 * function is not idempotent: `ipcMain.handle` refuses to register
 * a second handler for the same channel, and a second call would
 * therefore produce Electron errors. The single-call contract is
 * the same one every other feature's `register*IPC()` function
 * follows.
 */
export const registerResearchIPC = (): void => {
  ipcMain.handle(CHANNEL_SEARCH, handleSearch);
  ipcMain.handle(CHANNEL_EXTRACT, handleExtract);
  ipcMain.handle(CHANNEL_GET_CANDIDATES, handleGetCandidates);
  ipcMain.handle(CHANNEL_GET_FAILURES, handleGetFailures);
  ipcMain.handle(CHANNEL_CLEAR_FAILURES, handleClearFailures);
  ipcMain.handle(CHANNEL_CANCEL, handleCancel);
};

// ============================================================
//  Default export
// ============================================================

/**
 * The registration function as the default export, matching the
 * convention used by every other IPC module in the codebase.
 * `main/index.ts` uses the named import
 * (`import { registerResearchIPC } from ...`), so the default form
 * is a convenience rather than a load-bearing export.
 */
export default registerResearchIPC;