/**
 * Business logic for the WriteSpeare admin feature.
 *
 * SCOPE DECISION — what "Config upsert logic" means here:
 *
 *   The plan's file-tree annotation for this file reads simply
 *   "Config upsert logic". That phrase is the entire specification
 *   the plan gives, and it is ambiguous on its face — "config"
 *   could mean many things, and no model named `AdminConfig`,
 *   `SystemConfig`, or `GlobalSettings` exists anywhere in the
 *   codebase or in the plan's shared types.
 *
 *   This file resolves the ambiguity by picking the ONE form of
 *   cross-user configuration that the existing models actually
 *   support: the system-wide Preset. The Preset model already
 *   carries a nullable `userId` field whose `null` value is the
 *   semantic marker for "system preset, visible to every user" —
 *   see the Preset model header. The user-scoped
 *   `settingsService.createPreset` deliberately stamps every
 *   preset it creates with the CALLER's userId, so it cannot
 *   manufacture a system preset through any clean path. That is
 *   the genuine gap this service fills.
 *
 *   The choice has the following consequences, all of which are
 *   correct for the existing schema:
 *
 *     - No new model is introduced. The service operates on the
 *       Preset collection that already exists.
 *     - No new type is introduced. The service uses the existing
 *       `PresetCreatePayload` from `shared/types/index.ts`.
 *     - No new field is added to any existing document. A system
 *       preset is a preset with `userId: null` — a value the
 *       model already supports and the compound unique index on
 *       `{ userId, name }` already enforces uniqueness for.
 *
 *   If a future session decides the admin feature needs to
 *   manage a genuinely different "config" — a singleton
 *   application-settings document, a blocked-domain list, a
 *   usage-statistics collection — that decision requires new
 *   models and new types in `shared/types/index.ts` first, and
 *   those are out of scope for this file. The current file
 *   implements the interpretation the existing schema supports.
 *
 * The relationship to settingsService:
 *
 *   The settings feature already has a service
 *   (`settingsService.ts`) that exposes preset CRUD to ordinary
 *   users. Every operation in that service is ownership-scoped
 *   to the caller's `userId`:
 *
 *     - Read paths accept system presets (`userId: null`) AND the
 *       caller's own presets. A user can always see the built-in
 *       presets and their own customisations.
 *     - Write paths accept ONLY the caller's own presets. The
 *       system scope is excluded by the `{ _id, userId }` filter,
 *       which is what prevents a user from editing or deleting a
 *       system preset through the user-facing API.
 *
 *   That arrangement is correct for ordinary users — it is the
 *   entire point of the two-scope design — but it leaves no path
 *   for an administrator to manage system presets. The admin
 *   needs the ability to create a new system preset (perhaps for
 *   a new pipeline feature), edit an existing one (perhaps to
 *   tune the Balanced preset's word count), and delete one
 *   (perhaps to retire a preset no longer supported).
 *
 *   This service provides exactly those operations, and only
 *   those operations. It does NOT duplicate the ordinary user's
 *   preset CRUD — a system administrator who wants to create a
 *   personal preset uses `settingsService.createPreset` through
 *   the ordinary settings endpoint, and the resulting preset has
 *   their own userId as owner, not `null`.
 *
 * Why no `userId` argument on any function:
 *
 *   Every other service in this codebase takes a `userId` as its
 *   first argument — either the caller's (for ownership-scoped
 *   services) or the target's (for the users feature). This
 *   service takes NEITHER, because the entity it manages is
 *   owned by no one. A system preset is a shared resource: every
 *   administrator of the same installation manages the same
 *   system presets, and every user of the same installation
 *   reads the same system presets. There is no per-caller scope
 *   to filter on.
 *
 *   The authorization contract is therefore entirely at the
 *   controller and route layers: this service's functions are
 *   only reachable through admin-only endpoints, and the service
 *   trusts that guarantee. It does not re-verify the caller's
 *   role — it has no way of knowing the caller's identity, by
 *   design.
 *
 * Upsert semantics:
 *
 *   `upsertSystemPreset` accepts a full `PresetCreatePayload`
 *   whose `name` field is the identity of the preset being
 *   created or replaced. The service:
 *
 *     1. Normalizes the name (trim + lowercase) — the schema
 *        does this on write, but the query that matches the
 *        existing document must also use the normalized form,
 *        so the normalization happens explicitly here.
 *
 *     2. Issues a single `findOneAndUpdate` with
 *        `{ userId: null, name }` as the filter, `{ $set: {...} }`
 *        as the update, and `{ upsert: true, new: true,
 *        setDefaultsOnInsert: true, runValidators: true }` as the
 *        options.
 *
 *     3. Returns the resulting document — either the newly
 *        created one or the updated existing one.
 *
 *   The `$set` operator (rather than a full document replace)
 *   means the operation is a true upsert on both branches:
 *   on an existing document it overwrites only the fields the
 *   payload carries, leaving everything else untouched; on a new
 *   document it creates a fresh record with the payload's fields
 *   plus the schema's defaults for anything not supplied.
 *
 *   The `setDefaultsOnInsert: true` option is what makes the
 *   create branch apply the schema's `default: null` to the
 *   `userId` field, so the newly created document correctly
 *   lives in the system scope. Without that option, Mongoose
 *   would leave `userId` unset on insert, and the compound
 *   unique index would treat the resulting document as belonging
 *   to whichever null-equivalent the driver produces — which is
 *   usually `null` but is not guaranteed across driver versions.
 *
 *   The `runValidators: true` option ensures the schema's
 *   per-field validators run on both branches, so an invalid
 *   payload is rejected even on the update path where Mongoose's
 *   defaults-to-off behaviour would otherwise skip them.
 *
 * The compound unique index and what it enforces for this
 * service:
 *
 *   The Preset schema declares `{ userId: 1, name: 1 }` as a
 *   unique index. For this service, every query and every write
 *   targets `userId: null`, so the index behaves as a unique
 *   index on `name` alone within the system scope. Two system
 *   presets cannot share a name — the invariant is enforced at
 *   the database level, and this service relies on it rather
 *   than pre-checking. A concurrent pair of upsert calls for
 *   the same name will race, and the loser will receive a
 *   duplicate-key error (code 11000), which the terminal error
 *   middleware maps to a 409. That is the correct behaviour for
 *   an admin attempting to create the same system preset twice
 *   through two parallel requests.
 *
 * No cascade:
 *
 *   `deleteSystemPreset` does NOT cascade to any user's topics,
 *   articles, or other records. Presets are templates, not live
 *   references — a user's topic stores its pipeline configuration
 *   on itself at creation time, so removing the system preset
 *   it was based on does not affect the topic's ability to
 *   continue running its pipeline. This is the same reasoning
 *   the `settingsService.deletePreset` header gives for the
 *   user-scoped case; it applies identically here.
 *
 * Out of scope — the system-preset seeder:
 *
 *   The plan describes three system presets — Quick, Balanced,
 *   Deep — as shipped with the application. Nothing in this
 *   service creates them automatically: a seeder utility must
 *   call `upsertSystemPreset` for each of the three (or a
 *   similar operation) at some point during installation. That
 *   seeder is NOT declared anywhere in the plan's file tree and
 *   is therefore out of scope for this file. See the PLAN DELTA
 *   note in the execution response for the details. This service
 *   provides the primitive the seeder will consume; it does not
 *   run the seeder itself.
 */

