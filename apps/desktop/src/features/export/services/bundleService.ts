/**
 * bundleService — assembles a topic's complete archive as a ZIP.
 *
 * The "Download bundle" flow's main-process worker. Given a
 * topic ID, a destination path, and a set of per-artifact
 * inclusion flags, this service reads the topic's on-disk
 * artifacts, optionally renders each validation report to a
 * human-readable Markdown companion, and writes a single ZIP
 * containing the four-folder structure the plan's user journey
 * promises:
 *
 *     <topic-slug>/
 *       README.txt         — explains what the ZIP contains
 *       article/           — the generated draft(s), in Markdown
 *       sources/           — the source documents, in Markdown
 *       reports/           — each report as raw JSON + rendered .md
 *       prompt/            — the prompt template the writer used
 *       preset/            — the topic's pipeline-config snapshot
 *       metadata/          — the topic's raw on-disk record
 *
 * The caller (`export:bundle` IPC handler in `exportIPC.ts`)
 * opens a Save-As dialog or reads the user's default destination
 * from settings, then invokes `runBundle` with the resolved path.
 * This service does not open dialogs; it writes to whatever path
 * it is given.
 *
 * ── Why `archiver` ─────────────────────────────────────────────
 *
 *   Node's standard library has no ZIP writer. `archiver` is the
 *   ecosystem standard: it supports streaming writes (so a large
 *   bundle does not have to be fully buffered in memory before
 *   the first byte reaches disk), it handles the ZIP central
 *   directory correctly on close, and its API accepts both file
 *   paths (`archive.file(...)`) and in-memory buffers
 *   (`archive.append(...)`). The two call styles matter here:
 *   the article, sources, and raw report JSON are already files
 *   on disk and are added by path; the README, the rendered
 *   reports, and the preset snapshot are computed strings and
 *   are appended from memory.
 *
 * ── Why reports are included twice ─────────────────────────────
 *
 *   Each report in `reports/` is a JSON file the Python validator
 *   wrote. The JSON is the authoritative, machine-readable form —
 *   a future script or tool can re-parse it. But a human
 *   reviewing an archive wants a readable summary, not a blob of
 *   nested JSON. The bundle therefore includes each report twice:
 *   the raw `.json` file unchanged, plus a `.md` file rendered
 *   from it by `renderReportMarkdown`. The two live side by side
 *   under `reports/`; the README explains the duplication.
 *
 * ── Why a missing optional artifact is not a failure ───────────
 *
 *   The user picks the artifacts to include via the modal's
 *   checkboxes. If they check "Include reports" on a topic that
 *   has never been validated, there are no reports to include.
 *   The correct behaviour is to write the ZIP without a
 *   `reports/` folder, not to fail the operation. The same
 *   applies to every artifact: a folder that has no files is
 *   skipped silently, and the archive is written with whatever
 *   was found. The only failures that produce a `success: false`
 *   result are:
 *
 *     * Invalid arguments (empty `topicId`, empty `outputPath`,
 *       a `topicId` containing path-separator characters).
 *     * A topic folder that does not exist on disk.
 *     * An output path that cannot be opened for writing.
 *     * An unrecoverable error from the archiver itself
 *       (mid-write disk failure, an unhandled stream error).
 *
 * ── The path-safety contract for `topicId` ─────────────────────
 *
 *   The caller passes a topic ID that originated in the renderer.
 *   That ID flows through the authenticated session and the
 *   backend's records, so it is trusted — but a defensive check
 *   is cheap and closes the small class of "path traversal via
 *   a malformed ID" bugs. The service rejects any `topicId` that
 *   is empty, is `"."` or `".."`, or contains a path separator
 *   (`/` or `\`). This does not weaken the service's ability to
 *   handle a legitimate Mongo ObjectId; it only rejects inputs
 *   that could never be a legitimate one.
 *
 * ── What this service does NOT do ──────────────────────────────
 *
 *   - It does not open a Save-As dialog. That is the IPC
 *     handler's job; by the time `runBundle` runs, the
 *     destination path is known.
 *
 *   - It does not fetch anything from the backend. Every
 *     artifact it bundles is on disk in the topic's folder. The
 *     preset snapshot is reconstructed from the topic's own
 *     `topic.json`, which is the topic's record of the
 *     configuration it was created with — more accurate than
 *     re-fetching the current preset from the backend, since
 *     presets can be edited after a topic is created.
 *
 *   - It does not delete or modify any source file. Every read
 *     is a plain `fs.readFile` or `archive.file` call; the
 *     service is a pure producer of one new artifact, the
 *     output ZIP.
 *
 *   - It does not return the manifest of what was included. The
 *     caller learns what was bundled by inspecting the ZIP, and
 *     the README inside it names each folder. A future session
 *     that wanted a programmatic manifest could add an
 *     `included: string[]` field to the result type; today the
 *     caller's needs are met by the file existing.
 *
 * Dependencies: electron + Node stdlib + `archiver` + the
 * sibling `reportRenderer.ts`. `archiver` and `@types/archiver`
 * are declared as part of this same PR (see the package.json
 * modification listed under PR-5 in the manifest).
 */

