/**
 * HTTP handlers for the WriteSpeare admin feature.
 *
 * Admin-only management of system-wide presets. Every handler is
 * expected to be mounted behind BOTH `authenticate` and
 * `requireAdmin` at the route layer, so by the time a request
 * reaches here the caller is an authenticated administrator. The
 * controller does NOT re-check the role — that check has already
 * been performed by the middleware, and duplicating it here would
 * split the authorization contract across two files.
 *
 * What "admin config" means in this codebase:
 *
 *   The plan annotates the admin controller as "Config update
 *   endpoints". That phrase is the entire specification the plan
 *   gives, and it is ambiguous on its face — the plan declares
 *   no `AdminConfig`, `SystemConfig`, or `GlobalSettings` model,
 *   and none of the shared types describes a distinct
 *   admin-managed entity.
 *
 *   The service (`adminService.ts`) resolves the ambiguity by
 *   picking the ONE form of cross-user configuration the
 *   existing schema supports: the system-wide Preset. A preset
 *   with `userId: null` is the semantic marker for "system
 *   preset, visible to every user", and the user-scoped
 *   `settingsService.createPreset` deliberately refuses to
 *   manufacture one — it always stamps the caller's own userId.
 *   The admin feature is the one path that can create, edit, and
 *   delete presets in the system scope.
 *
 *   This controller exposes that capability through four
 *   endpoints, all under the `/api/admin/presets` sub-path. The
 *   service header documents the scope decision in full; this
 *   header only restates the shape so a reader of the controller
 *   does not have to jump files to understand why "admin config"
 *   maps onto the Preset collection.
 *
 * The inverted ownership model:
 *
 *   Every OTHER controller in this codebase either passes the
 *   CALLER's identity to its service (the ownership-scoped ones)
 *   or passes the TARGET's identity (the users feature). This
 *   controller passes NEITHER, because the entity it manages is
 *   owned by no one. A system preset is a shared resource: every
 *   administrator of the same installation manages the same
 *   system presets, and every user of the same installation
 *   reads the same system presets. There is no per-caller scope
 *   to filter on.
 *
 *   The consequence is that the defensive authentication guard
 *   this file applies — reading `req.user?.userId` and rejecting
 *   with a 401 if it is absent — is the ONLY thing the controller
 *   does with the caller's identity. The value is never passed to
 *   the service. Its sole purpose is to catch a route being
 *   misconfigured in a future refactor, where an admin-only
 *   handler is accidentally exposed without its middleware chain.
 *   That class of mistake is rare but has real consequences; the
 *   belt-and-braces guard is the cheap insurance.
 *
 * Response typing — the assignability bridge:
 *
 *   Every handler declares its `Response<T>` type as
 *   `ApiResponse<Preset>` or `ApiResponse<Preset[]>`. The service
 *   returns `PresetDocument` (Mongoose's in-process shape) which
 *   is structurally assignable to the shared `Preset` domain
 *   type — the only difference is that `PresetDocument._id` is a
 *   concrete `ObjectId` while `Preset._id` is `string | ObjectId`.
 *   Since `ObjectId` is a member of the union, the assignment is
 *   safe. At runtime, `res.json()` serialises the ObjectId to its
 *   hex string form.
 *
 * Validation is shallow:
 *
 *   The controller verifies the primitive type of each field that
 *   it reads from the request body or route params. It does NOT
 *   verify numeric ranges, slug formats, or anything else the
 *   Preset schema already enforces. Those checks are the schema's
 *   job; a Mongoose ValidationError is translated to a 400 by the
 *   terminal middleware with the schema's own message, which is
 *   exactly what a client should see. Duplicating the schema's
 *   rules here would create a second source of truth that could
 *   drift from the first.
 *
 * The upsert route's URL-vs-body precedence:
 *
 *   The upsert handler reads the preset's `name` from the route
 *   parameter (`/api/admin/presets/:name`) and the rest of the
 *   payload from the request body. The URL parameter is the
 *   authoritative source for the name — a `name` field in the
 *   body is IGNORED. This is the conventional REST behaviour for
 *   a resource whose identity is part of its URL, and it prevents
 *   a client from sending mismatched values (`PUT /presets/quick`
 *   with a body claiming `"name": "balanced"`) that would
 *   otherwise be ambiguous about which one wins.
 *
 *   The route is a PUT rather than a POST because the operation is
 *   idempotent: sending the same request twice produces the same
 *   final state (a single system preset with that name and the
 *   given configuration). PUT is the correct verb for that
 *   semantic, and it matches the service function's name
 *   (`upsertSystemPreset`).
 *
 * No try/catch appears anywhere in this file. Each route handler
 * is wrapped in `asyncHandler` at the route registration site,
 * which forwards any rejection to the terminal error middleware.
 * The middleware recognises the shared `AppError` class thrown by
 * the service — a 404 for a preset that does not exist, a 409 for
 * a name that collides within the system scope — and formats the
 * response with the same envelope this file uses on success.
 */

