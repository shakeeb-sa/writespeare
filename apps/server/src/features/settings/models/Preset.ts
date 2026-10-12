/**
 * Mongoose model for the WriteSpeare Preset entity.
 *
 * A Preset is a named bundle of pipeline settings that fully
 * describes how a topic's pipeline should run. The three system
 * presets — Quick, Balanced, Deep — ship with the app and are
 * identifiable by their `userId: null` field. A user who tunes
 * the settings for their own workflow can save the resulting
 * configuration as a preset with a custom name; that preset
 * carries the owning user's ObjectId.
 *
 * A preset is deliberately self-contained. Every field the
 * pipeline reads at run time is present on the preset document,
 * so loading a preset replaces the entire effective configuration
 * rather than merging with a global default. That guarantees the
 * same preset produces the same pipeline behaviour regardless of
 * what else the user has configured — a property that would be
 * lost if presets were sparse overrides on a shared base.
 *
 * Responsibilities:
 *
 *   1. Enforce the schema-level invariants of a preset record:
 *      a slug-form `name`, a non-empty `displayName`, sensible
 *      numeric ranges on every count and timeout field, and
 *      either an ObjectId or `null` for `userId` (nothing else).
 *
 *   2. Own the two indexes the preset feature's read paths
 *      exercise:
 *
 *        - A compound UNIQUE index on { userId, name } — which
 *          enforces two separate uniqueness rules with one index:
 *
 *          (a) No two system presets share a name. Since all
 *              system presets have `userId: null`, the tuple
 *              `(null, 'quick')` can exist at most once.
 *
 *          (b) No two presets belonging to the same user share a
 *              name. The tuple `(someObjectId, 'quick')` can
 *              exist at most once for that specific
 *              `someObjectId`.
 *
 *          A user preset named 'quick' is NOT in conflict with
 *          the system 'quick' preset, because their userIds
 *          differ. That is the intended behaviour: a user who
 *          wants to shadow a system preset with their own
 *          variant simply names it the same.
 *
 *        - A compound index on { userId, createdAt: -1 } — serves
 *          the "list my presets, newest first" query that the
 *          preset picker issues. The leftmost prefix { userId }
 *          also serves "list every system preset" (queried with
 *          `{ userId: null }`).
 *
 *   3. Provide a single `toJSON` transform that strips Mongoose's
 *      `__v` version field, so a serialised Preset matches the
 *      shared `Preset` interface exactly.
 *
 * The userId field is nullable:
 *
 *   Unlike every other model in this codebase, the `userId` field
 *   on a Preset is nullable. The nullable case is the semantic
 *   marker for "this preset is a system preset, visible to every
 *   user", while a non-null value means "this preset belongs to
 *   one user and is only visible to them". This is the same
 *   pattern the plan's shared `Preset.userId: MongoId | null`
 *   declares, and the schema mirrors it exactly. The `default:
 *   null` on the field means a preset created without an explicit
 *   `userId` is automatically treated as a system preset — that
 *   is not a mistake, it is the semantic default the plan wants
 *   for the seeder that ships the three built-in presets.
 *
 * The `targetReadingGrade` tuple:
 *
 *   The shared `Preset` interface declares this field as a
 *   two-element tuple `[number, number]` — `[min, max]` of an
 *   acceptable grade band. MongoDB does not have a tuple type,
 *   so the schema stores it as an array of numbers and enforces
 *   the "exactly two elements, both finite numbers" invariant
 *   with a validator. A well-formed record can be trusted by
 *   every reader to have the tuple shape the interface declares.
 *
 * What this model does NOT do:
 *
 *   - It does not seed the three system presets. That is the
 *     job of a future seeder script (`seedPresets` or its
 *     equivalent) that will run alongside the admin seeder in
 *     `features/shared/utils/`. The model is only responsible
 *     for the shape of a preset document, not for populating
 *     the collection with the built-in three.
 *
 *   - It does not enforce cross-field constraints between the
 *     numeric fields. For example, `maxKeywordDensity` should
 *     logically be greater than or equal to `minKeywordDensity`.
 *     The constraint is not checked here — Mongoose's cross-field
 *     validation is awkward to write, and a violation is a bug in
 *     the caller's configuration, not a bad value on a single
 *     field. The service layer is the right place for that check,
 *     where the full preset is available as a unit and the error
 *     can name both fields.
 *
 *   - It does not distinguish "user-created preset" from "system
 *     preset copied and edited by a user" beyond the `userId`
 *     value. If a user saves an edited copy of Balanced under the
 *     name 'my-balanced', it is simply a user preset named
 *     'my-balanced'. There is no linkage back to the system
 *     preset it was derived from, and no flag marking it as
 *     "customised". That simplification is deliberate: the plan's
 *     product model does not need to track derivation, and adding
 *     it would invite a whole class of stale-reference bugs
 *     without solving any current problem.
 */

