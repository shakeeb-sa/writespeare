/**
 * WriteSpeare — new topic modal.
 *
 * The create-topic modal, opened from the Topics home page. Its
 * purpose is narrow: collect the values the backend's
 * `POST /api/topics` endpoint needs, submit them, and hand the
 * user off to their newly-created topic.
 *
 * The modal has one text field of identity (the title), one
 * freeform field of metadata (the comma- or newline-separated
 * keywords), two dropdowns that route the pipeline (the preset
 * and the profile), and one collapsible advanced section (the
 * prompt file, word-count target, and source-count target).
 * Everything else the topic needs — the userId, the status, the
 * creation timestamp — is derived by the backend.
 *
 * Submit flow:
 *
 *   1. Trim the title. If it is empty, the submit button is
 *      disabled and no submit is possible — the check inside
 *      `handleSubmit` is a belt-and-braces guard against a
 *      programmatic call.
 *
 *   2. Parse the keyword textarea into a `string[]`. The split
 *      accepts both commas and newlines so a user can paste a
 *      comma-separated list from anywhere, or type one keyword
 *      per line, and get the same result. Empty segments are
 *      filtered out.
 *
 *   3. Build a `TopicCreatePayload` from the form values. The
 *      `keywords` field is OMITTED entirely when the user left
 *      the textarea empty — passing an empty array would tell
 *      the backend "this topic has no keywords", which is
 *      indistinguishable from "the user has not decided yet"
 *      once it lands in the collection. Omitting the field lets
 *      the backend apply its own default.
 *
 *   4. Call `createTopic` from the topics store. On success the
 *      store prepends the new topic to its list AND sets it as
 *      `activeTopic`; the return value is the created `Topic`.
 *
 *   5. On success: fire a confirmation toast, close the modal,
 *      and navigate to `/dashboard/topics/:id`. The navigation is
 *      what makes "Start Research" feel like the start of
 *      something — the user lands on the new topic's detail page
 *      with the Sources tab already selected (because the topic's
 *      status is `draft`, which `TopicDetail`'s `getDefaultTab`
 *      maps to `'sources'`). The user then clicks the search
 *      control on that page to actually begin the pipeline.
 *
 *   6. On failure: fire an error toast and LEAVE THE MODAL OPEN.
 *      The user's inputs are preserved, so they can correct
 *      whatever the backend rejected and retry without
 *      retyping.
 *
 * Why the modal does NOT itself start the search:
 *
 *   The journey document's Stage 1 mockup labels the submit
 *   button "Start Research →", and Stage 2 (Source Discovery)
 *   describes a search running immediately after topic
 *   creation. But the search is a research-feature concern — the
 *   IPC channels, the Python child process, the Chrome launcher,
 *   and the marker bridge are all declared in Session 10, not
 *   Session 7. Wiring the search into this modal now would
 *   require forward-referencing the entire research feature from
 *   the topics feature, inverting the dependency direction the
 *   plan establishes (topics is a leaf; research depends on it,
 *   not vice versa).
 *
 *   The modal therefore does what it CAN do at this point in the
 *   runbook: create the topic and navigate the user to it. When
 *   Session 10 lands, the search flow becomes reachable from the
 *   topic's detail page — the same place the user was already
 *   headed. If a future session decides the search should
 *   auto-start on creation, that change is a one-line addition
 *   to the success branch of `handleSubmit` here, and it will be
 *   made in that session with the research feature already in
 *   place to call.
 *
 * Form reset:
 *
 *   The modal's form state is reset every time the `open` prop
 *   transitions from `false` to `true`. Without this, a user who
 *   fills out half the form, cancels, and reopens the modal
 *   would find their stale inputs still present — which is
 *   misleading, because the modal LOOKS like a fresh start. The
 *   reset is the difference between "this is a new topic" and
 *   "this is a resumed abandoned draft", and the modal is
 *   always the former.
 *
 *   The reset is implemented as a `useEffect` keyed on `open`
 *   rather than as a ref-tracked previous value because the
 *   transition is exactly what `useEffect`'s dependency array
 *   is for. Under React 19's StrictMode double-invoke in
 *   development, the effect runs twice on mount — but the body
 *   is idempotent (setting the same initial values twice is a
 *   no-op for the second pass) so the double-invoke is
 *   harmless.
 *
 * Title input focus:
 *
 *   The title input is focused programmatically once the modal
 *   is open, so the user can start typing without clicking. The
 *   focus is deferred by one event-loop tick because the modal
 *   shell's own focus-management effect (see `Modal.tsx`)
 *   unconditionally focuses the modal's container element on
 *   mount — and that effect runs after the modal's synchronous
 *   effects, so a synchronous `focus()` call here would be
 *   immediately overwritten. A zero-delay `setTimeout` defers
 *   the call past the shell's effect, and the container's
 *   focus is transferred to the input. The `autoFocus` HTML
 *   attribute would NOT work for this reason — it fires during
 *   the commit phase, before the shell's effect, and the shell
 *   would steal the focus back.
 *
 * Forward references — PresetSelector and AdvancedSettings:
 *
 *   The modal delegates two of its regions to child components
 *   that are created in the next two steps of this same session:
 *
 *     PresetSelector    — step 60 — the Quick/Balanced/Deep/
 *                         Custom picker. Takes a `value: PresetName`
 *                         and an `onChange: (name) => void`, so
 *                         the modal's preset state is what the
 *                         picker displays and what it updates.
 *
 *     AdvancedSettings  — step 61 — the collapsible advanced
 *                         section. Takes a `values` object with
 *                         the three advanced fields, an
 *                         `onChange` that accepts a partial patch
 *                         of those fields, and a `disabled` flag.
 *
 *   Because this file is created BEFORE those two, it owns their
 *   prop interfaces by construction. When the two components are
 *   created in the next steps, they must accept exactly the
 *   props this file passes — if they don't, the compiler reports
 *   a TS2322 mismatch on the JSX call sites here, which is the
 *   correct signal that the interface has drifted.
 *
 *   Until the two files exist on disk, the imports at the top of
 *   this file produce two `TS2307` errors. That is EXPECTED and
 *   is documented in the TypeScript Integrity Check below.
 *
 * What this modal does NOT do:
 *
 *   - It does not run the search, the extraction, the writer, or
 *     the validation. See the discussion above for why the modal
 *     stops at "create and navigate".
 *
 *   - It does not edit an existing topic. The topic's mutable
 *     fields are changed through the backend's PATCH endpoint,
 *     which the desktop does not currently expose in a UI. If
 *     edit-in-place is ever added, it belongs in a separate
 *     modal or an inline edit on the detail page — this modal is
 *     specifically the "create from scratch" flow.
 *
 *   - It does not validate the title length on the client beyond
 *     HTML's `maxLength`, which mirrors the backend schema's
 *     300-character bound. A title that passes the client and
 *     fails the server's schema (which is the same rule) would
 *     produce a validation-error toast; there is no client-side
 *     duplicate of the schema's rules because the schema is the
 *     single source of truth.
 *
 *   - It does not offer a "Save as preset" affordance. The plan's
 *     user journey describes that flow in Stage 9 (the advanced
 *     user's path), but it belongs to the settings feature, not
 *     here.
 */

