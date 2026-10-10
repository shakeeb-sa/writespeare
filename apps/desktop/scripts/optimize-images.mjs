#!/usr/bin/env node
/**
 * optimize-images.mjs — one-shot image compressor for the bundled
 * image resources.
 *
 * Walks `apps/desktop/src/resources/images/` recursively and
 * compresses every PNG, JPG, JPEG, and WebP file in place. The
 * pre-compression original of every image is preserved under
 * `apps/desktop/.image-backups/`, mirroring the folder structure
 * of the source tree, so a developer who wants the uncompressed
 * version back can always recover it. The `.image-backups/` folder
 * is gitignored — see the desktop `.gitignore` for the note.
 *
 * ── Idempotency ─────────────────────────────────────────────────
 *
 *   The script is safe to run more than once. Its definition of
 *   "already processed" is the existence of a backup for the file:
 *
 *     * First run: the file has no backup, so the script copies
 *       the original to `.image-backups/`, then compresses the
 *       source file in place.
 *
 *     * Subsequent runs: the file has a backup, so the script
 *       SKIPS it entirely. This is what prevents a second round
 *       of lossy compression from compounding the artifacts.
 *
 *   The alternative definition — "compressed file looks small
 *   enough, skip it" — would be a heuristic that eventually gets
 *   it wrong. The backup-existence check is exact.
 *
 * ── What gets compressed ────────────────────────────────────────
 *
 *   PNG: compressionLevel 9 and palette quantization. The palette
 *   reduction is what produces the largest savings on the app's
 *   logo and icon assets, which use a limited color set. On a
 *   photographic PNG the palette reduction would hurt quality, but
 *   the app has no photographic PNGs.
 *
 *   JPEG: quality 85 with mozjpeg enabled. 85 is the standard
 *   "visually indistinguishable" quality setting for photographic
 *   content, and mozjpeg's encoder produces roughly 20% smaller
 *   files than libjpeg-turbo at the same quality.
 *
 *   WebP: quality 85. WebP already has aggressive internal
 *   compression; the additional savings over a well-encoded source
 *   WebP are small but non-zero.
 *
 *   SVG: skipped entirely. Sharp can rasterize an SVG, but doing
 *   so would replace a scalable vector with a fixed-resolution
 *   bitmap — the opposite of what a logo asset wants. The plan
 *   ships both `logo.svg` (for UI display) and `logo-256.png`
 *   (for installer icon use); the PNG is compressed, the SVG is
 *   left alone.
 *
 *   Any other extension: skipped. The script does not guess.
 *
 * ── The backup layout ───────────────────────────────────────────
 *
 *   Every original is copied to
 *   `<desktopRoot>/.image-backups/<relativePathFromImages>`.
 *   The relative path preserves the folder structure under
 *   `src/resources/images/`, so a future "restore originals"
 *   operation could walk the backup folder and copy each file
 *   back to its source location.
 *
 *   A restore script is not included in this file. The plan's
 *   file tree does not declare one, and the recovery path is
 *   simple enough to script by hand if it is ever needed. What
 *   matters is that the originals are preserved somewhere
 *   addressable, which is what the backup folder provides.
 *
 * ── What happens on a Sharp failure ─────────────────────────────
 *
 *   If Sharp fails on a file — a corrupt image, an unsupported
 *   sub-format, an out-of-memory condition on a pathologically
 *   large input — the script logs a warning, leaves the file
 *   UNTOUCHED, and continues with the remaining files. A failed
 *   file is not counted in the "processed" tally, and the final
 *   summary prints the failure count alongside it.
 *
 *   The important guarantee: the backup copy is written BEFORE
 *   the compression step. A Sharp failure therefore cannot leave
 *   a file in a state where the original was overwritten but no
 *   backup exists. If the compression fails after the backup
 *   succeeds, the original source file is still what it was, and
 *   the backup is a redundant copy — the safest possible failure
 *   mode.
 *
 * ── Exit codes ──────────────────────────────────────────────────
 *
 *   0 — the run completed. This includes runs where one or more
 *       individual files failed to compress; those are logged as
 *       warnings, not as a script-level failure.
 *   1 — the run could not start: the source images folder does
 *       not exist, or Sharp is not installed.
 *
 *   The distinction is deliberate. A missing images folder means
 *   the caller is running the script in the wrong place; a
 *   missing Sharp means the devDependencies were not installed.
 *   Both are preconditions the script cannot proceed past. A
 *   single corrupt image file, by contrast, is not a reason to
 *   abort the whole run.
 *
 * ── What this script does NOT do ────────────────────────────────
 *
 *   - It does not resize. The script's job is compression, not
 *     dimension changes. A future need for multiple resolutions
 *     (a 1x and a 2x variant of every icon, for instance) would
 *     be a different script — one that produces new files rather
 *     than modifying existing ones in place.
 *
 *   - It does not convert between formats. A PNG stays a PNG, a
 *     JPEG stays a JPEG. A future "convert everything to WebP"
 *     pass would change both file names and extension references
 *     throughout the codebase and is out of scope.
 *
 *   - It does not touch the main-process build output, the
 *     renderer bundle, or any file outside `src/resources/images/`.
 *
 *   - It does not run automatically. The npm script is invoked by
 *     a developer, not by the build. The plan calls this "one-shot"
 *     for exactly that reason — run once after adding new assets,
 *     commit the compressed files, and do not re-run.
 *
 * Dependencies: `sharp` (declared in `apps/desktop/package.json`
 * under devDependencies). Run via `npm run optimize:images` from
 * `apps/desktop/`.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';

// ============================================================
//  Path resolution
// ============================================================
//
//  The script lives at `apps/desktop/scripts/optimize-images.mjs`.
//  The paths it operates on are relative to the desktop app's
//  root (`apps/desktop/`), which is one directory up from this
//  file's own directory.
//
//  This is an ESM file (`.mjs`), so `__dirname` is not a
//  global. It is reconstructed from `import.meta.url` — the
//  same pattern used by every other ESM script in the codebase
//  that needs its own directory.

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** The desktop app's root directory (`apps/desktop/`). */
const DESKTOP_ROOT = path.resolve(__dirname, '..');

