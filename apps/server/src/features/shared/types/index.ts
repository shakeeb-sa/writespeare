/**
 * Shared domain types for the WriteSpeare backend.
 *
 * This module is the single source of truth for every domain
 * shape, payload, and API envelope used across the server. It is
 * intentionally dependency-free at runtime — the only external
 * reference is a type-only import of Mongoose's `ObjectId`, which
 * the compiler resolves without emitting a require. That keeps the
 * module safe to import from any layer (models, services,
 * controllers, routes, utilities) without triggering circular
 * dependency warnings.
 *
 * Naming conventions applied throughout:
 *   - Domain entities use PascalCase noun names (`Topic`, `Article`).
 *   - "Payload" suffix marks an input shape (create or update),
 *     always distinct from the entity it maps to.
 *   - "Report" is used both as a noun (the entity) and as a
 *     compound field name inside `Report` — the ambiguity is
 *     resolved by the capitalisation: `Report` is the entity,
 *     `readability`, `seo`, etc. are sections inside it.
 *   - Status unions are string literal types, not enums, so they
 *     serialise naturally to JSON and match the strings written
 *     by the Python validators without a runtime conversion step.
 */

// ============================================================
//  Mongoose type helper
// ============================================================

/**
 * The runtime type Mongoose uses for `_id` on documents that do
 * not declare a custom `_id`. Aliased here so every interface
 * reads `_id: MongoId` instead of repeating the dynamic import
 * syntax, and so a future migration to a different ODM has a
 * single point of change.
 *
 * The `string` half of the union covers the JSON-serialised form
 * that leaves the backend via `res.json()` — the wire format is a
 * string, but inside the process the value is an ObjectId.
 */
export type MongoId = string | import('mongoose').Types.ObjectId;

// ============================================================
//  API response envelopes
// ============================================================

/**
 * Every API response — success or failure — flows through this
 * envelope. The `success` flag is the discriminator; on `true`,
 * `data` carries the payload; on `false`, `error` carries a
 * human-readable message. `message` is reserved for optional
 * non-fatal context (e.g. "Synced 42 records") that a caller may
 * surface as a toast without treating the response as a failure.
 *
 * `T` defaults to `unknown` rather than `any` so call sites that
 * do not specify a payload type are forced to narrow before
 * accessing fields. In practice every handler specifies `T`
 * explicitly.
 */
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  message?: string;
  error?: string;
}

/**
 * Standard shape for list endpoints that support pagination.
 * `totalPages` is precomputed here rather than left to the client
 * so the UI can render a pager without a second round trip.
 */
export interface PaginatedResponse<T = unknown> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

// ============================================================
//  User & Authentication
// ============================================================

/**
 * Access level of a user account.
 *
 *   ADMIN — super-admin. Full access to user management and
 *           global configuration endpoints.
 *   USER  — regular user. Access restricted to their own topics,
 *           documents, articles, reports, and settings.
 */
export enum UserRole {
  ADMIN = 'admin',
  USER = 'user',
}

/**
 * The canonical user record as stored in MongoDB. `passwordHash`
 * is present on the entity but must never be returned over the
 * wire — every controller strips it before serialising, and the
 * model marks the field `select: false` so a naive `.find()`
 * omits it by default.
 */
