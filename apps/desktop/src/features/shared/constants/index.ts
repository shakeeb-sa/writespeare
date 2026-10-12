/**
 * WriteSpeare — shared constants.
 *
 * The app's shared constants — the values that more than one
 * feature needs and that must not drift between the places that
 * reference them. Everything in this file is either a primitive
 * (a string, a number) or a closed set of primitives represented
 * as a readonly tuple with a matching literal-type alias.
 *
 * Why this module is a leaf:
 *
 *   This file imports nothing. Every symbol it exports is either
 *   a literal value or a type derived from a literal value using
 *   TypeScript's own `as const` / `typeof` machinery. That
 *   property matters because it is the first file of Session 5 —
 *   the "shared UI" session — and every other shared module
 *   (the types file, the API client, the UI components) either
 *   imports from this one or from nothing. A leaf that requires
 *   no other file to exist before it can compile is what makes
 *   it safe to create first.
 *
 * Why the preset and profile names are exported as both a
 * runtime array and a derived type:
 *
 *   The two closed sets — the set of preset names and the set of
 *   profile names — are consumed in two different ways by the
 *   rest of the codebase:
 *
 *     - At runtime, as iterable lists. The preset selector and
 *       the profile picker in the New Topic modal both need to
 *       render one option per name; both need an array to `.map`
 *       over. The arrays exported here are that array.
 *
 *     - At compile time, as literal-union types. Every service,
 *       store, and IPC handler that carries a preset name or a
 *       profile name needs the type to be the specific union, not
 *       `string`. The two type aliases derived below — via
 *       `(typeof ARRAY)[number]` — give exactly that literal
 *       union without redeclaring the list of names in two forms.
 *
 *   The alternative — declaring the union type by hand and the
 *   array separately — has the classic drift risk: someone adds
 *   a preset to the array but forgets to add it to the union (or
 *   vice versa), and the compiler either complains in a confusing
 *   place or, worse, accepts a mismatch that surfaces as a
 *   runtime bug. Deriving the type from the array makes the array
 *   the single source of truth; the compiler automatically
 *   narrows any consumer of `PresetName` to exactly the strings
 *   the array contains.
 *
 * Relationship to the backend's mirror declarations:
 *
 *   The backend's `apps/server/src/features/shared/types/index.ts`
 *   declares the same two unions — `PresetName` and
 *   `ProfileName` — because the desktop app and the backend are
 *   independent compilation units and neither can import from
 *   the other. The two declarations are kept in sync by hand.
 *   When a new preset or profile is added on one side, the
 *   corresponding array on the other side must be updated in the
 *   same change, or a request that the desktop considers legal
 *   will be rejected by the backend's schema (or vice versa).
 *   This is the accepted cost of the two-app architecture; the
 *   alternative — a shared package — was considered and rejected
 *   in the plan because it would force the backend and the
 *   desktop to be built and deployed together.
 */

// ============================================================
//  Identity
// ============================================================

/**
 * The product's display name. Used in window titles, toast
 * messages, log lines, and any user-facing string that needs to
 * name the app.
 *
 * Declared here rather than read from `package.json` at runtime
 * because the renderer bundle does not have filesystem access —
 * and because a template-literal import from package.json would
 * force the bundler to inline the entire manifest, which carries
 * far more than the one field anyone needs.
 */
export const APP_NAME = 'WriteSpeare';

// ============================================================
//  API
// ============================================================

/**
 * The default base URL for the backend API.
 *
 * In development, the backend runs on `http://localhost:5000` —
 * the port is the `DEFAULT_PORT` constant declared in the
 * backend's `src/index.ts`. The `/api` suffix is the mount prefix
 * every backend route lives under.
 *
 * At runtime, the renderer does not read this constant directly.
 * The main process owns the actual URL, which can be overridden
 * from the settings page (the app supports pointing at a
 * self-hosted backend), and exposes the current value to the
 * renderer via the `config:getApiBaseUrl` IPC channel. This
 * constant is the fallback the main process uses when no override
 * has been configured, and the default the settings page shows
 * in its "API base URL" field.
 *
 * The URL has no trailing slash — the axios client concatenates
 * paths with a leading slash (`/topics`, `/auth/login`), and a
 * trailing slash on the base would produce `//topics`, which
 * some proxies reject. The rule "no trailing slash on the base"
 * is enforced by convention, not by a runtime check; a wrong
 * value here would be caught the first time the app made a
 * request.
 */
