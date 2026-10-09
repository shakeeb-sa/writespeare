/**
 * WriteSpeare — preset selector.
 *
 * The Quick / Balanced / Deep / Custom picker rendered inside the
 * New Topic modal. Four cards in a two-by-two grid, one per
 * preset, each showing its label and a one-line description of
 * what choosing it means for the pipeline.
 *
 * The component is a controlled picker: it renders whatever
 * `PresetName` the `value` prop carries, and it reports the user's
 * choice through `onChange`. It holds no state of its own — the
 * selection is the parent modal's concern, because the modal
 * serializes the whole form (title, keywords, preset, profile,
 * advanced fields) into a single `TopicCreatePayload` on submit.
 *
 * The four presets and their descriptions come from the shared
 * constants module, which is the single source of truth for the
 * `PresetName` union and its presentation metadata. The
 * `PRESET_NAMES` array is iterated to produce the cards — so a
 * future change that adds a fifth preset to that array
 * automatically renders a fifth card here, without any change to
 * this file. The one place this file hard-codes a piece of preset
 * identity is the "Recommended" badge on Balanced — see below.
 *
 * The four cards in detail:
 *
 *   Quick    — 5 sources, 800 words. For a first draft the user
 *              intends to expand by hand.
 *   Balanced — 10 sources, 1200 words. The recommended default,
 *              matching the plan's user-journey description of
 *              the preset.
 *   Deep     — 20 sources, 2000+ words. For pillar content.
 *   Custom   — a sentinel for "the user has configured the
 *              pipeline through the Advanced Settings section
 *              below this picker". Selecting it sets the topic's
 *              preset field to `'custom'`, and the topic's
 *              effective configuration is whatever the advanced
 *              fields currently hold.
 *
 * The "Recommended" badge:
 *
 *   Balanced carries a small green "Recommended" pill in its
 *   top-right corner. The badge is the picker's only piece of
 *   preset-specific decoration, and it exists to make the
 *   default choice obvious to a first-time user who has not yet
 *   internalised which of the four values is the plan's
 *   recommended starting point.
 *
 *   The recommendation is expressed here rather than in the
 *   constants module because it is a UI-layer opinion, not a
 *   property of the preset itself. A future session that wants
 *   to make the recommendation configurable per-user (a
 *   "remember my last pick and badge that one" behaviour) would
 *   change this file, not the constants module.
 *
 * Why radio-group semantics and not a native `<select>`:
 *
 *   A dropdown would compress four options into one row and hide
 *   their descriptions behind a click. The whole point of the
 *   picker — per the plan's user-journey document — is that the
 *   user SEES what each preset does before choosing. Four
 *   always-visible cards with their descriptions in plain sight
 *   is the correct presentation for that goal; a `<select>` is
 *   the correct presentation for a choice whose options the user
 *   already knows by name.
 *
 *   The accessibility model is therefore `role="radiogroup"` on
 *   the wrapper and `role="radio"` on each card, with
 *   `aria-checked` reflecting the current selection. That is the
 *   WAI-ARIA pattern for a group of mutually exclusive choices
 *   presented as custom-styled controls. The alternative — a
 *   native radio input visually hidden under each card's label —
 *   would work but would not match the design system's styling
 *   for the "selected" state, which is a bordered card rather
 *   than a filled dot.
 *
 * Disabled state:
 *
 *   When the `disabled` prop is true (the parent modal sets it
 *   while a submission is in flight), every card is disabled and
 *   the wrapper carries `aria-disabled="true"`. The visual
 *   treatment is the same `opacity-60` the modal's other inputs
 *   use, so the whole form greys out together.
 *
 * What this component does NOT do:
 *
 *   - It does not own the preset value. The selection is the
 *     parent modal's state; this component renders it and
 *     reports changes. See the component header above for the
 *     rationale.
 *
 *   - It does not render the advanced settings. Selecting the
 *     Custom card sets the preset to `'custom'`; the actual
 *     custom configuration (prompt file, word count, source
 *     count) is edited through the `AdvancedSettings` component
 *     that the modal renders below this picker.
 *
 *   - It does not validate against a closed set at runtime. The
 *     `PresetName` union is a compile-time constraint, and the
 *     values this component iterates come from the same array
 *     the union is derived from — so a caller cannot pass a
 *     preset this component does not render, and this component
 *     cannot produce a value outside the union.
 */

import {
  PRESET_DESCRIPTIONS,
  PRESET_LABELS,
  PRESET_NAMES,
} from '../../shared/constants/index.js';
import type { PresetName } from '../../shared/types/index.js';

// ============================================================
//  Public types
// ============================================================

/**
 * The props accepted by `PresetSelector`.
 *
 * The shape is a standard controlled-input contract — `value` and
 * `onChange` — extended with an optional `disabled` flag. The
 * parent modal passes all three; the flag is optional so a
 * consumer that never needs to gate the picker can omit it.
 */
