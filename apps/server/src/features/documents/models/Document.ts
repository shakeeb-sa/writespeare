/**
 * Mongoose model for the WriteSpeare Document entity.
 *
 * A Document is one scraped source page attached to a Topic. One
 * Topic owns many Documents; each Document is a single URL that
 * the extraction pipeline has opened, parsed, cleaned, and saved
 * as a Markdown file on disk (with a parallel MongoDB record
 * carrying the metadata and body that the writer step will paste
 * into DeepSeek).
 *
 * Responsibilities:
 *
 *   1. Enforce the schema-level invariants of a document record:
 *      a non-empty URL that parses as an absolute URL, a slug-
 *      formatted platform identifier, a non-empty title, a non-
 *      empty body, a non-negative integer word count, and a fetch
 *      timestamp.
 *
 *   2. Own the two compound indexes that the documents feature's
 *      read paths exercise:
 *
 *        - "list every document belonging to one topic, newest
 *           first" — served by { userId, topicId, createdAt: -1 }.
 *           The leftmost prefix { userId, topicId } also serves
 *           the topic-scoped count query the pipeline uses for
 *           progress display.
 *
 *        - "list every document belonging to the current user,
 *           newest first, across all topics" — served by
 *           { userId, createdAt: -1 }.
 *
 *      Both indexes are prefixed by `userId` for the same reason
 *      the Topic model's indexes are: every query on this
 *      collection is scoped to a single authenticated user, and
 *      an index without the userId prefix would never be chosen
 *      by the query planner.
 *
 *   3. Provide a single `toJSON` transform that strips Mongoose's
 *      `__v` version field, so a Document serialised to the
 *      client matches the `Document` interface from `shared/types`
 *      exactly. Without this, every response would carry an extra
 *      `__v: 0` field that the TypeScript type on the renderer
 *      side does not declare — the kind of small drift that
 *      eventually causes a runtime bug in code that iterates
 *      `Object.keys(document)`.
 *
 * Naming collision — the reason for the alias on the Mongoose
 * import:
 *
 *   The domain entity this file models is called `Document`.
 *   Mongoose also has a base class called `Document` — the
 *   interface that every hydrated model instance extends. If
 *   both imports used the same name, TypeScript would raise a
 *   duplicate-identifier error, and even if it did not, the
 *   resulting file would be unreadable. The Mongoose base is
 *   therefore imported under the alias `MongooseDocument`. The
 *   domain type keeps its name. Every reference to `Document`
 *   in the rest of this file — in the interface name, in the
 *   extends clause of `DocumentDocument`, and in the parameter
 *   types — refers to the domain entity from `shared/types`.
 *
 *   The document interface itself is named `DocumentDocument`
 *   rather than something shorter because the naming pattern
 *   established by `UserDocument` in `features/auth/models/User.ts`
 *   and `TopicDocument` in `features/topics/models/Topic.ts` is
 *   `[EntityName]Document`. Following that pattern here produces
 *   the awkward-but-consistent `DocumentDocument` rather than a
 *   one-off abbreviation. Consistency across the model layer is
 *   worth the minor visual cost — a future reader who has seen
 *   one model file can predict the interface name in every other
 *   model file.
 *
 * What this model does NOT do:
 *
 *   - It does not mark `content` as `select: false`. The field
 *     can be a few kilobytes (and occasionally tens of kilobytes)
 *     per record, and a "list all documents for this topic" query
 *     does not need it — the list view shows titles, URLs, word
 *     counts, and platform badges. That projection is the service
 *     layer's job: a list query issues `.select('-content')`, a
 *     writer-step query loads the full document. Making the field
 *     `select: false` would force an explicit `+content` on every
 *     legitimate full read (including the writer step) for the
 *     sole benefit of optimizing one list endpoint, which is a
 *     poor trade.
 *
 *   - It does not enforce that `topicId` references an existing
 *     Topic. Cross-collection referential integrity is the
 *     service layer's concern — the topic service guards creation
 *     of a document by checking that the topic exists and is
 *     owned by the caller, and the document service relies on
 *     that check. A model-level foreign key would require a
 *     plugin or a pre-save hook that queries the topics
 *     collection, and neither is warranted at this collection
 *     size.
 *
 *   - It does not enforce uniqueness on `url` or on
 *     `(topicId, url)`. A user may legitimately want to re-fetch
 *     a page they previously extracted — perhaps the page has
 *     been updated, or perhaps the earlier extraction failed
 *     partway and left a partial record. Deduplicating fetched
 *     URLs against existing documents is a service-layer policy
 *     decision (the current default is "dedupe within a topic by
 *     URL"), not a schema-level invariant, and forcing it at the
 *     schema level would produce a duplicate-key error that the
 *     service would then have to catch and translate. Cleaner to
 *     let the service do the check it actually wants.
 */