export interface User {
  _id: MongoId;
  email: string;
  passwordHash: string;
  role: UserRole;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Input shape for creating a user. `password` is the plaintext
 * that the auth service hashes before persisting. `role` and
 * `active` default to `USER` and `true` respectively when omitted.
 */
export interface UserCreatePayload {
  email: string;
  password: string;
  role?: UserRole;
  active?: boolean;
}

/**
 * Input shape for updating a user. Every field is optional — the
 * service merges the patch onto the existing document. If
 * `password` is provided it is hashed; if omitted, the existing
 * hash is preserved unchanged.
 */
export interface UserUpdatePayload {
  email?: string;
  password?: string;
  role?: UserRole;
  active?: boolean;
}

/**
 * Login request body. Accepted by `POST /api/auth/login`.
 */
export interface LoginRequest {
  email: string;
  password: string;
}

/**
 * Login response body. The `user` object here is the same shape
 * the `/api/auth/me` endpoint returns — a projection of `User`
 * with `passwordHash` removed.
 */
export interface LoginResponse {
  user: Omit<User, 'passwordHash'>;
  token: string;
}

// ============================================================
//  Topic (the unit of work for a single article)
// ============================================================

/**
 * Lifecycle state of a topic.
 *
 *   draft        — created, no work started.
 *   researching  — search step in flight.
 *   extracting   — source documents being fetched.
 *   extracted    — docs on disk, awaiting writer step.
 *   writing      — DeepSeek automation in flight.
 *   validating   — validation step in flight.
 *   completed    — article exists, report exists, ready to export.
 *   failed       — last step ended in an unrecoverable error;
 *                  the `error` field on the topic carries details.
 */
export type TopicStatus =
  | 'draft'
  | 'researching'
  | 'extracting'
  | 'extracted'
  | 'writing'
  | 'validating'
  | 'completed'
  | 'failed';

/**
 * Identifier for a preset bundle. The three named values are the
 * system presets shipped with the app. `custom` is used when the
 * user has built their own preset; the actual override values
 * live in the `Preset` document keyed by `name`.
 */
export type PresetName = 'quick' | 'balanced' | 'deep' | 'custom';

/**
 * Content profile — controls tone, structure, and default
 * length that the prompt template will target.
 */
export type ProfileName =
  | 'blog-post'
  | 'news-article'
  | 'product-review'
  | 'academic';

/**
 * A single topic — the atomic unit of work in WriteSpeare.
 * One topic owns one pipeline: search → extraction → writing →
 * validation → export. Every document, article, and report
 * references its owning topic by `_id`.
 *
 * All ownership is enforced by `userId`: a user can only see or
 * mutate topics where `topic.userId === req.user.userId`.
 */
export interface Topic {
  _id: MongoId;
  userId: MongoId;
  title: string;
  keywords: string[];
  preset: PresetName;
  profile: ProfileName;
  promptFile: string;
  wordCount: number;
  /**
   * The four time-range buckets the search step fills for this
   * topic. Snapshotted from the chosen preset's `defaultBucketLayout`
   * at creation time; the sum of the four values equals
   * `sourceCount`.
   */
  searchBuckets: {
    anyTime: number;
    pastYear: number;
    pastMonth: number;
    pastWeek: number;
  };
  /**
   * Total sources to fetch per topic. Derived from the sum of
   * `searchBuckets`'s four bucket counts; stored as a materialised
   * aggregate so a caller which only needs the total does not have
   * to fetch and sum the bucket object itself.
   */
  sourceCount: number;
  status: TopicStatus;
  /** Populated only when `status === 'failed'`. */
  error?: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Input shape for creating a topic. `userId` is derived from the
 * authenticated request, never from the payload — a caller cannot
 * create a topic on behalf of another user.
 */
export interface TopicCreatePayload {
  title: string;
  keywords?: string[];
  preset?: PresetName;
  profile?: ProfileName;
  promptFile?: string;
  wordCount?: number;
  /**
   * The four time-range buckets the search step should fill. When
   * provided, the topic service derives `sourceCount` as the sum of
   * the four values. When omitted, the service synthesises a bucket
   * layout from `sourceCount` for backward compatibility — see the
   * topic service for the derivation rule.
   */
  searchBuckets?: {
    anyTime: number;
    pastYear: number;
    pastMonth: number;
    pastWeek: number;
  };
  sourceCount?: number;
}

/**
 * Input shape for updating a topic. Every field is optional; the
 * service merges. `userId` and `createdAt` are immutable and are
 * not part of this payload by construction.
 */
export interface TopicUpdatePayload {
  title?: string;
  keywords?: string[];
  preset?: PresetName;
  profile?: ProfileName;
  promptFile?: string;
  wordCount?: number;
  /**
   * The four time-range buckets the search step should fill for
   * this topic. Same derivation rule as `TopicCreatePayload`: when
   * provided, the topic service recomputes `sourceCount` from the
   * sum; when omitted, both fields keep their current values.
   */
  searchBuckets?: {
    anyTime: number;
    pastYear: number;
    pastMonth: number;
    pastWeek: number;
  };
  sourceCount?: number;
  status?: TopicStatus;
  error?: string;
}

// ============================================================
//  Document (one scraped source page)
// ============================================================

/**
 * A single scraped source page attached to a topic. `content` is
 * the extracted Markdown body of the page (with YAML frontmatter
 * already stripped by the extraction pipeline), sized at a few
 * kilobytes in the common case and capped at ~20 KB by the
 * extractor's word-count guard.
 *
 * `platform` is a short slug identifying the source site
 * (`'reddit'`, `'quora'`, `'medium'`, `'generic'`). The renderer
 * uses it to badge each document in the list.
 */
export interface Document {
  _id: MongoId;
  topicId: MongoId;
  userId: MongoId;
  url: string;
  platform: string;
  title: string;
  content: string;
  wordCount: number;
  fetchedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Input shape for persisting a scraped document. `userId` is
 * derived from the request; `_id`, `createdAt`, and `updatedAt`
 * are set by Mongoose.
 */
export interface DocumentCreatePayload {
  topicId: MongoId;
  url: string;
  platform: string;
  title: string;
  content: string;
  wordCount: number;
  fetchedAt: Date;
}

// ============================================================
//  Article (the generated output)
// ============================================================

/**
 * Lifecycle state of a generated article.
 *
 *   draft     — the article as first returned by the writer.
 *   validated — a report has been produced against it.
 *   exported  — the user has exported it to a file.
 */
export type ArticleStatus = 'draft' | 'validated' | 'exported';

/**
 * A generated article. `version` starts at 1 and increments each
 * time the user requests a regeneration of the same topic; the
 * highest-version article is the "current" one. The `content`
 * field holds the Markdown text with the H1 title preserved.
 */
export interface Article {
  _id: MongoId;
  topicId: MongoId;
  userId: MongoId;
  content: string;
  wordCount: number;
  version: number;
  status: ArticleStatus;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Input shape for persisting a generated article. `userId` is
 * derived from the request; `version` and status defaults are
 * computed by the service.
 */
export interface ArticleCreatePayload {
  topicId: MongoId;
  content: string;
  wordCount: number;
}

// ============================================================
//  Report (validation output for one article)
// ============================================================

/**
 * Per-section pass/warn/fail classification. Sections that meet
 * every threshold read as `good`; sections that miss one or more
 * soft thresholds read as `warning`; sections that miss a hard
 * threshold read as `fail`.
 */
export type ReportStatus = 'good' | 'warning' | 'fail';

/**
 * Readability section. Values are produced by `textstat` on the
 * article body (Markdown markup stripped).
 */
export interface ReadabilityReport {
  /** 0–100, higher is easier to read. Plain-English band: 60–70. */
  fleschReadingEase: number;
  /** Approximate US school grade level. Target band: 7–9. */
  fleschKincaidGrade: number;
  /** Gunning Fog index. Target: under 12. */
  gunningFog: number;
  /** SMOG index. Target: under 12. */
  smogIndex: number;
  /** Average words per sentence across the article. */
  avgSentenceLength: number;
  /** Estimated reading time for an average adult reader, in seconds. */
  readingTimeSeconds: number;
  status: ReportStatus;
}

/**
 * Structural SEO section. Measures shape, not content quality —
 * heading counts, paragraph sizes, and the ratio of passive to
 * active voice.
 */
export interface SeoReport {
  wordCount: number;
  h2Count: number;
  h3Count: number;
  /** Average words per paragraph, split on blank-line boundaries. */
  avgParagraphWords: number;
  /** 0–1; fraction of sentences flagged as passive by the parser. */
  passiveVoicePercent: number;
  /** 0–1; fraction of sentences containing a transition word. */
  transitionWordsPercent: number;
  status: ReportStatus;
}

/**
 * Per-keyword placement and density. One of these per keyword the
 * user supplied on the topic, plus any keyword extracted from the
 * source corpus and accepted by the user.
 */
export interface KeywordReportEntry {
  keyword: string;
  priority: 'primary' | 'secondary' | 'supporting';
  /** Total occurrences in the article body. */
  count: number;
  /** `count / wordCount`, expressed as a fraction (0–1). */
  density: number;
  /** Whether the keyword appears in the H1 title. */
  inTitle: boolean;
  /** Whether the keyword appears in the first 100 words. */
  inIntro: boolean;
  /** Number of H2 sections whose heading contains the keyword. */
  inH2Count: number;
  status: ReportStatus;
}

/**
 * Wrapper around the per-keyword entries so the section carries
 * its own aggregate status, matching the shape of every other
 * section in the report.
 */
export interface KeywordReport {
  keywords: KeywordReportEntry[];
  status: ReportStatus;
}

/**
 * One sentence from the generated article that scored above the
 * configured similarity threshold against one or more source
 * documents. Rendered in the report so the user can see exactly
 * which sentences need rewriting if the corrective loop is not
 * enabled.
 */
export interface FlaggedSentence {
  text: string;
  /** 0–1; the highest similarity this sentence scored against any source. */
  similarity: number;
  /** Human-readable label of the source document it matched. */
  sourceTitle: string;
}

/**
 * Originality section. Two independent similarity signals are
 * reported side by side: TF-IDF catches lexical overlap, semantic
 * similarity catches paraphrase.
 */
export interface OriginalityReport {
  /** Highest TF-IDF cosine similarity against any source doc. */
  maxTfidfSimilarity: number;
  /** Highest embedding cosine similarity against any source doc. */
  maxSemanticSimilarity: number;
  flaggedSentences: FlaggedSentence[];
  status: ReportStatus;
}

/**
 * One overused AI-tell phrase and how many times it appeared.
 */
export interface AiMarkerEntry {
  phrase: string;
  count: number;
}

/**
 * AI-marker section. Counts occurrences of phrases that are
 * statistically over-represented in LLM output. A count over the
 * configured threshold is a soft signal to rewrite, not a hard
 * failure.
 */
export interface AiMarkersReport {
  markerCount: number;
  markers: AiMarkerEntry[];
  status: ReportStatus;
}

/**
 * One grammatical or stylistic issue raised by LanguageTool.
 * `offset` and `length` are character positions in the article
 * body, used by the UI to highlight the offending span.
 */
export interface GrammarIssue {
  ruleId: string;
  message: string;
  offset: number;
  length: number;
  /** Ordered list of suggested replacement strings. */
  replacements: string[];
}

/**
 * Grammar section. Issue counts over the configured threshold
 * produce a `warning`; a critical rule violation produces `fail`.
 */
export interface GrammarReport {
  issueCount: number;
  issues: GrammarIssue[];
  status: ReportStatus;
}

/**
 * The complete validation report for one article. Every section
 * is required — a report is only written when all six validators
 * have completed, so a partially-populated report on disk would
 * indicate a bug in the runner.
 */
export interface Report {
  _id: MongoId;
  articleId: MongoId;
  topicId: MongoId;
  userId: MongoId;
  readability: ReadabilityReport;
  seo: SeoReport;
  keywords: KeywordReport;
  originality: OriginalityReport;
  aiMarkers: AiMarkersReport;
  grammar: GrammarReport;
  /** The weakest status across all six sections. */
  overallStatus: ReportStatus;
  createdAt: Date;
}

// ============================================================
//  Preset (a named bundle of pipeline settings)
// ============================================================

/**
 * A saved bundle of settings that fully describes how a topic's
 * pipeline should run. The three system presets ship with the app
 * and have `userId === null`; user-created presets have the
 * owning user's ID.
 *
 * A preset is self-contained — every field the pipeline reads at
 * run time is present here, so loading a preset replaces the
 * entire effective configuration rather than merging with a
 * global default. That guarantees the same preset produces the
 * same pipeline behaviour regardless of what else the user has
 * configured.
 */
export interface Preset {
  _id: MongoId;
  /** `null` for system presets. */
  userId: MongoId | null;
  /** Slug-form identifier: `'quick'`, `'balanced'`, `'deep'`, or a user-chosen slug. */
  name: string;
  /** Human-readable label shown in the preset picker. */
  displayName: string;
  /**
   * The four time-range buckets the search step fills. Snapshotted
   * from the preset's `defaultBucketLayout` onto each topic created
   * with the preset; the sum of the four values equals the preset's
   * `sourceCount`.
   */
  defaultBucketLayout: {
    anyTime: number;
    pastYear: number;
    pastMonth: number;
    pastWeek: number;
  };
  /**
   * Total sources to fetch per topic. Derived from the sum of
   * `defaultBucketLayout`'s four bucket counts; stored as a
   * materialised aggregate so a caller which only needs the total
   * does not have to fetch and sum the bucket object itself.
   */
  sourceCount: number;
  /** Target word count for the generated article. */
  wordCount: number;
  /** Search engine identifiers in priority order, e.g. `['google', 'duckduckgo']`. */
  searchEngines: string[];
  /** Results to read per search engine page. */
  resultsPerPage: number;

