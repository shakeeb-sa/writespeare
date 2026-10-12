/**
 * Business logic for the WriteSpeare settings feature.
 *
 * Two related entities live under this one feature folder because
 * they share a controller and a route table in the plan's file
 * tree, and because they are always consumed together:
 *
 *   UserSetting — the per-user preferences that apply across
 *                 every topic a user works on. Exactly one
 *                 settings document per user, enforced by a
 *                 unique index on `userId`.
 *
 *   Preset      — a named bundle of pipeline settings. Three
 *                 system presets ship with the app (Quick,
 *                 Balanced, Deep) and are visible to every user;
 *                 a user can also save their own presets, which
 *                 are visible only to them.
 *
 * The service exposes seven ownership-scoped operations:
 *
 *   getUserSettings       — read the caller's settings, creating
 *                           them with defaults on first read
 *   updateUserSettings    — partial update of the caller's
 *                           settings
 *   listPresets           — list every preset visible to the
 *                           caller (system presets plus the
 *                           caller's own)
 *   getPresetById         — read one preset (system or owned)
 *   createPreset          — create a preset owned by the caller
 *   updatePreset          — update a preset the caller owns
 *   deletePreset          — delete a preset the caller owns
 *
 * The upsert-on-read behaviour of getUserSettings:
 *
 *   A user who has never opened the Settings page has no
 *   UserSetting document in the database. Rather than requiring
 *   every caller to handle the "settings not yet configured"
 *   case, `getUserSettings` performs a `findOneAndUpdate` with
 *   `upsert: true` — if the document exists, it is returned
 *   unchanged; if not, a new one is created with the schema's
 *   defaults applied and returned. The operation is idempotent,
 *   so calling it concurrently from two requests produces the
 *   same result — the unique index on `userId` guarantees that
 *   only one of the two racing inserts can succeed, and the
 *   losing caller receives the document the winner created.
 *
 *   The `$setOnInsert: { userId }` clause ensures the filter's
 *   userId field is written into the new document; without it,
 *   MongoDB would apply the schema defaults but leave the userId
 *   unset, which the schema would then reject.
 *
 * The preset visibility and authorization rules:
 *
 *   Read visibility — `listPresets` and `getPresetById` accept
 *   presets whose `userId` is `null` (system presets) OR equal
 *   to the caller's own userId. A preset owned by a different
 *   user is invisible — it is filtered out of list results by
 *   the list query, and `getPresetById` returns null for it
 *   (which the controller converts to a 404, not a 403, to
 *   avoid leaking the existence of other users' presets).
 *
 *   Write authorization — `updatePreset` and `deletePreset`
 *   filter on `{ _id, userId }` WITHOUT the `$or` branch that
 *   the read paths use. This is what forbids a caller from
 *   modifying or deleting a system preset: a system preset has
 *   `userId: null`, which never matches the caller's ObjectId,
 *   so the write filter matches zero documents and the service
 *   throws a 404. A user CAN shadow a system preset by creating
 *   their own preset with the same name; the two coexist
 *   because they have different userIds.
 *
 * Why `createPreset` cannot create a system preset:
 *
 *   The plan's product model is that system presets are seeded
 *   by the app — a seeder creates the three built-in presets
 *   once, and they are never created through the API. The
 *   service enforces this by always setting `userId` to the
 *   caller's ObjectId, never accepting it from the payload. A
 *   client that wanted to create a system preset would need a
 *   separate admin-only endpoint, which the plan does not
 *   describe, and which would be the wrong place to put this
 *   logic anyway.
 *
 * Cross-field validation:
 *
 *   Two cross-field constraints are deliberately NOT enforced by
 *   the Preset schema and are also NOT enforced here, in
 *   keeping with the plan's product decision to keep the service
 *   as thin as the schema permits:
 *
 *   - `maxKeywordDensity >= minKeywordDensity`. A preset that
 *     violated this would be internally inconsistent but not
 *     dangerous — the Python validator would simply flag every
 *     keyword against the same threshold. The user-facing
 *     consequence is a validation report that always reads
 *     "below minimum" and never "above maximum". The preset
 *     editor in the desktop UI prevents the configuration from
 *     being saved in this state; the backend is not the load-
 *     bearing guard.
 *
 *   - `autoRegenerate === true` implies `maxRegenerationAttempts
 *     >= 1`. Same reasoning — the desktop UI prevents the
 *     contradictory state, and a preset that reached the backend
 *     with it would simply produce zero regeneration attempts
 *     and a report the user could still export.
 *
 *   If a future requirement needs the backend to be the
 *   authoritative guard on either constraint, the correct place
 *   to add it is here, in a pre-save check inside `createPreset`
 *   and `updatePreset`. The file header records the decision so
 *   it is not mistaken for an oversight.
 */

