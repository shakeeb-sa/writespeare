/**
 * SearchDistribution — the time-bucket count inputs for the New
 * Topic modal.
 *
 * The New Topic modal uses this section to let the user say how
 * many sources the search step should collect from each of the
 * four time ranges: "Any time", "Past year", "Past month", and
 * "Past week". The four inputs sit above the Advanced Settings
 * section (see `NewTopicModal.tsx`), because the bucket
 * distribution is a first-class pipeline decision — not an
 * advanced override — and the total it produces is what the
 * search step actually runs against.
 *
 * ── The four buckets and the shape they map to ──────────────────
 *
 *   The component renders one input per bucket. Each input's
 *   value is a count. The four counts are stored on the parent
 *   as a `searchBuckets` object with camelCase keys — `anyTime`,
 *   `pastYear`, `pastMonth`, `pastWeek` — matching the shared
 *   `TopicCreatePayload['searchBuckets']` type. The camelCase
 *   shape is the layout representation; the lowercase
 *   `anytime` / `year` / `month` / `week` shape is the marker
 *   protocol's representation and appears only inside the
 *   research store, not here.
 *
 *   The order the inputs are rendered in matches the canonical
 *   order the rest of the pipeline uses — Any time, Past year,
 *   Past month, Past week — which is the order `BUCKET_KEYS`
 *   iterates in `researchStore.ts` and the order
 *   `TIME_RANGE_TO_DF` / `TIME_RANGE_TO_TBS` map over. Keeping
 *   the four in the same order everywhere means a reader who
 *   sees one list can predict the other.
 *
 * ── The live total and its bounds ──────────────────────────────
 *
 *   Below the four inputs the component renders the sum of the
 *   four counts — the total number of sources the topic will
 *   collect — and flags the total when it falls outside the
 *   valid range. The bounds come from the shared constants:
 *   `MIN_SOURCES` (1) and `MAX_SOURCES` (50). A total outside
 *   the range is displayed in red with an explanatory message,
 *   but the component does NOT block the user from reaching that
 *   state — the four inputs are still editable. The reason: the
 *   user may be mid-edit and have an intermediate total of 0
 *   between clearing a field and typing its replacement, and
 *   making the fields uneditable during that window would trap
 *   them in a state they cannot escape. The parent's submit
 *   handler is the layer that refuses an out-of-range total,
 *   and the backend's schema is the authoritative guard behind
 *   that.
 *
 * ── Zero means skip ────────────────────────────────────────────
 *
 *   A bucket with a count of zero is skipped entirely by the
 *   search step (Q8.3). This is the mechanism a user has for
 *   saying "I only want recent sources" — put 0 in Any time,
 *   Past year, and Past month, and put the full count in Past
 *   week. The note under the total explains the behaviour in
 *   one sentence so a user who has never read the plan's
 *   decisions still knows what 0 does.
 *
 * ── The change/blur model ──────────────────────────────────────
 *
 *   Same interaction model as `AdvancedSettings.tsx`'s numeric
 *   fields: the input holds a local buffer string, the change
 *   handler propagates the parsed value to the parent WITHOUT
 *   clamping (so typing "8" as the first keystroke of "80" does
 *   not snap the value), and the blur handler clamps to
 *   `[0, 50]` and re-syncs the parent if the clamped value
 *   differs from the current one. A blank or unparseable buffer
 *   on blur restores the parent's current value.
 *
 *   The four local buffers are held in a single record keyed by
 *   the same four keys the layout uses, so the per-bucket
 *   handlers can be dispatched by key rather than duplicated
 *   four times. The record is kept in sync with the parent's
 *   `value` by a single `useEffect` that fires whenever any of
 *   the four numbers changes; the effect bails out (returns the
 *   same reference) when the buffer already matches the parent's
 *   value, so a user's own keystroke does not produce a
 *   redundant render.
 *
 * ── What this component does NOT do ────────────────────────────
 *
 *   - It does not derive the total into a separate
 *     `sourceCount` field. The topic's materialised
 *     `sourceCount` is what the backend's `topicService`
 *     computes from the four buckets on write, per the C2
 *     decision ("the bucket layout is the single source of
 *     truth for how many sources to collect"). The parent
 *     forwards the four bucket counts; the backend sums them.
 *
 *   - It does not validate against a preset's default. The
 *     default values the component renders initially come from
 *     the parent's `value` prop, which the parent initialises
 *     from the chosen preset or from the user's own defaults.
 *     This component only edits what it is given.
 *
 *   - It does not persist anything. It is a controlled input;
 *     the parent owns the value.
 *
 *   - It does not render a preset picker. The preset selector
 *     (`PresetSelector.tsx`) sits elsewhere in the modal; when
 *     the user picks a preset, the parent updates this
 *     component's `value` prop and the four inputs re-render
 *     with the preset's bucket layout. A subsequent edit here
 *     overrides the preset's counts for this one topic.
 *
 * Dependencies: react + the shared constants module + the
 * shared types module. All three are already present in the
 * codebase.
 */