/** The folder whose images the script compresses. */
const IMAGES_ROOT = path.join(
  DESKTOP_ROOT,
  'src',
  'resources',
  'images'
);

/** The folder that receives a copy of every pre-compression
 *  original. Mirrors the structure under `IMAGES_ROOT`. */
const BACKUPS_ROOT = path.join(DESKTOP_ROOT, '.image-backups');

// ============================================================
//  Supported extensions
// ============================================================
//
//  The set of extensions the script compresses. Every other
//  extension is skipped silently (as opposed to warned about),
//  because the images folder can legitimately contain files the
//  script does not handle — an SVG, a favicon in a different
//  format, a README dropped in by mistake.
//
//  The extension is matched case-insensitively, so `LOGO.PNG`
//  and `logo.png` are treated identically. Windows filesystems
//  preserve case on write but treat it case-insensitively on
//  read, so a mixed-case extension is a real possibility.

const COMPRESSIBLE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
]);

// ============================================================
//  Per-format Sharp configuration
// ============================================================
//
//  A single `configureSharp` function returns the right Sharp
//  pipeline for a given extension. Each branch carries its own
//  tuning; the values and the reasoning behind them are in the
//  file header's "What gets compressed" section.
//
//  The function takes a `sharp.Sharp` instance and returns a
//  configured `sharp.Sharp`. Sharp's API is chainable — each
//  method returns a new instance — so the pattern is to keep
//  calling methods and let the final one be what writes the
//  output.

/**
 * Apply the compression settings for a file's extension to a
 * Sharp pipeline and return the resulting pipeline.
 *
 * The function is exhaustive over `COMPRESSIBLE_EXTENSIONS` — a
 * caller must have already checked that the extension is in that
 * set, and the final `default` branch throws if it is not. This
 * makes the assumption explicit rather than producing a
 * silently-uncompressed output for an unexpected extension.
 *
 * @param {import('sharp').Sharp} pipeline
 * @param {string} extension - Lowercase, including the leading dot.
 * @returns {import('sharp').Sharp}
 */
