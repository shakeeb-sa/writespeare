/**
 * DocumentPreview — the Markdown preview modal for the documents
 * feature.
 *
 * Reads the `selectedDocument` field from the documents store and
 * renders the selected doc as a modal when that field is non-null.
 * The modal is closed by calling the store's `selectDocument(null)`
 * action — the same field that drives its visibility, so the
 * component is fully controlled by the store.
 *
 * ── The modal-ownership arrangement ────────────────────────────
 *
 *   The preview is mounted by `DocumentList.tsx` — the list owns
 *   the mount, the store owns the open/closed state, and the
 *   preview component reads its state from the store rather than
 *   from a prop. The consequence is that the list and the preview
 *   never have to thread a `selected` prop between them: the list
 *   calls `selectDocument(doc)` to open the preview, and the
 *   preview calls `selectDocument(null)` to close itself.
 *
 *   See `DocumentList.tsx`'s file header for the fuller reasoning
 *   on why this arrangement is preferred over a per-component
 *   `useState<Document | null>` for the preview target.
 *
 * ── The cached-document trick ──────────────────────────────────
 *
 *   The modal component (`shared/components/Modal.tsx`) plays an
 *   exit animation when its `open` prop goes from `true` to
 *   `false`. For that animation to have content to animate, the
 *   modal's children must remain stable during the transition. If
 *   this component read `selectedDocument` directly and rendered
 *   its children from that field, the moment the user clicked
 *   "Close" the field would become `null` and the modal's body
 *   would flash empty before the animation finished.
 *
 *   To avoid the flash, this component caches the last non-null
 *   `selectedDocument` in local state and renders the modal's
 *   content from `selectedDocument ?? cached`. When the modal is
 *   open, `selectedDocument` is the fresh value; when the modal is
 *   closing (i.e., `selectedDocument` is `null` and the modal is
 *   playing its exit animation), the cached value is what the
 *   user sees.
 *
 *   The cache is updated by an effect that fires when
 *   `selectedDocument` changes. The effect runs after render, so
 *   the very first render where `selectedDocument` becomes non-null
 *   uses the previous cached value as a fallback — but because
 *   `displayDocument` reads `selectedDocument ?? cached`, the
 *   fresh value wins whenever it is present. The cached value is
 *   therefore only ever consulted during the exit animation, which
 *   is exactly the case it exists for.
 *
 * ── The Markdown rendering ─────────────────────────────────────
 *
 *   The document's `content` field is the extracted Markdown body
 *   — the doc file's text after its YAML frontmatter has been
 *   stripped by `documentService.ts`'s frontmatter parser. It is
 *   rendered with `react-markdown` and `remark-gfm` (the GitHub-
 *   Flavored Markdown plugin, which adds support for tables,
 *   strikethrough, task lists, and autolinks that the base
 *   CommonMark spec does not include).
 *
 *   The `components` prop overrides two element types:
 *
 *     `a` — links. The default `<a>` behavior in Electron would
 *           try to navigate the app's own window, which would
 *           replace the dashboard with the link's target. The
 *           override intercepts the click, prevents the default
 *           navigation, and calls the preload's
 *           `window.electronAPI.utils.openExternal(url)` to open
 *           the link in the user's default browser instead.
 *
 *     The remaining element overrides apply Tailwind classes for
 *     headings, paragraphs, lists, block quotes, code, and
 *     horizontal rules, so the rendered content matches the
 *     app's design tokens. The Tailwind preflight reset strips
 *     the browser's default styles for those elements, which
 *     would otherwise leave every heading looking like body text
 *     and every list item flush with the left margin.
 *
 * ── Images ─────────────────────────────────────────────────────
 *
 *   The extracted content can contain image references, and
 *   `react-markdown` renders them as `<img>` tags. The image
 *   URLs might be absolute (`https://example.com/foo.jpg`) or
 *   relative to the original page (`/images/foo.jpg`). Relative
 *   URLs would fail to load in the preview because the app has
 *   no way to resolve them against the source page's base URL.
 *
 *   A future session that wanted to display images reliably
 *   would resolve relative URLs against the doc's `url` field
 *   before rendering — a small `img` component override in the
 *   `components` map. That change is deliberately deferred: the
 *   preview's purpose is to let the user review the extracted
 *   TEXT (the whole point of the extraction stage is that the
 *   prose is what matters), and a broken image icon next to
 *   the alt text is a sufficient indication that the original
 *   page had an image without misleading the user about what
 *   the extracted content contains.
 *
 * ── What this component does NOT do ────────────────────────────
 *
 *   - It does not fetch the document from disk. The `content`
 *     field is already populated on the `Document` object by
 *     the main process's `documentService` when the list was
 *     loaded — the preview shows what is already in memory.
 *
 *   - It does not offer an edit mode. The extracted content is
 *     read-only by design; the user who wants to change the
 *     article edits the final output in the writer stage, not
 *     the extracted source doc. A future session that wanted
 *     to edit doc files would add a separate edit action, not
 *     change this component's mode.
 *
 *   - It does not parse or render the doc file's YAML
 *     frontmatter. The `content` field never contains
 *     frontmatter — see the previous section.
 *
 *   - It does not manage its own open/closed state. The store
 *     owns it. See the "modal-ownership arrangement" section
 *     above.
 *
 * Dependencies: react + react-markdown + remark-gfm + lucide-react
 * + the sibling hook and the shared modal component. All are
 * declared in package.json.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { ExternalLink } from 'lucide-react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

import Modal from '../../shared/components/Modal.js';
import { useDocuments } from '../hooks/useDocuments.js';
import type { Document } from '../../shared/types/index.js';

// ============================================================
//  Public types
// ============================================================

/**
 * The props accepted by `DocumentPreview`. Currently empty — the
 * component reads everything it needs from the documents store
 * via `useDocuments`, and the store's `selectedDocument` field is
 * what drives its visibility. The interface is declared anyway so
 * a future addition (a `format` prop to switch between rendered
 * Markdown and raw source view, a `readOnly` flag, a sizing hint)
 * has a named, exported home.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface DocumentPreviewProps {
  // Reserved for future additions. See the interface docstring.
}

// ============================================================
//  Internal helpers — relative time
// ============================================================
//
// A local copy of the small relative-time formatter used by
// `TopicCard.tsx` and `DocumentList.tsx`. The three copies are
// bounded (about fifteen lines each) and produce identical
// output for identical inputs, so a user reading "3m ago" next
// to a document row sees the same string in the preview's
// metadata line.
//
// The duplication is deliberate — the plan's tree declares no
// shared formatting module, and the alternative (modifying one
// of the sibling components to export the function) is out of
// scope for a file creation. See `TopicCard.tsx`'s docstring
// for the reasoning behind the thresholds and the fallback.

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
//  Internal — DocumentMeta
// ============================================================
//
// A compact metadata row shown above the markdown content. The
// row reports the four facts a user reviewing a doc file wants
// at a glance: how long the extraction is, when it was fetched,
// where it came from, and which site it belongs to.

interface DocumentMetaProps {
  document: Document;
}

const DocumentMeta = ({ document }: DocumentMetaProps) => {
  const handleOpenSource = useCallback((): void => {
    if (document.url.length > 0) {
      void window.electronAPI.utils.openExternal(document.url);
    }
  }, [document.url]);

  return (
    <div
      className={
        'mb-4 flex flex-wrap items-center gap-x-2 gap-y-1 ' +
        'border-b border-neutral-200 pb-3 text-xs ' +
        'text-neutral-500 dark:border-neutral-800 ' +
        'dark:text-neutral-400'
      }
    >
      <span>
        {document.wordCount.toLocaleString()}{' '}
        {document.wordCount === 1 ? 'word' : 'words'}
      </span>
      <span aria-hidden="true">·</span>
      <span>Fetched {formatRelativeTime(document.fetchedAt)}</span>
      {document.url.length > 0 && (
        <>
          <span aria-hidden="true">·</span>
          <button
            type="button"
            onClick={handleOpenSource}
            className={
              'inline-flex items-center gap-1 font-medium ' +
              'text-primary transition-colors ' +
              'hover:underline ' +
              'dark:text-primary-light ' +
              'focus-visible:outline-none'
            }
          >
            <ExternalLink size={12} aria-hidden="true" />
            <span>Open source page</span>
          </button>
        </>
      )}
    </div>
  );
};

// ============================================================
//  DocumentPreview
// ============================================================

/**
 * The preview modal. See the file header for the component's
 * responsibilities, the cached-document trick, and the reasoning
 * behind the markdown rendering choices.
 */
