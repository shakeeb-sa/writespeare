/**
 * reportRenderer — renders an on-disk validation report to
 * Markdown.
 *
 * A pure function: given a report object in the on-disk shape
 * that the Python validator writes (see `validation/validate_all.py`
 * and the `OnDiskReport` interface below), it returns a Markdown
 * summary. No filesystem access, no network, no side effects —
 * the same input always produces the same output.
 *
 * The output mirrors the six-section content of the Report tab's
 * `ValidationReport` panel: a header block, then one section per
 * validator (readability, SEO structure, keywords, originality,
 * AI markers, grammar), each opening with the section's status
 * and presenting its fields as a Markdown table or a bullet
 * list. The panel and the Markdown therefore describe the same
 * report from the same data; a user who reads one sees what the
 * other contains.
 *
 * ── Why a pure function and not a component ────────────────────
 *
 *   The rendered Markdown is a string, not a React tree. It is
 *   produced in the Electron main process (the bundle service
 *   runs there) and written into a ZIP. A React component would
 *   be the wrong shape for that pipeline — React is a renderer
 *   for a browser context, and the main process has no DOM to
 *   render into.
 *
 *   The two callers therefore share this string-producing
 *   function: `bundleService.ts` calls it once per report JSON
 *   it finds in the topic's `reports/` folder, and the
 *   `export:report` IPC channel calls it once to produce the
 *   standalone `.md` the "Download report" menu item writes.
 *
 * ── The on-disk report shape ───────────────────────────────────
 *
 *   The `OnDiskReport` interface below is the shape the Python
 *   validator's report file carries. It differs from the
 *   backend's `Report` interface in three ways, each of which is
 *   the direct consequence of what the two sides know:
 *
 *     * The on-disk file has `articlePath` and `validatedAt`
 *       fields that the backend `Report` does not. The Python
 *       side knows the local file it validated and the moment it
 *       ran; the backend assigns its own `_id`, `articleId`,
 *       `topicId`, `userId`, and `createdAt` when the report is
 *       POSTed to `/api/reports`.
 *
 *     * The on-disk file has no `_id`, `articleId`, `topicId`,
 *       `userId`, or `createdAt`. Those fields exist only on the
 *       backend, and the bundle's job is to preserve the local
 *       side of the record.
 *
 *     * The six section objects (`readability`, `seo`,
 *       `keywords`, `originality`, `aiMarkers`, `grammar`) and
 *       the `overallStatus` field are identical on both sides.
 *       The backend's schema and the Python script's writer were
 *       designed from the same shape, and the bundle reads that
 *       shape directly.
 *
 *   Because of that identity, the six section interfaces are
 *   imported from the shared types module (`ReadabilityReport`,
 *   `SeoReport`, and so on) rather than redeclared locally. A
 *   future change to a section's shape — a new field on the
 *   readability report, a rename inside the grammar report —
 *   propagates to this file automatically, and the compiler
 *   catches every place the renderer's code needs a matching
 *   update.
 *
 * ── Why the output uses Markdown tables ────────────────────────
 *
 *   The four sections whose data is a set of labeled numeric
 *   values (readability, SEO structure, keywords, originality's
 *   two similarities) are rendered as Markdown tables. A table is
 *   the most direct representation of "here are N labeled values"
 *   in Markdown: it aligns the labels and values into columns that
 *   any reader — human or tool — can scan top-to-bottom.
 *
 *   The two sections whose data is a list of sub-records
 *   (originality's flagged sentences, AI markers' phrases,
 *   grammar's issues) are rendered as bulleted lists. Each entry
 *   is a bullet with the entry's identifying field in bold or
 *   code, and any secondary fields in sub-bullets. A table would
 *   force a fixed column count on lists whose entries have
 *   different natural lengths.
 *
 * ── The escaping rules ─────────────────────────────────────────
 *
 *   Two classes of string value can break a Markdown table or a
 *   bullet:
 *
 *     * A literal pipe (`|`) inside a table cell — the pipe is
 *       the table's own column separator, and an unescaped one
 *       would split the cell in two.
 *     * An embedded newline (`\n` or `\r\n`) inside any line —
 *       a newline ends the current line, and an unescaped one
 *       would break a bullet or a row into two.
 *
 *   Two helpers handle both: `escapeTableCell` escapes pipes and
 *   collapses newlines for table cells, and `normalizeInline`
 *   collapses newlines (but does not need to escape pipes) for
 *   bullet text. The keyword field, the AI-marker phrase field,
 *   and the grammar issue's `ruleId` and `message` fields are the
 *   only string values that reach a table cell; the flagged
 *   sentence's `text` and `sourceTitle` and the grammar issue's
 *   `replacements` are the only string values that reach bullet
 *   text.
 *
 * ── Why the numeric fields are clamped before formatting ───────
 *
 *   The three percentage / similarity renderers (`formatPercent`
 *   for the SEO fractions, `formatSimilarity` for the originality
 *   scores, and the density inline calculation in the keywords
 *   table) clamp their input to `[0, 1]` before multiplying by
 *   100. The clamp exists because the underlying values are
 *   floating-point numbers, and a value of `0.30000000000000004`
 *   or `1.0000000000000002` can arise from a division on the
 *   Python side. Displaying `100.00000000000001%` for a value
 *   that should be `100%` is a cosmetic flaw, but it is the kind
 *   of cosmetic flaw that makes a report look less trustworthy
 *   than it is. The clamp is one line and removes the whole
 *   class.
 *
 * ── What this module does NOT do ───────────────────────────────
 *
 *   - It does not read the report file. The caller reads the
 *     JSON (via `fs.readFile` and `JSON.parse`) and passes the
 *     parsed object in. This file has no I/O.
 *
 *   - It does not validate the report's shape. The `OnDiskReport`
 *     interface declares the contract; the caller's cast from
 *     `unknown` is the boundary at which that contract is
 *     asserted. A report whose interiors do not match the
 *     declared shape produces a `toFixed` or `.map` error at the
 *     exact line where the mismatch surfaces — which the caller
 *     (`bundleService.ts`) catches around its call to
 *     `renderReportMarkdown` and logs. The raw JSON of the report
 *     is still included in the bundle in that case, so a
 *     malformed report never disappears from the archive; it
 *     simply lacks its `.md` companion.
 *
 *   - It does not wrap its output in a code fence or add
 *     frontmatter. The string is the Markdown document; a caller
 *     that wants to write it to a file does so verbatim.
 *
 * Dependencies: only the shared types module. No Node stdlib, no
 * external packages, no sibling files.
 */

