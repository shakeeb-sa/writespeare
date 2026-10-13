/**
 * WriteSpeare — shared domain types for the desktop app.
 *
 * This module is the desktop's mirror of the backend's
 * `apps/server/src/features/shared/types/index.ts`. It declares
 * every domain entity, every request payload, and every status
 * union that crosses the HTTP boundary between the two apps.
 * Both sides of the desktop app — the main process (which makes
 * the HTTP requests and parses the responses) and the renderer
 * (which renders the parsed data) — import from here.
 *
 * The two apps are independent compilation units:
 *
 *   The desktop app and the backend app share no TypeScript
 *   source. The plan's golden rules make this explicit — the
 *   boundary between them is HTTP and JSON, not an import. Both
 *   sides declare their own copy of each shared shape, and the
 *   two declarations are kept in sync by hand. When a field is
 *   added to a backend entity, the corresponding field must be
 *   added here in the same change, or the desktop will silently
 *   omit it from the objects it constructs or fails to render
 *   it when it arrives. This is the accepted cost of the
 *   two-app architecture; a shared package was considered and
 *   rejected because it would force the two apps to be built
 *   and deployed together.
 *
 * Wire format vs. backend's in-process shape:
 *
 *   Where the backend's types describe an in-process Mongoose
 *   document, this module describes what the same data looks
 *   like after the JSON round trip. Three differences are
 *   systematic:
 *
 *     1. IDs. The backend declares `_id` and every foreign key
 *        as `string | ObjectId` — the Mongoose `MongoId` type.
 *        A JSON response serializes an ObjectId to its hex
 *        string form, so on the desktop every ID is a `string`.
 *        This module uses `string` for every ID field without
 *        exception.
 *
 *     2. Timestamps. The backend declares `createdAt`,
 *        `updatedAt`, and every other date field as `Date`. A
 *        JSON response serializes a Date to its ISO-8601 string
 *        form, and axios does not parse strings into Dates. So
 *        on the desktop every timestamp is a `string`, and any
 *        component that needs a `Date` object constructs one at
 *        the display site (`new Date(createdAt)`).
 *
 *     3. The password hash. The backend's `User` interface
 *        includes `passwordHash` because the field is part of
 *        the entity. The backend strips it before serializing,
 *        so the desktop's `User` does NOT include the field at
 *        all. A consumer that tried to read `user.passwordHash`
 *        would be a compile error, which is the correct
 *        behaviour — the field never reaches the desktop, so
 *        the desktop should not be able to reference it.
 *
 *   Two types declared on the backend — `MongoId` and
 *   `PaginatedResponse<T>` — are not declared here. `MongoId`
 *   exists only to describe the union of serialized and
 *   in-process forms, and there is no in-process form on the
 *   desktop. `PaginatedResponse<T>` is not used by any
 *   endpoint the desktop consumes; the topics list, the
 *   documents list, and the reports list all return plain
 *   arrays.
 *
 * Re-export of PresetName and ProfileName:
 *
 *   The two literal-union types `PresetName` and `ProfileName`
 *   are declared in `../constants/index.ts` — where their
 *   runtime arrays live — and re-exported here so that a
 *   consumer that wants to import "everything domain-shaped"
 *   from this module can do so without a second import from
 *   the constants module. The constants module remains the
 *   single source of truth for both the arrays and the derived
 *   unions; this module's re-export is a convenience, not a
 *   second declaration.
 *
 * UserRole is a union type, not an enum:
 *
 *   The backend declares `UserRole` as a string enum
 *   (`UserRole.ADMIN = 'admin'`, `UserRole.USER = 'user'`).
 *   The enum has a runtime representation, which the backend
 *   uses in `requireAdmin` middleware to compare a caller's
 *   role against the admin value. The desktop never performs
 *   that comparison — the backend rejects a non-admin request
 *   with a 403, and the renderer's `Layout` component only
 *   reads the role to decide whether to show the "Admin" nav
 *   link. A union type (`'admin' | 'user'`) is enough for both
 *   uses and has no runtime cost. The full literal set is
 *   declared here rather than imported because the desktop's
 *   union and the backend's enum are independent declarations
 *   of the same two values.
 */

