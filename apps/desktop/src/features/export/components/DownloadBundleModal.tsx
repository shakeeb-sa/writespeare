/**
 * DownloadBundleModal — the topic-level "Download bundle" modal.
 *
 * Opened from the topic detail page's header, this modal lets the
 * user choose which of the topic's artifacts go into the bundle
 * ZIP, shows where the ZIP will be written, and fires the
 * `export:bundle` IPC call when the user clicks Download.
 *
 * ── The six artifacts ──────────────────────────────────────────
 *
 *   Each checkbox toggles one `include*` boolean on the options
 *   object the modal passes to `window.electronAPI.export.bundle`.
 *   The six flags correspond one-to-one with the six boolean
 *   fields on the preload's `BundleOptions` interface — the same
 *   shape the `bundleService.ts` main-process worker consumes and
 *   the same shape the `DownloadBundleModal`'s checkboxes were
 *   designed around in the plan's Q3.1 / C2 decisions.
 *
 *   All six default to `true`. The plan's user journey describes
 *   "I check everything" as the canonical flow; a user who wants
 *   only some artifacts unchecks the ones they do not want, which
 *   is the same "default to inclusive" convention the candidate
 *   list uses (Q8.4 / Auto-select).
 *
 * ── The destination display ────────────────────────────────────
 *
 *   The destination section shows the user's current
 *   `bundleDownloadMode` preference — 'ask' (a Save-As dialog
 *   opens on every download) or 'default' (the ZIP is written
 *   silently to `bundleDownloadPath`). When the mode is
 *   'default', the configured path is shown next to the mode so
 *   the user knows exactly where the file will go.
 *
 *   The section is informational, not interactive. A per-download
 *   override would require the preload's `bundle` method to
 *   accept a mode+path argument in addition to the six boolean
 *   flags; the current preload signature
 *   (`bundle(topicId, options)` where `options: BundleOptions`
 *   carries only the six booleans) has no place to pass an
 *   override through. Extending the preload signature is out of
 *   scope for this file, and changing the persisted preference
 *   from inside a per-download modal would surprise a user who
 *   expected the change to be local to this one download.
 *
 *   The section therefore carries a short "Change in Settings"
 *   hint: the user who wants a different destination knows where
 *   to go, and the user who does not care gets a clear statement
 *   of what will happen.
 *
 *   If the mode is 'default' but no path has been configured —
 *   a state the schema permits (the field's default is an empty
 *   string), and a state the user reaches by switching the mode
 *   without setting a path — the section shows a warning rather
 *   than a path. The IPC handler on the main-process side is the
 *   layer that decides what to do in that state (the plan calls
 *   for the bundle handler to fall back to a Save-As dialog when
 *   the mode is 'default' but no path is set); this modal's job
 *   is only to warn the user that the destination is not
 *   currently configured.
 *
 * ── Why the modal has no "Select all / Clear all" toggle ───────
 *
 *   Six checkboxes are few enough that a user can toggle the
 *   whole list by hand in the time it takes to read a single
 *   toggle button's label. The sibling `SourceList` component
 *   has a "Select all / Clear selection" toggle because its list
 *   runs to dozens of candidates; six items is below the
 *   threshold where the toggle pays for its own visual weight.
 *   If a future session adds more artifacts — a "raw HTML"
 *   option, a "source metadata JSON" option — the toggle is a
 *   small addition to this file.
 *
 * ── The download flow ──────────────────────────────────────────
 *
 *   Clicking Download:
 *
 *     1. Sets the local `isDownloading` flag so every control in
 *        the modal disables and the button shows its spinner.
 *     2. Calls `window.electronAPI.export.bundle(topic._id, selection)`.
 *     3. Awaits the response. The response's `data` field is
 *        either the absolute path to the ZIP that was written, or
 *        `null` when the user cancelled the Save-As dialog.
 *     4. On a non-null path: fires a success toast naming the
 *        file, closes the modal.
 *     5. On `null`: no toast (the user knows what they did),
 *        closes the modal.
 *     6. On an error envelope: fires an error toast with the
 *        response's message, leaves the modal open so the user
 *        can retry.
 *     7. On an IPC rejection (an unregistered channel, the
 *        renderer's context being torn down): treats it the same
 *        as an error envelope.
 *
 *   The `finally`-equivalent handling clears `isDownloading`
 *   regardless of which branch ran, so a failed call does not
 *   leave the button permanently disabled.
 *
 * ── What this component does NOT do ────────────────────────────
 *
 *   - It does not assemble the ZIP. The main-process
 *     `bundleService.ts` is the worker; the modal's only job is
 *     to collect the options and dispatch the call.
 *
 *   - It does not open the Save-As dialog. The `export:bundle`
 *     IPC handler on the main-process side opens the dialog when
 *     the user's preference is 'ask'. The modal never sees the
 *     dialog.
 *
 *   - It does not change the download preference. See the file
 *     header's "destination display" section above for the
 *     reasoning on why the section is display-only.
 *
 *   - It does not persist anything. The six checkbox values live
 *     in local component state and are discarded when the modal
 *     closes; the next open starts from the "everything checked"
 *     default. A user who habitually wants only the article in
 *     their bundle will uncheck the same five boxes each time —
 *     a friction a future session could remove by persisting the
 *     last-used selection, but one the current plan does not
 *     call for.
 *
 *   - It does not verify that any artifact exists before calling
 *     the IPC handler. A checked flag on a topic whose
 *     corresponding folder is empty (an unchecked "Report" on a
 *     topic that has never been validated) is a legitimate state
 *     the `bundleService` treats as "include nothing from that
 *     folder" — see that file's header for the reasoning. The
 *     modal does not preemptively disable any checkbox.
 *
 * Dependencies: react + lucide-react + the shared Modal + the
 * shared toast hook + the settings hook + the shared types. All
 * are already present in the codebase.
 */

