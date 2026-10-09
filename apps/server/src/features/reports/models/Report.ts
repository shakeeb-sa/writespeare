/**
 * Mongoose model for the WriteSpeare Report entity.
 *
 * A Report is the validation output produced against one
 * Article. It carries six sections — readability, SEO, keywords,
 * originality, AI markers, grammar — that map one-for-one to the
 * six Python validators in `apps/desktop/src/resources/scripts/validation/`.
 * The backend stores what the desktop's validation runner
 * produces, exactly as produced; it does not reinterpret or
 * re-score the numbers.
 *
 * Responsibilities:
 *
 *   1. Enforce the schema-level invariants of a report record.
 *      Every leaf field has a type, a numeric range where
 *      meaningful, and — for the three closed-set unions
 *      (`ReportStatus`, keyword priority, and the section status
 *      that follows from `ReportStatus`) — a runtime enum array
 *      that mirrors the string-literal union declared in
 *      `shared/types`.
 *
 *   2. Own the two compound indexes that the reports feature's
 *      read paths exercise:
 *
 *        - "list every report for one article, newest first" —
 *           served by { userId, articleId, createdAt: -1 }. A
 *           single article can have multiple reports: one per
 *           validation run, produced against successive
 *           versions or against a single version re-checked
 *           after the user edits content. The most recent one
 *           is the "current" report.
 *
 *        - "list every report for one topic, newest first" —
 *           served by { userId, topicId, createdAt: -1 }. The
 *           topic-detail view uses this to build a per-topic
 *           validation history without needing the intermediate
 *           articleId.
 *
 *      Both indexes are prefixed by `userId` for the same reason
 *      every other model's indexes are: every query on this
 *      collection is scoped to a single authenticated user.
 *
 *   3. Provide a single `toJSON` transform that strips Mongoose's
 *      `__v` version field, so a serialised Report matches the
 *      shared `Report` interface exactly.
 *
 * Sub-schemas and why they are embedded:
 *
 *   Each of the six sections is declared as its own `Schema` with
 *   `{ _id: false }`, and the top-level schema embeds them as
 *   sub-documents. This is the correct choice for three reasons:
 *
 *   (a) A Report is always read as a whole. No code path needs
 *       the readability numbers without the SEO numbers, or the
 *       keywords without the originality scores. Splitting the
 *       sections into their own collections would force six
 *       joins per read for zero benefit.
 *
 *   (b) The sections are not independently addressable. There is
 *       no operation in the product that reads or writes one
 *       section in isolation — the validation runner produces
 *       all six in one pass, and the desktop renderer consumes
 *       all six in one view.
 *
 *   (c) The sections have no lifecycle of their own. They are
 *       created when the Report is created and deleted when the
 *       Report is deleted. Making them independent documents
 *       would require a cascade delete with no compensating
 *       benefit.
 *
 *   The `_id: false` option on each sub-schema is important: by
 *   default, Mongoose adds an auto-generated `_id` to every sub-
 *   document, which is wasteful here (nothing ever references a
 *   section by id) and adds an `_id` field to the JSON output
 *   that the shared `Report` interface does not declare.
 *
 * Why the whole report is stored, not a reference to a file:
 *
 *   The desktop's Python validators can also write a JSON file
 *   to disk (the `reports/` folder in the topic directory), but
 *   that file is a local cache — the authoritative copy of the
 *   report is this MongoDB record. Storing the numbers in the
 *   database means:
 *
 *   (a) The user can switch machines and still see their
 *       validation history, provided they log in to the same
 *       backend.
 *   (b) The Reports dashboard can list every report across every
 *       topic without touching the filesystem.
 *   (c) A future server-side feature (a fleet-wide dashboard, a
 *       usage analytics job) can query the numbers directly.
 *
 *   The file on disk is a convenience for the desktop's local
 *   history view; the database is the source of truth.
 *
 * What this model does NOT do:
 *
 *   - It does not enforce that `articleId` or `topicId` reference
 *     existing records. Cross-collection referential integrity is
 *     the service layer's concern — the report service verifies
 *     the parent Article's ownership before persisting, exactly
 *     as the article service verifies its parent Topic.
 *
 *   - It does not enforce that `overallStatus` is consistent with
 *     the six section statuses. The rule for computing
 *     `overallStatus` (the weakest of the six) is a service-level
 *     policy — it might change, and it depends on per-user
 *     configuration (a user who disables the AI-marker check
 *     should not have that check's status drag down their overall
 *     score). The schema only stores what it is given.
 *
 *   - It does not version reports the way Articles are versioned.
 *     A new report is simply a new document with a later
 *     `createdAt`; the "current" report for an article is the one
 *     with the highest `createdAt` for that article. This is the
 *     right model for validation output — unlike an article,
 *     which is a user-facing artifact that the user may want to
 *     diff across versions, a report is a point-in-time snapshot
 *     and the only comparison the user cares about is "did the
 *     score improve since the last run".
 */