import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2, Sparkles } from 'lucide-react';

import Modal from '../../shared/components/Modal.js';
import PresetSelector from './PresetSelector.js';
import AdvancedSettings from './AdvancedSettings.js';
import { useTopics } from '../hooks/useTopics.js';
import { useToast } from '../../shared/hooks/useToast.js';
import {
  MAX_SOURCES_DEFAULT,
  MAX_WORDS_DEFAULT,
  PROFILE_LABELS,
  PROFILE_NAMES,
} from '../../shared/constants/index.js';
import type {
  PresetName,
  ProfileName,
  TopicCreatePayload,
} from '../../shared/types/index.js';

// ============================================================
//  Public types
// ============================================================

/**
 * The props accepted by `NewTopicModal`.
 *
 * The modal is a controlled child of the Topics page — the
 * page owns the boolean that determines whether the modal is
 * open, and the modal reports back through `onClose` when the
 * user dismisses it or completes the create flow. This mirrors
 * the pattern used by `Sidebar` in `Layout` (parent owns the
 * state, child is presentational).
 */
export interface NewTopicModalProps {
  /** Whether the modal is currently visible. */
  open: boolean;

  /** Called when the modal should close — by the user dismissing
   *  it (Cancel, X, Escape, overlay click) or by a successful
   *  create. The parent is responsible for flipping its own
   *  `open` state in response. */
  onClose: () => void;
}

// ============================================================
//  Form state shape
// ============================================================