import {
  useCallback,
  useEffect,
  useState,
} from 'react';
import {
  AlertCircle,
  Download,
  Loader2,
} from 'lucide-react';

import Modal from '../../shared/components/Modal.js';
import { useToast } from '../../shared/hooks/useToast.js';
import { useSettings } from '../../settings/hooks/useSettings.js';
import type { Topic } from '../../shared/types/index.js';

// ============================================================
//  Public types
// ============================================================

/**
 * The six inclusion flags the modal collects and passes to the
 * preload's `export.bundle` method.
 *
 * Structurally identical to the `BundleOptions` interface the
 * preload declares on `window.electronAPI.export.bundle`, and to
 * the `BundleServiceOptions` interface that the main-process
 * `bundleService.ts` consumes (minus the `topicId` and
 * `outputPath` fields, which the IPC handler fills in from its
 * own arguments). The three declarations are kept in sync by
 * hand; a future change to any one of them must be reflected in
 * the other two.
 *
 * Declared locally rather than imported because the preload's
 * shape is a main-context module's private interface, and the
 * renderer has no import path to it. Passing an object literal
 * of this shape to `window.electronAPI.export.bundle` type-checks
 * against the preload's global augmentation, so the compiler
 * still catches a drift between the two shapes at the call site.
 */
interface BundleSelection {
  includeArticle: boolean;
  includeSources: boolean;
  includeReports: boolean;
  includePrompt: boolean;
  includePreset: boolean;
  includeMetadata: boolean;
}

/**
 * The props accepted by `DownloadBundleModal`.
 *
 * The modal is a controlled child of the topic detail page,
 * matching the pattern `NewTopicModal.tsx` uses in the topics
 * feature: the page owns the boolean that determines visibility,
 * and the modal reports back through `onClose` when the user
 * dismisses it or completes the download.
 */
export interface DownloadBundleModalProps {
  /** Whether the modal is currently visible. */
  open: boolean;

  /** Called when the modal should close — by the user dismissing
   *  it (Cancel, X, Escape, overlay click) or by the modal itself
   *  after a successful download. */
  onClose: () => void;