import {
  PresetModel,
  type PresetDocument,
} from '../../settings/models/Preset.js';
import type { PresetCreatePayload } from '../../shared/types/index.js';
import { AppError } from '../../shared/middleware/errorHandler.js';

// ============================================================
//  Bucket-layout helper
// ============================================================
//
//  The system-preset upsert derives `sourceCount` from the
//  payload's `defaultBucketLayout` before persisting, per the C2
//  decision — the bucket layout is the single source of truth for
//  "how many sources to collect". The same derivation is applied
//  on the user-scoped `settingsService.createPreset` path; the
//  two implementations are parallel by design, since the settings
//  and admin features both write to the Preset collection through
//  the same field contract.
//
//  The helper here is intentionally narrower than the settings
//  service's: the admin controller requires `defaultBucketLayout`
//  on every request (it is a required field on
//  `PresetCreatePayload`), so there is no legacy-caller path that
//  would need a synthesized layout from a bare `sourceCount`.
//  Only `deriveSourceCount` is needed on this side.

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
 *
 * Identical in shape and behaviour to the helper of the same name
 * in `settingsService.ts`. The duplication is deliberate: the two
 * services are peers, and a shared helper module would be a new
 * file outside the plan's file tree. A future refactor that
 * promoted the helper to `features/shared/utils/` would update
 * both files together.
 */