/**
 * The modal's complete form state. A single object rather than
 * six separate `useState` calls so that a "reset the form"
 * operation is one assignment, and so that the field-change
 * handlers can each be a one-line update via the functional
 * `setValues((prev) => ({ ...prev, <field> }))` form.
 *
 * The `keywordsInput` field is the raw textarea string — it is
 * NOT parsed into a `string[]` until submit time. Storing the
 * parsed form would force the textarea's controlled value to be
 * a re-joined string on every keystroke, which would fight the
 * user over whitespace and partial commas. See `parseKeywords`
 * for where the conversion happens.
 */
interface FormValues {
  title: string;
  keywordsInput: string;
  preset: PresetName;
  profile: ProfileName;
  promptFile: string;
  wordCount: number;
  sourceCount: number;
}

/**
 * The form's initial values. Extracted as a constant so the
 * reset-on-open effect and the initial `useState` share one
 * source of truth for "what an empty form looks like".
 *
 * The three defaults that come from the constants module
 * (`preset: 'balanced'`, `wordCount: MAX_WORDS_DEFAULT`,
 * `sourceCount: MAX_SOURCES_DEFAULT`) are exactly the values the
 * plan's user journey names as the recommended starting point
 * (Stage 0, Step 1: "Balanced — 10 sources, 1200 words, the
 * recommended default").
 */
const INITIAL_FORM_VALUES: FormValues = {
  title: '',
  keywordsInput: '',
  preset: 'balanced',
  profile: 'blog-post',
  promptFile: 'default.md',
  wordCount: MAX_WORDS_DEFAULT,
  sourceCount: MAX_SOURCES_DEFAULT,
};

// ============================================================
//  Helpers
// ============================================================

/**
 * Split the keywords textarea's raw string into an array of
 * trimmed, non-empty keyword strings.
 *
 * The splitter accepts both commas and newlines so a user can
 * paste a comma-separated list from anywhere — a competitor's
 * meta tags, a spreadsheet column, a previous topic's config —
 * or type one keyword per line, and get the same result. The
 * `\r` is included in the character class to handle a Windows
 * CRLF newline, which the browser preserves in a textarea's
 * value.
 *
 * The trim + filter is what makes "banana, apple,,orange," parse
 * to `['banana', 'apple', 'orange']` rather than to a list with
 * an empty-string element.
 */
const parseKeywords = (input: string): string[] =>
  input
    .split(/[,\r\n]/)
    .map((keyword) => keyword.trim())
    .filter((keyword) => keyword.length > 0);

/**
 * Narrow an arbitrary string — the value read from a native
 * `<select>` element — to the `ProfileName` union.
 *
 * The runtime check is against `PROFILE_NAMES` from the
 * constants module, which is the same array the `<select>`
 * itself renders its `<option>` elements from. Because the two
 * share one source of truth, a value that came from the select
 * can never fail this guard — but the guard is still written
 * rather than a type assertion, because the value's type at the
 * `ChangeEvent<HTMLSelectElement>` boundary is `string`, and
 * the codebase's convention is to narrow with a predicate rather
 * than to assert with `as`.
 */
const isProfileName = (value: string): value is ProfileName =>
  (PROFILE_NAMES as readonly string[]).includes(value);

// ============================================================
//  NewTopicModal
// ============================================================

/**
 * The create-topic modal. See the file header for the modal's
 * responsibilities, its submit flow, its reset-on-open
 * behaviour, and the reasoning behind the title-focus deferral.
 */