const configureSharp = (pipeline, extension) => {
  switch (extension) {
    case '.png':
      return pipeline.png({
        compressionLevel: 9,
        palette: true,
      });
    case '.jpg':
    case '.jpeg':
      return pipeline.jpeg({
        quality: 85,
        mozjpeg: true,
      });
    case '.webp':
      return pipeline.webp({
        quality: 85,
      });
    default:
      throw new Error(
        `configureSharp: unsupported extension "${extension}". ` +
          `The caller must filter by COMPRESSIBLE_EXTENSIONS before ` +
          `reaching this function.`
      );
  }
};

// ============================================================
//  Directory walk
// ============================================================

/**
 * Recursively enumerate every file under `root`, returning paths
 * relative to `root`.
 *
 * The returned paths use the platform's native separator, so a
 * caller that joins them onto another root gets the correct
 * absolute path on Windows and on POSIX systems without further
 * transformation.
 *
 * A missing `root` throws — the caller (`main`) treats that as a
 * fatal precondition failure.
 *
 * @param {string} root - Absolute path to the directory to walk.
 * @returns {Promise<string[]>} Relative paths to every file under
 *          `root`, in the order `readdir` returned them.
 */
const walkDirectory = async (root) => {
  const results = [];

  /**
   * The recursive worker. Separate from `walkDirectory` so the
   * `results` accumulator is closed over rather than threaded
   * through every call.
   *
   * @param {string} absolute - Absolute path to the current
   *                            directory.
   * @param {string} relative - The corresponding path relative
   *                            to `root`.
   */
  const recurse = async (absolute, relative) => {
    const entries = await fs.readdir(absolute, { withFileTypes: true });
    for (const entry of entries) {
      const entryAbsolute = path.join(absolute, entry.name);
      const entryRelative =
        relative.length === 0
          ? entry.name
          : path.join(relative, entry.name);

      if (entry.isDirectory()) {
        await recurse(entryAbsolute, entryRelative);
      } else if (entry.isFile()) {
        results.push(entryRelative);
      }
      // Symlinks and other non-regular files are skipped. The
      // images folder is not expected to contain any, and
      // following a symlink could lead the script outside the
      // folder it was invoked to optimize.
    }
  };

  await recurse(root, '');
  return results;
};

// ============================================================
//  Per-file processing
// ============================================================

/**
 * The result of one file's optimization attempt.
 *
 * Every outcome carries the file's relative path and its
 * pre-compression size. Successes additionally carry the
 * post-compression size and the bytes saved; failures carry the
 * error message.
 */
/**
 * @typedef {object} FileResult
 * @property {string} relativePath
 * @property {'processed' | 'skipped' | 'failed'} outcome
 * @property {number} originalSize
 * @property {number} [newSize]    - Only present on 'processed'.
 * @property {number} [savedBytes] - Only present on 'processed'.
 * @property {string} [reason]     - Only present on 'failed'.
 */

/**
 * Optimize a single file, unless a backup for it already exists.
 *
 * Flow:
 *
 *   1. Stat the file. A missing file (racy deletion, a broken
 *      symlink the walk did not filter) is treated as a skip,
 *      not an error.
 *
 *   2. Check whether a backup exists. If it does, the file was
 *      already processed on a previous run — skip it. This is
 *      the idempotency signal documented in the file header.
 *
 *   3. Copy the file to its backup location. The parent directory
 *      of the backup is created if needed. This step runs BEFORE
 *      the compression step, so a compression failure can never
 *      leave the file in a state where the original was
 *      overwritten but no backup exists.
 *
 *   4. Compress the file in place via Sharp. Sharp's
 *      `toBuffer()` returns the compressed bytes; a separate
 *      `fs.writeFile` writes them back to the file's path. The
 *      two-step sequence (buffer, then write) is used rather
 *      than Sharp's `.toFile()` direct-to-path form, so that a
 *      Sharp failure leaves the source file untouched — the
 *      write never happens.
 *
 *   5. Return a `FileResult` describing the outcome.
 *
 * On any Sharp or filesystem failure in steps 3–4, the function
 * returns a `FileResult` with `outcome: 'failed'` rather than
 * throwing. The caller tallies failures and continues with the
 * next file.
 *
 * @param {string} relativePath - Path relative to `IMAGES_ROOT`.
 * @returns {Promise<FileResult>}
 */
