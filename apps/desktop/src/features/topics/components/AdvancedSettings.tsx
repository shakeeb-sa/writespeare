/**
 * WriteSpeare — advanced settings section.
 *
 * The collapsible "Advanced Settings" section rendered inside the
 * New Topic modal. Two fields, both optional-in-practice — a
 * beginner never opens the section and the modal's form submits
 * with the defaults; a power user expands it to override the
 * prompt template or the word-count target for this one topic.
 *
 * The source-count field that this component used to carry is
 * gone. It has been superseded by the Search Distribution
 * section that the modal renders above this one; the four-bucket
 * layout in that section is now the single count-related concept
 * on a topic (per the C2 decision).
 *
 * The section is a disclosure — a button with `aria-expanded`
 * that toggles the visibility of a panel below it. It is closed
 * on mount; the user must click to open it. That is the entire
 * point of a disclosure: the default path is the common path, and
 * the advanced path is behind one deliberate click.
 *
 * The two fields:
 *
 *   Prompt file — a dropdown, with a fallback text input. The
 *     name of the Jinja2 template the writer step renders into
 *     the DeepSeek prompt. The dropdown is populated from the
 *     `usePrompts` hook — the built-in templates that ship with
 *     the app plus the user's own templates from the user
 *     prompts folder. The default is `default.md`, matching the
 *     backend schema's default for the field. When the current
 *     filename is not in the offered list — a custom template
 *     the user has named but not yet saved, or a template that
 *     was removed from the prompts folder — a text input
 *     appears beneath the dropdown so the user can enter or
 *     edit the name directly.
 *
 *   Word count — a numeric input, bounded [100, 10000]. The
 *     target length of the generated article. Clamped on blur.
 *
 * The numeric bounds come from the shared constants module,
 * which mirrors the backend schema's `min` and `max` validators
 * on the `wordCount` field. The constants are the single source
 * of truth for the client-side bound; a future change to the
 * bound is a one-line edit in that module.
 *
 * Clamping on blur, not on change — why:
 *
 *   A user editing the word-count field from "1200" to "800"
 *   typically selects the whole field and types "8", intending to
 *   then type "0", "0". If the field clamped on every change, the
 *   "8" (below the minimum of 100) would immediately be replaced
 *   with "100", and the user's cursor would be at the end of a
 *   three-character field they did not want. The user would have
 *   to select the "100" and retype. That is a hostile interaction
 *   for what is a normal edit.
 *
 *   Clamping on blur instead lets the user type freely; the
 *   clamping runs when they leave the field, at which point the
 *   intermediate states are behind them. Trace:
 *
 *     1. User selects "1200", types "8". Field shows "8". The
 *        parent's value is updated to 8 — see "Propagation" below.
 *     2. User types "0". Field shows "80". Parent updated to 80.
 *     3. User types "0". Field shows "800". Parent updated to 800.
 *     4. User clicks elsewhere. Blur fires. Parse "800" → 800.
 *        In range. No change to the parent. Field stays "800".
 *
 *   If the user had instead typed "5" and then blurred:
 *
 *     1. User types "5". Field shows "5". Parent updated to 5.
 *     2. User blurs. Parse "5" → 5. Below minimum of 100. Clamp
 *        to 100. Field shows "100". Parent updated to 100.
 *
 *   The final state is always in range; the transient states
 *   during typing are the user's responsibility.
 *
 * Propagation of intermediate values — why the parent may
 * temporarily hold an out-of-range number:
 *
 *   The change handler propagates the parsed value to the parent
 *   without clamping, so that a user who wants to type "800" over
 *   "1200" does not have to fight a field that keeps snapping to
 *   a clamped value. This means the parent's `values.wordCount`
 *   can be transiently out of range — 8, then 80, then 800 — as
 *   the user types.
 *
 *   Two facts make this safe:
 *
 *     (a) The blur handler clamps. When the user leaves the field
 *         — which happens before any submit, because clicking a
 *         submit button blurs the currently-focused input — the
 *         parent's value is corrected to be in range.
 *
 *     (b) If the user submits without blurring (which is possible
 *         by pressing Enter in a field, since HTML forms submit
 *         on Enter from a single-line input), the backend's
 *         schema validation rejects the out-of-range value with
 *         a 400. The modal's error toast surfaces the schema's
 *         own message ("wordCount must be at least 100"), and
 *         the user knows exactly what to fix.
 *
 *   The alternative — clamping on every keystroke — was rejected
 *   for the interaction-hostility reason described above. Between
 *   an aggressive clamp that fights the user and a lazy clamp
 *   that relies on blur plus a backend safety net, the lazy
 *   clamp is the correct choice for this form.
 *
 * Local state and the sync from the parent:
 *
 *   Each numeric field keeps a local string state (the raw text
 *   the user is currently typing) that is synced from the
 *   parent's number whenever the parent's number changes for a
 *   reason the field did not itself originate. In practice, the
 *   sync fires when the modal resets its form (the effect in
 *   `NewTopicModal` sets `values` back to the initial values on
 *   every open transition).
 *
 *   The sync is implemented as a `useEffect` keyed on the
 *   parent's number. When the effect fires and the stringified
 *   parent number matches the current raw string, the setState
 *   is a no-op — React bails out on the same value. When the
 *   parent number changed from something else (a reset), the
 *   effect updates the local raw string to match. This is the
 *   standard "controlled component with local buffer" pattern.
 *
 * Why the prompt field is a dropdown with a text-input fallback:
 *
 *   The user journey describes the prompt field as a dropdown,
 *   and the `prompts:list` IPC channel (registered by
 *   `promptsIPC.ts`) is what makes a dropdown possible: the
 *   renderer can now enumerate the built-in templates shipped
 *   with the app and the user's own templates from the user
 *   prompts folder.
 *
 *   The dropdown alone would not be sufficient, because the
 *   `promptFile` value on a topic can legitimately name a file
 *   that does not exist yet. The two cases:
 *
 *     1. A user who has just typed a filename in the modal but
 *        has not yet created the file (a future session's "Save
 *        as new prompt" affordance, or a hand-authored file the
 *        user intends to drop into the prompts folder).
 *
 *     2. A user whose previously-saved template was deleted from
 *        the prompts folder between when the topic was created
 *        and when this modal was opened.
 *
 *   In both cases the value is real — it is what the user wants
 *   the topic to use — but it is not in the list the dropdown can
 *   offer. Showing the dropdown alone would force the value to
 *   snap to an unrelated entry.
 *
 *   The component therefore renders the dropdown AND, when the
 *   current value is not one of the offered options, a text
 *   input beneath it. The dropdown carries an extra "Custom
 *   filename…" entry that switches the component into that mode
 *   explicitly, so the user can start typing a name that does
 *   not yet exist. A value the user types that happens to match
 *   an offered option (a hand-typed `default.md`) collapses the
 *   component back to the plain-dropdown form — the same
 *   auto-completion behaviour that a text input paired with a
 *   suggestion list produces.
 *
 * What this component does NOT do:
 *
 *   - It does not own the three values. The parent modal holds
 *     them in its form state; this component renders them and
 *     reports changes through `onChange`. See the file header
 *     above for the change/blur semantics.
 *
 *   - It does not validate the prompt file name against the
 *     list of saved templates. A value that does not match any
 *     entry is a legitimate state — see "Why the prompt field
 *     is a dropdown with a text-input fallback" above. The
 *     writer step is the layer that fails cleanly if the file
 *     does not exist when a run starts.
 *
 *   - It does not implement expand/collapse persistence. The
 *     section opens closed on every mount, which is the correct
 *     default — a user who wants the advanced fields opens the
 *     section every time they create a topic, and a user who
 *     does not is never bothered by a remembered "open" state
 *     they did not ask for.
 *
 *   - It does not render the whole modal. It is one section of
 *     the form; the modal composes this section with the title,
 *     keywords, preset picker, profile, and search distribution
 *     sections.
 */