import type { Response } from 'express';

import {
  listSystemPresets as listSystemPresetsService,
  getSystemPresetByName as getSystemPresetByNameService,
  upsertSystemPreset as upsertSystemPresetService,
  deleteSystemPreset as deleteSystemPresetService,
} from '../services/adminService.js';

import type { AuthRequest } from '../../auth/middleware/authGuard.js';
import type {
  ApiResponse,
  Preset,
  PresetCreatePayload,
} from '../../shared/types/index.js';

// ============================================================
//  Primitive type predicates
// ============================================================
//
// The same predicates used by the settings controller for its
// create-preset and update-preset handlers. They are declared
// locally (rather than imported from a shared location) because
// the codebase's established convention is that each controller
// carries its own validation helpers — the settings controller
// does the same thing for the same fields, and no shared
// validators module exists in the plan's file tree.
//
// A future refactor could promote these predicates to a shared
// module (for example, `features/shared/utils/validators.ts`);
// that decision is out of scope for this file.

/**
 * A non-empty string. Rejects the empty string, which is the
 * common "client sent a field but left it blank" case.
 * Whitespace-only strings pass here and are rejected by the
 * schema's `trim: true` + `minlength` validators on the fields
 * that care.
 */
const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

/**
 * A finite number. Rejects NaN, Infinity, and -Infinity — none of
 * which are meaningful for any numeric field on the preset
 * payload.
 */
const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const isBoolean = (value: unknown): value is boolean =>
  typeof value === 'boolean';

/**
 * A `string[]`. Checks that the value is an array AND that every
 * element is a string — `Array.isArray` alone would accept
 * `[1, 2, 3]`.
 */
const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.every((item) => typeof item === 'string');

/**
 * A two-element array of finite numbers. Used for the
 * `targetReadingGrade` tuple field on the preset payload.
 */
const isNumberTuple2 = (value: unknown): value is [number, number] => {
  if (!Array.isArray(value)) {
    return false;
  }
  if (value.length !== 2) {
    return false;
  }
  return value.every(
    (item) => typeof item === 'number' && Number.isFinite(item)
  );
};

/**
 * The four time-range buckets a preset's default search
 * distribution is expressed as.
 *
 * Derived from `PresetCreatePayload['defaultBucketLayout']` so the
 * local shape cannot drift from the shape the shared types module
 * declares. If the shared declaration ever changes — a fifth
 * bucket, a rename of one of the four — the compiler reports it at
 * every call site in this file rather than letting this alias
 * quietly disagree with the wire contract.
 *
 * The same alias is declared (locally, for the same reason) in
 * `settingsService.ts`. The two declarations are intentionally
 * parallel — the admin and settings features both validate and
 * forward the same field, and the plan groups their updates
 * together so the two read as matching implementations.
 */
type BucketLayout = PresetCreatePayload['defaultBucketLayout'];

/**
 * Narrow `unknown` to a `BucketLayout`.
 *
 * Checks that the value is a plain object — not null, not an
 * array — and that all four required fields are finite numbers.
 * Does NOT check numeric ranges or integer-ness; the Preset
 * schema's validators are authoritative on those. The controller
 * only confirms that the shape is right before the value reaches
 * the service.
 *
 * The predicate is declared alongside the primitive predicates
 * above rather than in its own section because it is a compound
 * of them — it calls `isNumber` for each of its four fields — and
 * belongs where a reader looking for "how does this controller
 * validate a value" will find it.
 */
const isBucketLayout = (value: unknown): value is BucketLayout => {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value)
  ) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    isNumber(v['anyTime']) &&
    isNumber(v['pastYear']) &&
    isNumber(v['pastMonth']) &&
    isNumber(v['pastWeek'])
  );
};

// ============================================================
//  GET /api/admin/presets
// ============================================================

