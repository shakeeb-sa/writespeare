/**
 * ArticlePreview — the Article tab's reading view for the writer
 * stage.
 *
 * Renders the article the writer produced, with a small action
 * bar above it that offers Edit (an inline editor), Regenerate
 * (a fresh writer run), and an export dropdown. The component
 * renders nothing when the writer store holds no article — the
 * sibling `WriterProgress` panel is what shows the "not yet
 * generated" or "in flight" states, and the two components are
 * stacked in `TopicDetail.tsx`'s Article tab.
 *
 * ── The layout ─────────────────────────────────────────────────
 *
 *   The component renders, from top to bottom:
 *
 *     1. A metadata line with the article's word count, version
 *        number, and status badge.
 *     2. An action bar with Edit, Regenerate, and Export.
 *     3. The article body, rendered as Markdown.
 *
 *   In edit mode, the render swaps the body for a `<textarea>`
 *   and the action bar swaps Edit for Save and Cancel. The
 *   metadata line stays visible in both modes so the user can
 *   see what they are editing.
 *
 * ── Edit mode and what "Save" does ─────────────────────────────
 *
 *   Clicking Edit enters a local edit mode where the article's
 *   raw Markdown is held in a `<textarea>` and the user can
 *   modify it. Clicking Save replaces the local `article` object
 *   in the writer store with one whose `content` field is the
 *   edited text, and exits edit mode. Clicking Cancel discards
 *   the edits and exits edit mode.
 *
 *   The Save action does NOT persist the edited content to the
 *   backend. No IPC channel exists yet for updating an article's
 *   content — the desktop's feature tree declares no `articles`
 *   folder, and the preload's `writer` and `topics` namespaces
 *   do not carry an update method. The save is therefore
 *   local-only: the article the user sees in the tab reflects
 *   their edits, and the export flow (which reads from the
 *   article object) exports their edits, but a page refresh or
 *   a topic switch loses them.
 *
 *   The persistence wiring is logged as a PLAN DELTA with this
 *   file's creation. The fix is a small addition to the preload
 *   (a new `articles` namespace or an extended `writer`
 *   namespace) plus a corresponding IPC handler in the main
 *   process that POSTs to the backend's `/api/articles`
 *   endpoint — which, per the backend's `articleService.ts`,
 *   already creates a new version rather than mutating an
 *   existing one. The Save handler in this file would gain a
 *   single `await` before the local store update.
 *
 * ── Regenerate ─────────────────────────────────────────────────
 *
 *   The Regenerate button calls the writer hook's `regenerate`
 *   action with the topic's ID. The hook's `regenerate` is
 *   currently an alias for `generate` — see `useWriter.ts`'s
 *   file header for the reasoning — so the operation re-runs the
 *   writer from scratch, replaces the writer store's `article`
 *   field with the newly-generated one, and leaves the previous
 *   article lost from the UI's perspective. A future session
 *   that adds version history (a list of every Article record
 *   the backend has ever produced for the topic) would let the
 *   user navigate back to the previous version.
 *
 *   The button is hidden while the article is being edited, so
 *   the user cannot accidentally discard in-progress edits.
 *
 * ── The export dropdown ────────────────────────────────────────
 *
 *   The export dropdown is rendered by the sibling `ExportMenu`
 *   component in the export feature (`Session 17, step 132`).
 *   That component does not yet exist on disk, so the import
 *   produces a `TS2307` error on the import line — the same
 *   forward-reference pattern every feature's page in this
 *   codebase has used for its not-yet-created dependencies.
 *
 *   The `ExportMenu` is passed the article's `_id` as its
 *   `articleId` prop. The naming matches the backend's export
 *   IPC channels (`export:docx`, `export:md`, `export:txt`),
 *   which all take an article ID as their sole argument.
 *
 * ── Why the component does NOT fetch the article on mount ──────
 *
 *   Same gap as `WriterProgress.tsx` — see that file's PLAN
 *   DELTA 1. On a cold mount of a topic that already has an
 *   article on the backend, the writer store's `article` field
 *   is null and this component renders nothing. The user sees
 *   the sibling `WriterProgress` panel's idle state, and a
 *   click on "Generate Article" produces a fresh article. The
 *   "load the last saved article on mount" flow is a future
 *   session's addition.
 *
 * ── What this component does NOT do ────────────────────────────
 *
 *   - It does not persist edits to the backend. See "Edit mode"
 *     above.
 *
 *   - It does not fetch the article from disk or the backend.
 *     See the previous section.
 *
 *   - It does not run the writer. The Regenerate button delegates
 *     to the writer hook, which reaches the writer IPC handler in
 *     the main process.
 *
 *   - It does not validate the article. The Report tab does that
 *     — see the sibling `ValidationReport` component, which the
 *     parent `TopicDetail.tsx` renders in a separate tab.
 *
 *   - It does not manage a version history. The backend keeps
 *     every version, but the desktop's UI shows only the current
 *     one. A future session that wanted a version selector would
 *     add it here.
 *
 * Dependencies: react + react-markdown + remark-gfm +
 * lucide-react + the sibling writer hook + the shared toast hook
 * + the export feature's ExportMenu (forward reference).
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';
import {
  Edit3,
  Save,
  Sparkles,
  X,
} from 'lucide-react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { useWriter } from '../hooks/useWriter.js';
import { useToast } from '../../shared/hooks/useToast.js';
import ExportMenu from '../../export/components/ExportMenu.js';
import type {
  Article,
  Topic,
} from '../../shared/types/index.js';

// ============================================================
//  Public types
// ============================================================

/**
 * The props accepted by `ArticlePreview`.
 *
 * The component takes the full `Topic` object — the same shape
 * every other stage component on the topic-detail page receives
 * — so its Regenerate button can pass `topic._id` to the writer
 * hook's `regenerate` action.
 */
