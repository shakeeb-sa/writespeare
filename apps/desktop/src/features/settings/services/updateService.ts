/**
 * updateService — the update-check service for the WriteSpeare
 * main process.
 *
 * Its single export, `checkForUpdates`, is invoked by the settings
 * IPC handler's `settings:checkUpdates` channel. The settings page
 * fires that channel when the user clicks the "Check for updates"
 * button, and displays one of two outcomes: "Version X is
 * available" with the newer release's notes, or "You are running
 * the latest version".
 *
 * ── The plan's two conflicting annotations ──────────────────────
 *
 *   The plan describes this file twice, with two different
 *   characterizations:
 *
 *     (a) In the settings feature's file tree: "electron-updater
 *         integration".
 *
 *     (b) In the same section's responsibilities table: "Same as
 *         ROOKIE. Checks backend /api/version."
 *
 *   The two are not the same instruction. `electron-updater` is a
 *   full auto-update library whose `autoUpdater.checkForUpdates()`
 *   method fetches a `latest.yml` manifest from a static server
 *   (GitHub releases, an S3 bucket, or a "generic" HTTP server)
 *   and downloads the installer it names. It CANNOT consume the
 *   backend's `GET /api/version` endpoint, which serves a plain
 *   `AppVersion` JSON document, not an `electron-updater` manifest.
 *
 *   The two annotations also describe different operations:
 *
 *     (a) "electron-updater integration" describes the full
 *         auto-update pipeline — check, download, install, relaunch.
 *
 *     (b) "Checks backend /api/version" describes the FIRST step
 *         of that pipeline — the check.
 *
 *   This file implements (b). The check-only flow is what the
 *   settings page's current UI needs, and it is what the settings
 *   IPC handler's `settings:checkUpdates` channel calls for. The
 *   full electron-updater pipeline — download and install — is a
 *   future feature: it requires a static file server serving
 *   `latest.yml` and the installers, neither of which the current
 *   backend has. When that infrastructure exists, this file gains
 *   a second export that wires `electron-updater` to the static
 *   server, and the settings page gains a "Download and install"
 *   button next to the "Check for updates" one.
 *
 *   The dependency `electron-updater` is already declared in
 *   `apps/desktop/package.json` — the plan put it there — and it
 *   remains unused by this file for the reason above. It is
 *   reserved for the future session that lands the download flow.
 *
 * ── Why the check bypasses electron-updater ─────────────────────
 *
 *   `electron-updater` cannot be pointed at the backend's
 *   `/api/version` endpoint. Its check protocol expects a
 *   `latest.yml` manifest — a fixed YAML schema with specific
 *   fields, one per platform — and the backend serves an
 *   `AppVersion` JSON document instead. Wrapping the backend in a
 *   `latest.yml`-producing proxy would be a significant addition
 *   to the backend for no user-visible benefit; a direct HTTP GET
 *   against the existing endpoint is what the plan's own
 *   annotation describes ("Checks backend /api/version"), and it
 *   is the simplest implementation that produces the correct
 *   result.
 *
 * ── The version comparison ──────────────────────────────────────
 *
 *   The service compares the running build's version — obtained
 *   from `app.getVersion()`, which reads `package.json` — against
 *   the latest version the backend has published. The comparison
 *   is a full semantic-versioning precedence check:
 *
 *     * Core segments (major.minor.patch...) are compared
 *       numerically, with missing trailing segments treated as 0,
 *       so "1.0" and "1.0.0" compare as equal.
 *
 *     * A pre-release version is LOWER than the corresponding
 *       release, so "1.0.0-beta.1" < "1.0.0".
 *
 *     * Pre-release identifiers are compared left-to-right:
 *       numeric identifiers numerically, alphanumeric identifiers
 *       lexically, and numeric identifiers are always lower than
 *       alphanumeric ones.
 *
 *     * Build metadata (everything after a "+") is ignored, per
 *       the semver spec.
 *
 *   The comparison is implemented inline rather than by importing
 *   a semver library. The plan does not declare `semver` as a
 *   dependency of the desktop app; pulling it in would be a
 *   package.json change outside the scope of this file. The
 *   implementation here is complete for the version strings the
 *   backend's `SEMVER_PATTERN` accepts (see `AppVersion.ts`).
 *
 * ── The failure model ───────────────────────────────────────────
 *
 *   The function throws on any backend failure — an unreachable
 *   server, a non-2xx response, a malformed version payload. The
 *   caller (the settings IPC handler) catches the throw and
 *   converts it into a `{ success: false, error }` envelope. The
 *   settings page displays the error as a toast; the user sees
 *   "Update check failed: ..." rather than a silent no-op.
 *
 *   A 404 from the backend — "no version has been published yet"
 *   — is treated as a failure, not as "up to date". That is
 *   deliberate. A fresh installation with no published releases
 *   is a state the developer is expected to have fixed before
 *   shipping the app; surfacing the "no version published" message
 *   makes the misconfiguration visible rather than papering over
 *   it as a successful check.
 *
 *   The function returns `null` for the one non-error, no-action
 *   case: the running version is at or above the published one,
 *   so there is nothing for the user to do.
 *
 * ── What this file does NOT do ──────────────────────────────────
 *
 *   - It does not download or install a newer release. See the
 *     "two conflicting annotations" note above for why that is a
 *     separate, future feature.
 *
 *   - It does not cache the result of a check. Every call fires a
 *     fresh HTTP GET. The check is a user-initiated action with
 *     no frequency concern — a user does not click the button
 *     hundreds of times per session — so a cache would add
 *     invalidation logic for no benefit.
 *
 *   - It does not persist any state. The running version is read
 *     from Electron on every call; the latest published version
 *     is fetched from the backend on every call. There is no
 *     third source of truth that could drift.
 *
 *   - It does not signal the renderer directly. The result flows
 *     back through the IPC envelope, and the settings page
 *     decides how to render it. This file has no awareness of
 *     the renderer at all.
 *
 * Dependencies: electron + the shared axios client + the shared
 * `AppVersion` type. All present.
 */

