/**
 * Mongoose model for the WriteSpeare Article entity.
 *
 * An Article is one generated article attached to a Topic. One
 * Topic owns one or more Articles — the initial draft returned by
 * the writer step, plus any subsequent versions produced by the
 * corrective regeneration loop (see the shared `Article` interface
 * and its `version` field). Each Article is a numbered snapshot
 * of the writer step's output, and the version with the highest
 * number is the "current" article for its topic.
 *
 * Responsibilities:
 *
 *   1. Enforce the schema-level invariants of an article record:
 *      a non-empty body, a non-negative integer word count, a
 *      positive integer version number, and a status drawn from
 *      the closed `ArticleStatus` union (`draft`, `validated`,
 *      `exported`).
 *
 *   2. Own the two compound indexes that the articles feature's
 *      read paths exercise:
 *
 *        - "list every version of this topic's article, newest
 *           version first" — served by { userId, topicId, version: -1 }.
 *           The leftmost prefix { userId, topicId } also serves
 *           the "get the latest article for this topic" query
 *           that the desktop's topic-detail view issues on every
 *           render.
 *
 *        - "list every article owned by the current user, newest
 *           first across all topics" — served by
 *           { userId, createdAt: -1 }.
 *
 *      Both indexes are prefixed by `userId` for the same reason
 *      the Topic and Document models' indexes are: every query
 *      on this collection is scoped to a single authenticated
 *      user, and an index without the userId prefix would never
 *      be selected by the query planner.
 *
 *   3. Provide a single `toJSON` transform that strips Mongoose's
 *      `__v` version field, so a serialised Article matches the
 *      shared `Article` interface exactly.
 *
 * The `version` field and why it is schema-validated but not
 * schema-assigned:
 *
 *   The version number starts at 1 and increments each time the
 *   user requests a regeneration of the same topic. Assigning the
 *   next version is a cross-record decision — it requires reading
 *   the current maximum version for this topic and adding one —
 *   and cross-record decisions are the service's job, not the
 *   schema's. The schema only enforces that whatever version
 *   number the service writes is a positive integer. A schema-
 *   level default of 1 is provided as a convenience for the
 *   common "this is the first article for the topic" case, but a
 *   service that always writes the computed next version will
 *   override it every time.
 *
 *   Making the version unique per topic at the schema level (a
 *   compound unique index on { userId, topicId, version }) was
 *   considered and rejected: it would turn a service-level
 *   mistake (two concurrent regenerations racing to write the
 *   same version) into a duplicate-key error that the caller
 *   would have to catch and translate, when the correct response
 *   is to serialize regenerations in the service layer. The
 *   current design keeps the schema simple and the concurrency
 *   contract in one place.
 *
 * The status field and the corrective loop:
 *
 *   `draft`     — the article as first returned by the writer.
 *   `validated` — a Report has been produced against it.
 *   `exported`  — the user has exported it to a file.
 *
 *   The transitions are one-directional under normal operation:
 *   draft → validated → exported. A `validated` article that the
 *   user then edits returns to `draft` (the edit is not covered
 *   by the existing report), and that transition is the
 *   service's concern — the schema only enforces that the value
 *   is a member of the closed set.
 *
 * What this model does NOT do:
 *
 *   - It does not mark `content` as `select: false`. The field
 *     is the article body — the largest field on the record — and
 *     a "list articles for this topic" query does not need it
 *     (the list view shows word counts, versions, and status
 *     badges). That projection is the service layer's job: a list
 *     query issues `.select('-content')`, a read-for-display or
 *     read-for-validation query loads the full document. This
 *     mirrors the choice made for the Document model's `content`
 *     field.
 *
 *   - It does not enforce that `topicId` references an existing
 *     Topic, or that `userId` matches the Topic's owner. Cross-
 *     collection referential integrity is the service layer's
 *     concern — the article service validates the parent topic's
 *     ownership before persisting, exactly as the document
 *     service does for Document.
 *
 *   - It does not store the validation report. A Report is a
 *     separate entity (see `features/reports/models/Report.ts`)
 *     that references its owning Article by `articleId`. Keeping
 *     the two separate means a Report can be regenerated without
 *     touching the Article, and an Article can be edited without
 *     silently invalidating a stored Report.
 */

