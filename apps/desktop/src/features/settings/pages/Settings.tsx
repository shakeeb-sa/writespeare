/**
 * Settings — the full settings page for the WriteSpeare desktop app.
 *
 * Rendered at `/dashboard/settings` inside the authenticated shell
 * (see `renderer/App.tsx`). The page is a tabbed interface over the
 * six configuration areas the plan declares:
 *
 *   General     — theme, auto-save behaviour, notification behaviour,
 *                 and the "check for updates" action.
 *   Presets     — the user's default preset and default profile, the
 *                 two choices the pipeline uses when a new topic is
 *                 created without an explicit override.
 *   Prompts     — the user's default prompt template filename, and an
 *                 explainer of where the templates live and how a
 *                 custom one is added.
 *   Validation  — an informational panel naming the active preset and
 *                 its validation behaviour. Thresholds are preset-
 *                 driven in the current product, not per-user fields.
 *   DeepSeek    — an informational panel about the DeepSeek session,
 *                 its persistent Chrome profile, and how to reconnect
 *                 if the session expires.
 *   Admin       — visible only to administrators. A link to the admin
 *                 panel at `/dashboard/admin`.
 *
 * ── The draft/committed model ───────────────────────────────────
 *
 *   The page does NOT auto-save on every field change. A user who
 *   wants to try three different presets before deciding does not
 *   want each attempt persisted to the backend. The page therefore
 *   holds a "draft" copy of the settings in local component state,
 *   edits modify the draft, and the Save button commits the draft
 *   to the backend via `useSettings().saveSettings(...)`. A Discard
 *   button reverts the draft to the last-committed value.
 *
 *   The Save and Discard buttons are rendered in a sticky footer
 *   that appears only when the draft differs from the committed
 *   settings. This is the standard "unsaved changes" pattern for a
 *   form-based page: the user sees an explicit affordance to
 *   commit, and the page silently shows no such affordance once
 *   everything is saved. There is no "are you sure you want to
 *   leave?" guard on tab switch — the tabs are all part of the
 *   same form, and switching tabs does not lose the draft.
 *
 * ── Why the tabs use the same draft object ──────────────────────
 *
 *   All six tabs share one `draft: UserSettingsMap` object held in
 *   the page's state. A field edited on one tab is visible on
 *   another tab only if that tab renders it — in practice the tabs
 *   partition the six fields cleanly and no field appears on more
 *   than one tab. The shared draft is what makes the save button
 *   coherent: the user can edit the preset on the Presets tab, then
 *   switch to General, toggle the theme, and save both changes in
 *   one operation.
 *
 * ── The informational tabs ──────────────────────────────────────
 *
 *   Three tabs — Validation, DeepSeek, and (for non-admins) Admin —
 *   do not edit any field of `UserSettingsMap`, because the state
 *   they describe does not live there:
 *
 *     * Validation thresholds are properties of the ACTIVE PRESET,
 *       not per-user fields. A user who wants a different threshold
 *       picks a different preset on the Presets tab. The panel
 *       names the current preset and its description so the user
 *       can see what behaviour their choice produces.
 *
 *     * The DeepSeek session is a browser-session fact stored in
 *       the persistent Chrome profile the app owns — not a value
 *       in the settings document. The panel explains the model and
 *       where a re-login is triggered from.
 *
 *     * The Admin tab is a navigational affordance, not a settings
 *       surface. It contains a single button that routes to the
 *       admin panel at `/dashboard/admin`.
 *
 *   These are not placeholder panels. They render real information
 *   about the current effective configuration, drawn from state the
 *   page already has access to. A future session that promotes any
 *   of the described thresholds to a per-user field on
 *   `UserSettingsMap` would extend the corresponding tab with the
 *   form controls for the new fields — the panel structure is
 *   already in place.
 *
 * ── The theme application ───────────────────────────────────────
 *
 *   When the user changes the `theme` field on the General tab, the
 *   page applies the `dark` class to `<html>` immediately, without
 *   waiting for the save. This is the standard "theme preview"
 *   behaviour — the user sees the effect of their choice before
 *   committing to it. If they then click Discard, the theme reverts
 *   to the last-committed value.
 *
 *   The class application lives in a `useEffect` in this file rather
 *   than in a top-level provider. The plan's file tree does not
 *   declare a theme provider, and this page is the only place the
 *   theme is ever changed. A future session that wanted the theme
 *   applied on every render — including before this page has been
 *   visited — would add a one-line effect to `renderer/App.tsx` and
 *   remove the effect here. Until then, this page's effect is what
 *   keeps the visual feedback immediate and correct once the user
 *   has reached the settings page.
 *
 * ── What this page does NOT do ──────────────────────────────────
 *
 *   - It does not implement preset CRUD (create / edit / delete a
 *     user preset). The plan's user journey describes custom presets
 *     as a Stage 9 advanced-user feature, and the plan's file tree
 *     does not declare a preset-management UI. The Presets tab
 *     therefore exposes only the two default-selection fields —
 *     `defaultPreset` and `defaultProfile` — which are the two
 *     fields the settings document actually carries. A future
 *     session that adds preset CRUD would extend this tab; the
 *     layout is already structured to accommodate it.
 *
 *   - It does not wire the "connect DeepSeek" flow. That flow is a
 *     Stage 0 setup step owned by the first-run onboarding sequence,
 *     not by the settings page. The DeepSeek tab documents the
 *     connection model and points the user at the Chrome window the
 *     app owns for a re-login; the actual re-login is triggered by
 *     the writer stage's login-wall detection when it fires.
 *
 *   - It does not implement a "reset all settings to defaults"
 *     action. The plan does not declare one, and the backend has no
 *     endpoint for it. A user who wants to reset a specific field
 *     sets it back to its default value by hand; a user who wants a
 *     factory reset deletes the encrypted store from the app's
 *     userData directory. Neither operation is a settings-page
 *     concern today.
 *
 *   - It does not poll the update endpoint. The check runs once,
 *     when the user clicks the button. Re-checking on every page
 *     load would add a backend round trip to a screen the user
 *     visits to change unrelated settings.
 *
 * Dependencies: react + react-router-dom + lucide-react + the four
 * sibling files listed in the imports below. All declared in
 * package.json or in the codebase.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertCircle,
  Bell,
  CheckCircle2,
  Cpu,
  Download,
  FileText,
  Loader2,
  Moon,
  RotateCcw,
  Save,
  ServerCog,
  Settings as SettingsIcon,
  ShieldCheck,
  Sparkles,
  Sun,
  type LucideIcon,
} from 'lucide-react';

import { useSettings } from '../hooks/useSettings.js';
import { useAuth } from '../../auth/hooks/useAuth.js';
import { useToast } from '../../shared/hooks/useToast.js';
import {
  PRESET_DESCRIPTIONS,
  PRESET_LABELS,
  PRESET_NAMES,
  PROFILE_LABELS,
  PROFILE_NAMES,
} from '../../shared/constants/index.js';
import type {
  AppVersion,
  PresetName,
  ProfileName,
  UserSettingsMap,
} from '../../shared/types/index.js';

// ============================================================
//  Public types
// ============================================================

/**
 * The props accepted by `Settings`. Currently empty — the page
 * takes no props and derives everything from the settings store,
 * the auth store, and the router context.
 *
 * The interface is declared anyway so that a future addition (for
 * example, an `initialTab` prop for a deep link that wants to open
 * a specific tab) has a named, exported home.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface SettingsProps {
  // Reserved for future additions. See interface docstring.
}

// ============================================================
//  Tab definitions
// ============================================================

/**
 * The six tab identifiers. A string-literal union rather than an
 * enum — the values are used as React keys and as the discriminant
 * for the tab-content switch below, and a plain string is the
 * natural representation for both.
 */
