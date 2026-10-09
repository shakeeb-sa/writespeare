/**
 * PromptSelector — the prompt-template picker for the writer stage.
 *
 * Renders a dropdown that lets the user choose which of the three
 * built-in prompt templates the writer step uses for a topic. The
 * three templates are the ones the plan's tree declares under
 * `apps/desktop/src/resources/scripts/prompts/`:
 *
 *   default.md          The neutral, informative voice — the
 *                       default. Suitable for a broad range of
 *                       topics.
 *
 *   seo-focused.md      The keyword-heavy voice. Every keyword
 *                       must appear, with explicit placement
 *                       rules for the title, the intro, and the
 *                       H2 headings.
 *
 *   conversational.md   The friendly voice — first-person, direct
 *                       address, contractions. Suitable for a
 *                       personal blog, a newsletter, or any topic
 *                       where warmth reads as more trustworthy
 *                       than formality.
 *
 * ── Fully controlled ───────────────────────────────────────────
 *
 *   The component is a fully controlled input. It renders whatever
 *   `value` the parent passes and reports changes through
 *   `onChange`. It does not hold its own state, does not read any
 *   Zustand store, and does not call the IPC layer.
 *
 *   The consequence for the caller: a parent that wants the
 *   selection to persist across renders must hold it in its own
 *   state (or in the writer store) and pass it back down. The
 *   pattern is the same one `SourceCandidate.tsx` uses for its
 *   selection and `AdvancedSettings.tsx` uses for its fields —
 *   controlled component, parent owns the value.
 *
 * ── Where the value comes from and where it goes ───────────────
 *
 *   The topic object carries a `promptFile` field, populated at
 *   creation time from the New Topic modal's Advanced Settings
 *   section. When the writer IPC handler (`writerIPC.ts`) runs a
 *   generation, it reads `promptFile` from the topic's `topic.json`
 *   file and passes it to the writer service as the
 *   `--prompt-file` argument.
 *
 *   This component therefore has two possible callers:
 *
 *     1. A caller that wants to CHANGE the topic's prompt file
 *        before generating. That caller holds the selection in
 *        local state, passes it to `PromptSelector`, and — when
 *        the user clicks Generate — passes it to the writer
 *        store's `generate` action (or writes it back to the
 *        topic via the topics IPC channel). The wiring is a
 *        future session's concern.
 *
 *     2. A caller that wants to DISPLAY the current prompt file
 *        without changing it. That caller reads `topic.promptFile`
 *        and passes it to `PromptSelector` with a `disabled` flag
 *        set. The dropdown is read-only in that configuration.
 *
 *   The current implementation supports both usages without
 *   preferring either. Neither the writer store nor the writer
 *   IPC handler today holds a "current prompt file" field that
 *   the selector could read from directly, so the component
 *   remains presentational. See the PLAN DELTA logged with this
 *   file's creation for the wiring gap.
 *
 * ── Why a native `<select>` and not a custom dropdown ──────────
 *
 *   A native `<select>` brings keyboard interaction, screen-reader
 *   semantics, and platform-native rendering for free. A custom
 *   dropdown built from `<div>`s and click handlers would have to
 *   re-implement all three, and would inevitably get one of them
 *   subtly wrong. The visual design constraints the app's other
 *   dropdowns (the profile picker in `NewTopicModal.tsx`) already
 *   respect — Tailwind classes on the native element — are
 *   sufficient for this picker.
 *
 *   The alternative — a custom listbox with icons and descriptions
 *   per option — was considered and rejected. The three prompt
 *   templates are distinguishable by name, and their descriptions
 *   are already documented in the `prompts/` folder's own files.
 *   A picker that needed to show more than a name and a one-line
 *   label would warrant a custom UI; a three-option picker does
 *   not.
 *
 * ── The label and the description ──────────────────────────────
 *
 *   Each option's label is a short human-readable name ("Default",
 *   "SEO-focused", "Conversational"). Its value is the filename
 *   the writer service expects ("default.md", "seo-focused.md",
 *   "conversational.md"). The filename is what the Python side
 *   resolves against `<scripts>/prompts/`; the label is what the
 *   user sees in the dropdown.
 *
 *   A one-line description follows the dropdown in small muted
 *   text. The description changes with the selection — the user
 *   sees "Neutral, informative voice. Good for most topics." when
 *   Default is picked and "Keyword-heavy. Every keyword must
 *   appear with explicit placement." when SEO-focused is picked.
 *   The descriptions are the ones the three prompt files' own
 *   header comments document, condensed to one line each.
 *
 * ── What this component does NOT do ────────────────────────────
 *
 *   - It does not persist the selection. See "Fully controlled"
 *     above.
 *
 *   - It does not validate that the selected prompt file exists
 *     on disk. The Python side is the authoritative validator —
 *     a `prompt_file` that does not resolve to a file produces a
 *     clean error from `deepseek_writer.py`, which the writer
 *     IPC handler converts into a `{ success: false, error }`
 *     envelope. Adding a client-side existence check would
 *     require an IPC channel to enumerate the `prompts/` folder,
 *     which the plan does not declare.
 *
 *   - It does not offer a "custom prompt file" text input. A
 *     user who wants to use a prompt template named
 *     `my-style.md` uses the Advanced Settings section of the
 *     New Topic modal (`AdvancedSettings.tsx`), which accepts an
 *     arbitrary filename. This picker is a convenience for the
 *     three built-ins, not a replacement for the advanced path.
 *
 *   - It does not render an icon per option. The `FileText` icon
 *     imported from `lucide-react` is reserved for a future
 *     update; today it is used only as the leading glyph on the
 *     selector's label. See the "Unused import" note at the
 *     bottom of this file if the import list needs adjusting.
 */

