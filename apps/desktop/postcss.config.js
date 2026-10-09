/**
 * PostCSS configuration for the WriteSpeare renderer.
 *
 * PostCSS is the CSS transformation pipeline that Vite runs every
 * stylesheet through during development and at build time. This
 * file tells PostCSS which plugins to apply, in what order. The
 * renderer's stylesheet — `src/renderer/styles/tailwind.css` — is
 * written using Tailwind's directive syntax (`@tailwind base;`,
 * `@tailwind components;`, `@tailwind utilities;`) plus a small
 * set of custom base styles. Those directives are not valid CSS;
 * they are placeholders that the Tailwind PostCSS plugin replaces
 * with the actual generated CSS. Without this config, Vite would
 * pass the stylesheet through unchanged, the directives would
 * remain in the output as unknown at-rules, and every Tailwind
 * utility class in the app's `.tsx` files would have no matching
 * CSS rule — the renderer would display unstyled HTML.
 *
 * The two plugins — what each one does and why it is here:
 *
 *   1. `tailwindcss` — reads the `content` glob from
 *      `tailwind.config.js`, scans every file the glob matches
 *      for class-name strings, generates the minimal set of
 *      utility rules that covers the class names it found, and
 *      substitutes the generated rules in place of the
 *      `@tailwind` directives. This is the plugin that makes
 *      every `bg-primary`, `text-accent`, `rounded-2xl`, and
 *      `shadow-soft` class in the app do something.
 *
 *   2. `autoprefixer` — parses the CSS that Tailwind produced
 *      (and the custom base styles in the same stylesheet),
 *      checks each rule against a browser-target list, and adds
 *      the vendor prefixes (`-webkit-`, `-moz-`, `-ms-`) that
 *      the target browsers need. Electron 44 bundles a modern
 *      Chromium, so most modern CSS is supported unprefixed;
 *      the prefixes Autoprefixer adds are for the few edge cases
 *      Chromium still requires (certain flexbox gap behaviours,
 *      `user-select`, `appearance` on form controls). Removing
 *      Autoprefixer would not visibly break the app today, but
 *      it would leave those edge cases as a latent bug — a
 *      property that renders correctly in a fresh install but
 *      breaks on an older Chromium on a user's machine.
 *
 * Plugin order matters and is not alphabetical:
 *
 *   Tailwind runs first, Autoprefixer runs second. The order is
 *   required, not a preference:
 *
 *     - Tailwind's job is to expand the `@tailwind` directives
 *       into generated utility rules. The generated rules are
 *       what Autoprefixer needs to see — if Autoprefixer ran
 *       first, it would see only the `@tailwind` directives and
 *       have nothing to prefix.
 *
 *     - Autoprefixer's job is to inspect every rule in the
 *       stylesheet (both the ones Tailwind generated and the
 *       custom base styles written by hand) and add any missing
 *       vendor prefixes. Running it after Tailwind is what
 *       ensures the generated utilities are also prefixed where
 *       needed.
 *
 *   PostCSS runs plugins in the order they appear in the
 *   `plugins` object. Object key order is insertion order in
 *   JavaScript — the language specification guarantees this for
 *   string keys — so `tailwindcss` appearing first is what
 *   enforces the order. There is no separate "order" field; the
 *   order is the file.
 *
 * File format:
 *
 *   The `.js` extension with `export default` matches
 *   `tailwind.config.js` and reflects the workspace's
 *   `"type": "module"` setting in package.json. PostCSS's own
 *   loader detects the module system from the file extension
 *   and the enclosing package.json, so the ESM form is the
 *   correct one here.
 *
 * String-literal plugin names:
 *
 *   The `plugins` object uses string keys (`tailwindcss` and
 *   `autoprefixer`) that PostCSS resolves against node_modules
 *   at load time. This is the standard PostCSS config format and
 *   is what Vite's PostCSS integration expects. An alternative
 *   form — `import tailwindcss from 'tailwindcss'` followed by
 *   `plugins: [tailwindcss(), autoprefixer()]` — is also legal
 *   and equivalent. The string-literal form is used here because
 *   it is the convention established by Tailwind's own docs and
 *   because it produces a shorter file with no import statements
 *   whose resolution could fail if a future refactor moved
 *   `node_modules/`.
 *
 * What this file deliberately does NOT do:
 *
 *   - It does not configure PostCSS plugins beyond the two
 *     above. `postcss-import`, `postcss-nesting`, `cssnano` —
 *     none are enabled. Vite handles CSS imports at the
 *     bundler level, so `postcss-import` would be redundant.
 *     Vite's production build minifies CSS on its own, so
 *     `cssnano` would be redundant. Nested CSS is not used
 *     anywhere in the renderer's stylesheet.
 *
 *   - It does not set a `from` or `to` path. Those options are
 *     for PostCSS's own CLI; Vite's integration supplies them
 *     automatically from the file being processed.
 *
 *   - It does not reference `tailwind.config.js` by path.
 *     Tailwind's PostCSS plugin discovers the config file by
 *     convention — a file named `tailwind.config.js` at the
 *     project root — and loads it automatically. Naming the
 *     path explicitly would be redundant as long as the config
 *     file remains where it is (and it will: the plan's file
 *     tree fixes its location).
 */

export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};