import { app } from 'electron';
import { createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import archiver from 'archiver';

import {
  renderReportMarkdown,
  type OnDiskReport,
} from './reportRenderer.js';

// ============================================================
//  Public types
// ============================================================

/**
 * The options `runBundle` accepts.
 *
 * The six `include*` flags correspond one-to-one with the six
 * checkboxes the `DownloadBundleModal` renders. A `false` flag
 * means "do not include this artifact in the archive"; a `true`
 * flag means "include it if it exists".
 */
export interface BundleServiceOptions {
  /** The topic whose artifacts to bundle. */
  topicId: string;

  /** The absolute path to write the ZIP to. The caller (the
   *  `export:bundle` IPC handler) obtains this from a Save-As
   *  dialog or from the user's configured default download
   *  path. */
  outputPath: string;

  /** Include the topic's `article/` folder. */
  includeArticle: boolean;

  /** Include the topic's `sources/` folder. */
  includeSources: boolean;

  /** Include the topic's `reports/` folder, with each report
   *  rendered to a `.md` companion alongside its raw `.json`. */
  includeReports: boolean;

  /** Include the prompt template the topic's writer step used. */
  includePrompt: boolean;

  /** Include a snapshot of the topic's pipeline configuration
   *  (preset name, profile, word count target, source-count
   *  layout, keywords). */
  includePreset: boolean;

  /** Include the topic's raw `topic.json` record. */
  includeMetadata: boolean;
}

/**
 * The result of one `runBundle` call. Never thrown — the
 * function always resolves, and failures are reported via the
 * `success` / `error` fields.
 *
 * The `outputPath` field mirrors the caller-supplied path on
 * both success and failure. On success it names the file that
 * was written; on failure it echoes the path the caller asked
 * for so the caller can correlate the result with its request
 * without keeping the input around.
 */
export interface BundleServiceResult {
  /** True only when the ZIP was written to `outputPath`. */
  success: boolean;

  /** The path the caller asked to write to. */
  outputPath: string;

  /** A human-readable error message. Present whenever `success`
   *  is `false`. */
  error?: string;
}

// ============================================================
//  Constants
// ============================================================

/** The app slug used as the top-level folder under the user's
 *  application-data directory. Same value `documentService.ts`,
 *  `writerIPC.ts`, `validationIPC.ts`, `exportIPC.ts`, and
 *  `researchIPC.ts` use. */
const APP_SLUG = 'writespeare';

/** The subfolder under the app slug that holds every topic. */
const TOPICS_SUBFOLDER = 'topics';

/** The subfolder names for each artifact the service reads. */
const ARTICLE_SUBFOLDER = 'article';
const SOURCES_SUBFOLDER = 'sources';
const REPORTS_SUBFOLDER = 'reports';

/** The extension filters used when listing each folder. */
const MARKDOWN_EXTENSION = '.md';
const JSON_EXTENSION = '.json';

// ============================================================
//  ESM directory resolution
// ============================================================
//
//  The compiled file lives at
//  `<dist>/features/export/services/bundleService.js`. The
//  `__dirname` reconstruction below is used by
//  `getPromptsFolder` to resolve the dev-mode path to the
//  bundled prompt templates. ESM does not provide `__dirname`
//  as a global, so it is derived from `import.meta.url`.

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================
//  Path helpers
// ============================================================

/**
 * Return the absolute path to the topic's folder on disk.
 *
 * The layout matches what every other main-process module that
 * touches the topic folder uses: `<appData>/writespeare/topics/
 * <topicId>/`. The service does not check existence here —
 * `runBundle`'s validation step does, so a non-existent folder
 * produces a clear error before any archiver work happens.
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
 * Return the absolute path to the bundled prompt-templates
 * folder.
 *
 * In a packaged build, the folder is
 * `<resources>/scripts/prompts/` — matching the `extraResources`
 * block in `apps/desktop/package.json`. In a dev build, the
 * folder is `apps/desktop/src/resources/scripts/prompts/`,
 * computed relative to this file's compiled location.
 *
 * The two `..`-climbing paths are identical in shape to the
 * ones `childProcessManager.ts` and `chromeLauncher.ts` use to
 * find the scripts folder; the convention is that the desktop
 * app resolves its bundled resources the same way in every
 * module that needs them.
 */
const getPromptsFolder = (): string => {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'scripts', 'prompts');
  }
  return path.join(
    __dirname,
    '../../../..',
    'src',
    'resources',
    'scripts',
    'prompts'
  );
};