import { useCallback, type ChangeEvent } from 'react';
import { FileText } from 'lucide-react';

// ============================================================
//  Public types
// ============================================================

/**
 * The props accepted by `PromptSelector`.
 *
 * The component is a standard controlled-input contract —
 * `value` and `onChange` — extended with an optional `disabled`
 * flag. The shape mirrors `PresetSelector.tsx`'s and
 * `AdvancedSettings.tsx`'s prop surfaces so that a reader who has
 * seen one has seen the pattern.
 */
export interface PromptSelectorProps {
  /** The currently-selected prompt file's name. One of the three
   *  `value` fields on `PROMPT_OPTIONS`, or any other string the
   *  caller wants to display as a currently-selected option. */
  value: string;

  /** Called when the user selects a different prompt file. The
   *  parent is responsible for updating its own `value`. */
  onChange: (value: string) => void;

  /** When true, the dropdown is disabled and cannot be changed.
   *  The parent sets this while a generation is in flight so the
   *  user cannot pick a new template mid-run. Defaults to
   *  `false`. */
  disabled?: boolean;
}

// ============================================================
//  Constants — the three built-in prompt templates
// ============================================================
//
//  The three templates the plan's file tree declares under
//  `apps/desktop/src/resources/scripts/prompts/`. Each entry
//  carries three fields:
//
//    value        The filename the writer service expects for the
//                 `--prompt-file` argument. Matches the on-disk
//                 filename exactly.
//    label        The short, human-readable name shown in the
//                 dropdown.
//    description  A one-line description of the template's voice,
//                 shown below the dropdown for the currently-
//                 selected option.
//
//  Declared as a `readonly` array so a caller cannot mutate the
//  constant by accident. The array's length is fixed at three;
//  a future session that added a fourth built-in template would
//  add an entry here without changing any other code.

interface PromptOption {
  readonly value: string;
  readonly label: string;
  readonly description: string;
}

const PROMPT_OPTIONS: readonly PromptOption[] = [
  {
    value: 'default.md',
    label: 'Default',
    description:
      'Neutral, informative voice. Good for most topics.',
  },
  {
    value: 'seo-focused.md',
    label: 'SEO-focused',
    description:
      'Keyword-heavy. Every keyword appears with explicit placement rules.',
  },
  {
    value: 'conversational.md',
    label: 'Conversational',
    description:
      'Warm, first-person voice. Good for personal blogs and newsletters.',
  },
];

/**
 * The description shown when the selected `value` does not match
 * any entry in `PROMPT_OPTIONS` — for example, a user-provided
 * template name from the Advanced Settings section, or the empty
 * string (which the writer service treats as `default.md`). The
 * fallback keeps the component's layout stable when a custom
 * filename is displayed.
 */