import {
  useEffect,
  useState,
  type ChangeEvent,
} from 'react';

import {
  MAX_SOURCES,
  MIN_SOURCES,
} from '../../shared/constants/index.js';
import type { TopicCreatePayload } from '../../shared/types/index.js';

// ============================================================
//  Public types
// ============================================================

/**
 * The four-bucket count shape the component edits.
 *
 * Derived from `TopicCreatePayload['searchBuckets']` so the
 * component cannot drift from the wire format the parent will
 * eventually submit. If the shared declaration ever changes — a
 * rename of one bucket, a new bucket added — the compiler
 * reports it here and at every call site that passes a value,
 * rather than letting the component's local shape disagree
 * silently.
 *
 * The `NonNullable<...>` wrapper strips the `| undefined` arm
 * that the optional `searchBuckets?` field carries on the
 * create payload. Inside this component the field is always
 * present — the parent supplies a concrete value — so the
 * undefined case is not relevant to the component's type.
 */
type BucketLayout = NonNullable<TopicCreatePayload['searchBuckets']>;

/**
 * The props accepted by `SearchDistribution`.
 *
 * Fully controlled, matching the pattern the sibling
 * `PresetSelector.tsx` and `AdvancedSettings.tsx` components
 * use: the parent owns the value, this component renders it and
 * reports changes through `onChange`.
 */
export interface SearchDistributionProps {
  /** The current four-bucket layout. */
  value: BucketLayout;

  /**
   * Called with a partial patch whenever the user changes one
   * of the four bucket counts. The patch contains exactly the
   * keys the user touched — one key per invocation in the
   * common case. The parent merges the patch into its own
   * state, so a handler that changed `anyTime` does not disturb
   * `pastWeek`.
   */
  onChange: (patch: Partial<BucketLayout>) => void;

  /**
   * When true, every input is disabled and the total is left
   * visible but not interactive. The parent sets this while a
   * submission is in flight, so a user cannot change the
   * distribution mid-create.
   */
  disabled?: boolean;
}

// ============================================================
//  Internal constants
// ============================================================

/**
 * One bucket's static metadata: its key on the layout object,
 * the human-readable label the input renders, and the
 * one-sentence hint under the input that names what the bucket
 * means.
 *
 * Declared as a `readonly` array of a named interface so the
 * four buckets are iterated in one place — the render loop
 * below — and so a future session that wanted to add a fifth
 * bucket (a "past day" bucket, say) would extend this array
 * and the layout type together, with the compiler enforcing
 * that both changes happened.
 */
interface BucketDescriptor {
  readonly key: keyof BucketLayout;
  readonly label: string;
  readonly hint: string;
}

