/**
 * documentService — file-system layer for the documents feature.
 *
 * The main-process side of the documents feature. Its job is
 * narrow and specific: read the `.md` doc files the extraction
 * pipeline wrote into a topic's `sources/` folder, parse their
 * YAML frontmatter, and produce `Document`-shaped objects the
 * renderer can display. It also reads a single document's content
 * on demand and deletes a document file.
 *
 * ── Why this is a local-file reader and not a backend API ──────
 *
 *   The desktop app has two potential sources of document data:
 *   the `.md` files on the user's disk, and the Document records
 *   in MongoDB. This service reads the former, not the latter.
 *
 *   The plan's tree for the documents feature has no `api/`
 *   folder — no `documentsApi.ts` — and its annotation for this
 *   file reads "Reads .md files from disk". That is the entire
 *   specification, and it maps cleanly onto the user journey: the
 *   extraction stage produces files on disk, and the Documents
 *   list the user sees is those files. The backend's Document
 *   collection is a parallel store for a future server-side use
 *   case (search across a user's docs, sharing docs between
 *   machines) that is not part of the current journey; syncing
 *   the two stores is a decision the plan defers to a later
 *   session.
 *
 *   The consequence is a small contract the renderer must be
 *   aware of: the `Document` objects this service returns have
 *   some fields populated from the file's frontmatter and others
 *   synthesized locally. See the "Field synthesis" section below
 *   for the exact mapping.
 *
 * ── The on-disk layout ─────────────────────────────────────────
 *
 *   The extraction pipeline writes its doc files to:
 *
 *       <appData>/writespeare/topics/<topicId>/sources/<NNN-slug>.md
 *
 *   where `<appData>` is the OS's per-user application-data
 *   directory (Electron's `app.getPath('appData')`, which matches
 *   the `%APPDATA%` / `~/Library/Application Support` /
 *   `~/.config` triple the Python side uses via
 *   `core/file_io._app_data_root`). The path is constructed the
 *   same way here as it is on the Python side, and any change to
 *   one must be reflected in the other.
 *
 *   Each doc file's content is:
 *
 *       ---
 *       url: "https://example.com/page"
 *       title: "How to garden in a tiny apartment"
 *       platform: "reddit"
 *       word_count: 1847
 *       fetched_at: "2026-10-10T21:42:50Z"
 *       ---
 *
 *       <the extracted Markdown body, with no frontmatter>
 *
 *   The frontmatter format is what `core/file_io._build_frontmatter`
 *   produces — a small, hand-written YAML subset that escapes
 *   strings with a fixed set of rules and emits numbers, booleans,
 *   and nulls in their plain form. See `_parseFrontmatter` below
 *   for the parser that reverses that format, and see the Python
 *   module's `_yaml_scalar` for the serializer the parser is
 *   written against.
 *
 * ── Field synthesis ────────────────────────────────────────────
 *
 *   The shared `Document` interface declares eleven fields. The
 *   doc file's frontmatter carries five of them; the rest have to
 *   be synthesized from what the file system knows. The mapping:
 *
 *     _id          ← the file's absolute path (a stable local
 *                    identifier; also the value the caller passes
 *                    back to `readDocument` and `deleteDocument`)
 *     topicId      ← the `topicId` argument to `listDocuments`
 *     userId       ← an empty string (the main process does not
 *                    carry the authenticated user's identity into
 *                    the file system; a future session that needs
 *                    it would read it from the encrypted store)
 *     url          ← frontmatter `url`
 *     platform     ← frontmatter `platform`
 *     title        ← frontmatter `title`
 *     content      ← the file's body (everything after the
 *                    closing `---` line)
 *     wordCount    ← frontmatter `word_count`
 *     fetchedAt    ← frontmatter `fetched_at`
 *     createdAt    ← the file's birthtime as an ISO-8601 string
 *     updatedAt    ← the file's mtime as an ISO-8601 string
 *
 *   The three synthesized identity fields (`_id`, `userId`,
 *   `createdAt`, `updatedAt`) are populated with defensible
 *   defaults rather than left undefined, because the shared type
 *   declares them required. A future session that wants a richer
 *   `Document` — for example, one that reflects the backend's
 *   identity fields after a sync — would add a sync step at the
 *   end of `listDocuments` that replaces the synthesized values
 *   with the backend's. That change is a single block appended to
 *   this file.
 *
 * ── Why content is included in list results ────────────────────
 *
 *   The renderer's list view only needs metadata (title, URL,
 *   word count, platform badge) and not the body. But the
 *   `Document` interface declares `content: string` as a required
 *   field, and the preload's `list` signature returns
 *   `Document[]` — an array of complete documents. This service
 *   therefore reads each file's full body and includes it. For
 *   the sizes the pipeline deals with (tens of files, tens of
 *   kilobytes each) the cost is negligible, and the simplicity of
 *   returning a type-faithful object is worth more than the
 *   marginal bandwidth savings of a partial read.
 *
 *   A future session that wanted to optimize the list endpoint
 *   for large topics would split the `Document` interface into a
 *   summary and a full form, change the preload's `list`
 *   signature to return the summary, and have this function skip
 *   the file-body read. That refactor is out of scope today.
 *
 * ── Security: path validation ──────────────────────────────────
 *
 *   The `readDocument` and `deleteDocument` functions take a
 *   file path directly. The renderer receives that path from
 *   `listDocuments`, so in normal operation the path is always
 *   inside the app's own data directory. But a compromised
 *   renderer — an XSS-injected script, a malicious browser
 *   extension that somehow reaches the app's context — could
 *   call `window.electronAPI.documents.read('/etc/passwd')` and
 *   receive the file's contents in the reply.
 *
 *   To close that channel, both functions validate that the
 *   resolved path is inside `<appData>/writespeare/`. A path
 *   outside that prefix is rejected with an error before any
 *   file-system call runs. The check is cheap and it eliminates
 *   the whole class of arbitrary-file-read vulnerabilities — the
 *   only legitimate target of these functions is a doc file the
 *   pipeline wrote, and every doc file the pipeline writes lands
 *   under that prefix.
 *
 *   The check does not verify that the path is a `.md` file, that
 *   it lives in a specific topic's `sources/` folder, or that the
 *   caller owns the topic. Those are stronger checks, and a
 *   future session that wanted them would extend `isPathSafe` —
 *   but they require context (the topic ID, the authenticated
 *   user) that these two functions do not currently receive.
 *   The app-data prefix check is the strongest validation
 *   available at this level, and it is sufficient for the threat
 *   model.
 *
 * ── What this service does NOT do ──────────────────────────────
 *
 *   - It does not touch the backend. There is no POST to
 *     `/api/documents`, no fetch of the backend's Document list,
 *     no use of the shared axios client. See the "Why this is a
 *     local-file reader" section above for the rationale.
 *
 *   - It does not modify doc files. The extraction pipeline is
 *     the only writer; this service reads and (on delete)
 *     removes, but never edits.
 *
 *   - It does not parse the Markdown body. The body is returned
 *     as-is; the renderer's `react-markdown` component is what
 *     interprets it for display.
 *
 *   - It does not emit markers or IPC events. The documents
 *     feature is a request-response layer — the renderer asks
 *     for a list or a read and receives it. There is no progress
 *     to stream and no event to broadcast.
 *
 *   - It does not cache. Every call performs a fresh file-system
 *     read. The typical operation reads fewer than fifty small
 *     files, and the OS's page cache makes a repeat read cheap;
 *     a cache would add invalidation logic for no measurable
 *     gain.
 *
 * Dependencies: Node stdlib + electron. No external npm packages,
 * no backend API, no Python.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

import type { Document } from '../../shared/types/index.js';

// ============================================================
//  Constants
// ============================================================

/**
 * The app slug used as the top-level folder under the OS's
 * per-user application-data directory. Must match the Python
 * side's `core/file_io._APP_SLUG` and the desktop main process's
 * store slug — all three write to or read from paths that begin
 * with this segment.
 */
