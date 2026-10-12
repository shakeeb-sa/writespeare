/**
 * PromptsEditor — the prompt-template editor for the Settings page.
 *
 * The single surface for viewing, editing, creating, renaming, and
 * deleting the prompt templates the writer step renders. Replaces
 * the previous read-only Prompts tab (a static list of the three
 * built-in templates) with a full editor that treats the user's
 * own templates as first-class artifacts.
 *
 * ── The two-folder model, from the UI's perspective ───────────
 *
 *   The editor presents the user's prompt templates as two
 *   groups in a file tree:
 *
 *     BUILT-IN   — the templates that ship with the app. Sourced
 *                  from `<resources>/scripts/prompts/` on the
 *                  main process side; read-only from the user's
 *                  point of view.
 *
 *     MY PROMPTS — the user's own templates. Sourced from
 *                  `<appData>/writespeare/prompts/`; created on
 *                  demand the first time the user saves.
 *
 *   A user template with the same filename as a built-in shadows
 *   the built-in for every read path (the writer step, the
 *   Advanced Settings dropdown, this editor's own `select`
 *   action). Deleting the user file reverts the app to the
 *   built-in immediately.
 *
 *   The two folders are rendered as two independent groups. A
 *   user file named `default.md` appears in the My Prompts group
 *   while the built-in `default.md` still appears in the
 *   Built-in group — the editor does not hide the shadowed
 *   built-in, because a user who wants to see "what the app
 *   originally shipped" needs that view.
 *
 * ── The five operations ────────────────────────────────────────
 *
 *   NEW      — a modal prompts for a filename, then calls the
 *              hook's `create(name)`. The new file starts empty
 *              and becomes the selected prompt.
 *
 *   RENAME   — a modal prompts for a new filename, pre-filled
 *              with the current one. On confirm, the editor:
 *                * calls `saveAs(newName)` to write the current
 *                  content under the new name and select it;
 *                * if the ORIGINAL name was a user file (present
 *                  in the `userPrompts` list), calls
 *                  `remove(oldName)` to delete the original.
 *              A rename of a BUILT-IN does NOT delete anything —
 *              the built-in cannot be removed through the API,
 *              and the correct behaviour is to create a
 *              shadowing user file (the `saveAs` call) while
 *              leaving the built-in untouched.
 *
 *   DELETE   — a confirmation modal, then `remove(name)`. The
 *              Delete button is disabled when the selected name
 *              is not present in the `userPrompts` list — the
 *              UI refuses to attempt a delete it knows will fail
 *              on the main-process side. The refusal is a UI
 *              affordance, not a security boundary; the main
 *              process still refuses a delete of a built-in.
 *
 *   SAVE     — the primary action, dispatched from the editor's
 *              header and from the Ctrl/Cmd+S keybinding. Calls
 *              the hook's `save()`. Disabled when there is no
 *              selection, when there are no unsaved changes, or
 *              when the last validation reported a Jinja2 error.
 *
 *   SELECT   — clicking a file in the tree calls the hook's
 *              `select(name)`. If the editor has unsaved changes,
 *              a confirmation modal appears first — a user who
 *              has spent five minutes editing a template does
 *              not want a stray click on another file to discard
 *              their work silently.
 *
 * ── The editor's dirty guard ───────────────────────────────────
 *
 *   When the user has unsaved changes and clicks a different
 *   file, the editor intercepts the click and shows a
 *   confirmation modal: "You have unsaved changes to <old>. Save
 *   before switching?" Three actions: Save (writes, then
 *   switches), Discard (switches without saving), Cancel (stays
 *   on the current file).
 *
 *   The guard fires on tree-clicks and on the New button. It does
 *   NOT fire when the component unmounts — the tab system in
 *   `Settings.tsx` unmounts the PromptsEditor when the user
 *   switches to a different tab, and a `beforeunload`-style
 *   interception is not possible for an in-app unmount without
 *   the parent's cooperation. See the file header of the
 *   PromptsEditor's eventual predecessor (the read-only tab) for
 *   the note on this limitation.
 *
 *   The guard does not fire on Save or Delete either — those are
 *   explicit user actions on the current file, and the correct
 *   behaviour is to execute them (Delete discards the buffer
 *   along with the file, which is what the user asked for).
 *
 * ── Live validation ────────────────────────────────────────────
 *
 *   The editor validates the content on a 400-millisecond debounce
 *   after every keystroke. The hook's `validate` action returns
 *   a discriminated union — `{ valid: true }` or `{ valid: false,
 *   error, line }` — which the editor stores in the hook's own
 *   `validationResult` state field. The Save button reads that
 *   field and disables itself when the result is a failure.
 *
 *   The validation banner below the editor shows:
 *
 *     * Nothing when the result is `null` (validation not yet
 *       run, or explicitly cleared).
 *     * A green "Valid Jinja2 template" line when the result is
 *       `{ valid: true }`.
 *     * A red line naming the error and its line number when the
 *       result is `{ valid: false }`.
 *
 *   The debounce is implemented with a `setTimeout` in a
 *   `useEffect` keyed on `content`. The effect's cleanup clears
 *   the timer, so a fast typist's intermediate keystrokes do not
 *   each fire a validation. A validation in flight when the
 *   next keystroke arrives is not cancelled — the hook does not
 *   expose an abort — but the newer validation's result wins
 *   because it is stored last. The stale result is briefly
 *   visible before the newer one overwrites it, which is
 *   acceptable at a 400-millisecond debounce.
 *
 * ── The layout ─────────────────────────────────────────────────
 *
 *   A two-column flex layout inside the tab's content area:
 *
 *     LEFT (fixed ~20rem)   — the file tree, with two group
 *                              headers and the file items. A
 *                              "New Prompt" button pins to the
 *                              bottom of the column.
 *
 *     RIGHT (flex-1)         — the editor's header (filename,
 *                              actions), the textarea, and the
 *                              two status lines (error banner
 *                              and validation line).
 *
 *   The whole component fills its parent's height and each column
 *   scrolls independently. The tree's `overflow-y-auto` means a
 *   user with dozens of custom prompts can scroll through them
 *   without pushing the New button off-screen, and the editor's
 *   own `overflow-y-auto` gives the textarea the height it needs
 *   for a long template without forcing the whole component to
 *   grow.
 *
 * ── What this component does NOT do ────────────────────────────
 *
 *   - It does not persist the selection across mounts. Switching
 *     away from the Prompts tab and back mounts a fresh editor
 *     with no selection; the tree is reloaded via the hook's
 *     `refresh` on mount. The plan's design does not call for
 *     selection persistence, and a "last edit position" feature
 *     is out of scope.
 *
 *   - It does not offer a Markdown preview. The prompt templates
 *     are Jinja2 templates that will be rendered later by the
 *     writer step with the topic's variables; a preview without
 *     those variables would show `{{ title }}` verbatim, which
 *     is not more informative than the editor itself.
 *
 *   - It does not offer a diff against the built-in. A user who
 *     wants to see how their `default.md` differs from the
 *     shipped `default.md` reads both files. A future session
 *     that wanted a diff view would need to read the built-in
 *     under a temporary name, which the current IPC layer does
 *     not support without the user file being renamed first —
 *     a change out of scope for this file.
 *
 *   - It does not implement rename as an atomic operation. See
 *     "The five operations" above for the two-step
 *     `saveAs` + `remove` composition. An intermediate state
 *     where both the old and new files exist is visible for the
 *     duration of the second call; at the sizes involved (a few
 *     kilobytes per file) that window is under a hundred
 *     milliseconds and is not perceptible in practice.
 *
 *   - It does not autosave. The Save button is explicit; a user
 *     who navigates away without saving loses their buffer.
 *
 * Dependencies: react + lucide-react + the usePrompts hook +
 * the shared useToast hook + the shared Modal component. All
 * present in the codebase.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
} from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Edit3,
  FileText,
  Folder,
  FolderOpen,
  Loader2,
  Plus,
  RefreshCw,
  Save,
  Trash2,
} from 'lucide-react';

import { usePrompts } from '../../writer/hooks/usePrompts.js';
import { useToast } from '../../shared/hooks/useToast.js';
import Modal from '../../shared/components/Modal.js';

// ============================================================
//  Public types
// ============================================================

/**
 * The props accepted by `PromptsEditor`.
 *
 * Currently empty — the component reads everything it needs from
 * the `usePrompts` hook and the shared toast system. The
 * interface is declared and exported so that a future addition
 * (for example, an `initialSelection` prop for a deep link that
 * wants to open a specific template) has a named home.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface PromptsEditorProps {
  // Reserved for future additions. See interface docstring.
}

// ============================================================
//  Internal constants
// ============================================================

/**
 * The debounce interval, in milliseconds, between the last
 * keystroke and the Jinja2 validation call. See the file
 * header's "Live validation" section for the reasoning behind
 * the value.
 */
