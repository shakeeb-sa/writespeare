/**
 * exportIPC — IPC handlers for the export feature.
 *
 * Registers the three channels the renderer's
 * `window.electronAPI.export.*` methods invoke:
 *
 *   export:docx  — export the article as a Word document.
 *   export:md    — export the article as a Markdown file.
 *   export:txt   — export the article as a plain text file.
 *
 * The three channels correspond one-to-one with the three
 * methods the preload declares on `window.electronAPI.export` —
 * `docx`, `md`, `txt`.
 *
 * ── The `txt` channel and the format-mapping decision ──────────
 *
 *   The Python pipeline ships two export writers — `export_docx.py`
 *   for Word documents and `export_md.py` for Markdown files. The
 *   preload declares three methods. The mismatch is documented as
 *   a PLAN DELTA in `exportService.ts`'s file header.
 *
 *   This handler resolves the mismatch by mapping `txt` to the
 *   Markdown writer with a `.txt` default extension on the
 *   Save-As dialog. The rationale: the `export_md.py` writer's
 *   only operation is a UTF-8 copy of the article's text, which
 *   is already valid plain text — an `.md` file IS a `.txt` file
 *   with optional markup conventions. Writing the same bytes to
 *   a `.txt`-named destination produces a file that opens
 *   correctly in every text editor, that search-and-replace
 *   tools handle, and that plain-text pipeline tools consume.
 *
 *   The alternative — rejecting `txt` with a "not supported"
 *   error — was considered and rejected. It would leave a
 *   preload method permanently inert, forcing every caller to
 *   know which of the three export extensions the pipeline
 *   actually supports. The one-line mapping here is friendlier
 *   to the caller and cheaper than a future session adding a
 *   third Python writer whose body would be identical to
 *   `export_md.py`'s.
 *
 *   A future session that wanted a genuine `.txt` exporter — one
 *   that strips Markdown markup before writing — would add
 *   `export_txt.py` to the Python side, add the `'txt'` value to
 *   `ExportFormat` in `exportService.ts`, and change the mapping
 *   below from `'md'` to `'txt'`. The current design is a
 *   forward-compatible stand-in for that session.
 *
 * ── The Save-As dialog ─────────────────────────────────────────
 *
 *   Each handler opens a native Save-As dialog via Electron's
 *   `dialog.showSaveDialog`. The dialog is invoked with:
 *
 *     * A `defaultPath` that suggests a sensible filename — the
 *       article's title slugged into a filename-safe form,
 *       placed in the user's Documents folder. The user can
 *       navigate anywhere from the dialog; the default is a
 *       starting point, not a constraint.
 *
 *     * A `filters` array that names the format's extension so
 *       the OS dialog offers the right "Save as type" dropdown.
 *
 *     * A `title` string that names the operation in the dialog's
 *       window title bar.
 *
 *   A cancelled dialog (the user closed the window, clicked
 *   Cancel, or pressed Escape) produces `{ canceled: true }`
 *   from `showSaveDialog`. The handlers convert that case into
 *   a successful response with `data: null` — the preload's
 *   `Promise<ApiResponse<string | null>>` return type already
 *   declares the `null` case, and the renderer treats `null` as
 *   "the user cancelled" rather than as a failure.
 *
 * ── Why the handler fetches the Article from the backend ───────
 *
 *   Same situation as `validationIPC.ts`: the preload's
 *   `export.*` methods take a single `articleId` argument, and
 *   from that ID alone this handler cannot compute a local file
 *   path. The on-disk layout is keyed on the TOPIC's ID, and the
 *   only link between an article and its topic is the `topicId`
 *   field on the Article record, which lives on the backend.
 *
 *   The handler therefore performs a single GET to the backend's
 *   `/api/articles/:id` endpoint to learn the topic ID, then
 *   computes the topic's `article/` folder and locates the latest
 *   draft file. That draft's content is what the Python exporter
 *   writes to the user's chosen path.
 *
 *   The `Article` object the GET returns also carries a `content`
 *   field — the same Markdown the local draft holds. A future
 *   session that wanted to avoid the disk read could write the
 *   backend's content directly to a temporary file and pass that
 *   path to the Python exporter. The current design uses the
 *   local draft because the Python exporter expects a file path,
 *   and the local draft is already a file.
 *
 * ── What the handler does NOT do ───────────────────────────────
 *
 *   - It does not overwrite an existing file without the OS's
 *     permission. The native Save-As dialog prompts the user to
 *     confirm an overwrite by default; the handler inherits that
 *     behavior and does not need to re-implement it.
 *
 *   - It does not persist the export anywhere in the backend. The
 *     exported file is a user-facing artifact that lives outside
 *     the app's data directory. The backend's Article record
 *     carries no knowledge of it.
 *
 *   - It does not distinguish the two formats at the handler
 *     level beyond the extension and the dialog configuration.
 *     The Python-side dispatcher (`main.py`'s `_run_export`) is
 *     what selects the correct writer module based on the
 *     `--format` argument.
 *
 * ── Error handling ─────────────────────────────────────────────
 *
 *   Every failure path — a missing `articleId`, an unreachable
 *   backend, a topic with no draft file, a Python script that
 *   exits non-zero — is converted into a `{ success: false,
 *   error }` envelope. No exception escapes the handlers.
 *
 * Dependencies: electron + Node stdlib + the sibling export
 * service + the shared axios client.
 */