import {
  useEffect,
  useMemo,
  useState,
  type ChangeEvent,
} from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

import { usePrompts } from '../../writer/hooks/usePrompts.js';
import {
  MAX_WORDS,
  MIN_WORDS,
} from '../../shared/constants/index.js';

// ============================================================
//  Public types
// ============================================================

/**
 * The three advanced fields. Declared as a named interface
 * (rather than inlined into `AdvancedSettingsProps`) so that a
 * consumer that needs to construct or type a value of this shape
 * — for example, a test — has a name to import.
 *
 * The shape is deliberately narrow — exactly the three fields
 * this component renders — so that a mismatch between what the
 * parent passes and what this component expects is a compile
 * error, not a silent `undefined` at runtime.
 */
interface AdvancedSettingsValues {
  /** The name of the Jinja2 template the writer step renders. */
  promptFile: string;

  /** The target length of the generated article, in words. */
  wordCount: number;
}

/**
 * A partial update to the advanced fields. Every field is
 * optional; the caller (`NewTopicModal`) merges the patch onto
 * its own form state with a spread. A patch with one field set
 * leaves the other two unchanged.
 */
interface AdvancedSettingsPatch {
  promptFile?: string;
  wordCount?: number;
}

/**
 * The props accepted by `AdvancedSettings`.
 *
 * The component is fully controlled: it holds the three field
 * VALUES only through the `values` prop, and it never mutates
 * them directly. It does hold one piece of purely local UI state
 * (`expanded`, the disclosure's open/closed flag) and two
 * transient buffer strings (the raw text in the numeric fields
 * while the user is typing) — none of which are the parent's
 * concern.
 */
