/**
 * Vite configuration for the WriteSpeare renderer.
 *
 * The renderer is the React half of the Electron app — the code
 * that runs in the browser context of the desktop window and
 * talks to the main process through `window.electronAPI.*`. This
 * file configures the build and dev-server behaviour for that
 * half only. The main process is compiled separately by `tsc`
 * (see `build:main` in `package.json`) and is not touched by
 * Vite.
 *
 * What this config does, in order:
 *
 *   1. Sets `base: './'` — the single most important setting in
 *      this file. When the packaged Electron app loads the
 *      renderer from a `file://` URL, an asset path like
 *      `/assets/index-abc123.js` resolves to
 *      `file:///assets/index-abc123.js` (the filesystem root)
 *      instead of the app's own directory. The resulting page
 *      loads with a blank white screen and a stack of "failed to
 *      load resource" errors in the devtools console — one of
 *      the most common Electron packaging bugs and one of the
 *      hardest to diagnose without knowing to look for it. A
 *      relative base makes every asset URL resolve against the
 *      HTML file's own location, which works correctly in both
 *      the dev server and the packaged app.
 *
 *   2. Registers `@vitejs/plugin-react` — the official React
 *      plugin. It wires up the JSX/TSX transform (via esbuild)
 *      and Fast Refresh in dev. Every `.tsx` file in the
 *      renderer depends on it.
 *
 *   3. Registers a small custom plugin — `tsFromJsResolver` —
 *      that maps a relative import specifier ending in `.js` or
 *      `.jsx` to the matching `.ts` or `.tsx` file on disk. Every
 *      import in this codebase uses the `.js` extension even
 *      though the source files are `.ts`, because the main
 *      process is compiled under NodeNext resolution which
 *      requires the extension. Without this plugin, Vite would
 *      fail to resolve those imports in the renderer — the
 *      `.js` file does not exist on disk, only its `.ts` source.
 *      See the plugin's own docstring for the mechanics.
 *
 *   4. Pins the dev server to port 5173 with `strictPort: true`.
 *      The Electron main process hard-codes the same port when
 *      loading the renderer from the dev server, so a port
 *      collision must fail loudly rather than silently shifting
 *      to 5174 and leaving the main process pointed at a dead
 *      URL.
 *
 *   5. Disables Vite's clear-screen behaviour. When Electron and
 *      Vite are run together under a single terminal — the
 *      common dev loop — Vite's default clear-screen would wipe
 *      Electron's startup logs every time Vite restarts. That is
 *      the opposite of helpful when debugging.
 *
 * What this config deliberately does NOT do:
 *
 *   - It does not set `root`. Vite defaults `root` to the
 *     directory containing the config file, which is
 *     `apps/desktop/` — exactly where `index.html` lives. Setting
 *     it explicitly to the same value would be redundant.
 *
 *   - It does not set `resolve.alias` for `@` or any other
 *     shorthand. No source file in the plan's structure uses an
 *     alias — every import is a relative path — and adding an
 *     alias now would be a solution without a problem. If a
 *     future refactor introduces one, it belongs here.
 *
 *   - It does not configure the main-process build. That is
 *     `tsc`'s job, and the two builds are orchestrated by the
 *     `build` script in `package.json`.
 */

import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ============================================================
//  Module-local paths
// ============================================================
//
// This config file is ESM (the desktop package.json declares
// `"type": "module"`), so the CommonJS `__dirname` global is not
// available. It is reconstructed from `import.meta.url` below
// for any code that needs the config file's own directory. Vite
// itself defaults `root` to this directory, so `currentDir` is
// only used inside the resolver plugin, where it is not needed —
// the plugin resolves specifiers relative to the importer, not
// the config file.

const currentDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Resolve a relative import specifier that ends in `.js` or
 * `.jsx` to the matching `.ts` or `.tsx` source file on disk.
 *
 * Why this is necessary:
 *
 *   Every import specifier across this codebase — in the backend,
 *   in the desktop main process, and in the renderer — ends in
 *   `.js`, even though the source files are `.ts`. This is the
 *   NodeNext ESM convention: TypeScript's `moduleResolution:
 *   "NodeNext"` requires the runtime extension to appear in the
 *   source, because Node.js resolves imports literally and does
 *   not try alternate extensions.
 *
 *   Vite, by contrast, resolves imports the way a bundler does —
 *   it tries a list of extensions when the specifier has no
 *   extension, but it does NOT try to substitute extensions when
 *   the specifier already HAS one. An import of `./foo.js` asks
 *   Vite for a file literally named `foo.js`; the fact that a
 *   sibling file is named `foo.ts` is invisible to Vite's default
 *   resolver.
 *
 *   This plugin closes that gap. It runs `enforce: 'pre'`, so it
 *   sees every import before Vite's default resolver does. When
 *   it matches the pattern it is looking for, it returns the
 *   absolute path to the correct `.ts`/`.tsx` file; when it does
 *   not match, it returns `null` and Vite's default resolver
 *   proceeds unchanged.
 *
 * What it does NOT do:
 *
 *   - It does not touch bare package specifiers (`react`,
 *     `axios`) or subpath imports of packages (`react/jsx-runtime`).
 *     Those are handled by Vite's node resolution against
 *     `node_modules`. The check `source.startsWith('.')` limits
 *     this plugin to relative specifiers only.
 *
 *   - It does not handle absolute paths. The codebase does not
 *     use any, and relative specifiers are the only shape this
 *     plugin needs to recognize.
 *
 *   - It does not handle imports from another file's `.js` output
 *     in `dist/`. The renderer only ever imports from `.ts`/`.tsx`
 *     sources; the compiled `.js` output of the main process is
 *     never loaded into the renderer's module graph.
 *
 * The plugin is defined inline (rather than as a separate module)
 * because it is used exactly once, here, and its entire purpose
 * is expressed by this single function. Splitting it into its own
 * file would add a layer of indirection without adding a decision.
 */
const tsFromJsResolver = (): Plugin => ({
  name: 'ts-from-js-resolver',
  enforce: 'pre',

  /**
   * Vite calls this hook for every import specifier in the
   * module graph. Returning a string short-circuits the default
   * resolution; returning `null` delegates to the next resolver.
   *
   * The signature matches Vite's `Plugin['resolveId']` — Vite's
   * own type definitions make `importer` possibly `undefined`
   * when the specifier is the entry point, so the guard checks
   * for its presence explicitly rather than assuming it is
   * always defined.
   */
  resolveId(source, importer) {
    // No importer means this is the entry point itself — the
    // index.html or the renderer entry file — which is always a
    // real file on disk. Nothing to resolve.
    if (!importer) {
      return null;
    }

    // Only relative specifiers. Bare package names and absolute
    // paths are handled by Vite's own resolution chain.
    if (!source.startsWith('.')) {
      return null;
    }

    // Only specifiers that already carry a `.js` or `.jsx`
    // extension. Specifiers without an extension are correctly
    // resolved by Vite's default extension list.
    const isJs = source.endsWith('.js');
    const isJsx = source.endsWith('.jsx');
    if (!isJs && !isJsx) {
      return null;
    }

    // Build the candidate `.ts` / `.tsx` paths by stripping the
    // `.js` / `.jsx` extension and appending the TypeScript
    // extensions. Both extensions are tried for `.js` — a file
    // named `foo.js` could originate from either `foo.ts` or
    // `foo.tsx`. For `.jsx` only `.tsx` is tried, because the
    // `.jsx` extension in this codebase is only used to refer to
    // `.tsx` sources.
    const candidates = isJsx
      ? [source.slice(0, -4) + '.tsx']
      : [source.slice(0, -3) + '.ts', source.slice(0, -3) + '.tsx'];

    // Resolve each candidate relative to the importing file's
    // directory. `path.dirname(importer)` is the correct base
    // because the specifier is relative to the importer, not to
    // the config file or the project root.
    for (const candidate of candidates) {
      const resolved = path.resolve(path.dirname(importer), candidate);
      if (existsSync(resolved)) {
        return resolved;
      }
    }

    // No matching `.ts`/`.tsx` file. Return null so Vite's
    // default resolver runs — it will produce a clear
    // "module not found" error naming the missing file, which is
    // the correct diagnostic for this case.
    return null;
  },
});

// ============================================================
//  Export
// ============================================================

export default defineConfig({
  // Relative base — critical for the packaged Electron app. See
  // the file header for the full reasoning.
  base: './',

  // React plugin for JSX/TSX transform and Fast Refresh, plus
  // the local resolver for `.js`-suffixed imports of `.ts`
  // sources. Plugin order does not matter here — the resolver
  // uses `enforce: 'pre'` to run before Vite's defaults
  // regardless of where it sits in the array — but keeping
  // `react()` first reads naturally as "the main plugin, then
  // the helper".
  plugins: [react(), tsFromJsResolver()],

  build: {
    // Renderer output goes into its own subdirectory so it does
    // not collide with the main-process output that `tsc` writes
    // to `dist/main/`. Both subdirectories live under `dist/`,
    // which the electron-builder `files` glob in `package.json`
    // picks up in one pass.
    outDir: 'dist/renderer',

    // Clear this directory before each build. Only `dist/renderer`
    // is cleared — the sibling `dist/main/` is left alone, so a
    // `vite build` run does not wipe the main-process output that
    // was written by a previous `tsc` run.
    emptyOutDir: true,

    // Sourcemaps are emitted in dev builds and, by default, in
    // production builds too. The build script does not currently
    // pass `--mode production`, so Vite's default `mode` is
    // `production`, and this setting opts in to sourcemaps for
    // that mode. They are small enough at this codebase's size
    // to keep, and they are the difference between a readable
    // stack trace and a wall of minified identifiers when a
    // renderer bug surfaces in the packaged app.
    sourcemap: true,
  },

  server: {
    // Pin the dev server to 5173. The Electron main process loads
    // the renderer from `http://localhost:5173` in dev mode, so a
    // silent port shift would leave the main process pointed at a
    // dead URL and the window blank with no obvious error.
    port: 5173,

    // Fail loudly on a port collision rather than shifting to
    // 5174. See the comment above.
    strictPort: true,
  },

  // Do not clear the terminal between rebuilds. When Electron and
  // Vite are running together under a single terminal — the
  // common dev loop, orchestrated by the `dev` script — Vite's
  // default clear-screen would erase Electron's startup logs
  // every time Vite restarts. The logs are what a developer
  // needs most during a restart, so they are preserved.
  clearScreen: false,
});