import {
  ipcMain,
  dialog,
  app,
  type IpcMainInvokeEvent,
} from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  runExport,
  type ExportFormat,
} from '../services/exportService.js';
import { apiGet } from '../../shared/api/client.js';
import type {
  ApiResponse,
  Article,
} from '../../shared/types/index.js';

// ============================================================
//  Channel name constants
// ============================================================
//
// The three channel names are declared as constants so a future
// refactor that renames them (or a test that spies on them) has
// one place to change. The preload's `src/main/preload.ts`
// declares the same strings on the renderer side of the bridge —
// the two must stay in sync, but neither file imports from the
// other.

const CHANNEL_DOCX = 'export:docx';
const CHANNEL_MD = 'export:md';
const CHANNEL_TXT = 'export:txt';

// ============================================================
//  Layout constants
// ============================================================
//
// Same values `documentService.ts`, `writerIPC.ts`, and
// `validationIPC.ts` declare. See `writerIPC.ts`'s header for
// the rationale on the duplication.

const APP_SLUG = 'writespeare';
const TOPICS_SUBFOLDER = 'topics';
const ARTICLE_SUBFOLDER = 'article';
const MARKDOWN_EXTENSION = '.md';

// ============================================================
//  Helpers — path computation
// ============================================================

/**
 * Return the absolute path to a topic's `article/` folder.
 */
const getArticleFolder = (topicId: string): string => {
  return path.join(
    app.getPath('appData'),
    APP_SLUG,
    TOPICS_SUBFOLDER,
    topicId,
    ARTICLE_SUBFOLDER
  );
};

/**
 * Return the absolute path to the latest `.md` draft in a topic's
 * `article/` folder, or `null` when the folder is missing or
 * contains no `.md` file.
 *
 * Same logic as `validationIPC.ts`'s `findLatestDraft` — "latest"
 * is the lexically greatest filename, which matches the writer
 * step's zero-padded `draft-NN.md` naming and therefore the
 * temporal order of the drafts.
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

  const last = drafts[drafts.length - 1];
  if (last === undefined) {
    return null;
  }
  return path.join(articleFolder, last);
};

// ============================================================
//  Helpers — default filename
// ============================================================

/**
 * Slugify an article's title into a filename-safe form for the
 * Save-As dialog's default path.
 *
 * Same transformation the Python side's `core/utils.slugify`
 * applies to doc filenames: ASCII-only, lowercase, hyphen-
 * separated. The three differences from the Python function:
 *
 *   * The fallback is "article" rather than "untitled" — for a
 *     filename suggestion, "article.docx" reads better than
 *     "untitled.docx".
 *
 *   * The maximum length is shorter (60 characters) — Windows
 *     reserves a portion of its 260-character path budget for
 *     the user's chosen directory, and a long filename risks
 *     the dialog producing an invalid path on a deep folder.
 *
 *   * The slug is not run through a Windows-reserved-name
 *     check — the dialog will append an extension to the name,
 *     which sidesteps the reserved-name rejection for files
 *     like "CON" or "PRN".
 *
 * The function never throws. A title that produces an empty
 * slug — one composed entirely of punctuation, or of non-ASCII
 * characters that the ASCII encoding strips — falls back to the
 * literal "article".
 */
