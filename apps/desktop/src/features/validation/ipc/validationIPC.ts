/**
 * validationIPC — IPC handlers for the validation feature.
 *
 * Registers the two channels the renderer's
 * `window.electronAPI.validation.*` methods invoke:
 *
 *   validation:run     — run the six validators on an article and
 *                        return the resulting Report.
 *   validation:report  — fetch the most recent report for an
 *                        article from the backend.
 *
 * The two channels correspond one-to-one with the two methods
 * the preload declares on `window.electronAPI.validation` —
 * `run` and `report`.
 *
 * ── What the run handler does that the service does not ────────
 *
 *   The `validationService.runValidate` function produces a local
 *   `.json` report file. The backend's `Report` entity is a Mongo
 *   record with an `_id`, an `articleId`, a `topicId`, a
 *   `userId`, a `createdAt`, and a computed `overallStatus` —
 *   none of which the file carries. The run handler bridges the
 *   two:
 *
 *     1. Receives the article's Mongo ID from the renderer.
 *
 *     2. Fetches the Article record from the backend to learn
 *        its `topicId` — the identifier the local on-disk layout
 *        keys on. Without this lookup, an article ID alone
 *        cannot be resolved to a folder path.
 *
 *     3. Computes the topic folder, its `sources/` subfolder,
 *        and finds the latest `.md` draft in the topic's
 *        `article/` subfolder. The latest draft is the one the
 *        writer step just produced; the pipeline's serial model
 *        means there is no ambiguity about which draft the user
 *        is validating.
 *
 *     4. Calls `runValidate({ topicId, articlePath, sourcesDir })`
 *        and receives a `ValidationServiceResult`.
 *
 *     5. On success, reads the produced report file at
 *        `result.reportPath`, parses its JSON, and extracts the
 *        six sections (`readability`, `seo`, `keywords`,
 *        `originality`, `aiMarkers`, `grammar`).
 *
 *     6. POSTs those six sections plus the article's Mongo ID to
 *        the backend's `/api/reports` endpoint. The backend
 *        derives `topicId` from the parent article and computes
 *        `overallStatus` from the six section statuses — neither
 *        is sent by this handler.
 *
 *     7. Returns the backend's response — a fully-populated
 *        `Report` object with its Mongo-assigned `_id` and every
 *        field the renderer needs to display the six panels.
 *
 * ── Why the handler fetches the Article from the backend ────────
 *
 *   The preload's `validation.run` signature takes a single
 *   `articleId` argument. From an article ID alone, this handler
 *   cannot compute a local file path: the file layout keys on the
 *   TOPIC's ID, and the only link between an article and its
 *   topic is the `topicId` field on the Article record, which
 *   lives on the backend.
 *
 *   The alternative — having the renderer pass both an article ID
 *   and a topic ID — would change the preload's signature, which
 *   is out of scope for this file. The alternative of deriving
 *   the topic ID from the on-disk folder structure (scanning every
 *   topic's `article/` folder for a matching filename) would be
 *   both slow and unreliable — the draft filenames are sequential
 *   (`draft-01.md`, `draft-02.md`, ...) and do not encode the
 *   article's Mongo ID.
 *
 *   The single GET request to `/api/articles/:id` is therefore the
 *   correct resolution path. It runs once per validation
 *   operation, and the backend's `getArticleById` handler answers
 *   it with a single indexed lookup.
 *
 * ── What the report handler does ────────────────────────────────
 *
 *   The `validation:report` channel is a read-only fetch of an
 *   existing report. It is used by a caller that wants to display
 *   a previously-produced report without re-running the
 *   validators — for example, the Article tab re-mounting after a
 *   navigation, or a Report view that the user re-opens after
 *   closing it.
 *
 *   The handler is a one-line forward of the article ID to the
 *   backend's `GET /api/reports/article/:articleId/latest`
 *   endpoint. All the interesting logic (which report is "latest",
 *   ownership scoping, the 404-when-none-exists collapse) lives on
 *   the backend.
 *
 * ── Error handling ─────────────────────────────────────────────
 *
 *   Every failure path — a missing `articleId`, an unreachable
 *   backend, a missing draft file, a Python script that exits
 *   non-zero, a report file that cannot be read or parsed — is
 *   converted into a `{ success: false, error }` envelope. No
 *   exception escapes the handlers: an unhandled rejection from
 *   an IPC handler would arrive in the renderer as an unhandled
 *   promise rejection, which is a strictly worse failure mode
 *   than a well-formed error envelope the renderer's store can
 *   unwrap.
 *
 * ── What this file does NOT do ──────────────────────────────────
 *
 *   - It does not launch Chrome. Validation has no browser
 *     dependency — see `validationService.ts`'s header for the
 *     reasoning.
 *
 *   - It does not hold report state between calls. Each
 *     `validation:run` produces a fresh report; each
 *     `validation:report` fetches the latest from the backend.
 *     The renderer's store is what decides which report to
 *     display.
 *
 *   - It does not cache the backend's Article lookup. A validation
 *     operation is a user-triggered, low-frequency action; the
 *     extra GET is invisible to the user and removing it would
 *     require an invalidation strategy the plan does not call
 *     for.
 *
 * Dependencies: electron + Node stdlib + the sibling validation
 * service + the shared axios client.
 */

