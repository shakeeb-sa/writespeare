/**
 * DocumentList — the list of doc files attached to a topic.
 *
 * The central component of the Documents tab. It loads the doc
 * files for the topic it is given, renders them as a list of
 * rows, and opens the `DocumentPreview` modal when the user
 * clicks a row's preview button.
 *
 * ── The topic prop ─────────────────────────────────────────────
 *
 *   The component takes the full `Topic` object rather than just
 *   a topic ID. The pattern matches every other component
 *   rendered inside `TopicDetail.tsx` — the parent already has
 *   the topic in hand, and passing it through is zero friction.
 *
 *   The `topic._id` value is used in five places:
 *
 *     1. As the hook argument (`useDocuments(topic._id)`), which
 *        scopes every data field and action to this topic.
 *     2. As the first argument to `loadDocuments`, `deleteDocument`,
 *        `selectDocument`, and `clearError` — every per-topic
 *        action on the store takes a topic ID as its first
 *        argument.
 *     3. As the `topicId` prop passed to the mounted
 *        `<DocumentPreview />` so the preview reads the same
 *        per-topic slot.
 *
 *   A future reader who wonders "why the whole topic?" sees the
 *   answer: consistency with the sibling components that render
 *   inside the same tab, all of which take the same `Topic` prop.
 *
 * ── The hook signature (PR-1) ──────────────────────────────────
 *
 *   `useDocuments(topic._id)` — the hook now takes the topic ID
 *   as its required first argument so this component reads the
 *   store's per-topic slots for the topic it was given. See
 *   `useDocuments.ts`'s file header for the full rationale on
 *   the signature change; the short version is Q4.3's "refactor
 *   all feature stores to key by topicId in the same pass."
 *
 * ── The four visual states ─────────────────────────────────────
 *
 *   The component renders one of four states, driven by the
 *   topic's `status` slot and by whether the `documents` array
 *   is populated:
 *
 *     1. LOADING — `status === 'loading'` and no documents are
 *        currently shown. A centered spinner.
 *
 *     2. ERROR — `status === 'error'` and the error message is
 *        non-null. A red banner with the message and a "Try
 *        again" button that re-runs `loadDocuments(topic._id)`.
 *
 *     3. EMPTY — `status === 'idle'` and `documents.length === 0`.
 *        A friendly empty state telling the user where the doc
 *        files come from and pointing them at the Sources tab.
 *
 *     4. POPULATED — `status === 'idle'` (or a background
 *        refresh that is still in flight) and `documents.length >
 *        0`. The list of document rows.
 *
 *   The `status` / `documents.length` combinations are read in
 *   that priority order — loading before error before empty
 *   before populated — because a topic whose store slot is
 *   loading but whose list still holds a previous load's
 *   documents should show the stale list rather than a spinner.
 *   The "loading" state only fires when the list is empty, which
 *   is the cold-start case.
 *
 * ── The DocumentPreview modal ──────────────────────────────────
 *
 *   The list mounts a `<DocumentPreview topicId={topic._id} />`
 *   at the bottom of its own render tree. The preview component
 *   reads the same per-topic `selectedDocument` slot through
 *   `useDocuments(topicId)`, renders itself as a modal when that
 *   slot is non-null, and calls `selectDocument(topicId, null)`
 *   when the user dismisses it.
 *
 *   This arrangement — the list owns the preview's mount, but
 *   the store owns the preview's open/closed state — is what
 *   lets the two components communicate without the list having
 *   to thread a `selected` prop down. The alternative (the list
 *   holds `const [preview, setPreview] = useState<Document | null>(null)`
 *   and passes it to the modal) would duplicate the state that
 *   the store already has a field for.
 *
 * ── The delete confirmation ────────────────────────────────────
 *
 *   Deleting a doc file is irreversible from the UI's
 *   perspective — the file is removed from disk and there is no
 *   undo path. The delete button therefore opens a confirmation
 *   modal (through the shared `useModal()` API) rather than
 *   deleting immediately. The pattern is the same one
 *   `TopicCard.tsx` uses for its topic-delete confirmation, and
 *   it is the standard "destructive action" pattern for the app.
 *
 *   On confirmation, the component calls
 *   `deleteDocument(topic._id, document._id)` and fires a success
 *   or error toast based on the boolean the action resolves with.
 *   The topic's `documents` slot is updated by the action itself,
 *   so the list re-renders without any additional work in this
 *   component.
 *
 * ── What this component does NOT do ────────────────────────────
 *
 *   - It does not fetch the doc file's content when a preview is
 *     requested. The `Document` object the store holds already
 *     carries the `content` field — the main process populated it
 *     from disk when the list was fetched. Clicking a preview
 *     button just writes to the topic's `selectedDocument` slot
 *     on the store, and the preview modal renders the content
 *     that is already in memory.
 *
 *   - It does not offer an "open in external editor" action.
 *     Adding one would use the preload's
 *     `window.electronAPI.utils.showItemInFolder` method, but the
 *     plan's user journey does not call for it. A future session
 *     that wants it would add a small button to each row's action
 *     group — the same shape as the preview button.
 *
 *   - It does not sort or filter the list. The order is
 *     determined by the main process's `documentService`, which
 *     preserves the extraction pipeline's batch order. If a
 *     future session adds a sort control, that state belongs in
 *     the documents store, and this component would read it the
 *     same way it reads `documents`.
 *
 *   - It does not persist anything. See the documents store's
 *     file header for the non-persistence rationale.
 */

