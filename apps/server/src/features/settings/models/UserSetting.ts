/**
 * Mongoose model for the WriteSpeare UserSetting entity.
 *
 * A UserSetting document holds the per-user preferences that
 * apply across every topic a user works on: which preset a new
 * topic should start with, which profile, which prompt template,
 * the default time-bucketed search distribution, whether the
 * pipeline auto-saves after each stage, whether the user wants a
 * notification when a topic finishes, which theme the desktop UI
 * should render, and where the "Download bundle" flow saves its
 * output.
 *
 * The per-topic values (the keyword list, the word count, the
 * source count, the preset, the profile, the prompt file) live on
 * the `Topic` document itself — the UserSetting document holds
 * only the defaults a new topic is seeded with, plus the bucket
 * layout default, the two cross-cutting toggles (auto-save and
 * notifications), the theme preference, and the two bundle-
 * download preferences.
 *
 * Responsibilities:
 *
 *   1. Enforce the schema-level invariants of a settings record:
 *      a required `userId`, the fields of the embedded `settings`
 *      sub-document, and closed-set validation on the four fields
 *      whose values come from a string-literal union
 *      (`defaultPreset`, `defaultProfile`, `theme`, and
 *      `bundleDownloadMode`).
 *
 *   2. Enforce the one-document-per-user invariant via a unique
 *      index on `userId`. The service is expected to perform an
 *      upsert — find the user's settings, create if absent,
 *      update if present — and the unique index is the safety
 *      net that prevents a race between two concurrent reads
 *      from producing two settings documents for the same user.
 *      Without the index, a concurrent double-create would leave
 *      the second document as an orphan that the service would
 *      never read (its findOne would return the first), and the
 *      user's settings would diverge invisibly.
 *
 *   3. Provide a single `toJSON` transform that strips Mongoose's
 *      `__v` version field, so a serialised UserSetting matches
 *      the shared `UserSetting` interface exactly.
 *
 * Why the settings sub-document is embedded, not a top-level
 * object:
 *
 *   The shared `UserSetting` interface declares `settings` as a
 *   nested object of type `UserSettingsMap`. That nesting is not
 *   cosmetic — it exists so that a future addition (say, a new
 *   default field, or a new preference that spans multiple
 *   features) can be added to the settings map without changing
 *   the outer schema's shape. Mongoose's support for embedded
 *   sub-documents with `{ _id: false }` is exactly the mechanism
 *   that preserves the nesting without introducing an auto-
 *   generated ObjectId on the sub-document.
 *
 *   An alternative design — flattening the six fields to the top
 *   level of the schema — was rejected because it would break the
 *   shared type's shape and would make the eventual promotion of
 *   a new settings field a breaking change to the outer schema.
 *
 * Why the settings map is declared as a sub-schema constant:
 *
 *   The pattern matches the one established in `Report.ts` for
 *   the six validation sections: declare a standalone `Schema`
 *   constant, then embed it by reference in the top-level schema.
 *   The alternative — inlining the entire sub-schema as an object
 *   literal in the top-level definition — would make the top-
 *   level schema harder to read and would scatter the field-level
 *   validation rules across two locations.
 *
 * Defaults on every field:
 *
 *   Every field in the settings map has a default. This is
 *   deliberate: a freshly-created user should have working
 *   settings the moment their first request is served, without
 *   the service having to seed them explicitly or the controller
 *   having to handle the "settings not yet configured" case.
 *   The defaults are chosen to match the plan's documented
 *   product behaviour — 'balanced' preset, 'blog-post' profile,
 *   'default.md' prompt, auto-save on, notify on, light theme.
 *   A user who never opens the Settings page gets a fully
 *   functional app with sensible behaviour.
 *
 * What this model does NOT do:
 *
 *   - It does not enforce that the `defaultPromptFile` names a
 *     file that exists on disk. The desktop's Python scripts own
 *     the prompt file directory, and the backend has no way to
 *     read the local filesystem. The prompt picker in the
 *     desktop UI is responsible for validating that a user's
 *     chosen prompt file is one that exists; the model only
 *     stores the string.
 *
 *   - It does not link back to a `User` document by foreign key.
 *     Cross-collection referential integrity is the service
 *     layer's concern — the settings service validates the
 *     caller's identity from the authenticated session before
 *     reading or writing, exactly as the other feature services
 *     do. A model-level foreign key would require a pre-save
 *     hook that queries the users collection, which is
 *     unnecessary at this collection size.
 *
 *   - It does not track which fields the user has explicitly set
 *     versus which are defaults. That distinction is not needed
 *     by the current product — the settings document always
 *     holds the full effective settings for the user, and the
 *     UI shows the effective values as editable fields. If a
 *     future feature needs to distinguish "explicitly set" from
 *     "still default", the correct change is to add a parallel
 *     `overrides` map, not to change this document's shape.
 */