import type {
  PresetName,
  ProfileName,
} from '../constants/index.js';

// Re-export the two constants-declared unions so that a
// consumer can import "everything domain-shaped" from one
// module. See the file header for why the constants module is
// the source of truth and this re-export is a convenience.
export type { PresetName, ProfileName } from '../constants/index.js';

// ============================================================
//  API response envelope
// ============================================================

/**
 * The shape of every response that crosses the backend's HTTP
 * boundary — success or failure.
 *
 * The `success` flag is the discriminator. On `true`, `data`
 * carries the payload; on `false`, `error` carries a
 * human-readable message. `message` is reserved for optional
 * non-fatal context that a caller may surface as a toast.
 *
 * The generic parameter `T` is unconstrained; consumers
 * instantiate it with the payload type of the specific endpoint
 * they are calling. A default of `null` is used for endpoints
 * that return no payload (`logout`, `clearToken`) so that a
 * caller does not have to write `ApiResponse<null>` in every
 * case.
 */
export interface ApiResponse<T = null> {
  success: boolean;
  data?: T;
  message?: string;
  error?: string;
}

// ============================================================
//  User & Authentication
// ============================================================

/**
 * The two roles a user account can hold.
 *
 * See the file header for why this is a union type rather than
 * an enum.
 */
export type UserRole = 'admin' | 'user';

/**
 * The public shape of a user account as the desktop receives it
 * from the backend.
 *
 * The `passwordHash` field that the backend's `User` interface
 * declares is deliberately absent — the backend strips it before
 * serializing, so the field never reaches the desktop. See the
 * file header for the systematic ID and timestamp conversions
 * that apply to every entity in this module.
 */