const optimizeOne = async (relativePath) => {
  const sourcePath = path.join(IMAGES_ROOT, relativePath);
  const backupPath = path.join(BACKUPS_ROOT, relativePath);

  // ---- 1. Stat the source file ----
  let originalStats;
  try {
    originalStats = await fs.stat(sourcePath);
  } catch {
    // The file was deleted between the walk and this stat, or
    // the walk produced a path that no longer resolves. Not an
    // error worth surfacing — the file is gone, so there is
    // nothing to optimize.
    return { relativePath, outcome: 'skipped', originalSize: 0 };
  }
  const originalSize = originalStats.size;

  // ---- 2. Skip already-processed files ----
  // A backup's existence is the signal that this file was
  // compressed on a previous run. See the file header for why
  // this is the idempotency signal rather than a size heuristic.
  try {
    await fs.access(backupPath);
    return { relativePath, outcome: 'skipped', originalSize };
  } catch {
    // No backup — proceed with the optimization.
  }

  // ---- 3. Back up the original ----
  try {
    await fs.mkdir(path.dirname(backupPath), { recursive: true });
    await fs.copyFile(sourcePath, backupPath);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      relativePath,
      outcome: 'failed',
      originalSize,
      reason: `backup failed: ${reason}`,
    };
  }

  // ---- 4. Compress in place ----
  const extension = path.extname(relativePath).toLowerCase();
  try {
    const sourceBuffer = await fs.readFile(sourcePath);
    const compressedBuffer = await configureSharp(
      sharp(sourceBuffer),
      extension
    ).toBuffer();
    await fs.writeFile(sourcePath, compressedBuffer);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // The source file has not been modified — the write step
    // never ran. The backup exists, but it is a redundant copy
    // of an unchanged file. The caller's tally records the
    // failure; the file remains as it was.
    return {
      relativePath,
      outcome: 'failed',
      originalSize,
      reason: `compression failed: ${reason}`,
    };
  }

  // ---- 5. Stat the compressed file and compute savings ----
  // The stat is re-read rather than assumed, because Sharp does
  // not guarantee the output size matches any particular
  // estimate. The saved-bytes figure in the summary is measured,
  // not predicted.
  let newSize;
  try {
    newSize = (await fs.stat(sourcePath)).size;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      relativePath,
      outcome: 'failed',
      originalSize,
      reason: `post-compression stat failed: ${reason}`,
    };
  }

  return {
    relativePath,
    outcome: 'processed',
    originalSize,
    newSize,
    savedBytes: originalSize - newSize,
  };
};

// ============================================================
//  Summary reporting
// ============================================================

/**
 * Format a byte count as a human-readable string. Uses binary
 * units (KiB, MiB) rather than the SI units (KB, MB) because the
 * savings numbers are being compared to file sizes the OS reports
 * in binary units.
 *
 * @param {number} bytes
 * @returns {string}
 */
const formatBytes = (bytes) => {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
};

/**
 * Print a one-line report for a single result, and return the
 * numbers the summary needs.
 *
 * The caller passes an accumulator object so the summary can be
 * computed in one pass without a second loop over the results
 * array.
 *
 * @param {FileResult} result
 * @param {{ processed: number, skipped: number, failed: number,
 *           totalOriginal: number, totalSaved: number }} tally
 */
const reportResult = (result, tally) => {
  switch (result.outcome) {
    case 'processed': {
      tally.processed += 1;
      tally.totalOriginal += result.originalSize;
      tally.totalSaved += result.savedBytes ?? 0;

      const savings =
        result.originalSize > 0 && result.savedBytes !== undefined
          ? ((result.savedBytes / result.originalSize) * 100).toFixed(0)
          : '0';
      console.log(
        `  ✅ ${result.relativePath} — ` +
          `${formatBytes(result.originalSize)} → ` +
          `${formatBytes(result.newSize ?? 0)} ` +
          `(saved ${savings}%)`
      );
      return;
    }

    case 'skipped': {
      tally.skipped += 1;
      // Silent for files that were already processed — a
      // re-run of a fully-optimized folder produces no output,
      // which is the correct behavior for the common case.
      return;
    }

    case 'failed': {
      tally.failed += 1;
      console.warn(
        `  ⚠️  ${result.relativePath} — ${result.reason ?? 'unknown error'}`
      );
      return;
    }
  }
};

