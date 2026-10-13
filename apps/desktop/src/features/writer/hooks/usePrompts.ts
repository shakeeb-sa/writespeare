/**
 * usePrompts — the renderer's prompt-management hook.
 *
 * The single entry point through which a component reads and
 * manipulates the user's prompt templates. It wraps the five IPC
 * channels that `promptsIPC.ts` registers on the main process side
 * (prompts:list, prompts:read, prompts:write, prompts:delete,
 * prompts:validate) and holds the local state that the
 * PromptsEditor UI needs:
 *
 *   - the two prompt-folder listings (built-in and user),
 *   - the currently-selected prompt's name,
 *   - the current content in the editor,
 *   - whether the editor has unsaved changes,
 *   - the loading / saving / error flags that drive the UI's
 *     spinners and banners,
 *   - the last validation result (a Jinja2 syntax check).
 *
 * ── Why the hook holds its own state and not a Zustand store ───
 *
 *   Every other feature hook in this codebase (`useWriter`,
 *   `useResearch`, `useDocuments`, `useValidation`, `useSettings`,
 *   `useTopics`) is a thin wrapper over a Zustand store — the
 *   store owns the state, the hook exposes it. The prompt editor
 *   is different.
 *
 *   The plan's PR-6 file manifest declares no `promptsStore.ts`
 *   and no `prompts` slice in any existing store. The prompts
 *   feature has one consumer (`PromptsEditor.tsx`) and one piece
 *   of ephemeral state — the file the user is currently editing
 *   and its unsaved buffer. A store would add a level of
 *   indirection with no cross-component sharing to justify it.
 *
 *   The hook therefore uses plain `useState` / `useCallback` and
 *   returns a fresh object on every render, exactly as a local
 *   component would. This is the same pattern the plan's file
 *   tree establishes for the export feature (`useExport.ts`),
 *   which also has no store.
 *
 * ── The two-folder model ───────────────────────────────────────
 *
 *   Prompt templates live in two places on disk:
 *
 *     BUILT-IN:  `<resources>/scripts/prompts/` (packaged), or
 *                `<repo>/src/resources/scripts/prompts/` (dev).
 *                Read-only. Ships with the app. Cannot be
 *                modified or deleted through this hook.
 *
 *     USER:      `<appData>/writespeare/prompts/`.
 *                Read-write. Created on demand the first time the
 *                user saves a prompt. Empty on a fresh install.
 *
 *   A user template with the same filename as a built-in shadows
 *   the built-in for every read path — the writer step, the
 *   Advanced Settings dropdown, and this hook's own read action.
 *   Deleting the user file reverts the app to the built-in
 *   immediately.
 *
 *   The hook surfaces the two folders as two separate arrays
 *   (`builtinPrompts` and `userPrompts`) so the editor can render
 *   them as two groups in its file tree. It does NOT collapse
 *   them into a single "effective" list; the editor's own logic
 *   is what decides whether a user-file shadows a built-in of
 *   the same name.
 *
 * ── The five wrapping actions ──────────────────────────────────
 *
 *   Every action in the hook's public surface is a thin wrapper
 *   over one of the five IPC channels, plus the local state
 *   management the editor needs:
 *
 *     refresh()          → calls prompts:list, updates the two
 *                          folder arrays.
 *
 *     select(name|null)  → calls prompts:read, updates
 *                          selectedName, content, and
 *                          savedContent. Passing null clears the
 *                          selection without an IPC call.
 *
 *     setContent(text)   → local only. Updates `content`, which
 *                          is the editor's buffer. Does NOT
 *                          touch `savedContent`.
 *
 *     save()             → calls prompts:write with the current
 *                          selectedName and content. On success,
 *                          refreshes the folder lists and
 *                          promotes `content` to `savedContent`.
 *
 *     saveAs(name)       → calls prompts:write with the given
 *                          name and current content. Selects the
 *                          new name afterward and refreshes.
 *
 *     create(name)       → calls prompts:write with the given
 *                          name and empty content. Selects the
 *                          new name afterward and refreshes.
 *
 *     remove(name)       → calls prompts:delete. If the removed
 *                          file was selected, clears the
 *                          selection. Refreshes.
 *
 *     validate(content)  → calls prompts:validate and stores the
 *                          result in `validationResult`.
 *
 *   The four state-mutating actions (`save`, `saveAs`, `create`,
 *   `remove`) each return `Promise<boolean>` so the editor can
 *   decide whether to fire a success toast. The two read actions
 *   (`refresh`, `select`) return `Promise<void>` because their
 *   outcome is fully reflected in the hook's own state fields.
 *
 * ── Why `save` on a built-in shadows rather than fails ─────────
 *
 *   A user who selects a built-in prompt from the tree sees its
 *   content read-only. If they click Save while that built-in is
 *   selected, the correct behaviour — per the plan's two-folder
 *   model — is to create a user file with the same name that
 *   shadows the built-in from that point forward. The hook does
 *   not refuse the save and does not silently rename it. It calls
 *   `prompts:write` with the built-in's name, which creates the
 *   shadowing user file. The editor's UI is what communicates
 *   this to the user (a banner, a confirmation dialog, or simply
 *   a change in the file tree).
 *
 * ── Validation ─────────────────────────────────────────────────
 *
 *   The `validate` action is called by the editor on every change
 *   (debounced by the editor, not by the hook) and again on save.
 *   The result is stored in `validationResult` so a component can
 *   render a persistent error line. The action also returns the
 *   result directly, so a caller that wants to gate a save on a
 *   passing validation can do so without a second state read.
 *
 *   The Jinja2 render itself happens on the main process side —
 *   the hook does not know or care how the validation is
 *   performed. It receives a discriminated union of
 *   `{ valid: true }` or `{ valid: false; error; line }` and
 *   stores whatever it gets.
 *
 * ── The `PromptValidationResult` type ──────────────────────────
 *
 *   The type is declared here rather than imported from the
 *   preload. The preload's `ElectronAPI` interface declares its
 *   own copy of the same shape, and `promptsIPC.ts` on the main
 *   process side declares a third. All three are structurally
 *   identical — TypeScript's structural typing means a value
 *   crossing the IPC boundary as one shape is accepted by any
 *   code that expects the other. A future refactor that promoted
 *   the type into `shared/types/index.ts` would delete all three
 *   local declarations and replace them with a single import;
 *   the current design is what the plan's file tree declares, and
 *   the duplication is the accepted cost of the two-process
 *   boundary.
 *
 * ── What this hook does NOT do ─────────────────────────────────
 *
 *   - It does not persist the selection across mounts. A fresh
 *     mount starts with no selected prompt and empty content.
 *     The editor component is expected to call `refresh()` on
 *     mount and to make its own decision about whether to
 *     auto-select the first built-in.
 *
 *   - It does not debounce validation. A caller that wants to
 *     validate on every keystroke must implement its own debounce
 *     (or use the `useCallback` result in a `useEffect` with a
 *     timeout). The hook does not schedule timers.
 *
 *   - It does not distinguish a built-in from a user file when
 *     the same name appears in both lists. The two arrays carry
 *     the raw filenames, and it is the caller's responsibility
 *     to decide what a "shadowed built-in" looks like in the UI.
 *
 *   - It does not track the previous name of a renamed prompt. A
 *     rename is `saveAs(newName)` followed by `remove(oldName)` —
 *     the hook has no atomic rename operation, and adding one
 *     would require the IPC layer to expose one. The plan's file
 *     tree declares no rename channel, so rename is the editor's
 *     composition.
 *
 *   - It does not throw. Every action catches its own errors,
 *     converts them to strings, and stores the result in `error`.
 *     The editor reads `error` and renders it; the caller never
 *     has to wrap a hook action in a try/catch.
 *
 * Dependencies: React (for useState, useCallback, useMemo) and
 * the shared types module. No store, no service, no other feature.
 */

