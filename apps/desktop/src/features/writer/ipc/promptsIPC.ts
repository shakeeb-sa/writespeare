/**
 * promptsIPC — IPC handlers for the writer feature's prompt
 * templates.
 *
 * Registers the five channels the renderer's
 * `window.electronAPI.prompts.*` methods invoke:
 *
 *   prompts:list      — return the filenames of every built-in
 *                       and user prompt template.
 *   prompts:read      — read one template's content, preferring
 *                       the user's copy over a built-in of the
 *                       same name.
 *   prompts:write     — create or overwrite a user template.
 *   prompts:delete    — remove a user template; a built-in with
 *                       the same name is refused.
 *   prompts:validate  — render a template with Jinja2 dummy
 *                       variables and report any syntax error
 *                       before the template is saved.
 *
 * ── The two-folder model ───────────────────────────────────────
 *
 *   Prompt templates live in two folders, following the
 *   same pattern the app already uses for Chrome profiles and
 *   for the topic folder layout:
 *
 *     BUILT-IN:   `<resources>/scripts/prompts/` (packaged)
 *                 `<repo>/src/resources/scripts/prompts/` (dev)
 *                 Read-only. Ships with the app. Cannot be
 *                 modified or deleted through the API.
 *
 *     USER:       `<appData>/writespeare/prompts/`
 *                 Read-write. Created on demand the first time a
 *                 user saves a prompt. Empty on a fresh install.
 *
 *   A user template with the same filename as a built-in
 *   shadows the built-in for every read path — the writer
 *   step, the Advanced Settings dropdown, and this module's own
 *   `read` handler. Deleting the user file reverts the app to
 *   the built-in immediately, with no further action required.
 *
 *   The `<appData>/writespeare/` root is the same root the
 *   topic folder layout uses (`<appData>/writespeare/topics/`).
 *   Using one root for every per-user artifact means a future
 *   "reset app data" operation has a single folder to remove,
 *   and it means the Python side's `core/file_io._app_data_root()`
 *   can compute the same user-prompts path with one string
 *   concatenation.
 *
 * ── Validation is delegated to a Python script ─────────────────
 *
 *   Jinja2 is a Python library. Rather than re-implement its
 *   parser in TypeScript — which would drift from the real
 *   renderer's behaviour the first time a template used an
 *   obscure filter or a whitespace-control marker — this module
 *   spawns the bundled `validate_prompt.py` script on a
 *   temporary file containing the content to be validated.
 *
 *   The script:
 *
 *     1. Reads the temporary file.
 *     2. Attempts to construct a Jinja2 `Template` from its
 *        contents and render it with a small set of dummy
 *        variables.
 *     3. Writes a single line of JSON to stdout, of the shape
 *        `{"valid": true}` on success or
 *        `{"valid": false, "error": "...", "line": N}` on a
 *        syntax error.
 *     4. Exits with code 0 on success, 1 on failure.
 *
 *   The TS handler reads the exit code and the stdout JSON,
 *   deletes the temporary file in a `finally`, and returns the
 *   result in the standard envelope. A script that fails to
 *   produce parseable JSON at all (an import error inside the
 *   script, a Python that did not start) is reported as a
 *   validation failure with a generic message, so the caller
 *   always receives a well-formed result.
 *
 * ── The temporary file's lifecycle ─────────────────────────────
 *
 *   Each validation call writes to a unique file under the OS's
 *   temp directory, named
 *   `writespeare-validate-<uuid>.md`. The UUID is what makes
 *   two concurrent validations safe: each call writes its own
 *   file, runs its own Python process, and removes its own file,
 *   with no possibility of one call observing another's content.
 *
 *   The cleanup runs in a `finally` block that wraps the
 *   validation call, so a validation that fails for any reason
 *   — a spawn error, a JSON parse error, an exception from the
 *   Python script — still leaves the temp directory clean. A
 *   cleanup that itself fails (a permission error, an antivirus
 *   lock) is swallowed; a leftover file in the temp directory
 *   is not a problem the caller needs to hear about, and the
 *   OS's own temp cleanup will remove it eventually.
 *
 * ── Path safety for prompt names ───────────────────────────────
 *
 *   The renderer supplies the name, and the name becomes part of
 *   a `path.join` on this side. A malicious renderer — one
 *   whose context was compromised by an extension, or by an XSS
 *   in a future feature that loads remote content — could send
 *   a name like `../../../etc/passwd` and read files outside
 *   the prompts folders. The `isValidPromptName` helper rejects
 *   that class of input before any `path.join` runs:
 *
 *     * The empty string (a name that is not a name).
 *     * `.` and `..` (the two path-navigation sentinels).
 *     * Any leading `.` (a dotfile; not a legitimate prompt
 *       filename).
 *     * Any `/` or `\` (a path separator; a prompt name is a
 *       bare filename, not a path).
 *     * Any NUL byte (a defensive check against a class of
 *       C-string-truncation attacks that do not apply to
 *       Node's UTF-8 path handling but cost one comparison to
 *       rule out).
 *
 *   The check does not restrict the extension. A user who wants
 *   their prompt named `my-style.txt` or `notes` may do so; the
 *   reader side treats every file in the folder as a prompt
 *   regardless of its extension. The check only rules out the
 *   inputs that could never be a legitimate bare filename.
 *
 * ── The delete handler's refusal to remove built-ins ───────────
 *
 *   The user-folder delete path is straightforward: `fs.unlink`
 *   the user file. The refusal path is the interesting one. When
 *   `fs.unlink` throws `ENOENT` — the user file does not exist —
 *   the handler checks whether a built-in with the same name
 *   exists. If it does, the handler returns an explicit
 *   `"Built-in prompts cannot be deleted."` message rather than
 *   a generic `"not found"`. The distinction matters: a user
 *   who clicked Delete on `default.md` (a built-in) gets a
 *   message that names the reason, not a message that reads as
 *   if the file had already been removed.
 *
 *   If neither a user file nor a built-in exists under the name,
 *   the handler returns a generic `"Prompt file not found."` —
 *   which is the honest answer for a name the renderer invented.
 *
 * ── Why this module duplicates the layout constants ────────────
 *
 *   The `APP_SLUG` constant and the `path.join(app.getPath('appData'), ...)`
 *   pattern are declared here, in `documentService.ts`, in
 *   `writerIPC.ts`, in `validationIPC.ts`, in `exportIPC.ts`, in
 *   `researchIPC.ts`, and in `bundleService.ts`. The duplication
 *   is deliberate — the same rationale the other files' headers
 *   give: the layout is a cross-file contract that every writer
 *   and reader of the topic folder must agree on, and a shared
 *   module that all seven files imported would be a new file the
 *   plan does not declare. A change to the app slug or the
 *   writespeare subfolder would touch all seven files and the
 *   Python side in the same commit, which is the correct amount
 *   of friction for a path convention that is part of the app's
 *   on-disk API.
 *
 * ── What this module does NOT do ───────────────────────────────
 *
 *   - It does not touch the writer store or any renderer-side
 *     state. The store is updated by the renderer's own
 *     `usePrompts` hook (Session 6, PR-6) from the envelopes
 *     this file returns.
 *
 *   - It does not implement a file watcher. If the user edits a
 *     prompt file on disk while the app is running, the change
 *     is visible the next time the app reads the file — a
 *     subsequent `prompts:read` call, or a subsequent writer
 *     run. There is no live refresh of the editor, and the
 *     plan does not call for one.
 *
 *   - It does not version prompt templates. Overwriting a user
 *     prompt is a plain file write; the previous content is
 *     not retained. A user who wants history can keep the
 *     previous version under a different name, or use their
 *     own version control on the prompts folder.
 *
 *   - It does not validate Jinja2 semantics beyond what the
 *     Python script reports. A template that renders successfully
 *     with dummy variables but produces the wrong output for the
 *     user's actual variables is a template the validator cannot
 *     catch; the writer step's own rendering will surface the
 *     problem on the first real run, and the user can fix the
 *     template then.
 *
 * Dependencies: electron + Node stdlib + the shared types module.
 * The spawned `validate_prompt.py` script is created in the same
 * PR (see the manifest's PR-6 block); until it exists on disk, the
 * `prompts:validate` channel returns a validation-failure envelope
 * with a message naming the missing script.
 */