const APP_SLUG = 'writespeare';

/**
 * The subfolder under the app slug that holds every topic.
 * Matches `core/file_io._TOPICS_SUBFOLDER`.
 */
const TOPICS_SUBFOLDER = 'topics';

/**
 * The subfolder under a topic's folder that holds its doc files.
 * Matches `core/file_io._SOURCES_SUBFOLDER`.
 */
const SOURCES_SUBFOLDER = 'sources';

/**
 * The extension every doc file carries. Used to filter the
 * `readdir` results and to guard against reading non-Markdown
 * files that happen to live in the sources folder.
 */
const MARKDOWN_EXTENSION = '.md';

/**
 * The delimiter that brackets a doc file's frontmatter block.
 * The format is `---\n<key>: <value>\n...\n---\n<body>` — see
 * the file header for the full layout.
 */
const FRONTMATTER_DELIMITER = '---';

// ============================================================
//  Path helpers
// ============================================================

/**
 * Return the absolute path to a topic's `sources/` folder.
 *
 * The path is `<appData>/writespeare/topics/<topicId>/sources`.
 * It is computed the same way on the Python side (see
 * `core/file_io.get_sources_folder`), so a doc file written by
 * the extractor lands exactly where this function looks for it.
 *
 * The function does NOT create the folder — reading a
 * non-existent folder is a legitimate case (a topic whose
 * extraction has not run yet), and the caller
 * (`listDocuments`) handles the resulting ENOENT by returning an
 * empty list. A separate helper for creating the folder would
 * only be needed by a write operation, which this service does
 * not perform.
 */