export interface User {
  _id: string;
  email: string;
  role: UserRole;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * The payload the admin feature sends when creating a new user
 * through the `POST /api/users` endpoint.
 */
export interface UserCreatePayload {
  email: string;
  password: string;
  role?: UserRole;
  active?: boolean;
}

/**
 * The payload for a partial update to a user. Every field is
 * optional; the backend merges the patch onto the existing
 * document.
 */
export interface UserUpdatePayload {
  email?: string;
  password?: string;
  role?: UserRole;
  active?: boolean;
}

/**
 * The body of a login request. Sent to `POST /api/auth/login`.
 */
export interface LoginRequest {
  email: string;
  password: string;
}

/**
 * The body of a successful login response.
 *
 * The `user` object is the desktop's `User` type — which is
 * already the client-safe shape, with the password hash
 * stripped. The `token` is a bearer JWT the desktop stores in
 * the encrypted `electron-store` and attaches to every
 * subsequent request through the axios client's request
 * interceptor.
 */
export interface LoginResponse {
  user: User;
  token: string;
}

// ============================================================
//  Topic
// ============================================================

/**
 * The lifecycle state of a topic. Matches the backend's
 * `TopicStatus` union exactly — the string values are what
 * crosses the wire, and the backend's schema validates the
 * value against the same set.
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
 * A topic — the atomic unit of work in WriteSpeare. One topic
 * owns one pipeline: search → extraction → writing → validation
 * → export. Every document, article, and report references its
 * owning topic by `_id`.
 */
export interface Topic {
  _id: string;
  userId: string;
  title: string;
  keywords: string[];
  preset: PresetName;
  profile: ProfileName;
  promptFile: string;
  wordCount: number;
  sourceCount: number;
  /**
   * The topic's snapshot of the four time-range search bucket
   * counts. Captured at creation from the chosen preset's
   * `defaultBucketLayout` (or from the user's settings-level
   * default when no preset overrides it), and editable per
   * topic afterward. The single source of truth for "how many
   * sources to collect" per the plan's Item 3 / C2 decision;
   * `sourceCount` on this record is derived from the sum of the
   * four counts.
   */
  searchBuckets: {
    anyTime: number;
    pastYear: number;
    pastMonth: number;
    pastWeek: number;
  };
  status: TopicStatus;
  /** Populated only when `status === 'failed'`. */
  error?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * The payload for creating a topic.
 *
 * `userId` is derived from the authenticated session on the
 * backend and is not part of the payload. The remaining fields
 * are the values the user chose in the New Topic modal, all
 * optional except the title.
 */
export interface TopicCreatePayload {
  title: string;
  keywords?: string[];
  preset?: PresetName;
  profile?: ProfileName;
  promptFile?: string;
  wordCount?: number;
  sourceCount?: number;
  /**
   * The initial four-bucket search layout. When provided, the
   * backend derives `sourceCount` as the sum of the four counts
   * (per Item 3 / C2 — the bucket layout is the authoritative
   * count input). When omitted, the backend applies the
   * user's `defaultBucketLayout` from their settings, or the
   * chosen preset's `defaultBucketLayout` if the caller supplied
   * a preset. A zero count for a bucket means "skip that time
   * range entirely" (Q8.3).
   */
  searchBuckets?: {
    anyTime: number;
    pastYear: number;
    pastMonth: number;
    pastWeek: number;
  };
}

/**
 * The payload for a partial update to a topic. Every field is
 * optional; the backend merges the patch onto the existing
 * document.
 */
export interface TopicUpdatePayload {
  title?: string;
  keywords?: string[];
  preset?: PresetName;
  profile?: ProfileName;
  promptFile?: string;
  wordCount?: number;
  sourceCount?: number;
  /**
   * Replace the topic's four-bucket search layout. Same semantics
   * as `TopicCreatePayload.searchBuckets` — the four counts are
   * the authoritative input, and `sourceCount` is derived as
   * their sum when this field is present. A partial update that
   * omits this field leaves the topic's existing layout
   * untouched.
   */
  searchBuckets?: {
    anyTime: number;
    pastYear: number;
    pastMonth: number;
    pastWeek: number;
  };
  status?: TopicStatus;
  error?: string;
}

/**
 * The narrowing criteria the topics list supports.
 *
 * The backend's `GET /api/topics` endpoint accepts an optional
 * `?status=` query parameter; this type models that filter. It
 * is the closest equivalent on the desktop to the ROOKIE plan's
 * `RunFilters` concept — a small, closed-set filter object
 * passed through to a list endpoint. If a future session adds
 * another filter dimension (a preset filter, a date range), it
 * is added here.
 */
export interface TopicFilters {
  status?: TopicStatus;
}

// ============================================================
//  Document
// ============================================================

/**
 * A scraped source page attached to a topic.
 *
 * The `content` field carries the extracted Markdown body of the
 * page — the same text the extraction pipeline wrote to the
 * `.md` file on disk. The desktop's document list uses the
 * other fields (title, url, platform, wordCount) for display
 * and only loads `content` when the user opens the preview.
 */
export interface Document {
  _id: string;
  topicId: string;
  userId: string;
  url: string;
  platform: string;
  title: string;
  content: string;
  wordCount: number;
  fetchedAt: string;
  createdAt: string;
  updatedAt: string;
}

// ============================================================
//  Article
// ============================================================

/**
 * The lifecycle state of a generated article. Matches the
 * backend's `ArticleStatus` union.
 */
export type ArticleStatus = 'draft' | 'validated' | 'exported';

/**
 * A generated article attached to a topic. A topic can own
 * multiple articles — one per regeneration — and the article
 * with the highest `version` number is the current one.
 */
export interface Article {
  _id: string;
  topicId: string;
  userId: string;
  content: string;
  wordCount: number;
  version: number;
  status: ArticleStatus;
  createdAt: string;
  updatedAt: string;
}

// ============================================================
//  Report
// ============================================================

/**
 * The pass/warn/fail classification of a validation section.
 * Matches the backend's `ReportStatus` union.
 */
export type ReportStatus = 'good' | 'warning' | 'fail';

/**
 * The readability section of a validation report. Values are
 * produced by `textstat` on the article body with Markdown
 * markup stripped.
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
 * The structural SEO section of a report. Measures shape, not
 * content quality — heading counts, paragraph sizes, and the
 * ratio of passive to active voice.
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
 * Per-keyword placement and density. One entry per keyword the
 * user supplied on the topic, plus any keyword extracted from
 * the source corpus and accepted by the user.
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
 * The keywords section of a report. Wraps the per-entry array
 * with an aggregate status so the section matches the shape of
 * every other section.
 */
export interface KeywordReport {
  keywords: KeywordReportEntry[];
  status: ReportStatus;
}

/**
 * One sentence from the generated article that scored above the
 * configured similarity threshold against one or more source
 * documents.
 */
export interface FlaggedSentence {
  text: string;
  /** 0–1; the highest similarity this sentence scored against any source. */
  similarity: number;
  /** Human-readable label of the source document it matched. */
  sourceTitle: string;
}

/**
 * The originality section of a report. Two independent
 * similarity signals are reported side by side: TF-IDF catches
 * lexical overlap, semantic similarity catches paraphrase.
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
 * The AI-marker section of a report. Counts occurrences of
 * phrases that are statistically over-represented in LLM output.
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
  replacements: string[];
}

/**
 * The grammar section of a report.
 */
export interface GrammarReport {
  issueCount: number;
  issues: GrammarIssue[];
  status: ReportStatus;
}

/**
 * The complete validation report for one article. Every section
 * is required — a report is only written when all six validators
 * have completed, so a partially-populated report would indicate
 * a bug in the runner.
 */
export interface Report {
  _id: string;
  articleId: string;
  topicId: string;
  userId: string;
  readability: ReadabilityReport;
  seo: SeoReport;
  keywords: KeywordReport;
  originality: OriginalityReport;
  aiMarkers: AiMarkersReport;
  grammar: GrammarReport;
  /** The weakest status across all six sections. */
  overallStatus: ReportStatus;
  createdAt: string;
}

// ============================================================
//  Preset
// ============================================================

/**
 * A saved bundle of pipeline settings. Three system presets ship
 * with the app (Quick, Balanced, Deep) and have
 * `userId === null`; user-created presets carry the owning
 * user's id.
 *
 * A preset is self-contained — every field the pipeline reads at
 * run time is present here, so loading a preset replaces the
 * entire effective configuration rather than merging with a
 * global default. That guarantees the same preset produces the
 * same pipeline behaviour regardless of what else the user has
 * configured.
 */
export interface Preset {
  _id: string;
  /** `null` for system presets. */
  userId: string | null;
  name: string;
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
  createdAt: string;
  updatedAt: string;
}

/**
 * The payload for creating a preset. `userId` is set by the
 * backend (or, for the admin feature, by the service) — the
 * client never supplies it, so it is not part of the payload.
 */
export interface PresetCreatePayload {
  name: string;
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
}

// ============================================================
//  User settings
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
  autoSaveAfterEachStage: boolean;
  notifyOnCompletion: boolean;
  theme: 'light' | 'dark';
  /**
   * The user's default bucket layout for the four time-range
   * search buckets. Seeds the `searchBuckets` field on a new
   * Topic when no preset overrides it (see the plan's Item 3 /
   * C2 decision — bucket layout is the single source of truth
   * for "how many sources to collect"). The same four-key shape
   * the Topic schema's `searchBuckets` field and the renderer's
   * `BucketConfig` type use; a count of zero means "skip this
   * time range entirely" (Q8.3).
   */
  defaultBucketLayout: {
    anyTime: number;
    pastYear: number;
    pastMonth: number;
    pastWeek: number;
  };
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
 * The per-user settings document as the desktop receives it from
 * the backend. Exactly one exists per user — the backend
 * upserts one on the first read.
 */
export interface UserSetting {
  _id: string;
  userId: string;
  settings: UserSettingsMap;
  createdAt: string;
  updatedAt: string;
}

// ============================================================
//  App version
// ============================================================

/**
 * A published desktop-app release. The most recent record by
 * `createdAt` is the "latest version" that the desktop's update
 * checker compares against its own build version.
 */
export interface AppVersion {
  _id: string;
  version: string;
  downloadUrl: string;
  releaseNotes?: string;
  mandatory?: boolean;
  createdAt: string;
  updatedAt: string;
}