const CUSTOM_DESCRIPTION =
  'Custom template. Defined by the topic\u2019s advanced settings.';

// ============================================================
//  Internal helper — resolve the current option
// ============================================================

/**
 * Return the `PromptOption` whose `value` matches the given
 * filename, or `null` when no option matches.
 *
 * Used by the component to decide what description to display
 * below the dropdown. A missing match is a legitimate state —
 * the caller might pass a custom filename that the three built-in
 * options do not cover.
 */
const findOption = (value: string): PromptOption | null => {
  for (const option of PROMPT_OPTIONS) {
    if (option.value === value) {
      return option;
    }
  }
  return null;
};

// ============================================================
//  PromptSelector
// ============================================================

/**
 * The prompt-template picker. See the file header for the
 * component's scope, its controlled-input contract, and the
 * reasoning behind the native-`select` choice.
 */
export const PromptSelector = ({
  value,
  onChange,
  disabled = false,
}: PromptSelectorProps) => {
  // ---- Change handler ----
  // Reads the new value from the select element and forwards it
  // to the caller's `onChange`. The handler is `useCallback`-
  // wrapped so its identity is stable across renders — a caller
  // that lists `PromptSelector`'s `onChange` (not this handler,
  // which is internal) in a `useEffect` dependency array does not
  // need to worry about this wrapper, but the wrapper's
  // stability is still the right hygiene for a component whose
  // parent might memoize it.
  const handleChange = useCallback(
    (event: ChangeEvent<HTMLSelectElement>): void => {
      onChange(event.target.value);
    },
    [onChange]
  );

  // The description for the current selection. A matched option's
  // own description, or the custom-template fallback.
  const currentOption = findOption(value);
  const description =
    currentOption !== null ? currentOption.description : CUSTOM_DESCRIPTION;

  return (
    <div>
      {/* ---- Label ---- */}
      {/* A `<label>` bound to the select's id so a click on the
          label focuses the select, and so a screen reader
          announces the association. The `FileText` icon is a
          small leading glyph, purely decorative — `aria-hidden`
          keeps it out of the accessibility tree. */}
      <label
        htmlFor="writer-prompt-selector"
        className={
          'mb-1.5 flex items-center gap-1.5 text-sm font-medium ' +
          'text-text dark:text-neutral-200'
        }
      >
        <FileText
          size={14}
          className="text-neutral-500 dark:text-neutral-400"
          aria-hidden="true"
        />
        <span>Prompt template</span>
      </label>

      {/* ---- Select ---- */}
      {/* The native `<select>` styled with the same border, radius,
          padding, and focus treatment as every other select in the
          app (see `NewTopicModal.tsx`'s profile select for the
          shared styling vocabulary). The `disabled` attribute is
          what greys out the control while a generation is in
          flight. */}
      <select
        id="writer-prompt-selector"
        value={value}
        onChange={handleChange}
        disabled={disabled}
        className={
          'w-full rounded-lg border border-neutral-300 ' +
          'bg-background px-3 py-2 text-sm text-text ' +
          'focus:border-primary ' +
          'disabled:cursor-not-allowed disabled:opacity-60 ' +
          'dark:border-neutral-700 dark:bg-neutral-950 ' +
          'dark:text-neutral-100'
        }
      >
        {PROMPT_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
        {/* A caller that set a custom filename (not one of the
            three built-in values) would see the native select
            fall back to selecting the first option, which would
            silently misrepresent the value. The extra `<option>`
            below is rendered only when the current value does
            not match any built-in option, so the select shows
            the custom value as the selection. */}
        {currentOption === null && value.length > 0 && (
          <option value={value}>{value}</option>
        )}
      </select>

      {/* ---- Description ---- */}
      <p
        className={
          'mt-1 text-xs text-neutral-500 ' +
          'dark:text-neutral-400'
        }
      >
        {description}
      </p>
    </div>
  );
};

// ============================================================
//  Default export
// ============================================================

/**
 * The `PromptSelector` component as the default export.
 * Consumers that prefer the named form use
 * `import { PromptSelector } from ...`; consumers that prefer
 * the default form use `import PromptSelector from ...`. Both
 * resolve to the same component.
 */
export default PromptSelector;