import {
  UserSettingModel,
  type UserSettingDocument,
} from '../models/UserSetting.js';
import { PresetModel, type PresetDocument } from '../models/Preset.js';
import type {
  MongoId,
  UserSettingsMap,
  PresetCreatePayload,
} from '../../shared/types/index.js';
import { AppError } from '../../shared/middleware/errorHandler.js';

// ============================================================
//  Local payload types
// ============================================================
//
// The shared types module declares `UserSettingsMap` (all fields
// required) but does not declare a dedicated update-payload
// interface for it. The update-payload shape is trivially
// `Partial<UserSettingsMap>` — every field optional, so a caller
// can send a patch containing any subset. The alias is exported
// so the controller can import it from this service without
// re-deriving it.
//
// The Preset update payload is likewise not declared in
// shared/types. Its shape is `Partial<PresetCreatePayload>` for
// the same reason. That one is NOT exported as a named alias
// because it appears in exactly one place — the `updatePreset`
// signature — and a one-off alias for a single use adds surface
// without benefit.

export type UserSettingsUpdatePayload = Partial<UserSettingsMap>;

// ============================================================
//  Bucket-layout helpers
// ============================================================
//
//  `defaultBucketLayout` is the primary count field on a preset
//  (per the C2 decision — the bucket layout is the single source
//  of truth for "how many sources to collect"). The preset's
//  `sourceCount` field is a materialised aggregate of the four
//  bucket counts, kept in sync with the layout by the helpers
//  below.
//
//  The same four-bucket shape is used by `Topic.searchBuckets`
//  and by the `defaultBucketLayout` field on `UserSettingsMap`.
//  Deriving the local type alias from the imported
//  `PresetCreatePayload` keeps the three declarations in
//  lockstep — a change to the shared type propagates here
//  automatically, rather than requiring a matching edit in a
//  locally-declared interface that would silently drift.

/**
 * The four time-range buckets a preset's default search
 * distribution is expressed as.
 *
 * Derived from `PresetCreatePayload['defaultBucketLayout']` so the
 * shape here cannot drift from the shape the shared types module
 * declares. If the shared declaration ever changes — a fifth
 * bucket, a rename of one of the four — the compiler reports it at
 * every call site in this file rather than letting this alias
 * quietly disagree with the wire contract.
 */
type BucketLayout = PresetCreatePayload['defaultBucketLayout'];

/**
 * Compute a preset's `sourceCount` from its `defaultBucketLayout`.
 *
 * The sum of the four bucket counts is the total number of sources
 * the preset instructs the search step to collect. Per the C2
 * decision, this derived value is what gets persisted on the
 * preset — never a separately-supplied count — so the two fields
 * cannot drift on disk.
 */
const deriveSourceCount = (layout: BucketLayout): number =>
  layout.anyTime +
  layout.pastYear +
  layout.pastMonth +
  layout.pastWeek;