import mongoose, { Schema, Document as MongooseDocument } from 'mongoose';
import {
  UserSetting,
  PresetName,
  ProfileName,
} from '../../shared/types/index.js';

// ============================================================
//  Document interface
// ============================================================

/**
 * The runtime shape of a UserSetting document as returned by
 * Mongoose.
 *
 * Extends `Omit<UserSetting, '_id'>` (the shared domain
 * interface minus its loosely-typed `_id`) and `MongooseDocument`
 * (the Mongoose base class), then re-declares `_id` with the
 * concrete ObjectId type Mongoose actually produces in-process.
 * Same pattern as `UserDocument`, `TopicDocument`,
 * `DocumentDocument`, `ArticleDocument`, and `ReportDocument`.
 *
 * No instance methods are declared. A UserSetting has no per-
 * record behaviour beyond what Mongoose provides out of the box
 * (save, validate, toJSON). Business logic — applying defaults on
 * first read, merging a partial update from the settings page —
 * lives in the service.
 */
export interface UserSettingDocument
  extends Omit<UserSetting, '_id'>,
    MongooseDocument {
  _id: mongoose.Types.ObjectId;
}

// ============================================================
//  Legal values (runtime counterparts of the union types)
// ============================================================
//
// Each array is annotated with its union type, which gives a
// compile-time guarantee that every string is a legal member. A
// typo would be a type error, not a silent runtime surprise.
//
// The `theme` union is declared inline as a readonly tuple
// because the shared types module does not export a named type
// for it — the `UserSettingsMap.theme` field uses the inline
// union `'light' | 'dark'` directly. The tuple is structurally
// equivalent to the union and satisfies the same check.

const PRESET_VALUES: readonly PresetName[] = [
  'quick',
  'balanced',
  'deep',
  'custom',
];

const PROFILE_VALUES: readonly ProfileName[] = [
  'blog-post',
  'news-article',
  'product-review',
  'academic',
];

const THEME_VALUES: readonly ['light', 'dark'] = ['light', 'dark'];

// The two modes for the "Download bundle" flow. `'ask'` opens a
// Save-As dialog on every download; `'default'` writes silently
// to the path stored in `bundleDownloadPath`. Declared as an
// inline readonly tuple because the shared types module does not
// export a named type for this union — the
// `UserSettingsMap.bundleDownloadMode` field uses the inline
// union `'ask' | 'default'` directly.
const BUNDLE_DOWNLOAD_MODE_VALUES: readonly ['ask', 'default'] = [
  'ask',
  'default',
];


// ============================================================
//  Settings sub-schema
// ============================================================
//
//  Declared as a standalone `Schema` constant with `{ _id: false }`
//  so Mongoose does not auto-generate an `_id` on the embedded
//  sub-document. The sub-schema is embedded by reference in the
//  top-level schema below.

// ---- Default bucket layout ----
// The four time-range buckets a user's new topics default to.
// Each value is the number of candidates the search step collects
// for that specific time range; a value of zero means the bucket
// is skipped entirely (per the plan's Q8.3 decision). The four
// values sum to `sourceCount` on any topic created from this
// layout.
//
// Declared as a standalone `Schema` with `{ _id: false }` so
// Mongoose does not auto-generate an `_id` on the embedded sub-
// document. Same pattern the top-level `settings` map uses, and
// the same pattern the Report model uses for its six section
// sub-schemas.
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