/**
 * List every system preset.
 *
 * Flow:
 *
 *   1. Reject with 401 if no authenticated user is attached.
 *      (See the file header for the belt-and-braces rationale —
 *      `requireAdmin` on the route already guarantees an
 *      authenticated admin reaches here.)
 *   2. Delegate to the service.
 *   3. Respond with 200 and the array. An empty array is a
 *      valid response for a fresh installation that has not yet
 *      run its preset seeder.
 *
 * No body, query, or route parameters are read. The endpoint's
 * only input is the fact that the caller is an administrator.
 */
export const listSystemPresets = async (
  req: AuthRequest,
  res: Response<ApiResponse<Preset[]>>
): Promise<void> => {
  // ---- 1. Defensive authentication guard ----
  const callerId = req.user?.userId;
  if (!callerId) {
    res.status(401).json({
      success: false,
      error: 'Authentication required.',
    });
    return;
  }

  // ---- 2. Delegate to the service ----
  const presets = await listSystemPresetsService();

  // ---- 3. Respond ----
  res.status(200).json({
    success: true,
    data: presets,
  });
};

// ============================================================
//  GET /api/admin/presets/:name
// ============================================================

/**
 * Return a single system preset by its slug name.
 *
 * Flow:
 *
 *   1. Reject with 401 if no authenticated user is attached.
 *   2. Reject with 400 if the `:name` route parameter is missing
 *      or empty.
 *   3. Delegate to the service. The service normalizes the name
 *      (trim + lowercase) before querying, so a caller that
 *      supplies `"Balanced"` matches the same document as a
 *      caller that supplies `"balanced"`.
 *   4. A null result means "no such system preset"; this handler
 *      returns 404. Note that a user-owned preset with the same
 *      name is invisible here — the service's `{ userId: null }`
 *      filter excludes it — and correctly so, because it is not
 *      the system preset with that name.
 *   5. Respond with 200 and the preset, or 404.
 */
export const getSystemPresetByName = async (
  req: AuthRequest,
  res: Response<ApiResponse<Preset>>
): Promise<void> => {
  // ---- 1. Defensive authentication guard ----
  const callerId = req.user?.userId;
  if (!callerId) {
    res.status(401).json({
      success: false,
      error: 'Authentication required.',
    });
    return;
  }

  // ---- 2. Route parameter guard ----
  const name = req.params['name'];
  if (!isNonEmptyString(name)) {
    res.status(400).json({
      success: false,
      error: 'Preset name is required.',
    });
    return;
  }

  // ---- 3. Delegate to the service ----
  const preset = await getSystemPresetByNameService(name);
  if (!preset) {
    res.status(404).json({
      success: false,
      error: 'System preset not found.',
    });
    return;
  }

  // ---- 4. Respond ----
  res.status(200).json({
    success: true,
    data: preset,
  });
};

// ============================================================
//  PUT /api/admin/presets/:name
// ============================================================

/**
 * Create a new system preset, or update the existing one with
 * the same name. The operation is a true upsert — idempotent, so
 * sending the same request twice produces the same final state.
 *
 * Flow:
 *
 *   1. Reject with 401 if no authenticated user is attached.
 *   2. Reject with 400 if the `:name` route parameter is missing
 *      or empty.
 *   3. Reject with 400 if the request body is not a plain object.
 *   4. Validate every required field of the preset payload. The
 *      `name` field comes from the URL, not the body — see the
 *      file header for the URL-vs-body precedence rule. The
 *      remaining 21 fields are validated for their primitive
 *      types only; the schema is authoritative on ranges and
 *      formats.
 *   5. Delegate to the service. The service issues a single
 *      `findOneAndUpdate` with `upsert: true` and returns the
 *      resulting document.
 *   6. Respond with 200 and the resulting preset.
 *
 * Response status is 200 rather than 201. The operation is an
 * upsert, and the server does not distinguish "created" from
 * "updated" in the response body — both cases produce the same
 * document shape, and the client has no use for the distinction.
 * A separate 201-on-create / 200-on-update split would require
 * the service to report which branch ran, adding surface for no
 * benefit. Clients that want the distinction can compare the
 * returned document's `createdAt` against the current time; the
 * returned payload carries enough information.
 */