import mongoose, { Schema, Document as MongooseDocument } from 'mongoose';
import { Report, ReportStatus } from '../../shared/types/index.js';

// ============================================================
//  Document interface
// ============================================================

/**
 * The runtime shape of a Report document as returned by Mongoose.
 *
 * Extends `Omit<Report, '_id'>` (the shared domain interface
 * minus its loosely-typed `_id`) and `MongooseDocument` (the
 * Mongoose base class), then re-declares `_id` with the concrete
 * ObjectId type Mongoose actually produces in-process. Same
 * pattern as `UserDocument`, `TopicDocument`, `DocumentDocument`,
 * and `ArticleDocument`.
 *
 * No instance methods are declared. A Report has no per-record
 * behaviour beyond what Mongoose provides out of the box (save,
 * validate, toJSON). Business logic — computing `overallStatus`
 * from the section statuses, applying per-user thresholds —
 * lives in the service.
 */
export interface ReportDocument
  extends Omit<Report, '_id'>,
    MongooseDocument {
  _id: mongoose.Types.ObjectId;
}

// ============================================================
//  Legal values (runtime counterparts of the union types)
// ============================================================

/**
 * The closed set of legal values for any status field — the
 * section-level `status` on each of the six sections, and the
 * top-level `overallStatus`.
 *
 * `ReportStatus` in `shared/types/index.ts` is a string-literal
 * union type — it does not exist at runtime, so Mongoose cannot
 * use it directly as an `enum` option. This array is the runtime
 * source of truth, and its type annotation (`readonly ReportStatus[]`)
 * guarantees at compile time that every string in the array is a
 * legal member of the union.
 *
 * The same array is reused for every status field on every
 * sub-schema, so there is exactly one place to change if the set
 * of legal statuses ever expands.
 */
const REPORT_STATUS_VALUES: readonly ReportStatus[] = [
  'good',
  'warning',
  'fail',
];

/**
 * The closed set of legal values for a keyword's priority.
 *
 * `KeywordReportEntry.priority` in `shared/types` is the union
 * `'primary' | 'secondary' | 'supporting'`. That union is not
 * exported as a named type from `shared/types`; this array is
 * declared locally, annotated with the equivalent inline union so
 * the compiler can verify that every string is a legal member.
 *
 * The priorities are used by the UI to sort keyword rows and by
 * a future scoring adjustment that weights primary keywords more
 * heavily than supporting ones. For now the schema only enforces
 * that the value is one of the three.
 */
const KEYWORD_PRIORITY_VALUES: readonly [
  'primary',
  'secondary',
  'supporting',
] = ['primary', 'secondary', 'supporting'];

// ============================================================
//  Sub-schemas
// ============================================================
//
//  Each of the six sections is a separate Schema, declared with
//  `{ _id: false }` so Mongoose does not auto-generate an `_id`
//  on every embedded sub-document. The schemas are declared as
//  standalone constants and embedded by reference below — this
//  keeps the top-level schema readable (each section is one line
//  in the top-level definition) and lets each sub-schema carry
//  its own validation rules in one place.