/**
 * Synthesize an even-split `defaultBucketLayout` from a bare
 * `sourceCount`.
 *
 * Used only on the legacy fallback path where a caller provides a
 * `sourceCount` without a `defaultBucketLayout` — an older API
 * client, or a small UI that has not yet been updated to expose
 * the four buckets. The count is split evenly across the four
 * buckets, with any remainder placed on `anyTime`, so the four
 * bucket counts always sum to the caller's number and the
 * `sourceCount === sum of bucket counts` invariant holds on the
 * persisted document.
 *
 * The same derivation rule is used by the migration script
 * (`0001_add_bucket_layout.py`) when synthesizing a bucket layout
 * for legacy preset and topic records that predate the four-bucket
 * schema. Keeping the two implementations identical means a legacy
 * record migrated by the script and a legacy record updated by
 * this function end up with the same bucket layout for the same
 * source count.
 */
const synthesizeBucketLayout = (sourceCount: number): BucketLayout => {
  const per = Math.floor(sourceCount / 4);
  const remainder = sourceCount - per * 4;
  return {
    anyTime: per + remainder,
    pastYear: per,
    pastMonth: per,
    pastWeek: per,
  };
};

// ============================================================
//  getUserSettings
// ============================================================

/**
 * Read the authenticated user's settings, creating them with
 * schema defaults if they do not yet exist.
 *
 * The upsert is performed via a single `findOneAndUpdate` with
 * `upsert: true`. This is atomic at the database level — two
 * concurrent calls from the same user both resolve to the same
 * settings document, and the unique index on `userId` guarantees
 * that the second insert cannot produce a duplicate.
 *
 * The `$setOnInsert: { userId }` clause is required: without it,
 * MongoDB would apply the schema's field defaults to the new
 * document but would not populate the filter's `userId` field,
 * and the resulting document would fail the schema's `required`
 * validation on save.
 *
 * The `setDefaultsOnInsert: true` option is what makes the
 * schema's defaults fire on the upsert path. Without it, the
 * `settings` sub-document would be created empty and the
 * field-level defaults inside it would not run.
 *
 * Returns the settings document. The function is idempotent —
 * calling it twice in a row produces the same result and does
 * not modify the document on the second call.
 *
 * @param userId - Ownership value, derived from the authenticated
 *                  session by the controller.
 */
export const getUserSettings = async (
  userId: MongoId
): Promise<UserSettingDocument> => {
  const settings = await UserSettingModel.findOneAndUpdate(
    { userId },
    { $setOnInsert: { userId } },
    {
      upsert: true,
      new: true,
      setDefaultsOnInsert: true,
    }
  );

  // `findOneAndUpdate` with `upsert: true` and `new: true` is
  // documented to always return a document, but its TypeScript
  // signature still returns `T | null` — the compiler cannot
  // know that the upsert option guarantees non-null. The guard
  // is defensive: if it ever fires, the database is in a state
  // this service cannot recover from (the upsert was silently
  // rejected), and a 500 is the correct response.
  if (!settings) {
    throw new AppError('Failed to load settings.', 500);
  }

  return settings;
};

// ============================================================
//  updateUserSettings
// ============================================================

/**
 * Apply a partial update to the authenticated user's settings,
 * creating the document with defaults if it does not yet exist.
 *
 * Every field in the patch is optional. Fields omitted from the
 * patch are left unchanged. A patch with no fields is a valid
 * no-op — the function returns the current settings without
 * modifying anything.
 *
 * The update is expressed as a `$set` on dotted paths
 * (`settings.<field>`), rather than a full replacement of the
 * `settings` sub-document. This is what makes the operation
 * partial: MongoDB merges the `$set` fields into the existing
 * sub-document, leaving every other field untouched. A full
 * replacement would require reading the current settings first
 * and would introduce a race between the read and the write.
 *
 * The `runValidators: true` option is set so the schema's
 * per-field validation runs on the update, even though the
 * controller has already narrowed each field's type. Belt-and-
 * braces: the schema is the authoritative validator, and any
 * future caller of this service benefits from the check.
 *
 * The `upsert: true` and `setDefaultsOnInsert: true` options
 * mirror `getUserSettings` — a user who has never opened the
 * Settings page but sends an update directly (via the API, not
 * the UI) gets their settings document created with defaults,
 * and the patch is applied on top. The desktop UI does not do
 * this, but the API should not require the UI's cooperation to
 * produce a valid state.
 *
 * @param userId - Ownership value.
 * @param patch  - A partial settings map. Only the fields present
 *                  in the patch are modified.
 */