export const upsertSystemPreset = async (
  req: AuthRequest,
  res: Response<ApiResponse<Preset>>
): Promise<void> => {
  // ---- 1. Defensive authentication guard ----
  const callerId = req.user?.userId;
  if (!callerId) {
    res.status(401).json({
      success: false,
      error: 'Authentication required.',
    });
    return;
  }

  // ---- 2. Route parameter guard ----
  const name = req.params['name'];
  if (!isNonEmptyString(name)) {
    res.status(400).json({
      success: false,
      error: 'Preset name is required.',
    });
    return;
  }

  // ---- 3. Body shape guard ----
  const rawBody: unknown = req.body;
  if (
    typeof rawBody !== 'object' ||
    rawBody === null ||
    Array.isArray(rawBody)
  ) {
    res.status(400).json({
      success: false,
      error: 'Request body must be a JSON object.',
    });
    return;
  }
  const body = rawBody as Record<string, unknown>;

  // ---- 4. Field-by-field validation ----
  // Every field is validated for its primitive type. Fields not
  // present in the body are rejected with a 400 — the payload
  // type requires all 21 non-name fields to be present, so a
  // missing field is a client error, not a "use the default"
  // case. (The schema has defaults for some of these fields, but
  // they apply when the SERVICE omits them, not when a client
  // does. A client building a system preset is expected to
  // specify the full configuration; the admin UI's form
  // pre-populates the fields from the schema's defaults.)

  const displayName = body['displayName'];
  if (!isNonEmptyString(displayName)) {
    res.status(400).json({
      success: false,
      error: 'displayName is required.',
    });
    return;
  }

  const defaultBucketLayout = body['defaultBucketLayout'];
  if (!isBucketLayout(defaultBucketLayout)) {
    res.status(400).json({
      success: false,
      error:
        'defaultBucketLayout must be an object with anyTime, ' +
        'pastYear, pastMonth, and pastWeek as numbers.',
    });
    return;
  }

  const sourceCount = body['sourceCount'];
  if (!isNumber(sourceCount)) {
    res.status(400).json({
      success: false,
      error: 'sourceCount must be a number.',
    });
    return;
  }

  const wordCount = body['wordCount'];
  if (!isNumber(wordCount)) {
    res.status(400).json({
      success: false,
      error: 'wordCount must be a number.',
    });
    return;
  }

  const searchEngines = body['searchEngines'];
  if (!isStringArray(searchEngines)) {
    res.status(400).json({
      success: false,
      error: 'searchEngines must be an array of strings.',
    });
    return;
  }

  const resultsPerPage = body['resultsPerPage'];
  if (!isNumber(resultsPerPage)) {
    res.status(400).json({
      success: false,
      error: 'resultsPerPage must be a number.',
    });
    return;
  }



  const pageLoadTimeout = body['pageLoadTimeout'];
  if (!isNumber(pageLoadTimeout)) {
    res.status(400).json({
      success: false,
      error: 'pageLoadTimeout must be a number.',
    });
    return;
  }

  const maxRetries = body['maxRetries'];
  if (!isNumber(maxRetries)) {
    res.status(400).json({
      success: false,
      error: 'maxRetries must be a number.',
    });
    return;
  }

  const targetReadingGrade = body['targetReadingGrade'];
  if (!isNumberTuple2(targetReadingGrade)) {
    res.status(400).json({
      success: false,
      error: 'targetReadingGrade must be a 2-element array of numbers.',
    });
    return;
  }

  const minKeywordDensity = body['minKeywordDensity'];
  if (!isNumber(minKeywordDensity)) {
    res.status(400).json({
      success: false,
      error: 'minKeywordDensity must be a number.',
    });
    return;
  }

  const maxKeywordDensity = body['maxKeywordDensity'];
  if (!isNumber(maxKeywordDensity)) {
    res.status(400).json({
      success: false,
      error: 'maxKeywordDensity must be a number.',
    });
    return;
  }

  const maxTfidfSimilarity = body['maxTfidfSimilarity'];
  if (!isNumber(maxTfidfSimilarity)) {
    res.status(400).json({
      success: false,
      error: 'maxTfidfSimilarity must be a number.',
    });
    return;
  }

  const maxSemanticSimilarity = body['maxSemanticSimilarity'];
  if (!isNumber(maxSemanticSimilarity)) {
    res.status(400).json({
      success: false,
      error: 'maxSemanticSimilarity must be a number.',
    });
    return;
  }

  const maxAiMarkers = body['maxAiMarkers'];
  if (!isNumber(maxAiMarkers)) {
    res.status(400).json({
      success: false,
      error: 'maxAiMarkers must be a number.',
    });
    return;
  }

  const runReadabilityCheck = body['runReadabilityCheck'];
  if (!isBoolean(runReadabilityCheck)) {
    res.status(400).json({
      success: false,
      error: 'runReadabilityCheck must be a boolean.',
    });
    return;
  }

  const runSeoCheck = body['runSeoCheck'];
  if (!isBoolean(runSeoCheck)) {
    res.status(400).json({
      success: false,
      error: 'runSeoCheck must be a boolean.',
    });
    return;
  }

  const runOriginalityCheck = body['runOriginalityCheck'];
  if (!isBoolean(runOriginalityCheck)) {
    res.status(400).json({
      success: false,
      error: 'runOriginalityCheck must be a boolean.',
    });
    return;
  }

  const runAiMarkerCheck = body['runAiMarkerCheck'];
  if (!isBoolean(runAiMarkerCheck)) {
    res.status(400).json({
      success: false,
      error: 'runAiMarkerCheck must be a boolean.',
    });
    return;
  }

  const runGrammarCheck = body['runGrammarCheck'];
  if (!isBoolean(runGrammarCheck)) {
    res.status(400).json({
      success: false,
      error: 'runGrammarCheck must be a boolean.',
    });
    return;
  }

  const autoRegenerate = body['autoRegenerate'];
  if (!isBoolean(autoRegenerate)) {
    res.status(400).json({
      success: false,
      error: 'autoRegenerate must be a boolean.',
    });
    return;
  }

  const maxRegenerationAttempts = body['maxRegenerationAttempts'];
  if (!isNumber(maxRegenerationAttempts)) {
    res.status(400).json({
      success: false,
      error: 'maxRegenerationAttempts must be a number.',
    });
    return;
  }

  // ---- 5. Build the payload and delegate ----
  // The URL parameter is the authoritative `name` — a `name` field
  // in the body is deliberately ignored (the field is not read
  // from the body above). The payload's remaining fields come
  // from the validated body values. The object literal is
  // assignable to `PresetCreatePayload` because every required
  // field is present and correctly typed.
  const payload: PresetCreatePayload = {
    name,
    displayName,
    defaultBucketLayout,
    sourceCount,
    wordCount,
    searchEngines,
    resultsPerPage,
    pageLoadTimeout,
    maxRetries,
    targetReadingGrade,
    minKeywordDensity,
    maxKeywordDensity,
    maxTfidfSimilarity,
    maxSemanticSimilarity,
    maxAiMarkers,
    runReadabilityCheck,
    runSeoCheck,
    runOriginalityCheck,
    runAiMarkerCheck,
    runGrammarCheck,
    autoRegenerate,
    maxRegenerationAttempts,
  };

  const preset = await upsertSystemPresetService(payload);

  // ---- 6. Respond ----
  res.status(200).json({
    success: true,
    data: preset,
  });
};