/**
 * The four buckets in canonical order — Any time, Past year,
 * Past month, Past week.
 *
 * The order matches the sequence the rest of the pipeline uses:
 * `BUCKET_KEYS` in `researchStore.ts`, `TIME_RANGE_TO_TBS` in
 * `google_search.py`, and `TIME_RANGE_TO_DF` in
 * `duckduckgo_search.py` all iterate the four buckets in this
 * same order, so a reader who sees one list recognises the
 * others.
 */
const BUCKETS: readonly BucketDescriptor[] = [
  {
    key: 'anyTime',
    label: 'Any time',
    hint: 'No time restriction.',
  },
  {
    key: 'pastYear',
    label: 'Past year',
    hint: 'Published in the last 12 months.',
  },
  {
    key: 'pastMonth',
    label: 'Past month',
    hint: 'Published in the last 30 days.',
  },
  {
    key: 'pastWeek',
    label: 'Past week',
    hint: 'Published in the last 7 days.',
  },
];

/**
 * The lower bound for a single bucket's count. Zero is legal
 * and meaningful — it tells the search step to skip the bucket
 * entirely (Q8.3) — which is why this bound differs from
 * `MIN_SOURCES` (the lower bound on the total, which is 1).
 */
const MIN_BUCKET = 0;

/**
 * The upper bound for a single bucket's count. Matches the
 * `max: 50` validator on each of the four bucket fields in the
 * Preset and UserSetting schemas, and the `max: 50` on the
 * Topic schema's `SearchBucketsSchema`. A single bucket may
 * legally be as large as the total's own maximum; the total's
 * own bound is enforced separately below.
 */
const MAX_BUCKET = 50;

// ============================================================
//  Helpers
// ============================================================

/**
 * Parse a user-typed string into a bounded integer, or return
 * `null` if the string does not represent one.
 *
 * Same algorithm as the helper of the same name in
 * `AdvancedSettings.tsx`: reject the empty string, parse with
 * `Number.parseInt(_, 10)` (explicit radix so a leading "0x"
 * is not interpreted as hexadecimal on some engines), and
 * clamp to `[min, max]`. The `Number.isFinite` guard rejects
 * `NaN` — `parseInt` can produce `NaN` for a non-numeric
 * string, and `NaN < min` and `NaN > max` are both `false`,
 * so without the guard the clamp would silently pass a `NaN`
 * through.
 *
 * The two call sites below pass `Number.MIN_SAFE_INTEGER` and
 * `Number.MAX_SAFE_INTEGER` on the change path — the intent
 * there is "parse, do not clamp" — and the real
 * `[MIN_BUCKET, MAX_BUCKET]` bounds on the blur path.
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
//  SearchDistribution
// ============================================================

/**
 * The Search Distribution section. See the file header for the
 * component's responsibilities, the change/blur model, and the
 * reasoning behind the live total's visual treatment.
 */