export const NewTopicModal = ({ open, onClose }: NewTopicModalProps) => {
  const navigate = useNavigate();
  const toast = useToast();
  const { createTopic } = useTopics();

  // ---- Form state ----
  const [values, setValues] = useState<FormValues>(INITIAL_FORM_VALUES);

  // ---- Submission state ----
  // `true` between the click on the submit button and the
  // resolution of the `createTopic` promise. Drives the
  // disabled state on all inputs and buttons, the spinner on the
  // submit button, and the disabled close paths on the modal
  // shell. See the file header for why the close paths are
  // disabled during submit — a user who dismissed the modal
  // mid-create would have the create still resolve server-side,
  // and the resulting navigation would fire from a component
  // that was already animating away.
  const [submitting, setSubmitting] = useState(false);

  // ---- Title input ref ----
  // Used by the reset-on-open effect to focus the input after
  // the modal shell's own focus-management effect has run. See
  // the file header for why a plain `autoFocus` attribute does
  // not work here.
  const titleInputRef = useRef<HTMLInputElement>(null);

  // ---- Reset on open + focus title ----
  //
  // Runs whenever the `open` prop changes. When it flips to
  // `true`, the form is reset to its initial values and the title
  // input is focused. When it flips to `false`, the effect body
  // does nothing and the cleanup (if the timer was scheduled)
  // cancels it. See the file header for the reset rationale and
  // for why the focus is deferred by a `setTimeout`.
  useEffect(() => {
    if (!open) {
      return;
    }

    setValues(INITIAL_FORM_VALUES);
    setSubmitting(false);

    const focusTimer = window.setTimeout(() => {
      titleInputRef.current?.focus();
    }, 0);

    return () => {
      window.clearTimeout(focusTimer);
    };
  }, [open]);

  // ---- Change handlers ----
  // Each handler updates one field of the form state via the
  // functional-update form. The functional form is used so the
  // handler does not have to list `values` as a dependency and
  // does not read a potentially-stale `values` object.

  const handleTitleChange = (
    event: ChangeEvent<HTMLInputElement>
  ): void => {
    const title = event.target.value;
    setValues((prev) => ({ ...prev, title }));
  };

  const handleKeywordsChange = (
    event: ChangeEvent<HTMLTextAreaElement>
  ): void => {
    const keywordsInput = event.target.value;
    setValues((prev) => ({ ...prev, keywordsInput }));
  };

  const handlePresetChange = (preset: PresetName): void => {
    setValues((prev) => ({ ...prev, preset }));
  };

  const handleProfileChange = (
    event: ChangeEvent<HTMLSelectElement>
  ): void => {
    const value = event.target.value;
    if (!isProfileName(value)) {
      // Unreachable in practice — the `<option>` elements are
      // generated from the same `PROFILE_NAMES` array the guard
      // checks against. The early return keeps the type of
      // `value` narrowed to `ProfileName` without an `as` cast,
      // and the `return` here is defensive rather than expected.
      return;
    }
    setValues((prev) => ({ ...prev, profile: value }));
  };

  const handleAdvancedChange = (patch: {
    promptFile?: string;
    wordCount?: number;
    sourceCount?: number;
  }): void => {
    setValues((prev) => ({ ...prev, ...patch }));
  };

  // ---- Submit handler ----

  const handleSubmit = async (): Promise<void> => {
    const trimmedTitle = values.title.trim();

    // Guard against a double-submit — a user pressing Enter
    // twice, or a programmatic call racing a click. The
    // submit button's `disabled` attribute handles the visual
    // case; the guard handles the programmatic one.
    if (trimmedTitle.length === 0 || submitting) {
      return;
    }

    setSubmitting(true);

    // Build the payload conditionally. `keywords` is omitted
    // entirely when the textarea is empty — see the file header
    // for why passing an empty array is different from omitting
    // the field entirely.
    const payload: TopicCreatePayload = {
      title: trimmedTitle,
      preset: values.preset,
      profile: values.profile,
      promptFile: values.promptFile,
      wordCount: values.wordCount,
      sourceCount: values.sourceCount,
    };

    const keywords = parseKeywords(values.keywordsInput);
    if (keywords.length > 0) {
      payload.keywords = keywords;
    }

    const created = await createTopic(payload);

    setSubmitting(false);

    if (created) {
      toast.success(`Created "${created.title}"`);
      onClose();
      navigate(`/dashboard/topics/${created._id}`);
    } else {
      toast.error('Failed to create topic. Please try again.');
    }
  };

  const handleSubmitForm = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void handleSubmit();
  };

  // ---- Derived flags ----
  const titleIsEmpty = values.title.trim().length === 0;

  // ---- Render ----
  return (
    <Modal
      open={open}
      onClose={onClose}
      variant="info"
      size="lg"
      title="New Topic"
      closeOnOverlay={!submitting}
      closeOnEscape={!submitting}
      showCloseButton={!submitting}
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className={
              'rounded-lg border border-neutral-300 bg-background ' +
              'px-4 py-2 text-sm font-medium text-text ' +
              'transition-colors hover:bg-neutral-100 ' +
              'disabled:cursor-not-allowed disabled:opacity-60 ' +
              'dark:border-neutral-700 dark:hover:bg-neutral-800 ' +
              'focus-visible:outline-none'
            }
          >
            Cancel
          </button>

          {/*
            * The submit button lives in the modal's footer (a
            * sibling of the form's own DOM subtree), so it
            * carries a `form="new-topic-form"` attribute to
            * direct its submission at the form inside the
            * modal body. `type="submit"` + `form="..."` is the
            * standard HTML pattern for a submit button outside
            * its form's subtree.
            */}
          <button
            type="submit"
            form="new-topic-form"
            disabled={submitting || titleIsEmpty}
            className={
              'flex items-center gap-2 rounded-lg bg-primary ' +
              'px-4 py-2 text-sm font-medium text-white ' +
              'transition-colors hover:bg-primary-dark ' +
              'disabled:cursor-not-allowed disabled:opacity-60 ' +
              'focus-visible:outline-none'
            }
          >
            {submitting ? (
              <>
                <Loader2
                  size={16}
                  className="animate-spin"
                  aria-hidden="true"
                />
                <span>Creating…</span>
              </>
            ) : (
              <>
                <Sparkles size={16} aria-hidden="true" />
                <span>Start Research</span>
              </>
            )}
          </button>
        </>
      }
    >
      <form
        id="new-topic-form"
        onSubmit={handleSubmitForm}
        noValidate
        className="space-y-5"
      >
        {/* ---- Title ---- */}
        <div>
          <label
            htmlFor="new-topic-title"
            className={
              'mb-1.5 block text-sm font-medium ' +
              'text-text dark:text-neutral-200'
            }
          >
            Title <span className="text-red-500">*</span>
          </label>
          <input
            id="new-topic-title"
            ref={titleInputRef}
            type="text"
            required
            maxLength={300}
            value={values.title}
            onChange={handleTitleChange}
            disabled={submitting}
            placeholder="e.g. Small Space Gardening for Renters"
            className={
              'w-full rounded-lg border border-neutral-300 ' +
              'bg-background px-3 py-2 text-sm text-text ' +
              'placeholder-neutral-400 focus:border-primary ' +
              'disabled:cursor-not-allowed disabled:opacity-60 ' +
              'dark:border-neutral-700 dark:bg-neutral-950 ' +
              'dark:text-neutral-100 dark:placeholder-neutral-500'
            }
          />
        </div>

        {/* ---- Keywords ---- */}
        <div>
          <label
            htmlFor="new-topic-keywords"
            className={
              'mb-1.5 block text-sm font-medium ' +
              'text-text dark:text-neutral-200'
            }
          >
            Keywords{' '}
            <span className="font-normal text-neutral-400">
              (optional)
            </span>
          </label>
          <textarea
            id="new-topic-keywords"
            rows={2}
            value={values.keywordsInput}
            onChange={handleKeywordsChange}
            disabled={submitting}
            placeholder={
              'small space gardening, container gardening, ' +
              'vertical planters'
            }
            className={
              'w-full resize-none rounded-lg border ' +
              'border-neutral-300 bg-background px-3 py-2 ' +
              'text-sm text-text placeholder-neutral-400 ' +
              'focus:border-primary ' +
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
            Separate keywords with commas or newlines.
          </p>
        </div>

        {/* ---- Preset picker (forward reference) ---- */}
        <PresetSelector
          value={values.preset}
          onChange={handlePresetChange}
          disabled={submitting}
        />

        {/* ---- Profile ---- */}
        <div>
          <label
            htmlFor="new-topic-profile"
            className={
              'mb-1.5 block text-sm font-medium ' +
              'text-text dark:text-neutral-200'
            }
          >
            Profile
          </label>
          <select
            id="new-topic-profile"
            value={values.profile}
            onChange={handleProfileChange}
            disabled={submitting}
            className={
              'w-full rounded-lg border border-neutral-300 ' +
              'bg-background px-3 py-2 text-sm text-text ' +
              'focus:border-primary ' +
              'disabled:cursor-not-allowed disabled:opacity-60 ' +
              'dark:border-neutral-700 dark:bg-neutral-950 ' +
              'dark:text-neutral-100'
            }
          >
            {PROFILE_NAMES.map((name) => (
              <option key={name} value={name}>
                {PROFILE_LABELS[name]}
              </option>
            ))}
          </select>
        </div>

        {/* ---- Advanced settings (forward reference) ---- */}
        <AdvancedSettings
          values={{
            promptFile: values.promptFile,
            wordCount: values.wordCount,
            sourceCount: values.sourceCount,
          }}
          onChange={handleAdvancedChange}
          disabled={submitting}
        />
      </form>
    </Modal>
  );
};

// ============================================================
//  Default export
// ============================================================

/**
 * The `NewTopicModal` component as the default export. `Topics.tsx`
 * imports it with the default form
 * (`import NewTopicModal from '../components/NewTopicModal.js'`),
 * so this is the export that keeps the modal resolving.
 */
export default NewTopicModal;