  /** The topic whose bundle is being downloaded. */
  topic: Topic;
}

// ============================================================
//  Internal constants
// ============================================================

/**
 * The default selection: every artifact included.
 *
 * The plan's user journey describes the canonical flow as "you
 * check everything". A fresh modal open therefore starts with all
 * six boxes ticked, and the user's action is to uncheck the ones
 * they do not want. See the file header for the reasoning on why
 * this differs from an "opt-in" default.
 */
const DEFAULT_SELECTION: BundleSelection = {
  includeArticle: true,
  includeSources: true,
  includeReports: true,
  includePrompt: true,
  includePreset: true,
  includeMetadata: true,
};

/**
 * One row in the checkbox list: the key on `BundleSelection`, the
 * display label, and a one-line hint.
 *
 * The array is `readonly` and the `key` field is typed as
 * `keyof BundleSelection`, so the compiler enforces that every
 * entry names a real field on the selection object. Adding a
 * seventh flag to `BundleSelection` without adding it to this
 * array is not a compiler error — the array is not exhaustive
 * over the interface — but a flag that is missing from the array
 * will never appear as a checkbox, which the developer will
 * notice immediately on the next manual test. A future session
 * that wanted compile-time enforcement could add a `satisfies`
 * check; today the two are close enough that the visual mismatch
 * is its own diagnostic.
 */
interface ArtifactDescriptor {
  readonly key: keyof BundleSelection;
  readonly label: string;
  readonly hint: string;
}

const ARTIFACTS: readonly ArtifactDescriptor[] = [
  {
    key: 'includeArticle',
    label: 'Article',
    hint: 'The generated article drafts, in Markdown.',
  },
  {
    key: 'includeSources',
    label: 'Sources',
    hint: 'The scraped source documents the article was written from.',
  },
  {
    key: 'includeReports',
    label: 'Report',
    hint: 'The validation report, as raw JSON and rendered Markdown.',
  },
  {
    key: 'includePrompt',
    label: 'Prompt used',
    hint: 'The prompt template the writer step used.',
  },
  {
    key: 'includePreset',
    label: 'Preset used',
    hint: 'The pipeline configuration snapshot the topic was created with.',
  },
  {
    key: 'includeMetadata',
    label: 'Topic metadata',
    hint: "The topic's raw on-disk configuration record.",
  },
];

// ============================================================
//  DownloadBundleModal
// ============================================================

/**
 * The bundle download modal. See the file header for the modal's
 * responsibilities, the destination-display choice, and the
 * download flow.
 */