import type {
  ReportStatus,
  ReadabilityReport,
  SeoReport,
  KeywordReport,
  OriginalityReport,
  AiMarkersReport,
  GrammarReport,
} from '../../shared/types/index.js';

// ============================================================
//  Public types
// ============================================================

/**
 * The shape of a validation report as it exists on disk.
 *
 * See the file header for how this shape differs from the
 * backend's `Report` interface and why. The two fields that are
 * specific to the on-disk form — `articlePath` and `validatedAt`
 * — are declared here as required strings; the six section
 * objects and the aggregate status are imported from the shared
 * types module so this declaration tracks any future change to
 * those shapes automatically.
 */
export interface OnDiskReport {
  /** The absolute path to the article `.md` file this report
   *  validates. Written by the Python validator; not present on
   *  the backend's `Report` document. */
  articlePath: string;

  /** The ISO-8601 UTC timestamp of the validation run. Written
   *  by the Python validator; the backend's `Report` document
   *  carries a `createdAt` timestamp assigned by Mongoose
   *  instead. */
  validatedAt: string;

  readability: ReadabilityReport;
  seo: SeoReport;
  keywords: KeywordReport;
  originality: OriginalityReport;
  aiMarkers: AiMarkersReport;
  grammar: GrammarReport;

  /** The weakest of the six section statuses, as computed by the
   *  Python validator. Matches the backend's `Report.overallStatus`
   *  in shape and value. */
  overallStatus: ReportStatus;
}

// ============================================================
//  Formatting helpers
// ============================================================

/**
 * Render a `ReportStatus` value as the uppercase label used in
 * section headers and the header block.
 *
 * The three values map to the three labels `GOOD`, `WARNING`,
 * and `FAIL`. The `if`-chain form is used rather than a `switch`
 * because it is exhaustive by construction: the final `return`
 * handles the only remaining member of the union, which the
 * compiler can verify without a fallthrough warning.
 */
const formatStatus = (status: ReportStatus): string => {
  if (status === 'good') return 'GOOD';
  if (status === 'warning') return 'WARNING';
  return 'FAIL';
};

/**
 * Format a fraction in `[0, 1]` as a percentage string with one
 * decimal place — `0.062` becomes `"6.2%"`.
 *
 * The clamp to `[0, 1]` before the multiplication removes the
 * floating-point roundoff artifacts described in the file
 * header. The `toFixed(1)` matches the precision the
 * `SeoPanel` component renders on the Report tab, so the
 * Markdown and the panel show the same string for the same
 * value.
 */