// ---- Readability ----

const ReadabilityReportSchema = new Schema(
  {
    fleschReadingEase: {
      type: Number,
      required: true,
      // 0–100 in theory; textstat can report slightly above 100
      // for very short texts composed almost entirely of one-
      // syllable words, so the upper bound is generous rather
      // than exactly 100. A negative score is possible for very
      // dense academic prose.
      min: [-100, 'fleschReadingEase must be at least -100.'],
      max: [200, 'fleschReadingEase must be at most 200.'],
    },
    fleschKincaidGrade: {
      type: Number,
      required: true,
      min: [-10, 'fleschKincaidGrade must be at least -10.'],
      max: [30, 'fleschKincaidGrade must be at most 30.'],
    },
    gunningFog: {
      type: Number,
      required: true,
      min: [0, 'gunningFog must be non-negative.'],
      max: [30, 'gunningFog must be at most 30.'],
    },
    smogIndex: {
      type: Number,
      required: true,
      min: [0, 'smogIndex must be non-negative.'],
      max: [30, 'smogIndex must be at most 30.'],
    },
    avgSentenceLength: {
      type: Number,
      required: true,
      min: [0, 'avgSentenceLength must be non-negative.'],
      max: [200, 'avgSentenceLength must be at most 200.'],
    },
    readingTimeSeconds: {
      type: Number,
      required: true,
      min: [0, 'readingTimeSeconds must be non-negative.'],
      validate: {
        // Reading time is a count of whole seconds. A float
        // would indicate the Python validator returned a raw
        // division without rounding, which is a pipeline bug
        // worth catching at the schema boundary.
        validator: (value: number): boolean => Number.isInteger(value),
        message: 'readingTimeSeconds must be an integer.',
      },
    },
    status: {
      type: String,
      enum: {
        values: REPORT_STATUS_VALUES,
        message: 'status must be one of: good, warning, fail.',
      },
      required: true,
    },
  },
  { _id: false }
);

// ---- SEO ----

const SeoReportSchema = new Schema(
  {
    wordCount: {
      type: Number,
      required: true,
      min: [0, 'wordCount must be non-negative.'],
      max: [1000000, 'wordCount must be at most 1000000.'],
      validate: {
        validator: (value: number): boolean => Number.isInteger(value),
        message: 'wordCount must be an integer.',
      },
    },
    h2Count: {
      type: Number,
      required: true,
      min: [0, 'h2Count must be non-negative.'],
      max: [1000, 'h2Count must be at most 1000.'],
      validate: {
        validator: (value: number): boolean => Number.isInteger(value),
        message: 'h2Count must be an integer.',
      },
    },
    h3Count: {
      type: Number,
      required: true,
      min: [0, 'h3Count must be non-negative.'],
      max: [1000, 'h3Count must be at most 1000.'],
      validate: {
        validator: (value: number): boolean => Number.isInteger(value),
        message: 'h3Count must be an integer.',
      },
    },
    avgParagraphWords: {
      type: Number,
      required: true,
      min: [0, 'avgParagraphWords must be non-negative.'],
      max: [10000, 'avgParagraphWords must be at most 10000.'],
    },
    passiveVoicePercent: {
      // Stored as a fraction (0–1), matching the shared type's
      // documented units. The Python validator is responsible for
      // normalizing to this scale; the schema just checks the
      // bounds.
      type: Number,
      required: true,
      min: [0, 'passiveVoicePercent must be between 0 and 1.'],
      max: [1, 'passiveVoicePercent must be between 0 and 1.'],
    },
    transitionWordsPercent: {
      type: Number,
      required: true,
      min: [0, 'transitionWordsPercent must be between 0 and 1.'],
      max: [1, 'transitionWordsPercent must be between 0 and 1.'],
    },
    status: {
      type: String,
      enum: {
        values: REPORT_STATUS_VALUES,
        message: 'status must be one of: good, warning, fail.',
      },
      required: true,
    },
  },
  { _id: false }
);