const getSourcesFolder = (topicId: string): string => {
  return path.join(
    app.getPath('appData'),
    APP_SLUG,
    TOPICS_SUBFOLDER,
    topicId,
    SOURCES_SUBFOLDER
  );
};

/**
 * Return the absolute path to the app's own data root — the
 * folder that contains every topic the app has ever created.
 *
 * Used by `isPathSafe` as the prefix that every legitimate doc
 * file path must begin with. The check that consumes this
 * function is what keeps a compromised renderer from reading
 * arbitrary files; see the file header's "Security" section.
 */
const getAppDataRoot = (): string => {
  return path.join(app.getPath('appData'), APP_SLUG);
};

/**
 * Return true if a path resolves to a location inside the app's
 * data root.
 *
 * The check resolves both paths to absolute form (in case the
 * input contains `..` segments or is relative) and then compares
 * the resolved target against the resolved root, requiring the
 * target to begin with the root followed by a path separator.
 * The trailing separator is what prevents a path like
 * `.../writespeare-secret/file` from passing the check when the
 * root is `.../writespeare` — the strings share a prefix but the
 * target is not inside the root.
 *
 * The function is deliberately strict: a path that is exactly
 * the root is rejected (it is a directory, not a file), and a
 * path that resolves outside the root — even by a single
 * character — is rejected. The caller (`readDocument`,
 * `deleteDocument`) turns a `false` return into a thrown error
 * before any file-system call runs.
 *
 * The check does not follow symbolic links. A symlink inside the
 * app-data root that points outside it would pass this check.
 * The pipeline does not create symlinks, and closing the gap
 * would require an asynchronous `fs.realpath` call plus a second
 * prefix comparison — a change a future session can make in the
 * same shape as the current check if the app's data layout ever
 * gains symlinks.
 */
const isPathSafe = (filepath: string): boolean => {
  const root = getAppDataRoot();
  const resolvedTarget = path.resolve(filepath);
  const resolvedRoot = path.resolve(root);
  const rootWithSeparator = resolvedRoot + path.sep;
  return resolvedTarget.startsWith(rootWithSeparator);
};

// ============================================================
//  Frontmatter parsing
// ============================================================

/**
 * Parse a doc file's raw text into its frontmatter metadata and
 * its body.
 *
 * The function recognizes the format `core/file_io._build_frontmatter`
 * writes: a leading `---\n` line, a sequence of `key: value`
 * lines, a closing `---\n` line, and the body. A file with no
 * leading `---\n` is treated as having no frontmatter — the
 * entire text is the body and the metadata is empty.
 *
 * The line endings are normalized to `\n` before parsing, so a
 * file written on Windows (which Python's `Path.write_text`
 * produces with CRLF endings) parses identically to a file
 * written on Linux or macOS.
 *
 * Values are parsed by `_parseScalar`, which reverses the
 * escaping that `core/file_io._yaml_scalar` applies. See that
 * function for the exact rules.
 *
 * Never throws for any input. A malformed frontmatter block —
 * an opening `---` with no closing delimiter, a line without a
 * colon, a key that is empty after trimming — is handled by
 * treating the affected line as missing and continuing. The
 * caller receives a `metadata` object that may be missing keys,
 * which is a legitimate state (a doc file written by an older
 * version of the pipeline may lack a field), and a body that is
 * the entire input if no closing delimiter was found.
 *
 * @param raw - The file's raw text, as read from disk.
 * @returns The parsed metadata and the file's body.
 */
