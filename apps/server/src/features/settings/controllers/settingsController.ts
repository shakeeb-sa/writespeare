/**
 * HTTP handlers for the WriteSpeare settings feature.
 *
 * Two related resource families are exposed by this one
 * controller. They are grouped together because the plan's file
 * tree places them under the same feature folder and because they
 * share a route prefix in the final router:
 *
 *   UserSetting endpoints (per-user preferences):
 *     GET    /api/settings          → read settings, upserting defaults
 *     PATCH  /api/settings          → partial update
 *
 *   Preset endpoints (named pipeline configuration bundles):
 *     GET    /api/settings/presets          → list visible presets
 *     POST   /api/settings/presets          → create a user-owned preset
 *     GET    /api/settings/presets/:id      → read one preset
 *     PATCH  /api/settings/presets/:id      → update one user-owned preset
 *     DELETE /api/settings/presets/:id      → delete one user-owned preset
 *
 * Every handler performs exactly four jobs and nothing else:
 *
 *   1. Read the authenticated user's ID from `req.user.userId`
 *      and reject the request with a 401 if it is absent. Every
 *      ownership-scoped operation in WriteSpeare keys off this
 *      value; a handler reached without an authenticated session
 *      would either crash on a null dereference or — far worse —
 *      silently operate on the wrong user's data.
 *
 *   2. Validate the shape of the request body / params just
 *      enough to reject requests that are so malformed the
 *      service would produce a confusing error. The schemas
 *      remain the authoritative validators for everything
 *      subtler — field ranges, closed-set membership on nested
 *      values, cross-field constraints — and a Mongoose
 *      ValidationError is translated to a 400 by the terminal
 *      error middleware.
 *
 *   3. Delegate to the service. The controller never touches the
 *      database directly — it does not import the UserSetting or
 *      Preset models, does not build queries, and does not know
 *      what collections the data lives in.
 *
 *   4. Format the success response using the shared `ApiResponse`
 *      envelope. Every response — success or failure — uses the
 *      same shape, so a client can unwrap it uniformly.
 *
 * No try/catch appears anywhere in this file. Each route handler
 * is wrapped in `asyncHandler` at the route registration site,
 * which forwards any rejection to the terminal error middleware.
 * The middleware recognises the shared `AppError` class thrown by
 * the service — a 404 for a settings document or preset that does
 * not exist or belongs to a different user, a 409 for a preset
 * name collision within the caller's scope — and formats the
 * response with the same envelope this file uses on success.
 *
 * The two-scope rule for presets — and how it is expressed at the
 * controller level:
 *
 *   A preset is either a system preset (`userId: null`, visible
 *   to every user, seeded once and never modified through the
 *   API) or a user preset (owned by exactly one user, visible
 *   and writable only to that user). The visibility rules for
 *   the two scopes live in the service — the read paths accept
 *   either scope, the write paths accept only the caller's own
 *   scope — and the controller does not need to know about them.
 *   Every preset handler simply passes the authenticated userId
 *   to the service; the service enforces the rule and the
 *   controller formats the outcome.
 *
 * The exclusion of `name` from preset updates:
 *
 *   A preset's `name` field is its identity within the caller's
 *   scope and is the key the compound unique index uses. The
 *   service's `updatePreset` deliberately excludes `name` from
 *   the updatable field set (see the service header), and this
 *   controller mirrors that — the update handler does not read
 *   `name` from the request body. If a client sends a `name`
 *   field on a PATCH, it is silently ignored. A user who wants a
 *   differently-named preset deletes the current one and creates
 *   a new one; that flow is what the desktop UI exposes.
 *
 * Response typing — the assignability bridge:
 *
 *   Every handler declares its `Response<T>` type explicitly. On
 *   success the service returns a `UserSettingDocument` or
 *   `PresetDocument` (Mongoose's in-process shapes) which are
 *   structurally assignable to the shared `UserSetting` and
 *   `Preset` domain types — the only difference is that the
 *   document interfaces pin `_id` to a concrete `ObjectId` while
 *   the shared interfaces use the `string | ObjectId` union.
 *   Since `ObjectId` is a member of the union, the assignment is
 *   safe. At runtime, `res.json()` serialises the ObjectId to
 *   its hex string form.
 *
 * The upsert-on-read behaviour of GET /api/settings:
 *
 *   A user who has never opened the Settings page has no
 *   UserSetting document in the database. The service's
 *   `getUserSettings` creates one with schema defaults on first
 *   read, so this handler never returns a 404 for "settings not
 *   configured". That is deliberate: the "no settings yet" state
 *   is semantically equivalent to "settings are all defaults",
 *   and a 404 would force every client to special-case it.
 *
 * Ownership scoping:
 *
 *   The `userId` passed to the service is ALWAYS derived from the
 *   authenticated session — `req.user.userId` — and NEVER read
 *   from the request body or query. A client-supplied `userId`
 *   field on any request body is ignored (the body's
 *   `Record<string, unknown>` type simply does not read it).
 */