import mongoose, { Schema, Document as MongooseDocument } from 'mongoose';
import { Article, ArticleStatus } from '../../shared/types/index.js';

// ============================================================
//  Document interface
// ============================================================

/**
 * The runtime shape of an Article document as returned by
 * Mongoose.
 *
 * Extends `Omit<Article, '_id'>` (the shared domain interface
 * minus its loosely-typed `_id`) and `MongooseDocument` (the
 * Mongoose base class), then re-declares `_id` with the concrete
 * ObjectId type Mongoose actually produces in-process. This is
 * the same pattern as `UserDocument`, `TopicDocument`, and
 * `DocumentDocument` — the shared domain type stays transport-
 * agnostic, while the document interface pins `_id` to what the
 * ODM gives you.
 *
 * No instance methods are declared. An Article has no per-record
 * behaviour beyond what Mongoose provides out of the box (save,
 * validate, toJSON). Business logic — computing the next version
 * number, transitioning status, deciding whether to re-validate
 * — lives in the service.
 */
export interface ArticleDocument
  extends Omit<Article, '_id'>,
    MongooseDocument {
  _id: mongoose.Types.ObjectId;
}

// ============================================================
//  Legal values (runtime counterpart of the union type)
// ============================================================

/**
 * The closed set of legal values for the `status` field.
 *
 * `ArticleStatus` in `shared/types/index.ts` is a string-literal
 * union type — it does not exist at runtime, so Mongoose cannot
 * use it directly as an `enum` option. This array is the runtime
 * source of truth, and its type annotation (`readonly ArticleStatus[]`)
 * guarantees at compile time that every string in the array is a
 * legal member of the union. A typo such as `'valiated'` would be
 * a type error, not a silent runtime surprise.
 *
 * What the annotation does NOT catch: a union member that is
 * missing from the array (a new status added to `ArticleStatus`
 * in `shared/types` without a corresponding array update). That
 * class of drift has to be caught by a reviewer or by an
 * integration test that exercises every legal value — which is
 * exactly what the `Article.ts` model file's counterpart in the
 * Topic model does for `TopicStatus`.
 */
const ARTICLE_STATUS_VALUES: readonly ArticleStatus[] = [
  'draft',
  'validated',
  'exported',
];

// ============================================================
//  Schema
// ============================================================