import { app } from 'electron';

import { apiGet } from '../../shared/api/client.js';
import type { AppVersion } from '../../shared/types/index.js';

// ============================================================
//  Version parsing and comparison
// ============================================================
//
// The two helpers below implement semantic-versioning precedence
// for the subset of semver the backend's `AppVersion` schema
// accepts — see `apps/server/src/features/version/models/AppVersion.ts`
// for the `SEMVER_PATTERN` that defines the accepted shape.
//
// The split into a parser and a comparator (rather than one fused
// function) is deliberate: the parser isolates the "what does
// this string mean" concern, and the comparator isolates the
// "which of these two means is newer" concern. Each is a pure
// function of its arguments and can be reasoned about in
// isolation.

/**
 * The parsed form of a semver-shaped version string.
 *
 *   `core` — the numeric segments before any `-`. Missing
 *            trailing segments are absent from the array, not
 *            filled with zeros; the comparator treats absent
 *            segments as zero during comparison, which is what
 *            makes `1.0` and `1.0.0` compare as equal.
 *
 *   `pre`  — the dot-separated pre-release identifiers. Each
 *            identifier is either a number (for an all-digit
 *            identifier with no leading zeros, per the semver
 *            spec) or a string. An empty array means "no
 *            pre-release", which the comparator treats as higher
 *            precedence than any pre-release.
 */
interface ParsedVersion {
  core: number[];
  pre: (number | string)[];
}

/**
 * Parse a semver-shaped version string into its core segments and
 * its pre-release identifiers. Build metadata (everything after
 * the first `+`) is discarded — the semver spec assigns it no
 * precedence, so it cannot affect the comparison.
 *
 * The function never throws. A malformed version string — an
 * empty string, a string with a non-numeric segment before the
 * pre-release — parses to a result the comparator treats as
 * "version 0", which will compare as older than any well-formed
 * version. That is the safe fallback: an unparseable running
 * version reports as "there is an update available", which is
 * more likely to be true than the alternative.
 */