// ============================================================
//  Helpers — validation
// ============================================================

/**
 * Return true when the given string is a well-formed topic ID.
 *
 * The check rejects four classes of input, each of which would
 * produce an incorrect or dangerous `path.join` result:
 *
 *   - The empty string. A topic ID is never empty; an empty ID
 *     would collapse the topic folder to `<appData>/writespeare/
 *     topics/`, which is the parent of every topic.
 *
 *   - The strings `"."` and `".."` — path-navigation sentinels
 *     that would move the topic folder up a level in the tree.
 *
 *   - Any string containing `/` or `\`, either of which would
 *     let a caller craft a `topicId` that resolves outside the
 *     topics folder.
 *
 * A legitimate Mongo ObjectId (24 lowercase hex characters) or
 * the folder-name convention the app writes (`<slug>-<shortId>`)
 * both pass cleanly. The check is a safety rail, not a format
 * validator — it does not reject an unusual-but-legal ID, only
 * the inputs that could never be one.
 */
const isValidTopicId = (topicId: string): boolean => {
  if (topicId.length === 0) return false;
  if (topicId === '.') return false;
  if (topicId === '..') return false;
  if (topicId.includes('/')) return false;
  if (topicId.includes('\\')) return false;
  return true;
};

// ============================================================
//  Helpers — file reading
// ============================================================

/**
 * Read a JSON file and return its parsed value, or `null` when
 * the file does not exist or cannot be parsed.
 *
 * Never throws. A missing file (the topic has no `topic.json`
 * yet, or no report has been written) is a legitimate state;
 * a malformed file is a bug in whatever wrote it, not something
 * the caller can act on. Both collapse to `null`, which the
 * callers treat as "no data".
 */