import type { Response } from 'express';

import {
  getUserSettings as getUserSettingsService,
  updateUserSettings as updateUserSettingsService,
  listPresets as listPresetsService,
  getPresetById as getPresetByIdService,
  createPreset as createPresetService,
  updatePreset as updatePresetService,
  deletePreset as deletePresetService,
} from '../services/settingsService.js';
import type { UserSettingsUpdatePayload } from '../services/settingsService.js';

import type { AuthRequest } from '../../auth/middleware/authGuard.js';
import type {
  ApiResponse,
  UserSetting,
  Preset,
  PresetName,
  ProfileName,
} from '../../shared/types/index.js';

// ============================================================
//  Runtime legal-value tables and type guards
// ============================================================
//
// Each array is annotated with its corresponding union type
// where one exists, giving a compile-time guarantee that every
// string in the array is a legal member. The `theme` union is
// declared inline because the shared types module does not
// export a named alias for it — `UserSettingsMap.theme` uses the
// inline union `'light' | 'dark'` directly.

const PRESET_NAME_VALUES: readonly PresetName[] = [
  'quick',
  'balanced',
  'deep',
  'custom',
];

const PROFILE_NAME_VALUES: readonly ProfileName[] = [
  'blog-post',
  'news-article',
  'product-review',
  'academic',
];

const THEME_VALUES: readonly ['light', 'dark'] = ['light', 'dark'];

const isPresetName = (value: unknown): value is PresetName =>
  typeof value === 'string' &&
  (PRESET_NAME_VALUES as readonly string[]).includes(value);

const isProfileName = (value: unknown): value is ProfileName =>
  typeof value === 'string' &&
  (PROFILE_NAME_VALUES as readonly string[]).includes(value);

const isTheme = (value: unknown): value is 'light' | 'dark' =>
  typeof value === 'string' &&
  (THEME_VALUES as readonly string[]).includes(value);

// ============================================================
//  Primitive type predicates
// ============================================================
//
// These are declared here rather than imported because no other
// controller file has needed them — the previous controllers
// validated fewer fields per handler and inlined their type
// checks. The settings controller validates 20+ fields on the
// create-preset and update-preset paths, so a set of named
// predicates keeps the handler bodies readable.

/**
 * A non-empty string. Rejects the empty string, which is the
 * common "client sent a field but left it blank" case.
 * Whitespace-only strings pass here and are trimmed-then-rejected
 * by the schema's `trim: true` + `minlength: 1` on the relevant
 * fields — the controller does not duplicate the schema's trim
 * step.
 */
const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

/**
 * A finite number. Rejects NaN, Infinity, and -Infinity — none of
 * which are meaningful for any numeric field in this feature, and
 * all of which JSON's parser can produce from malformed input in
 * some JavaScript engines.
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
 * `targetReadingGrade` tuple field on Preset. The runtime shape
 * is `[number, number]`, which the shared interface declares as a
 * tuple; MongoDB stores it as an array.
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

// ============================================================
//  GET /api/settings
// ============================================================

/**
 * Return the authenticated user's settings, creating them with
 * schema defaults on first access if they do not yet exist.
 *
 * Flow:
 *
 *   1. Reject with 401 if no authenticated user is attached.
 *   2. Delegate to the service. The service upserts on read —
 *      see the file header for why the "no settings yet" case is
 *      not a 404.
 *   3. Respond with 200 and the settings document.
 *
 * No body, query, or route parameters are read. The endpoint's
 * only input is the authenticated user, and the response is
 * always a single settings object.
 */