// ---- Keywords ----

const KeywordReportEntrySchema = new Schema(
  {
    keyword: {
      type: String,
      required: true,
      trim: true,
      minlength: [1, 'keyword must not be empty.'],
      maxlength: [200, 'keyword must be at most 200 characters.'],
    },
    priority: {
      type: String,
      enum: {
        values: KEYWORD_PRIORITY_VALUES,
        message:
          'priority must be one of: primary, secondary, supporting.',
      },
      required: true,
    },
    count: {
      type: Number,
      required: true,
      min: [0, 'count must be non-negative.'],
      max: [100000, 'count must be at most 100000.'],
      validate: {
        validator: (value: number): boolean => Number.isInteger(value),
        message: 'count must be an integer.',
      },
    },
    density: {
      // Fraction of word count (0–1). A density of 0.02 means
      // the keyword accounts for 2% of the article's words.
      type: Number,
      required: true,
      min: [0, 'density must be between 0 and 1.'],
      max: [1, 'density must be between 0 and 1.'],
    },
    inTitle: {
      type: Boolean,
      required: true,
    },
    inIntro: {
      type: Boolean,
      required: true,
    },
    inH2Count: {
      type: Number,
      required: true,
      min: [0, 'inH2Count must be non-negative.'],
      max: [1000, 'inH2Count must be at most 1000.'],
      validate: {
        validator: (value: number): boolean => Number.isInteger(value),
        message: 'inH2Count must be an integer.',
      },
    },
    status: {
      type: String,
      enum: {
        values: REPORT_STATUS_VALUES,
        message: 'status must be one of: good, warning, fail.',
      },
      required: true,
    },
  },
  { _id: false }
);

const KeywordReportSchema = new Schema(
  {
    keywords: {
      type: [KeywordReportEntrySchema],
      default: [],
    },
    status: {
      type: String,
      enum: {
        values: REPORT_STATUS_VALUES,
        message: 'status must be one of: good, warning, fail.',
      },
      required: true,
    },
  },
  { _id: false }
);

// ---- Originality ----

const FlaggedSentenceSchema = new Schema(
  {
    text: {
      type: String,
      required: true,
      trim: true,
      minlength: [1, 'text must not be empty.'],
      // 5000 characters is generous for a single sentence — the
      // longest legitimate sentence in normal prose is a few
      // hundred characters. The bound exists to reject a
      // malformed entry that accidentally contains a whole
      // paragraph.
      maxlength: [5000, 'text must be at most 5000 characters.'],
    },
    similarity: {
      // 0–1 cosine similarity. Values above the user's configured
      // threshold are what caused this sentence to be flagged.
      type: Number,
      required: true,
      min: [0, 'similarity must be between 0 and 1.'],
      max: [1, 'similarity must be between 0 and 1.'],
    },
    sourceTitle: {
      type: String,
      required: true,
      trim: true,
      minlength: [1, 'sourceTitle must not be empty.'],
      maxlength: [500, 'sourceTitle must be at most 500 characters.'],
    },
  },
  { _id: false }
);

const OriginalityReportSchema = new Schema(
  {
    maxTfidfSimilarity: {
      type: Number,
      required: true,
      min: [0, 'maxTfidfSimilarity must be between 0 and 1.'],
      max: [1, 'maxTfidfSimilarity must be between 0 and 1.'],
    },
    maxSemanticSimilarity: {
      type: Number,
      required: true,
      min: [0, 'maxSemanticSimilarity must be between 0 and 1.'],
      max: [1, 'maxSemanticSimilarity must be between 0 and 1.'],
    },
    flaggedSentences: {
      type: [FlaggedSentenceSchema],
      default: [],
    },
    status: {
      type: String,
      enum: {
        values: REPORT_STATUS_VALUES,
        message: 'status must be one of: good, warning, fail.',
      },
      required: true,
    },
  },
  { _id: false }
);