export const SearchDistribution = ({
  value,
  onChange,
  disabled = false,
}: SearchDistributionProps) => {
  // ---- Local buffer state ----
  //
  // One entry per bucket, in the same shape as the layout. The
  // buffers hold the raw text the user is currently typing so
  // that intermediate states (a lone "8" that will become "80",
  // an empty field between clearing and retyping) survive
  // React's controlled-input round trip. See the file header's
  // "change/blur model" section for the full rationale.
  const [raw, setRaw] = useState<Record<keyof BucketLayout, string>>({
    anyTime: String(value.anyTime),
    pastYear: String(value.pastYear),
    pastMonth: String(value.pastMonth),
    pastWeek: String(value.pastWeek),
  });

  // ---- Sync the buffers when the parent's value changes ----
  //
  // The effect fires whenever any of the four numbers on the
  // parent's `value` changes. Three sources can trigger it:
  //
  //   1. The user's own keystroke in one of the four inputs.
  //      The change handler already set the buffer for that
  //      bucket; the effect's write for that bucket is a no-op
  //      because the buffer already matches.
  //
  //   2. A preset selection in the parent. The parent sets all
  //      four numbers at once; the effect writes all four
  //      buffers to match the new layout.
  //
  //   3. A programmatic reset of the parent's form. Same as the
  //      preset case — every bucket updates.
  //
  // The bail-out inside the functional updater returns the
  // previous state object unchanged when every buffer already
  // matches the parent's value, so React can skip the re-render.
  // This is what keeps a keystroke in one bucket from producing
  // a redundant render of the other three.
  useEffect(() => {
    setRaw((prev) => {
      const next: Record<keyof BucketLayout, string> = {
        anyTime: String(value.anyTime),
        pastYear: String(value.pastYear),
        pastMonth: String(value.pastMonth),
        pastWeek: String(value.pastWeek),
      };
      if (
        next.anyTime === prev.anyTime &&
        next.pastYear === prev.pastYear &&
        next.pastMonth === prev.pastMonth &&
        next.pastWeek === prev.pastWeek
      ) {
        return prev;
      }
      return next;
    });
  }, [value.anyTime, value.pastYear, value.pastMonth, value.pastWeek]);

  // ---- Derived total ----
  //
  // The sum of the four bucket counts. Recomputed on every render
  // — it is four additions over numbers, which is cheaper than
  // memoizing it would be. `totalInRange` is the boolean the
  // total's visual treatment keys on.
  const total =
    value.anyTime + value.pastYear + value.pastMonth + value.pastWeek;
  const totalInRange = total >= MIN_SOURCES && total <= MAX_SOURCES;

  // ---- Change handler factory ----
  //
  // Returns a per-bucket change handler. The handler:
  //   1. Writes the raw text into the bucket's buffer slot.
  //   2. Parses without clamping and, if the result is a number,
  //      propagates it to the parent. See `AdvancedSettings.tsx`
  //      for why the intermediate out-of-range value is safe to
  //      propagate.
  //
  // The factory form is used so the render loop below does not
  // need to reference the four setters by name — one dispatch
  // by key covers all four buckets.
  const handleChange =
    (key: keyof BucketLayout) =>
    (event: ChangeEvent<HTMLInputElement>): void => {
      const v = event.target.value;
      setRaw((prev) => {
        if (prev[key] === v) {
          return prev;
        }
        const next: Record<keyof BucketLayout, string> = { ...prev };
        next[key] = v;
        return next;
      });
      const parsed = parseBoundedInt(
        v,
        Number.MIN_SAFE_INTEGER,
        Number.MAX_SAFE_INTEGER
      );
      if (parsed !== null) {
        onChange({ [key]: parsed } as Partial<BucketLayout>);
      }
    };

  // ---- Blur handler factory ----
  //
  // Returns a per-bucket blur handler. The handler:
  //   1. Reads the bucket's current raw buffer.
  //   2. Parses and clamps to `[MIN_BUCKET, MAX_BUCKET]`.
  //   3. On an unparseable buffer, restores the parent's current
  //      value into the buffer.
  //   4. On a valid buffer, writes the clamped value into the
  //      buffer and, if the clamped value differs from the
  //      parent's current one, propagates the clamped value.
  const handleBlur =
    (key: keyof BucketLayout) =>
    (): void => {
      const v = raw[key];
      const parsed = parseBoundedInt(
        v,
        Number.MIN_SAFE_INTEGER,
        Number.MAX_SAFE_INTEGER
      );
      if (parsed === null) {
        setRaw((prev) => {
          const next: Record<keyof BucketLayout, string> = { ...prev };
          next[key] = String(value[key]);
          return next;
        });
        return;
      }
      const clamped = Math.min(Math.max(parsed, MIN_BUCKET), MAX_BUCKET);
      setRaw((prev) => {
        const next: Record<keyof BucketLayout, string> = { ...prev };
        next[key] = String(clamped);
        return next;
      });
      if (clamped !== value[key]) {
        onChange({ [key]: clamped } as Partial<BucketLayout>);
      }
    };

  // ---- Render ----
  return (
    <section>
      {/* ---- Header ---- */}
      {/* A short heading and a one-line description. The heading
          is a `<h3>` sized to match the modal's other section
          headers; the description tells the user what the four
          inputs collectively do, which the individual bucket
          labels do not. */}
      <div className="mb-3">
        <h3
          className={
            'text-sm font-semibold text-text ' +
            'dark:text-neutral-100'
          }
        >
          Search Distribution
        </h3>
        <p
          className={
            'mt-0.5 text-xs text-neutral-500 ' +
            'dark:text-neutral-400'
          }
        >
          Set how many sources to collect from each time range.
        </p>
      </div>

      {/* ---- The four inputs ---- */}
      {/* A two-by-two grid on wider viewports and a single column
          on narrow ones. The modal the component lives in opens
          at `size="lg"` (`max-w-2xl`, 672 px), which fits two
          columns comfortably at the modal's own padding. The
          two-column layout keeps the section compact — the user
          sees all four inputs, the total, and the hint without
          scrolling. */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {BUCKETS.map((bucket) => (
          <div key={bucket.key}>
            <label
              htmlFor={`search-distribution-${bucket.key}`}
              className={
                'mb-1.5 block text-sm font-medium ' +
                'text-text dark:text-neutral-200'
              }
            >
              {bucket.label}
            </label>
            <input
              id={`search-distribution-${bucket.key}`}
              type="number"
              inputMode="numeric"
              min={MIN_BUCKET}
              max={MAX_BUCKET}
              step={1}
              value={raw[bucket.key]}
              onChange={handleChange(bucket.key)}
              onBlur={handleBlur(bucket.key)}
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
              {bucket.hint}
            </p>
          </div>
        ))}
      </div>

      {/* ---- Live total + skip note ---- */}
      {/* The total is the sum of the four counts. Its color keys
          on whether the total falls within the valid range —
          neutral when it does, red when it does not. The bounds
          message below the total names the actual valid range so
          a user who has never seen the plan's constants knows
          what the limit is without reading the source. */}
      <div
        className={
          'mt-4 rounded-lg border border-neutral-200 ' +
          'bg-neutral-50 px-3 py-3 ' +
          'dark:border-neutral-800 dark:bg-neutral-900/40'
        }
      >
        <div className="flex items-baseline justify-between gap-3">
          <span
            className={
              'text-sm font-medium text-text ' +
              'dark:text-neutral-100'
            }
          >
            Total
          </span>
          <span
            className={
              'text-sm font-semibold tabular-nums ' +
              (totalInRange
                ? 'text-text dark:text-neutral-100'
                : 'text-red-600 dark:text-red-400')
            }
          >
            {total}{' '}
            {total === 1 ? 'source' : 'sources'}
          </span>
        </div>

        {/* ---- Bounds message — shown only when out of range ---- */}
        {!totalInRange && (
          <p
            className={
              'mt-1 text-xs text-red-600 dark:text-red-400'
            }
          >
            The total must be between {MIN_SOURCES} and{' '}
            {MAX_SOURCES}.
          </p>
        )}

        {/* ---- Skip note — always shown ---- */}
        {/* Explains what a bucket with count 0 does. This is the
            only place in the modal where Q8.3's skip semantics
            are surfaced to the user; without it, a user who set
            a bucket to 0 would have no way to know whether the
            bucket was being skipped or being searched-and-empty. */}
        <p
          className={
            'mt-2 text-xs text-neutral-500 ' +
            'dark:text-neutral-400'
          }
        >
          Set any bucket to 0 to skip that time range entirely.
        </p>
      </div>
    </section>
  );
};

// ============================================================
//  Default export
// ============================================================

/**
 * The `SearchDistribution` component as the default export.
 * `NewTopicModal.tsx` will import it with the default form
 * (`import SearchDistribution from './SearchDistribution.js'`)
 * when that file is modified in its own step of this PR. Both
 * export forms resolve to the same component.
 */
export default SearchDistribution;