export const updateUserSettings = async (
  userId: MongoId,
  patch: UserSettingsUpdatePayload
): Promise<UserSettingDocument> => {
  // ---- Build the $set object from the patch ----
  // Each field is checked for presence explicitly rather than via
  // iteration, because `exactOptionalPropertyTypes` treats each
  // optional field as a distinct type (`PresetName | undefined`,
  // `string | undefined`, etc.) and an iteration would need a
  // per-field cast to recover the correct type. The explicit
  // form is more verbose but keeps every field's type intact
  // from the caller's perspective.
  //
  // The dotted-path form (`settings.<field>`) is what allows
  // MongoDB to merge the patch into the existing sub-document
  // rather than replace it.
  const setObj: Record<string, unknown> = {};

  if (patch.defaultPreset !== undefined) {
    setObj['settings.defaultPreset'] = patch.defaultPreset;
  }
  if (patch.defaultProfile !== undefined) {
    setObj['settings.defaultProfile'] = patch.defaultProfile;
  }
  if (patch.defaultPromptFile !== undefined) {
    setObj['settings.defaultPromptFile'] = patch.defaultPromptFile;
  }
  if (patch.autoSaveAfterEachStage !== undefined) {
    setObj['settings.autoSaveAfterEachStage'] =
      patch.autoSaveAfterEachStage;
  }
  if (patch.notifyOnCompletion !== undefined) {
    setObj['settings.notifyOnCompletion'] = patch.notifyOnCompletion;
  }
  if (patch.theme !== undefined) {
    setObj['settings.theme'] = patch.theme;
  }
  if (patch.defaultBucketLayout !== undefined) {
    setObj['settings.defaultBucketLayout'] = patch.defaultBucketLayout;
  }
  if (patch.bundleDownloadMode !== undefined) {
    setObj['settings.bundleDownloadMode'] = patch.bundleDownloadMode;
  }
  if (patch.bundleDownloadPath !== undefined) {
    setObj['settings.bundleDownloadPath'] = patch.bundleDownloadPath;
  }

  // ---- Empty-patch short circuit ----
  // A patch with no recognized fields is a no-op. Calling the
  // database with an empty `$set` is legal (MongoDB treats it as
  // "nothing to do") but the response would still be correct,
  // so skipping the round trip is a pure optimization. It also
  // makes the function's behaviour more predictable for a caller
  // that inspects the return value: the same settings object is
  // returned whether the patch was empty or full.
  if (Object.keys(setObj).length === 0) {
    return await getUserSettings(userId);
  }

  // ---- Perform the update ----
  const settings = await UserSettingModel.findOneAndUpdate(
    { userId },
    { $set: setObj },
    {
      upsert: true,
      new: true,
      setDefaultsOnInsert: true,
      runValidators: true,
    }
  );

  if (!settings) {
    // Same defensive guard as `getUserSettings` — an upsert that
    // returns null indicates a database-level failure the service
    // cannot recover from.
    throw new AppError('Failed to update settings.', 500);
  }

  return settings;
};

// ============================================================
//  listPresets
// ============================================================

/**
 * List every preset visible to the caller: all system presets
 * (`userId: null`) plus the caller's own presets. Presets owned
 * by other users are excluded.
 *
 * Sort order is `createdAt` ascending — the three system presets
 * appear in the order they were seeded, and the user's own
 * presets appear in the order they were created. This matches
 * the preset picker's expectation: the built-in three at the
 * top, the user's customisations below them in chronological
 * order.
 *
 * Sort is served by the compound index `{ userId, createdAt: -1 }`
 * — the sort direction does not have to match the index direction
 * for the index to be used; MongoDB can scan the index in reverse.
 *
 * Returns an array. A user with no custom presets and no system
 * presets seeded yet (a fresh install) receives an empty array.
 *
 * @param userId - Ownership value.
 */