// ============================================================
//  Main
// ============================================================

/**
 * Entry point. Walks the images folder, filters to compressible
 * extensions, processes each file, and prints a summary.
 *
 * Exits with code 0 on a completed run (regardless of individual
 * failures) and code 1 on a precondition failure. See the file
 * header for the exit-code contract.
 */
const main = async () => {
  // ---- 1. Precondition: source folder exists ----
  try {
    await fs.access(IMAGES_ROOT);
  } catch {
    console.error(
      `❌ Source images folder does not exist:\n` +
        `   ${IMAGES_ROOT}\n` +
        `   Run this script from the desktop app's root, or check ` +
        `that the resources folder has not been moved.`
    );
    process.exit(1);
  }

  console.log(`🔍 Scanning ${path.relative(DESKTOP_ROOT, IMAGES_ROOT)}…`);

  // ---- 2. Walk the tree ----
  const allFiles = await walkDirectory(IMAGES_ROOT);

  // ---- 3. Filter to compressible extensions ----
  const compressibleFiles = allFiles.filter((relativePath) =>
    COMPRESSIBLE_EXTENSIONS.has(path.extname(relativePath).toLowerCase())
  );

  if (compressibleFiles.length === 0) {
    console.log(
      `   No compressible files found ` +
        `(looked for: ${[...COMPRESSIBLE_EXTENSIONS].join(', ')}).`
    );
    return;
  }

  console.log(
    `   Found ${compressibleFiles.length} compressible ` +
      `file${compressibleFiles.length === 1 ? '' : 's'}.`
  );
  console.log();

  // ---- 4. Process each file, accumulating a tally ----
  const tally = {
    processed: 0,
    skipped: 0,
    failed: 0,
    totalOriginal: 0,
    totalSaved: 0,
  };

  for (const relativePath of compressibleFiles) {
    const result = await optimizeOne(relativePath);
    reportResult(result, tally);
  }

  // ---- 5. Summary ----
  console.log();
  console.log('─'.repeat(60));

  if (tally.processed === 0 && tally.failed === 0) {
    console.log(
      `✅ Nothing to do — all ${tally.skipped} file` +
        `${tally.skipped === 1 ? '' : 's'} already optimized.`
    );
    console.log(
      `   Backups are in ${path.relative(DESKTOP_ROOT, BACKUPS_ROOT)}/.`
    );
    return;
  }

  console.log(`✅ Processed: ${tally.processed}`);
  if (tally.skipped > 0) {
    console.log(`   Skipped:   ${tally.skipped} (already optimized)`);
  }
  if (tally.failed > 0) {
    console.log(`   Failed:    ${tally.failed} (see warnings above)`);
  }

  if (tally.totalOriginal > 0) {
    const savingsPct = (
      (tally.totalSaved / tally.totalOriginal) *
      100
    ).toFixed(1);
    console.log();
    console.log(
      `   Total:     ${formatBytes(tally.totalOriginal)} → ` +
        `${formatBytes(tally.totalOriginal - tally.totalSaved)} ` +
        `(saved ${formatBytes(tally.totalSaved)}, ${savingsPct}%)`
    );
  }

  if (tally.processed > 0) {
    console.log();
    console.log(
      `   Originals preserved in ` +
        `${path.relative(DESKTOP_ROOT, BACKUPS_ROOT)}/.`
    );
  }
};

// ============================================================
//  Invocation
// ============================================================
//
//  Run the script. Any unexpected throw — a bug in the script
//  itself, a filesystem error the per-file handlers did not
//  catch — is logged and converted to exit code 1. The per-file
//  `optimizeOne` calls are expected to return `FileResult`
//  objects rather than throw, so this outer catch is the last-
//  resort net rather than the primary error-handling path.

main().catch((err) => {
  const reason = err instanceof Error ? err.message : String(err);
  console.error(`❌ Unexpected error: ${reason}`);
  if (err instanceof Error && err.stack !== undefined) {
    console.error(err.stack);
  }
  process.exit(1);
});