export const getUserSettings = async (
  req: AuthRequest,
  res: Response<ApiResponse<UserSetting>>
): Promise<void> => {
  // ---- 1. Authentication guard ----
  const userId = req.user?.userId;
  if (!userId) {
    res.status(401).json({
      success: false,
      error: 'Authentication required.',
    });
    return;
  }

  // ---- 2. Delegate to the service ----
  const settings = await getUserSettingsService(userId);

  // ---- 3. Respond ----
  res.status(200).json({
    success: true,
    data: settings,
  });
};

// ============================================================
//  PATCH /api/settings
// ============================================================

/**
 * Apply a partial update to the authenticated user's settings.
 *
 * Flow:
 *
 *   1. Reject with 401 if no authenticated user is attached.
 *   2. Reject with 400 if the request body is not a plain object.
 *   3. For every field present in the body, validate its type or
 *      closed-set membership and copy it into the patch. Fields
 *      omitted from the body are left unchanged on the document.
 *   4. Delegate to the service. A body with no recognized fields
 *      is a valid no-op — the service short-circuits and returns
 *      the current settings.
 *   5. Respond with 200 and the updated settings.
 *
 * Only the six fields on `UserSettingsMap` are read from the
 * body. Any other key — including a `userId` a client might try
 * to sneak in — is ignored, because the handler only reads the
 * keys it names.
 */
export const updateUserSettings = async (
  req: AuthRequest,
  res: Response<ApiResponse<UserSetting>>
): Promise<void> => {
  // ---- 1. Authentication guard ----
  const userId = req.user?.userId;
  if (!userId) {
    res.status(401).json({
      success: false,
      error: 'Authentication required.',
    });
    return;
  }

  // ---- 2. Body shape guard ----
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

  // ---- 3. Build the patch field-by-field ----
  const patch: UserSettingsUpdatePayload = {};

  const defaultPreset = body['defaultPreset'];
  if (defaultPreset !== undefined) {
    if (!isPresetName(defaultPreset)) {
      res.status(400).json({
        success: false,
        error: `defaultPreset must be one of: ${PRESET_NAME_VALUES.join(', ')}.`,
      });
      return;
    }
    patch.defaultPreset = defaultPreset;
  }

  const defaultProfile = body['defaultProfile'];
  if (defaultProfile !== undefined) {
    if (!isProfileName(defaultProfile)) {
      res.status(400).json({
        success: false,
        error: `defaultProfile must be one of: ${PROFILE_NAME_VALUES.join(', ')}.`,
      });
      return;
    }
    patch.defaultProfile = defaultProfile;
  }

  const defaultPromptFile = body['defaultPromptFile'];
  if (defaultPromptFile !== undefined) {
    if (!isNonEmptyString(defaultPromptFile)) {
      res.status(400).json({
        success: false,
        error: 'defaultPromptFile must be a non-empty string.',
      });
      return;
    }
    patch.defaultPromptFile = defaultPromptFile;
  }

  const autoSaveAfterEachStage = body['autoSaveAfterEachStage'];
  if (autoSaveAfterEachStage !== undefined) {
    if (!isBoolean(autoSaveAfterEachStage)) {
      res.status(400).json({
        success: false,
        error: 'autoSaveAfterEachStage must be a boolean.',
      });
      return;
    }
    patch.autoSaveAfterEachStage = autoSaveAfterEachStage;
  }

  const notifyOnCompletion = body['notifyOnCompletion'];
  if (notifyOnCompletion !== undefined) {
    if (!isBoolean(notifyOnCompletion)) {
      res.status(400).json({
        success: false,
        error: 'notifyOnCompletion must be a boolean.',
      });
      return;
    }
    patch.notifyOnCompletion = notifyOnCompletion;
  }

  const theme = body['theme'];
  if (theme !== undefined) {
    if (!isTheme(theme)) {
      res.status(400).json({
        success: false,
        error: `theme must be one of: ${THEME_VALUES.join(', ')}.`,
      });
      return;
    }
    patch.theme = theme;
  }

  // ---- 4. Delegate to the service ----
  const settings = await updateUserSettingsService(userId, patch);

  // ---- 5. Respond ----
  res.status(200).json({
    success: true,
    data: settings,
  });
};

