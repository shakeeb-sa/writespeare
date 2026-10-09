/**
 * Tailwind CSS configuration for the WriteSpeare renderer.
 *
 * This file is the single source of truth for the app's visual
 * design tokens. Every color, font, radius, and shadow that the
 * renderer uses is declared here, and every Tailwind utility class
 * (`bg-primary`, `text-accent`, `rounded-2xl`, `shadow-soft`) is
 * generated from the values below. Nothing in the codebase should
 * hard-code a hex color or a raw pixel value for a design token —
 * if a new color is needed, it belongs here, not in a `style`
 * attribute or a CSS file.
 *
 * File format:
 *
 *   The file uses the `.js` extension even though it is consumed
 *   by a Node build tool that could load `.mjs` or `.cjs` equally
 *   well, because the plan's file tree declares it as
 *   `tailwind.config.js` and because `package.json` in this
 *   workspace declares `"type": "module"` — which makes this file
 *   ESM by default. The `export default` at the bottom is the
 *   correct form for an ESM module. There is no CommonJS
 *   alternative to consider; the surrounding package is ESM.
 *
 * No runtime import of Tailwind's types:
 *
 *   The `/** @type {import('tailwindcss').Config} *\/` JSDoc
 *   comment at the top of the exported object is what gives the
 *   editor IntelliSense for the `theme`, `content`, and other
 *   keys. It is a documentation-only reference — the `import(...)`
 *   inside a JSDoc comment is resolved by the language server
 *   without generating a runtime `require` or a bundler-side
 *   import. The same pattern is used in `postcss.config.js`.
 *
 * Color tokens — what each one is for:
 *
 *   `primary`     — the app's hero color. Used for primary action
 *                   buttons, active navigation states, focused
 *                   inputs, and any element that should read as
 *                   "the user's main path forward". The three
 *                   variants (DEFAULT, light, dark) cover hover,
 *                   disabled, and pressed states.
 *
 *   `secondary`   — a softer supporting color. Used for badges,
 *                   tags, secondary buttons, and any element
 *                   that needs to read as "related to primary
 *                   but not the main action".
 *
 *   `accent`      — a warm attention color. Used for warnings,
 *                   AI-marker flags, and any UI element that
 *                   needs to draw the eye without being as
 *                   dominant as a full primary button.
 *
 *   `text` and `background` — the two neutral base tokens. Used
 *                   as the foreground and background of every
 *                   page. The values are pure black and pure
 *                   white, which is deliberate: contrast is a
 *                   design decision made per-element with the
 *                   tinted tokens above, not a global choice
 *                   baked into these two.
 *
 *   The full palette for each token is a nested object with
 *   `DEFAULT`, `light`, and `dark` keys. Tailwind flattens this
 *   so that `bg-primary` maps to `primary.DEFAULT`, `bg-primary-light`
 *   maps to `primary.light`, and `bg-primary-dark` maps to
 *   `primary.dark` — the same convention Tailwind's built-in
 *   color palettes (`blue-500`, `blue-600`) follow.
 *
 * Font family — why the app declares its own stack:
 *
 *   The default Tailwind sans stack is a generic system font
 *   list. WriteSpeare wants a specific look — Inter for prose,
 *   JetBrains Mono for code and prompt templates — with system
 *   fallbacks so the app still renders correctly if the primary
 *   font is not installed on the user's machine. Neither font
 *   is bundled with the app by the plan; they are expected to
 *   be present on the developer's machine during development
 *   and available from the OS's font stack during use. If a
 *   future session decides to bundle them, the change is to add
 *   the font files under `src/resources/` and reference them
 *   from the CSS — not to change this file.
 *
 * Border radius — why the app extends Tailwind's defaults:
 *
 *   Tailwind's default scale stops at `rounded-3xl` (1.5rem).
 *   The plan's mockups use `rounded-xl` and `rounded-2xl` heavily,
 *   and the app wants a softer, more modern feel than Tailwind's
 *   built-in `xl` (0.75rem) provides. The extension overrides
 *   the two default tokens at the sizes the app actually uses,
 *   so that `rounded-xl` renders at 1rem rather than 0.75rem.
 *   This is an override, not an addition — the defaults it
 *   replaces were not in use anywhere in the codebase.
 *
 * Box shadow — why the app declares two named shadows:
 *
 *   Named shadows (`shadow-soft`, `shadow-medium`) are easier to
 *   reason about than numeric Tailwind sizes and easier to
 *   change globally: bumping the opacity of every card shadow
 *   in the app is a one-line change here rather than a search-
 *   and-replace across fifty components. The two values are
 *   deliberately subtle — this is a productivity app, not a
 *   marketing site, and heavy drop shadows read as dated on a
 *   UI that a user spends hours inside.
 *
 * Dark mode — why `class`, not `media`:
 *
 *   Tailwind's two dark-mode strategies are `'media'` (follow
 *   the OS preference via `prefers-color-scheme`) and `'class'`
 *   (toggle by adding a `dark` class to an ancestor element).
 *   The app uses `'class'` because the theme preference is an
 *   explicit, per-user setting stored in `UserSettingsMap.theme`
 *   — a user who prefers light mode on a dark-mode OS, or vice
 *   versa, should get what they chose, not what the OS chose.
 *   The `dark` class is applied to the `<html>` element by the
 *   renderer's root component based on the stored setting.
 *
 * The `content` glob — why it lists both HTML and TSX:
 *
 *   Tailwind works by scanning source files for class-name
 *   strings, then emitting only the CSS utilities that were
 *   actually found. Files that are not in this list are not
 *   scanned, and any class name that appears only in an
 *   unscanned file is silently dropped from the output — the
 *   utility exists but its styles do not, which produces a
 *   visually broken element with no error message. The glob
 *   below covers the two places class names ever appear: the
 *   Vite entry HTML (which carries a small number of classes on
 *   the `<body>` and a loading splash), and every TS/TSX file
 *   under `src/` (where all component classes live).
 */