export const API_BASE_URL = 'http://localhost:5000/api';

// ============================================================
//  Pipeline defaults
// ============================================================

/**
 * The default number of source documents a new topic fetches.
 *
 * Applied when the user creates a topic without changing the
 * source count from the New Topic modal's field. The number
 * matches the backend schema's default for the `sourceCount`
 * field, so a topic created with this value and a topic created
 * without any source count at all produce the same result.
 */
export const MAX_SOURCES_DEFAULT = 10;

/**
 * The default target word count for a generated article.
 *
 * Applied when the user creates a topic without changing the
 * word count field. Matches the backend schema's default for the
 * `wordCount` field.
 */
export const MAX_WORDS_DEFAULT = 1200;

/**
 * The lower and upper bounds of the `sourceCount` field,
 * mirroring the backend schema's `min` and `max` validators.
 *
 * These exist on the renderer side so the New Topic modal can
 * clamp the input before submitting — a client that submits a
 * value outside the bounds would receive a 400 from the backend
 * and show the user a schema error, which is a worse experience
 * than the picker simply refusing to go out of range.
 *
 * The two constants are not the source of truth. The backend
 * schema is. If the bounds are ever changed on the backend, this
 * file must be changed in the same commit.
 */
export const MIN_SOURCES = 1;
export const MAX_SOURCES = 50;

/**
 * The lower and upper bounds of the `wordCount` field, mirroring
 * the backend schema's validators. Same reasoning and the same
 * "not the source of truth" caveat as the source-count bounds.
 */
export const MIN_WORDS = 100;
export const MAX_WORDS = 10000;

// ============================================================
//  Search buckets
// ============================================================
//
//  The four time-range buckets the search step queries. Each
//  bucket is an independent search invocation with its own
//  result set; the sum of the four buckets' counts is what a
//  topic's `sourceCount` — and a preset's `defaultBucketLayout`,
//  and a user's `defaultBucketLayout` — totals to. The bucket
//  identifiers are what the Python search scripts accept on
//  their `--time-range` argument, what the renderer's research
//  store keys its per-bucket candidate and progress records on,
//  and what the Search Distribution section of the New Topic
//  modal groups its inputs under.

/**
 * The closed set of time-range bucket identifiers.
 *
 * The four values match the strings the Python search scripts
 * accept on their `--time-range` argument (see
 * `research/google_search.py` and `research/duckduckgo_search.py`)
 * and the keys the renderer's research store uses in its
 * per-bucket candidate and progress records.
 *
 * The array is `readonly` and declared with `as const` so
 * TypeScript infers it as a tuple of literal string types rather
 * than as `string[]`; that inference is what makes the
 * `BucketKey` type below resolve to the literal union rather
 * than to `string`.
 */
export const BUCKET_KEYS = [
  'anytime',
  'year',
  'month',
  'week',
] as const;

/**
 * The literal-union type of bucket identifiers, derived from the
 * `BUCKET_KEYS` tuple above. Consumers that want the type should
 * import this, not redeclare it — a redeclaration would drift
 * the moment the tuple changed.
 *
 * The union is the canonical shape for the `searchBuckets` field
 * on `Topic`, the `defaultBucketLayout` field on `Preset` and
 * `UserSettingsMap`, and the renderer's per-bucket records in
 * the research store.
 */
export type BucketKey = (typeof BUCKET_KEYS)[number];

/**
 * Human-readable labels for each bucket, keyed by identifier.
 *
 * Declared as a `Record<BucketKey, string>` rather than a plain
 * object so that the compiler enforces exhaustiveness: a new
 * bucket added to `BUCKET_KEYS` without a corresponding label
 * here is a compile error. The labels are what the four
 * collapsible sections in the Sources tab render, what the
 * Search Distribution section's four inputs are labeled with,
 * and what the overall-progress line names each bucket by.
 */