const readJsonOrNull = async (filepath: string): Promise<unknown> => {
  try {
    const raw = await fs.readFile(filepath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

/**
 * Read the topic's `topic.json` file and return its parsed
 * object, or an empty object when the file is missing or
 * malformed.
 *
 * The empty-object fallback matters because every consumer of
 * the result treats absent fields the same way it treats
 * missing ones: a topic with no `title` gets the "Untitled
 * Topic" label, a topic with no `promptFile` gets the default
 * prompt, and so on. Returning an empty object keeps the
 * downstream consumers free of a null check.
 */
const readTopicJson = async (
  topicFolder: string
): Promise<Record<string, unknown>> => {
  const raw = await readJsonOrNull(path.join(topicFolder, 'topic.json'));
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  return {};
};

/**
 * List the files in a folder that carry the given extension,
 * sorted lexically, dotfiles excluded.
 *
 * Returns an empty array when the folder does not exist or
 * cannot be read. The dotfile filter is what keeps a macOS
 * `.DS_Store` (or a resource-fork `._foo.md` artifact) out of
 * the archive; the extension filter excludes the `.tmp` files
 * that `write_text_atomic` may leave behind if a previous write
 * was interrupted.
 *
 * The lexical sort is the correct order for every folder this
 * service reads: the pipeline's naming conventions
 * (`draft-01.md`, `001-reddit-*.md`, `report-draft-01.json`)
 * are all designed so that a lexical sort reproduces the
 * creation order.
 */
const listFilesIn = async (
  folder: string,
  extension: string
): Promise<string[]> => {
  try {
    const entries = await fs.readdir(folder);
    return entries
      .filter((name) => !name.startsWith('.') && name.endsWith(extension))
      .sort();
  } catch {
    return [];
  }
};

// ============================================================
//  Helpers — string formatting
// ============================================================

/**
 * Convert a topic title into a filename-safe slug.
 *
 * Same transformation the Python side's `core.utils.slugify`
 * applies to doc filenames and the same one `exportIPC.ts`
 * applies to the Save-As default filename: NFKD-normalize,
 * strip combining marks, ASCII-only, lowercase, runs of
 * non-alphanumeric characters collapsed to single hyphens,
 * leading and trailing hyphens removed, capped at 60 characters.
 *
 * The 60-character cap is a little under the Python side's 80,
 * chosen because this slug becomes the root folder name inside
 * the ZIP, and a longer root name pushes every entry inside the
 * archive further from the start of the path — which matters
 * for tools that display the entry list in a narrow pane.
 *
 * Returns the empty string for a title that produces no usable
 * slug — a title composed entirely of punctuation, or of
 * non-ASCII characters that the ASCII filter strips. The caller
 * substitutes the topic ID in that case; see `runBundle`.
 */
const slugify = (input: string): string => {
  const ascii = input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7E]/g, '');
  const lowered = ascii.toLowerCase();
  const hyphenated = lowered.replace(/[^a-z0-9]+/g, '-');
  const stripped = hyphenated.replace(/^-+|-+$/g, '');
  if (stripped.length === 0) {
    return '';
  }
  return stripped.slice(0, 60).replace(/-+$/, '');
};

// ============================================================
//  Helpers — README generation
// ============================================================

/**
 * Build the text of the archive's `README.txt`.
 *
 * The README is the archive's self-documentation. A collaborator
 * who receives the ZIP without any context should be able to
 * read this file first and understand what every folder contains
 * and why some folders may be absent.
 *
 * The text is plain ASCII with a simple "=" underline under the
 * title. Nothing in the README depends on the topic's specific
 * artifacts; the file is generated identically for every bundle,
 * with only the title, ID, and timestamp varying.
 */
const buildReadme = (
  topicTitle: string,
  topicId: string,
  generatedAt: string
): string => {
  return [
    'WriteSpeare — Topic Bundle',
    '==========================',
    '',
    `Topic:      ${topicTitle}`,
    `Topic ID:   ${topicId}`,
    `Generated:  ${generatedAt}`,
    '',
    'This archive contains the artifacts WriteSpeare produced for',
    'this topic, as selected when the bundle was downloaded.',
    '',
    'Folder structure',
    '----------------',
    '',
    'article/',
    '  The generated article draft(s), in Markdown format. The',
    '  highest-numbered draft is the current version.',
    '',
    'sources/',
    '  The source documents the article was written from — one',
    '  Markdown file per scraped page.',
    '',
    'reports/',
    '  The validation report(s) for the topic. Each report is',
    '  included twice: once as the raw JSON the validation step',
    '  wrote, and once as a rendered Markdown summary for human',
    '  reading.',
    '',
    'prompt/',
    '  The prompt template the writer step used to generate the',
    '  article.',
    '',
    'preset/',
    '  The pipeline-configuration snapshot the topic was created',
    '  with — preset name, profile, word-count target, source-count',
    '  layout, keywords. Reproducing a run with the same preset',
    '  and the same prompt should produce a similar article.',
    '',
    'metadata/',
    '  The topic\'s raw on-disk configuration record, exactly as',
    '  WriteSpeare stores it.',
    '',
    'Only the folders you selected when the bundle was downloaded',
    'are present. A folder whose checkbox was left unchecked is',
    'not in this archive.',
    '',
    'Generated by WriteSpeare.',
    '',
  ].join('\n');
};

// ============================================================
//  Helpers — preset snapshot
// ============================================================

/**
 * Extract the topic's pipeline-configuration snapshot from its
 * `topic.json`.
 *
 * The snapshot carries only the fields relevant to reproducing
 * the run: the preset name, the profile, the prompt file, the
 * word-count target, the source-count layout, and the keyword
 * list. Every other field on `topic.json` (the `_id`, the
 * `userId`, the timestamps, the runtime `status`) is
 * metadata about the record, not about the configuration, and
 * is deliberately excluded from the snapshot.
 *
 * A field that is absent from the input is absent from the
 * output — no key is written with a placeholder value. A
 * consumer that reads the snapshot and finds `wordCount`
 * missing knows the input did not carry it, which is a more
 * informative state than `wordCount: null`.
 */
const buildPresetSnapshot = (
  topicJson: Record<string, unknown>
): Record<string, unknown> => {
  const keys = [
    'preset',
    'profile',
    'promptFile',
    'wordCount',
    'sourceCount',
    'searchBuckets',
    'keywords',
  ];
  const snapshot: Record<string, unknown> = {};
  for (const key of keys) {
    if (topicJson[key] !== undefined) {
      snapshot[key] = topicJson[key];
    }
  }
  return snapshot;
};

// ============================================================
//  runBundle
// ============================================================

/**
 * Assemble and write the topic's bundle ZIP.
 *
 * See the file header for the full flow, the four-folder
 * structure, and the reasoning behind the design choices.
 *
 * The function never rejects — a failure is reported via the
 * resolved result's `success: false` and `error` fields,
 * matching the pattern established by the sibling services
 * (`searchService.runSearch`, `writerService.runGenerate`,
 * `exportService.runExport`).
 *
 * The `outputPath` is echoed on both success and failure so
 * the caller has a single field to correlate the result with
 * its request, whether the operation succeeded or not.
 *
 * The `outputPath` is chosen by the caller (the `export:bundle`
 * IPC handler, which opens a Save-As dialog or reads the user's
 * configured default). This function does not prompt for a
 * path; by the time it runs, the destination is known.
 */
export const runBundle = async (
  options: BundleServiceOptions
): Promise<BundleServiceResult> => {
  // ---- 1. Validate the arguments ----
  // Two classes of input are rejected before any filesystem
  // work happens: an invalid topic ID (empty, path-navigating,
  // or path-separator-containing) and an empty output path.
  // Both would produce a confusing downstream error if allowed
  // through.
  if (
    typeof options.topicId !== 'string' ||
    !isValidTopicId(options.topicId)
  ) {
    return {
      success: false,
      outputPath: '',
      error: 'A valid topicId is required.',
    };
  }
  if (
    typeof options.outputPath !== 'string' ||
    options.outputPath.length === 0
  ) {
    return {
      success: false,
      outputPath: '',
      error: 'An output path is required.',
    };
  }

  // ---- 2. Compute the topic folder and verify it exists ----
  // A topic folder that is missing or that is not a directory is
  // a hard error: the caller asked to bundle something that is
  // not there, and the correct response is a specific message
  // rather than a ZIP with only a README.
  const topicFolder = getTopicFolder(options.topicId);
  try {
    const stat = await fs.stat(topicFolder);
    if (!stat.isDirectory()) {
      return {
        success: false,
        outputPath: options.outputPath,
        error: `Topic folder is not a directory: ${topicFolder}`,
      };
    }
  } catch {
    return {
      success: false,
      outputPath: options.outputPath,
      error: `Topic folder does not exist: ${topicFolder}`,
    };
  }

  // ---- 3. Read the topic's metadata ----
  // `topic.json` is optional in the sense that the bundle can
  // still be written without it — a topic whose file was
  // deleted by hand still has its article and sources. But the
  // bundle's README needs a title and its folder name needs a
  // slug, so a missing or malformed `topic.json` falls back to
  // an empty object and the derived strings use their own
  // fallbacks below.
  const topicJson = await readTopicJson(topicFolder);

  const rawTitle = topicJson['title'];
  const topicTitle =
    typeof rawTitle === 'string' && rawTitle.length > 0
      ? rawTitle
      : 'Untitled Topic';

  // The root folder name inside the ZIP. A slug of the title
  // is the preferred form; the topic ID is the fallback when
  // the title does not produce a usable slug (a title made
  // entirely of punctuation, or of non-ASCII characters that
  // the ASCII filter strips).
  const titleSlug = slugify(topicTitle);
  const rootFolder = titleSlug.length > 0 ? titleSlug : options.topicId;

  // The prompt file the writer used. A missing `promptFile` on
  // `topic.json` falls back to the default template, matching
  // the writer pipeline's own default.
  const rawPromptFile = topicJson['promptFile'];
  const promptFile =
    typeof rawPromptFile === 'string' && rawPromptFile.length > 0
      ? rawPromptFile
      : 'default.md';

  // ---- 4. Read every file list up front ----
  // The archiver's API expects additions to be synchronous once
  // the archive is started, so all asynchronous I/O is
  // performed here, before the archiver is opened. This is
  // also where a missing optional artifact is quietly reduced
  // to an empty array — see the file header for why a missing
  // artifact is not a failure.
  const drafts = options.includeArticle
    ? await listFilesIn(
        path.join(topicFolder, ARTICLE_SUBFOLDER),
        MARKDOWN_EXTENSION
      )
    : [];
  const sources = options.includeSources
    ? await listFilesIn(
        path.join(topicFolder, SOURCES_SUBFOLDER),
        MARKDOWN_EXTENSION
      )
    : [];
  const reportNames = options.includeReports
    ? await listFilesIn(
        path.join(topicFolder, REPORTS_SUBFOLDER),
        JSON_EXTENSION
      )
    : [];

  // Each report is read once here and reused for both the raw
  // JSON addition and the Markdown rendering. The `data` field
  // is `unknown` because `readJsonOrNull` does not narrow the
  // parsed value; the narrow check below casts to
  // `OnDiskReport` only when the value is a plain object.
  const reports: Array<{ name: string; data: unknown }> = [];
  for (const name of reportNames) {
    const data = await readJsonOrNull(
      path.join(topicFolder, REPORTS_SUBFOLDER, name)
    );
    reports.push({ name, data });
  }

  // The prompt template's path is resolved and its existence
  // checked up front. A prompt file that does not exist is
  // skipped silently — the same reasoning as a missing
  // artifact folder — rather than failing the whole bundle.
  const promptPath = path.join(getPromptsFolder(), promptFile);
  let promptExists = false;
  if (options.includePrompt) {
    try {
      await fs.access(promptPath);
      promptExists = true;
    } catch {
      promptExists = false;
    }
  }

  // ---- 5. Open the archiver and the output stream ----
  // The output stream is created and the archiver piped to it
  // before any additions, so that the first byte of the ZIP
  // header reaches disk as soon as the archive starts producing
  // output. Nothing is buffered in memory beyond the strings
  // the archiver itself holds.
  const output = createWriteStream(options.outputPath);
  const archive = archiver('zip', { zlib: { level: 9 } });

  // The two failure signals and the one success signal are
  // captured in a single promise that the function awaits. Any
  // of the three resolves the promise; the `state.writeFailed`
  // check below distinguishes the two failure cases from the
  // success case.
  //
  // The error is held as a property on a `const` object rather
  // than as a `let` variable. TypeScript's control-flow analysis
  // does not see assignments made inside a callback closure when
  // deciding what a local `let` variable's type is at a later
  // read site — it flow-narrows the read back to the variable's
  // last visible assignment in the surrounding scope, which for
  // a `let` initialised to `null` and never reassigned in that
  // scope is `null`. Holding the value as a property of a
  // `const` object sidesteps the narrowing entirely: property
  // reads are evaluated against the object's declared property
  // type, not against the current scope's flow state.
  //
  // This pattern removes the need for any `as` cast at the read
  // site. The previous code used `(writeFailed as Error | null)`
  // on the comparison and `(writeFailed as Error)` on the error
  // message; the second of those is what produced the TS 2352
  // error this edit fixes.
  const state: { writeFailed: Error | null } = { writeFailed: null };
  const done = new Promise<void>((resolve) => {
    archive.once('error', (err: Error) => {
      state.writeFailed = err;
      resolve();
    });
    output.once('error', (err: Error) => {
      state.writeFailed = err;
      resolve();
    });
    output.once('close', () => {
      resolve();
    });
  });

  archive.pipe(output);

  // ---- 6. Add the README ----
  // Always the first entry. Its position at the top of the
  // archive means a user who extracts the ZIP sees the README
  // first in a file manager that preserves archive order.
  const generatedAt = new Date().toISOString();
  archive.append(buildReadme(topicTitle, options.topicId, generatedAt), {
    name: `${rootFolder}/README.txt`,
  });

  // ---- 7. Add the article drafts ----
  // Each `.md` file in `article/` is added by path. `archive.file`
  // reads the file lazily as the archiver streams to output, so
  // a large draft does not have to be held in memory.
  for (const name of drafts) {
    archive.file(path.join(topicFolder, ARTICLE_SUBFOLDER, name), {
      name: `${rootFolder}/article/${name}`,
    });
  }

  // ---- 8. Add the sources ----
  for (const name of sources) {
    archive.file(path.join(topicFolder, SOURCES_SUBFOLDER, name), {
      name: `${rootFolder}/sources/${name}`,
    });
  }

  // ---- 9. Add the reports ----
  // Each report is added twice: the raw JSON by path, and the
  // rendered Markdown from memory. The rendering is wrapped in
  // a try/catch so a single report that fails to render (a
  // malformed JSON that parsed to the wrong shape, a renderer
  // bug on an unusual section) does not abort the whole bundle.
  // The raw JSON for that report is still included.
  for (const { name, data } of reports) {
    archive.file(
      path.join(topicFolder, REPORTS_SUBFOLDER, name),
      { name: `${rootFolder}/reports/${name}` }
    );
    if (
      typeof data === 'object' &&
      data !== null &&
      !Array.isArray(data)
    ) {
      try {
        const markdown = renderReportMarkdown(data as OnDiskReport);
        const mdName = name.replace(/\.json$/, '.md');
        archive.append(markdown, {
          name: `${rootFolder}/reports/${mdName}`,
        });
      } catch (err) {
        console.error(
          `[bundleService] could not render report ${name}:`,
          err
        );
      }
    }
  }

  // ---- 10. Add the prompt ----
  if (promptExists) {
    archive.file(promptPath, {
      name: `${rootFolder}/prompt/${promptFile}`,
    });
  }

  // ---- 11. Add the preset snapshot ----
  // The snapshot is built from the topic's own `topic.json`,
  // which is the topic's record of the configuration it was
  // created with. The snapshot is added even when `topicJson`
  // is empty — an empty snapshot (`{}`) is a valid, if
  // uninformative, record of "the topic had no configuration
  // fields on file".
  if (options.includePreset) {
    const snapshot = buildPresetSnapshot(topicJson);
    archive.append(JSON.stringify(snapshot, null, 2), {
      name: `${rootFolder}/preset/preset.json`,
    });
  }

  // ---- 12. Add the metadata ----
  if (options.includeMetadata) {
    archive.append(JSON.stringify(topicJson, null, 2), {
      name: `${rootFolder}/metadata/topic.json`,
    });
  }

  // ---- 13. Finalize and wait for the output stream to close ----
  // `archive.finalize()` returns a promise that resolves when
  // the archiver has produced its last byte; the output stream
  // then flushes and emits `close`. We wait on the promise
  // captured above, which resolves on `close` or on either
  // stream's `error`.
  try {
    void archive.finalize();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      outputPath: options.outputPath,
      error: `Could not finalize archive: ${message}`,
    };
  }

  await done;

  // `state.writeFailed` is typed `Error | null` at this read
  // site without any cast — see the comment on the `state`
  // declaration above for why the property form avoids the
  // flow-narrowing problem the previous `let`-variable form
  // had. The `!== null` check narrows the type to `Error` for
  // the property access inside the branch.
  if (state.writeFailed !== null) {
    return {
      success: false,
      outputPath: options.outputPath,
      error: `Could not write archive: ${state.writeFailed.message}`,
    };
  }

  return {
    success: true,
    outputPath: options.outputPath,
  };
};

// ============================================================
//  Default export
// ============================================================

/**
 * Every export bundled under one default object, matching the
 * convention of the sibling main-process services
 * (`searchService.ts`, `writerService.ts`, `exportService.ts`).
 * A caller that prefers named imports uses
 * `import { runBundle } from ...`; a caller that prefers the
 * default form uses `import bundleService from ...` and
 * destructures.
 */
export default {
  runBundle,
};