const parseFrontmatter = (
  raw: string
): { metadata: Record<string, unknown>; body: string } => {
  // Normalize line endings so CRLF files parse the same way.
  const normalized = raw.replace(/\r\n/g, '\n');

  // No opening delimiter means no frontmatter at all.
  if (!normalized.startsWith(`${FRONTMATTER_DELIMITER}\n`)) {
    return { metadata: {}, body: raw };
  }

  // Find the closing delimiter. Search from just after the
  // opening delimiter's line, so a `---` that happens to be the
  // first character of the frontmatter itself (unusual but
  // legal — a comment line starting with three dashes) does not
  // terminate the block prematurely.
  const afterOpening = normalized.slice(
    FRONTMATTER_DELIMITER.length + 1
  );
  const closingIndex = afterOpening.indexOf(
    `\n${FRONTMATTER_DELIMITER}\n`
  );
  if (closingIndex === -1) {
    // No closing delimiter — treat the whole input as body.
    return { metadata: {}, body: raw };
  }

  const frontmatterText = afterOpening.slice(0, closingIndex);
  // The body starts two characters after the closing delimiter's
  // newline — one for the `\n` before the closing `---`, one for
  // the `\n` after it.
  const body = afterOpening.slice(
    closingIndex + 1 + FRONTMATTER_DELIMITER.length + 1
  );

  // Parse the key-value lines.
  const metadata: Record<string, unknown> = {};
  for (const line of frontmatterText.split('\n')) {
    if (line.length === 0) continue;
    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) continue;
    const key = line.slice(0, colonIndex).trim();
    if (key.length === 0) continue;
    const valueText = line.slice(colonIndex + 1).trim();
    metadata[key] = parseScalar(valueText);
  }

  return { metadata, body };
};

/**
 * Parse a single frontmatter value string into its typed form.
 *
 * The escaping this function reverses is what
 * `core/file_io._yaml_scalar` applies: strings are wrapped in
 * double quotes with backslashes, quotes, newlines, and carriage
 * returns escaped; numbers, booleans, and null are emitted bare.
 * This function recognizes each case:
 *
 *   - A value wrapped in `"..."` is a string. The inner text is
 *     unescaped by a single regex replace that matches every
 *     backslash-escape sequence and rewrites it to its literal
 *     character. Unknown escapes (`\t`, `\u`, anything not in
 *     the small set the Python side produces) are preserved as
 *     the backslash followed by the character — a conservative
 *     choice that avoids mangling a string the parser does not
 *     understand.
 *
 *   - The bare word `true` / `false` / `null` is the
 *     corresponding boolean or null value.
 *
 *   - A bare sequence that parses as a finite number is that
 *     number. `Number('')` is `0` in JavaScript, so the empty
 *     string is checked explicitly and skipped.
 *
 *   - Anything else is returned as the trimmed string. This is
 *     the fallback for a value that was not quoted (contrary to
 *     the Python side's behavior) — a doc file written by a
 *     hand-edited or older version of the pipeline. Returning
 *     the string is the safest interpretation.
 *
 * Never throws.
 *
 * @param value - The value portion of a `key: value` line.
 * @returns The typed value.
 */
const parseScalar = (value: string): unknown => {
  // Quoted string.
  if (
    value.length >= 2 &&
    value.startsWith('"') &&
    value.endsWith('"')
  ) {
    const inner = value.slice(1, -1);
    return inner.replace(/\\(.)/g, (_match, char: string) => {
      if (char === '\\') return '\\';
      if (char === '"') return '"';
      if (char === 'n') return '\n';
      if (char === 'r') return '\r';
      // Unknown escape — keep the backslash and the character.
      return `\\${char}`;
    });
  }

  // Null.
  if (value === 'null') return null;

  // Booleans.
  if (value === 'true') return true;
  if (value === 'false') return false;

  // Numbers. The empty string must be checked first: `Number('')`
  // is `0`, and a `key:` line with nothing after the colon should
  // not produce a zero.
  if (value.length > 0) {
    const numeric = Number(value);
    if (!Number.isNaN(numeric) && Number.isFinite(numeric)) {
      return numeric;
    }
  }

  // Fallback: an unquoted string.
  return value;
};

// ============================================================
//  Document synthesis
// ============================================================

/**
 * Read one doc file and synthesize a `Document` object from its
 * contents and file-system metadata.
 *
 * Returns `null` when the file cannot be read (an ENOENT from a
 * race with a concurrent delete, a permissions error, a file
 * that was replaced by a directory between the `readdir` call
 * and this read). The caller (`listDocuments`) skips null results
 * rather than aborting the whole listing — a single unreadable
 * file should not hide the other documents.
 *
 * The returned object's fields are a mix of parsed frontmatter
 * and file-system metadata. See the file header's "Field
 * synthesis" section for the full mapping.
 *
 * Never throws.
 *
 * @param topicId  - The topic's ID, from the caller.
 * @param filepath - The absolute path to the doc file.
 * @returns The synthesized `Document`, or `null` when the file
 *          could not be read.
 */
