/**
 * Mongoose model for the WriteSpeare Topic entity.
 *
 * A Topic is the atomic unit of work in WriteSpeare: one title
 * in, one article out. Every Document, Article, and Report
 * references its owning Topic by `_id`. The Topic document is
 * where the user's per-topic choices live — which preset they
 * picked, which profile, which prompt template, how many sources
 * and how many words they asked for — plus the runtime status
 * that tracks where the pipeline currently is.
 *
 * Responsibilities:
 *
 *   1. Enforce the schema-level invariants of a topic record:
 *      a non-empty title, legal values for the three closed
 *      unions (status / preset / profile), numeric ranges on the
 *      two count fields, and a bounded error string.
 *
 *   2. Own the indexes that make the two access patterns the
 *      Topics page exercises efficient:
 *
 *        - "list every topic belonging to the current user,
 *           newest first" — served by { userId, createdAt }.
 *        - "filter the current user's topics by status" —
 *           served by { userId, status }.
 *
 *      Both indexes are compound with `userId` as the prefix
 *      because every query on this collection is scoped to a
 *      single user. A bare `{ status }` index would never be
 *      used: no code path queries topics across all users, and
 *      adding a wide cross-user index would slow writes for no
 *      read benefit.
 *
 *   3. Provide a single `toJSON` transform that strips Mongoose's
 *      `__v` version field, so a Topic serialised to the client
 *      matches the `Topic` interface from `shared/types` exactly.
 *      Without this, every response would carry an extra
 *      `__v: 0` field that the TypeScript type on the renderer
 *      side does not declare — the kind of small drift that
 *      eventually causes a runtime bug in code that iterates
 *      `Object.keys(topic)`.
 *
 * What this model does NOT do:
 *
 *   - It does not run business logic. The pipeline state
 *     transitions (draft → researching → extracting → …) are
 *     enforced by the topic service, which has the context to
 *     validate them against the caller's identity and the
 *     operation they are performing. The schema only knows the
 *     closed set of legal status values; it does not know which
 *     transitions are legal from which state.
 *
 *   - It does not enforce per-user uniqueness on `title`. A user
 *     may legitimately create two topics with the same title —
 *     for example, a rewrite under a different preset, or a
 *     duplicate they intend to edit before running. The plan's
 *     UI explicitly supports a "Duplicate" action that relies
 *     on this being allowed.
 *
 * Type unions vs. runtime enums:
 *
 *   The `TopicStatus`, `PresetName`, and `ProfileName` types in
 *   `shared/types` are string-literal union types, not runtime
 *   enums. A union type does not exist at runtime — it is erased
 *   by the compiler. To give Mongoose a runtime `enum` option
 *   for each field, this file declares an explicit array of the
 *   legal values. The three arrays are the ONLY runtime source
 *   of truth for what values are legal; if the union types in
 *   `shared/types` ever change, these arrays must be updated in
 *   the same commit or the schema and the types will drift. The
 *   pattern is intentionally verbose in exchange for being easy
 *   to grep and easy to audit against the shared types.
 */

import mongoose, { Schema, Document } from 'mongoose';
import {
  Topic,
  TopicStatus,
  PresetName,
  ProfileName,
} from '../../shared/types/index.js';

// ============================================================
//  Document interface
// ============================================================

/**
 * The runtime shape of a Topic document as returned by Mongoose.
 *
 * Extends `Omit<Topic, '_id'>` (the shared domain interface minus
 * its loosely-typed `_id`) and then re-declares `_id` with the
 * concrete ObjectId type Mongoose actually produces in-process.
 * This is the same pattern as `UserDocument` in
 * `features/auth/models/User.ts`: the shared domain type stays
 * transport-agnostic (its `_id` is `string | ObjectId` so it can
 * cross JSON boundaries), while the document interface pins
 * `_id` to what the ODM gives you.
 *
 * No instance methods are declared on this interface. Unlike the
 * User model — which needs a `comparePassword` method to keep
 * the bcrypt library out of the service layer — a Topic has no
 * per-document behaviour beyond what Mongoose provides out of the
 * box (save, validate, toJSON). Business logic lives in the
 * service.
 */
export interface TopicDocument extends Omit<Topic, '_id'>, Document {
  _id: mongoose.Types.ObjectId;
}

// ============================================================
//  Legal values (runtime counterparts of the union types)
// ============================================================
//
// Each array is annotated with its union type, which gives us a
// compile-time guarantee that every string in the array is a
// member of the union. A typo such as 'complete' instead of
// 'completed' would be flagged by tsc — the one class of drift
// this pattern is designed to catch. What it does NOT catch is a
// value MISSING from the array (a new union member added without
// a corresponding array update); that has to be caught by a
// reviewer or by an integration test that tries to save every
// legal status.

const TOPIC_STATUS_VALUES: TopicStatus[] = [
  'draft',
  'researching',
  'extracting',
  'extracted',
  'writing',
  'validating',
  'completed',
  'failed',
];

const PRESET_NAME_VALUES: PresetName[] = [
  'quick',
  'balanced',
  'deep',
  'custom',
];

const PROFILE_NAME_VALUES: ProfileName[] = [
  'blog-post',
  'news-article',
  'product-review',
  'academic',
];

// ============================================================
//  Schema
// ============================================================