/** @type {import('tailwindcss').Config} */
export default {
  // ----------------------------------------------------------
  //  Content
  // ----------------------------------------------------------
  //  The two patterns below cover the only two file locations
  //  where Tailwind class names appear in this app. See the
  //  file header for why an unscanned file is a silent failure.
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
  ],

  // ----------------------------------------------------------
  //  Dark mode
  // ----------------------------------------------------------
  //  'class' rather than 'media' — the user's stored theme
  //  preference wins over the OS preference. See the file header.
  darkMode: 'class',

  // ----------------------------------------------------------
  //  Theme
  // ----------------------------------------------------------
  theme: {
    extend: {
      // ---- Brand colors ----
      //  The three brand tokens plus the two neutral base tokens.
      //  Every color used in the UI resolves to one of these, or
      //  to a Tailwind built-in for status colors (red-600 for
      //  errors, amber-500 for warnings) that the design does
      //  not need to override.
      colors: {
        text: '#000000',
        background: '#ffffff',
        primary: {
          DEFAULT: '#03A791',
          light: '#81E7AF',
          dark: '#028A78',
        },
        secondary: {
          DEFAULT: '#81E7AF',
          dark: '#5BC98A',
        },
        accent: {
          DEFAULT: '#F1BA88',
          dark: '#E0A06A',
        },
      },

      // ---- Font families ----
      //  Two stacks: `sans` for prose, `mono` for code and
      //  prompt templates. Both fall back to the system stack
      //  so the app renders correctly on a machine where Inter
      //  and JetBrains Mono are not installed.
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },

      // ---- Border radius ----
      //  Overrides Tailwind's `xl` and `2xl` defaults at the
      //  sizes the app actually uses. See the file header for
      //  why these are overrides rather than additions.
      borderRadius: {
        xl: '1rem',
        '2xl': '1.5rem',
      },

      // ---- Box shadows ----
      //  Two named, deliberately subtle shadows. See the file
      //  header for why they are named and why they are soft.
      boxShadow: {
        soft: '0 2px 8px rgba(0, 0, 0, 0.08)',
        medium: '0 4px 16px rgba(0, 0, 0, 0.12)',
      },
    },
  },

  // ----------------------------------------------------------
  //  Plugins
  // ----------------------------------------------------------
  //  No plugins are enabled. Every utility the app uses is
  //  either a Tailwind core utility or one of the theme
  //  extensions declared above. If a future session needs a
  //  plugin (forms, typography, aspect-ratio), it is added to
  //  this array — the plan does not declare any.
  plugins: [],
};