// ---- AI markers ----

const AiMarkerEntrySchema = new Schema(
  {
    phrase: {
      type: String,
      required: true,
      trim: true,
      minlength: [1, 'phrase must not be empty.'],
      maxlength: [200, 'phrase must be at most 200 characters.'],
    },
    count: {
      type: Number,
      required: true,
      min: [0, 'count must be non-negative.'],
      max: [100000, 'count must be at most 100000.'],
      validate: {
        validator: (value: number): boolean => Number.isInteger(value),
        message: 'count must be an integer.',
      },
    },
  },
  { _id: false }
);

const AiMarkersReportSchema = new Schema(
  {
    markerCount: {
      // The total number of AI-tell phrases found across the
      // whole article — not the number of distinct phrases.
      // A phrase that appears four times contributes 4 to this
      // count and appears once in the `markers` array with
      // `count: 4`.
      type: Number,
      required: true,
      min: [0, 'markerCount must be non-negative.'],
      max: [100000, 'markerCount must be at most 100000.'],
      validate: {
        validator: (value: number): boolean => Number.isInteger(value),
        message: 'markerCount must be an integer.',
      },
    },
    markers: {
      type: [AiMarkerEntrySchema],
      default: [],
    },
    status: {
      type: String,
      enum: {
        values: REPORT_STATUS_VALUES,
        message: 'status must be one of: good, warning, fail.',
      },
      required: true,
    },
  },
  { _id: false }
);

// ---- Grammar ----

const GrammarIssueSchema = new Schema(
  {
    ruleId: {
      // LanguageTool's rule identifier, e.g. 'EN_QUOTES',
      // 'UPPERCASE_SENTENCE_START'. Opaque to the backend —
      // stored and returned verbatim.
      type: String,
      required: true,
      trim: true,
      minlength: [1, 'ruleId must not be empty.'],
      maxlength: [200, 'ruleId must be at most 200 characters.'],
    },
    message: {
      type: String,
      required: true,
      trim: true,
      minlength: [1, 'message must not be empty.'],
      maxlength: [2000, 'message must be at most 2000 characters.'],
    },
    offset: {
      // Character position in the article body where the issue
      // starts. Non-negative; the article can be up to a million
      // characters, so the upper bound matches.
      type: Number,
      required: true,
      min: [0, 'offset must be non-negative.'],
      max: [1000000, 'offset must be at most 1000000.'],
      validate: {
        validator: (value: number): boolean => Number.isInteger(value),
        message: 'offset must be an integer.',
      },
    },
    length: {
      type: Number,
      required: true,
      min: [0, 'length must be non-negative.'],
      max: [1000000, 'length must be at most 1000000.'],
      validate: {
        validator: (value: number): boolean => Number.isInteger(value),
        message: 'length must be an integer.',
      },
    },
    replacements: {
      type: [String],
      default: [],
    },
  },
  { _id: false }
);

const GrammarReportSchema = new Schema(
  {
    issueCount: {
      type: Number,
      required: true,
      min: [0, 'issueCount must be non-negative.'],
      max: [100000, 'issueCount must be at most 100000.'],
      validate: {
        validator: (value: number): boolean => Number.isInteger(value),
        message: 'issueCount must be an integer.',
      },
    },
    issues: {
      type: [GrammarIssueSchema],
      default: [],
    },
    status: {
      type: String,
      enum: {
        values: REPORT_STATUS_VALUES,
        message: 'status must be one of: good, warning, fail.',
      },
      required: true,
    },
  },
  { _id: false }
);

// ============================================================
//  Top-level schema
// ============================================================