const synthesizeDocument = async (
  topicId: string,
  filepath: string
): Promise<Document | null> => {
  let raw: string;
  let stats: Awaited<ReturnType<typeof fs.stat>>;
  try {
    [raw, stats] = await Promise.all([
      fs.readFile(filepath, 'utf-8'),
      fs.stat(filepath),
    ]);
  } catch {
    return null;
  }

  const { metadata, body } = parseFrontmatter(raw);

  // Read each frontmatter field with a sensible fallback. The
  // Python side always writes all five, so a missing field
  // indicates a hand-edited or older file. The fallbacks keep
  // the resulting Document well-formed rather than throwing.
  const url =
    typeof metadata['url'] === 'string' ? metadata['url'] : '';
  const title =
    typeof metadata['title'] === 'string' ? metadata['title'] : '';
  const platform =
    typeof metadata['platform'] === 'string'
      ? metadata['platform']
      : 'generic';
  const wordCount =
    typeof metadata['word_count'] === 'number'
      ? metadata['word_count']
      : 0;
  const fetchedAt =
    typeof metadata['fetched_at'] === 'string'
      ? metadata['fetched_at']
      : stats.mtime.toISOString();

  // The `createdAt` and `updatedAt` fields are populated from
  // the file's own timestamps. `birthtime` is the more accurate
  // "created at" on the platforms that support it; on older
  // systems without birthtime support, Node returns `ctime`
  // instead, which is a reasonable substitute.
  const createdAt = stats.birthtime.toISOString();
  const updatedAt = stats.mtime.toISOString();

  return {
    _id: filepath,
    topicId,
    userId: '',
    url,
    platform,
    title,
    content: body,
    wordCount,
    fetchedAt,
    createdAt,
    updatedAt,
  };
};

// ============================================================
//  Public API — listDocuments
// ============================================================

/**
 * List every doc file in a topic's `sources/` folder, synthesized
 * into `Document` objects.
 *
 * Flow:
 *
 *   1. Compute the sources folder path from the topic ID.
 *   2. Read the folder's entries. A missing folder (a topic whose
 *      extraction has not run yet, a topic the user has never
 *      opened on this machine) is caught and treated as an empty
 *      list — the caller receives an empty array, not an error.
 *   3. Filter to `.md` files. Any other file in the folder — a
 *      `.tmp` left behind by an interrupted write, a stray
 *      `.DS_Store` on macOS, the user's own notes file — is
 *      ignored.
 *   4. Sort the entries by filename. The extraction pipeline
 *      names its doc files with a zero-padded index
 *      (`001-reddit-...`, `002-quora-...`), so a lexical sort
 *      reproduces the order the user saw in the candidate list.
 *   5. Read each file and synthesize a `Document`. A file that
 *      cannot be read is skipped with a warning logged to the
 *      main-process console; the other files are returned.
 *
 * The returned array preserves the sort order from step 4.
 * `readdir` on every platform Node supports returns names, not
 * full paths, so the folder path is prepended to each entry
 * before the read.
 *
 * @param topicId - The topic whose documents to list.
 * @returns The list of documents. Empty if the folder does not
 *          exist or contains no `.md` files. Never throws for a
 *          missing folder.
 */
export const listDocuments = async (
  topicId: string
): Promise<Document[]> => {
  if (!topicId || topicId.trim().length === 0) {
    return [];
  }

  const sourcesFolder = getSourcesFolder(topicId);

  let entries: string[];
  try {
    entries = await fs.readdir(sourcesFolder);
  } catch (err) {
    // ENOENT (no such folder) is the expected "topic has no docs
    // yet" case. Any other error (permissions, path is a file,
    // I/O failure) is logged and treated the same way — the
    // caller sees an empty list rather than a thrown error,
    // because the operation's contract is "return what exists"
    // and a missing or unreadable folder has nothing to return.
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      console.warn(
        `[documentService] could not read ${sourcesFolder}:`,
        err
      );
    }
    return [];
  }

  // Filter to Markdown files and sort lexically. The sort is
  // stable and locale-independent — `localeCompare` would tie
  // the order to the user's system locale, which would make the
  // document list order differ from the extraction order on
  // some machines.
  const markdownFiles = entries
    .filter((name) => name.endsWith(MARKDOWN_EXTENSION))
    .sort();

  const documents: Document[] = [];
  for (const name of markdownFiles) {
    const filepath = path.join(sourcesFolder, name);
    const doc = await synthesizeDocument(topicId, filepath);
    if (doc !== null) {
      documents.push(doc);
    }
  }

  return documents;
};