// ============================================================
//  GET /api/settings/presets
// ============================================================

/**
 * List every preset visible to the authenticated user — the
 * system presets plus the caller's own. Presets owned by other
 * users are excluded by the service's read filter.
 *
 * Flow:
 *
 *   1. Reject with 401 if no authenticated user is attached.
 *   2. Delegate to the service.
 *   3. Respond with 200 and the array. An empty array is a valid
 *      response for a fresh install with no system presets seeded
 *      yet.
 *
 * No body, query, or route parameters are read. The endpoint's
 * only input is the authenticated user.
 */
export const listPresets = async (
  req: AuthRequest,
  res: Response<ApiResponse<Preset[]>>
): Promise<void> => {
  // ---- 1. Authentication guard ----
  const userId = req.user?.userId;
  if (!userId) {
    res.status(401).json({
      success: false,
      error: 'Authentication required.',
    });
    return;
  }

  // ---- 2. Delegate to the service ----
  const presets = await listPresetsService(userId);

  // ---- 3. Respond ----
  res.status(200).json({
    success: true,
    data: presets,
  });
};

// ============================================================
//  GET /api/settings/presets/:id
// ============================================================

/**
 * Return a single preset by its ID — a system preset or a preset
 * the caller owns.
 *
 * Flow:
 *
 *   1. Reject with 401 if no authenticated user is attached.
 *   2. Reject with 400 if the `:id` route parameter is missing
 *      or empty. A malformed ID that is present but not a valid
 *      ObjectId is not rejected here — the service's `findOne`
 *      throws a CastError, which the terminal middleware maps to
 *      a 400.
 *   3. Delegate to the service. A null result means either "no
 *      such preset" or "preset owned by a different user"; this
 *      handler returns 404 for both. The service's read filter
 *      accepts system presets always, so a system preset that
 *      exists will never produce a null here.
 *   4. Respond with 200 and the preset, or 404.
 */