  /** Per-page navigation timeout, in milliseconds. */
  pageLoadTimeout: number;
  /** Retries per failed page load before the URL is marked as failed. */
  maxRetries: number;
  /** Acceptable range for `fleschKincaidGrade`, as `[min, max]`. */
  targetReadingGrade: [number, number];
  /** Minimum acceptable keyword density (fraction of word count). */
  minKeywordDensity: number;
  /** Maximum acceptable keyword density before flagging as stuffed. */
  maxKeywordDensity: number;
  /** Similarity ceiling for the TF-IDF check. */
  maxTfidfSimilarity: number;
  /** Similarity ceiling for the semantic check. */
  maxSemanticSimilarity: number;
  /** Maximum count of AI-tell phrases before flagging. */
  maxAiMarkers: number;
  runReadabilityCheck: boolean;
  runSeoCheck: boolean;
  runOriginalityCheck: boolean;
  runAiMarkerCheck: boolean;
  runGrammarCheck: boolean;
  /** When true, the app reruns the writer with a corrective prompt on validation failure. */
  autoRegenerate: boolean;
  /** Upper bound on regeneration attempts; prevents an infinite loop. */
  maxRegenerationAttempts: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Input shape for creating a user preset. `userId` and the
 * `isSystem` flag are set by the service, not the payload.
 */
export interface PresetCreatePayload {
  name: string;
  displayName: string;
  defaultBucketLayout: {
    anyTime: number;
    pastYear: number;
    pastMonth: number;
    pastWeek: number;
  };
  sourceCount: number;
  wordCount: number;
  searchEngines: string[];
  resultsPerPage: number;
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
}

// ============================================================
//  User settings (per-user preferences)
// ============================================================

/**
 * The user-controlled preferences that apply across every topic.
 * Per-topic values (keyword list, word count, source count,
 * preset, profile, prompt file) live on the `Topic` document
 * itself; this map only holds the choices that apply when a new
 * topic is created or when a stage completes.
 */
export interface UserSettingsMap {
  defaultPreset: PresetName;
  defaultProfile: ProfileName;
  defaultPromptFile: string;
  /**
   * The user's default time-bucketed search distribution. Used to
   * seed a new topic when no preset is applied. The four values
   * sum to the topic's derived `sourceCount`.
   */
  defaultBucketLayout: {
    anyTime: number;
    pastYear: number;
    pastMonth: number;
    pastWeek: number;
  };
  autoSaveAfterEachStage: boolean;
  notifyOnCompletion: boolean;
  theme: 'light' | 'dark';
  /**
   * Where the "Download bundle" flow writes the topic's archive
   * ZIP. `'ask'` opens a Save-As dialog on every download so the
   * user picks the location each time; `'default'` writes silently
   * to `bundleDownloadPath`.
   */
  bundleDownloadMode: 'ask' | 'default';
  /**
   * The destination path the bundle flow writes to when
   * `bundleDownloadMode` is `'default'`. Empty string when unset.
   */
  bundleDownloadPath: string;
}

/**
 * Per-user settings document. `settings` is a nested object so a
 * future addition (e.g. a new default) can be made without
 * changing the outer schema or requiring a migration on the
 * collection level — Mongoose's Mixed handling of the inner
 * object absorbs additions transparently.
 */
export interface UserSetting {
  _id: MongoId;
  userId: MongoId;
  settings: UserSettingsMap;
  createdAt: Date;
  updatedAt: Date;
}

// ============================================================
//  App version (for update checks)
// ============================================================

/**
 * A published release. The most recent entry by `createdAt` is
 * the "latest version" that the desktop update checker compares
 * against its own build version.
 */
export interface AppVersion {
  _id: MongoId;
  version: string;
  downloadUrl: string;
  releaseNotes?: string;
  mandatory?: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Input shape for publishing a new release version.
 */
export interface AppVersionCreatePayload {
  version: string;
  downloadUrl: string;
  releaseNotes?: string;
  mandatory?: boolean;
}

/**
 * Input shape for editing an existing release version. Every
 * field is optional; the service merges the patch.
 */
export interface AppVersionUpdatePayload {
  version?: string;
  downloadUrl?: string;
  releaseNotes?: string;
  mandatory?: boolean;
}

// ============================================================
//  Environment
// ============================================================

/**
 * The set of environment variables the server expects at startup.
 * Consumed by `dotenv` loading in `src/index.ts` and by the
 * `handler/index.ts` serverless entry. A missing required field
 * is a fatal startup error and must be caught before the HTTP
 * listener begins accepting connections.
 */
export interface Env {
  NODE_ENV: 'development' | 'production' | 'test';
  PORT: number;
  MONGODB_URI: string;
  JWT_SECRET: string;
  ADMIN_EMAIL: string;
  ADMIN_PASSWORD: string;
}