export interface ArticlePreviewProps {
  /** The topic whose article this preview represents. */
  topic: Topic;
}

// ============================================================
//  Internal helpers — status labels and class names
// ============================================================
//
//  A small mapping from the article's `status` field to a label
//  and a Tailwind class set. Same pattern as `TopicDetail.tsx`'s
//  status badge tables and `TopicCard.tsx`'s — the three statuses
//  (`'draft'`, `'validated'`, `'exported'`) each get a colour
//  that reflects their position in the article's lifecycle.

const ARTICLE_STATUS_LABELS: Record<Article['status'], string> = {
  draft: 'Draft',
  validated: 'Validated',
  exported: 'Exported',
};

const ARTICLE_STATUS_CLASSES: Record<Article['status'], string> = {
  draft:
    'bg-neutral-100 text-neutral-700 ' +
    'dark:bg-neutral-800 dark:text-neutral-300',
  validated:
    'bg-emerald-100 text-emerald-800 ' +
    'dark:bg-emerald-950 dark:text-emerald-200',
  exported:
    'bg-sky-100 text-sky-800 ' +
    'dark:bg-sky-950 dark:text-sky-200',
};

// ============================================================
//  ArticlePreview
// ============================================================

/**
 * The article reading view. See the file header for the
 * component's responsibilities, its edit mode, and the reasoning
 * behind the design choices.
 */