import {
  app,
  ipcMain,
  type IpcMainInvokeEvent,
} from 'electron';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import type { ApiResponse } from '../../shared/types/index.js';

// ============================================================
//  Public types
// ============================================================

/**
 * The result of validating a prompt template's Jinja2 syntax.
 *
 * A discriminated union rather than a shape with optional
 * fields, so a caller cannot accidentally read `error` or
 * `line` from a successful validation. The two variants map
 * one-to-one to the two outcomes the Python validator script
 * can produce.
 *
 * The shape matches the `PromptValidationResult` type the
 * preload's `prompts.validate` method declares — the two must
 * stay in sync, and a future change to either side is a
 * coordinated edit.
 */
export type PromptValidationResult =
  | { valid: true }
  | { valid: false; error: string; line: number };

// ============================================================
//  Channel name constants
// ============================================================

const CHANNEL_LIST = 'prompts:list';
const CHANNEL_READ = 'prompts:read';
const CHANNEL_WRITE = 'prompts:write';
const CHANNEL_DELETE = 'prompts:delete';
const CHANNEL_VALIDATE = 'prompts:validate';

// ============================================================
//  Layout constants
// ============================================================

/**
 * The app slug used as the top-level folder under the OS's
 * per-user application-data directory. Same value the sibling
 * main-process modules use, and the same value the Python
 * side's `core/file_io._APP_SLUG` uses.
 */