type TabId =
  | 'general'
  | 'presets'
  | 'prompts'
  | 'validation'
  | 'deepseek'
  | 'admin';

/**
 * The shape of one tab's static metadata. The `icon` field is
 * typed as `LucideIcon` so that swapping an icon is a change to
 * this one table, not a change to the render code.
 *
 * The `adminOnly` flag controls visibility: the Admin tab is
 * hidden from a non-admin user's tab bar entirely, not merely
 * disabled. A user who is not an administrator has no reason to
 * see the tab; hiding it keeps the tab bar focused on the
 * settings a regular user can act on.
 */
interface TabDefinition {
  readonly id: TabId;
  readonly label: string;
  readonly icon: LucideIcon;
  readonly adminOnly: boolean;
}

/**
 * The tab table, in display order. The order matches the plan's
 * user-journey description of the Settings page — General first,
 * then the three pipeline-adjacent tabs, then the connection tab,
 * then the admin tab at the end. The Admin tab is last because it
 * is a navigational escape hatch rather than a settings surface;
 * placing it at the end keeps the settings-editing tabs grouped.
 */
const TABS: readonly TabDefinition[] = [
  { id: 'general', label: 'General', icon: SettingsIcon, adminOnly: false },
  { id: 'presets', label: 'Presets', icon: Sparkles, adminOnly: false },
  { id: 'prompts', label: 'Prompts', icon: FileText, adminOnly: false },
  {
    id: 'validation',
    label: 'Validation',
    icon: ShieldCheck,
    adminOnly: false,
  },
  { id: 'deepseek', label: 'DeepSeek', icon: Cpu, adminOnly: false },
  { id: 'admin', label: 'Admin', icon: ServerCog, adminOnly: true },
];

// ============================================================
//  Small internal components
// ============================================================

/**
 * A section header shown above a group of related fields. The
 * heading uses the app's standard "text-base font-semibold"
 * typography and sits inside the tab content flow.
 */
const SectionHeader = ({
  title,
  description,
}: {
  title: string;
  description?: string;
}) => (
  <div className="mb-4">
    <h2 className="text-base font-semibold text-text dark:text-neutral-100">
      {title}
    </h2>
    {description !== undefined && (
      <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
        {description}
      </p>
    )}
  </div>
);

/**
 * A single labeled form row. Renders the label and an optional
 * hint on the left, and the caller's control on the right. Used
 * by every field on the General, Presets, and Prompts tabs so the
 * spacing and alignment are consistent across tabs without each
 * tab re-declaring the same layout.
 */