export const getPresetById = async (
  req: AuthRequest,
  res: Response<ApiResponse<Preset>>
): Promise<void> => {
  // ---- 1. Authentication guard ----
  const userId = req.user?.userId;
  if (!userId) {
    res.status(401).json({
      success: false,
      error: 'Authentication required.',
    });
    return;
  }

  // ---- 2. Route parameter guard ----
  const presetId = req.params['id'];
  if (!isNonEmptyString(presetId)) {
    res.status(400).json({
      success: false,
      error: 'Preset ID is required.',
    });
    return;
  }

  // ---- 3. Delegate to the service ----
  const preset = await getPresetByIdService(userId, presetId);
  if (!preset) {
    res.status(404).json({
      success: false,
      error: 'Preset not found.',
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
//  POST /api/settings/presets
// ============================================================

/**
 * Create a preset owned by the authenticated user.
 *
 * Flow:
 *
 *   1. Reject with 401 if no authenticated user is attached.
 *   2. Reject with 400 if the request body is not a plain object.
 *   3. Validate every required field of the create payload. Each
 *      field's presence and top-level type is checked here; the
 *      schema is authoritative on ranges and formats.
 *   4. Delegate to the service. The service sets `userId` from
 *      the authenticated session — never from the body — and
 *      persists. A duplicate name within the caller's own preset
 *      set produces a 409 from the terminal middleware, via the
 *      compound unique index on `(userId, name)`.
 *   5. Respond with 201 Created and the persisted preset.
 *
 * The `userId` argument to the service is derived from the
 * authenticated session. Any client-supplied `userId` field on
 * the request body is ignored — the body's `Record<string,
 * unknown>` type does not read that key.
 */
export const createPreset = async (
  req: AuthRequest,
  res: Response<ApiResponse<Preset>>
): Promise<void> => {
  // ---- 1. Authentication guard ----
  const userId = req.user?.userId;
  if (!userId) {
    res.status(401).json({
      success: false,
      error: 'Authentication required.',
    });
    return;
  }

  // ---- 2. Body shape guard ----
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

  // ---- 3. Required field checks ----

  const name = body['name'];
  if (!isNonEmptyString(name)) {
    res.status(400).json({
      success: false,
      error: 'name is required.',
    });
    return;
  }

  const displayName = body['displayName'];
  if (!isNonEmptyString(displayName)) {
    res.status(400).json({
      success: false,
      error: 'displayName is required.',
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

  const maxResults = body['maxResults'];
  if (!isNumber(maxResults)) {
    res.status(400).json({
      success: false,
      error: 'maxResults must be a number.',
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

  // ---- 4. Build the payload and delegate ----
  // The payload object is typed as `PresetCreatePayload` so the
  // compiler verifies that every required field is present. The
  // `name` field on the payload is the slug-form identifier; the
  // service does not accept a `userId` field on this payload by
  // design — see the service header.
  const payload = {
    name,
    displayName,
    sourceCount,
    wordCount,
    searchEngines,
    resultsPerPage,
    maxResults,
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

  const preset = await createPresetService(userId, payload);

  // ---- 5. Respond ----
  res.status(201).json({
    success: true,
    data: preset,
  });
};

// ============================================================
//  PATCH /api/settings/presets/:id
// ============================================================

/**
 * Apply a partial update to a preset the authenticated user owns.
 * System presets (`userId: null`) are not updatable through this
 * endpoint — the service's write filter excludes the system
 * scope, and the terminal middleware converts the resulting
 * service error into a 404.
 *
 * Flow:
 *
 *   1. Reject with 401 if no authenticated user is attached.
 *   2. Reject with 400 if the `:id` route parameter is missing
 *      or empty.
 *   3. Reject with 400 if the request body is not a plain object.
 *   4. For every field present in the body, validate its type
 *      and copy it into the patch. Fields omitted from the body
 *      are left unchanged on the document.
 *   5. Delegate to the service. A body with no recognized fields
 *      is a valid no-op — the service short-circuits and returns
 *      the current document, having verified ownership first.
 *   6. Respond with 200 and the updated preset.
 *
 * The `name` field is deliberately not read from the body. See
 * the file header for why a preset's slug is immutable through
 * the API.
 */
export const updatePreset = async (
  req: AuthRequest,
  res: Response<ApiResponse<Preset>>
): Promise<void> => {
  // ---- 1. Authentication guard ----
  const userId = req.user?.userId;
  if (!userId) {
    res.status(401).json({
      success: false,
      error: 'Authentication required.',
    });
    return;
  }

  // ---- 2. Route parameter guard ----
  const presetId = req.params['id'];
  if (!isNonEmptyString(presetId)) {
    res.status(400).json({
      success: false,
      error: 'Preset ID is required.',
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

  // ---- 4. Build the patch field-by-field ----
  // The patch type is `Partial<PresetCreatePayload>` — every
  // field optional. Fields are added to the patch only when they
  // are present in the body AND pass validation.
  const patch: Partial<{
    displayName: string;
    sourceCount: number;
    wordCount: number;
    searchEngines: string[];
    resultsPerPage: number;
    maxResults: number;
    pageLoadTimeout: number;
    maxRetries: number;
    targetReadingGrade: [number, number];
    minKeywordDensity: number;
    maxKeywordDensity: number;
    maxTfidfSimilarity: number;
    maxSemanticSimilarity: number;
    maxAiMarkers: number;
    runReadabilityCheck: boolean;
    runSeoCheck: boolean;
    runOriginalityCheck: boolean;
    runAiMarkerCheck: boolean;
    runGrammarCheck: boolean;
    autoRegenerate: boolean;
    maxRegenerationAttempts: number;
  }> = {};

  const displayName = body['displayName'];
  if (displayName !== undefined) {
    if (!isNonEmptyString(displayName)) {
      res.status(400).json({
        success: false,
        error: 'displayName must be a non-empty string.',
      });
      return;
    }
    patch.displayName = displayName;
  }

  const sourceCount = body['sourceCount'];
  if (sourceCount !== undefined) {
    if (!isNumber(sourceCount)) {
      res.status(400).json({
        success: false,
        error: 'sourceCount must be a number.',
      });
      return;
    }
    patch.sourceCount = sourceCount;
  }

  const wordCount = body['wordCount'];
  if (wordCount !== undefined) {
    if (!isNumber(wordCount)) {
      res.status(400).json({
        success: false,
        error: 'wordCount must be a number.',
      });
      return;
    }
    patch.wordCount = wordCount;
  }

  const searchEngines = body['searchEngines'];
  if (searchEngines !== undefined) {
    if (!isStringArray(searchEngines)) {
      res.status(400).json({
        success: false,
        error: 'searchEngines must be an array of strings.',
      });
      return;
    }
    patch.searchEngines = searchEngines;
  }

  const resultsPerPage = body['resultsPerPage'];
  if (resultsPerPage !== undefined) {
    if (!isNumber(resultsPerPage)) {
      res.status(400).json({
        success: false,
        error: 'resultsPerPage must be a number.',
      });
      return;
    }
    patch.resultsPerPage = resultsPerPage;
  }

  const maxResults = body['maxResults'];
  if (maxResults !== undefined) {
    if (!isNumber(maxResults)) {
      res.status(400).json({
        success: false,
        error: 'maxResults must be a number.',
      });
      return;
    }
    patch.maxResults = maxResults;
  }

  const pageLoadTimeout = body['pageLoadTimeout'];
  if (pageLoadTimeout !== undefined) {
    if (!isNumber(pageLoadTimeout)) {
      res.status(400).json({
        success: false,
        error: 'pageLoadTimeout must be a number.',
      });
      return;
    }
    patch.pageLoadTimeout = pageLoadTimeout;
  }

  const maxRetries = body['maxRetries'];
  if (maxRetries !== undefined) {
    if (!isNumber(maxRetries)) {
      res.status(400).json({
        success: false,
        error: 'maxRetries must be a number.',
      });
      return;
    }
    patch.maxRetries = maxRetries;
  }

  const targetReadingGrade = body['targetReadingGrade'];
  if (targetReadingGrade !== undefined) {
    if (!isNumberTuple2(targetReadingGrade)) {
      res.status(400).json({
        success: false,
        error: 'targetReadingGrade must be a 2-element array of numbers.',
      });
      return;
    }
    patch.targetReadingGrade = targetReadingGrade;
  }

  const minKeywordDensity = body['minKeywordDensity'];
  if (minKeywordDensity !== undefined) {
    if (!isNumber(minKeywordDensity)) {
      res.status(400).json({
        success: false,
        error: 'minKeywordDensity must be a number.',
      });
      return;
    }
    patch.minKeywordDensity = minKeywordDensity;
  }

  const maxKeywordDensity = body['maxKeywordDensity'];
  if (maxKeywordDensity !== undefined) {
    if (!isNumber(maxKeywordDensity)) {
      res.status(400).json({
        success: false,
        error: 'maxKeywordDensity must be a number.',
      });
      return;
    }
    patch.maxKeywordDensity = maxKeywordDensity;
  }

  const maxTfidfSimilarity = body['maxTfidfSimilarity'];
  if (maxTfidfSimilarity !== undefined) {
    if (!isNumber(maxTfidfSimilarity)) {
      res.status(400).json({
        success: false,
        error: 'maxTfidfSimilarity must be a number.',
      });
      return;
    }
    patch.maxTfidfSimilarity = maxTfidfSimilarity;
  }

  const maxSemanticSimilarity = body['maxSemanticSimilarity'];
  if (maxSemanticSimilarity !== undefined) {
    if (!isNumber(maxSemanticSimilarity)) {
      res.status(400).json({
        success: false,
        error: 'maxSemanticSimilarity must be a number.',
      });
      return;
    }
    patch.maxSemanticSimilarity = maxSemanticSimilarity;
  }

  const maxAiMarkers = body['maxAiMarkers'];
  if (maxAiMarkers !== undefined) {
    if (!isNumber(maxAiMarkers)) {
      res.status(400).json({
        success: false,
        error: 'maxAiMarkers must be a number.',
      });
      return;
    }
    patch.maxAiMarkers = maxAiMarkers;
  }

  const runReadabilityCheck = body['runReadabilityCheck'];
  if (runReadabilityCheck !== undefined) {
    if (!isBoolean(runReadabilityCheck)) {
      res.status(400).json({
        success: false,
        error: 'runReadabilityCheck must be a boolean.',
      });
      return;
    }
    patch.runReadabilityCheck = runReadabilityCheck;
  }

  const runSeoCheck = body['runSeoCheck'];
  if (runSeoCheck !== undefined) {
    if (!isBoolean(runSeoCheck)) {
      res.status(400).json({
        success: false,
        error: 'runSeoCheck must be a boolean.',
      });
      return;
    }
    patch.runSeoCheck = runSeoCheck;
  }

  const runOriginalityCheck = body['runOriginalityCheck'];
  if (runOriginalityCheck !== undefined) {
    if (!isBoolean(runOriginalityCheck)) {
      res.status(400).json({
        success: false,
        error: 'runOriginalityCheck must be a boolean.',
      });
      return;
    }
    patch.runOriginalityCheck = runOriginalityCheck;
  }

  const runAiMarkerCheck = body['runAiMarkerCheck'];
  if (runAiMarkerCheck !== undefined) {
    if (!isBoolean(runAiMarkerCheck)) {
      res.status(400).json({
        success: false,
        error: 'runAiMarkerCheck must be a boolean.',
      });
      return;
    }
    patch.runAiMarkerCheck = runAiMarkerCheck;
  }

  const runGrammarCheck = body['runGrammarCheck'];
  if (runGrammarCheck !== undefined) {
    if (!isBoolean(runGrammarCheck)) {
      res.status(400).json({
        success: false,
        error: 'runGrammarCheck must be a boolean.',
      });
      return;
    }
    patch.runGrammarCheck = runGrammarCheck;
  }

  const autoRegenerate = body['autoRegenerate'];
  if (autoRegenerate !== undefined) {
    if (!isBoolean(autoRegenerate)) {
      res.status(400).json({
        success: false,
        error: 'autoRegenerate must be a boolean.',
      });
      return;
    }
    patch.autoRegenerate = autoRegenerate;
  }

  const maxRegenerationAttempts = body['maxRegenerationAttempts'];
  if (maxRegenerationAttempts !== undefined) {
    if (!isNumber(maxRegenerationAttempts)) {
      res.status(400).json({
        success: false,
        error: 'maxRegenerationAttempts must be a number.',
      });
      return;
    }
    patch.maxRegenerationAttempts = maxRegenerationAttempts;
  }

  // ---- 5. Delegate to the service ----
  const preset = await updatePresetService(userId, presetId, patch);

  // ---- 6. Respond ----
  res.status(200).json({
    success: true,
    data: preset,
  });
};

// ============================================================
//  DELETE /api/settings/presets/:id
// ============================================================

/**
 * Delete a preset the authenticated user owns. System presets
 * (`userId: null`) are not deletable through this endpoint — the
 * service's write filter excludes the system scope, and the
 * terminal middleware converts the resulting service error into
 * a 404.
 *
 * Flow:
 *
 *   1. Reject with 401 if no authenticated user is attached.
 *   2. Reject with 400 if the `:id` route parameter is missing
 *      or empty.
 *   3. Delegate to the service. The service returns the deleted
 *      document so the client can render an undo affordance
 *      without a second read.
 *   4. Respond with 200 and the deleted preset.
 *
 * Presets have no children — deleting a preset does not affect
 * any topic or article that was previously configured with it.
 * The topic model stores its pipeline configuration on itself at
 * creation time; the preset is a template, not a live reference.
 */
export const deletePreset = async (
  req: AuthRequest,
  res: Response<ApiResponse<Preset>>
): Promise<void> => {
  // ---- 1. Authentication guard ----
  const userId = req.user?.userId;
  if (!userId) {
    res.status(401).json({
      success: false,
      error: 'Authentication required.',
    });
    return;
  }

  // ---- 2. Route parameter guard ----
  const presetId = req.params['id'];
  if (!isNonEmptyString(presetId)) {
    res.status(400).json({
      success: false,
      error: 'Preset ID is required.',
    });
    return;
  }

  // ---- 3. Delegate to the service ----
  const preset = await deletePresetService(userId, presetId);

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
  getUserSettings,
  updateUserSettings,
  listPresets,
  createPreset,
  getPresetById,
  updatePreset,
  deletePreset,
};