import {
  useCallback,
  useEffect,
  useState,
} from 'react';
import {
  AlertCircle,
  Eye,
  FileText,
  Loader2,
  Trash2,
} from 'lucide-react';

import { useDocuments } from '../hooks/useDocuments.js';
import { useToast } from '../../shared/hooks/useToast.js';
import { useModal } from '../../shared/components/Modal.js';
import DocumentPreview from './DocumentPreview.js';
import type {
  Document,
  Topic,
} from '../../shared/types/index.js';

// ============================================================
//  Public types
// ============================================================

/**
 * The props accepted by `DocumentList`.
 *
 * The component takes the full `Topic` object rather than just an
 * ID — see the file header for the reasoning. The `topic` prop is
 * the same one the sibling `SearchProgress`, `SourceList`, and
 * other stage components on the topic-detail page receive.
 */
export interface DocumentListProps {
  /** The topic whose documents this list represents. */
  topic: Topic;
}

// ============================================================
//  Internal helpers — platform badge
// ============================================================
//
// Same label and class tables the sibling `SourceCandidate.tsx`
// uses on the Sources tab. The two are duplicated rather than
// shared because the plan's tree declares no shared platform-badge
// component, and the duplication is bounded — two small maps that
// would be a two-line edit in each file if a new platform were
// ever added.
//
// The visual treatment is identical between the two tabs, so a
// candidate the user reviewed on Sources looks the same when its
// extracted doc appears here — the two views share a badge
// vocabulary.

const PLATFORM_LABELS: Record<string, string> = {
  reddit: 'Reddit',
  quora: 'Quora',
  medium: 'Medium',
  twitter: 'Twitter',
  generic: 'Web',
};

const PLATFORM_CLASSES: Record<string, string> = {
  reddit:
    'bg-orange-100 text-orange-800 ' +
    'dark:bg-orange-950/60 dark:text-orange-200',
  quora:
    'bg-red-100 text-red-800 ' +
    'dark:bg-red-950/60 dark:text-red-200',
  medium:
    'bg-neutral-200 text-neutral-800 ' +
    'dark:bg-neutral-800 dark:text-neutral-200',
  twitter:
    'bg-sky-100 text-sky-800 ' +
    'dark:bg-sky-950/60 dark:text-sky-200',
  generic:
    'bg-neutral-100 text-neutral-700 ' +
    'dark:bg-neutral-800 dark:text-neutral-300',
};

const FALLBACK_BADGE_CLASS =
  'bg-neutral-100 text-neutral-700 ' +
  'dark:bg-neutral-800 dark:text-neutral-300';

/**
 * The same relative-time formatter used by `TopicCard.tsx`. The
 * duplication is bounded (twenty lines) and consistent — the two
 * components produce the same labels for the same timestamps, so
 * a document fetched three minutes ago reads "3m ago" the same
 * way a topic created three minutes ago does.
 *
 * See `TopicCard.tsx`'s `formatRelativeTime` docstring for the
 * reasoning behind the thresholds and the fallback.
 */
const formatRelativeTime = (iso: string): string => {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const diffMs = now - then;

  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffSec < 60) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHour < 24) return `${diffHour}h ago`;
  if (diffDay < 7) return `${diffDay}d ago`;
  return new Date(iso).toLocaleDateString();
};