const VALIDATION_DEBOUNCE_MS = 400;

/**
 * The default filename the "New Prompt" modal pre-fills. An
 * empty field is unfriendly and offers no cue about the shape
 * the name should take; `my-prompt.md` reads as an example the
 * user can replace.
 */
const DEFAULT_NEW_NAME = 'my-prompt.md';

// ============================================================
//  Internal — PromptTreeItem
// ============================================================

interface PromptTreeItemProps {
  name: string;
  selected: boolean;
  onSelect: (name: string) => void;
}

/**
 * One file in the tree. Renders as a full-width button so the
 * click target matches the visual row — a user clicking anywhere
 * on the row selects the file. The selected state is expressed
 * with a background tint and a bold label.
 *
 * The component is not exported. It has one consumer (this file)
 * and no reuse case that would justify lifting it.
 */
const PromptTreeItem = ({
  name,
  selected,
  onSelect,
}: PromptTreeItemProps) => {
  const handleClick = (): void => {
    onSelect(name);
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      title={name}
      className={
        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 ' +
        'text-left text-sm transition-colors ' +
        'focus-visible:outline-none ' +
        (selected
          ? 'bg-primary/10 font-medium text-primary ' +
            'dark:bg-primary-light/10 dark:text-primary-light'
          : 'text-text hover:bg-neutral-100 ' +
            'dark:text-neutral-200 dark:hover:bg-neutral-800/60')
      }
    >
      <FileText
        size={14}
        className="shrink-0 text-neutral-500 dark:text-neutral-400"
        aria-hidden="true"
      />
      <span className="min-w-0 flex-1 truncate">{name}</span>
    </button>
  );
};