// ============================================================
//  DELETE /api/admin/presets/:name
// ============================================================

/**
 * Delete a system preset by its slug name.
 *
 * Flow:
 *
 *   1. Reject with 401 if no authenticated user is attached.
 *   2. Reject with 400 if the `:name` route parameter is missing
 *      or empty.
 *   3. Delegate to the service. The service issues a
 *      `findOneAndDelete` scoped to `{ userId: null, name }`, so
 *      a user-owned preset with the same name is not touched.
 *   4. A null result means "no system preset with that name";
 *      this handler returns 404. The 404 covers two cases the
 *      caller does not need to distinguish — the name names no
 *      preset at all, or it names a user-owned preset that the
 *      admin service does not manage.
 *   5. Respond with 200 and the deleted preset. Returning the
 *      deleted document gives the client a last-chance look at
 *      what was removed, which the admin UI uses for an undo
 *      affordance.
 *
 * No cascade: the deleted preset is a template, not a live
 * reference. Topics that were previously configured with it
 * store their own copy of the pipeline configuration and are
 * unaffected.
 */
export const deleteSystemPreset = async (
  req: AuthRequest,
  res: Response<ApiResponse<Preset>>
): Promise<void> => {
  // ---- 1. Defensive authentication guard ----
  const callerId = req.user?.userId;
  if (!callerId) {
    res.status(401).json({
      success: false,
      error: 'Authentication required.',
    });
    return;
  }

  // ---- 2. Route parameter guard ----
  const name = req.params['name'];
  if (!isNonEmptyString(name)) {
    res.status(400).json({
      success: false,
      error: 'Preset name is required.',
    });
    return;
  }

  // ---- 3. Delegate to the service ----
  const preset = await deleteSystemPresetService(name);

  // ---- 4. Respond ----
  res.status(200).json({
    success: true,
    data: preset,
  });
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