const ReportSchema = new Schema<ReportDocument>(
  {
    // ---- Ownership ----
    // Every report belongs to exactly one user via the article
    // and topic it is attached to. Denormalising `userId` onto
    // the report follows the same pattern as the Document and
    // Article models: it lets the indexes key on `userId`
    // directly and means every authorization check queries one
    // collection instead of three.
    userId: {
      type: Schema.Types.ObjectId,
      required: [true, 'userId is required'],
    },

    // ---- Parent references ----
    // Both the immediate parent (articleId) and the grandparent
    // (topicId) are stored, denormalised, so that the two list
    // queries the reports feature exposes — "reports for this
    // article" and "reports for this topic" — are each a single
    // indexed query on this collection, with no join through
    // the Article collection for the topic-scoped case.
    articleId: {
      type: Schema.Types.ObjectId,
      required: [true, 'articleId is required'],
    },
    topicId: {
      type: Schema.Types.ObjectId,
      required: [true, 'topicId is required'],
    },

    // ---- Six sections ----
    // Each section is an embedded sub-document. The subschema
    // constants declared above carry the field-level validation;
    // the entries here only wire the sub-schemas in by reference.
    readability: {
      type: ReadabilityReportSchema,
      required: true,
    },
    seo: {
      type: SeoReportSchema,
      required: true,
    },
    keywords: {
      type: KeywordReportSchema,
      required: true,
    },
    originality: {
      type: OriginalityReportSchema,
      required: true,
    },
    aiMarkers: {
      type: AiMarkersReportSchema,
      required: true,
    },
    grammar: {
      type: GrammarReportSchema,
      required: true,
    },

    // ---- Aggregate status ----
    // The weakest of the six section statuses, computed by the
    // service. The schema enforces that the value is a member of
    // the closed set; it does NOT recompute or verify the value
    // against the section statuses — see the file header for why
    // that rule belongs in the service.
    overallStatus: {
      type: String,
      enum: {
        values: REPORT_STATUS_VALUES,
        message:
          'overallStatus must be one of: good, warning, fail.',
      },
      required: true,
    },
  },
  {
    timestamps: true,
    toJSON: {
      transform: (_doc, ret) => {
        // `__v` is Mongoose's internal version field. It is
        // added to every saved document automatically and is
        // not part of the shared `Report` interface, so it must
        // not appear in the JSON response.
        //
        // The cast to `Record<string, unknown>` is required
        // because TypeScript's `delete` operator refuses to
        // operate on non-optional properties (TS2790). The same
        // fix is applied in `Topic.ts`, `Document.ts`, and
        // `Article.ts`.
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
//  Two compound indexes cover the read paths the reports feature
//  exercises. Both are prefixed by `userId` for the same reason
//  as every other model's indexes.
//
//    { userId: 1, articleId: 1, createdAt: -1 }
//      Serves "list every report for this article, newest
//      first". An article can accumulate multiple reports — one
//      per validation run — and the newest is the "current"
//      report. The compound shape lets MongoDB satisfy the
//      filter (userId + articleId) and the sort (createdAt
//      descending) from the index alone.
//
//    { userId: 1, topicId: 1, createdAt: -1 }
//      Serves "list every report for this topic, newest first",
//      which the topic-detail view uses to build a validation
//      history without going through the intermediate Article
//      collection. Same reasoning: filter and sort covered by
//      the index in one pass.
//
//  A third index on `overallStatus` was considered and rejected:
//  no read path filters by status alone, and a status filter
//  would always be combined with one of the two ownership-scoped
//  filters above. If a future feature wants to query "all my
//  failed reports", the correct shape is a compound index
//  { userId, overallStatus, createdAt: -1 }, which can be added
//  without a migration.

ReportSchema.index({ userId: 1, articleId: 1, createdAt: -1 });
ReportSchema.index({ userId: 1, topicId: 1, createdAt: -1 });

// ============================================================
//  Model
// ============================================================

export const ReportModel = mongoose.model<ReportDocument>(
  'Report',
  ReportSchema
);

// ============================================================
//  Default export
// ============================================================

export default ReportModel;