export const listPresets = async (
  userId: MongoId
): Promise<PresetDocument[]> => {
  return await PresetModel.find({
    $or: [{ userId: null }, { userId }],
  }).sort({ createdAt: 1 });
};

// ============================================================
//  getPresetById
// ============================================================

/**
 * Read a single preset by id, scoped to the caller's visibility
 * rules.
 *
 * Returns `null` when the preset does not exist, OR when it
 * exists but is owned by a different user. A system preset
 * (`userId: null`) is always readable. The two "not visible"
 * cases collapse to the same null — the caller (the controller)
 * converts it to a 404, never a 403, so an authenticated user
 * cannot enumerate other users' preset IDs by probing the
 * endpoint and watching for a status-code change.
 *
 * A malformed id string — one that is not a valid ObjectId —
 * causes Mongoose to throw a CastError, which the terminal
 * middleware maps to a 400.
 *
 * @param userId   - Ownership value.
 * @param presetId - The preset's id, as a string from the route
 *                   parameter.
 */
export const getPresetById = async (
  userId: MongoId,
  presetId: string
): Promise<PresetDocument | null> => {
  return await PresetModel.findOne({
    _id: presetId,
    $or: [{ userId: null }, { userId }],
  });
};

// ============================================================
//  createPreset
// ============================================================

/**
 * Create a preset owned by the caller. The payload is expected
 * to conform to `PresetCreatePayload` — every field except
 * `userId` (which is derived from the authenticated session)
 * and the timestamps (which Mongoose assigns).
 *
 * A user can create a preset whose `name` shadows a system
 * preset's name — the compound unique index on `{ userId, name }`
 * allows `(null, 'quick')` and `(someObjectId, 'quick')` to
 * coexist. This is the intended behaviour: a user who wants
 * their own tuned variant of "quick" can simply name it that,
 * and their variant is the one the picker shows them for topics
 * they create.
 *
 * A duplicate name within the caller's own preset set produces
 * a Mongo duplicate-key error (code 11000), which the terminal
 * middleware maps to a 409 with a "Duplicate value for field
 * ..." message. The service does not pre-check for a collision —
 * doing so would introduce a race between the check and the
 * insert, and the unique index is the authoritative guard.
 *
 * @param userId  - Ownership value.
 * @param payload - The preset's configuration. Every field
 *                  required by `PresetCreatePayload` is expected;
 *                  `userId` is derived here, not read from the
 *                  payload.
 */
export const createPreset = async (
  userId: MongoId,
  payload: PresetCreatePayload
): Promise<PresetDocument> => {
  // The payload's fields are copied into the document, and
  // `userId` is set from the authenticated session. The payload
  // type does not include a `userId` field, so there is no risk
  // of the caller's value overriding the session value — the
  // compiler enforces that.
  //
  // `sourceCount` is ALWAYS derived from `defaultBucketLayout`,
  // overriding whatever value the payload carried. Per the C2
  // decision, the bucket layout is the single source of truth
  // for "how many sources to collect", and `sourceCount` is a
  // materialised aggregate of it. A caller that sends a
  // `sourceCount` that does not match the sum of its
  // `defaultBucketLayout` gets the layout's sum, not the
  // caller's number — the alternative would let the two fields
  // drift on the persisted document.
  const sourceCount = deriveSourceCount(payload.defaultBucketLayout);
  const doc = new PresetModel({
    ...payload,
    sourceCount,
    userId,
  });

  return await doc.save();
};

// ============================================================
//  updatePreset
// ============================================================