const APP_SLUG = 'writespeare';

/**
 * The subfolder under the app slug that holds every user
 * prompt template. Paired with `TOPICS_SUBFOLDER` in the
 * sibling modules — every per-user artifact the app writes
 * lives under one of these two subfolders.
 */
const PROMPTS_SUBFOLDER = 'prompts';

// ============================================================
//  Path helpers
// ============================================================

/**
 * Return the absolute path to the user's prompts folder.
 *
 * The folder is not created by this helper — creation happens
 * on the first write. A list or read on a fresh installation
 * sees a missing folder and treats it as empty, which is the
 * correct reading for a folder that has never been populated.
 */
const getUserPromptsFolder = (): string => {
  return path.join(app.getPath('appData'), APP_SLUG, PROMPTS_SUBFOLDER);
};

/**
 * Return the absolute path to the bundled prompts folder.
 *
 * In a packaged build, the folder is
 * `<resources>/scripts/prompts/` — matching the `extraResources`
 * block in `apps/desktop/package.json`. In a dev build, the
 * folder is `apps/desktop/src/resources/scripts/prompts/`,
 * computed relative to this file's compiled location
 * (`dist/features/writer/ipc/promptsIPC.js`, four levels below
 * the desktop app's root).
 *
 * The two `..`-climbing paths are identical in shape to the
 * ones `childProcessManager.ts` and `bundleService.ts` use to
 * find the scripts folder; the convention is that the desktop
 * app resolves its bundled resources the same way in every
 * module that needs them.
 */
const getBuiltinPromptsFolder = (): string => {
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

/**
 * Return the absolute path to the bundled `validate_prompt.py`
 * script. Same packaged-vs-dev split as `getBuiltinPromptsFolder`.
 */
const getValidatePromptScriptPath = (): string => {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'scripts', 'validate_prompt.py');
  }
  return path.join(
    __dirname,
    '../../../..',
    'src',
    'resources',
    'scripts',
    'validate_prompt.py'
  );
};

/**
 * Return the Python interpreter's absolute path (packaged) or
 * the bare binary name (dev).
 *
 * Same resolution rule as `childProcessManager.ts` uses: in a
 * packaged build, the interpreter is under the app's own
 * `resources/python/` folder; in a dev build, the developer's
 * `PATH` is expected to provide a working `python`.
 */
const getPythonExecutable = (): string => {
  if (app.isPackaged) {
    if (process.platform === 'win32') {
      return path.join(process.resourcesPath, 'python', 'python.exe');
    }
    if (process.platform === 'darwin' || process.platform === 'linux') {
      return path.join(process.resourcesPath, 'python', 'bin', 'python3');
    }
    return path.join(process.resourcesPath, 'python', 'python');
  }
  return 'python';
};

// ============================================================
//  Validation helpers
// ============================================================

/**
 * Return true when the given string is a well-formed prompt
 * filename. See the file header's "path safety" section for the
 * full rationale on which inputs are rejected and why.
 */
const isValidPromptName = (name: string): boolean => {
  if (typeof name !== 'string') return false;
  if (name.length === 0) return false;
  if (name === '.') return false;
  if (name === '..') return false;
  if (name.startsWith('.')) return false;
  if (name.includes('/')) return false;
  if (name.includes('\\')) return false;
  if (name.includes('\0')) return false;
  return true;
};