const FieldRow = ({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) => (
  <div className="flex items-start justify-between gap-6 py-3">
    <div className="min-w-0 flex-1">
      <p className="text-sm font-medium text-text dark:text-neutral-100">
        {label}
      </p>
      {hint !== undefined && (
        <p className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">
          {hint}
        </p>
      )}
    </div>
    <div className="shrink-0">{children}</div>
  </div>
);

/**
 * A toggle switch for boolean settings. The control is a native
 * `<input type="checkbox">` styled with Tailwind's `peer` +
 * pseudo-class pattern — this keeps the keyboard interaction
 * (Space to toggle) and accessibility semantics (announced as
 * "checked" or "unchecked") for free, while the visual treatment
 * is a custom slider styled on top of the hidden input.
 */
const ToggleSwitch = ({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled: boolean;
}) => (
  <label className="relative inline-flex cursor-pointer items-center">
    <input
      type="checkbox"
      checked={checked}
      onChange={(e) => onChange(e.target.checked)}
      disabled={disabled}
      className="peer sr-only"
    />
    <span
      className={
        'h-5 w-9 rounded-full bg-neutral-300 transition-colors ' +
        'peer-checked:bg-primary peer-disabled:cursor-not-allowed ' +
        'peer-disabled:opacity-60 ' +
        'peer-focus-visible:outline peer-focus-visible:outline-2 ' +
        'peer-focus-visible:outline-offset-2 ' +
        'peer-focus-visible:outline-primary ' +
        'dark:bg-neutral-700'
      }
      aria-hidden="true"
    />
    <span
      className={
        'absolute left-0.5 top-0.5 h-4 w-4 rounded-full ' +
        'bg-white shadow transition-transform ' +
        'peer-checked:translate-x-4 ' +
        'peer-disabled:opacity-60'
      }
      aria-hidden="true"
    />
  </label>
);

// ============================================================
//  Tab content renderers
// ============================================================
//
// Each of the six tabs is rendered by a dedicated function below.
// The functions are module-level rather than components because
// they are called from exactly one place each (the main
// component's `renderTab` switch), they take no JSX-transform
// benefits from being components, and keeping them as plain
// functions makes the switch below read as a flat dispatch.

// ---- General ----

interface GeneralTabProps {
  draft: UserSettingsMap;
  updateDraft: <K extends keyof UserSettingsMap>(
    key: K,
    value: UserSettingsMap[K]
  ) => void;
  disabled: boolean;
  checking: boolean;
  updateResult: AppVersion | null;
  updateChecked: boolean;
  onCheckUpdates: () => void;
}

const renderGeneralTab = (props: GeneralTabProps): ReactNode => {
  const {
    draft,
    updateDraft,
    disabled,
    checking,
    updateResult,
    updateChecked,
    onCheckUpdates,
  } = props;

  return (
    <div className="space-y-8">
      {/* ---- Appearance ---- */}
      <section>
        <SectionHeader
          title="Appearance"
          description="How the app looks on this device."
        />
        <div className="divide-y divide-neutral-100 dark:divide-neutral-800/60">
          <FieldRow
            label="Theme"
            hint="Applies immediately. Saved when you click Save."
          >
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => updateDraft('theme', 'light')}
                disabled={disabled}
                className={
                  'inline-flex items-center gap-1.5 rounded-lg ' +
                  'border px-3 py-1.5 text-xs font-medium ' +
                  'transition-colors ' +
                  'disabled:cursor-not-allowed disabled:opacity-60 ' +
                  'focus-visible:outline-none ' +
                  (draft.theme === 'light'
                    ? 'border-primary bg-primary/10 text-primary ' +
                      'dark:bg-primary-light/10 ' +
                      'dark:text-primary-light'
                    : 'border-neutral-300 bg-background text-text ' +
                      'hover:bg-neutral-100 ' +
                      'dark:border-neutral-700 ' +
                      'dark:hover:bg-neutral-800 ' +
                      'dark:text-neutral-100')
                }
              >
                <Sun size={14} aria-hidden="true" />
                <span>Light</span>
              </button>
              <button
                type="button"
                onClick={() => updateDraft('theme', 'dark')}
                disabled={disabled}
                className={
                  'inline-flex items-center gap-1.5 rounded-lg ' +
                  'border px-3 py-1.5 text-xs font-medium ' +
                  'transition-colors ' +
                  'disabled:cursor-not-allowed disabled:opacity-60 ' +
                  'focus-visible:outline-none ' +
                  (draft.theme === 'dark'
                    ? 'border-primary bg-primary/10 text-primary ' +
                      'dark:bg-primary-light/10 ' +
                      'dark:text-primary-light'
                    : 'border-neutral-300 bg-background text-text ' +
                      'hover:bg-neutral-100 ' +
                      'dark:border-neutral-700 ' +
                      'dark:hover:bg-neutral-800 ' +
                      'dark:text-neutral-100')
                }
              >
                <Moon size={14} aria-hidden="true" />
                <span>Dark</span>
              </button>
            </div>
          </FieldRow>
        </div>
      </section>

      {/* ---- Behaviour ---- */}
      <section>
        <SectionHeader
          title="Pipeline behaviour"
          description="How the research, extraction, and writer stages behave by default."
        />
        <div className="divide-y divide-neutral-100 dark:divide-neutral-800/60">
          <FieldRow
            label="Auto-save after each stage"
            hint="Persist intermediate results to disk as each pipeline stage completes."
          >
            <ToggleSwitch
              checked={draft.autoSaveAfterEachStage}
              onChange={(v) => updateDraft('autoSaveAfterEachStage', v)}
              disabled={disabled}
            />
          </FieldRow>
          <FieldRow
            label="Notify on completion"
            hint="Flash the taskbar icon when a long-running operation finishes."
          >
            <ToggleSwitch
              checked={draft.notifyOnCompletion}
              onChange={(v) => updateDraft('notifyOnCompletion', v)}
              disabled={disabled}
            />
          </FieldRow>
        </div>
      </section>

      {/* ---- Updates ---- */}
      <section>
        <SectionHeader
          title="Updates"
          description="Check whether a newer version of WriteSpeare is available."
        />
        <div className="flex items-center justify-between gap-4 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <div className="min-w-0 flex-1">
            {!updateChecked && (
              <p className="text-sm text-neutral-600 dark:text-neutral-300">
                Check for updates to see whether a newer version is
                available.
              </p>
            )}
            {updateChecked && updateResult !== null && (
              <div className="flex items-start gap-2">
                <Download
                  size={16}
                  className="mt-0.5 shrink-0 text-primary"
                  aria-hidden="true"
                />
                <div>
                  <p className="text-sm font-medium text-text dark:text-neutral-100">
                    Version {updateResult.version} is available.
                  </p>
                  {updateResult.releaseNotes !== undefined && (
                    <p className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">
                      {updateResult.releaseNotes}
                    </p>
                  )}
                </div>
              </div>
            )}
            {updateChecked && updateResult === null && (
              <div className="flex items-center gap-2">
                <CheckCircle2
                  size={16}
                  className="shrink-0 text-emerald-600 dark:text-emerald-400"
                  aria-hidden="true"
                />
                <p className="text-sm text-neutral-600 dark:text-neutral-300">
                  You are running the latest version.
                </p>
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={onCheckUpdates}
            disabled={checking}
            className={
              'shrink-0 inline-flex items-center gap-1.5 ' +
              'rounded-lg bg-primary px-3 py-1.5 text-xs ' +
              'font-medium text-white transition-colors ' +
              'hover:bg-primary-dark ' +
              'disabled:cursor-not-allowed disabled:opacity-60 ' +
              'focus-visible:outline-none'
            }
          >
            {checking ? (
              <>
                <Loader2
                  size={14}
                  className="animate-spin"
                  aria-hidden="true"
                />
                <span>Checking…</span>
              </>
            ) : (
              <>
                <Download size={14} aria-hidden="true" />
                <span>Check for updates</span>
              </>
            )}
          </button>
        </div>
      </section>
    </div>
  );
};

// ---- Presets ----

interface PresetsTabProps {
  draft: UserSettingsMap;
  updateDraft: <K extends keyof UserSettingsMap>(
    key: K,
    value: UserSettingsMap[K]
  ) => void;
  disabled: boolean;
}

const renderPresetsTab = (props: PresetsTabProps): ReactNode => {
  const { draft, updateDraft, disabled } = props;

  return (
    <div className="space-y-8">
      {/* ---- Default preset ---- */}
      <section>
        <SectionHeader
          title="Default preset"
          description="The preset the New Topic modal pre-selects. Every preset is fully editable on the topic itself after creation."
        />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {PRESET_NAMES.map((preset: PresetName) => {
            const selected = draft.defaultPreset === preset;
            return (
              <button
                key={preset}
                type="button"
                onClick={() => updateDraft('defaultPreset', preset)}
                disabled={disabled}
                className={
                  'flex flex-col items-start gap-1 rounded-xl ' +
                  'border p-4 text-left transition-colors ' +
                  'disabled:cursor-not-allowed disabled:opacity-60 ' +
                  'focus-visible:outline-none ' +
                  (selected
                    ? 'border-primary bg-primary/5 ' +
                      'dark:border-primary-light ' +
                      'dark:bg-primary-light/5'
                    : 'border-neutral-200 bg-background ' +
                      'hover:border-neutral-300 hover:bg-neutral-50 ' +
                      'dark:border-neutral-800 ' +
                      'dark:hover:border-neutral-700 ' +
                      'dark:hover:bg-neutral-800/40')
                }
              >
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
                <span className="text-xs leading-snug text-neutral-500 dark:text-neutral-400">
                  {PRESET_DESCRIPTIONS[preset]}
                </span>
              </button>
            );
          })}
        </div>
      </section>

      {/* ---- Default profile ---- */}
      <section>
        <SectionHeader
          title="Default profile"
          description="The content profile that controls tone and structure. Individual topics can override this."
        />
        <div className="divide-y divide-neutral-100 dark:divide-neutral-800/60">
          <FieldRow label="Profile">
            <select
              value={draft.defaultProfile}
              onChange={(e) =>
                updateDraft(
                  'defaultProfile',
                  e.target.value as ProfileName
                )
              }
              disabled={disabled}
              className={
                'min-w-[12rem] rounded-lg border ' +
                'border-neutral-300 bg-background px-3 py-2 ' +
                'text-sm text-text focus:border-primary ' +
                'disabled:cursor-not-allowed disabled:opacity-60 ' +
                'dark:border-neutral-700 dark:bg-neutral-950 ' +
                'dark:text-neutral-100'
              }
            >
              {PROFILE_NAMES.map((name: ProfileName) => (
                <option key={name} value={name}>
                  {PROFILE_LABELS[name]}
                </option>
              ))}
            </select>
          </FieldRow>
        </div>
      </section>
    </div>
  );
};

// ---- Prompts ----

interface PromptsTabProps {
  draft: UserSettingsMap;
  updateDraft: <K extends keyof UserSettingsMap>(
    key: K,
    value: UserSettingsMap[K]
  ) => void;
  disabled: boolean;
}

const renderPromptsTab = (props: PromptsTabProps): ReactNode => {
  const { draft, updateDraft, disabled } = props;

  return (
    <div className="space-y-8">
      <section>
        <SectionHeader
          title="Default prompt template"
          description="The Jinja2 template the writer step renders into the DeepSeek prompt. Individual topics can override this."
        />
        <div className="divide-y divide-neutral-100 dark:divide-neutral-800/60">
          <FieldRow
            label="Prompt file"
            hint="Filename resolved relative to the prompts folder."
          >
            <input
              type="text"
              value={draft.defaultPromptFile}
              onChange={(e) =>
                updateDraft('defaultPromptFile', e.target.value)
              }
              disabled={disabled}
              placeholder="default.md"
              className={
                'min-w-[14rem] rounded-lg border ' +
                'border-neutral-300 bg-background px-3 py-2 ' +
                'text-sm text-text placeholder-neutral-400 ' +
                'focus:border-primary ' +
                'disabled:cursor-not-allowed disabled:opacity-60 ' +
                'dark:border-neutral-700 dark:bg-neutral-950 ' +
                'dark:text-neutral-100 ' +
                'dark:placeholder-neutral-500'
              }
            />
          </FieldRow>
        </div>
      </section>

      <section>
        <SectionHeader title="Built-in templates" />
        <ul className="space-y-2 rounded-lg border border-neutral-200 p-4 text-sm dark:border-neutral-800">
          <li className="flex items-baseline gap-2">
            <code className="font-mono text-xs text-primary dark:text-primary-light">
              default.md
            </code>
            <span className="text-neutral-600 dark:text-neutral-300">
              Neutral, informative voice. Good for most topics.
            </span>
          </li>
          <li className="flex items-baseline gap-2">
            <code className="font-mono text-xs text-primary dark:text-primary-light">
              seo-focused.md
            </code>
            <span className="text-neutral-600 dark:text-neutral-300">
              Keyword-heavy. Explicit placement rules for each keyword.
            </span>
          </li>
          <li className="flex items-baseline gap-2">
            <code className="font-mono text-xs text-primary dark:text-primary-light">
              conversational.md
            </code>
            <span className="text-neutral-600 dark:text-neutral-300">
              Warm, first-person voice. Good for personal blogs.
            </span>
          </li>
        </ul>
        <p className="mt-3 text-xs text-neutral-500 dark:text-neutral-400">
          Custom templates can be added by creating a new file in the
          app&rsquo;s prompts folder. Reference it by filename above or
          per-topic in the Advanced Settings of the New Topic modal.
        </p>
      </section>
    </div>
  );
};

// ---- Validation ----

interface ValidationTabProps {
  draft: UserSettingsMap;
}

const renderValidationTab = (props: ValidationTabProps): ReactNode => {
  const { draft } = props;
  const presetLabel = PRESET_LABELS[draft.defaultPreset];
  const presetDescription = PRESET_DESCRIPTIONS[draft.defaultPreset];

  return (
    <div className="space-y-8">
      <section>
        <SectionHeader
          title="Active preset"
          description="The preset whose thresholds the validation step applies to a new topic."
        />
        <div className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <p className="text-sm font-semibold text-text dark:text-neutral-100">
            {presetLabel}
          </p>
          <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-300">
            {presetDescription}
          </p>
        </div>
      </section>

      <section>
        <SectionHeader title="What each preset checks" />
        <div className="space-y-3 text-sm">
          <div className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
            <p className="font-medium text-text dark:text-neutral-100">
              Readability
            </p>
            <p className="mt-0.5 text-neutral-600 dark:text-neutral-300">
              Flesch Reading Ease, Flesch-Kincaid Grade, Gunning Fog,
              and SMOG scores, plus average sentence length.
            </p>
          </div>
          <div className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
            <p className="font-medium text-text dark:text-neutral-100">
              SEO structure
            </p>
            <p className="mt-0.5 text-neutral-600 dark:text-neutral-300">
              Word count, H2 and H3 heading counts, average paragraph
              length, passive voice percentage, and transition-word
              percentage.
            </p>
          </div>
          <div className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
            <p className="font-medium text-text dark:text-neutral-100">
              Keywords, originality, AI markers, grammar
            </p>
            <p className="mt-0.5 text-neutral-600 dark:text-neutral-300">
              Per-keyword placement and density, similarity against
              source documents, overused AI-tell phrases, and
              LanguageTool grammar issues.
            </p>
          </div>
        </div>
      </section>

      <section>
        <SectionHeader title="Tuning the thresholds" />
        <p className="text-sm text-neutral-600 dark:text-neutral-300">
          Thresholds are preset properties, not per-user settings. A
          custom preset with tuned thresholds can be created from the
          Advanced Settings section of the New Topic modal and saved
          for reuse.
        </p>
      </section>
    </div>
  );
};

// ---- DeepSeek ----

const renderDeepSeekTab = (): ReactNode => (
  <div className="space-y-8">
    <section>
      <SectionHeader
        title="Connection"
        description="How WriteSpeare talks to DeepSeek."
      />
      <div className="space-y-3 text-sm">
        <div className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <p className="font-medium text-text dark:text-neutral-100">
            Persistent session
          </p>
          <p className="mt-0.5 text-neutral-600 dark:text-neutral-300">
            WriteSpeare drives DeepSeek through a Chrome window with a
            dedicated user-data-dir. You signed in once during setup,
            and that session persists across app restarts — you do not
            log in again unless the session expires or you clear the
            Chrome profile.
          </p>
        </div>
        <div className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <p className="font-medium text-text dark:text-neutral-100">
            If the session expires
          </p>
          <p className="mt-0.5 text-neutral-600 dark:text-neutral-300">
            The next writer operation that hits a login wall will block
            and prompt you to sign in again in the Chrome window. Once
            you sign in, the operation resumes automatically.
          </p>
        </div>
        <div className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <p className="font-medium text-text dark:text-neutral-100">
            The Chrome profile location
          </p>
          <p className="mt-0.5 font-mono text-xs text-neutral-500 dark:text-neutral-400">
            &lt;appData&gt;/writespeare-desktop/chrome-profile
          </p>
        </div>
      </div>
    </section>
  </div>
);

// ---- Admin ----

interface AdminTabProps {
  onNavigate: () => void;
}

const renderAdminTab = (props: AdminTabProps): ReactNode => {
  const { onNavigate } = props;
  return (
    <div className="space-y-8">
      <section>
        <SectionHeader
          title="Administration"
          description="Manage users and system-wide presets."
        />
        <div className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <p className="text-sm text-neutral-600 dark:text-neutral-300">
            The admin panel lets you create and edit user accounts,
            change user roles, and manage the system-wide presets that
            every user of this installation reads.
          </p>
          <button
            type="button"
            onClick={onNavigate}
            className={
              'mt-4 inline-flex items-center gap-2 ' +
              'rounded-lg bg-primary px-4 py-2 text-sm ' +
              'font-medium text-white transition-colors ' +
              'hover:bg-primary-dark focus-visible:outline-none'
            }
          >
            <ServerCog size={16} aria-hidden="true" />
            <span>Open admin panel</span>
          </button>
        </div>
      </section>
    </div>
  );
};

// ============================================================
//  Settings — the main component
// ============================================================

/**
 * The settings page. See the file header for the page's
 * responsibilities, its draft/committed model, and the reasoning
 * behind the six-tab structure.
 */
export const Settings = (_props: SettingsProps = {}) => {
  const navigate = useNavigate();
  const toast = useToast();
  const { user } = useAuth();
  const {
    settings,
    status,
    error,
    loadSettings,
    saveSettings,
    clearError,
  } = useSettings();

  const isAdmin = user?.role === 'admin';

  // ---- Local state ----
  const [activeTab, setActiveTab] = useState<TabId>('general');
  const [draft, setDraft] = useState<UserSettingsMap | null>(null);
  const [saving, setSaving] = useState(false);

  // Update-check state. `updateChecked` distinguishes "not yet
  // checked" from "checked and up to date" so the panel's
  // initial and confirmed-success states render differently.
  const [checking, setChecking] = useState(false);
  const [updateResult, setUpdateResult] = useState<AppVersion | null>(
    null
  );
  const [updateChecked, setUpdateChecked] = useState(false);

  // ---- Load on mount ----
  // The `useSettings` hook does not auto-load — it is a passive
  // reader — so the page triggers the fetch itself. The effect
  // depends only on `loadSettings` (a stable Zustand action
  // reference), so it fires exactly once per mount.
  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  // ---- Sync the draft when settings arrive or change ----
  // The effect fires when the store's `settings` field changes.
  // It overwrites the draft with the fresh value, which is
  // correct for both the initial load (draft moves from null to
  // the loaded settings) and any external refresh (a save that
  // returned a merged result the store then stored). The effect
  // does NOT fire during user edits, because edits change the
  // draft, not the store.
  useEffect(() => {
    if (settings !== null) {
      setDraft(settings);
    }
  }, [settings]);

  // ---- Apply the theme to the document root ----
  // The effect reacts to the draft's theme value — which is the
  // "preview" behaviour described in the file header. The
  // committed value is used as a fallback when no draft exists
  // yet, so the theme is correct even during the initial load.
  //
  // The two Tailwind-selector-safe operations (add / remove) are
  // what `darkMode: 'class'` in `tailwind.config.js` picks up.
  useEffect(() => {
    const theme = draft?.theme ?? settings?.theme ?? 'light';
    const root = document.documentElement;
    if (theme === 'dark') {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
  }, [draft?.theme, settings?.theme]);

  // ---- Dirty flag ----
  // The draft differs from the committed settings if any field
  // differs. Computed with `useMemo` so the O(1) comparison runs
  // only when the two objects change identity — a non-issue for
  // an object with six fields, but the correct hygiene.
  const isDirty = useMemo((): boolean => {
    if (settings === null || draft === null) {
      return false;
    }
    return (
      draft.defaultPreset !== settings.defaultPreset ||
      draft.defaultProfile !== settings.defaultProfile ||
      draft.defaultPromptFile !== settings.defaultPromptFile ||
      draft.autoSaveAfterEachStage !== settings.autoSaveAfterEachStage ||
      draft.notifyOnCompletion !== settings.notifyOnCompletion ||
      draft.theme !== settings.theme
    );
  }, [settings, draft]);

  // ---- Draft updater ----
  // A generic setter that takes a field name and a value. The
  // keyof-constrained generic makes the value's type follow the
  // field's type — `updateDraft('theme', 'dark')` type-checks;
  // `updateDraft('theme', 'blue')` does not.
  const updateDraft = useCallback(
    <K extends keyof UserSettingsMap>(
      key: K,
      value: UserSettingsMap[K]
    ): void => {
      setDraft((prev) => {
        if (prev === null) return null;
        return { ...prev, [key]: value };
      });
    },
    []
  );

  // ---- Save ----
  const handleSave = useCallback((): void => {
    if (draft === null || saving) {
      return;
    }
    void (async (): Promise<void> => {
      setSaving(true);
      try {
        const merged = await saveSettings(draft);
        if (merged !== null) {
          toast.success('Settings saved.');
        } else {
          toast.error('Failed to save settings.');
        }
      } finally {
        setSaving(false);
      }
    })();
  }, [draft, saving, saveSettings, toast]);

  // ---- Discard ----
  const handleDiscard = useCallback((): void => {
    if (settings !== null) {
      setDraft(settings);
    }
  }, [settings]);

  // ---- Check for updates ----
  const handleCheckUpdates = useCallback((): void => {
    if (checking) {
      return;
    }
    void (async (): Promise<void> => {
      setChecking(true);
      setUpdateChecked(true);
      try {
        const result =
          await window.electronAPI.settings.checkUpdates();
        if (result.success) {
          setUpdateResult(result.data ?? null);
        } else {
          toast.error(result.error ?? 'Update check failed.');
          setUpdateResult(null);
        }
      } catch (err) {
        console.error('[Settings] checkUpdates failed:', err);
        toast.error('Unable to reach the update service.');
        setUpdateResult(null);
      } finally {
        setChecking(false);
      }
    })();
  }, [checking, toast]);

  // ---- Visible tabs ----
  // The Admin tab is filtered out for a non-admin user. The
  // filter runs on every render, which is O(6) — trivial — and
  // keeps the tab list correct if a future session makes the
  // role check reactive to a store update.
  const visibleTabs = useMemo(
    () => TABS.filter((tab) => !tab.adminOnly || isAdmin),
    [isAdmin]
  );

  // ---- Render: loading ----
  // The initial state is `settings === null`. Rendering a
  // spinner while the load is in flight is the correct behavior
  // for a page whose entire content depends on the loaded
  // settings — a partially-rendered tab bar with empty fields
  // would be misleading.
  if (settings === null) {
    if (status === 'error' && error !== null) {
      return (
        <div className="mx-auto flex h-full w-full max-w-2xl items-center justify-center px-6 py-8">
          <div
            role="alert"
            className={
              'flex w-full flex-col items-center gap-3 ' +
              'rounded-xl border border-red-200 bg-red-50 p-6 ' +
              'text-center dark:border-red-900 ' +
              'dark:bg-red-950/60'
            }
          >
            <AlertCircle
              size={24}
              className="text-red-600 dark:text-red-400"
              aria-hidden="true"
            />
            <p className="text-sm text-red-900 dark:text-red-100">
              {error}
            </p>
            <button
              type="button"
              onClick={() => {
                clearError();
                void loadSettings();
              }}
              className={
                'rounded-lg bg-red-600 px-4 py-2 text-sm ' +
                'font-medium text-white transition-colors ' +
                'hover:bg-red-700 focus-visible:outline-none'
              }
            >
              Try again
            </button>
          </div>
        </div>
      );
    }
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2
          size={28}
          className="animate-spin text-primary"
          aria-hidden="true"
        />
        <span className="sr-only">Loading settings…</span>
      </div>
    );
  }

  // ---- Render: loaded ----
  // `draft` is guaranteed non-null at this point: the sync effect
  // sets it as soon as `settings` becomes non-null, and the
  // branch above returns when `settings` is null. The defensive
  // `?? settings` fallback covers the one-tick window between
  // the two state updates, where `settings` is non-null but
  // `draft` has not yet been updated by the effect.
  const activeDraft = draft ?? settings;

  // ---- Render: page ----
  return (
    <div className="mx-auto flex h-full w-full max-w-4xl flex-col px-6 py-8">
      {/* ---- Header ---- */}
      <header className="mb-6">
        <h1 className="text-2xl font-semibold text-text dark:text-neutral-100">
          Settings
        </h1>
        <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
          Configure how WriteSpeare behaves on this device.
        </p>
      </header>

      {/* ---- Tab bar ---- */}
      <nav
        role="tablist"
        aria-label="Settings sections"
        className="mb-6 flex flex-wrap gap-1 border-b border-neutral-200 dark:border-neutral-800"
      >
        {visibleTabs.map((tab) => {
          const Icon = tab.icon;
          const active = tab.id === activeTab;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setActiveTab(tab.id)}
              className={
                'flex items-center gap-2 border-b-2 px-4 py-3 ' +
                'text-sm font-medium transition-colors ' +
                'focus-visible:outline-none ' +
                (active
                  ? 'border-primary text-primary'
                  : 'border-transparent text-neutral-500 ' +
                    'hover:border-neutral-300 ' +
                    'hover:text-neutral-700 ' +
                    'dark:text-neutral-400 ' +
                    'dark:hover:border-neutral-600 ' +
                    'dark:hover:text-neutral-200')
              }
            >
              <Icon size={16} aria-hidden="true" />
              <span>{tab.label}</span>
            </button>
          );
        })}
      </nav>

      {/* ---- Tab content ---- */}
      <div className="flex-1">
        {activeTab === 'general' &&
          renderGeneralTab({
            draft: activeDraft,
            updateDraft,
            disabled: saving,
            checking,
            updateResult,
            updateChecked,
            onCheckUpdates: handleCheckUpdates,
          })}
        {activeTab === 'presets' &&
          renderPresetsTab({
            draft: activeDraft,
            updateDraft,
            disabled: saving,
          })}
        {activeTab === 'prompts' &&
          renderPromptsTab({
            draft: activeDraft,
            updateDraft,
            disabled: saving,
          })}
        {activeTab === 'validation' &&
          renderValidationTab({
            draft: activeDraft,
          })}
        {activeTab === 'deepseek' && renderDeepSeekTab()}
        {activeTab === 'admin' &&
          isAdmin &&
          renderAdminTab({
            onNavigate: () => navigate('/dashboard/admin'),
          })}
      </div>

      {/* ---- Sticky footer: save/discard ---- */}
      {/* The footer is rendered only when the draft has unsaved
          changes. The `sticky bottom-0` positioning keeps the
          buttons visible while the user scrolls a long tab, and
          the negative-margin blur bar gives it a visual separation
          from the content below. When the form is clean, the
          footer unmounts and the content flows to the page's own
          bottom margin. */}
      {isDirty && (
        <div
          className={
            'sticky bottom-0 z-10 -mx-6 mt-6 flex items-center ' +
            'justify-end gap-2 border-t ' +
            'border-neutral-200 bg-background/95 px-6 py-3 ' +
            'backdrop-blur ' +
            'dark:border-neutral-800 dark:bg-neutral-900/95'
          }
        >
          <p className="mr-auto text-xs text-neutral-500 dark:text-neutral-400">
            <Bell size={12} className="mr-1 inline" aria-hidden="true" />
            You have unsaved changes.
          </p>
          <button
            type="button"
            onClick={handleDiscard}
            disabled={saving}
            className={
              'inline-flex items-center gap-1.5 rounded-lg ' +
              'border border-neutral-300 bg-background ' +
              'px-3 py-1.5 text-xs font-medium text-text ' +
              'transition-colors hover:bg-neutral-100 ' +
              'disabled:cursor-not-allowed disabled:opacity-60 ' +
              'focus-visible:outline-none ' +
              'dark:border-neutral-700 ' +
              'dark:hover:bg-neutral-800 ' +
              'dark:text-neutral-100'
            }
          >
            <RotateCcw size={14} aria-hidden="true" />
            <span>Discard</span>
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className={
              'inline-flex items-center gap-1.5 rounded-lg ' +
              'bg-primary px-3 py-1.5 text-xs font-medium ' +
              'text-white transition-colors ' +
              'hover:bg-primary-dark ' +
              'disabled:cursor-not-allowed disabled:opacity-60 ' +
              'focus-visible:outline-none'
            }
          >
            {saving ? (
              <>
                <Loader2
                  size={14}
                  className="animate-spin"
                  aria-hidden="true"
                />
                <span>Saving…</span>
              </>
            ) : (
              <>
                <Save size={14} aria-hidden="true" />
                <span>Save</span>
              </>
            )}
          </button>
        </div>
      )}
    </div>
  );
};

// ============================================================
//  Default export
// ============================================================

/**
 * The `Settings` component as the default export. The router in
 * `renderer/App.tsx` imports it with the default form
 * (`import Settings from '.../Settings.js'`), so this is the
 * export that keeps the route tree resolving.
 */
export default Settings;