export const DownloadBundleModal = ({
  open,
  onClose,
  topic,
}: DownloadBundleModalProps) => {
  const toast = useToast();
  const { settings, loadSettings } = useSettings();

  // ---- Selection state ----
  // The six inclusion flags the user is currently editing. Reset
  // to the "everything checked" default on every open — see the
  // file header for the reasoning on why the selection does not
  // persist between opens.
  const [selection, setSelection] = useState<BundleSelection>(
    DEFAULT_SELECTION
  );

  // ---- Download-in-flight flag ----
  // True between the click on Download and the resolution of the
  // IPC promise. Disables every control in the modal and drives
  // the spinner on the Download button.
  const [isDownloading, setIsDownloading] = useState(false);

  // ---- Reset selection on open ----
  // The effect fires whenever the modal transitions from closed
  // to open. The reset is idempotent — the modal does not care
  // if the previous session's selection was different, and
  // restoring the default on every open is the documented
  // behaviour.
  useEffect(() => {
    if (open) {
      setSelection(DEFAULT_SELECTION);
      setIsDownloading(false);
    }
  }, [open]);

  // ---- Load settings on open if not already loaded ----
  // The settings store holds the `bundleDownloadMode` and
  // `bundleDownloadPath` values the destination display reads.
  // On a cold app start, the store is empty when the modal
  // first opens; the effect triggers the fetch. On a warm
  // start, the store already has the values and the fetch is
  // skipped. The settings hook exposes `loadSettings` as a
  // stable Zustand action reference, so the effect only fires
  // on the `open` transition.
  useEffect(() => {
    if (open && settings === null) {
      void loadSettings();
    }
  }, [open, settings, loadSettings]);

  // ---- Checkbox toggle handler ----
  const handleToggle = useCallback((key: keyof BundleSelection): void => {
    setSelection((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  // ---- Download handler ----
  const handleDownload = useCallback((): void => {
    if (isDownloading) {
      return;
    }
    setIsDownloading(true);
    void (async (): Promise<void> => {
      try {
        const result = await window.electronAPI.export.bundle(
          topic._id,
          selection
        );

        if (!result.success) {
          toast.error(
            result.error ?? 'Failed to download the bundle.'
          );
          return;
        }

        // A success envelope with a non-null `data` field means
        // the ZIP was written and `data` is its absolute path.
        // A success envelope with a null `data` field means the
        // user cancelled the Save-As dialog.
        if (result.data !== null && result.data !== undefined) {
          const filename =
            result.data.split(/[\\/]/).pop() ?? result.data;
          toast.success(`Downloaded ${filename}`);
          onClose();
        } else {
          // Cancelled — close the modal without a toast. The
          // user knows what they did.
          onClose();
        }
      } catch (err) {
        console.error(
          '[DownloadBundleModal] bundle IPC failed:',
          err
        );
        toast.error('Unable to reach the export service.');
      } finally {
        setIsDownloading(false);
      }
    })();
  }, [isDownloading, topic._id, selection, toast, onClose]);

  // ---- Destination display ----
  // Derived from the settings store. The three possible states:
  //
  //   1. Mode is 'ask' — the modal shows "Ask each time".
  //   2. Mode is 'default' with a non-empty path — the modal
  //      shows the path.
  //   3. Mode is 'default' with an empty path — the modal shows
  //      the warning.
  //
  // When the settings store is empty (not yet loaded), the modal
  // assumes the schema's default mode ('ask') rather than showing
  // a loading state for a non-critical section. The schema
  // declares `bundleDownloadMode` with a default of 'ask'; the
  // placeholder is honest about what the user's default is
  // before the fetch completes.
  const downloadMode: 'ask' | 'default' =
    settings?.bundleDownloadMode ?? 'ask';
  const downloadPath: string = settings?.bundleDownloadPath ?? '';
  const defaultPathIsSet =
    downloadMode === 'default' && downloadPath.length > 0;
  const defaultPathIsMissing =
    downloadMode === 'default' && downloadPath.length === 0;

  // ---- Derived flags ----
  const anySelected = Object.values(selection).some(Boolean);
  const submitDisabled = isDownloading || !anySelected;

  // ---- Render ----
  return (
    <Modal
      open={open}
      onClose={onClose}
      variant="info"
      size="lg"
      title="Download bundle"
      closeOnOverlay={!isDownloading}
      closeOnEscape={!isDownloading}
      showCloseButton={!isDownloading}
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            disabled={isDownloading}
            className={
              'rounded-lg border border-neutral-300 bg-background ' +
              'px-4 py-2 text-sm font-medium text-text ' +
              'transition-colors hover:bg-neutral-100 ' +
              'disabled:cursor-not-allowed disabled:opacity-60 ' +
              'dark:border-neutral-700 dark:hover:bg-neutral-800 ' +
              'focus-visible:outline-none'
            }
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleDownload}
            disabled={submitDisabled}
            className={
              'inline-flex items-center gap-2 rounded-lg bg-primary ' +
              'px-4 py-2 text-sm font-medium text-white ' +
              'transition-colors hover:bg-primary-dark ' +
              'disabled:cursor-not-allowed disabled:opacity-60 ' +
              'focus-visible:outline-none'
            }
          >
            {isDownloading ? (
              <>
                <Loader2
                  size={16}
                  className="animate-spin"
                  aria-hidden="true"
                />
                <span>Downloading…</span>
              </>
            ) : (
              <>
                <Download size={16} aria-hidden="true" />
                <span>Download</span>
              </>
            )}
          </button>
        </>
      }
    >
      {/* ---- Intro paragraph ---- */}
      <p
        className={
          'text-sm leading-relaxed text-neutral-600 ' +
          'dark:text-neutral-300'
        }
      >
        Pick the artifacts to include in the ZIP. Only the checked
        items are bundled; artifacts that do not exist for this
        topic are skipped silently.
      </p>

      {/* ---- Checkbox list ---- */}
      <fieldset
        className="mt-5 space-y-2 border-0 p-0"
        disabled={isDownloading}
      >
        <legend className="sr-only">Artifacts to include</legend>
        {ARTIFACTS.map((artifact) => {
          const checked = selection[artifact.key];
          return (
            <label
              key={artifact.key}
              className={
                'flex cursor-pointer items-start gap-3 rounded-lg ' +
                'border border-neutral-200 bg-background p-3 ' +
                'transition-colors hover:bg-neutral-50 ' +
                'dark:border-neutral-800 ' +
                'dark:hover:bg-neutral-800/40 ' +
                (isDownloading
                  ? 'cursor-not-allowed opacity-60'
                  : '')
              }
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={() => handleToggle(artifact.key)}
                disabled={isDownloading}
                className={
                  'mt-0.5 h-4 w-4 cursor-pointer rounded ' +
                  'border-neutral-300 text-primary accent-primary ' +
                  'disabled:cursor-not-allowed ' +
                  'focus-visible:outline-none ' +
                  'dark:border-neutral-600 dark:bg-neutral-950'
                }
              />
              <span className="min-w-0 flex-1">
                <span
                  className={
                    'block text-sm font-medium text-text ' +
                    'dark:text-neutral-100'
                  }
                >
                  {artifact.label}
                </span>
                <span
                  className={
                    'mt-0.5 block text-xs text-neutral-500 ' +
                    'dark:text-neutral-400'
                  }
                >
                  {artifact.hint}
                </span>
              </span>
            </label>
          );
        })}
      </fieldset>

      {/* ---- Destination section ---- */}
      {/* Informational, not interactive. See the file header's
          "destination display" section for the reasoning. */}
      <div
        className={
          'mt-5 rounded-lg border border-neutral-200 ' +
          'bg-neutral-50 p-3 ' +
          'dark:border-neutral-800 dark:bg-neutral-900/40'
        }
      >
        <p
          className={
            'text-xs font-medium uppercase tracking-wide ' +
            'text-neutral-500 dark:text-neutral-400'
          }
        >
          Destination
        </p>

        {downloadMode === 'ask' && (
          <p
            className={
              'mt-1 text-sm text-text dark:text-neutral-100'
            }
          >
            Ask each time — a Save-As dialog will open.
          </p>
        )}

        {defaultPathIsSet && (
          <p
            className={
              'mt-1 break-all text-sm text-text ' +
              'dark:text-neutral-100'
            }
          >
            <span className="font-mono text-xs">{downloadPath}</span>
          </p>
        )}

        {defaultPathIsMissing && (
          <div
            role="alert"
            className={
              'mt-1 flex items-start gap-2 text-sm ' +
              'text-amber-700 dark:text-amber-400'
            }
          >
            <AlertCircle
              size={16}
              className="mt-0.5 shrink-0"
              aria-hidden="true"
            />
            <span>
              Save to default location is selected, but no default
              path is configured. The download will fall back to
              a Save-As dialog.
            </span>
          </div>
        )}

        <p
          className={
            'mt-2 text-xs text-neutral-500 ' +
            'dark:text-neutral-400'
          }
        >
          Change the destination in Settings → General.
        </p>
      </div>
    </Modal>
  );
};

// ============================================================
//  Default export
// ============================================================

/**
 * The `DownloadBundleModal` component as the default export.
 * `TopicDetail.tsx` imports it with the default form when the
 * same PR's modification to that file lands — see the PR-5 block
 * of the manifest — so this is the export that resolves the
 * forward reference.
 */
export default DownloadBundleModal;