export const DocumentPreview = (
  _props: DocumentPreviewProps = {}
) => {
  const { selectedDocument, selectDocument } = useDocuments();

  // The last non-null selected document. Used as a fallback while
  // the modal plays its exit animation. See the file header's
  // "cached-document trick" section for the full reasoning.
  const [cachedDocument, setCachedDocument] = useState<Document | null>(
    null
  );

  useEffect(() => {
    if (selectedDocument !== null) {
      setCachedDocument(selectedDocument);
    }
  }, [selectedDocument]);

  // The document the modal's body renders from. While the modal
  // is open, `selectedDocument` is the fresh value; while it is
  // closing, `selectedDocument` is null and the cached value
  // takes over so the exit animation has content. See the file
  // header for the full reasoning.
  const document = selectedDocument ?? cachedDocument;

  // Whether the modal is currently open. Derived from the store
  // field directly, NOT from `document !== null` — because the
  // cached value lingers after the store field is cleared, and
  // the modal should be closing in that state, not open.
  const isOpen = selectedDocument !== null;

  // The modal's header title. The doc's own title when it has
  // one, otherwise a generic fallback. The fallback matters for a
  // doc file whose frontmatter omitted the title field — the
  // modal should still have a header rather than an empty one.
  const modalTitle =
    document !== null && document.title.length > 0
      ? document.title
      : 'Document preview';

  const handleClose = useCallback((): void => {
    selectDocument(null);
  }, [selectDocument]);

  // ---- Markdown component overrides ----
  //
  // The overrides are memoized so React does not re-create the
  // `components` object on every render — an identity change on
  // that prop would cause react-markdown to re-run its internal
  // analysis of the entire content on every keystroke elsewhere
  // in the app. The dependency is the document URL, because the
  // only override that reads from the outer scope is the `a`
  // component (which does not actually read the URL — it reads
  // the link's own href — but keeping the dependency explicit
  // makes a future override that DOES need document context
  // safe to add without a subtle re-render bug).
  //
  // The overrides themselves are a straight mapping of Tailwind
  // classes onto the standard markdown elements. See the file
  // header's "Markdown rendering" section for the rationale on
  // the `a` override in particular.
  const documentUrl = document?.url ?? '';
  const markdownComponents = useMemo<Components>(
    () => ({
      // Headings. Each level gets a scaled font size and a top
      // margin that scales down with the level, so the content
      // has a clear visual hierarchy without looking like a
      // formal document.
      h1: ({ node: _node, ...props }) => (
        <h1
          className={
            'mb-3 mt-6 text-2xl font-semibold text-text ' +
            'dark:text-neutral-100'
          }
          {...props}
        />
      ),
      h2: ({ node: _node, ...props }) => (
        <h2
          className={
            'mb-2 mt-5 text-xl font-semibold text-text ' +
            'dark:text-neutral-100'
          }
          {...props}
        />
      ),
      h3: ({ node: _node, ...props }) => (
        <h3
          className={
            'mb-2 mt-4 text-lg font-semibold text-text ' +
            'dark:text-neutral-100'
          }
          {...props}
        />
      ),
      h4: ({ node: _node, ...props }) => (
        <h4
          className={
            'mb-2 mt-3 text-base font-semibold text-text ' +
            'dark:text-neutral-100'
          }
          {...props}
        />
      ),

      // Body text. The `leading-relaxed` class is what keeps
      // long paragraphs readable — a compact line height is the
      // single most common cause of "wall of text" complaints
      // about a preview pane.
      p: ({ node: _node, ...props }) => (
        <p className="mb-3 leading-relaxed" {...props} />
      ),

      // Lists. `list-disc` and `list-decimal` restore the bullet
      // glyphs and numbering that the Tailwind preflight reset
      // removes; the `pl-6` indent is what keeps a nested list
      // visually distinct from its parent paragraph.
      ul: ({ node: _node, ...props }) => (
        <ul className="mb-3 list-disc pl-6" {...props} />
      ),
      ol: ({ node: _node, ...props }) => (
        <ol className="mb-3 list-decimal pl-6" {...props} />
      ),
      li: ({ node: _node, ...props }) => (
        <li className="mb-1 leading-relaxed" {...props} />
      ),

      // Block quotes. A left border plus an italic font is the
      // standard "quoted passage" treatment.
      blockquote: ({ node: _node, ...props }) => (
        <blockquote
          className={
            'mb-3 border-l-4 border-neutral-300 pl-4 italic ' +
            'text-neutral-700 dark:border-neutral-700 ' +
            'dark:text-neutral-300'
          }
          {...props}
        />
      ),

      // Inline code and code blocks. The `font-mono` class uses
      // the app's monospace font (JetBrains Mono, from the
      // tailwind config); the light background tint matches the
      // code-block style in the export_docx writer's output.
      code: ({ node: _node, ...props }) => (
        <code
          className={
            'rounded bg-neutral-100 px-1 py-0.5 font-mono ' +
            'text-sm dark:bg-neutral-800'
          }
          {...props}
        />
      ),
      pre: ({ node: _node, ...props }) => (
        <pre
          className={
            'mb-3 overflow-x-auto rounded-lg bg-neutral-100 ' +
            'p-3 font-mono text-sm dark:bg-neutral-800'
          }
          {...props}
        />
      ),

      // Emphasis. The Tailwind preflight reset does not remove
      // the browser's default italic for `<em>`, but it does
      // remove `<strong>`'s bold weight on some browsers; making
      // both explicit keeps the two consistent.
      strong: ({ node: _node, ...props }) => (
        <strong className="font-semibold" {...props} />
      ),
      em: ({ node: _node, ...props }) => (
        <em className="italic" {...props} />
      ),

      // Horizontal rule. A thin neutral line, matching the
      // horizontal rule the docx export writes.
      hr: ({ node: _node, ...props }) => (
        <hr
          className={
            'my-4 border-t border-neutral-200 ' +
            'dark:border-neutral-800'
          }
          {...props}
        />
      ),

      // Links. The override intercepts the click, prevents the
      // default navigation, and opens the URL in the user's
      // default browser. See the file header's "Markdown
      // rendering" section for the full reasoning.
      a: ({ node: _node, href, ...props }) => {
        const linkHref = typeof href === 'string' ? href : '';
        return (
          <a
            {...props}
            href={href}
            className={
              'text-primary transition-colors hover:underline ' +
              'dark:text-primary-light'
            }
            onClick={(event) => {
              event.preventDefault();
              if (linkHref.length > 0) {
                void window.electronAPI.utils.openExternal(linkHref);
              }
            }}
          />
        );
      },
    }),
    [documentUrl]
  );

  // ---- Render ----
  // The `<Modal>` is always rendered, with its `open` prop
  // controlling visibility. When the modal is closed, `Modal`
  // renders nothing into the DOM. When it opens or closes, the
  // internal `AnimatePresence` plays the enter or exit animation,
  // and the body's content is sourced from `document` — which
  // falls back to the cached document during the exit animation
  // so the animation has content to show.
  return (
    <Modal
      open={isOpen}
      onClose={handleClose}
      variant="info"
      size="xl"
      title={modalTitle}
      footer={
        <button
          type="button"
          onClick={handleClose}
          className={
            'rounded-lg border border-neutral-300 ' +
            'bg-background px-4 py-2 text-sm font-medium ' +
            'text-text transition-colors ' +
            'hover:bg-neutral-100 ' +
            'focus-visible:outline-none ' +
            'dark:border-neutral-700 ' +
            'dark:hover:bg-neutral-800 ' +
            'dark:text-neutral-100'
          }
        >
          Close
        </button>
      }
    >
      {document !== null ? (
        <div>
          <DocumentMeta document={document} />
          <div className="text-sm">
            <Markdown
              remarkPlugins={[remarkGfm]}
              components={markdownComponents}
            >
              {document.content}
            </Markdown>
          </div>
        </div>
      ) : null}
    </Modal>
  );
};

// ============================================================
//  Default export
// ============================================================

/**
 * The `DocumentPreview` component as the default export.
 * `DocumentList.tsx` imports it with the default form
 * (`import DocumentPreview from './DocumentPreview.js'`), so this
 * is the export that resolves that file's forward reference.
 */
export default DocumentPreview;