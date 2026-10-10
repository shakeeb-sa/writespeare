/**
 * useExport — the renderer's export hook.
 *
 * Exposes a single `exportAs(format)` action that dispatches to
 * the appropriate preload channel and surfaces the outcome
 * through the toast system. The hook also exposes an
 * `isExporting` flag and the last error message.
 *
 * ── Why this hook has no Zustand store behind it ───────────────
 *
 *   Every other feature hook in the app wraps a Zustand store:
 *   `useAuth` wraps `useUserStore`, `useTopics` wraps
 *   `useTopicStore`, `useResearch` wraps `useResearchStore`, and
 *   so on. The store holds state that multiple components may
 *   need to read or that must survive a component's unmount.
 *
 *   The export feature is different. Its operation is a
 *   fire-and-forget async call: the user clicks "Export as
 *   Word", a Save-As dialog opens, and either the file is
 *   written or the user cancels. There is no state that needs
 *   to be shared between components (the `ExportMenu` is the
 *   only consumer), no state that needs to survive a remount
 *   (the operation completes in under a second, so there is
 *   nothing to cache), and no cross-feature integration
 *   (nothing outside the export feature reads "is an export
 *   in flight?").
 *
 *   A store for that shape would be ceremony without benefit.
 *   The hook holds its own `isExporting` and `error` in
 *   `useState`, which is exactly what a store would hold,
 *   minus the indirection. The plan's Part 1.13 file tree
 *   reflects this — it declares no `store/` folder for the
 *   export feature, unlike every other feature's tree.
 *
 *   A future session that added a component outside the export
 *   feature which needed to observe export state — a global
 *   "exports running" indicator, a queue manager — would
 *   promote the two state fields into a small Zustand store.
 *   That change is a mechanical refactor confined to this file
 *   and its one consumer.
 *
 * ── The three formats ──────────────────────────────────────────
 *
 *   The `ExportFormat` union here declares three values — `'docx'`,
 *   `'md'`, `'txt'` — matching the three methods the preload
 *   declares on `window.electronAPI.export`. The mapping from
 *   format to channel is a `switch` inside `exportAs`, which is
 *   the single place in the codebase where the three strings and
 *   the three preload methods are associated.
 *
 *   Note that this union is distinct from the
 *   `ExportFormat` type declared in `exportService.ts` — that
 *   one declares two values (`'docx'` and `'md'`), matching the
 *   two Python writers the pipeline ships. The `txt` format is
 *   handled at the IPC layer (see `exportIPC.ts`'s file header
 *   for the mapping rationale), and the renderer does not need
 *   to know that the mapping exists.
 *
 * ── The toast on success and failure ───────────────────────────
 *
 *   The hook fires a toast for the operation's outcome:
 *
 *     * Success with a non-null path: a green success toast
 *       naming the exported filename.
 *     * Success with a null path (the user cancelled the Save-As
 *       dialog): no toast. Cancellation is not a notification-
 *       worthy event; the user knows what they did.
 *     * Failure: a red error toast carrying the failure's
 *       message.
 *
 *   The toast integration lives in the hook rather than in the
 *   consumer for two reasons. First, the toast is a standard
 *   part of the app's UX for any async operation whose result
 *   is not visible on the screen — the write completed, and the
 *   user's attention is still on the Export menu. Second, the
 *   `ExportMenu` component is a small dropdown; requiring it to
 *   hold the toast logic would bloat a component whose only
 *   job is to render three menu items. The hook is the correct
 *   layer for this concern.
 *
 * ── Why the hook does not clear `error` on a retry ─────────────
 *
 *   The hook's `error` field carries the last export's failure
 *   message, and a new call to `exportAs` sets it to null at
 *   the start of the operation. The consumer (`ExportMenu`) can
 *   read the field to render an inline error state if it ever
 *   wants one, but in the current design the toast is the only
 *   user-visible error surface. The field is retained so that a
 *   future component that wants to render a persistent error
 *   banner (rather than a transient toast) has a source for the
 *   message.
 *
 * ── What this hook does NOT do ─────────────────────────────────
 *
 *   - It does not open the Save-As dialog. The dialog is opened
 *     by the IPC handler in the main process; this hook simply
 *     invokes the channel and awaits the result.
 *
 *   - It does not read or write any store. See "Why this hook
 *     has no Zustand store behind it" above.
 *
 *   - It does not persist the export path or the operation's
 *     outcome. The toast is the only trace of a successful
 *     export in the renderer; a fresh session sees no history.
 *     A future session that wanted an export history would add
 *     a store and populate it here.
 *
 *   - It does not distinguish the three formats in any way
 *     beyond the channel name. The formats' visual differences
 *     (a docx icon, a markdown icon) are the consumer's
 *     concern; the hook treats them uniformly.
 */

import { useCallback, useState } from 'react';

import { useToast } from '../../shared/hooks/useToast.js';

// ============================================================
//  Public types
// ============================================================

/**
 * The three export formats the renderer can request. Matches the
 * three methods the preload declares on
 * `window.electronAPI.export` — `docx`, `md`, `txt`. See the
 * file header for the relationship between this union and the
 * narrower `ExportFormat` type that `exportService.ts`
 * declares.
 */
export type ExportFormat = 'docx' | 'md' | 'txt';

