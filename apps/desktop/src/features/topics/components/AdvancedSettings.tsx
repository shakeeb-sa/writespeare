/**
 * WriteSpeare — advanced settings section.
 *
 * The collapsible "Advanced Settings" section rendered inside the
 * New Topic modal. Three fields, all optional-in-practice — a
 * beginner never opens the section and the modal's form submits
 * with the defaults; a power user expands it to override the
 * prompt template, the word-count target, or the source-count
 * target for this one topic.
 *
 * The section is a disclosure — a button with `aria-expanded`
 * that toggles the visibility of a panel below it. It is closed
 * on mount; the user must click to open it. That is the entire
 * point of a disclosure: the default path is the common path, and
 * the advanced path is behind one deliberate click.
 *
 * The three fields:
 *
 *   Prompt file — a text input. The name of the Jinja2 template
 *     the writer step renders into the DeepSeek prompt. The
 *     default is `default.md`, matching the backend schema's
 *     default for the field. The user can override it to any
 *     filename; the writer script loads the template by name
 *     from the prompts folder, and a name that does not resolve
 *     to a file produces a clear error at generation time. A
 *     closed dropdown of the three built-in templates was
 *     considered and rejected — see "Why the prompt field is a
 *     text input" below.
 *
 *   Word count — a numeric input, bounded [100, 10000]. The
 *     target length of the generated article. Clamped on blur.
 *
 *   Source count — a numeric input, bounded [1, 50]. The target
 *     number of source documents the pipeline fetches for this
 *     topic. Clamped on blur.
 *
 * The numeric bounds come from the shared constants module,
 * which mirrors the backend schema's `min` and `max` validators
 * on the same two fields. The constants are the single source of
 * truth for the client-side bounds; a future change to the
 * bounds is a one-line edit in that module.
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
 * Why the prompt field is a text input and not a dropdown:
 *
 *   The plan's user-journey mockup shows the prompt field as a
 *   dropdown with a chevron, implying a fixed list. But the plan
 *   declares no constants module for prompt file names, no IPC
 *   channel to enumerate the prompts folder, and no shared type
 *   for the set of valid prompt files. The three built-in
 *   templates (`default.md`, `seo-focused.md`,
 *   `conversational.md`) live under
 *   `apps/desktop/src/resources/scripts/prompts/` — a folder
 *   that the renderer has no way to read.
 *
 *   A dropdown would therefore require hard-coding the three
 *   filenames in this file. That hard-coded list would drift the
 *   moment a session added a fourth prompt template, and the
 *   user journey's Stage 9 explicitly describes a user writing
 *   their own custom template (say, `my-style.md`) — a file that
 *   a hard-coded dropdown could not offer. A text input accepts
 *   any filename, defers validation to the writer step (which
 *   produces a clear "template not found" error), and requires
 *   no maintenance when the set of available templates changes.
 *
 *   If a future session adds an IPC channel to list prompt files
 *   — say, `settings:listPrompts` — the correct change is to
 *   switch this field to a `<select>` populated from that
 *   channel's result, at which point the list is dynamic and the
 *   concern that motivated the text input here is resolved. That
 *   change is not in scope for the current session.
 *
 * What this component does NOT do:
 *
 *   - It does not own the three values. The parent modal holds
 *     them in its form state; this component renders them and
 *     reports changes through `onChange`. See the file header
 *     above for the change/blur semantics.
 *
 *   - It does not validate the prompt file name against a list.
 *     See "Why the prompt field is a text input" for the
 *     rationale.
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
 *     keywords, preset picker, and profile fields.
 */

import {
  useEffect,
  useState,
  type ChangeEvent,
} from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

import {
  MAX_SOURCES,
  MAX_WORDS,
  MIN_SOURCES,
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

  /** The target number of source documents the pipeline fetches. */
  sourceCount: number;
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
  sourceCount?: number;
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
  const [sourceCountRaw, setSourceCountRaw] = useState(
    String(values.sourceCount)
  );

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

  useEffect(() => {
    setSourceCountRaw(String(values.sourceCount));
  }, [values.sourceCount]);

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

  // ---- Source count change ----
  //
  // Mirrors `handleWordCountChange` exactly. The two handlers
  // are not factored into a shared parameterised function
  // because the codebase's convention is that two inline
  // handlers with the same shape but different field names read
  // more clearly at the call site than one shared handler
  // threaded with a key argument.
  const handleSourceCountChange = (
    event: ChangeEvent<HTMLInputElement>
  ): void => {
    const raw = event.target.value;
    setSourceCountRaw(raw);
    const parsed = parseBoundedInt(
      raw,
      Number.MIN_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER
    );
    if (parsed === null) {
      return;
    }
    onChange({ sourceCount: parsed });
  };

  // ---- Source count blur ----
  const handleSourceCountBlur = (): void => {
    const parsed = parseBoundedInt(
      sourceCountRaw,
      Number.MIN_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER
    );
    if (parsed === null) {
      setSourceCountRaw(String(values.sourceCount));
      return;
    }
    const clamped = Math.min(
      Math.max(parsed, MIN_SOURCES),
      MAX_SOURCES
    );
    setSourceCountRaw(String(clamped));
    if (clamped !== values.sourceCount) {
      onChange({ sourceCount: clamped });
    }
  };

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
            <input
              id="advanced-prompt-file"
              type="text"
              value={values.promptFile}
              onChange={handlePromptFileChange}
              disabled={disabled}
              placeholder="default.md"
              className={
                'w-full rounded-lg border border-neutral-300 ' +
                'bg-background px-3 py-2 text-sm text-text ' +
                'placeholder-neutral-400 focus:border-primary ' +
                'disabled:cursor-not-allowed disabled:opacity-60 ' +
                'dark:border-neutral-700 dark:bg-neutral-950 ' +
                'dark:text-neutral-100 dark:placeholder-neutral-500'
              }
            />
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

          {/* ---- Word count + source count ---- */}
          <div className="grid grid-cols-2 gap-3">
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

            <div>
              <label
                htmlFor="advanced-source-count"
                className={
                  'mb-1.5 block text-sm font-medium ' +
                  'text-text dark:text-neutral-200'
                }
              >
                Source count
              </label>
              <input
                id="advanced-source-count"
                type="number"
                inputMode="numeric"
                min={MIN_SOURCES}
                max={MAX_SOURCES}
                step={1}
                value={sourceCountRaw}
                onChange={handleSourceCountChange}
                onBlur={handleSourceCountBlur}
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
                {MIN_SOURCES}–{MAX_SOURCES}
              </p>
            </div>
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