export interface AdvancedSettingsProps {
  /** The current values of the three advanced fields. */
  values: AdvancedSettingsValues;

  /** Called with a partial patch whenever one of the fields
   *  changes. The parent merges the patch into its own state. */
  onChange: (patch: AdvancedSettingsPatch) => void;

  /** When true, the disclosure header and every field inside the
   *  panel are disabled. Defaults to `false`. */
  disabled?: boolean;
}

// ============================================================
//  Helpers
// ============================================================


/**
 * The sentinel value the prompt-file dropdown uses to represent
 * the "the current value is not one of the offered options, show
 * the fallback text input" state.
 *
 * The value is deliberately a string that cannot be a valid
 * prompt filename — the `promptsIPC` layer's `isValidPromptName`
 * helper rejects any name starting with a dot, and the
 * `listPromptNames` reader in the same module filters dotfiles
 * out of the folder listing. A user template named `.custom`
 * therefore cannot exist, so no collision between a real
 * filename and the sentinel is possible.
 *
 * The double-underscore prefix also matches the codebase's
 * convention for internal marker values (`_handleMarker` on the
 * Zustand stores, the `__v` field Mongoose adds), which makes
 * the sentinel read as internal rather than as a filename.
 */
const CUSTOM_PROMPT_SENTINEL = '.custom';

/**
 * Parse a user-typed string into a bounded integer, or return
 * `null` if the string does not represent one.
 *
 * Accepts an empty string (returns `null` — the caller treats
 * that as "user is still typing, do not propagate"). Accepts
 * any string that `Number.parseInt` accepts, then clamps the
 * result into `[min, max]`. Rejects `NaN` and `±Infinity` (which
 * `parseInt` never produces but the type guard cannot assume).
 *
 * The clamp is applied by this function rather than by the
 * caller so that both the change handler (which uses the
 * unclamped parse) and the blur handler (which uses the clamped
 * one) can share the same parsing logic and only differ in which
 * branch they take. The unclamped path is achieved by passing a
 * `[min, max]` range wide enough to never clamp — see the
 * callers.
 *
 * The `Number.parseInt` radix of 10 is explicit rather than
 * implicit. Under `noImplicitAny` and the codebase's general
 * preference for explicit intent, an implicit radix is a
 * low-grade footgun: a string beginning with "0x" would parse
 * as hexadecimal under some engine defaults, producing a value
 * the user did not type. Pinning the radix to 10 avoids that
 * entirely.
 */
const parseBoundedInt = (
  input: string,
  min: number,
  max: number
): number | null => {
  if (input === '') {
    return null;
  }
  const parsed = Number.parseInt(input, 10);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return Math.min(Math.max(parsed, min), max);
};

// ============================================================
//  AdvancedSettings
// ============================================================