const deriveSourceCount = (layout: BucketLayout): number =>
  layout.anyTime +
  layout.pastYear +
  layout.pastMonth +
  layout.pastWeek;

// ============================================================
//  listSystemPresets
// ============================================================

/**
 * List every system preset — every Preset document whose
 * `userId` is `null`. Sorted by `name` ascending so the picker
 * that consumes this endpoint shows the built-ins in a stable,
 * predictable order (Balanced, Deep, Quick, alphabetically)
 * rather than in the order the seeder happened to install them.
 *
 * The query is served by the compound index `{ userId: 1, name: 1 }`
 * on the Preset schema — MongoDB matches on the leftmost prefix
 * `userId: null` and reads the entries in `name` order without
 * a separate sort step.
 *
 * Returns an empty array when no system presets have been
 * seeded. That is a valid, non-error state — a fresh installation
 * that has not yet run its preset seeder has zero system presets,
 * and the correct client behaviour is to show an empty list, not
 * to surface a 404.
 */
export const listSystemPresets = async (): Promise<PresetDocument[]> => {
  return await PresetModel.find({ userId: null }).sort({ name: 1 });
};

// ============================================================
//  getSystemPresetByName
// ============================================================

/**
 * Read one system preset by its slug name. Returns `null` when
 * no system preset with that name exists.
 *
 * The name is normalized before the query — trimmed and
 * lowercased — so that a caller who supplies `"Balanced"` or
 * `"  balanced  "` matches the same document as a caller who
 * supplies `"balanced"`. The schema applies the same normalization
 * on write, so the query's normalized value always matches the
 * stored value.
 *
 * The query is served by the compound unique index
 * `{ userId: 1, name: 1 }` — a single index-covered lookup.
 *
 * Returns `null` rather than throwing on a missing preset. The
 * caller (the controller) converts the null into a 404, which is
 * the correct response for a well-formed request that happens to
 * name a preset that does not exist.
 *
 * @param name - The slug name of the system preset to read.
 */
export const getSystemPresetByName = async (
  name: string
): Promise<PresetDocument | null> => {
  const normalizedName = name.trim().toLowerCase();
  return await PresetModel.findOne({
    userId: null,
    name: normalizedName,
  });
};

// ============================================================
//  upsertSystemPreset
// ============================================================

/**
 * Create a new system preset, or update the existing one with
 * the same name. The operation is a true upsert: on the create
 * branch the schema's defaults fill any field the payload omits;
 * on the update branch only the fields the payload carries are
 * overwritten, and every other field on the existing document
 * is left untouched.
 *
 * Flow:
 *
 *   1. Normalize the payload's `name` — trim + lowercase — so
 *      that both the query (which matches the existing document
 *      to update) and the eventual write use the same canonical
 *      form. The schema also lowercases on write, so the write
 *      side is belt-and-braces; the query side is the one that
 *      genuinely needs the explicit normalization, because the
 *      stored value was already lowercased by a previous write.
 *
 *   2. Derive `sourceCount` from the payload's
 *      `defaultBucketLayout`. Per the C2 decision, the bucket
 *      layout is the single source of truth for "how many
 *      sources to collect", so the materialised `sourceCount`
 *      field is always the sum of the four bucket counts —
 *      never a caller-supplied number that could disagree with
 *      the layout.
 *
 *   3. Issue a single `findOneAndUpdate` with:
 *
 *        filter:  { userId: null, name: normalizedName }
 *        update:  { $set: { ...payload,
 *                           sourceCount: derivedSourceCount,
 *                           name: normalizedName,
 *                           userId: null } }
 *        options: { upsert: true, new: true,
 *                   setDefaultsOnInsert: true,
 *                   runValidators: true }
 *
 *      The `sourceCount` entry comes AFTER the spread so the
 *      derived value overrides whatever the payload carried.
 *
 *      The `userId: null` inside the `$set` is redundant on the
 *      update branch (the field is already null on the matched
 *      document) but is required on the create branch to
 *      guarantee the new document belongs to the system scope.
 *      `setDefaultsOnInsert: true` would also apply the schema's
 *      `default: null` on insert, so the `$set` entry and the
 *      default are belt-and-braces against each other. Both are
 *      kept: the explicit `$set` documents the intent at the
 *      call site, and the default covers any future schema-level
 *      change to the field's initial value.
 *
 *   4. Return the resulting document.
 *
 * The `$set` operator (rather than a full document replace) is
 * deliberate: it means a caller who supplies a full payload
 * overwrites every field they name while leaving any field they
 * did NOT name (or any field the payload type does not carry)
 * at its existing value on the update branch. For the current
 * `PresetCreatePayload` type, which requires every field, the
 * practical effect is the same as a replace — but the semantics
 * are strictly more conservative, and they remain correct if the
 * payload type ever grows optional fields.
 *
 * The function does NOT pre-check for a name collision. The
 * compound unique index on `{ userId, name }` is the
 * authoritative guard, and a pre-check would introduce a race
 * between the check and the write. Two concurrent upserts for
 * the same name are resolved by the index: one succeeds, the
 * other receives a duplicate-key error, which the terminal
 * error middleware maps to a 409.
 *
 * @param payload - The full configuration of the system preset.
 *                  The `name` field is the identity key; every
 *                  other field is a value the preset carries.
 */