import mongoose, { Schema, Document as MongooseDocument } from 'mongoose';
import { Preset } from '../../shared/types/index.js';

// ============================================================
//  Document interface
// ============================================================

/**
 * The runtime shape of a Preset document as returned by Mongoose.
 *
 * Extends `Omit<Preset, '_id'>` (the shared domain interface
 * minus its loosely-typed `_id`) and `MongooseDocument` (the
 * Mongoose base class), then re-declares `_id` with the concrete
 * ObjectId type Mongoose actually produces in-process. Same
 * pattern as every other model in this codebase.
 *
 * No instance methods are declared. A Preset has no per-record
 * behaviour beyond what Mongoose provides out of the box (save,
 * validate, toJSON). Business logic — applying a preset to a
 * topic, deriving a custom preset from a system one — lives in
 * the service.
 */
export interface PresetDocument
  extends Omit<Preset, '_id'>,
    MongooseDocument {
  _id: mongoose.Types.ObjectId;
}

// ============================================================
//  Schema
// ============================================================

// ---- Default bucket layout ----
// The four time-range buckets the preset's search phase fills.
// Each value is the number of candidates the search step should
// collect for that specific time range; a value of zero means
// the bucket is skipped entirely (per the plan's Q8.3 decision).
// The four values sum to the preset's `sourceCount`, which is
// stored alongside this layout as a materialised aggregate.
//
// Declared as a standalone `Schema` with `{ _id: false }` so
// Mongoose does not auto-generate an `_id` on the embedded
// sub-document. Same pattern the Report model uses for its six
// section sub-schemas.
const DefaultBucketLayoutSchema = new Schema(
  {
    anyTime: {
      type: Number,
      required: true,
      min: [0, 'anyTime must be non-negative.'],
      max: [50, 'anyTime must be at most 50.'],
      validate: {
        validator: (value: number): boolean => Number.isInteger(value),
        message: 'anyTime must be an integer.',
      },
    },
    pastYear: {
      type: Number,
      required: true,
      min: [0, 'pastYear must be non-negative.'],
      max: [50, 'pastYear must be at most 50.'],
      validate: {
        validator: (value: number): boolean => Number.isInteger(value),
        message: 'pastYear must be an integer.',
      },
    },
    pastMonth: {
      type: Number,
      required: true,
      min: [0, 'pastMonth must be non-negative.'],
      max: [50, 'pastMonth must be at most 50.'],
      validate: {
        validator: (value: number): boolean => Number.isInteger(value),
        message: 'pastMonth must be an integer.',
      },
    },
    pastWeek: {
      type: Number,
      required: true,
      min: [0, 'pastWeek must be non-negative.'],
      max: [50, 'pastWeek must be at most 50.'],
      validate: {
        validator: (value: number): boolean => Number.isInteger(value),
        message: 'pastWeek must be an integer.',
      },
    },
  },
  { _id: false }
);