import { useCallback, useMemo, useState } from 'react';

// ============================================================
//  Public types
// ============================================================

/**
 * The result of validating a prompt template's Jinja2 syntax.
 *
 * A discriminated union rather than a shape with optional fields,
 * so a caller cannot accidentally read `error` or `line` from a
 * successful validation. The two variants map one-to-one to the
 * two outcomes the main process's `validate_prompt.py` script
 * can produce.
 *
 * The shape is structurally identical to the
 * `PromptValidationResult` type declared in `promptsIPC.ts` and
 * in the preload's `ElectronAPI` augmentation. See the file
 * header's note on the three-way duplication.
 */
export type PromptValidationResult =
  | { valid: true }
  | { valid: false; error: string; line: number };

/**
 * The shape of the object returned by `usePrompts()`.
 *
 * Exported so that a helper function that takes "an instance of
 * the prompts hook" as a parameter can be typed against the
 * interface without redeclaring the shape. A component that
 * destructures the return value does not need to reference the
 * interface at all.
 */
export interface PromptsHookValue {
  // ---- Data ----

  /** The filenames of every built-in prompt template, sorted
   *  lexically. Populated by `refresh()`; empty until the first
   *  successful call. */
  builtinPrompts: string[];

  /** The filenames of every user prompt template, sorted
   *  lexically. Populated by `refresh()`; empty until the first
   *  successful call, or when the user folder does not yet
   *  exist. */
  userPrompts: string[];