const parseVersion = (v: string): ParsedVersion => {
  // Strip build metadata.
  const plusIdx = v.indexOf('+');
  const noBuild = plusIdx >= 0 ? v.slice(0, plusIdx) : v;

  // Split pre-release from core on the first `-`.
  const dashIdx = noBuild.indexOf('-');
  const coreStr = dashIdx >= 0 ? noBuild.slice(0, dashIdx) : noBuild;
  const preStr = dashIdx >= 0 ? noBuild.slice(dashIdx + 1) : '';

  // Parse the core segments. A segment that does not parse as a
  // finite number contributes a 0 — a malformed version cannot
  // throw the parse, it just contributes as "zero" to every
  // comparison.
  const core = coreStr.split('.').map((s) => {
    const n = Number.parseInt(s, 10);
    return Number.isFinite(n) ? n : 0;
  });

  // Parse the pre-release identifiers. The regex `^(0|[1-9]\d*)$`
  // is the semver spec's exact test for "numeric identifier": a
  // single `0`, or a digit sequence with no leading zero. An
  // identifier that fails the test — "01" with a leading zero,
  // "beta" with letters, "alpha-1" with a hyphen — is kept as a
  // string and compared lexically.
  const pre: (number | string)[] = [];
  if (preStr.length > 0) {
    for (const part of preStr.split('.')) {
      if (/^(0|[1-9]\d*)$/.test(part)) {
        pre.push(Number.parseInt(part, 10));
      } else {
        pre.push(part);
      }
    }
  }

  return { core, pre };
};

/**
 * Compare two semver-shaped version strings and return their
 * precedence relationship.
 *
 * Returns:
 *   -1  when `a` is older than `b`
 *    0  when `a` and `b` have equal precedence
 *    1  when `a` is newer than `b`
 *
 * The comparison implements the full semver precedence rules:
 *
 *   1. Core segments are compared numerically, left to right.
 *      A missing segment on one side is treated as 0.
 *
 *   2. When the core segments are equal, a version WITH a
 *      pre-release is lower than one without. So `1.0.0-beta`
 *      is older than `1.0.0`.
 *
 *   3. When both versions have pre-releases, their identifiers
 *      are compared left to right:
 *
 *        * Numeric identifiers are compared numerically.
 *        * Alphanumeric identifiers are compared lexically
 *          (ASCII order).
 *        * Numeric identifiers have LOWER precedence than
 *          alphanumeric ones — `1.0.0-1` < `1.0.0-alpha`.
 *        * If all shared identifiers are equal, a version with
 *          MORE pre-release identifiers is newer — `1.0.0-alpha`
 *          < `1.0.0-alpha.1`.
 *
 * The function never throws.
 */
const compareVersions = (a: string, b: string): number => {
  const pa = parseVersion(a);
  const pb = parseVersion(b);

  // ---- 1. Core segments ----
  const coreLen = Math.max(pa.core.length, pb.core.length);
  for (let i = 0; i < coreLen; i += 1) {
    const na = pa.core[i] ?? 0;
    const nb = pb.core[i] ?? 0;
    if (na !== nb) {
      return na < nb ? -1 : 1;
    }
  }

  // ---- 2. Pre-release presence ----
  // A version with a pre-release is LOWER than one without.
  if (pa.pre.length === 0 && pb.pre.length === 0) {
    return 0;
  }
  if (pa.pre.length === 0) {
    return 1;
  }
  if (pb.pre.length === 0) {
    return -1;
  }

  // ---- 3. Pre-release identifiers ----
  const preLen = Math.max(pa.pre.length, pb.pre.length);
  for (let i = 0; i < preLen; i += 1) {
    const ia = pa.pre[i];
    const ib = pb.pre[i];

    // A version with more pre-release identifiers is newer, if
    // all shared identifiers are equal.
    if (ia === undefined) {
      return -1;
    }
    if (ib === undefined) {
      return 1;
    }

    const aIsNum = typeof ia === 'number';
    const bIsNum = typeof ib === 'number';

    if (aIsNum && bIsNum) {
      if (ia !== ib) {
        return ia < ib ? -1 : 1;
      }
      continue;
    }

    // A numeric identifier is always LOWER than an alphanumeric
    // one, regardless of the characters.
    if (aIsNum) {
      return -1;
    }
    if (bIsNum) {
      return 1;
    }

    // Both are strings — lexical comparison.
    const sa = String(ia);
    const sb = String(ib);
    if (sa !== sb) {
      return sa < sb ? -1 : 1;
    }
  }

  // All shared identifiers are equal, and neither version has
  // additional identifiers. The two versions have equal
  // precedence.
  return 0;
};

