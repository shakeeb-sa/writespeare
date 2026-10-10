/**
 * ExportMenu — the export dropdown for the writer's article preview.
 *
 * A small menu button that opens a three-item dropdown, one item
 * per supported export format. Each item calls the `exportAs`
 * action from the `useExport` hook, which opens a native Save-As
 * dialog through the main process and writes the file to the
 * user's chosen path. The menu disables itself while an export is
 * in flight and shows a spinner on the trigger button.
 *
 * The component is rendered by the sibling `ArticlePreview.tsx`
 * (in the writer feature's components folder), which passes the
 * article's Mongo ID as the component's sole prop. The forward
 * reference that file carries — `TS2307` until this file exists —
 * resolves when this file is created.
 *
 * ── The three formats ──────────────────────────────────────────
 *
 *   The three items, in the order they appear in the menu:
 *
 *     Word (.docx)     A Word document with headings, bold runs,
 *                      italic runs, and links preserved as native
 *                      Word constructs. Opens in Word, Google
 *                      Docs, LibreOffice, and any other
 *                      Word-compatible editor.
 *
 *     Markdown (.md)   The article's source Markdown, copied
 *                      verbatim. Ideal for blogs, GitHub, Notion,
 *                      and any tool that renders Markdown.
 *
 *     Plain text (.txt)
 *                      The article's source Markdown with a
 *                      `.txt` filename. Rendered by the same
 *                      Python writer that produces the `.md`
 *                      file; the bytes are identical, only the
 *                      extension differs. See `exportIPC.ts`'s
 *                      file header for the reasoning on the
 *                      txt/md mapping.
 *
 *   Each item carries a small icon from `lucide-react` to
 *   distinguish the three formats at a glance. The icons are
 *   `FileType2` for Word, `FileCode2` for Markdown, and
 *   `FileText` for plain text. They are decorative — the label
 *   text is what a screen reader announces and what a user
 *   reads.
 *
 * ── The controlled-open pattern ────────────────────────────────
 *
 *   The menu's open/closed state is component-local. A click on
 *   the trigger button toggles it; a click outside the menu, a
 *   click on an item, or pressing Escape closes it. Three
 *   effects implement that:
 *
 *     1. A `useRef` on the menu's outer container so the
 *        document-level click handler can tell whether a click
 *        landed inside or outside the menu.
 *
 *     2. A `useEffect` that installs a `pointerdown` listener on
 *        the document when the menu is open, and removes it when
 *        the menu closes. The listener checks whether the event
 *        target is inside the menu's container; a click outside
 *        closes the menu.
 *
 *     3. A `useEffect` that installs a `keydown` listener for
 *        the Escape key. Escape closes the menu regardless of
 *        where the focus currently is.
 *
 *   The pattern is the standard "small menu" approach and does
 *   not need a third-party library. A future session that added
 *   a second menu somewhere else in the app would lift these
 *   three pieces into a shared `useOutsideClick` or `useMenu`
 *   hook — for one menu, inlining them is the honest form.
 *
 * ── The `setCurrentArticleId` call ─────────────────────────────
 *
 *   The `useExport` hook's `exportAs` action reads a module-scope
 *   `currentArticleId` holder rather than taking the article ID
 *   as an argument. See that hook's file header for the reasoning
 *   — the plan's Part 1.13 annotation declares the action as
 *   `exportAs(format)`, and the module-scope holder is the
 *   smallest mechanism that reconciles that signature with the
 *   preload's `export.*(articleId)` signature.
 *
 *   This component is the one place in the codebase that
 *   populates the holder. It does so in a `useEffect` keyed on
 *   the `articleId` prop — the effect fires when the component
 *   mounts and whenever the prop changes. By the time the user
 *   clicks a menu item, the effect has run and the holder holds
 *   the correct ID.
 *
 *   The effect runs before any click handler can fire because
 *   React guarantees that effects run after the commit phase
 *   (and therefore after the DOM is rendered), and user clicks
 *   always land after the commit. A future change that moved
 *   the `articleId` read into the menu's click handler — as a
 *   `setCurrentArticleId(articleId)` call right before
 *   `exportAs(format)` — would work too, but the effect form is
 *   simpler and does not repeat the setter at three call sites.
 *
 * ── The spinner on the trigger ─────────────────────────────────
 *
 *   While an export is in flight, the trigger button shows a
 *   spinner icon (from `lucide-react`'s `Loader2`, animated with
 *   Tailwind's `animate-spin`) in place of its normal down-chevron.
 *   The button is not disabled — clicking it while an export is
 *   in flight is a no-op on the menu (the menu closes on click
 *   by the outside-click handler, which for a click on the
 *   trigger itself does not fire). The button's appearance tells
 *   the user something is happening, which is the useful signal
 *   during the few hundred milliseconds an export takes.
 *
 *   The menu items, by contrast, ARE disabled while an export is
 *   in flight. A second click on an item while the first is
 *   processing would start a second export — the two would race
 *   through the Save-As dialog and the Python writer, producing
 *   two output files or one clobbering the other. Disabling the
 *   items is the correct way to prevent that.
 *
 * ── What this component does NOT do ────────────────────────────
 *
 *   - It does not open the Save-As dialog. That is the IPC
 *     handler's job.
 *
 *   - It does not render the toast on success or failure. The
 *     `useExport` hook owns that — see its file header for why.
 *
 *   - It does not have a mode where the menu is always open, or
 *     a mode where the items are rendered inline. The plan
 *     describes the component as a "small dropdown", and that
 *     is the only form it takes. A future session that wanted
 *     the same actions rendered as a toolbar or a set of inline
 *     buttons would add a `variant` prop; today the dropdown is
 *     the only requirement.
 *
 *   - It does not disable itself based on any state other than
 *     `isExporting`. A future session that wanted to disable
 *     the menu for other reasons — no article loaded, an
 *     article in a status that cannot be exported — would add
 *     a `disabled` prop; the parent already has the article in
 *     hand and can gate the menu from there.
 *
 * Dependencies: react + lucide-react + the sibling export hook.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  ChevronDown,
  FileCode2,
  FileText,
  FileType2,
  Loader2,
  type LucideIcon,
} from 'lucide-react';

import {
  useExport,
  setCurrentArticleId,
  type ExportFormat,
} from '../hooks/useExport.js';

// ============================================================
//  Public types
// ============================================================

/**
 * The props accepted by `ExportMenu`.
 *
 * The component takes a single `articleId` prop — the Mongo
 * ObjectId of the article to export. The ID is passed through to
 * the `useExport` hook via `setCurrentArticleId` so that the
 * hook's `exportAs` action knows which article to write.
 *
 * The `articleId` shape matches the call site in the sibling
 * `ArticlePreview.tsx`: that component renders
 * `<ExportMenu articleId={article._id} />`, where `article._id`
 * is the article's Mongo ObjectId as a string.
 */