const formatPercent = (fraction: number): string => {
  const clamped = Math.max(0, Math.min(1, fraction));
  return `${(clamped * 100).toFixed(1)}%`;
};

/**
 * Format a cosine similarity in `[0, 1]` as a decimal string with
 * two decimal places — `0.31` stays `"0.31"`.
 *
 * Same clamp reasoning as `formatPercent`, and the two-decimal
 * precision matches the `OriginalityPanel` component's
 * `formatSimilarity` helper.
 */
const formatSimilarity = (value: number): string => {
  const clamped = Math.max(0, Math.min(1, value));
  return clamped.toFixed(2);
};

/**
 * Format a number of seconds as a human-readable string —
 * `"45 sec"`, `"4 min"`, `"4 min 48 sec"`.
 *
 * Same algorithm as the `ReadabilityPanel` component's
 * `formatReadingTime` helper: round to the nearest second, split
 * into minutes and seconds, and omit whichever part is zero.
 */
const formatReadingTime = (seconds: number): string => {
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  const remaining = total % 60;
  if (minutes === 0) return `${remaining} sec`;
  if (remaining === 0) return `${minutes} min`;
  return `${minutes} min ${remaining} sec`;
};

/**
 * Escape a string for safe inclusion in a Markdown table cell.
 *
 * Three transformations, in order:
 *
 *   1. Backslashes are doubled. This is done first so that a
 *      backslash already present in the input does not interact
 *      with the pipe-escaping below.
 *   2. Pipes are escaped. The pipe is the table's own column
 *      separator; an unescaped one would split the cell.
 *   3. Newlines are collapsed to single spaces. A newline ends
 *      the current table row; an unescaped one would produce a
 *      second, malformed row.
 */
const escapeTableCell = (value: string): string => {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ');
};

/**
 * Collapse newlines in a string to single spaces for inclusion in
 * a bullet list.
 *
 * Pipes do not need escaping in bullet text — only in table
 * cells — so this helper does less than `escapeTableCell`. The
 * `trim()` at the end removes any leading or trailing whitespace
 * the newline collapse may leave behind.
 */
const normalizeInline = (value: string): string => {
  return value.replace(/\r?\n/g, ' ').trim();
};

// ============================================================
//  Section renderers
// ============================================================
//
//  One renderer per section of the report. Each returns a
//  self-contained Markdown block with no trailing newlines;
//  `renderReportMarkdown` joins the blocks with the paragraph
//  separator.
//
//  The section renderers take only the specific section object
//  they render, not the whole report. That keeps each one
//  focused on the section's own fields and lets a future caller
//  render a single section in isolation without threading the
//  full report through.

/**
 * Render the report's header block: the article path, the
 * validation timestamp, and the aggregate status.
 *
 * The path and timestamp use the on-disk fields the Python
 * validator wrote. Both are wrapped in a `**Label:** value`
 * pattern so they read as a compact metadata block that a user
 * can scan in one glance.
 */
const renderHeader = (report: OnDiskReport): string => {
  return [
    '# Validation Report',
    '',
    `**Article:** \`${report.articlePath}\``,
    `**Validated:** ${report.validatedAt}`,
    `**Overall status:** **[${formatStatus(report.overallStatus)}]**`,
  ].join('\n');
};

/**
 * Render the readability section as a table of the six metrics.
 *
 * The metric labels and their formats match the `ReadabilityPanel`
 * component: the four grade-level / reading-ease scores are
 * rendered with one decimal place, the average sentence length is
 * rendered with one decimal place and a "words" suffix, and the
 * reading time uses the `formatReadingTime` helper.
 */
const renderReadability = (section: ReadabilityReport): string => {
  const rows: ReadonlyArray<readonly [string, string]> = [
    ['Flesch Reading Ease', section.fleschReadingEase.toFixed(1)],
    ['Flesch-Kincaid Grade', section.fleschKincaidGrade.toFixed(1)],
    ['Gunning Fog', section.gunningFog.toFixed(1)],
    ['SMOG Index', section.smogIndex.toFixed(1)],
    [
      'Avg Sentence Length',
      `${section.avgSentenceLength.toFixed(1)} words`,
    ],
    ['Reading Time', formatReadingTime(section.readingTimeSeconds)],
  ];

  const lines: string[] = [
    `## Readability — [${formatStatus(section.status)}]`,
    '',
    '| Metric | Value |',
    '| --- | --- |',
  ];
  for (const [label, value] of rows) {
    lines.push(`| ${label} | ${value} |`);
  }
  return lines.join('\n');
};