const UserSettingsMapSchema = new Schema(
  {
    defaultPreset: {
      type: String,
      enum: {
        values: PRESET_VALUES,
        message:
          'defaultPreset must be one of: quick, balanced, deep, custom.',
      },
      default: 'balanced',
      required: true,
    },
    defaultProfile: {
      type: String,
      enum: {
        values: PROFILE_VALUES,
        message:
          'defaultProfile must be one of: blog-post, news-article, ' +
          'product-review, academic.',
      },
      default: 'blog-post',
      required: true,
    },
    defaultPromptFile: {
      type: String,
      default: 'default.md',
      trim: true,
      minlength: [1, 'defaultPromptFile must not be empty.'],
      maxlength: [200, 'defaultPromptFile must be at most 200 characters.'],
    },

        // ---- Default bucket layout ----
    // The user's default time-bucketed search distribution, used
    // to seed a new topic when no preset is applied (per the
    // plan's Item 3 / C2 decision). The four values correspond to
    // the four time ranges the search step queries; a value of
    // zero means the bucket is skipped. The sum of the four
    // values is what `sourceCount` materialises to on a topic
    // created from this default.
    //
    // The default (4, 2, 2, 2) matches the Balanced preset's
    // 10-source bucket split, so a user who never opens the
    // Settings page gets the same distribution a Balanced topic
    // would produce.
    defaultBucketLayout: {
      type: DefaultBucketLayoutSchema,
      required: true,
      default: () => ({
        anyTime: 4,
        pastYear: 2,
        pastMonth: 2,
        pastWeek: 2,
      }),
    },
    autoSaveAfterEachStage: {
      type: Boolean,
      default: true,
      required: true,
    },
    notifyOnCompletion: {
      type: Boolean,
      default: true,
      required: true,
    },
    theme: {
      type: String,
      enum: {
        values: THEME_VALUES,
        message: 'theme must be one of: light, dark.',
      },
      default: 'light',
      required: true,
    },

        // ---- Bundle download ----
    // Where the "Download bundle" flow writes the topic's archive
    // ZIP. `'ask'` opens a Save-As dialog on every download so the
    // user picks the location each time; `'default'` writes
    // silently to `bundleDownloadPath`. The path is only consulted
    // when the mode is `'default'`; an empty path in that mode is
    // a configuration error the service is expected to catch.
    bundleDownloadMode: {
      type: String,
      enum: {
        values: BUNDLE_DOWNLOAD_MODE_VALUES,
        message: 'bundleDownloadMode must be one of: ask, default.',
      },
      default: 'ask',
      required: true,
    },
    bundleDownloadPath: {
      type: String,
      default: '',
      trim: true,
      maxlength: [
        500,
        'bundleDownloadPath must be at most 500 characters.',
      ],
    },
  },
  { _id: false }
);

// ============================================================
//  Top-level schema
// ============================================================

const UserSettingSchema = new Schema<UserSettingDocument>(
  {
    // ---- Ownership ----
    // Every settings document belongs to exactly one user. The
    // unique index declared below enforces the one-to-one
    // relationship — a user cannot have two settings documents.
    userId: {
      type: Schema.Types.ObjectId,
      required: [true, 'userId is required'],
      unique: true,
    },

    // ---- Preferences ----
    // The embedded settings sub-document. The sub-schema declared
    // above carries the field-level validation and defaults; the
    // entry here only wires the sub-schema in by reference.
    settings: {
      type: UserSettingsMapSchema,
      required: true,
      // Provide an empty-object default so that a document created
      // with only a `userId` (the common case on first read) is
      // valid: Mongoose applies the sub-schema's field-level
      // defaults to the empty object, producing a settings map
      // populated with the plan's documented product defaults.
      default: () => ({}),
    },
  },
  {
    timestamps: true,
    toJSON: {
      transform: (_doc, ret) => {
        // `__v` is Mongoose's internal version field. It is added
        // to every saved document automatically and is not part of
        // the shared `UserSetting` interface, so it must not
        // appear in the JSON response.
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
//  The unique index on `userId` is created implicitly by the
//  `unique: true` option on the field itself, so it is not
//  re-declared here. Its purpose is twofold:
//
//    (a) Guarantee the one-to-one relationship at the database
//        level. Even if two concurrent requests both find "no
//        settings for this user" and both attempt to create a
//        document, the second insert fails with a duplicate-key
//        error rather than producing an orphan record.
//
//    (b) Serve the primary read path — `findOne({ userId })` —
//        as a single index-covered lookup with no collection
//        scan.
//
//  No additional indexes are needed. Every query on this
//  collection is scoped to exactly one user, and the unique
//  index on `userId` is the only access path the service
//  exercises.

// ============================================================
//  Model
// ============================================================

export const UserSettingModel = mongoose.model<UserSettingDocument>(
  'UserSetting',
  UserSettingSchema
);

// ============================================================
//  Default export
// ============================================================

export default UserSettingModel;