// ============================================================
//  checkForUpdates
// ============================================================

/**
 * Ask the backend whether a newer version of WriteSpeare is
 * available and return it, or `null` if the running build is
 * already current.
 *
 * Flow:
 *
 *   1. Read the running build's version from `app.getVersion()`,
 *      which returns the value of the `version` field in the
 *      desktop app's `package.json`.
 *
 *   2. Fetch the latest published version from the backend's
 *      `GET /api/version` endpoint via the shared axios client.
 *      The endpoint is intentionally unauthenticated — the
 *      update check must be able to run before the user has
 *      logged in — but the shared client attaches the bearer
 *      token when one is present, which is harmless because the
 *      endpoint ignores it.
 *
 *   3. Validate that the response carries a non-empty `version`
 *      string. A well-formed backend response always does (the
 *      schema requires it), so a failure here indicates the
 *      backend is serving something unexpected — a proxy error
 *      page, a mis-configured route — and the service treats it
 *      as a hard failure rather than silently returning `null`.
 *
 *   4. Compare the two versions using `compareVersions`. If the
 *      backend's version is STRICTLY newer, return the
 *      `AppVersion` object. Otherwise return `null` — the running
 *      build is at or above the published one.
 *
 * The function throws on any backend failure: an unreachable
 * server, a non-2xx response, a malformed body. The caller
 * (`settingsIPC.ts`'s `settings:checkUpdates` handler) catches
 * the throw and returns a `{ success: false, error }` envelope,
 * which the settings page displays as a toast. See the file
 * header's "failure model" note for why a 404 is an error and
 * not a "no update" state.
 *
 * The function does NOT touch the renderer, does not write to
 * disk, and does not hold any state between calls.
 *
 * @returns The newer `AppVersion` when the backend has published
 *          one, or `null` when the running build is current.
 * @throws  `Error` on any backend failure.
 */
export const checkForUpdates = async (): Promise<AppVersion | null> => {
  // ---- 1. Running version ----
  const runningVersion = app.getVersion();

  // ---- 2. Latest published version ----
  const result = await apiGet<AppVersion>('/version');

  if (!result.success || !result.data) {
    // The `apiGet` wrapper already converts every axios-level
    // failure into this envelope. The message it carries is
    // whatever the backend or the network layer produced; the
    // service forwards it verbatim so the settings page can
    // display it without translation.
    throw new Error(
      result.error ?? 'The backend did not return a version.'
    );
  }

  const latest = result.data;

  // ---- 3. Validate the version string ----
  // A well-formed `AppVersion` document always carries a
  // non-empty `version` — the schema enforces it. A response
  // that does not is a signal that the backend is serving
  // something unexpected, and the honest response is to fail
  // rather than silently treat the running build as current.
  if (
    typeof latest.version !== 'string' ||
    latest.version.length === 0
  ) {
    throw new Error(
      'The backend returned a version response with no version string.'
    );
  }

  // ---- 4. Compare and return ----
  const comparison = compareVersions(latest.version, runningVersion);

  if (comparison > 0) {
    // The backend's version is strictly newer. Return the whole
    // `AppVersion` object — the settings page displays the
    // version number, and may display the release notes and
    // the mandatory flag in a future revision.
    return latest;
  }

  // The backend's version is equal to or older than the running
  // build. There is nothing for the user to do.
  return null;
};

// ============================================================
//  Default export
// ============================================================

/**
 * Every export bundled under one default object, matching the
 * convention used by the other main-process service modules
 * (`searchService`, `extractionService`, `writerService`,
 * `validationService`, `exportService`, and so on). A caller
 * that prefers the named form uses
 * `import { checkForUpdates } from ...` — which is what
 * `settingsIPC.ts` does — and a caller that prefers the default
 * form uses `import updateService from ...` and destructures.
 */
export default {
  checkForUpdates,
};