/**
 * Render the SEO structure section as a table of the six
 * structural metrics.
 *
 * The two fraction-valued fields — `passiveVoicePercent` and
 * `transitionWordsPercent` — are rendered via `formatPercent`,
 * matching the `SeoPanel` component's display.
 */
const renderSeo = (section: SeoReport): string => {
  const rows: ReadonlyArray<readonly [string, string]> = [
    ['Word Count', section.wordCount.toLocaleString()],
    ['H2 Sections', String(section.h2Count)],
    ['H3 Subsections', String(section.h3Count)],
    [
      'Avg Paragraph Length',
      `${section.avgParagraphWords.toFixed(1)} words`,
    ],
    ['Passive Voice', formatPercent(section.passiveVoicePercent)],
    [
      'Transition Words',
      formatPercent(section.transitionWordsPercent),
    ],
  ];

  const lines: string[] = [
    `## SEO Structure — [${formatStatus(section.status)}]`,
    '',
    '| Metric | Value |',
    '| --- | --- |',
  ];
  for (const [label, value] of rows) {
    lines.push(`| ${label} | ${value} |`);
  }
  return lines.join('\n');
};

/**
 * Render the keywords section as a table with one row per
 * keyword.
 *
 * Each row shows the keyword itself, its priority, its usage
 * count, its density as a percentage, three boolean placement
 * flags (title, intro, at least one H2), and the per-keyword
 * status. The three placement flags render as a `✓` for `true`
 * and an em-dash `—` for `false`; the em-dash reads as "not
 * present" more cleanly than an empty cell or the word `no`.
 *
 * When the topic had no keywords — the `keywords` array is
 * empty — the section renders a short explanatory line in place
 * of the table, matching the `KeywordPanel` component's empty
 * state.
 */
const renderKeywords = (section: KeywordReport): string => {
  const lines: string[] = [
    `## Keywords — [${formatStatus(section.status)}]`,
    '',
  ];

  if (section.keywords.length === 0) {
    lines.push('No keywords were requested for this topic.');
    return lines.join('\n');
  }

  lines.push(
    '| Keyword | Priority | Uses | Density | Title | Intro | H2s | Status |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |'
  );

  for (const entry of section.keywords) {
    const densityPercent = (
      Math.max(0, Math.min(1, entry.density)) * 100
    ).toFixed(2);
    const inTitle = entry.inTitle ? '✓' : '—';
    const inIntro = entry.inIntro ? '✓' : '—';
    lines.push(
      '| ' +
        escapeTableCell(entry.keyword) +
        ' | ' +
        entry.priority +
        ' | ' +
        String(entry.count) +
        ' | ' +
        densityPercent +
        '% | ' +
        inTitle +
        ' | ' +
        inIntro +
        ' | ' +
        String(entry.inH2Count) +
        ' | ' +
        formatStatus(entry.status) +
        ' |'
    );
  }

  return lines.join('\n');
};

/**
 * Render the originality section: the two similarity maxima as a
 * table, plus a bulleted list of flagged sentences.
 *
 * The two maxima are the same two numbers the `OriginalityPanel`
 * component shows — highest TF-IDF similarity against any
 * source, highest semantic similarity against any source. Each
 * flagged sentence is a bullet with its own similarity and the
 * title of the source it matched, in a sub-bullet.
 *
 * A section with no flagged sentences renders a short
 * confirmation line, matching the panel's empty state.
 */
const renderOriginality = (section: OriginalityReport): string => {
  const lines: string[] = [
    `## Originality — [${formatStatus(section.status)}]`,
    '',
    '| Metric | Value |',
    '| --- | --- |',
    `| Max TF-IDF Similarity | ${formatSimilarity(
      section.maxTfidfSimilarity
    )} |`,
    `| Max Semantic Similarity | ${formatSimilarity(
      section.maxSemanticSimilarity
    )} |`,
  ];

  if (section.flaggedSentences.length === 0) {
    lines.push(
      '',
      'No sentences were flagged. The article reads as original writing.'
    );
    return lines.join('\n');
  }

  lines.push(
    '',
    `### Flagged sentences (${section.flaggedSentences.length})`,
    ''
  );

  for (const flagged of section.flaggedSentences) {
    lines.push(
      `- **${formatSimilarity(flagged.similarity)}** — ${normalizeInline(
        flagged.text
      )}`
    );
    lines.push(
      `  - Matched source: ${normalizeInline(flagged.sourceTitle)}`
    );
  }

  return lines.join('\n');
};