// ============================================================
//  Internal — DocumentRow
// ============================================================
//
// One row in the document list. Not exported — the list is the
// only consumer, and every row takes the same shape.

interface DocumentRowProps {
  document: Document;
  onPreview: (document: Document) => void;
  onDelete: (document: Document) => void;
}

const DocumentRow = ({
  document,
  onPreview,
  onDelete,
}: DocumentRowProps) => {
  const platformLabel =
    PLATFORM_LABELS[document.platform] ?? document.platform;
  const platformClass =
    PLATFORM_CLASSES[document.platform] ?? FALLBACK_BADGE_CLASS;

  const handlePreview = useCallback((): void => {
    onPreview(document);
  }, [onPreview, document]);

  const handleDelete = useCallback((): void => {
    onDelete(document);
  }, [onDelete, document]);

  // The document's `_id` is the file's absolute path — see
  // `documentService.ts`'s header for the rationale on that
  // mapping. The `title` field is the frontmatter title the
  // extraction pipeline wrote; when it is absent (a malformed
  // file), the fallback uses the file path's last segment so
  // the row is still identifiable.
  const displayTitle =
    document.title.length > 0
      ? document.title
      : document._id.split(/[\\/]/).pop() ?? 'Untitled document';

  return (
    <div
      className={
        'flex items-start gap-3 rounded-xl border p-3 ' +
        'border-neutral-200 bg-background ' +
        'transition-colors hover:border-neutral-300 ' +
        'dark:border-neutral-800 ' +
        'dark:hover:border-neutral-700'
      }
    >
      {/* ---- Icon ---- */}
      <div
        className={
          'flex h-9 w-9 shrink-0 items-center justify-center ' +
          'rounded-lg bg-neutral-100 text-neutral-500 ' +
          'dark:bg-neutral-800 dark:text-neutral-400'
        }
      >
        <FileText size={18} aria-hidden="true" />
      </div>

      {/* ---- Content ---- */}
      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-2">
          <span
            className={
              'shrink-0 rounded-full px-2 py-0.5 text-[10px] ' +
              'font-medium uppercase tracking-wide ' +
              platformClass
            }
          >
            {platformLabel}
          </span>
          <p
            className={
              'line-clamp-2 min-w-0 flex-1 text-sm font-medium ' +
              'text-text dark:text-neutral-100'
            }
            title={displayTitle}
          >
            {displayTitle}
          </p>
        </div>

        {/* URL, if present. The URL is not always useful for
            identification — the title carries more signal — but
            showing it lets a user who recognizes a domain
            confirm which source a doc came from. */}
        {document.url.length > 0 && (
          <p
            className={
              'mt-0.5 truncate text-xs text-neutral-500 ' +
              'dark:text-neutral-400'
            }
            title={document.url}
          >
            {document.url}
          </p>
        )}

        {/* Metadata line: word count and fetch time. */}
        <div
          className={
            'mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 ' +
            'text-xs text-neutral-500 dark:text-neutral-400'
          }
        >
          <span>
            {document.wordCount.toLocaleString()}{' '}
            {document.wordCount === 1 ? 'word' : 'words'}
          </span>
          <span aria-hidden="true">·</span>
          <span>{formatRelativeTime(document.fetchedAt)}</span>
        </div>
      </div>

      {/* ---- Actions ---- */}
      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={handlePreview}
          aria-label={`Preview ${displayTitle}`}
          title="Preview"
          className={
            'rounded-md p-1.5 text-neutral-500 ' +
            'transition-colors ' +
            'hover:bg-neutral-100 hover:text-primary ' +
            'focus-visible:outline-none ' +
            'dark:text-neutral-400 ' +
            'dark:hover:bg-neutral-800 ' +
            'dark:hover:text-primary-light'
          }
        >
          <Eye size={16} aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={handleDelete}
          aria-label={`Delete ${displayTitle}`}
          title="Delete"
          className={
            'rounded-md p-1.5 text-neutral-500 ' +
            'transition-colors ' +
            'hover:bg-red-50 hover:text-red-700 ' +
            'focus-visible:outline-none ' +
            'dark:text-neutral-400 ' +
            'dark:hover:bg-red-950/60 ' +
            'dark:hover:text-red-400'
          }
        >
          <Trash2 size={16} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
};

// ============================================================
//  DocumentList
// ============================================================

/**
 * The list of doc files attached to a topic. See the file header
 * for the component's responsibilities, its four visual states,
 * and its relationship to the preview modal and the confirmation
 * modal.
 */
export const DocumentList = ({ topic }: DocumentListProps) => {
  const {
    documents,
    status,
    error,
    loadDocuments,
    deleteDocument,
    selectDocument,
    clearError,
  } = useDocuments(topic._id);

  const toast = useToast();
  const modal = useModal();

  // Local state for the load-in-flight flag on the "Try again"
  // button. The store's `status` field is the source of truth
  // for rendering, but a caller that wants to disable the button
  // during a re-load needs to know whether a new load is
  // running even when the previous list is still displayed. A
  // small piece of local state — `retrying` — is the simplest
  // way to track that.
  const [retrying, setRetrying] = useState(false);

  // ---- Load on mount + on topic change ----
  // The effect fires when the component mounts or when
  // `topic._id` changes — the two moments the documents list
  // needs a fresh fetch. The `activeTopicId` check avoids a
  // redundant fetch when the store already holds the correct
  // topic's documents (the common case when the topic-detail
  // page's tab is switched back and forth).
  //
  // The `loadDocuments` reference is stable (a Zustand action
  // selected directly from the store), so listing it as a
  // dependency does not cause the effect to re-run on every
  // render.
  useEffect(() => {
    void loadDocuments(topic._id);
  }, [loadDocuments, topic._id]);

  // ---- Preview handler ----
  // Sets the store's `selectedDocument`, which the mounted
  // `<DocumentPreview />` reads to decide whether to render. The
  // component does not hold the preview state itself — see the
  // file header for the reasoning.
  const handlePreview = useCallback(
    (document: Document): void => {
      selectDocument(topic._id, document);
    },
    [selectDocument, topic._id]
  );

  // ---- Delete handler ----
  // Opens a confirmation modal. The modal's "Delete" button calls
  // the actual delete and closes the modal on the same click.
  const performDelete = useCallback(
    (document: Document): void => {
      void (async (): Promise<void> => {
        const ok = await deleteDocument(topic._id, document._id);
        if (ok) {
          toast.success('Document deleted.');
        } else {
          toast.error('Failed to delete document.');
        }
      })();
    },
    [deleteDocument, topic._id, toast]
  );

  const handleDelete = useCallback(
    (document: Document): void => {
      // The dialog's title is the doc's title if it has one,
      // otherwise the file path's last segment. Same fallback as
      // the row's `displayTitle`.
      const displayTitle =
        document.title.length > 0
          ? document.title
          : document._id.split(/[\\/]/).pop() ?? 'this document';

      modal.open({
        title: 'Delete document?',
        variant: 'danger',
        size: 'sm',
        content: (
          <p>
            Are you sure you want to delete{' '}
            <strong className="font-semibold">{displayTitle}</strong>?
            The file will be removed from disk. This cannot be undone.
          </p>
        ),
        footer: (
          <>
            <button
              type="button"
              onClick={() => modal.close()}
              className={
                'rounded-lg border border-neutral-300 bg-background ' +
                'px-4 py-2 text-sm font-medium text-text ' +
                'transition-colors hover:bg-neutral-100 ' +
                'dark:border-neutral-700 dark:hover:bg-neutral-800 ' +
                'focus-visible:outline-none'
              }
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => {
                modal.close();
                performDelete(document);
              }}
              className={
                'rounded-lg bg-red-600 px-4 py-2 text-sm ' +
                'font-medium text-white transition-colors ' +
                'hover:bg-red-700 focus-visible:outline-none'
              }
            >
              Delete
            </button>
          </>
        ),
      });
    },
    [modal, performDelete]
  );

  // ---- Retry handler ----
  // Used by the error state's "Try again" button. Clears the
  // previous error (so the banner does not linger while the
  // retry is in flight), sets the local `retrying` flag, awaits
  // the fetch, and clears the flag. The store's own `status`
  // field reflects the outcome.
  const handleRetry = useCallback((): void => {
    void (async (): Promise<void> => {
      clearError(topic._id);
      setRetrying(true);
      try {
        await loadDocuments(topic._id);
      } finally {
        setRetrying(false);
      }
    })();
  }, [clearError, loadDocuments, topic._id]);

  // ---- State 1: LOADING ----
  // Only shows the spinner when there is no list to display. A
  // re-load that has a previous list in hand keeps the list on
  // screen rather than flashing a spinner.
  const isInitialLoad =
    status === 'loading' && documents.length === 0;

  if (isInitialLoad) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2
          size={28}
          className="animate-spin text-primary"
          aria-hidden="true"
        />
        <span className="sr-only">Loading documents…</span>
      </div>
    );
  }

  // ---- State 2: ERROR ----
  // Shown when the last load failed AND there is no list to fall
  // back on. If the list is populated from a previous successful
  // load, an error banner would be more confusing than useful —
  // the user already sees the data they asked for.
  if (
    status === 'error' &&
    error !== null &&
    documents.length === 0
  ) {
    return (
      <div
        role="alert"
        className={
          'mx-auto flex max-w-lg flex-col items-center gap-3 ' +
          'rounded-xl border border-red-200 bg-red-50 p-6 ' +
          'text-center dark:border-red-900 ' +
          'dark:bg-red-950/60'
        }
      >
        <AlertCircle
          size={24}
          className="text-red-600 dark:text-red-400"
          aria-hidden="true"
        />
        <p className="text-sm text-red-900 dark:text-red-100">
          {error}
        </p>
        <button
          type="button"
          onClick={handleRetry}
          disabled={retrying}
          className={
            'rounded-lg bg-red-600 px-4 py-2 text-sm font-medium ' +
            'text-white transition-colors hover:bg-red-700 ' +
            'disabled:cursor-not-allowed disabled:opacity-60 ' +
            'focus-visible:outline-none'
          }
        >
          {retrying ? 'Trying again…' : 'Try again'}
        </button>
      </div>
    );
  }

  // ---- State 3: EMPTY ----
  // Shown when the load succeeded but no documents exist for the
  // topic yet. The copy points the user at the Sources tab,
  // which is where they would go to run an extraction.
  if (documents.length === 0) {
    return (
      <div className="mx-auto flex max-w-md flex-col items-center gap-4 py-12 text-center">
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
          <h2
            className={
              'text-lg font-semibold text-text ' +
              'dark:text-neutral-100'
            }
          >
            No documents yet
          </h2>
          <p
            className={
              'mt-1 text-sm text-neutral-500 ' +
              'dark:text-neutral-400'
            }
          >
            Open the Sources tab to search for candidate pages
            and fetch the ones you want to use. Each fetched page
            lands here as a Markdown doc file.
          </p>
        </div>
      </div>
    );
  }

  // ---- State 4: POPULATED ----
  // The list of document rows. A header line reports the count
  // and total word count, matching the summary format the user
  // journey shows ("9 documents saved · 15,203 words total").
  //
  // The total is computed here rather than in the store because
  // it is a derived value the store would have to recompute on
  // every documents change, and a component that already maps
  // over the array can sum it in one pass.
  const totalWords = documents.reduce(
    (sum, doc) => sum + (doc.wordCount || 0),
    0
  );

  return (
    <div className="space-y-3">
      {/* ---- Summary line ---- */}
      <p
        className={
          'text-sm text-neutral-600 dark:text-neutral-300'
        }
      >
        {documents.length}{' '}
        {documents.length === 1 ? 'document' : 'documents'} ·{' '}
        {totalWords.toLocaleString()} words total
      </p>

      {/* ---- Rows ---- */}
      <div className="space-y-2">
        {documents.map((doc) => (
          <DocumentRow
            key={doc._id}
            document={doc}
            onPreview={handlePreview}
            onDelete={handleDelete}
          />
        ))}
      </div>

      {/* ---- Preview modal ---- */}
      {/* Mounted unconditionally and handed the topic's ID so
          the preview reads the same per-topic `selectedDocument`
          slot this list manages. The preview renders nothing
          when that slot is null, so there is no cost to keeping
          it in the tree — the same pattern the sibling
          `SourceList.tsx` uses for its auto-select effect and
          the topic list page uses for its modal. */}
      <DocumentPreview topicId={topic._id} />
    </div>
  );
};

// ============================================================
//  Default export
// ============================================================

/**
 * The `DocumentList` component as the default export.
 * `TopicDetail.tsx` imports it with the default form
 * (`import DocumentList from '.../DocumentList.js'`), so this is
 * the export that resolves that file's forward reference.
 */
export default DocumentList;