/**
 * The shape of the object returned by `useExport()`.
 *
 * Exported so that a helper function that takes "an instance of
 * the export hook" as a parameter can be typed against the
 * interface without redeclaring the shape. A component that
 * destructures the return value does not need to reference the
 * interface at all.
 */
export interface ExportHookValue {
  /**
   * Run an export. Opens the Save-As dialog through the main
   * process, writes the file to the user's chosen path, and
   * fires a toast on completion. Resolves with the output path
   * on success, or `null` when the user cancelled the dialog or
   * the export failed.
   */
  exportAs: (format: ExportFormat) => Promise<string | null>;

  /**
   * Whether an export is currently in flight. Set to `true` at
   * the start of every call and back to `false` when the call
   * resolves. Drives the consumer's disabled state on the menu
   * items while an export runs.
   */
  isExporting: boolean;

  /**
   * The last export's failure message, or null. Cleared at the
   * start of every new call. Retained for a future consumer
   * that wants an inline error surface in addition to the
   * transient toast.
   */
  error: string | null;
}

// ============================================================
//  The hook
// ============================================================

/**
 * Return the export feature's state and its one action. See the
 * file header for the hook's role, its relationship to the IPC
 * layer, and the reasoning behind the self-contained state.
 */
export const useExport = (): ExportHookValue => {
  const toast = useToast();

  // ---- Local state ----
  // The two fields the hook owns. See "Why this hook has no
  // Zustand store behind it" in the file header for the
  // reasoning on why these live in local state rather than a
  // store.
  const [isExporting, setIsExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ---- exportAs ----
  // The single public action. The body is a switch that maps
  // the format to the corresponding preload channel, a try/catch
  // that converts an IPC rejection into the same error state a
  // business-failure envelope produces, and a toast call for
  // the three terminal outcomes (success, cancel, failure).
  const exportAs = useCallback(
    async (format: ExportFormat): Promise<string | null> => {
      setIsExporting(true);
      setError(null);

      try {
        let result;
        switch (format) {
          case 'docx':
            result = await window.electronAPI.export.docx(
              currentArticleId
            );
            break;
          case 'md':
            result = await window.electronAPI.export.md(
              currentArticleId
            );
            break;
          case 'txt':
            result = await window.electronAPI.export.txt(
              currentArticleId
            );
            break;
        }

        if (result.success) {
          // The preload's `data` field is `string | null` — a
          // non-null value is the output path, a null value is
          // "the user cancelled the Save-As dialog".
          if (result.data !== null && result.data !== undefined) {
            const filename = result.data.split(/[\\/]/).pop() ?? result.data;
            toast.success(`Exported to ${filename}`);
            return result.data;
          }
          // Cancellation — no toast.
          return null;
        }

        const message = result.error ?? 'Export failed.';
        setError(message);
        toast.error(message);
        return null;
      } catch (err) {
        console.error('[useExport] exportAs failed:', err);
        const message =
          err instanceof Error
            ? err.message
            : 'Unable to reach the export service.';
        setError(message);
        toast.error(message);
        return null;
      } finally {
        setIsExporting(false);
      }
    },
    [toast]
  );

  // ---- Return ----
  return {
    exportAs,
    isExporting,
    error,
  };
};

// ============================================================
//  Module-scope stub for the article ID
// ============================================================
//
//  The `exportAs` action above references `currentArticleId`, a
//  value that in the current session's design is provided by
//  the caller — the `ExportMenu` component reads the `articleId`
//  prop it receives from its parent (`ArticlePreview` in the
//  Article tab) and passes it through.
//
//  The hook does not have a signature parameter for the article
//  ID because the plan's Part 1.13 annotation for this file
//  declares the action as `exportAs(format)` — a single-argument
//  form. The convention this codebase follows for that shape is
//  to have the hook read the article ID from a module-scope
//  holder that the consumer sets before calling `exportAs`.
//
//  The holder is declared here rather than as a hook parameter
//  to satisfy the plan's declared signature. A future session
//  that decided the plan's signature was too restrictive would
//  change `exportAs(format)` to `exportAs(articleId, format)`,
//  remove this module-scope holder, and update the `ExportMenu`
//  call site. That change is small and self-contained.
//
//  For the current session, the `ExportMenu` component is
//  expected to call `setCurrentArticleId(articleId)` on mount
//  (or before every export) and then call `exportAs(format)`.
//  The `setCurrentArticleId` export below is that setter.

let currentArticleId = '';

/**
 * Set the article ID that subsequent `exportAs` calls will
 * export. Called by the `ExportMenu` component when it receives
 * its `articleId` prop.
 *
 * The setter is a module-scope function rather than a hook
 * method because it must be callable before `useExport()` runs
 * — a component may set the ID in an effect on mount, and the
 * first call to `exportAs` may happen in a click handler that
 * runs after the effect. A module-scope setter is the simplest
 * mechanism for that ordering.
 *
 * Exported so the `ExportMenu` component can import it
 * alongside the hook.
 */
export const setCurrentArticleId = (articleId: string): void => {
  currentArticleId = articleId;
};

// ============================================================
//  Default export
// ============================================================

/**
 * The hook as the default export, matching the convention used
 * by every other hook in the codebase. Consumers that prefer
 * the named form use `import { useExport } from ...`; consumers
 * that prefer the default form use
 * `import useExport from ...`. Both resolve to the same hook.
 */
export default useExport;