// ============================================================
//  Public API — readDocument
// ============================================================

/**
 * Read a single doc file's content.
 *
 * The `filepath` is expected to be one of the `_id` values the
 * caller received from a previous `listDocuments` call — the
 * functions are designed to be used as a pair, with the caller
 * holding a `Document` and passing its `_id` back to read its
 * content. The `filepath` is validated by `isPathSafe` before
 * any file-system call runs; a path outside the app's data
 * directory is rejected. See the file header's "Security"
 * section for the threat model.
 *
 * Returns the file's full content — frontmatter included. The
 * caller that wants only the body parses the frontmatter itself
 * or, more commonly, uses the `content` field the previous
 * `listDocuments` call already populated. This function exists
 * for the case where the caller wants a freshly-read copy — a
 * document that changed on disk after the list was fetched, a
 * document the user clicked "refresh" on, a diagnostic tool
 * inspecting a file directly.
 *
 * Throws on any failure:
 *
 *   - An empty or non-string path — a caller passing a value the
 *     preload's IPC bridge could not deliver.
 *   - A path that fails the `isPathSafe` check — see the file
 *     header for why this matters.
 *   - A file that cannot be read (ENOENT, EACCES, EISDIR). The
 *     error is propagated with the original code intact; the
 *     IPC handler that wraps this function is what converts it
 *     into a `{ success: false, error }` envelope for the
 *     renderer.
 *
 * @param filepath - The absolute path to the doc file.
 * @returns The file's full content as a UTF-8 string.
 * @throws  Error when the path is invalid or the file cannot be
 *          read.
 */
export const readDocument = async (
  filepath: string
): Promise<string> => {
  if (typeof filepath !== 'string' || filepath.length === 0) {
    throw new Error('readDocument: filepath must be a non-empty string.');
  }

  if (!isPathSafe(filepath)) {
    throw new Error(
      'readDocument: path is outside the app data directory.'
    );
  }

  return await fs.readFile(filepath, 'utf-8');
};

// ============================================================
//  Public API — deleteDocument
// ============================================================

/**
 * Delete a single doc file from disk.
 *
 * The `filepath` is expected to be one of the `_id` values the
 * caller received from a previous `listDocuments` call. It is
 * validated by `isPathSafe` before any file-system call runs,
 * for the same reason `readDocument` validates its argument.
 *
 * Does NOT delete the corresponding backend Document record —
 * this service does not touch the backend at all. See the file
 * header's "Why this is a local-file reader" section for the
 * rationale. A future session that adds backend sync would
 * extend this function to also call the backend's delete
 * endpoint; the change is a single await before the `fs.unlink`
 * call.
 *
 * Throws on any failure:
 *
 *   - An empty or non-string path.
 *   - A path that fails the `isPathSafe` check.
 *   - A file that cannot be removed (ENOENT, EACCES, EPERM). The
 *     error is propagated with its code intact; the IPC handler
 *     converts it into a `{ success: false, error }` envelope.
 *
 * The function does not treat "file does not exist" as success.
 * The caller asked to delete a specific file; if the file is
 * already gone, that is a state the caller should learn about —
 * typically because another part of the app deleted it in a race
 * — rather than a silent no-op. A future session that wants the
 * more lenient behavior would catch the ENOENT case here and
 * return normally.
 *
 * @param filepath - The absolute path to the doc file.
 * @throws  Error when the path is invalid or the file cannot be
 *          removed.
 */
export const deleteDocument = async (
  filepath: string
): Promise<void> => {
  if (typeof filepath !== 'string' || filepath.length === 0) {
    throw new Error(
      'deleteDocument: filepath must be a non-empty string.'
    );
  }

  if (!isPathSafe(filepath)) {
    throw new Error(
      'deleteDocument: path is outside the app data directory.'
    );
  }

  await fs.unlink(filepath);
};

// ============================================================
//  Default export
// ============================================================

/**
 * Every export bundled under one default object, matching the
 * convention of the sibling service modules (`searchService`,
 * `extractionService`, `chromeLauncher`, `childProcessManager`).
 * A caller that prefers named imports uses
 * `import { listDocuments } from ...`; a caller that prefers the
 * default form uses `import documentService from ...` and
 * destructures.
 */
export default {
  listDocuments,
  readDocument,
  deleteDocument,
};