import { ipcMain, app, type IpcMainInvokeEvent } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { runValidate } from '../services/validationService.js';
import { apiGet, apiPost } from '../../shared/api/client.js';
import type {
  ApiResponse,
  Article,
  Report,
} from '../../shared/types/index.js';

// ============================================================
//  Channel name constants
// ============================================================
//
// The two channel names are declared as constants so a future
// refactor that renames them (or a test that spies on them) has
// one place to change. The preload's `src/main/preload.ts`
// declares the same strings on the renderer side of the bridge —
// the two must stay in sync, but neither file imports from the
// other.

const CHANNEL_RUN = 'validation:run';
const CHANNEL_REPORT = 'validation:report';

// ============================================================
//  Layout constants
// ============================================================
//
// Same values `documentService.ts` and `writerIPC.ts` declare.
// See `writerIPC.ts`'s header for the rationale on the
// duplication across the three files.

const APP_SLUG = 'writespeare';
const TOPICS_SUBFOLDER = 'topics';
const SOURCES_SUBFOLDER = 'sources';
const ARTICLE_SUBFOLDER = 'article';
const MARKDOWN_EXTENSION = '.md';

// ============================================================
//  Helpers — path computation
// ============================================================

/**
 * Return the absolute path to a topic's folder.
 * Same layout the sibling services use.
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
 * Return the absolute path to a topic's `sources/` folder.
 */
const getSourcesFolder = (topicId: string): string => {
  return path.join(getTopicFolder(topicId), SOURCES_SUBFOLDER);
};

/**
 * Return the absolute path to a topic's `article/` folder.
 */
const getArticleFolder = (topicId: string): string => {
  return path.join(getTopicFolder(topicId), ARTICLE_SUBFOLDER);
};

// ============================================================
//  Helpers — latest draft resolution
// ============================================================

/**
 * Return the absolute path to the latest `.md` draft in a topic's
 * `article/` folder, or `null` when the folder is missing or
 * contains no `.md` file.
 *
 * "Latest" is the lexically greatest filename. The writer step
 * names its drafts with a zero-padded index (`draft-01.md`,
 * `draft-02.md`, ...), so a lexical sort reproduces the temporal
 * order — `draft-10.md` sorts after `draft-09.md`, and the last
 * entry of the sorted list is the most recently produced draft.
 *
 * The function never throws. A missing folder (the writer step
 * never ran for this topic) or an empty folder both return
 * `null`, which the caller converts into a user-facing error.
 */
const findLatestDraft = async (
  topicId: string
): Promise<string | null> => {
  const articleFolder = getArticleFolder(topicId);

  let entries: string[];
  try {
    entries = await fs.readdir(articleFolder);
  } catch {
    return null;
  }

  const drafts = entries
    .filter((name) => name.endsWith(MARKDOWN_EXTENSION))
    .sort();

  if (drafts.length === 0) {
    return null;
  }

  // The last entry of the sorted list is the latest draft.
  // `noUncheckedIndexedAccess` types the access as
  // `string | undefined`; the length check above makes the
  // undefined case impossible in practice, but the guard is
  // retained for type safety.
  const last = drafts[drafts.length - 1];
  if (last === undefined) {
    return null;
  }
  return path.join(articleFolder, last);
};

// ============================================================
//  Helpers — report file reading
// ============================================================

/**
 * Read a report file from disk and return its parsed JSON
 * content as a `Record<string, unknown>`.
 *
 * The report file is written by the Python side's
 * `validation/validate_all.py` and its shape is the `Report`
 * interface's fields minus `_id`, `articleId`, `topicId`,
 * `userId`, and `createdAt`, plus two local-only metadata fields
 * (`articlePath` and `validatedAt`).
 *
 * The function returns the parsed JSON without validating the
 * shape of its sections. The backend's `/api/reports` endpoint
 * is the authoritative validator for those — see the handler's
 * `apiPost` call for how the six sections are forwarded.
 *
 * Throws when the file cannot be read or when its content is not
 * valid JSON. The caller catches the throw and converts it into
 * an error envelope.
 */
const readReportFile = async (
  reportPath: string
): Promise<Record<string, unknown>> => {
  const raw = await fs.readFile(reportPath, 'utf-8');
  const parsed: unknown = JSON.parse(raw);
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed)
  ) {
    throw new Error('Report file is not a JSON object.');
  }
  return parsed as Record<string, unknown>;
};

// ============================================================
//  registerValidationIPC
// ============================================================

/**
 * Register the validation feature's IPC handlers.
 *
 * Called once, from `main/index.ts`, inside the
 * `app.whenReady().then(...)` callback. The function is not
 * idempotent — `ipcMain.handle` refuses to register a second
 * handler for the same channel — matching the contract every
 * other feature's `register*IPC()` function follows.
 */