export const BUCKET_LABELS: Record<BucketKey, string> = {
  anytime: 'Any time',
  year: 'Past year',
  month: 'Past month',
  week: 'Past week',
};

// ============================================================
//  Preset names
// ============================================================

/**
 * The closed set of preset identifiers.
 *
 * The four values are the three system presets shipped with the
 * app plus the sentinel `'custom'`, which marks a topic that has
 * been configured with settings not matching any named preset.
 * The `'custom'` value is not a selectable preset in the picker;
 * it exists so that a topic's `preset` field has a well-typed
 * value in the case where the user has overridden the preset's
 * defaults through the Advanced Settings panel.
 *
 * The array is `readonly` and declared with `as const` so that
 * TypeScript infers it as a tuple of literal string types rather
 * than as `string[]`. That inference is what makes the
 * `PresetName` type below resolve to the literal union rather
 * than to `string`.
 */
export const PRESET_NAMES = [
  'quick',
  'balanced',
  'deep',
  'custom',
] as const;

/**
 * The literal-union type of preset identifiers, derived from the
 * `PRESET_NAMES` tuple above. Consumers that want the type should
 * import this, not redeclare it — a redeclaration would drift the
 * moment the tuple changed.
 */
export type PresetName = (typeof PRESET_NAMES)[number];

/**
 * Human-readable labels for each preset, keyed by identifier.
 *
 * Declared as a `Record<PresetName, string>` rather than a plain
 * object so that the compiler enforces exhaustiveness: if a new
 * preset identifier is added to `PRESET_NAMES` and the label is
 * not added here, the assignment fails to type-check. That is the
 * exact failure mode this map exists to prevent — a preset that
 * is selectable but renders as `undefined` in the picker.
 */
export const PRESET_LABELS: Record<PresetName, string> = {
  quick: 'Quick',
  balanced: 'Balanced',
  deep: 'Deep',
  custom: 'Custom',
};

/**
 * A one-line description of each preset, for display under the
 * label in the preset picker. Same exhaustiveness guarantee as
 * `PRESET_LABELS` — the `Record<PresetName, string>` type forces
 * one entry per identifier.
 *
 * The descriptions describe each preset's search distribution as
 * a total source count across the four time-range buckets. The
 * number shown here is the sum of the four bucket counts the
 * preset's `defaultBucketLayout` carries, and it is the same
 * number the Search Distribution section of the New Topic modal
 * surfaces as the preset's default layout:
 *
 *   Quick    — 15 sources across four time ranges, 800 words.
 *   Balanced — 30 sources across four time ranges, 1200 words.
 *   Deep     — 60 sources across four time ranges, 2000+ words.
 *
 * The `custom` description exists because the type demands an
 * entry, even though the picker never shows `custom` as a
 * selectable option. The text reflects what the value means when
 * it appears as a topic's state.
 */
export const PRESET_DESCRIPTIONS: Record<PresetName, string> = {
  quick: '15 sources across four time ranges, 800 words. Fast — good for a first draft.',
  balanced: '30 sources across four time ranges, 1200 words. The recommended default.',
  deep: '60 sources across four time ranges, 2000+ words. For in-depth, pillar content.',
  custom: 'Configured with custom settings.',
};

// ============================================================
//  Profile names
// ============================================================

/**
 * The closed set of content profile identifiers.
 *
 * A profile determines the tone and structure the writer prompt
 * aims for. The four values cover the four most common article
 * shapes the plan's user journey describes.
 */
export const PROFILE_NAMES = [
  'blog-post',
  'news-article',
  'product-review',
  'academic',
] as const;

/**
 * The literal-union type of profile identifiers, derived from the
 * `PROFILE_NAMES` tuple above.
 */
export type ProfileName = (typeof PROFILE_NAMES)[number];

/**
 * Human-readable labels for each profile, keyed by identifier.
 * Same exhaustiveness guarantee as `PRESET_LABELS`.
 */
export const PROFILE_LABELS: Record<ProfileName, string> = {
  'blog-post': 'Blog Post',
  'news-article': 'News Article',
  'product-review': 'Product Review',
  academic: 'Academic',
};