import mongoose, { Schema, Document as MongooseDocument } from 'mongoose';
import { Document } from '../../shared/types/index.js';

// ============================================================
//  Document interface
// ============================================================

/**
 * The runtime shape of a Document document as returned by
 * Mongoose.
 *
 * Extends `Omit<Document, '_id'>` (the shared domain interface
 * minus its loosely-typed `_id`) and `MongooseDocument` (the
 * Mongoose base class), then re-declares `_id` with the concrete
 * ObjectId type Mongoose actually produces in-process. This is
 * the same pattern as `UserDocument` and `TopicDocument`: the
 * shared domain type stays transport-agnostic (its `_id` is
 * `string | ObjectId` so it can cross JSON boundaries), while the
 * document interface pins `_id` to what the ODM gives you.
 *
 * No instance methods are declared. Unlike the User model — which
 * needs a `comparePassword` method to keep the bcrypt library out
 * of the service layer — a Document has no per-record behaviour
 * beyond what Mongoose provides out of the box (save, validate,
 * toJSON). Business logic lives in the service.
 */
export interface DocumentDocument
  extends Omit<Document, '_id'>,
    MongooseDocument {
  _id: mongoose.Types.ObjectId;
}

// ============================================================
//  Schema
// ============================================================

const DocumentSchema = new Schema<DocumentDocument>(
  {
    // ---- Ownership ----
    // Every document belongs to exactly one user via the topic
    // it is attached to. Denormalising `userId` onto the document
    // record — rather than deriving ownership by joining through
    // the parent Topic — is deliberate: it lets the model index
    // and the service query both key on `userId` directly, which
    // is the one field every authorization check needs. The
    // alternative (querying topics first, then documents) would
    // double the round trips for every list endpoint and would
    // make a cross-collection cascade delete harder to reason
    // about. The trade is a small amount of write-time
    // denormalisation for a large amount of read-time clarity.
    userId: {
      type: Schema.Types.ObjectId,
      required: [true, 'userId is required'],
    },

    // ---- Parent topic ----
    // The Topic this document belongs to. Together with `userId`
    // this forms the composite identity that the compound index
    // below keys on, and it is the field the "list documents for
    // topic X" query filters on.
    topicId: {
      type: Schema.Types.ObjectId,
      required: [true, 'topicId is required'],
    },

    // ---- Source identity ----
    url: {
      type: String,
      required: [true, 'url is required'],
      trim: true,
      maxlength: [2048, 'url must be at most 2048 characters.'],
      validate: {
        // A URL is "valid" for this model's purposes if the
        // WHATWG URL parser accepts it. The validator uses the
        // global `URL` constructor rather than a regex because
        // a regex that correctly handles every legal URL form
        // (schemes, ports, percent-encoding, IPv6 literals,
        // query strings, fragments) is famously difficult to
        // write correctly, and the standard parser is the same
        // one every browser and the `fetch` implementation use.
        // Any value that parses is accepted; the domain check
        // (http/https, or a specific platform) belongs to the
        // extraction dispatcher, not to the schema.
        validator: (value: string): boolean => {
          try {
            // The URL constructor throws on a malformed input
            // and returns a parsed URL object otherwise. The
            // returned object is not used — the check is only
            // that no throw happened.
            void new URL(value);
            return true;
          } catch {
            return false;
          }
        },
        message: 'url must be a valid absolute URL.',
      },
    },

    platform: {
      type: String,
      required: [true, 'Platform is required'],
      trim: true,
      lowercase: true,
      // The platform identifier is a slug: lowercase letters,
      // digits, and hyphens. Examples in current use: 'reddit',
      // 'quora', 'medium', 'generic'. Deliberately NOT a closed
      // enum — new extractors are added over time and each one
      // has its own platform slug, so a schema-level enum would
      // require a schema change every time the Python side grows
      // a new `extract_*.py` module. The slug format check is
      // the invariant that stays stable: whatever the platform
      // is called, it is a lowercase ASCII slug so that a future
      // query that filters by platform has one canonical form to
      // match against.
      match: [/^[a-z0-9-]+$/, 'platform must be a lowercase slug.'],
      minlength: [1, 'platform must be at least 1 character.'],
      maxlength: [50, 'platform must be at most 50 characters.'],
    },

    title: {
      type: String,
      required: [true, 'Title is required'],
      trim: true,
      minlength: [1, 'Title must be at least 1 character.'],
      maxlength: [500, 'Title must be at most 500 characters.'],
    },

    // ---- Body ----
    // The extracted Markdown body of the page, with YAML
    // frontmatter already stripped by the extraction pipeline.
    // Sized at a few kilobytes in the common case and capped at
    // one megabyte by the schema. The cap is a safety rail, not
    // a design target — the extractor's own word-count guard
    // keeps documents well under it in practice, and the 1 MB
    // ceiling is generous enough that a document hitting it is
    // a signal that the extraction pipeline has broken, not that
    // a legitimate page was exceptionally long.
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
        // counts are conceptually integers — a count of "1847.5
        // words" is meaningless and would only appear if the
        // extraction pipeline passed a float by mistake. This
        // validator catches that at the schema boundary so no
        // downstream consumer has to think about rounding.
        validator: (value: number): boolean => Number.isInteger(value),
        message: 'wordCount must be an integer.',
      },
    },

    // ---- Provenance ----
    // The moment the extraction pipeline finished writing this
    // document. Distinct from Mongoose's own `createdAt` (which
    // is when this record was persisted) because a Document can
    // be created in a batch after the pages were fetched — the
    // fetchedAt timestamp is what the UI shows ("fetched 3
    // minutes ago"), while createdAt is what the database keys
    // its sort on.
    fetchedAt: {
      type: Date,
      required: [true, 'fetchedAt is required'],
    },
  },
  {
    timestamps: true,
    toJSON: {
      transform: (_doc, ret) => {
        // `__v` is Mongoose's internal version field. It is
        // added to every saved document automatically and is not
        // part of the shared `Document` interface, so it must not
        // appear in the JSON response.
        //
        // The cast to `Record<string, unknown>` is required
        // because TypeScript's `delete` operator refuses to
        // operate on non-optional properties (TS2790). The
        // transform callback's `ret` parameter is typed as the
        // schema's document type, which inherits `__v` as a
        // required property from Mongoose's base `Document`
        // interface. Casting to a record loosens the type enough
        // for the delete to be legal without changing any runtime
        // behaviour — the property is removed from the same object
        // either way.
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
//  Two compound indexes cover the read paths the documents
//  feature exercises. Both are prefixed by `userId` because every
//  query on this collection is scoped to a single authenticated
//  user; a query across all users is not a supported operation.
//
//    { userId: 1, topicId: 1, createdAt: -1 }
//      Serves the default "list my documents for topic X, newest
//      first" view. The compound shape means MongoDB can satisfy
//      both the equality filter (userId + topicId) and the sort
//      (createdAt descending) from the index alone, without an
//      in-memory sort stage. The leftmost prefix { userId, topicId }
//      also serves the topic-scoped count query the research
//      progress panel uses ("3 of 10 documents fetched").
//
//    { userId: 1, createdAt: -1 }
//      Serves the cross-topic list — "all my documents, newest
//      first" — which the documents feature offers as an
//      alternate view of the collection, and which the writer
//      step uses to load every document attached to a topic in
//      one query when the topic's documents are the target.
//
//  A third index on { topicId: 1, createdAt: -1 } was considered
//  and rejected: every query in the application already carries a
//  userId (the controller derives it from the authenticated
//  session and passes it to the service, and the service filters
//  on it), so an index without the userId prefix would never be
//  selected by the query planner. If a future cascade-delete path
//  ever needs to remove documents by topicId alone, the correct
//  move is to carry the userId through that path and reuse the
//  existing compound index, not to add a redundant index.

DocumentSchema.index({ userId: 1, topicId: 1, createdAt: -1 });
DocumentSchema.index({ userId: 1, createdAt: -1 });

// ============================================================
//  Model
// ============================================================

export const DocumentModel = mongoose.model<DocumentDocument>(
  'Document',
  DocumentSchema
);

// ============================================================
//  Default export
// ============================================================

export default DocumentModel;