const TopicSchema = new Schema<TopicDocument>(
  {
    // ---- Ownership ----
    // Every topic belongs to exactly one user. This field is the
    // anchor for every query and every authorization check: a
    // request may only read or mutate a topic where
    // `topic.userId === req.user.userId`. Indexed below as part
    // of both compound indexes.
    userId: {
      type: Schema.Types.ObjectId,
      required: [true, 'userId is required'],
    },

    // ---- User-supplied fields ----
    title: {
      type: String,
      required: [true, 'Title is required'],
      trim: true,
      minlength: [3, 'Title must be at least 3 characters.'],
      maxlength: [300, 'Title must be at most 300 characters.'],
    },

    // Keywords arrive as an array of strings. Mongoose will
    // attempt to cast each element to a string on write; a value
    // that cannot be cast throws a CastError, which the terminal
    // error middleware maps to a 400. The service layer is
    // expected to have already trimmed and filtered empty strings
    // before calling save — the schema accepts what it is given
    // rather than silently mutating the array, so a bug in the
    // service's sanitization is visible rather than masked.
    keywords: {
      type: [String],
      default: [],
    },

    // ---- Pipeline configuration ----
    preset: {
      type: String,
      enum: {
        values: PRESET_NAME_VALUES,
        message: 'Preset must be one of: quick, balanced, deep, custom.',
      },
      default: 'balanced',
      required: true,
    },
    profile: {
      type: String,
      enum: {
        values: PROFILE_NAME_VALUES,
        message:
          'Profile must be one of: blog-post, news-article, product-review, academic.',
      },
      default: 'blog-post',
      required: true,
    },
    promptFile: {
      type: String,
      default: 'default.md',
      trim: true,
      maxlength: [200, 'promptFile must be at most 200 characters.'],
    },
    wordCount: {
      type: Number,
      default: 1200,
      min: [100, 'wordCount must be at least 100.'],
      max: [10000, 'wordCount must be at most 10000.'],
      validate: {
        // The built-in Number type in Mongoose is a double. Word
        // counts are conceptually integers — a target of "1200.5
        // words" is meaningless and would only appear if a caller
        // passed a float by mistake. This validator catches that
        // at the schema boundary so no downstream consumer has to
        // think about rounding.
        validator: (value: number) => Number.isInteger(value),
        message: 'wordCount must be an integer.',
      },
    },
    sourceCount: {
      type: Number,
      default: 10,
      min: [1, 'sourceCount must be at least 1.'],
      max: [50, 'sourceCount must be at most 50.'],
      validate: {
        validator: (value: number) => Number.isInteger(value),
        message: 'sourceCount must be an integer.',
      },
    },

    // ---- Runtime status ----
    // The closed set of pipeline states. The schema validates
    // that the value is one of them; it does not enforce which
    // transitions between them are legal. That is the service's
    // job — see the file header.
    status: {
      type: String,
      enum: {
        values: TOPIC_STATUS_VALUES,
        message:
          'Status must be one of: draft, researching, extracting, ' +
          'extracted, writing, validating, completed, failed.',
      },
      default: 'draft',
      required: true,
    },

    // ---- Failure detail ----
    // Populated only when `status === 'failed'`. The schema does
    // not enforce that invariant — the service sets and clears
    // this field in step with the status transition. Bounded at
    // 2000 characters to match the truncation the pipeline
    // already applies to error messages before they reach this
    // field.
    error: {
      type: String,
      trim: true,
      maxlength: [2000, 'error must be at most 2000 characters.'],
    },
  },
  {
    timestamps: true,
    toJSON: {
      transform: (_doc, ret) => {
        delete ret['__v'];
        return ret;
      },
    },
  }
);

// ============================================================
//  Indexes
// ============================================================
//
//  Two compound indexes cover every read path the Topics page
//  exercises. Both are prefixed by `userId` because every query
//  on this collection is scoped to a single authenticated user;
//  a query across all users is not a supported operation, so an
//  index without the userId prefix would never be selected by
//  the query planner.
//
//    { userId: 1, createdAt: -1 }
//      Serves the default "list my topics, newest first" view.
//      The `-1` on createdAt means the sort is ascending-index /
//      descending-scan — the sort clause in the query does not
//      need a separate in-memory sort step.
//
//    { userId: 1, status: 1 }
//      Serves the "filter my topics by status" view, and by
//      extension the two-index intersection the planner picks
//      for "filter by status, sorted by createdAt": MongoDB 4.4+
//      can combine the two indexes rather than falling back to a
//      collection scan.
//
//  A third index on `{ userId: 1, title: 1 }` was considered for
//  the "search my topics by title substring" workflow and
//  deliberately not added: a leading-substring search is not an
//  indexed operation regardless of the index shape, and a full-
//  text index would force a different query structure on the
//  renderer side. If title search becomes a requirement, the
//  correct index is a text index on { title } with a compound
//  variant, and that is a decision for a future session.

TopicSchema.index({ userId: 1, createdAt: -1 });
TopicSchema.index({ userId: 1, status: 1 });

// ============================================================
//  Model
// ============================================================

export const TopicModel = mongoose.model<TopicDocument>('Topic', TopicSchema);

// ============================================================
//  Default export
// ============================================================

export default TopicModel;