/**
 * Render the AI-markers section: the total occurrence count as a
 * single labeled line, plus a table of the phrases that appeared.
 *
 * The `markerCount` field is the total across every phrase; the
 * `markers` array is the per-phrase breakdown. Both are shown,
 * because a user who sees "11 total" needs the list of which
 * phrases contributed to that number in order to act on it.
 *
 * A section with no markers renders a short confirmation line.
 */
const renderAiMarkers = (section: AiMarkersReport): string => {
  const lines: string[] = [
    `## AI Markers — [${formatStatus(section.status)}]`,
    '',
    `**Total occurrences:** ${section.markerCount.toLocaleString()}`,
  ];

  if (section.markers.length === 0) {
    lines.push('', 'No AI-tell phrases were found.');
    return lines.join('\n');
  }

  lines.push('', '### Phrases found', '', '| Phrase | Count |', '| --- | --- |');

  for (const marker of section.markers) {
    lines.push(
      `| ${escapeTableCell(marker.phrase)} | ${String(marker.count)} |`
    );
  }

  return lines.join('\n');
};

/**
 * Render the grammar section: the issue count as a labeled line,
 * plus a bulleted list of every issue.
 *
 * Each issue's bullet leads with the LanguageTool rule id in
 * code form, followed by the human-readable message. When the
 * rule provided suggested replacements, a sub-bullet lists them
 * separated by middle dots — the same separator convention the
 * `GrammarPanel` component uses for its suggestion pills.
 */
const renderGrammar = (section: GrammarReport): string => {
  const lines: string[] = [
    `## Grammar — [${formatStatus(section.status)}]`,
    '',
    `**Issues found:** ${section.issueCount.toLocaleString()}`,
  ];

  if (section.issues.length === 0) {
    lines.push('', 'No grammar issues were found.');
    return lines.join('\n');
  }

  lines.push('', '### Issues', '');

  for (const issue of section.issues) {
    lines.push(
      `- **\`${escapeTableCell(issue.ruleId)}\`** — ${normalizeInline(
        issue.message
      )}`
    );
    if (issue.replacements.length > 0) {
      const formatted = issue.replacements
        .map((replacement) => normalizeInline(replacement))
        .filter((replacement) => replacement.length > 0)
        .join(' · ');
      if (formatted.length > 0) {
        lines.push(`  - Suggested: ${formatted}`);
      }
    }
  }

  return lines.join('\n');
};

// ============================================================
//  Public API
// ============================================================

/**
 * Render a validation report to Markdown.
 *
 * The output is a complete Markdown document: an H1 title, a
 * header block with the article path and validation timestamp,
 * an aggregate status line, and one H2 section per validator in
 * the canonical order the Report tab renders them —
 * readability, SEO, keywords, originality, AI markers, grammar.
 *
 * The function is pure. Given the same `OnDiskReport`, it
 * returns the same string. It reads no files, touches no
 * network, and mutates nothing. The caller owns the report
 * object it passes in.
 *
 * The function's contract with its callers:
 *
 *   * The input must satisfy the `OnDiskReport` interface. A
 *     caller that received a value from `JSON.parse` should
 *     assert the interface at the call site — the same pattern
 *     `bundleService.ts` uses.
 *
 *   * The output is a string, not a promise. Every renderer the
 *     function delegates to is synchronous. There is no I/O in
 *     the pipeline.
 *
 *   * The output ends with a single trailing newline. That is
 *     the conventional form for a Markdown file written to disk.
 *
 * @param report - The on-disk report to render.
 * @returns The rendered Markdown document.
 */
export const renderReportMarkdown = (report: OnDiskReport): string => {
  const blocks: string[] = [
    renderHeader(report),
    renderReadability(report.readability),
    renderSeo(report.seo),
    renderKeywords(report.keywords),
    renderOriginality(report.originality),
    renderAiMarkers(report.aiMarkers),
    renderGrammar(report.grammar),
  ];
  return blocks.join('\n\n') + '\n';
};

// ============================================================
//  Default export
// ============================================================

/**
 * Every export bundled under one default object, matching the
 * convention of the sibling services in this feature
 * (`bundleService.ts`, `exportService.ts`). A caller that
 * prefers named imports uses
 * `import { renderReportMarkdown } from ...`; a caller that
 * prefers the default form uses
 * `import reportRenderer from ...` and destructures.
 */
export default {
  renderReportMarkdown,
};