const PresetSchema = new Schema<PresetDocument>(
  {
    // ---- Ownership ----
    // `null` marks a system preset (visible to every user); a
    // non-null ObjectId marks a user-owned preset. See the file
    // header for why the field is nullable. The `default: null`
    // makes the system-preset case the implicit one, matching
    // the seeder's intent: a preset created without an owner is
    // a system preset.
    userId: {
      type: Schema.Types.ObjectId,
      default: null,
    },

    // ---- Identity ----
    // The slug-form identifier the pipeline uses to reference
    // the preset. Format matches the platform slug convention
    // used elsewhere in the codebase (lowercase letters, digits,
    // hyphens) so a future "find by name" query has one
    // canonical form to match against.
    name: {
      type: String,
      required: [true, 'Name is required'],
      trim: true,
      lowercase: true,
      match: [/^[a-z0-9-]+$/, 'name must be a lowercase slug.'],
      minlength: [1, 'name must be at least 1 character.'],
      maxlength: [50, 'name must be at most 50 characters.'],
    },
    displayName: {
      type: String,
      required: [true, 'displayName is required'],
      trim: true,
      minlength: [1, 'displayName must be at least 1 character.'],
      maxlength: [100, 'displayName must be at most 100 characters.'],
    },

    // ---- Pipeline configuration ----
    // The four-bucket search distribution. This is the primary
    // count field on the preset: every topic created with the
    // preset snapshots this layout, and the Python search
    // pipeline runs one time-bucketed search per bucket. The
    // bucket layout is the single source of truth for "how many
    // sources to collect"; there is no separate maxResults
    // field. See the plan's Item 3 / C2 decision for the full
    // rationale.
    defaultBucketLayout: {
      type: DefaultBucketLayoutSchema,
      required: true,
    },
    // `sourceCount` is a derived value: its value is always the
    // sum of `defaultBucketLayout`'s four bucket counts. It is
    // stored as a materialised aggregate so that a caller which
    // only needs the total does not have to fetch the full
    // bucket object and sum it itself. The service is
    // responsible for keeping this field in sync with the
    // bucket layout on every write.
    sourceCount: {
      type: Number,
      required: true,
      min: [1, 'sourceCount must be at least 1.'],
      max: [50, 'sourceCount must be at most 50.'],
      validate: {
        validator: (value: number): boolean => Number.isInteger(value),
        message: 'sourceCount must be an integer.',
      },
    },
    wordCount: {
      type: Number,
      required: true,
      min: [100, 'wordCount must be at least 100.'],
      max: [10000, 'wordCount must be at most 10000.'],
      validate: {
        validator: (value: number): boolean => Number.isInteger(value),
        message: 'wordCount must be an integer.',
      },
    },

    // ---- Search behaviour ----
    // The ordered list of search engines the search step will
    // try, most-preferred first. Example: ['google',
    // 'duckduckgo']. The list is NOT a closed enum at the
    // schema level — new engines are added on the Python side
    // over time, and a schema change would be required every
    // time one was added. The dispatcher on the Python side is
    // the authoritative validator for what engines it can
    // actually run.
    searchEngines: {
      type: [String],
      default: ['google', 'duckduckgo'],
    },
    resultsPerPage: {
      type: Number,
      required: true,
      min: [1, 'resultsPerPage must be at least 1.'],
      max: [100, 'resultsPerPage must be at most 100.'],
      validate: {
        validator: (value: number): boolean => Number.isInteger(value),
        message: 'resultsPerPage must be an integer.',
      },
    },


    // ---- Extraction behaviour ----
    // Per-page navigation timeout in milliseconds. Minimum one
    // second, maximum two minutes. The bounds reject obviously
    // bad configurations (a timeout of 0 would fail every page
    // load instantly; a timeout of an hour would hang the
    // pipeline on a dead page).
    pageLoadTimeout: {
      type: Number,
      required: true,
      min: [1000, 'pageLoadTimeout must be at least 1000 ms.'],
      max: [120000, 'pageLoadTimeout must be at most 120000 ms.'],
      validate: {
        validator: (value: number): boolean => Number.isInteger(value),
        message: 'pageLoadTimeout must be an integer.',
      },
    },
    maxRetries: {
      type: Number,
      required: true,
      min: [0, 'maxRetries must be non-negative.'],
      max: [10, 'maxRetries must be at most 10.'],
      validate: {
        validator: (value: number): boolean => Number.isInteger(value),
        message: 'maxRetries must be an integer.',
      },
    },

    // ---- Validation thresholds ----
    // The target reading grade band, as [min, max]. Stored as a
    // two-element numeric array; the validators enforce the
    // tuple shape the shared interface declares.
    targetReadingGrade: {
      type: [Number],
      required: true,
      validate: [
        {
          validator: (value: number[]): boolean => value.length === 2,
          message: 'targetReadingGrade must have exactly 2 elements.',
        },
        {
          validator: (value: number[]): boolean =>
            value.every(
              (n) => typeof n === 'number' && Number.isFinite(n)
            ),
          message: 'targetReadingGrade elements must be finite numbers.',
        },
      ],
    },

    // Keyword densities are fractions of word count (0–1). A
    // min of 0 means "no minimum"; a max of 1 means "up to
    // every word being the keyword", which is nonsensical in
    // practice but structurally valid.
    minKeywordDensity: {
      type: Number,
      required: true,
      min: [0, 'minKeywordDensity must be at least 0.'],
      max: [1, 'minKeywordDensity must be at most 1.'],
    },
    maxKeywordDensity: {
      type: Number,
      required: true,
      min: [0, 'maxKeywordDensity must be at least 0.'],
      max: [1, 'maxKeywordDensity must be at most 1.'],
    },

    // Similarity ceilings for the two originality checks (TF-IDF
    // and semantic embedding). Both are fractions of similarity
    // (0–1); a value of 0.30 means "flag anything that resembles
    // any source by more than 30%".
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

    // Maximum number of AI-tell phrases permitted before the
    // report flags the AI-marker section.
    maxAiMarkers: {
      type: Number,
      required: true,
      min: [0, 'maxAiMarkers must be non-negative.'],
      max: [100, 'maxAiMarkers must be at most 100.'],
      validate: {
        validator: (value: number): boolean => Number.isInteger(value),
        message: 'maxAiMarkers must be an integer.',
      },
    },

    // ---- Per-check toggles ----
    // Which of the six validators run when this preset is in
    // effect. A user who is confident in their grammar, for
    // example, can disable the grammar check to shave seconds
    // off every validation run.
    runReadabilityCheck: {
      type: Boolean,
      default: true,
      required: true,
    },
    runSeoCheck: {
      type: Boolean,
      default: true,
      required: true,
    },
    runOriginalityCheck: {
      type: Boolean,
      default: true,
      required: true,
    },
    runAiMarkerCheck: {
      type: Boolean,
      default: true,
      required: true,
    },
    runGrammarCheck: {
      type: Boolean,
      default: true,
      required: true,
    },

    // ---- Corrective loop ----
    // Whether the pipeline should re-run the writer with a
    // corrective prompt when validation fails, and how many
    // attempts to try before giving up. A max of 0 with
    // autoRegenerate true would be a contradiction — the service
    // is expected to reject that configuration — but the schema
    // does not enforce the cross-field constraint (see the file
    // header for why).
    autoRegenerate: {
      type: Boolean,
      default: false,
      required: true,
    },
    maxRegenerationAttempts: {
      type: Number,
      required: true,
      min: [0, 'maxRegenerationAttempts must be non-negative.'],
      max: [10, 'maxRegenerationAttempts must be at most 10.'],
      validate: {
        validator: (value: number): boolean => Number.isInteger(value),
        message: 'maxRegenerationAttempts must be an integer.',
      },
    },
  },
  {
    timestamps: true,
    toJSON: {
      transform: (_doc, ret) => {
        // `__v` is Mongoose's internal version field. It is added
        // to every saved document automatically and is not part
        // of the shared `Preset` interface, so it must not appear
        // in the JSON response.
        //
        // The cast to `Record<string, unknown>` is required
        // because TypeScript's `delete` operator refuses to
        // operate on non-optional properties (TS2790). The same
        // fix is applied in every other model in this codebase.
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
//  Two compound indexes cover the read paths the preset feature
//  exercises. Both include `userId` as their leftmost field
//  because every query on this collection is scoped either to a
//  specific user or to the system-wide `null` scope.
//
//    { userId: 1, name: 1 } — UNIQUE
//      Enforces the "no two presets share a name within the same
//      scope" invariant. See the file header for the two
//      uniqueness rules this single index provides. Also serves
//      the primary read path: `findOne({ userId, name })` is
//      an index-covered lookup with no collection scan.
//
//      The unique constraint is declared here (rather than via
//      `unique: true` on either field alone) because Mongoose
//      only creates a compound unique index from an explicit
//      `.index(...)` call — putting `unique: true` on `userId`
//      and `name` independently would create two single-field
//      unique indexes, which is the wrong thing: a single-field
//      unique index on `userId` alone would allow at most one
//      preset per user (wrong — users can have many), and a
//      single-field unique index on `name` alone would forbid
//      two users from both having a preset called 'draft'.
//
//    { userId: 1, createdAt: -1 }
//      Serves "list my presets, newest first" (the preset
//      picker's default view) and "list all system presets"
//      (queried with `{ userId: null }`, which the leftmost
//      prefix serves). The compound shape means MongoDB can
//      satisfy both the equality filter on userId and the sort
//      on createdAt from the index alone, without an in-memory
//      sort stage.
//
//  A third index on `name` alone was considered and rejected:
//  the read paths that look up a preset by name always know the
//  userId first (either a specific user's, or `null` for a
//  system preset), so a name-only index would never be chosen
//  by the query planner. If a future feature needs to look up a
//  preset by name without knowing its scope, the correct change
//  is to extend the compound unique index's prefix, not to add
//  a redundant one.

PresetSchema.index({ userId: 1, name: 1 }, { unique: true });
PresetSchema.index({ userId: 1, createdAt: -1 });

// ============================================================
//  Model
// ============================================================

export const PresetModel = mongoose.model<PresetDocument>(
  'Preset',
  PresetSchema
);

// ============================================================
//  Default export
// ============================================================

export default PresetModel;