// ============================================================
//  Internal — GroupHeader
// ============================================================

interface GroupHeaderProps {
  icon: typeof Folder;
  label: string;
  count: number;
}

const GroupHeader = ({ icon: Icon, label, count }: GroupHeaderProps) => (
  <div
    className={
      'flex items-center gap-2 px-2 py-1 text-xs font-semibold ' +
      'uppercase tracking-wide text-neutral-500 ' +
      'dark:text-neutral-400'
    }
  >
    <Icon size={12} aria-hidden="true" />
    <span className="flex-1">{label}</span>
    <span className="tabular-nums">{count}</span>
  </div>
);

// ============================================================
//  PromptsEditor
// ============================================================

/**
 * The prompt template editor. See the file header for the
 * component's responsibilities, the two-folder model, the five
 * operations, and the reasoning behind the design choices.
 */
export const PromptsEditor = (_props: PromptsEditorProps = {}) => {
  const toast = useToast();
  const {
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
  } = usePrompts();

  // ---- Load on mount ----
  // The hook is a passive reader; this effect is what triggers
  // the first folder-list fetch. The `refresh` reference is
  // stable (a `useCallback` with empty deps from the hook), so
  // the effect fires exactly once per mount.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // ---- Live validation with debounce ----
  // Every keystroke updates `content` via the textarea's
  // `onChange` handler, which this effect sees. The effect
  // schedules a validation 400 milliseconds later; a subsequent
  // keystroke clears the timer and schedules a new one. See the
  // file header for the reasoning on why an in-flight
  // validation is not aborted (the hook does not expose an
  // abort, and the newer validation's result wins by being
  // stored last).
  //
  // The empty-content case is skipped — an empty template is
  // trivially valid Jinja2 and the validation round trip would
  // be wasted work on every fresh "New Prompt".
  useEffect(() => {
    if (content.length === 0) {
      return;
    }
    const timer = window.setTimeout(() => {
      void validate(content);
    }, VALIDATION_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [content, validate]);

  // ============================================================
  //  Modal state
  // ============================================================

  // ---- New prompt ----
  const [newModalOpen, setNewModalOpen] = useState(false);
  const [newName, setNewName] = useState(DEFAULT_NEW_NAME);
  const newInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (newModalOpen) {
      setNewName(DEFAULT_NEW_NAME);
      // Defer focus by one tick so the modal shell's own
      // focus-management effect runs first. Same pattern as
      // `NewTopicModal`.
      const timer = window.setTimeout(() => {
        newInputRef.current?.focus();
        newInputRef.current?.select();
      }, 0);
      return () => {
        window.clearTimeout(timer);
      };
    }
    return undefined;
  }, [newModalOpen]);

  // ---- Rename ----
  const [renameModalOpen, setRenameModalOpen] = useState(false);
  const [renameName, setRenameName] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renameModalOpen) {
      // Pre-fill with the currently-selected name so the user
      // edits rather than retypes.
      setRenameName(selectedName ?? '');
      const timer = window.setTimeout(() => {
        renameInputRef.current?.focus();
        renameInputRef.current?.select();
      }, 0);
      return () => {
        window.clearTimeout(timer);
      };
    }
    return undefined;
  }, [renameModalOpen, selectedName]);

  // ---- Delete confirmation ----
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);

  // ---- Unsaved-changes guard ----
  // When the user has unsaved changes and attempts to select a
  // different file (or start a new one), the editor intercepts
  // the action and stores a callback that will run after the
  // user resolves the modal. `null` means no guard is pending.
  const [pendingAction, setPendingAction] = useState<
    { kind: 'select'; name: string } | { kind: 'new' } | null
  >(null);

  // ============================================================
  //  Handlers — file tree
  // ============================================================

  /**
   * The user clicked a file in the tree. If there are unsaved
   * changes and the clicked file is not the currently-selected
   * one, arm the guard instead of switching immediately. See the
   * file header's "The editor's dirty guard" section.
   */
  const handleTreeSelect = useCallback(
    (name: string): void => {
      if (name === selectedName) {
        return;
      }
      if (hasUnsavedChanges) {
        setPendingAction({ kind: 'select', name });
        return;
      }
      void select(name);
    },
    [selectedName, hasUnsavedChanges, select]
  );

  // ============================================================
  //  Handlers — editor header actions
  // ============================================================

  /**
   * The Save button (and Ctrl/Cmd+S) handler. A save with no
   * selection is a no-op; the button is disabled in that state
   * so the guard is a belt-and-braces check.
   */
  const handleSave = useCallback((): void => {
    if (selectedName === null || !hasUnsavedChanges) {
      return;
    }
    void (async (): Promise<void> => {
      const ok = await save();
      if (ok) {
        toast.success(`Saved ${selectedName}`);
      } else {
        toast.error('Failed to save prompt.');
      }
    })();
  }, [selectedName, hasUnsavedChanges, save, toast]);

  /**
   * The Rename button handler. Opens the rename modal.
   */
  const handleRenameClick = useCallback((): void => {
    setRenameModalOpen(true);
  }, []);

  /**
   * The Rename modal's confirm handler. Two-step rename:
   *
   *   1. `saveAs(newName)` writes the current buffer under the
   *      new name and selects it.
   *   2. If the ORIGINAL name was a user file, `remove(oldName)`
   *      deletes the original.
   *
   * The check `userPrompts.includes(oldName)` is what
   * distinguishes a rename of a user file (delete the original)
   * from a rename of a built-in (leave the built-in untouched,
   * creating only a shadowing user file).
   */
  const handleRenameConfirm = useCallback((): void => {
    const oldName = selectedName;
    const trimmed = renameName.trim();
    if (oldName === null || trimmed.length === 0 || trimmed === oldName) {
      setRenameModalOpen(false);
      return;
    }

    void (async (): Promise<void> => {
      const saved = await saveAs(trimmed);
      if (!saved) {
        toast.error('Failed to rename prompt.');
        return;
      }

      // Only delete the original when it is a user file.
      if (userPrompts.includes(oldName)) {
        await remove(oldName);
      }
      toast.success(`Renamed to ${trimmed}`);
      setRenameModalOpen(false);
    })();
  }, [selectedName, renameName, userPrompts, saveAs, remove, toast]);

  /**
   * The Delete button handler. Opens the confirmation modal.
   */
  const handleDeleteClick = useCallback((): void => {
    setDeleteModalOpen(true);
  }, []);

  /**
   * The Delete modal's confirm handler. Calls the hook's
   * `remove`, which clears the selection if the removed file was
   * the selected one.
   */
  const handleDeleteConfirm = useCallback((): void => {
    const target = selectedName;
    if (target === null) {
      setDeleteModalOpen(false);
      return;
    }
    void (async (): Promise<void> => {
      const ok = await remove(target);
      if (ok) {
        toast.success(`Deleted ${target}`);
      } else {
        toast.error('Failed to delete prompt.');
      }
      setDeleteModalOpen(false);
    })();
  }, [selectedName, remove, toast]);

  // ============================================================
  //  Handlers — New prompt
  // ============================================================

  /**
   * The "New Prompt" button handler. Intercepts the action when
   * there are unsaved changes — same guard pattern as the tree
   * selection — and otherwise opens the new-prompt modal.
   */
  const handleNewClick = useCallback((): void => {
    if (hasUnsavedChanges) {
      setPendingAction({ kind: 'new' });
      return;
    }
    setNewModalOpen(true);
  }, [hasUnsavedChanges]);

  /**
   * The New modal's confirm handler. Creates an empty file with
   * the given name and selects it.
   */
  const handleNewConfirm = useCallback((): void => {
    const trimmed = newName.trim();
    if (trimmed.length === 0) {
      return;
    }
    void (async (): Promise<void> => {
      const ok = await create(trimmed);
      if (ok) {
        toast.success(`Created ${trimmed}`);
        setNewModalOpen(false);
      } else {
        toast.error('Failed to create prompt.');
      }
    })();
  }, [newName, create, toast]);

  // ============================================================
  //  Handlers — unsaved-changes guard
  // ============================================================

  /**
   * The guard modal's "Save" action: save the current buffer,
   * then execute the pending action. If the save fails, the
   * guard closes without executing the pending action — the
   * user's work is preserved in the buffer and they can retry.
   */
  const handleGuardSave = useCallback((): void => {
    const action = pendingAction;
    if (action === null) {
      return;
    }
    void (async (): Promise<void> => {
      const saved = await save();
      if (!saved) {
        toast.error('Failed to save prompt.');
        setPendingAction(null);
        return;
      }
      toast.success(`Saved ${selectedName ?? ''}`);
      setPendingAction(null);
      if (action.kind === 'select') {
        void select(action.name);
      } else {
        setNewModalOpen(true);
      }
    })();
  }, [pendingAction, save, select, toast, selectedName]);

  /**
   * The guard modal's "Discard" action: skip the save, execute
   * the pending action with the current buffer discarded.
   */
  const handleGuardDiscard = useCallback((): void => {
    const action = pendingAction;
    if (action === null) {
      return;
    }
    setPendingAction(null);
    if (action.kind === 'select') {
      void select(action.name);
    } else {
      setNewModalOpen(true);
    }
  }, [pendingAction, select]);

  /**
   * The guard modal's "Cancel" action: dismiss the modal without
   * executing the pending action. The editor stays on the current
   * file with the buffer intact.
   */
  const handleGuardCancel = useCallback((): void => {
    setPendingAction(null);
  }, []);

  // ============================================================
  //  Handlers — keyboard
  // ============================================================

  /**
   * Ctrl/Cmd+S in the textarea triggers a save. The event's
   * default browser action (the Save Page dialog) is suppressed.
   *
   * The check for `metaKey || ctrlKey` handles macOS (Cmd+S) and
   * Windows / Linux (Ctrl+S) with one branch.
   */
  const handleEditorKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>): void => {
      if ((event.metaKey || event.ctrlKey) && event.key === 's') {
        event.preventDefault();
        handleSave();
      }
    },
    [handleSave]
  );

  // ============================================================
  //  Handlers — simple
  // ============================================================

  const handleContentChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>): void => {
      setContent(event.target.value);
    },
    [setContent]
  );

  const handleRefresh = useCallback((): void => {
    void refresh();
  }, [refresh]);

  const handleDismissError = useCallback((): void => {
    clearError();
  }, [clearError]);

  const handleDismissValidation = useCallback((): void => {
    clearValidationResult();
  }, [clearValidationResult]);

  // ============================================================
  //  Derived flags
  // ============================================================

  const hasSelection = selectedName !== null;
  const isUserFile =
    selectedName !== null && userPrompts.includes(selectedName);
  const validationFailed =
    validationResult !== null && validationResult.valid === false;
  const canSave =
    hasSelection &&
    hasUnsavedChanges &&
    !isSaving &&
    !validationFailed;

  // ============================================================
  //  Render
  // ============================================================

  return (
    <div className="flex h-full w-full min-h-0 flex-col">
      {/* ---- Header ---- */}
      <header className="mb-4 shrink-0">
        <h2
          className={
            'text-base font-semibold text-text ' +
            'dark:text-neutral-100'
          }
        >
          Prompt Templates
        </h2>
        <p
          className={
            'mt-1 text-sm text-neutral-500 ' +
            'dark:text-neutral-400'
          }
        >
          Edit the Jinja2 templates the writer step renders. Built-in
          templates are read-only; saving over one creates a user
          copy that takes precedence.
        </p>
      </header>

      {/* ---- Two-column body ---- */}
      <div className="flex min-h-0 flex-1 gap-4">
        {/* ==================================================
         *  LEFT — file tree
         * ================================================== */}
        <aside
          className={
            'flex w-72 shrink-0 flex-col rounded-xl border ' +
            'border-neutral-200 bg-background ' +
            'dark:border-neutral-800'
          }
        >
          {/* ---- Tree header ---- */}
          <div
            className={
              'flex items-center gap-2 border-b ' +
              'border-neutral-200 px-3 py-2 ' +
              'dark:border-neutral-800'
            }
          >
            <span
              className={
                'flex-1 text-sm font-medium text-text ' +
                'dark:text-neutral-100'
              }
            >
              Files
            </span>
            <button
              type="button"
              onClick={handleRefresh}
              disabled={isLoading}
              aria-label="Refresh prompt list"
              title="Refresh"
              className={
                'rounded-md p-1 text-neutral-500 ' +
                'transition-colors hover:bg-neutral-100 ' +
                'hover:text-neutral-800 ' +
                'disabled:cursor-not-allowed disabled:opacity-60 ' +
                'focus-visible:outline-none ' +
                'dark:text-neutral-400 ' +
                'dark:hover:bg-neutral-800 ' +
                'dark:hover:text-neutral-100'
              }
            >
              {isLoading ? (
                <Loader2
                  size={14}
                  className="animate-spin"
                  aria-hidden="true"
                />
              ) : (
                <RefreshCw size={14} aria-hidden="true" />
              )}
            </button>
          </div>

          {/* ---- Tree body ---- */}
          <div className="flex-1 overflow-y-auto p-2">
            {/* Built-in group */}
            <GroupHeader
              icon={FolderOpen}
              label="Built-in"
              count={builtinPrompts.length}
            />
            {builtinPrompts.length === 0 ? (
              <p
                className={
                  'px-2 py-1 text-xs text-neutral-500 ' +
                  'dark:text-neutral-400'
                }
              >
                No built-in prompts found.
              </p>
            ) : (
              <ul className="mb-3 space-y-0.5">
                {builtinPrompts.map((name) => (
                  <li key={`builtin:${name}`}>
                    <PromptTreeItem
                      name={name}
                      selected={selectedName === name}
                      onSelect={handleTreeSelect}
                    />
                  </li>
                ))}
              </ul>
            )}

            {/* User group */}
            <GroupHeader
              icon={Folder}
              label="My Prompts"
              count={userPrompts.length}
            />
            {userPrompts.length === 0 ? (
              <p
                className={
                  'px-2 py-1 text-xs italic text-neutral-500 ' +
                  'dark:text-neutral-400'
                }
              >
                No custom prompts yet.
              </p>
            ) : (
              <ul className="space-y-0.5">
                {userPrompts.map((name) => (
                  <li key={`user:${name}`}>
                    <PromptTreeItem
                      name={name}
                      selected={selectedName === name}
                      onSelect={handleTreeSelect}
                    />
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* ---- New button ---- */}
          <div
            className={
              'shrink-0 border-t border-neutral-200 p-2 ' +
              'dark:border-neutral-800'
            }
          >
            <button
              type="button"
              onClick={handleNewClick}
              disabled={isSaving}
              className={
                'flex w-full items-center justify-center gap-2 ' +
                'rounded-lg bg-primary px-3 py-2 text-sm ' +
                'font-medium text-white transition-colors ' +
                'hover:bg-primary-dark ' +
                'disabled:cursor-not-allowed disabled:opacity-60 ' +
                'focus-visible:outline-none'
              }
            >
              <Plus size={16} aria-hidden="true" />
              <span>New Prompt</span>
            </button>
          </div>
        </aside>

        {/* ==================================================
         *  RIGHT — editor
         * ================================================== */}
        <section
          className={
            'flex min-w-0 flex-1 flex-col rounded-xl border ' +
            'border-neutral-200 bg-background ' +
            'dark:border-neutral-800'
          }
        >
          {/* ---- Editor header ---- */}
          <div
            className={
              'flex shrink-0 items-center gap-2 border-b ' +
              'border-neutral-200 px-3 py-2 ' +
              'dark:border-neutral-800'
            }
          >
            {/* Filename */}
            <div className="min-w-0 flex-1">
              {hasSelection ? (
                <div className="flex items-center gap-2">
                  <span
                    className={
                      'truncate text-sm font-medium text-text ' +
                      'dark:text-neutral-100'
                    }
                    title={selectedName ?? undefined}
                  >
                    {selectedName}
                  </span>
                  {hasUnsavedChanges && (
                    <span
                      className={
                        'shrink-0 rounded-full bg-amber-100 ' +
                        'px-2 py-0.5 text-[10px] font-semibold ' +
                        'uppercase tracking-wide text-amber-800 ' +
                        'dark:bg-amber-950/60 ' +
                        'dark:text-amber-200'
                      }
                      title="Unsaved changes"
                    >
                      Unsaved
                    </span>
                  )}
                </div>
              ) : (
                <span
                  className={
                    'text-sm italic text-neutral-500 ' +
                    'dark:text-neutral-400'
                  }
                >
                  No prompt selected
                </span>
              )}
            </div>

            {/* Actions */}
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                onClick={handleRenameClick}
                disabled={!hasSelection || isSaving}
                aria-label="Rename prompt"
                title="Rename"
                className={
                  'rounded-md p-1.5 text-neutral-500 ' +
                  'transition-colors ' +
                  'hover:bg-neutral-100 hover:text-primary ' +
                  'disabled:cursor-not-allowed disabled:opacity-40 ' +
                  'focus-visible:outline-none ' +
                  'dark:text-neutral-400 ' +
                  'dark:hover:bg-neutral-800 ' +
                  'dark:hover:text-primary-light'
                }
              >
                <Edit3 size={16} aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={handleDeleteClick}
                disabled={!isUserFile || isSaving}
                aria-label="Delete prompt"
                title={
                  isUserFile
                    ? 'Delete'
                    : 'Built-in prompts cannot be deleted'
                }
                className={
                  'rounded-md p-1.5 text-neutral-500 ' +
                  'transition-colors ' +
                  'hover:bg-red-50 hover:text-red-700 ' +
                  'disabled:cursor-not-allowed disabled:opacity-40 ' +
                  'focus-visible:outline-none ' +
                  'dark:text-neutral-400 ' +
                  'dark:hover:bg-red-950/60 ' +
                  'dark:hover:text-red-400'
                }
              >
                <Trash2 size={16} aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={!canSave}
                className={
                  'inline-flex items-center gap-1.5 rounded-md ' +
                  'bg-primary px-3 py-1.5 text-xs font-medium ' +
                  'text-white transition-colors ' +
                  'hover:bg-primary-dark ' +
                  'disabled:cursor-not-allowed disabled:opacity-40 ' +
                  'focus-visible:outline-none'
                }
              >
                {isSaving ? (
                  <>
                    <Loader2
                      size={14}
                      className="animate-spin"
                      aria-hidden="true"
                    />
                    <span>Saving…</span>
                  </>
                ) : (
                  <>
                    <Save size={14} aria-hidden="true" />
                    <span>Save</span>
                  </>
                )}
              </button>
            </div>
          </div>

          {/* ---- Error banner ---- */}
          {error !== null && (
            <div
              role="alert"
              className={
                'flex items-start gap-2 border-b ' +
                'border-red-200 bg-red-50 px-3 py-2 ' +
                'dark:border-red-900 dark:bg-red-950/60'
              }
            >
              <AlertCircle
                size={16}
                className={
                  'mt-0.5 shrink-0 text-red-600 dark:text-red-400'
                }
                aria-hidden="true"
              />
              <p
                className={
                  'min-w-0 flex-1 text-sm text-red-900 ' +
                  'dark:text-red-100'
                }
              >
                {error}
              </p>
              <button
                type="button"
                onClick={handleDismissError}
                className={
                  'shrink-0 text-xs font-medium text-red-700 ' +
                  'hover:underline focus-visible:outline-none ' +
                  'dark:text-red-300'
                }
              >
                Dismiss
              </button>
            </div>
          )}

          {/* ---- Editor body ---- */}
          {hasSelection ? (
            <textarea
              value={content}
              onChange={handleContentChange}
              onKeyDown={handleEditorKeyDown}
              spellCheck={false}
              wrap="off"
              className={
                'min-h-0 flex-1 resize-none border-0 ' +
                'bg-background px-4 py-3 font-mono text-sm ' +
                'text-text focus:outline-none ' +
                'dark:bg-neutral-950 dark:text-neutral-100'
              }
            />
          ) : (
            <div
              className={
                'flex min-h-0 flex-1 flex-col items-center ' +
                'justify-center gap-3 px-6 py-12 text-center'
              }
            >
              <div
                className={
                  'flex h-14 w-14 items-center justify-center ' +
                  'rounded-2xl bg-neutral-100 text-neutral-500 ' +
                  'dark:bg-neutral-800 dark:text-neutral-400'
                }
              >
                <FileText size={28} aria-hidden="true" />
              </div>
              <div>
                <p
                  className={
                    'text-sm font-medium text-text ' +
                    'dark:text-neutral-100'
                  }
                >
                  Select a prompt to edit
                </p>
                <p
                  className={
                    'mt-1 max-w-sm text-xs text-neutral-500 ' +
                    'dark:text-neutral-400'
                  }
                >
                  Pick a file from the tree on the left, or click
                  &ldquo;New Prompt&rdquo; to create one.
                </p>
              </div>
            </div>
          )}

          {/* ---- Validation line ---- */}
          {hasSelection && validationResult !== null && (
            <div
              className={
                'flex shrink-0 items-start gap-2 border-t px-3 py-2 ' +
                (validationResult.valid
                  ? 'border-emerald-200 bg-emerald-50 ' +
                    'dark:border-emerald-900 ' +
                    'dark:bg-emerald-950/40'
                  : 'border-red-200 bg-red-50 ' +
                    'dark:border-red-900 ' +
                    'dark:bg-red-950/40')
              }
            >
              {validationResult.valid ? (
                <>
                  <CheckCircle2
                    size={14}
                    className={
                      'mt-0.5 shrink-0 text-emerald-600 ' +
                      'dark:text-emerald-400'
                    }
                    aria-hidden="true"
                  />
                  <p
                    className={
                      'min-w-0 flex-1 text-xs text-emerald-900 ' +
                      'dark:text-emerald-100'
                    }
                  >
                    Valid Jinja2 template.
                  </p>
                </>
              ) : (
                <>
                  <AlertCircle
                    size={14}
                    className={
                      'mt-0.5 shrink-0 text-red-600 ' +
                      'dark:text-red-400'
                    }
                    aria-hidden="true"
                  />
                  <p
                    className={
                      'min-w-0 flex-1 text-xs text-red-900 ' +
                      'dark:text-red-100'
                    }
                  >
                    <span className="font-semibold">
                      Line {validationResult.line}:
                    </span>{' '}
                    {validationResult.error}
                  </p>
                </>
              )}
              <button
                type="button"
                onClick={handleDismissValidation}
                className={
                  'shrink-0 text-xs font-medium ' +
                  (validationResult.valid
                    ? 'text-emerald-700 dark:text-emerald-300'
                    : 'text-red-700 dark:text-red-300') +
                  ' hover:underline focus-visible:outline-none'
                }
              >
                Dismiss
              </button>
            </div>
          )}
        </section>
      </div>

      {/* ==================================================
       *  MODALS
       * ================================================== */}

      {/* ---- New prompt ---- */}
      <Modal
        open={newModalOpen}
        onClose={() => setNewModalOpen(false)}
        variant="info"
        size="sm"
        title="New Prompt"
        footer={
          <>
            <button
              type="button"
              onClick={() => setNewModalOpen(false)}
              className={
                'rounded-lg border border-neutral-300 bg-background ' +
                'px-4 py-2 text-sm font-medium text-text ' +
                'transition-colors hover:bg-neutral-100 ' +
                'focus-visible:outline-none ' +
                'dark:border-neutral-700 ' +
                'dark:hover:bg-neutral-800 ' +
                'dark:text-neutral-100'
              }
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleNewConfirm}
              disabled={newName.trim().length === 0}
              className={
                'inline-flex items-center gap-2 rounded-lg ' +
                'bg-primary px-4 py-2 text-sm font-medium ' +
                'text-white transition-colors ' +
                'hover:bg-primary-dark ' +
                'disabled:cursor-not-allowed disabled:opacity-60 ' +
                'focus-visible:outline-none'
              }
            >
              <Plus size={16} aria-hidden="true" />
              <span>Create</span>
            </button>
          </>
        }
      >
        <label
          htmlFor="prompt-new-name"
          className={
            'mb-1.5 block text-sm font-medium ' +
            'text-text dark:text-neutral-200'
          }
        >
          Filename
        </label>
        <input
          id="prompt-new-name"
          ref={newInputRef}
          type="text"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder={DEFAULT_NEW_NAME}
          className={
            'w-full rounded-lg border border-neutral-300 ' +
            'bg-background px-3 py-2 text-sm text-text ' +
            'placeholder-neutral-400 focus:border-primary ' +
            'dark:border-neutral-700 dark:bg-neutral-950 ' +
            'dark:text-neutral-100 dark:placeholder-neutral-500'
          }
        />
        <p
          className={
            'mt-2 text-xs text-neutral-500 ' +
            'dark:text-neutral-400'
          }
        >
          Include the extension — for example,{' '}
          <code className="font-mono">my-style.md</code>. The new
          template starts empty.
        </p>
      </Modal>

      {/* ---- Rename ---- */}
      <Modal
        open={renameModalOpen}
        onClose={() => setRenameModalOpen(false)}
        variant="info"
        size="sm"
        title="Rename Prompt"
        footer={
          <>
            <button
              type="button"
              onClick={() => setRenameModalOpen(false)}
              className={
                'rounded-lg border border-neutral-300 bg-background ' +
                'px-4 py-2 text-sm font-medium text-text ' +
                'transition-colors hover:bg-neutral-100 ' +
                'focus-visible:outline-none ' +
                'dark:border-neutral-700 ' +
                'dark:hover:bg-neutral-800 ' +
                'dark:text-neutral-100'
              }
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleRenameConfirm}
              disabled={
                renameName.trim().length === 0 ||
                renameName.trim() === selectedName
              }
              className={
                'inline-flex items-center gap-2 rounded-lg ' +
                'bg-primary px-4 py-2 text-sm font-medium ' +
                'text-white transition-colors ' +
                'hover:bg-primary-dark ' +
                'disabled:cursor-not-allowed disabled:opacity-60 ' +
                'focus-visible:outline-none'
              }
            >
              <Edit3 size={16} aria-hidden="true" />
              <span>Rename</span>
            </button>
          </>
        }
      >
        <label
          htmlFor="prompt-rename-name"
          className={
            'mb-1.5 block text-sm font-medium ' +
            'text-text dark:text-neutral-200'
          }
        >
          New filename
        </label>
        <input
          id="prompt-rename-name"
          ref={renameInputRef}
          type="text"
          value={renameName}
          onChange={(e) => setRenameName(e.target.value)}
          className={
            'w-full rounded-lg border border-neutral-300 ' +
            'bg-background px-3 py-2 text-sm text-text ' +
            'placeholder-neutral-400 focus:border-primary ' +
            'dark:border-neutral-700 dark:bg-neutral-950 ' +
            'dark:text-neutral-100 dark:placeholder-neutral-500'
          }
        />
        {selectedName !== null &&
          !userPrompts.includes(selectedName) && (
            <p
              className={
                'mt-2 text-xs text-amber-700 ' +
                'dark:text-amber-400'
              }
            >
              This is a built-in template. Renaming saves a user
              copy under the new name; the built-in remains
              available.
            </p>
          )}
      </Modal>

      {/* ---- Delete confirmation ---- */}
      <Modal
        open={deleteModalOpen}
        onClose={() => setDeleteModalOpen(false)}
        variant="danger"
        size="sm"
        title="Delete prompt?"
        footer={
          <>
            <button
              type="button"
              onClick={() => setDeleteModalOpen(false)}
              className={
                'rounded-lg border border-neutral-300 bg-background ' +
                'px-4 py-2 text-sm font-medium text-text ' +
                'transition-colors hover:bg-neutral-100 ' +
                'focus-visible:outline-none ' +
                'dark:border-neutral-700 ' +
                'dark:hover:bg-neutral-800 ' +
                'dark:text-neutral-100'
              }
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleDeleteConfirm}
              className={
                'rounded-lg bg-red-600 px-4 py-2 text-sm ' +
                'font-medium text-white transition-colors ' +
                'hover:bg-red-700 focus-visible:outline-none'
              }
            >
              Delete
            </button>
          </>
        }
      >
        <p>
          Are you sure you want to delete{' '}
          <strong className="font-semibold">{selectedName}</strong>?
          The file will be removed from disk. This cannot be undone.
        </p>
      </Modal>

      {/* ---- Unsaved-changes guard ---- */}
      <Modal
        open={pendingAction !== null}
        onClose={handleGuardCancel}
        variant="warning"
        size="sm"
        title="Unsaved changes"
        footer={
          <>
            <button
              type="button"
              onClick={handleGuardCancel}
              className={
                'rounded-lg border border-neutral-300 bg-background ' +
                'px-4 py-2 text-sm font-medium text-text ' +
                'transition-colors hover:bg-neutral-100 ' +
                'focus-visible:outline-none ' +
                'dark:border-neutral-700 ' +
                'dark:hover:bg-neutral-800 ' +
                'dark:text-neutral-100'
              }
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleGuardDiscard}
              className={
                'rounded-lg border border-red-300 bg-transparent ' +
                'px-4 py-2 text-sm font-medium text-red-700 ' +
                'transition-colors hover:bg-red-50 ' +
                'focus-visible:outline-none ' +
                'dark:border-red-800 dark:text-red-400 ' +
                'dark:hover:bg-red-950/60'
              }
            >
              Discard
            </button>
            <button
              type="button"
              onClick={handleGuardSave}
              disabled={validationFailed}
              className={
                'inline-flex items-center gap-2 rounded-lg ' +
                'bg-primary px-4 py-2 text-sm font-medium ' +
                'text-white transition-colors ' +
                'hover:bg-primary-dark ' +
                'disabled:cursor-not-allowed disabled:opacity-60 ' +
                'focus-visible:outline-none'
              }
            >
              <Save size={16} aria-hidden="true" />
              <span>Save</span>
            </button>
          </>
        }
      >
        <p>
          You have unsaved changes to{' '}
          <strong className="font-semibold">{selectedName}</strong>.
          Save before continuing?
        </p>
      </Modal>
    </div>
  );
};

// ============================================================
//  Default export
// ============================================================

/**
 * The `PromptsEditor` component as the default export. The
 * Settings page imports it with the default form
 * (`import PromptsEditor from '../components/PromptsEditor.js'`)
 * when its Prompts tab is updated to render this component
 * instead of the previous read-only list.
 */
export default PromptsEditor;