/**
 * Mongoose model for the WriteSpeare AppVersion entity.
 *
 * An AppVersion is a published application release. The desktop
 * client's update checker reads the most recent document by
 * `createdAt` — that is the "latest version" — and compares it
 * against its own build version to decide whether an update is
 * available.
 *
 * This is the only system-wide entity in the codebase. Every
 * other model (User, Topic, Document, Article, Report,
 * UserSetting, Preset) carries a `userId` field and is scoped to
 * one user; a release is global — it applies to every user of the
 * application equally. The model therefore has NO `userId` field
 * and its read paths are NOT ownership-scoped. The only feature
 * that reads this collection is the public version endpoint
 * (`GET /api/version`), which is intentionally unauthenticated —
 * a client needs to know whether an update exists before it has
 * a session.
 *
 * Responsibilities:
 *
 *   1. Enforce the schema-level invariants of a release record:
 *      a semver-form `version` string, a URL-form `downloadUrl`,
 *      optional release notes and an optional `mandatory` flag.
 *
 *   2. Own the two indexes the version feature's read paths
 *      exercise:
 *
 *        - A UNIQUE index on `version`. A version string can be
 *          published at most once. If the release process is ever
 *          retried after a partial failure, a duplicate publish
 *          fails cleanly with a duplicate-key error rather than
 *          silently creating two records for the same version
 *          — which would leave the "latest by createdAt" query
 *          ambiguous about which record it means.
 *
 *        - A descending index on `createdAt`. The primary read
 *          path is "get the most recent release", which is
 *          `findOne().sort({ createdAt: -1 })`. The index makes
 *          this a single-record lookup with no collection scan.
 *
 *   3. Provide a single `toJSON` transform that strips Mongoose's
 *      `__v` version field, so a serialised AppVersion matches
 *      the shared `AppVersion` interface exactly.
 *
 * The `mandatory` flag:
 *
 *   When `true`, the desktop client is expected to block usage
 *   until the update is installed. When `false` or absent, the
 *   update is offered but the user may defer it. The flag is
 *   optional on the shared interface and defaults to `false` on
 *   the schema — the safe default for a release is "optional",
 *   because a mandatory release is a stronger claim that should
 *   be asserted explicitly, not arrived at by omission.
 *
 * The `releaseNotes` field:
 *
 *   Free-form Markdown, displayed in the client's update dialog.
 *   Optional — a hotfix release may have no user-facing notes.
 *   Bounded at 10,000 characters, which is generous for a release
 *   announcement (a long GitHub release body is a few thousand
 *   characters) and small enough that a runaway paste is rejected
 *   rather than stored.
 *
 * The `version` field format:
 *
 *   The schema enforces a semver-shaped string — one to four
 *   numeric segments separated by dots, with an optional
 *   pre-release suffix (`-alpha.1`, `-rc.2`) and an optional
 *   build metadata suffix (`+build.123`). This is the format the
 *   desktop client's own version parser expects (see
 *   `electron-updater`'s comparison rules), and enforcing it at
 *   the schema boundary means the client never has to handle a
 *   malformed version string from the backend.
 *
 *   The regex is deliberately permissive within that shape —
 *   `1.0.0`, `1.0.0-beta.1`, `2.10.3`, `0.1.0+build.42` all
 *   match. It is NOT permissive about prefixes (`v1.0.0` is
 *   rejected — the client stores versions without the `v`) or
 *   about non-numeric segments (`1.0.x` is rejected).
 *
 * What this model does NOT do:
 *
 *   - It does not enforce monotonic version ordering — a new
 *     record with a lower version string than an existing one
 *     is not rejected by the schema. The schema cannot perform
 *     that check (it would need to query other documents, which
 *     is out of scope for a schema validator); the correct place
 *     is the service's `createAppVersion`, which will compare
 *     the new version against the current latest. See the
 *     service file when it is created (File 41 in the plan
 *     sequence).
 *
 *   - It does not store a download URL per platform. The shared
 *     interface declares a single `downloadUrl` field, which is
 *     the correct shape for the current single-platform product
 *     (Windows only, one `.exe` per release). If multi-platform
 *     support arrives later, the correct change is to add a
 *     platform-keyed map alongside `downloadUrl`, not to change
 *     the existing field — that preserves backward compatibility
 *     with clients that only know about the single URL.
 *
 *   - It does not carry `userId`. See the file header for why.
 *     A future model that needs to scope a release to a user (a
 *     beta-testing channel, for example) would be a different
 *     entity, not a modification of this one.
 */