/**
 * The advanced settings disclosure. See the file header for the
 * component's responsibilities, the change/blur semantics of the
 * numeric fields, and the reasoning behind the text-input shape
 * of the prompt field.
 */
export const AdvancedSettings = ({
  values,
  onChange,
  disabled = false,
}: AdvancedSettingsProps) => {
  // ---- Disclosure state ----
  const [expanded, setExpanded] = useState(false);

  // ---- Local buffer strings for the two numeric fields ----
  //
  // The parent holds the three field values as numbers; the two
  // numeric inputs render as strings. The buffers below hold the
  // exact text the user is currently typing so that intermediate
  // states — a leading "1" that will become "1200", a temporary
  // empty string when the user selects-all-and-deletes — survive
  // React's controlled-input round trip.
  //
  // The initial values are the string forms of the parent's
  // initial numbers. On external change (a modal reset), the
  // sync effects below update the buffers to match.
  const [wordCountRaw, setWordCountRaw] = useState(
    String(values.wordCount)
  );

  // ---- Prompt list from the prompts IPC layer ----
  // The dropdown's options come from this hook. The hook is a
  // passive reader — see the "fetch on mount" effect below for
  // what triggers the initial list load. See the file header's
  // "Why the prompt field is a dropdown with a text-input
  // fallback" section for the reasoning on why the fallback
  // exists.
  const { builtinPrompts, userPrompts, refresh: refreshPrompts } =
    usePrompts();

  // The merged, deduped list of every prompt name the dropdown
  // can offer. A user template with the same filename as a
  // built-in shadows it on disk; the dropdown shows the name
  // once, and the shadowing rule is what the writer step
  // applies when it resolves the file.
  const availablePrompts = useMemo(
    () => Array.from(new Set([...builtinPrompts, ...userPrompts])),
    [builtinPrompts, userPrompts]
  );

  // Whether the component is in "custom filename" entry mode.
  // True when the user has explicitly picked the "Custom
  // filename…" option from the dropdown, or when the current
  // value is not in the offered list. See the file header for
  // the full reasoning.
  const [isCustomEntry, setIsCustomEntry] = useState(false);

  // ---- Sync numeric buffers from the parent ----
  //
  // Runs whenever the parent's number for the corresponding field
  // changes. When the change was originated by this component's
  // own change handler (the common case during typing), the
  // stringified parent number matches the current buffer, and the
  // setState is a React no-op. When the change was external — the
  // modal's reset-on-open effect setting the values back to the
  // initial ones — the buffer is updated to match.
  //
  // The two effects are keyed on the individual numbers rather
  // than on the whole `values` object, because the object's
  // identity changes on every parent render (the parent builds a
  // fresh literal for the `values` prop on every render), and
  // keying on the object would fire the effect on every keystroke
  // in every field of the modal.
  useEffect(() => {
    setWordCountRaw(String(values.wordCount));
  }, [values.wordCount]);

  // ---- Fetch the prompt list on mount ----
  // The `usePrompts` hook is a passive reader; this effect is
  // what triggers the initial list fetch. The `refresh`
  // reference is stable (a `useCallback` from the hook), so the
  // effect fires exactly once per mount.
  useEffect(() => {
    void refreshPrompts();
  }, [refreshPrompts]);

  // ---- Sync custom-entry mode when the value changes ----
  // When the parent's `promptFile` value changes — the modal
  // resets its form on open, or the user picks a known prompt
  // from the dropdown — the component exits custom-entry mode
  // if the new value is in the offered list. When the new value
  // is not in the list, custom-entry mode stays on (the user is
  // mid-typing a custom name).
  //
  // The effect deliberately does NOT force custom-entry mode ON
  // when the value is unknown: a user who just picked a known
  // prompt should stay in dropdown mode until the file actually
  // changes. The select's `value` derivation below handles the
  // "unknown value, not in custom mode" case by showing the
  // sentinel anyway.
  useEffect(() => {
    if (availablePrompts.includes(values.promptFile)) {
      setIsCustomEntry(false);
    }
  }, [values.promptFile, availablePrompts]);

  // ---- Disclosure toggle ----
  const toggleExpanded = (): void => {
    setExpanded((prev) => !prev);
  };

  // ---- Prompt file change ----
  //
  // A direct passthrough — no parsing, no validation. The value
  // the user typed is exactly what the parent receives. See the
  // file header for why this field is a text input rather than
  // a dropdown.
  const handlePromptFileChange = (
    event: ChangeEvent<HTMLInputElement>
  ): void => {
    onChange({ promptFile: event.target.value });
  };

  
  // ---- Prompt select change ----
  //
  // The dropdown's change handler. Two branches:
  //
  //   * The sentinel — the user explicitly chose the "Custom
  //     filename…" entry, so the component enters custom-entry
  //     mode without changing the parent's value. The fallback
  //     text input appears beneath the dropdown with the
  //     current value pre-filled.
  //
  //   * A known prompt name — the user picked a real template,
  //     so the parent's value is updated and custom-entry mode
  //     is cleared.
  //
  // The sentinel branch deliberately leaves the parent's value
  // untouched. A user who picks "Custom filename…" from a
  // dropdown that was showing `default.md` has not yet said what
  // the new name should be; writing a placeholder to the parent
  // would send the placeholder to the backend if the user
  // submitted before typing. Leaving the value alone means the
  // worst case is a submit with the previous value, which is a
  // state the user can see and correct.
  const handlePromptSelectChange = (
    event: ChangeEvent<HTMLSelectElement>
  ): void => {
    const value = event.target.value;
    if (value === CUSTOM_PROMPT_SENTINEL) {
      setIsCustomEntry(true);
      return;
    }
    setIsCustomEntry(false);
    onChange({ promptFile: value });
  };

  // ---- Word count change ----
  //
  // Updates the buffer with the raw text, then propagates the
  // parsed number to the parent WITHOUT clamping — see the file
  // header for why the intermediate out-of-range value is safe.
  // An empty or unparseable input does not propagate; the buffer
  // keeps the raw text so the user can continue typing.
  //
  // The `Number.MIN_SAFE_INTEGER` / `Number.MAX_SAFE_INTEGER`
  // bounds on the parse call are wide enough to never clamp in
  // practice; the intent is "parse, do not clamp", and passing
  // the widest possible integer range is how that intent is
  // expressed through the shared helper.
  const handleWordCountChange = (
    event: ChangeEvent<HTMLInputElement>
  ): void => {
    const raw = event.target.value;
    setWordCountRaw(raw);
    const parsed = parseBoundedInt(
      raw,
      Number.MIN_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER
    );
    if (parsed === null) {
      return;
    }
    onChange({ wordCount: parsed });
  };

  // ---- Word count blur ----
  //
  // Clamps the buffer to the field's bounds and re-syncs the
  // parent to the clamped value. If the buffer is empty or
  // unparseable, the buffer is restored to the parent's current
  // value — the field re-shows the last valid number.
  const handleWordCountBlur = (): void => {
    const parsed = parseBoundedInt(
      wordCountRaw,
      Number.MIN_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER
    );
    if (parsed === null) {
      setWordCountRaw(String(values.wordCount));
      return;
    }
    const clamped = Math.min(Math.max(parsed, MIN_WORDS), MAX_WORDS);
    setWordCountRaw(String(clamped));
    if (clamped !== values.wordCount) {
      onChange({ wordCount: clamped });
    }
  };

  
  // ---- Derived dropdown state ----
  //
  // `isKnownPrompt` is true when the current value is one of the
  // offered options. `showCustomInput` is true when the fallback
  // text input should render — either because the user entered
  // custom mode explicitly, or because the current value is not
  // in the list (so the dropdown alone could not display it
  // correctly).
  //
  // `selectValue` is what the `<select>` element's `value` prop
  // is bound to. When the fallback is shown, the select shows
  // the sentinel entry; otherwise it shows the current value,
  // which is guaranteed to match an option because
  // `isKnownPrompt` is true.
  const isKnownPrompt = availablePrompts.includes(values.promptFile);
  const showCustomInput = isCustomEntry || !isKnownPrompt;
  const selectValue = showCustomInput
    ? CUSTOM_PROMPT_SENTINEL
    : values.promptFile;


  // ---- Render ----
  return (
    <div
      className={
        'rounded-lg border border-neutral-200 ' +
        'dark:border-neutral-800'
      }
    >
      {/* ---- Disclosure header ---- */}
      <button
        type="button"
        onClick={toggleExpanded}
        disabled={disabled}
        aria-expanded={expanded}
        aria-controls="advanced-settings-panel"
        className={
          'flex w-full items-center gap-2 rounded-lg ' +
          'px-3 py-2 text-sm font-medium text-text ' +
          'transition-colors hover:bg-neutral-50 ' +
          'disabled:cursor-not-allowed disabled:opacity-60 ' +
          'dark:text-neutral-100 dark:hover:bg-neutral-800/40 ' +
          'focus-visible:outline-none'
        }
      >
        {expanded ? (
          <ChevronDown size={16} aria-hidden="true" />
        ) : (
          <ChevronRight size={16} aria-hidden="true" />
        )}
        <span>Advanced Settings</span>
      </button>

      {/* ---- Disclosure panel ---- */}
      {expanded && (
        <div
          id="advanced-settings-panel"
          className={
            'space-y-4 border-t border-neutral-200 ' +
            'px-3 py-4 dark:border-neutral-800'
          }
        >
          {/* ---- Prompt file ---- */}
          <div>
            <label
              htmlFor="advanced-prompt-file"
              className={
                'mb-1.5 block text-sm font-medium ' +
                'text-text dark:text-neutral-200'
              }
            >
              Prompt file
            </label>
            <select
              id="advanced-prompt-file"
              value={selectValue}
              onChange={handlePromptSelectChange}
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
              {availablePrompts.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
              <option value={CUSTOM_PROMPT_SENTINEL}>
                Custom filename…
              </option>
            </select>
            {showCustomInput && (
              <input
                id="advanced-prompt-file-custom"
                type="text"
                value={values.promptFile}
                onChange={handlePromptFileChange}
                disabled={disabled}
                placeholder="my-style.md"
                className={
                  'mt-2 w-full rounded-lg border border-neutral-300 ' +
                  'bg-background px-3 py-2 text-sm text-text ' +
                  'placeholder-neutral-400 focus:border-primary ' +
                  'disabled:cursor-not-allowed disabled:opacity-60 ' +
                  'dark:border-neutral-700 dark:bg-neutral-950 ' +
                  'dark:text-neutral-100 dark:placeholder-neutral-500'
                }
              />
            )}
            <p
              className={
                'mt-1 text-xs text-neutral-500 ' +
                'dark:text-neutral-400'
              }
            >
              The template the writer fills in. Defaults to
              <code className="mx-1 font-mono">default.md</code>.
            </p>
          </div>

          {/* ---- Word count ---- */}
          <div>
            <label
              htmlFor="advanced-word-count"
              className={
                'mb-1.5 block text-sm font-medium ' +
                'text-text dark:text-neutral-200'
              }
            >
              Word count
            </label>
            <input
              id="advanced-word-count"
              type="number"
              inputMode="numeric"
              min={MIN_WORDS}
              max={MAX_WORDS}
              step={100}
              value={wordCountRaw}
              onChange={handleWordCountChange}
              onBlur={handleWordCountBlur}
              disabled={disabled}
              className={
                'w-full rounded-lg border border-neutral-300 ' +
                'bg-background px-3 py-2 text-sm text-text ' +
                'focus:border-primary ' +
                'disabled:cursor-not-allowed disabled:opacity-60 ' +
                'dark:border-neutral-700 dark:bg-neutral-950 ' +
                'dark:text-neutral-100'
              }
            />
            <p
              className={
                'mt-1 text-xs text-neutral-500 ' +
                'dark:text-neutral-400'
              }
            >
              {MIN_WORDS}–{MAX_WORDS.toLocaleString()}
            </p>
          </div>
        </div>
      )}
    </div>
  );
};

// ============================================================
//  Default export
// ============================================================

/**
 * The `AdvancedSettings` component as the default export.
 * `NewTopicModal.tsx` imports it with the default form
 * (`import AdvancedSettings from './AdvancedSettings.js'`), so
 * this is the export that keeps the modal's form resolving.
 */
export default AdvancedSettings;