const slugifyTitle = (title: string): string => {
  const ascii = title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7E]/g, '');
  const lowered = ascii.toLowerCase();
  const hyphenated = lowered.replace(/[^a-z0-9]+/g, '-');
  const stripped = hyphenated.replace(/^-+|-+$/g, '');
  if (stripped.length === 0) {
    return 'article';
  }
  if (stripped.length > 60) {
    return stripped.slice(0, 60).replace(/-+$/, '');
  }
  return stripped;
};

// ============================================================
//  Helpers — dialog + draft resolution
// ============================================================

/**
 * The configuration for one Save-As invocation. Each of the
 * three export handlers builds one of these and passes it to
 * `promptForOutputPath`.
 */
interface DialogConfig {
  /** The dialog's window title. */
  title: string;
  /** The extension the OS dialog filters on, without a dot
   *  ("docx", "md", "txt"). */
  extension: string;
  /** The label shown in the OS dialog's "Save as type"
   *  dropdown. */
  filterLabel: string;
}

/**
 * Open a native Save-As dialog with the article's title as the
 * default filename, and return the user's chosen path — or
 * `null` when the dialog was cancelled.
 *
 * The default path is `<Documents>/<slug>.<extension>`, where
 * the slug is the article's title run through `slugifyTitle`.
 * A title that produced an empty slug falls back to "article".
 *
 * The dialog is anchored to the parent window when one is
 * available, so it behaves as a modal in the app rather than as
 * a free-floating window. A caller that reaches this handler
 * from a renderer that is not a window — a test harness — still
 * works, because the `BrowserWindow | undefined` anchor is
 * optional in Electron's API and this function passes
 * `undefined` when no window is available.
 */
const promptForOutputPath = async (
  config: DialogConfig,
  articleTitle: string
): Promise<string | null> => {
  const slug = slugifyTitle(articleTitle);
  const defaultPath = path.join(
    app.getPath('documents'),
    `${slug}.${config.extension}`
  );

  // Find the window the renderer is currently focused on. This
  // makes the dialog modal to that window — a standard desktop
  // behavior that keeps the user's other app windows responsive
  // while the modal is open. When no window is available, the
  // dialog opens free-standing.
  //
  // Electron's `dialog.showSaveDialog` has two overloads: one
  // that takes only the options object (free-standing dialog),
  // and one that takes a `BaseWindow` followed by the options
  // object (window-modal dialog). The two overloads are not
  // unified under a single signature whose first parameter
  // accepts `BaseWindow | undefined` — passing `parent ?? undefined`
  // as the first argument to a single call would not type-check
  // against either overload. The branch below is what selects
  // the correct overload for each case.
  const { BrowserWindow } = await import('electron');
  const windows = BrowserWindow.getAllWindows();
  const parent = windows[0];

  const dialogOptions = {
    title: config.title,
    defaultPath,
    filters: [
      { name: config.filterLabel, extensions: [config.extension] },
    ],
  };

  const result =
    parent !== undefined
      ? await dialog.showSaveDialog(parent, dialogOptions)
      : await dialog.showSaveDialog(dialogOptions);

  if (result.canceled || !result.filePath) {
    return null;
  }
  return result.filePath;
};

// ============================================================
//  Shared handler shape
// ============================================================

/**
 * The common body of the three export handlers.
 *
 * Each of the three public handlers is a one-line forward to
 * this function with a different `format` and `dialogConfig`.
 * The shared body:
 *
 *   1. Validates the `articleId` argument.
 *   2. Fetches the Article record to learn its topic ID.
 *   3. Resolves the latest local draft for that topic.
 *   4. Opens the Save-As dialog to obtain the output path.
 *   5. Calls `runExport` with the resolved arguments.
 *   6. Returns the output path on success, or `null` when the
 *      user cancelled the dialog.
 *
 * Never throws. Every failure is converted into an
 * `ApiResponse` envelope with `success: false`.
 */