  /** The currently-selected prompt's filename, or null when no
   *  prompt is selected. */
  selectedName: string | null;

  /** The editor's current content buffer. Set by `select()` when
   *  a prompt is loaded, and by `setContent()` on every keystroke.
   *  May differ from `savedContent` when the editor is dirty. */
  content: string;

  /** Whether the editor's buffer differs from the last-loaded or
   *  last-saved content. Derived from `content !== savedContent`. */
  hasUnsavedChanges: boolean;

  /** True while a `refresh()` or `select()` call is in flight. */
  isLoading: boolean;

  /** True while a `save()`, `saveAs()`, `create()`, or `remove()`
   *  call is in flight. */
  isSaving: boolean;

  /** The last error message from any action, or null. Cleared
   *  automatically at the start of every action. */
  error: string | null;

  /** The last validation result, or null when the current content
   *  has not yet been validated or the last validation succeeded
   *  and was cleared. */
  validationResult: PromptValidationResult | null;

  // ---- Actions ----

  /** Reload both folder listings. */
  refresh: () => Promise<void>;

  /** Load a prompt's content into the editor and select it.
   *  Passing null clears the selection and the content buffer. */
  select: (name: string | null) => Promise<void>;

  /** Update the editor's content buffer. Does not persist, does
   *  not validate, does not touch `savedContent`. */
  setContent: (content: string) => void;

  /** Save the current content under the currently-selected name.
   *  Resolves with `true` on success, `false` on failure (with
   *  `error` set). A save with no selection is a no-op returning
   *  `false`. */
  save: () => Promise<boolean>;

  /** Save the current content under a new name, and select the
   *  new name afterward. Used for both "Save As" and "Duplicate".
   *  Resolves with `true` on success. */
  saveAs: (name: string) => Promise<boolean>;

  /** Create a new empty prompt file with the given name, and
   *  select it. Resolves with `true` on success. */
  create: (name: string) => Promise<boolean>;

  /** Delete a prompt file. If the removed file was selected, the
   *  selection is cleared. Resolves with `true` on success. */
  remove: (name: string) => Promise<boolean>;

  /** Validate a template's Jinja2 syntax. Stores the result in
   *  `validationResult` and returns it directly so a caller can
   *  gate a save on a passing validation without a second state
   *  read. */
  validate: (content: string) => Promise<PromptValidationResult>;

  /** Clear the last error message. */
  clearError: () => void;

  /** Clear the last validation result. */
  clearValidationResult: () => void;
}

// ============================================================
//  The hook
// ============================================================

/**
 * Return the prompts feature's state and its actions. See the
 * file header for the hook's role, its relationship to the IPC
 * layer, and the reasoning behind the design choices.
 */