const ArticleSchema = new Schema<ArticleDocument>(
  {
    // ---- Ownership ----
    // Every article belongs to exactly one user via the topic it
    // is attached to. Denormalising `userId` onto the article
    // record — rather than deriving ownership by joining through
    // the parent Topic — follows the same pattern as the Document
    // model: it lets the indexes key on `userId` directly, and it
    // means every authorization check queries one collection
    // instead of two.
    userId: {
      type: Schema.Types.ObjectId,
      required: [true, 'userId is required'],
    },

    // ---- Parent topic ----
    // The Topic this article belongs to. Together with `userId`
    // this forms the composite identity the compound indexes
    // below key on, and it is the field the "list articles for
    // topic X" query filters on.
    topicId: {
      type: Schema.Types.ObjectId,
      required: [true, 'topicId is required'],
    },

    // ---- Body ----
    // The generated Markdown body of the article, with the H1
    // title preserved. Sized at a few kilobytes in the common
    // case (a 1200-word article is roughly 8–10 KB of Markdown)
    // and capped at one megabyte by the schema. The cap is a
    // safety rail, not a design target — the writer step's own
    // word-count guard keeps articles well under it in practice,
    // and an article hitting 1 MB would indicate the DeepSeek
    // automation has gone off the rails, not that a legitimate
    // user requested an exceptionally long piece.
    content: {
      type: String,
      required: [true, 'Content is required'],
      minlength: [1, 'Content must not be empty.'],
      maxlength: [1000000, 'Content must be at most 1,000,000 characters.'],
    },

    wordCount: {
      type: Number,
      required: [true, 'wordCount is required'],
      min: [0, 'wordCount must be non-negative.'],
      max: [100000, 'wordCount must be at most 100000.'],
      validate: {
        // The built-in Number type in Mongoose is a double. Word
        // counts are conceptually integers — a count of "1247.5
        // words" is meaningless and would only appear if the
        // writer pipeline passed a float by mistake. This
        // validator catches that at the schema boundary so no
        // downstream consumer has to think about rounding.
        validator: (value: number): boolean => Number.isInteger(value),
        message: 'wordCount must be an integer.',
      },
    },

    // ---- Versioning ----
    // Starts at 1 for the first article produced for a topic and
    // increments by 1 for each regeneration. The schema enforces
    // that the number is a positive integer; the assignment of
    // the specific next value is the service's job (see the file
    // header). The default of 1 exists as a convenience for the
    // common case where the service does not override it.
    version: {
      type: Number,
      required: [true, 'version is required'],
      default: 1,
      min: [1, 'version must be at least 1.'],
      validate: {
        validator: (value: number): boolean => Number.isInteger(value),
        message: 'version must be an integer.',
      },
    },

    // ---- Lifecycle status ----
    // The closed set of article lifecycle states. The schema
    // validates that the value is one of them; it does not
    // enforce which transitions between them are legal. That is
    // the service's concern — the writer step creates a `draft`,
    // the validation step transitions it to `validated`, and the
    // export step transitions it to `exported`. An edit after
    // validation is expected to return the article to `draft`,
    // and enforcing that rule belongs in the service where the
    // surrounding context (whether the edit actually changed
    // anything) is available.
    status: {
      type: String,
      enum: {
        values: ARTICLE_STATUS_VALUES,
        message:
          'Status must be one of: draft, validated, exported.',
      },
      default: 'draft',
      required: true,
    },
  },
  {
    timestamps: true,
    toJSON: {
      transform: (_doc, ret) => {
        // `__v` is Mongoose's internal version field. It is
        // added to every saved document automatically and is
        // not part of the shared `Article` interface, so it must
        // not appear in the JSON response.
        //
        // The cast to `Record<string, unknown>` is required
        // because TypeScript's `delete` operator refuses to
        // operate on non-optional properties (TS2790). The
        // transform callback's `ret` parameter is typed as the
        // schema's document type, which inherits `__v` as a
        // required property from Mongoose's base `Document`
        // interface. Casting to a record loosens the type enough
        // for the delete to be legal without changing any runtime
        // behaviour — the property is removed from the same
        // object either way. The same fix is applied in
        // `Topic.ts` and `Document.ts`.
        delete (ret as Record<string, unknown>)['__v'];
        return ret;
      },
    },
  }
);

// ============================================================
//  Indexes
// ============================================================
//
//  Two compound indexes cover the read paths the articles
//  feature exercises. Both are prefixed by `userId` because every
//  query on this collection is scoped to a single authenticated
//  user.
//
//    { userId: 1, topicId: 1, version: -1 }
//      Serves two related queries:
//        - "list all versions of this topic's article, newest
//           version first" — the version history view.
//        - "get the latest article for this topic" — the same
//           query with a `.limit(1)`, which is what the topic
//           detail view issues on every render.
//      The compound shape means MongoDB can satisfy both the
//      equality filter (userId + topicId) and the sort (version
//      descending) from the index alone.
//
//    { userId: 1, createdAt: -1 }
//      Serves the cross-topic list — "all my articles, newest
//      first" — which the desktop's dashboard view can offer as
//      an alternate landing page, and which the article service
//      uses to sort by most-recent-activity when it is not
//      filtering by topic.
//
//  A third index on { topicId: 1, version: -1 } was considered
//  and rejected for the same reason the analogous index on the
//  Document model was rejected: every query already carries a
//  userId, so an index without the userId prefix would never be
//  selected. If a future cascade-delete path ever needs to
//  remove articles by topicId alone, the correct move is to
//  carry the userId through that path and reuse the existing
//  compound index.

ArticleSchema.index({ userId: 1, topicId: 1, version: -1 });
ArticleSchema.index({ userId: 1, createdAt: -1 });

// ============================================================
//  Model
// ============================================================

export const ArticleModel = mongoose.model<ArticleDocument>(
  'Article',
  ArticleSchema
);

// ============================================================
//  Default export
// ============================================================

export default ArticleModel;