const handleExport = async (
  articleId: unknown,
  format: ExportFormat,
  dialogConfig: DialogConfig
): Promise<ApiResponse<string | null>> => {
  // ---- Validate the argument ----
  if (
    typeof articleId !== 'string' ||
    articleId.trim().length === 0
  ) {
    return { success: false, error: 'articleId is required.' };
  }
  const trimmedArticleId = articleId.trim();

  // ---- Fetch the article to learn its topic ----
  const articleResult = await apiGet<Article>(
    `/articles/${encodeURIComponent(trimmedArticleId)}`
  );
  if (!articleResult.success || !articleResult.data) {
    return {
      success: false,
      error:
        articleResult.error ?? 'The article could not be found.',
    };
  }
  const article = articleResult.data;
  const topicId = article.topicId;

  // ---- Resolve the local draft ----
  const articlePath = await findLatestDraft(topicId);
  if (articlePath === null) {
    return {
      success: false,
      error:
        'No article draft was found on disk for this topic. ' +
        'Generate an article first, then export it.',
    };
  }

  // ---- Open the Save-As dialog ----
  // The `Article` type carries no `title` field — the title is a
  // property of the parent Topic, and the backend's `Article`
  // schema stores only the content, word count, and version. The
  // export IPC therefore has no topic object in scope from which
  // to read a real title, and it would be wasteful to fetch one
  // just to construct a filename hint.
  //
  // The dialog's default filename is derived from the article's
  // local draft path stem instead. A draft at
  // `<topicFolder>/article/draft-01.md` has the stem `draft-01`,
  // which is a stable, non-empty identifier that appears nowhere
  // else in the file system. If the stem is empty — a
  // hand-crafted path that ended in just `.md` — the fallback
  // "article" is the same string `slugifyTitle` produces when it
  // has nothing else to work with, so the naming stays
  // consistent.
  const draftStem = path.basename(
    articlePath,
    path.extname(articlePath)
  );
  const defaultNameHint = draftStem.length > 0 ? draftStem : 'article';

  let outputPath: string | null;
  try {
    outputPath = await promptForOutputPath(
      dialogConfig,
      defaultNameHint
    );
  } catch (err) {
    const message =
      err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: `Could not open the Save-As dialog: ${message}`,
    };
  }

  // A cancelled dialog is not an error. The renderer's caller
  // receives `{ success: true, data: null }` and treats the
  // null as "the user chose not to export".
  if (outputPath === null) {
    return { success: true, data: null };
  }

  // ---- Run the export ----
  let result;
  try {
    result = await runExport({
      topicId,
      format,
      articlePath,
      outputPath,
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: `Export failed: ${message}`,
    };
  }

  if (!result.success) {
    return {
      success: false,
      error: result.error ?? 'Export failed.',
    };
  }

  return { success: true, data: result.outputPath };
};

// ============================================================
//  registerExportIPC
// ============================================================

/**
 * Register the export feature's IPC handlers.
 *
 * Called once, from `main/index.ts`, inside the
 * `app.whenReady().then(...)` callback. The function is not
 * idempotent — `ipcMain.handle` refuses to register a second
 * handler for the same channel — matching the contract every
 * other feature's `register*IPC()` function follows.
 */
export const registerExportIPC = (): void => {
  // ---- export:docx ----
  ipcMain.handle(
    CHANNEL_DOCX,
    async (
      _event: IpcMainInvokeEvent,
      articleId: unknown
    ): Promise<ApiResponse<string | null>> =>
      handleExport(articleId, 'docx', {
        title: 'Export as Word document',
        extension: 'docx',
        filterLabel: 'Word Document',
      })
  );

  // ---- export:md ----
  ipcMain.handle(
    CHANNEL_MD,
    async (
      _event: IpcMainInvokeEvent,
      articleId: unknown
    ): Promise<ApiResponse<string | null>> =>
      handleExport(articleId, 'md', {
        title: 'Export as Markdown',
        extension: 'md',
        filterLabel: 'Markdown',
      })
  );

  // ---- export:txt ----
  // The `txt` export is mapped to the Markdown writer, with a
  // `.txt` default extension. See the file header's "The `txt`
  // channel and the format-mapping decision" section for the
  // full rationale.
  ipcMain.handle(
    CHANNEL_TXT,
    async (
      _event: IpcMainInvokeEvent,
      articleId: unknown
    ): Promise<ApiResponse<string | null>> =>
      handleExport(articleId, 'md', {
        title: 'Export as plain text',
        extension: 'txt',
        filterLabel: 'Plain Text',
      })
  );
};

// ============================================================
//  Default export
// ============================================================

/**
 * The registration function as the default export, matching the
 * convention used by every other IPC module in the codebase.
 * `main/index.ts` uses the named import
 * (`import { registerExportIPC } from ...`), so the default form
 * is a convenience rather than a load-bearing export.
 */
export default registerExportIPC;