export const upsertSystemPreset = async (
  payload: PresetCreatePayload
): Promise<PresetDocument> => {
  const normalizedName = payload.name.trim().toLowerCase();

  // Derive `sourceCount` from the bucket layout — see the
  // function's docstring for the C2 rationale. The derived
  // value overrides whatever the payload carried, so the
  // invariant `sourceCount === sum of the four bucket counts`
  // holds on the persisted document regardless of what the
  // caller sent.
  const sourceCount = deriveSourceCount(payload.defaultBucketLayout);

  const doc = await PresetModel.findOneAndUpdate(
    { userId: null, name: normalizedName },
    {
      $set: {
        ...payload,
        sourceCount,
        name: normalizedName,
        userId: null,
      },
    },
    {
      upsert: true,
      new: true,
      setDefaultsOnInsert: true,
      runValidators: true,
    }
  );

  // `findOneAndUpdate` with `upsert: true` and `new: true` is
  // documented to always return a document, but its TypeScript
  // signature still returns `T | null` — the compiler cannot
  // know that the upsert option guarantees non-null. The guard
  // is defensive: if it ever fires, the database is in a state
  // this service cannot recover from, and a 500 is the correct
  // response.
  if (!doc) {
    throw new AppError('Failed to upsert system preset.', 500);
  }

  return doc;
};

// ============================================================
//  deleteSystemPreset
// ============================================================

/**
 * Delete a system preset by its slug name.
 *
 * Flow:
 *
 *   1. Normalize the name — trim + lowercase — for the same
 *      reason `getSystemPresetByName` and `upsertSystemPreset`
 *      normalize: the stored value is always in the canonical
 *      form, so the query must be too.
 *
 *   2. Issue a `findOneAndDelete` with `{ userId: null, name }`
 *      as the filter. The `userId: null` clause is what scopes
 *      the operation to the system presets only; a user-owned
 *      preset with the same name (which is legal, because the
 *      unique index is scoped by userId) is not touched.
 *
 *   3. Return the deleted document so the caller can log or
 *      display what was removed.
 *
 * Throws `AppError(404)` when no system preset with that name
 * exists. The 404 is correct in two distinct cases that the
 * caller does not need to distinguish:
 *
 *   - The name names no preset at all.
 *   - The name names a user-owned preset, which the admin service
 *     does not manage (it belongs to the user whose userId it
 *     carries).
 *
 * The two cases collapse to the same 404 because from the admin
 * service's perspective they are the same: "there is no system
 * preset with that name". A user's personal preset called
 * `balanced` is invisible here, and correct so — it is not the
 * system `balanced`, and modifying it is not the admin's job.
 *
 * No cascade: the deleted preset is a template, not a live
 * reference. Topics that were previously configured with it
 * store their own copy of the pipeline configuration and are
 * unaffected.
 *
 * @param name - The slug name of the system preset to delete.
 */
export const deleteSystemPreset = async (
  name: string
): Promise<PresetDocument> => {
  const normalizedName = name.trim().toLowerCase();

  const deleted = await PresetModel.findOneAndDelete({
    userId: null,
    name: normalizedName,
  });

  if (!deleted) {
    throw new AppError('System preset not found.', 404);
  }

  return deleted;
};

// ============================================================
//  Default export
// ============================================================

export default {
  listSystemPresets,
  getSystemPresetByName,
  upsertSystemPreset,
  deleteSystemPreset,
};