/**
 * Apply a partial update to a preset the caller owns. System
 * presets (`userId: null`) are NOT updatable through this
 * function — the write filter is `{ _id, userId }`, which
 * matches only the caller's own presets.
 *
 * Every field in the patch is optional. Fields omitted from the
 * patch are left unchanged. A patch with no actionable fields
 * returns the current document unchanged, without a database
 * write.
 *
 * The `name` field is deliberately not included in the
 * updatable set. A preset's name is its identity within the
 * user's scope and is the key the compound unique index uses;
 * renaming would require a second uniqueness check and would
 * change the preset's URL identity from the client's
 * perspective. A user who wants a differently-named preset can
 * delete this one and create a new one — the operation is
 * cheap and unambiguous.
 *
 * Returns the updated document, so the caller can reflect the
 * new state without a second read.
 *
 * Throws `AppError(404)` when the preset does not exist, when
 * it is owned by a different user, OR when it is a system preset
 * (because the write filter excludes the system scope). All
 * three cases collapse to the same 404 for the same enumeration-
 * safety reason.
 *
 * @param userId   - Ownership value.
 * @param presetId - The preset's id.
 * @param patch    - A partial set of the preset's configuration
 *                    fields. `name` and `userId` are not
 *                    updatable and are not accepted.
 */
export const updatePreset = async (
  userId: MongoId,
  presetId: string,
  patch: Partial<PresetCreatePayload>
): Promise<PresetDocument> => {
  // ---- Build the $set object from the patch ----
  // Only the fields that are present in the patch and are in the
  // updatable set are copied. `name` and `displayName` are
  // intentionally excluded — see the docstring above for the
  // rationale on `name`. `displayName` is included below: the
  // user can rename the human-readable label without changing
  // the underlying slug.
  const setObj: Record<string, unknown> = {};

  if (patch.displayName !== undefined) {
    setObj['displayName'] = patch.displayName;
  }
  // `defaultBucketLayout` and `sourceCount` are handled together,
  // in that order, so that the bucket layout wins whenever both
  // are present. Per the C2 decision, the bucket layout is the
  // single source of truth for "how many sources to collect", so
  // when both fields are present `sourceCount` is derived from
  // the layout and the caller's raw count is ignored. When only
  // `sourceCount` is present — a legacy caller, or a UI that does
  // not yet expose the four buckets — a bucket layout is
  // synthesized as an even split with the remainder on `anyTime`,
  // keeping the invariant `sourceCount === sum of the four bucket
  // counts` intact on the persisted document.
  if (patch.defaultBucketLayout !== undefined) {
    setObj['defaultBucketLayout'] = patch.defaultBucketLayout;
    setObj['sourceCount'] = deriveSourceCount(patch.defaultBucketLayout);
  } else if (patch.sourceCount !== undefined) {
    setObj['defaultBucketLayout'] = synthesizeBucketLayout(
      patch.sourceCount
    );
    setObj['sourceCount'] = patch.sourceCount;
  }
  if (patch.wordCount !== undefined) {
    setObj['wordCount'] = patch.wordCount;
  }
  if (patch.searchEngines !== undefined) {
    setObj['searchEngines'] = patch.searchEngines;
  }
  if (patch.resultsPerPage !== undefined) {
    setObj['resultsPerPage'] = patch.resultsPerPage;
  }

  if (patch.pageLoadTimeout !== undefined) {
    setObj['pageLoadTimeout'] = patch.pageLoadTimeout;
  }
  if (patch.maxRetries !== undefined) {
    setObj['maxRetries'] = patch.maxRetries;
  }
  if (patch.targetReadingGrade !== undefined) {
    setObj['targetReadingGrade'] = patch.targetReadingGrade;
  }
  if (patch.minKeywordDensity !== undefined) {
    setObj['minKeywordDensity'] = patch.minKeywordDensity;
  }
  if (patch.maxKeywordDensity !== undefined) {
    setObj['maxKeywordDensity'] = patch.maxKeywordDensity;
  }
  if (patch.maxTfidfSimilarity !== undefined) {
    setObj['maxTfidfSimilarity'] = patch.maxTfidfSimilarity;
  }
  if (patch.maxSemanticSimilarity !== undefined) {
    setObj['maxSemanticSimilarity'] = patch.maxSemanticSimilarity;
  }
  if (patch.maxAiMarkers !== undefined) {
    setObj['maxAiMarkers'] = patch.maxAiMarkers;
  }
  if (patch.runReadabilityCheck !== undefined) {
    setObj['runReadabilityCheck'] = patch.runReadabilityCheck;
  }
  if (patch.runSeoCheck !== undefined) {
    setObj['runSeoCheck'] = patch.runSeoCheck;
  }
  if (patch.runOriginalityCheck !== undefined) {
    setObj['runOriginalityCheck'] = patch.runOriginalityCheck;
  }
  if (patch.runAiMarkerCheck !== undefined) {
    setObj['runAiMarkerCheck'] = patch.runAiMarkerCheck;
  }
  if (patch.runGrammarCheck !== undefined) {
    setObj['runGrammarCheck'] = patch.runGrammarCheck;
  }
  if (patch.autoRegenerate !== undefined) {
    setObj['autoRegenerate'] = patch.autoRegenerate;
  }
  if (patch.maxRegenerationAttempts !== undefined) {
    setObj['maxRegenerationAttempts'] = patch.maxRegenerationAttempts;
  }

  // ---- Empty-patch short circuit ----
  // A patch with no actionable fields is a no-op: read the
  // existing document and return it, without a database write.
  // The read is still ownership-scoped — a caller who provides
  // no fields but targets someone else's preset still gets a 404,
  // matching the behaviour of the write path.
  if (Object.keys(setObj).length === 0) {
    const existing = await PresetModel.findOne({
      _id: presetId,
      userId,
    });
    if (!existing) {
      throw new AppError('Preset not found.', 404);
    }
    return existing;
  }

  // ---- Perform the update ----
  // The filter `{ _id, userId }` deliberately does NOT include
  // the `$or: [{ userId: null }, ...]` branch that the read
  // paths use. This is what forbids a caller from updating a
  // system preset — the system preset's `userId: null` never
  // matches the caller's ObjectId.
  const updated = await PresetModel.findOneAndUpdate(
    { _id: presetId, userId },
    { $set: setObj },
    { new: true, runValidators: true }
  );

  if (!updated) {
    throw new AppError('Preset not found.', 404);
  }

  return updated;
};