/**
 * Return true when the given value is a usable content string.
 * A `null` or non-string content is rejected; an empty string
 * is allowed, because a template that is intentionally blank is
 * still a syntactically valid (if useless) Jinja2 template, and
 * the Python validator's own error will surface anything
 * downstream that depends on non-empty content.
 */
const isContentString = (value: unknown): value is string =>
  typeof value === 'string';

// ============================================================
//  Filesystem helpers
// ============================================================

/**
 * Read a file and return its content, or `null` when the file
 * does not exist or cannot be read. Never throws.
 *
 * A missing file is a legitimate state for every caller in this
 * module — a `read` on a name that resolves to no file, a
 * `list` on a folder that has never been created. Both collapse
 * to `null`, and the callers translate that into the correct
 * envelope.
 */
const readFileOrNull = async (filepath: string): Promise<string | null> => {
  try {
    return await fs.readFile(filepath, 'utf-8');
  } catch {
    return null;
  }
};

/**
 * List the filenames in a folder that are candidates for
 * prompt templates, sorted lexically. Returns an empty array
 * when the folder does not exist or cannot be read.
 *
 * The filter excludes dotfiles (a `.DS_Store` on macOS, a
 * `.gitkeep`) and directories are not enumerated — `readdir`
 * without `withFileTypes` returns names only, and a
 * subdirectory in the prompts folder is not a prompt. A future
 * session that wanted a more elaborate filter (extension-based,
 * say) would extend this function; today the simplest filter
 * that excludes the files the app never writes is the correct
 * one.
 */
const listPromptNames = async (folder: string): Promise<string[]> => {
  try {
    const entries = await fs.readdir(folder);
    return entries.filter((name) => !name.startsWith('.')).sort();
  } catch {
    return [];
  }
};

// ============================================================
//  Validation spawn
// ============================================================

/**
 * Run the bundled `validate_prompt.py` against a prompt file
 * and return its classification.
 *
 * Never throws — every failure mode (a missing Python, a
 * script that crashes before emitting JSON, a parse error on
 * the script's output) is converted into a `{ valid: false,
 * ... }` result with a descriptive message. The caller
 * (`prompts:validate`) wraps that result in the standard
 * envelope.
 *
 * The script's contract, which this function is written
 * against:
 *
 *   * Argv: `validate_prompt.py <prompt-file-path>`.
 *   * Stdout: on success, a single JSON line `{"valid": true}`;
 *     on failure, a single JSON line
 *     `{"valid": false, "error": "...", "line": N}`.
 *   * Exit code: 0 on success, 1 on any validation failure.
 *
 * The handler reads the exit code first — a non-zero exit is
 * authoritative even if the stdout JSON is missing or
 * malformed. A zero exit with unparseable stdout falls back to
 * a generic success, which is the safe reading: the script
 * completed cleanly, so the template is considered valid, and
 * the caller will find out quickly if a subsequent write
 * produces something the writer step cannot render.
 */
const runValidator = (promptPath: string): Promise<PromptValidationResult> => {
  return new Promise<PromptValidationResult>((resolve) => {
    let settled = false;
    const finish = (result: PromptValidationResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const pythonPath = getPythonExecutable();
    const scriptPath = getValidatePromptScriptPath();

    // The env vars mirror the ones `childProcessManager.ts` sets:
    // UTF-8 I/O, unbuffered stdout. The validator is a short
    // script that prints one line and exits; the unbuffered
    // flag matters less here than for the long-running pipeline
    // scripts, but keeping the environment identical across
    // every Python spawn in the app means there is one convention
    // for how Python runs.
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8',
      PYTHONUNBUFFERED: '1',
    };

    let child;
    try {
      child = spawn(pythonPath, [scriptPath, promptPath], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      finish({
        valid: false,
        error: `Could not start the validator: ${message}`,
        line: 0,
      });
      return;
    }

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });

    child.once('error', (err: Error) => {
      finish({
        valid: false,
        error: `Validator failed: ${err.message}`,
        line: 0,
      });
    });

    child.once('exit', (code: number | null) => {
      // The JSON result is the last non-empty line of stdout.
      // A script that printed a warning before the JSON, or a
      // traceback that happened to land on stdout instead of
      // stderr, would otherwise confuse the parse.
      const lines = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      const lastLine = lines[lines.length - 1] ?? '';

      let parsed: unknown = null;
      if (lastLine.length > 0) {
        try {
          parsed = JSON.parse(lastLine);
        } catch {
          parsed = null;
        }
      }

      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        !Array.isArray(parsed)
      ) {
        const obj = parsed as Record<string, unknown>;
        if (obj['valid'] === true) {
          finish({ valid: true });
          return;
        }
        if (obj['valid'] === false) {
          const errorText =
            typeof obj['error'] === 'string' && obj['error'].length > 0
              ? obj['error']
              : 'Prompt template is not valid Jinja2.';
          const lineNumber =
            typeof obj['line'] === 'number' && Number.isFinite(obj['line'])
              ? obj['line']
              : 0;
          finish({
            valid: false,
            error: errorText,
            line: lineNumber,
          });
          return;
        }
      }

      // Fall back to the exit code when the JSON parse did not
      // resolve. A zero exit is a success; a non-zero exit is a
      // failure whose message comes from stderr (or a generic
      // string when stderr is empty).
      if (code === 0) {
        finish({ valid: true });
        return;
      }
      const fallbackMessage =
        stderr.trim().length > 0
          ? stderr.trim().split(/\r?\n/).slice(-1)[0] ?? stderr.trim()
          : 'Prompt template validation failed.';
      finish({ valid: false, error: fallbackMessage, line: 0 });
    });
  });
};