export const ArticlePreview = ({ topic }: ArticlePreviewProps) => {
  const { article, isGenerating, regenerate, setArticle } = useWriter();
  const toast = useToast();

  // ---- Local state ----
  // Whether the user is currently editing the article. The
  // component holds this locally rather than in the writer
  // store because edit mode is transient UI state that has no
  // meaning outside this component's mount.
  const [isEditing, setIsEditing] = useState(false);

  // The in-progress edited content. Only meaningful while
  // `isEditing` is true; reset every time edit mode is entered
  // so the textarea always starts from the current article.
  const [editedContent, setEditedContent] = useState('');

  // ---- Reset edit state when the article identity changes ----
  // A new article (a fresh generation, a regeneration, an
  // article loaded from the backend) invalidates any in-progress
  // edit. The effect fires when `article._id` changes and exits
  // edit mode. The `article === null` case also exits, since
  // there is nothing to edit.
  useEffect(() => {
    setIsEditing(false);
    setEditedContent('');
  }, [article?._id]);

  // ---- Enter edit mode ----
  const handleEdit = useCallback((): void => {
    if (article === null) return;
    setEditedContent(article.content);
    setIsEditing(true);
  }, [article]);

  // ---- Cancel edit ----
  const handleCancel = useCallback((): void => {
    setIsEditing(false);
    setEditedContent('');
  }, []);

  // ---- Save edit ----
  // Replaces the local article object in the writer store with
  // one whose `content` field is the edited text. See the file
  // header's "Edit mode" section for the rationale on the
  // local-only save.
  const handleSave = useCallback((): void => {
    if (article === null) return;
    const trimmed = editedContent.trim();
    if (trimmed.length === 0) {
      toast.error('Cannot save an empty article.');
      return;
    }
    // Recomputed word count so the metadata line reflects the
    // edit. Same definition the backend uses — a run of
    // non-whitespace characters is a word.
    const matches = trimmed.match(/\S+/g);
    const wordCount = matches === null ? 0 : matches.length;
    setArticle({ ...article, content: trimmed, wordCount });
    setIsEditing(false);
    setEditedContent('');
    toast.success('Article updated.');
  }, [article, editedContent, setArticle, toast]);

  // ---- Regenerate ----
  const handleRegenerate = useCallback((): void => {
    void regenerate(topic._id);
  }, [regenerate, topic._id]);

  // ---- Markdown component overrides ----
  // Same overrides as `DocumentPreview.tsx`'s — see that file's
  // header for the full reasoning on the `a` override and the
  // Tailwind class mappings. The set here is what makes the
  // rendered article read as prose rather than as raw Markdown
  // pasted into unstyled elements.
  const markdownComponents = useMemo<Components>(
    () => ({
      h1: ({ node: _node, ...props }) => (
        <h1
          className={
            'mb-4 mt-6 text-3xl font-semibold text-text ' +
            'dark:text-neutral-100'
          }
          {...props}
        />
      ),
      h2: ({ node: _node, ...props }) => (
        <h2
          className={
            'mb-3 mt-6 text-2xl font-semibold text-text ' +
            'dark:text-neutral-100'
          }
          {...props}
        />
      ),
      h3: ({ node: _node, ...props }) => (
        <h3
          className={
            'mb-2 mt-5 text-xl font-semibold text-text ' +
            'dark:text-neutral-100'
          }
          {...props}
        />
      ),
      h4: ({ node: _node, ...props }) => (
        <h4
          className={
            'mb-2 mt-4 text-lg font-semibold text-text ' +
            'dark:text-neutral-100'
          }
          {...props}
        />
      ),
      p: ({ node: _node, ...props }) => (
        <p
          className={
            'mb-4 text-base leading-relaxed ' +
            'text-text dark:text-neutral-200'
          }
          {...props}
        />
      ),
      ul: ({ node: _node, ...props }) => (
        <ul className="mb-4 list-disc pl-6" {...props} />
      ),
      ol: ({ node: _node, ...props }) => (
        <ol className="mb-4 list-decimal pl-6" {...props} />
      ),
      li: ({ node: _node, ...props }) => (
        <li
          className={
            'mb-1 text-base leading-relaxed ' +
            'text-text dark:text-neutral-200'
          }
          {...props}
        />
      ),
      blockquote: ({ node: _node, ...props }) => (
        <blockquote
          className={
            'mb-4 border-l-4 border-neutral-300 pl-4 italic ' +
            'text-neutral-700 dark:border-neutral-700 ' +
            'dark:text-neutral-300'
          }
          {...props}
        />
      ),
      code: ({ node: _node, ...props }) => (
        <code
          className={
            'rounded bg-neutral-100 px-1 py-0.5 font-mono ' +
            'text-sm dark:bg-neutral-800 dark:text-neutral-100'
          }
          {...props}
        />
      ),
      pre: ({ node: _node, ...props }) => (
        <pre
          className={
            'mb-4 overflow-x-auto rounded-lg bg-neutral-100 ' +
            'p-4 font-mono text-sm ' +
            'dark:bg-neutral-800 dark:text-neutral-100'
          }
          {...props}
        />
      ),
      strong: ({ node: _node, ...props }) => (
        <strong className="font-semibold" {...props} />
      ),
      em: ({ node: _node, ...props }) => (
        <em className="italic" {...props} />
      ),
      hr: ({ node: _node, ...props }) => (
        <hr
          className={
            'my-6 border-t border-neutral-200 ' +
            'dark:border-neutral-800'
          }
          {...props}
        />
      ),
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
    []
  );

  // ---- Render: nothing when no article exists ----
  // The `WriterProgress` panel above this component handles the
  // "not yet generated" and "in flight" states. This component
  // is only meaningful when an article has been produced.
  if (article === null) {
    return null;
  }

  const statusLabel = ARTICLE_STATUS_LABELS[article.status];
  const statusClass = ARTICLE_STATUS_CLASSES[article.status];

  return (
    <article className="overflow-hidden rounded-xl border border-neutral-200 bg-background dark:border-neutral-800">
      {/* ---- Header: metadata + actions ---- */}
      <header
        className={
          'flex flex-wrap items-center justify-between gap-3 ' +
          'border-b border-neutral-200 bg-neutral-50 px-4 py-3 ' +
          'dark:border-neutral-800 dark:bg-neutral-900/40'
        }
      >
        {/* Metadata */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-neutral-600 dark:text-neutral-400">
          <span
            className={
              'inline-flex items-center rounded-full px-2 py-0.5 ' +
              'text-xs font-medium ' +
              statusClass
            }
          >
            {statusLabel}
          </span>
          <span>v{article.version}</span>
          <span aria-hidden="true">·</span>
          <span>
            {article.wordCount.toLocaleString()}{' '}
            {article.wordCount === 1 ? 'word' : 'words'}
          </span>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2">
          {!isEditing && (
            <>
              <button
                type="button"
                onClick={handleEdit}
                disabled={isGenerating}
                className={
                  'inline-flex items-center gap-1.5 rounded-lg ' +
                  'border border-neutral-300 bg-background ' +
                  'px-3 py-1.5 text-xs font-medium text-text ' +
                  'transition-colors hover:bg-neutral-100 ' +
                  'disabled:cursor-not-allowed disabled:opacity-60 ' +
                  'focus-visible:outline-none ' +
                  'dark:border-neutral-700 ' +
                  'dark:hover:bg-neutral-800 ' +
                  'dark:text-neutral-100'
                }
              >
                <Edit3 size={14} aria-hidden="true" />
                <span>Edit</span>
              </button>

              <button
                type="button"
                onClick={handleRegenerate}
                disabled={isGenerating}
                className={
                  'inline-flex items-center gap-1.5 rounded-lg ' +
                  'border border-neutral-300 bg-background ' +
                  'px-3 py-1.5 text-xs font-medium text-text ' +
                  'transition-colors hover:bg-neutral-100 ' +
                  'disabled:cursor-not-allowed disabled:opacity-60 ' +
                  'focus-visible:outline-none ' +
                  'dark:border-neutral-700 ' +
                  'dark:hover:bg-neutral-800 ' +
                  'dark:text-neutral-100'
                }
              >
                <Sparkles size={14} aria-hidden="true" />
                <span>Regenerate</span>
              </button>

              {/* Forward reference to the export feature's
                  dropdown. See the file header for the
                  import's TS2307 status. */}
              <ExportMenu articleId={article._id} />
            </>
          )}

          {isEditing && (
            <>
              <button
                type="button"
                onClick={handleCancel}
                className={
                  'inline-flex items-center gap-1.5 rounded-lg ' +
                  'border border-neutral-300 bg-background ' +
                  'px-3 py-1.5 text-xs font-medium text-text ' +
                  'transition-colors hover:bg-neutral-100 ' +
                  'focus-visible:outline-none ' +
                  'dark:border-neutral-700 ' +
                  'dark:hover:bg-neutral-800 ' +
                  'dark:text-neutral-100'
                }
              >
                <X size={14} aria-hidden="true" />
                <span>Cancel</span>
              </button>
              <button
                type="button"
                onClick={handleSave}
                className={
                  'inline-flex items-center gap-1.5 rounded-lg ' +
                  'bg-primary px-3 py-1.5 text-xs font-medium ' +
                  'text-white transition-colors ' +
                  'hover:bg-primary-dark ' +
                  'focus-visible:outline-none'
                }
              >
                <Save size={14} aria-hidden="true" />
                <span>Save</span>
              </button>
            </>
          )}
        </div>
      </header>

      {/* ---- Body: rendered Markdown or edit textarea ---- */}
      {!isEditing && (
        <div className="px-6 py-6 text-base">
          <Markdown
            remarkPlugins={[remarkGfm]}
            components={markdownComponents}
          >
            {article.content}
          </Markdown>
        </div>
      )}

      {isEditing && (
        <div className="px-6 py-6">
          <textarea
            value={editedContent}
            onChange={(e) => setEditedContent(e.target.value)}
            disabled={isGenerating}
            spellCheck={false}
            className={
              'block w-full resize-y rounded-lg border ' +
              'border-neutral-300 bg-background p-4 ' +
              'font-mono text-sm leading-relaxed text-text ' +
              'focus:border-primary ' +
              'disabled:cursor-not-allowed disabled:opacity-60 ' +
              'dark:border-neutral-700 dark:bg-neutral-950 ' +
              'dark:text-neutral-100'
            }
            style={{ minHeight: '32rem' }}
          />
          <p
            className={
              'mt-2 text-xs text-neutral-500 ' +
              'dark:text-neutral-400'
            }
          >
            Editing the raw Markdown. The Save button updates the
            article in the app; changes are not yet persisted to
            the server. See the file header for details.
          </p>
        </div>
      )}
    </article>
  );
};

// ============================================================
//  Default export
// ============================================================

/**
 * The `ArticlePreview` component as the default export.
 * `TopicDetail.tsx` imports it with the default form
 * (`import ArticlePreview from '.../ArticlePreview.js'`), so
 * this is the export that resolves that file's forward
 * reference.
 */
export default ArticlePreview;