export const usePrompts = (): PromptsHookValue => {
  // ---- Folder listings ----
  // Populated by `refresh()`. Empty arrays until the first
  // successful call.
  const [builtinPrompts, setBuiltinPrompts] = useState<string[]>([]);
  const [userPrompts, setUserPrompts] = useState<string[]>([]);

  // ---- Selection + editor buffer ----
  // `selectedName` is the identity of the file the editor is
  // currently working on. `content` is the live buffer; the user
  // types into it via `setContent`. `savedContent` is the value
  // that was last loaded from disk or last written to disk — the
  // reference point for the dirty flag.
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [content, setContentState] = useState<string>('');
  const [savedContent, setSavedContent] = useState<string>('');

  // ---- Loading flags ----
  // `isLoading` covers the two read paths (list, read);
  // `isSaving` covers the four write paths (save, saveAs, create,
  // remove). Splitting them lets the editor show different
  // spinners — a subtle one in the file tree while loading, a
  // prominent one on the Save button while saving.
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [isSaving, setIsSaving] = useState<boolean>(false);

  // ---- Error + validation ----
  const [error, setError] = useState<string | null>(null);
  const [validationResult, setValidationResult] =
    useState<PromptValidationResult | null>(null);

  // ---- Derived dirty flag ----
  // The editor is "dirty" when its buffer differs from the last
  // value it loaded or saved. A `content` that matches
  // `savedContent` is clean, regardless of which path got it
  // there — loading a prompt sets both fields to the same value,
  // and a successful save promotes `content` to `savedContent`.
  //
  // The comparison is a plain string equality. For the size of a
  // prompt template (a few kilobytes at most) this is
  // microseconds per keystroke, which is well below the
  // threshold where a hash or a structural diff would earn its
  // keep.
  const hasUnsavedChanges = useMemo(
    () => content !== savedContent,
    [content, savedContent]
  );

  // ============================================================
  //  refresh — reload both folder listings
  // ============================================================

  const refresh = useCallback(async (): Promise<void> => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await window.electronAPI.prompts.list();
      if (result.success && result.data) {
        setBuiltinPrompts(result.data.builtin);
        setUserPrompts(result.data.user);
      } else {
        setError(result.error ?? 'Failed to load prompts.');
      }
    } catch (err) {
      // An IPC rejection is unusual — the preload resolves
      // business failures into envelopes — but can happen if
      // the channel is unregistered or the renderer's context
      // has been torn down.
      console.error('[usePrompts] refresh failed:', err);
      setError(
        err instanceof Error ? err.message : 'Failed to load prompts.'
      );
    } finally {
      setIsLoading(false);
    }
  }, []);

  // ============================================================
  //  select — load a prompt into the editor
  // ============================================================

  const select = useCallback(
    async (name: string | null): Promise<void> => {
      // Clearing the selection is a local operation with no IPC
      // call. It also clears the content buffer and the
      // validation result, so a subsequent render of the editor
      // shows an empty state rather than the previous prompt's
      // text.
      if (name === null) {
        setSelectedName(null);
        setContentState('');
        setSavedContent('');
        setValidationResult(null);
        setError(null);
        return;
      }

      setIsLoading(true);
      setError(null);
      setValidationResult(null);
      try {
        const result = await window.electronAPI.prompts.read(name);
        if (result.success && result.data) {
          setSelectedName(name);
          setContentState(result.data.content);
          setSavedContent(result.data.content);
        } else {
          setError(result.error ?? `Failed to read prompt: ${name}`);
        }
      } catch (err) {
        console.error('[usePrompts] select failed:', err);
        setError(
          err instanceof Error
            ? err.message
            : `Failed to read prompt: ${name}`
        );
      } finally {
        setIsLoading(false);
      }
    },
    []
  );

  // ============================================================
  //  setContent — update the editor buffer
  // ============================================================

  const setContent = useCallback((newContent: string): void => {
    setContentState(newContent);
  }, []);

  // ============================================================
  //  Internal write helper
  // ============================================================
  //
  //  `save`, `saveAs`, and `create` all funnel through this
  //  helper. It performs the IPC write, refreshes the folder
  //  listings on success (so a new file appears in the tree and
  //  a renamed one disappears), and — depending on the
  //  `selectAfterWrite` flag — updates the hook's selection and
  //  buffer to match the file that was just written.
  //
  //  The four branches the caller cares about:
  //
  //    save()     → write to selectedName, refresh lists, mark
  //                 the buffer as saved (savedContent = content).
  //                 Does NOT change the selection.
  //
  //    saveAs(n)  → write to n, refresh lists, select n, mark
  //                 the buffer as saved.
  //
  //    create(n)  → write empty content to n, refresh lists,
  //                 select n, clear the buffer.
  //
  //  The refresh is fire-and-await inside the helper so the
  //  caller's `true` return means "the write succeeded AND the
  //  listings are up to date" — not just "the write succeeded
  //  and a refresh is in flight somewhere".
  const performWrite = useCallback(
    async (
      name: string,
      writeContent: string,
      selectAfterWrite: boolean
    ): Promise<boolean> => {
      setIsSaving(true);
      setError(null);
      try {
        const result = await window.electronAPI.prompts.write(
          name,
          writeContent
        );
        if (!result.success) {
          setError(result.error ?? `Failed to save prompt: ${name}`);
          return false;
        }

        // Update the local state before the refresh so a
        // component that reads the state during the refresh
        // sees the post-write values.
        if (selectAfterWrite) {
          setSelectedName(name);
          setContentState(writeContent);
        }
        setSavedContent(writeContent);

        // Reload the folder listings so the tree reflects the
        // write. A failure here does not undo the successful
        // write — the file is on disk — so the error is set but
        // the action still reports success.
        const listResult = await window.electronAPI.prompts.list();
        if (listResult.success && listResult.data) {
          setBuiltinPrompts(listResult.data.builtin);
          setUserPrompts(listResult.data.user);
        }

        return true;
      } catch (err) {
        console.error('[usePrompts] performWrite failed:', err);
        setError(
          err instanceof Error
            ? err.message
            : `Failed to save prompt: ${name}`
        );
        return false;
      } finally {
        setIsSaving(false);
      }
    },
    []
  );

  // ============================================================
  //  save — write under the currently-selected name
  // ============================================================

  const save = useCallback(async (): Promise<boolean> => {
    if (selectedName === null) {
      setError('No prompt selected.');
      return false;
    }
    // `selectAfterWrite: false` — the selection is unchanged by
    // a save; the file the user was editing is the file that was
    // written.
    return performWrite(selectedName, content, false);
  }, [selectedName, content, performWrite]);

  // ============================================================
  //  saveAs — write under a new name and select it
  // ============================================================

  const saveAs = useCallback(
    async (name: string): Promise<boolean> => {
      // `selectAfterWrite: true` — the editor jumps to the new
      // file. This is what makes "Save As" feel like a rename
      // followed by a re-open, which is the conventional
      // behaviour for the operation.
      return performWrite(name, content, true);
    },
    [content, performWrite]
  );

  // ============================================================
  //  create — write an empty file with a new name and select it
  // ============================================================

  const create = useCallback(
    async (name: string): Promise<boolean> => {
      return performWrite(name, '', true);
    },
    [performWrite]
  );

  // ============================================================
  //  remove — delete a prompt file
  // ============================================================

  const remove = useCallback(
    async (name: string): Promise<boolean> => {
      setIsSaving(true);
      setError(null);
      try {
        const result = await window.electronAPI.prompts.delete(name);
        if (!result.success) {
          setError(result.error ?? `Failed to delete prompt: ${name}`);
          return false;
        }

        // If the deleted file was the selected one, clear the
        // selection and the buffer. The editor then renders its
        // empty state rather than a stale prompt.
        if (selectedName === name) {
          setSelectedName(null);
          setContentState('');
          setSavedContent('');
          setValidationResult(null);
        }

        // Reload the listings so the deleted file disappears
        // from the tree. Same best-effort reasoning as
        // `performWrite`.
        const listResult = await window.electronAPI.prompts.list();
        if (listResult.success && listResult.data) {
          setBuiltinPrompts(listResult.data.builtin);
          setUserPrompts(listResult.data.user);
        }

        return true;
      } catch (err) {
        console.error('[usePrompts] remove failed:', err);
        setError(
          err instanceof Error
            ? err.message
            : `Failed to delete prompt: ${name}`
        );
        return false;
      } finally {
        setIsSaving(false);
      }
    },
    [selectedName]
  );

  // ============================================================
  //  validate — Jinja2 syntax check
  // ============================================================

  const validate = useCallback(
    async (contentToValidate: string): Promise<PromptValidationResult> => {
      try {
        const result =
          await window.electronAPI.prompts.validate(contentToValidate);
        if (result.success && result.data) {
          setValidationResult(result.data);
          return result.data;
        }
        const failure: PromptValidationResult = {
          valid: false,
          error: result.error ?? 'Validation failed.',
          line: 0,
        };
        setValidationResult(failure);
        return failure;
      } catch (err) {
        console.error('[usePrompts] validate failed:', err);
        const failure: PromptValidationResult = {
          valid: false,
          error:
            err instanceof Error ? err.message : 'Validation failed.',
          line: 0,
        };
        setValidationResult(failure);
        return failure;
      }
    },
    []
  );

  // ============================================================
  //  clearError / clearValidationResult
  // ============================================================

  const clearError = useCallback((): void => {
    setError(null);
  }, []);

  const clearValidationResult = useCallback((): void => {
    setValidationResult(null);
  }, []);

  // ============================================================
  //  Return
  // ============================================================

  return {
    builtinPrompts,
    userPrompts,
    selectedName,
    content,
    hasUnsavedChanges,
    isLoading,
    isSaving,
    error,
    validationResult,
    refresh,
    select,
    setContent,
    save,
    saveAs,
    create,
    remove,
    validate,
    clearError,
    clearValidationResult,
  };
};

// ============================================================
//  Default export
// ============================================================

/**
 * The hook as the default export, matching the convention used
 * by every other hook in the codebase. Consumers that prefer the
 * named form use `import { usePrompts } from ...`; consumers that
 * prefer the default form use `import usePrompts from ...`. Both
 * resolve to the same hook.
 */
export default usePrompts;