/**
 * Validate a prompt template's content by writing it to a
 * temporary file, running the validator against the file, and
 * removing the file.
 *
 * The temporary file lives in the OS's temp directory, with a
 * name that carries a fresh UUID so that concurrent validations
 * cannot collide. The file is removed in a `finally` block so
 * that a validation which fails for any reason still cleans up
 * after itself.
 */
const validateContent = async (
  content: string
): Promise<PromptValidationResult> => {
  const tmpName = `writespeare-validate-${randomUUID()}.md`;
  const tmpPath = path.join(app.getPath('temp'), tmpName);

  try {
    await fs.writeFile(tmpPath, content, 'utf-8');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      valid: false,
      error: `Could not prepare validation: ${message}`,
      line: 0,
    };
  }

  try {
    return await runValidator(tmpPath);
  } finally {
    // Best-effort cleanup. A failure to remove the temp file is
    // swallowed — see the file header for the reasoning.
    try {
      await fs.unlink(tmpPath);
    } catch {
      /* swallow */
    }
  }
};

// ============================================================
//  registerPromptsIPC
// ============================================================

/**
 * Register the prompts feature's IPC handlers.
 *
 * Called once, from `main/index.ts`, inside the
 * `app.whenReady().then(...)` callback. The function is not
 * idempotent — `ipcMain.handle` refuses to register a second
 * handler for the same channel — matching the contract every
 * other feature's `register*IPC()` function follows.
 */