// ============================================================
//  deletePreset
// ============================================================

/**
 * Delete a preset the caller owns. System presets
 * (`userId: null`) are NOT deletable through this function —
 * the delete filter is `{ _id, userId }`, which matches only
 * the caller's own presets.
 *
 * Returns the deleted document so the caller can log or display
 * what was removed. Presets have no children — deleting a preset
 * does not affect any topic or article that was previously
 * configured with it, because the pipeline copies the preset's
 * values onto the Topic document at creation time (see the
 * Topic model's `preset`, `profile`, `promptFile`, `wordCount`,
 * and `sourceCount` fields). A user who deletes a preset and
 * later wants its behaviour back can recreate it from the
 * values on any topic that used it.
 *
 * Throws `AppError(404)` when the preset does not exist, when
 * it is owned by a different user, OR when it is a system
 * preset. Same collapsing rule as `updatePreset`.
 *
 * @param userId   - Ownership value.
 * @param presetId - The preset's id.
 */
export const deletePreset = async (
  userId: MongoId,
  presetId: string
): Promise<PresetDocument> => {
  const deleted = await PresetModel.findOneAndDelete({
    _id: presetId,
    userId,
  });

  if (!deleted) {
    throw new AppError('Preset not found.', 404);
  }

  return deleted;
};

// ============================================================
//  Default export
// ============================================================

export default {
  getUserSettings,
  updateUserSettings,
  listPresets,
  getPresetById,
  createPreset,
  updatePreset,
  deletePreset,
};