export const registerValidationIPC = (): void => {
  // ---- validation:run ----
  //
  // The renderer sends an `articleId` (a Mongo ObjectId string)
  // and receives the fully-populated `Report` on success. See the
  // file header for the full flow.
  ipcMain.handle(
    CHANNEL_RUN,
    async (
      _event: IpcMainInvokeEvent,
      articleId: unknown
    ): Promise<ApiResponse<Report>> => {
      // ---- Validate ----
      if (
        typeof articleId !== 'string' ||
        articleId.trim().length === 0
      ) {
        return { success: false, error: 'articleId is required.' };
      }
      const trimmedArticleId = articleId.trim();

      // ---- Resolve the article's topic ----
      // The GET returns the Article record whose `topicId` field
      // is what the local on-disk layout keys on. Without this
      // lookup, an article ID alone cannot be resolved to a
      // folder path — see the file header for the reasoning.
      const articleResult = await apiGet<Article>(
        `/articles/${encodeURIComponent(trimmedArticleId)}`
      );
      if (!articleResult.success || !articleResult.data) {
        return {
          success: false,
          error:
            articleResult.error ??
            'The article could not be found.',
        };
      }
      const article = articleResult.data;
      const topicId = article.topicId;

      // ---- Compute the operation's inputs ----
      const sourcesDir = getSourcesFolder(topicId);

      const articlePath = await findLatestDraft(topicId);
      if (articlePath === null) {
        return {
          success: false,
          error:
            'No article draft was found on disk for this topic. ' +
            'Generate an article first, then run validation.',
        };
      }

      // ---- Run the validation ----
      // A rejection from `runValidate` would be unusual — the
      // service's contract is "always resolve" — but the
      // try/catch is here to catch an unexpected throw so the
      // renderer sees a well-formed error envelope.
      let result;
      try {
        result = await runValidate({
          topicId,
          articlePath,
          sourcesDir,
        });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : String(err);
        return {
          success: false,
          error: `Validation failed: ${message}`,
        };
      }

      if (!result.success) {
        return {
          success: false,
          error: result.error ?? 'Validation failed.',
        };
      }

      if (result.reportPath.length === 0) {
        return {
          success: false,
          error:
            'Validation reported success but produced no report path.',
        };
      }

      // ---- Read the report file ----
      let reportData: Record<string, unknown>;
      try {
        reportData = await readReportFile(result.reportPath);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : String(err);
        return {
          success: false,
          error: `Could not read the validation report: ${message}`,
        };
      }

      // ---- POST the report to the backend ----
      // The payload carries the six sections the Python side
      // produced plus the article's Mongo ID. The backend
      // derives `topicId` from the parent article and computes
      // `overallStatus` from the six section statuses — neither
      // is sent by this handler.
      //
      // The two local-only metadata fields the Python side
      // wrote into the report file (`articlePath` and
      // `validatedAt`) are deliberately NOT included in the
      // POST body. The backend's schema does not declare them,
      // and the `isPlainObject` guards in its controller would
      // reject extra fields if it did — the safest posture is
      // to send exactly the fields the backend declares.
      const postResult = await apiPost<Report>('/reports', {
        articleId: trimmedArticleId,
        readability: reportData['readability'],
        seo: reportData['seo'],
        keywords: reportData['keywords'],
        originality: reportData['originality'],
        aiMarkers: reportData['aiMarkers'],
        grammar: reportData['grammar'],
      });

      if (!postResult.success || !postResult.data) {
        return {
          success: false,
          error:
            postResult.error ??
            'The report was generated but could not be saved.',
        };
      }

      return {
        success: true,
        data: postResult.data,
      };
    }
  );

  // ---- validation:report ----
  //
  // Fetch the most recent report for an article from the
  // backend. Read-only — no local files, no Python process, no
  // side effects.
  //
  // The backend's `GET /api/reports/article/:articleId/latest`
  // endpoint returns the newest report by `createdAt` for the
  // given article, scoped to the authenticated user. A 404 means
  // the article has no reports yet, which this handler forwards
  // as an error envelope — the caller (the Report tab's initial
  // mount) treats that as "no report yet" rather than as a hard
  // failure.
  ipcMain.handle(
    CHANNEL_REPORT,
    async (
      _event: IpcMainInvokeEvent,
      articleId: unknown
    ): Promise<ApiResponse<Report>> => {
      // ---- Validate ----
      if (
        typeof articleId !== 'string' ||
        articleId.trim().length === 0
      ) {
        return { success: false, error: 'articleId is required.' };
      }

      return apiGet<Report>(
        `/reports/article/${encodeURIComponent(
          articleId.trim()
        )}/latest`
      );
    }
  );
};

// ============================================================
//  Default export
// ============================================================

/**
 * The registration function as the default export, matching the
 * convention used by every other IPC module in the codebase.
 * `main/index.ts` uses the named import
 * (`import { registerValidationIPC } from ...`), so the default
 * form is a convenience rather than a load-bearing export.
 */
export default registerValidationIPC;