export interface PresetSelectorProps {
  /** The currently-selected preset. */
  value: PresetName;

  /** Called when the user selects a different preset. The
   *  parent is responsible for updating its own `value`. */
  onChange: (preset: PresetName) => void;

  /** When true, every card is disabled and the group is marked
   *  `aria-disabled`. Defaults to `false`. */
  disabled?: boolean;
}

// ============================================================
//  Internal: PresetCard
// ============================================================

interface PresetCardProps {
  preset: PresetName;
  selected: boolean;
  recommended: boolean;
  disabled: boolean;
  onSelect: (preset: PresetName) => void;
}

/**
 * One card in the picker. Not exported — the picker is the only
 * consumer, and all four cards take the same shape.
 *
 * The card is a `<button type="button">` rather than a `<div>` so
 * that keyboard interaction and focus handling are the browser's
 * responsibility, not this file's. The `role="radio"` + `aria-checked`
 * pair layers the radio-group semantics on top of the button's
 * native activation behaviour — Enter and Space activate the
 * button, which is exactly what a radio control should do.
 *
 * The `disabled` attribute on the button is the single source of
 * truth for the disabled state; the visual treatment (`opacity-60`
 * + `cursor-not-allowed`) is applied by Tailwind's `disabled:`
 * variants, and the parent group's `aria-disabled` is derived
 * from the same prop. There is no path where the button is
 * visually enabled but functionally disabled, or vice versa.
 */
const PresetCard = ({
  preset,
  selected,
  recommended,
  disabled,
  onSelect,
}: PresetCardProps) => {
  const handleClick = (): void => {
    if (disabled) {
      return;
    }
    onSelect(preset);
  };

  // Border treatment differs between the selected and unselected
  // states. The selected state uses the brand primary color for
  // both the border and the background tint; the unselected state
  // uses the neutral palette. The hover treatment on the
  // unselected state previews the selection color so the card
  // reads as interactive.
  const stateClass = selected
    ? 'border-primary bg-primary/5 ' +
      'dark:border-primary-light dark:bg-primary-light/5'
    : 'border-neutral-200 bg-background ' +
      'hover:border-neutral-300 hover:bg-neutral-50 ' +
      'dark:border-neutral-800 dark:hover:border-neutral-700 ' +
      'dark:hover:bg-neutral-800/40';

  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={handleClick}
      className={
        'relative flex flex-col items-start gap-1 rounded-xl ' +
        'border p-3 text-left transition-colors ' +
        'focus-visible:outline-none ' +
        'disabled:cursor-not-allowed disabled:opacity-60 ' +
        stateClass
      }
    >
      <div className="flex w-full items-center justify-between gap-2">
        <span
          className={
            'text-sm font-semibold ' +
            (selected
              ? 'text-primary dark:text-primary-light'
              : 'text-text dark:text-neutral-100')
          }
        >
          {PRESET_LABELS[preset]}
        </span>
        {recommended && (
          <span
            className={
              'shrink-0 rounded-full bg-primary-light/40 ' +
              'px-2 py-0.5 text-[10px] font-medium ' +
              'uppercase tracking-wide text-primary-dark ' +
              'dark:bg-primary-light/20 dark:text-primary-light'
            }
          >
            Recommended
          </span>
        )}
      </div>
      <span
        className={
          'text-xs leading-snug text-neutral-500 ' +
          'dark:text-neutral-400'
        }
      >
        {PRESET_DESCRIPTIONS[preset]}
      </span>
    </button>
  );
};

// ============================================================
//  PresetSelector
// ============================================================

/**
 * The preset picker. See the file header for the component's
 * responsibilities, its accessibility model, and the reasoning
 * behind the "Recommended" badge placement.
 */
export const PresetSelector = ({
  value,
  onChange,
  disabled = false,
}: PresetSelectorProps) => {
  return (
    <div>
      <span
        className={
          'mb-1.5 block text-sm font-medium ' +
          'text-text dark:text-neutral-200'
        }
      >
        Preset
      </span>
      <div
        role="radiogroup"
        aria-label="Pipeline preset"
        aria-disabled={disabled}
        className="grid grid-cols-2 gap-2"
      >
        {PRESET_NAMES.map((preset) => (
          <PresetCard
            key={preset}
            preset={preset}
            selected={preset === value}
            recommended={preset === 'balanced'}
            disabled={disabled}
            onSelect={onChange}
          />
        ))}
      </div>
    </div>
  );
};

// ============================================================
//  Default export
// ============================================================

/**
 * The `PresetSelector` component as the default export.
 * `NewTopicModal.tsx` imports it with the default form
 * (`import PresetSelector from './PresetSelector.js'`), so this
 * is the export that keeps the modal's form resolving.
 */
export default PresetSelector;