import mongoose, { Schema, Document as MongooseDocument } from 'mongoose';
import { AppVersion } from '../../shared/types/index.js';

// ============================================================
//  Document interface
// ============================================================

/**
 * The runtime shape of an AppVersion document as returned by
 * Mongoose.
 *
 * Extends `Omit<AppVersion, '_id'>` (the shared domain interface
 * minus its loosely-typed `_id`) and `MongooseDocument` (the
 * Mongoose base class), then re-declares `_id` with the concrete
 * ObjectId type Mongoose actually produces in-process. Same
 * pattern as every other model in this codebase.
 *
 * No instance methods are declared. An AppVersion has no
 * per-record behaviour beyond what Mongoose provides out of the
 * box (save, validate, toJSON). Business logic — comparing a new
 * version against the current latest, filtering releases by
 * channel — lives in the service.
 */
export interface AppVersionDocument
  extends Omit<AppVersion, '_id'>,
    MongooseDocument {
  _id: mongoose.Types.ObjectId;
}

// ============================================================
//  Version-string format
// ============================================================
//
// A semver-shaped string: one to four numeric segments separated
// by dots, with an optional pre-release suffix and an optional
// build-metadata suffix. See the file header for why this format
// is enforced at the schema boundary.
//
// The regex is compiled once at module load rather than inline in
// the validator, so the pattern object is shared across every
// validation call rather than reallocated per save.

const SEMVER_PATTERN =
  /^\d+(\.\d+){0,3}(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

// ============================================================
//  Schema
// ============================================================

const AppVersionSchema = new Schema<AppVersionDocument>(
  {
    // ---- Identity ----
    // The version string, unique across the collection. See the
    // file header for the format rationale and for why this field
    // is indexed as UNIQUE.
    version: {
      type: String,
      required: [true, 'version is required'],
      trim: true,
      match: [SEMVER_PATTERN, 'version must be a semver-form string.'],
      maxlength: [100, 'version must be at most 100 characters.'],
    },

    // ---- Distribution ----
    // The URL the desktop client downloads the installer from.
    // Validated with the WHATWG URL parser, the same check the
    // Document model uses for its source URL. The schema does not
    // restrict the scheme — a future release could ship via
    // `file://` for local testing or `s3://` if a signed-URL
    // service is added — so the check is only that the value
    // parses.
    downloadUrl: {
      type: String,
      required: [true, 'downloadUrl is required'],
      trim: true,
      maxlength: [2048, 'downloadUrl must be at most 2048 characters.'],
      validate: {
        validator: (value: string): boolean => {
          try {
            void new URL(value);
            return true;
          } catch {
            return false;
          }
        },
        message: 'downloadUrl must be a valid absolute URL.',
      },
    },

    // ---- Optional metadata ----
    releaseNotes: {
      type: String,
      trim: true,
      maxlength: [
        10000,
        'releaseNotes must be at most 10000 characters.',
      ],
    },
    mandatory: {
      type: Boolean,
      default: false,
      required: true,
    },
  },
  {
    timestamps: true,
    toJSON: {
      transform: (_doc, ret) => {
        // `__v` is Mongoose's internal version field. It is added
        // to every saved document automatically and is not part
        // of the shared `AppVersion` interface, so it must not
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
//  Two indexes cover the read and write paths the version feature
//  exercises.
//
//    { version: 1 } — UNIQUE
//      A version string can be published at most once. See the
//      file header for the rationale. Also serves any future
//      "find by version string" lookup as a single-record read.
//
//      Declared via an explicit `.index(...)` call with
//      `unique: true` rather than via `unique: true` on the field
//      definition, because the field-level form and the explicit
//      form are equivalent at the driver level, and the explicit
//      form makes the intent clearer when the schema also has
//      other indexes (which this one does).
//
//    { createdAt: -1 }
//      Serves the primary read path: "get the most recent
//      release", which is `findOne().sort({ createdAt: -1 })`.
//      A descending index means MongoDB can scan the index from
//      the top and stop at the first entry, without a collection
//      fetch and without an in-memory sort stage.
//
//  No compound index is needed. Unlike the user-scoped
//  collections, every query on this collection is global — there
//  is no `userId` to prefix an index with, and no filter other
//  than "the latest" or "this specific version string".

AppVersionSchema.index({ version: 1 }, { unique: true });
AppVersionSchema.index({ createdAt: -1 });

// ============================================================
//  Model
// ============================================================

export const AppVersionModel = mongoose.model<AppVersionDocument>(
  'AppVersion',
  AppVersionSchema
);

// ============================================================
//  Default export
// ============================================================

export default AppVersionModel;