export const registerPromptsIPC = (): void => {
  // ---- prompts:list ----
  //
  // Returns the filenames of every prompt template in each of
  // the two folders. A missing folder contributes an empty
  // array; the renderer's editor displays the two groups
  // separately, and a group with no files shows its own empty
  // state.
  //
  // The result is a plain object with two `string[]` fields.
  // Both arrays are sorted lexically; the ordering convention
  // matches the file listing every other folder in the app
  // uses.
  ipcMain.handle(
    CHANNEL_LIST,
    async (): Promise<
      ApiResponse<{ builtin: string[]; user: string[] }>
    > => {
      const builtin = await listPromptNames(getBuiltinPromptsFolder());
      const user = await listPromptNames(getUserPromptsFolder());
      return { success: true, data: { builtin, user } };
    }
  );

  // ---- prompts:read ----
  //
  // Reads one template's content, preferring the user's copy
  // over a built-in with the same name — the two-folder rule
  // documented in the file header.
  //
  // Returns an error envelope when the name is not a valid
  // prompt filename, or when no file with that name exists in
  // either folder.
  ipcMain.handle(
    CHANNEL_READ,
    async (
      _event: IpcMainInvokeEvent,
      name: unknown
    ): Promise<ApiResponse<{ content: string }>> => {
      if (typeof name !== 'string' || !isValidPromptName(name)) {
        return { success: false, error: 'Invalid prompt name.' };
      }

      const userPath = path.join(getUserPromptsFolder(), name);
      const userContent = await readFileOrNull(userPath);
      if (userContent !== null) {
        return { success: true, data: { content: userContent } };
      }

      const builtinPath = path.join(getBuiltinPromptsFolder(), name);
      const builtinContent = await readFileOrNull(builtinPath);
      if (builtinContent !== null) {
        return { success: true, data: { content: builtinContent } };
      }

      return {
        success: false,
        error: `Prompt template not found: ${name}`,
      };
    }
  );

  // ---- prompts:write ----
  //
  // Creates or overwrites a user template. Writes always land
  // in the user folder — the built-in folder is read-only, and
  // a write that shadows a built-in intentionally creates a
  // user copy that takes precedence on subsequent reads.
  //
  // The user folder is created if it does not yet exist, so a
  // fresh installation's first save succeeds without a separate
  // setup step.
  //
  // The write is atomic at the file-system level: `fs.writeFile`
  // with a path that does not yet exist, followed by no rename,
  // is not itself atomic on every platform. The trade-off is
  // acceptable here because the file is small, the operation is
  // user-initiated, and a partial write would be caught on the
  // next validation. A future session that wanted the same
  // atomic-write guarantee the Python side's `write_text_atomic`
  // provides would implement the temp-file-then-rename pattern
  // in this handler.
  ipcMain.handle(
    CHANNEL_WRITE,
    async (
      _event: IpcMainInvokeEvent,
      name: unknown,
      content: unknown
    ): Promise<ApiResponse<null>> => {
      if (typeof name !== 'string' || !isValidPromptName(name)) {
        return { success: false, error: 'Invalid prompt name.' };
      }
      if (!isContentString(content)) {
        return { success: false, error: 'Content must be a string.' };
      }

      const folder = getUserPromptsFolder();
      try {
        await fs.mkdir(folder, { recursive: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          success: false,
          error: `Could not create the prompts folder: ${message}`,
        };
      }

      const filepath = path.join(folder, name);
      try {
        await fs.writeFile(filepath, content, 'utf-8');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          success: false,
          error: `Could not write the prompt file: ${message}`,
        };
      }

      return { success: true, data: null };
    }
  );

  // ---- prompts:delete ----
  //
  // Removes a user template. A built-in with the same name is
  // refused with a specific error message — see the file
  // header's "delete handler's refusal" section for the
  // reasoning.
  //
  // A missing user file with no built-in of the same name
  // produces a generic "not found" message. A missing user file
  // WITH a built-in of the same name produces the "built-ins
  // cannot be deleted" message — the distinction matters
  // because it tells the user which reason applies.
  ipcMain.handle(
    CHANNEL_DELETE,
    async (
      _event: IpcMainInvokeEvent,
      name: unknown
    ): Promise<ApiResponse<null>> => {
      if (typeof name !== 'string' || !isValidPromptName(name)) {
        return { success: false, error: 'Invalid prompt name.' };
      }

      const userPath = path.join(getUserPromptsFolder(), name);
      try {
        await fs.unlink(userPath);
        return { success: true, data: null };
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          // The user file is not present. Determine whether a
          // built-in with the same name exists, so the
          // response distinguishes "you cannot delete a
          // built-in" from "no such prompt".
          const builtinPath = path.join(getBuiltinPromptsFolder(), name);
          try {
            await fs.access(builtinPath);
            return {
              success: false,
              error:
                'Built-in prompts cannot be deleted. ' +
                'Create a user prompt with a different name, ' +
                'or overwrite the built-in by saving a file with ' +
                'the same name.',
            };
          } catch {
            return {
              success: false,
              error: `Prompt template not found: ${name}`,
            };
          }
        }
        const message = err instanceof Error ? err.message : String(err);
        return {
          success: false,
          error: `Could not delete the prompt file: ${message}`,
        };
      }
    }
  );

  // ---- prompts:validate ----
  //
  // Validates a template's Jinja2 syntax by spawning the
  // bundled Python validator on a temporary file containing the
  // content. See the file header for the full contract.
  //
  // A non-string argument is rejected before any spawn, so the
  // only paths that reach the Python side have a well-typed
  // content value.
  ipcMain.handle(
    CHANNEL_VALIDATE,
    async (
      _event: IpcMainInvokeEvent,
      content: unknown
    ): Promise<ApiResponse<PromptValidationResult>> => {
      if (!isContentString(content)) {
        return { success: false, error: 'Content must be a string.' };
      }

      const result = await validateContent(content);
      return { success: true, data: result };
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
 * (`import { registerPromptsIPC } from ...`), so the default
 * form is a convenience rather than a load-bearing export.
 */
export default registerPromptsIPC;