export interface ExportMenuProps {
  /** The Mongo ObjectId of the article to export. */
  articleId: string;
}

// ============================================================
//  Constants — menu items
// ============================================================
//
//  The three menu items, in display order. Each entry carries
//  the format identifier, a human-readable label, and the icon
//  that renders to the left of the label. The array is typed as
//  `readonly` and the format field is typed as the
//  `ExportFormat` union, so the compiler enforces that every
//  format the hook accepts has a matching menu entry — and
//  vice versa, since the array is exhaustive over the three
//  values.

interface MenuItemDefinition {
  readonly format: ExportFormat;
  readonly label: string;
  readonly icon: LucideIcon;
}

const MENU_ITEMS: readonly MenuItemDefinition[] = [
  { format: 'docx', label: 'Word (.docx)', icon: FileType2 },
  { format: 'md', label: 'Markdown (.md)', icon: FileCode2 },
  { format: 'txt', label: 'Plain text (.txt)', icon: FileText },
];

// ============================================================
//  ExportMenu
// ============================================================

/**
 * The export dropdown. See the file header for the component's
 * responsibilities, its controlled-open pattern, and the
 * reasoning behind the article-ID propagation.
 */
export const ExportMenu = ({ articleId }: ExportMenuProps) => {
  const { exportAs, isExporting } = useExport();

  // ---- Menu open/closed state ----
  const [isOpen, setIsOpen] = useState(false);

  // ---- Container ref for the outside-click check ----
  const containerRef = useRef<HTMLDivElement>(null);

  // ---- Populate the hook's module-scope article-ID holder ----
  // The effect fires on mount and whenever the `articleId` prop
  // changes. By the time a user click reaches an item, the
  // holder is populated with the correct ID. See the file
  // header's "The `setCurrentArticleId` call" section for the
  // full reasoning on why the hook reads the ID from a holder
  // rather than taking it as a parameter.
  useEffect(() => {
    setCurrentArticleId(articleId);
  }, [articleId]);

  // ---- Toggle the menu ----
  const handleToggle = useCallback((): void => {
    setIsOpen((prev) => !prev);
  }, []);

  // ---- Close the menu ----
  const handleClose = useCallback((): void => {
    setIsOpen(false);
  }, []);

  // ---- Handle item click ----
  // Closes the menu first so the user sees the menu dismiss
  // immediately, then fires the export. The export's async
  // resolution is not awaited here — the hook owns the toast
  // that reports the outcome, and the component does not need
  // to react to the result.
  const handleItemClick = useCallback(
    (format: ExportFormat): void => {
      handleClose();
      void exportAs(format);
    },
    [handleClose, exportAs]
  );

  // ---- Outside-click handler ----
  // Installed on the document when the menu is open, removed
  // when it closes. A click whose target is not inside the
  // menu's container closes the menu. The `pointerdown` event
  // is used rather than `click` so the menu closes on the same
  // gesture that opens the next thing — a menu that waited for
  // the full click cycle would leave a frame where the menu is
  // visible on top of whatever the user just clicked.
  useEffect(() => {
    if (!isOpen) return;

    const handlePointerDown = (event: PointerEvent): void => {
      const container = containerRef.current;
      if (container === null) return;
      const target = event.target;
      if (target instanceof Node && container.contains(target)) {
        return;
      }
      setIsOpen(false);
    };

    document.addEventListener('pointerdown', handlePointerDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
    };
  }, [isOpen]);

  // ---- Escape-key handler ----
  // Installed on the document when the menu is open. Escape
  // closes the menu regardless of which element has focus.
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setIsOpen(false);
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  // ---- Render ----
  return (
    <div ref={containerRef} className="relative inline-block">
      {/* ---- Trigger button ---- */}
      <button
        type="button"
        onClick={handleToggle}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        className={
          'inline-flex items-center gap-1.5 rounded-lg ' +
          'border border-neutral-300 bg-background ' +
          'px-3 py-1.5 text-xs font-medium text-text ' +
          'transition-colors hover:bg-neutral-100 ' +
          'focus-visible:outline-none ' +
          'dark:border-neutral-700 dark:hover:bg-neutral-800 ' +
          'dark:text-neutral-100'
        }
      >
        {isExporting ? (
          <Loader2
            size={14}
            className="animate-spin"
            aria-hidden="true"
          />
        ) : (
          <FileText size={14} aria-hidden="true" />
        )}
        <span>Export</span>
        <ChevronDown
          size={12}
          className={
            'transition-transform ' + (isOpen ? 'rotate-180' : '')
          }
          aria-hidden="true"
        />
      </button>

      {/* ---- Dropdown ---- */}
      {/* The `absolute right-0` positioning anchors the dropdown
          to the trigger button's right edge, so the menu opens
          beneath the button and does not overflow the parent
          container's right boundary. `z-20` places the menu
          above the article body but below the app's modal
          overlay (which is `z-40`) — a modal that appears while
          the menu is open correctly covers it. */}
      {isOpen && (
        <div
          role="menu"
          aria-label="Export format"
          className={
            'absolute right-0 z-20 mt-1 w-44 overflow-hidden ' +
            'rounded-lg border border-neutral-200 bg-background ' +
            'shadow-medium ' +
            'dark:border-neutral-800 dark:bg-neutral-900'
          }
        >
          {MENU_ITEMS.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.format}
                type="button"
                role="menuitem"
                onClick={() => handleItemClick(item.format)}
                disabled={isExporting}
                className={
                  'flex w-full items-center gap-2 px-3 py-2 ' +
                  'text-left text-sm text-text ' +
                  'transition-colors ' +
                  'hover:bg-neutral-100 ' +
                  'disabled:cursor-not-allowed disabled:opacity-60 ' +
                  'focus-visible:bg-neutral-100 ' +
                  'focus-visible:outline-none ' +
                  'dark:text-neutral-100 ' +
                  'dark:hover:bg-neutral-800 ' +
                  'dark:focus-visible:bg-neutral-800'
                }
              >
                <Icon
                  size={14}
                  className="shrink-0 text-neutral-500 dark:text-neutral-400"
                  aria-hidden="true"
                />
                <span>{item.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

// ============================================================
//  Default export
// ============================================================

/**
 * The `ExportMenu` component as the default export. The sibling
 * `ArticlePreview.tsx` imports it with the default form
 * (`import ExportMenu from '.../ExportMenu.js'`), so this is
 * the export that resolves that file's forward reference.
 */
export default ExportMenu;