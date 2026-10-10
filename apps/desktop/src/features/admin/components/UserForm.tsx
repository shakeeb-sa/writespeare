/**
 * UserForm — the create/edit user modal for the admin panel.
 *
 * A single component that serves two modes: creating a new user
 * account and editing an existing one. The page (`Admin.tsx`)
 * renders it unconditionally and passes two pieces of state that
 * determine what the user sees:
 *
 *   `open`  — whether the modal is currently visible. When false,
 *             the modal is a no-op; when true, the form fields
 *             are populated and the user can edit them.
 *
 *   `user`  — the account being edited, or null for "create a
 *             new user". The two modes are distinguished entirely
 *             by this prop's value.
 *
 * On submit, the form calls the appropriate admin action
 * (`createUser` for a new account, `updateUser` for an existing
 * one), fires a toast on the outcome, and — on success — calls
 * its `onSuccess` callback so the page can close the modal.
 *
 * ── The form's four fields ──────────────────────────────────────
 *
 *   email     — required, non-empty string. Trimmed before
 *               submission. Not client-validated for format —
 *               the backend's schema applies the same rule and
 *               a client-side check that disagreed with the
 *               schema's would produce worse UX than letting
 *               the server reject it.
 *
 *   password  — required in create mode, optional in edit mode.
 *               In edit mode, an empty field means "leave the
 *               existing password alone"; a non-empty value
 *               means "replace the password". This is the
 *               standard "change password" form pattern: the
 *               field starts empty, and the user is only asked
 *               to supply a value if they want to change it.
 *
 *   role      — a dropdown with the two legal `UserRole` values.
 *               Defaults to `USER` in create mode, and to the
 *               user's current role in edit mode.
 *
 *   active    — a toggle. Defaults to `true` in create mode, and
 *               to the user's current active state in edit mode.
 *
 * ── Why the form does NOT re-validate the backend's rules ───────
 *
 *   The backend's `userController.createUser` and
 *   `userController.updateUser` validate the primitive types and
 *   the closed-set membership of every field, and the User schema
 *   applies the semantic rules (email format, uniqueness, minimum
 *   password constraints if any were added). This form's job is
 *   to collect the values, not to second-guess the validation.
 *
 *   The one exception is the password field's "required on
 *   create, optional on edit" distinction — that is a form-level
 *   rule about what the user is being asked for, not a
 *   validation of the value itself. The form enforces it by
 *   disabling the submit button when the create-mode password is
 *   empty. A blank email also disables the submit button in both
 *   modes, because an empty email would produce a confusing
 *   backend error ("email is required") rather than the obvious
 *   "you haven't filled in the form" feedback the user needs.
 *
 * ── Reset on open ───────────────────────────────────────────────
 *
 *   The form resets its state every time the `open` prop flips
 *   from false to true, populating the fields from the `user`
 *   prop (in edit mode) or from the create-mode defaults (when
 *   `user` is null). This mirrors the reset-on-open pattern used
 *   by `NewTopicModal.tsx`.
 *
 *   Without the reset, a user who edits user A, closes the
 *   modal, then opens it again for user B would find user A's
 *   email still in the field. That's a subtle data-leak bug —
 *   the wrong values would be showing for a moment — and the
 *   reset effect is what prevents it.
 *
 *   The effect depends on both `open` and `user`, so it fires
 *   on the "modal opened" transition AND on a change of the
 *   target user while the modal is already open. The second
 *   case does not arise in the current page's flow — the page
 *   closes the modal before changing the target — but the
 *   dependency is declared anyway so the form is correct if a
 *   future session adds an in-modal "switch to user B" flow.
 *
 * ── Why the password field includes a visibility toggle ─────────
 *
 *   The password field starts masked (`type="password"`) and
 *   carries a small eye icon that toggles it to plaintext. This
 *   matches the login form's pattern (`Login.tsx`) and the
 *   conventional UX for password fields — an admin typing a
 *   temporary password for a new user wants to see what they
 *   typed, and a masked field would force them to type it twice
 *   or paste it from elsewhere. The toggle does not steal focus
 *   from the input, so the user can keep typing.
 *
 * ── What this component does NOT do ─────────────────────────────
 *
 *   - It does not fetch the user list or the target user. The
 *     list comes from the page via the store; the target user
 *     comes from the page via the `user` prop.
 *
 *   - It does not manage its own open/closed state. The page
 *     owns the boolean and controls it through the `open` prop
 *     and the `onClose` callback. This is the same controlled-
 *     component pattern the New Topic modal uses.
 *
 *   - It does not distinguish "creating" from "editing" via a
 *     prop — the mode is derived from whether `user` is null.
 *     A dedicated `mode` prop would duplicate information that
 *     the `user` prop already carries, and the two could
 *     disagree in a caller that set them inconsistently.
 *
 *   - It does not show an inline error banner. Failures surface
 *     as toasts, matching the rest of the admin panel's error
 *     surface. The form clears the fields' submission flag on
 *     failure but leaves the field values in place, so the
 *     admin can correct and retry without retyping.
 *
 * Dependencies: react + lucide-react + the three sibling
 * modules the form composes (Modal, useToast, useAdmin) + the
 * shared User types. All present.
 */

import {
  useCallback,
  useEffect,
  useState,
  type ChangeEvent,
  type FormEvent,
} from 'react';
import { Eye, EyeOff, Loader2, Save } from 'lucide-react';

import Modal from '../../shared/components/Modal.js';
import { useToast } from '../../shared/hooks/useToast.js';
import { useAdmin } from '../hooks/useAdmin.js';
import type {
  User,
  UserCreatePayload,
  UserUpdatePayload,
  UserRole,
} from '../../shared/types/index.js';

// ============================================================
//  Public types
// ============================================================

/**
 * The props accepted by `UserForm`.
 *
 * The shape is fixed by construction: the sibling page
 * (`Admin.tsx`) passes exactly these four props at its own
 * `<UserForm ... />` call site, and any drift between the two
 * sides produces a compile-time TS2322 on the page. The
 * interface is exported so a future helper that needs to
 * construct a `UserForm`-shaped prop object can reference the
 * same type without redeclaring it.
 */
export interface UserFormProps {
  /** Whether the modal is currently visible. */
  open: boolean;

  /** The user being edited, or null when the form is creating a
   *  new account. */
  user: User | null;

  /** Called when the modal should close without saving — by the
   *  user dismissing it, or by the page's flow after a
   *  successful save. */
  onClose: () => void;

  /** Called after a successful create or update. The page uses
   *  this to close the modal and clear its editing target. */
  onSuccess: () => void;
}

// ============================================================
//  Form state
// ============================================================

/**
 * The form's internal state. A single object rather than four
 * separate `useState` calls so the reset-on-open effect can
 * assign every field in one update, and so the change handlers
 * can each be a one-line spread.
 *
 * The `password` field is a plain string in both modes. Its
 * "required on create, optional on edit" distinction is a rule
 * about the form's submission logic, not about the field's
 * type.
 */
interface FormValues {
  email: string;
  password: string;
  role: UserRole;
  active: boolean;
}

/**
 * The create-mode defaults. In edit mode, the reset effect
 * overrides every field from the `user` prop; the value below
 * is used only when the modal opens in create mode.
 *
 * The default role is `USER` (a new account should not be an
 * admin by default) and the default active state is `true`
 * (a freshly-created account is usable immediately).
 */
const INITIAL_CREATE_VALUES: FormValues = {
  email: '',
  password: '',
  role: 'user',
  active: true,
};

/**
 * The two role options, in display order. Declared as a
 * `readonly` tuple so the dropdown's iteration is exhaustive
 * and the array cannot be mutated by accident.
 */
const ROLE_OPTIONS: readonly UserRole[] = ['user', 'admin'];

/**
 * Human-readable labels for the two roles. The enum values are
 * lowercase strings (`'user'`, `'admin'`); the labels capitalize
 * them for display. Declared as a `Record<UserRole, string>` so
 * the compiler enforces exhaustiveness: adding a third role to
 * the enum without adding a label here is a compile error, not a
 * runtime `undefined`.
 */
const ROLE_LABELS: Record<UserRole, string> = {
  user: 'User',
  admin: 'Admin',
};

// ============================================================
//  UserForm — the main component
// ============================================================

/**
 * The create/edit user modal. See the file header for the
 * component's responsibilities, its two modes, and the reasoning
 * behind the design.
 */
export const UserForm = ({
  open,
  user,
  onClose,
  onSuccess,
}: UserFormProps) => {
  const toast = useToast();
  const { createUser, updateUser } = useAdmin();

  // ---- Form state ----
  const [values, setValues] = useState<FormValues>(INITIAL_CREATE_VALUES);

  // ---- Submission flag ----
  // True between the click on the submit button and the
  // resolution of the create/update promise. Drives the disabled
  // state on every field and on the two footer buttons.
  const [submitting, setSubmitting] = useState(false);

  // ---- Password visibility ----
  // Resets to `false` (hidden) every time the modal opens, so a
  // freshly-opened form never starts with the password revealed.
  const [showPassword, setShowPassword] = useState(false);

  // ---- Mode ----
  // Derived from the `user` prop. The `user !== null` form is
  // the single source of truth for "editing an existing account";
  // a separate `mode` prop would be redundant with this and could
  // disagree with it.
  const isEditMode = user !== null;

  // ---- Reset on open ----
  // Fires when the modal opens, and when the target user changes
  // while the modal is open. See the file header for the full
  // rationale.
  useEffect(() => {
    if (!open) {
      return;
    }

    if (user !== null) {
      // Edit mode: populate from the target user. The password
      // starts empty — the field is a "leave blank to keep
      // unchanged" slot, and prefilling it with anything
      // (even a placeholder) would be misleading.
      setValues({
        email: user.email,
        password: '',
        role: user.role,
        active: user.active,
      });
    } else {
      // Create mode: start from the defaults.
      setValues(INITIAL_CREATE_VALUES);
    }

    setSubmitting(false);
    setShowPassword(false);
  }, [open, user]);

  // ---- Change handlers ----
  // Each handler updates one field via the functional-update
  // form. The functional form is used so the handlers do not
  // have to list `values` as a dependency and do not read a
  // potentially-stale `values` object.

  const handleEmailChange = (
    event: ChangeEvent<HTMLInputElement>
  ): void => {
    const email = event.target.value;
    setValues((prev) => ({ ...prev, email }));
  };

  const handlePasswordChange = (
    event: ChangeEvent<HTMLInputElement>
  ): void => {
    const password = event.target.value;
    setValues((prev) => ({ ...prev, password }));
  };

  const handleRoleChange = (
    event: ChangeEvent<HTMLSelectElement>
  ): void => {
    const rawValue = event.target.value;
    // The `<select>` values are the enum's string values, so
    // the runtime value matches the `UserRole` union. The check
    // below narrows it explicitly rather than asserting, so a
    // future change that added a third option without updating
    // this handler would fail loudly rather than silently
    // storing an unrecognized string.
    if (rawValue !== 'admin' && rawValue !== 'user') {
      return;
    }
    setValues((prev) => ({ ...prev, role: rawValue }));
  };

  const handleActiveChange = (
    event: ChangeEvent<HTMLInputElement>
  ): void => {
    const active = event.target.checked;
    setValues((prev) => ({ ...prev, active }));
  };

  const toggleShowPassword = (): void => {
    setShowPassword((prev) => !prev);
  };

  // ---- Submit handler ----
  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>): Promise<void> => {
      event.preventDefault();

      // Guard against a double-submit. The submit button's
      // disabled state handles the visual case; this guard
      // handles a programmatic call or a rapid Enter-press on
      // a form whose button has not yet re-rendered.
      if (submitting) {
        return;
      }

      const trimmedEmail = values.email.trim();

      // A blank email is rejected here even though the submit
      // button is disabled when it is blank — a belt-and-braces
      // guard against a form submission that bypassed the
      // button (an Enter press on a focused field after a
      // programmatic clear).
      if (trimmedEmail.length === 0) {
        return;
      }

      setSubmitting(true);

      try {
        if (isEditMode && user !== null) {
          // ---- Edit mode ----
          // The patch carries email, role, and active
          // unconditionally. The password is included only when
          // the field is non-empty — an empty password means
          // "leave the existing password alone". Omitting the
          // field is what tells the backend not to touch it.
          const patch: UserUpdatePayload = {
            email: trimmedEmail,
            role: values.role,
            active: values.active,
          };
          if (values.password.length > 0) {
            patch.password = values.password;
          }

          const updated = await updateUser(user._id, patch);

          if (updated !== null) {
            toast.success(`Updated ${updated.email}`);
            onSuccess();
          } else {
            toast.error('Failed to update user.');
          }
        } else {
          // ---- Create mode ----
          // All four fields are supplied. The password is
          // required here — the submit button is disabled
          // when it is empty, and the guard below repeats
          // the check for the same reason the email guard
          // exists.
          if (values.password.length === 0) {
            setSubmitting(false);
            return;
          }

          const payload: UserCreatePayload = {
            email: trimmedEmail,
            password: values.password,
            role: values.role,
            active: values.active,
          };

          const created = await createUser(payload);

          if (created !== null) {
            toast.success(`Created ${created.email}`);
            onSuccess();
          } else {
            toast.error('Failed to create user.');
          }
        }
      } finally {
        setSubmitting(false);
      }
    },
    [
      submitting,
      values,
      isEditMode,
      user,
      updateUser,
      createUser,
      toast,
      onSuccess,
    ]
  );

  const handleSubmitForm = (event: FormEvent<HTMLFormElement>): void => {
    void handleSubmit(event);
  };

  // ---- Derived flags ----
  const emailIsEmpty = values.email.trim().length === 0;
  const passwordIsEmpty = values.password.length === 0;
  // The submit button is disabled when the form is
  // incomplete — an empty email in either mode, or an empty
  // password in create mode. In edit mode, an empty password
  // is valid (it means "leave the password alone") and does
  // not disable the button.
  const submitDisabled =
    submitting || emailIsEmpty || (!isEditMode && passwordIsEmpty);

  // ---- Modal title and button label ----
  const modalTitle = isEditMode ? 'Edit User' : 'New User';
  const submitLabel = isEditMode ? 'Save Changes' : 'Create User';

  // ---- Render ----
  return (
    <Modal
      open={open}
      onClose={onClose}
      variant="info"
      size="md"
      title={modalTitle}
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

          <button
            type="submit"
            form="user-form"
            disabled={submitDisabled}
            className={
              'inline-flex items-center gap-2 rounded-lg bg-primary ' +
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
                <span>Saving…</span>
              </>
            ) : (
              <>
                <Save size={16} aria-hidden="true" />
                <span>{submitLabel}</span>
              </>
            )}
          </button>
        </>
      }
    >
      <form
        id="user-form"
        onSubmit={handleSubmitForm}
        noValidate
        className="space-y-5"
      >
        {/* ---- Email ---- */}
        <div>
          <label
            htmlFor="user-form-email"
            className={
              'mb-1.5 block text-sm font-medium ' +
              'text-text dark:text-neutral-200'
            }
          >
            Email <span className="text-red-500">*</span>
          </label>
          <input
            id="user-form-email"
            type="email"
            autoComplete="off"
            required
            value={values.email}
            onChange={handleEmailChange}
            disabled={submitting}
            placeholder="user@example.com"
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

        {/* ---- Password ---- */}
        <div>
          <label
            htmlFor="user-form-password"
            className={
              'mb-1.5 block text-sm font-medium ' +
              'text-text dark:text-neutral-200'
            }
          >
            Password{' '}
            {!isEditMode && <span className="text-red-500">*</span>}
          </label>
          <div className="relative">
            <input
              id="user-form-password"
              type={showPassword ? 'text' : 'password'}
              autoComplete="new-password"
              required={!isEditMode}
              value={values.password}
              onChange={handlePasswordChange}
              disabled={submitting}
              placeholder={
                isEditMode
                  ? 'Leave blank to keep current password'
                  : '••••••••'
              }
              className={
                'w-full rounded-lg border border-neutral-300 ' +
                'bg-background px-3 py-2 pr-10 text-sm ' +
                'text-text placeholder-neutral-400 ' +
                'focus:border-primary ' +
                'disabled:cursor-not-allowed disabled:opacity-60 ' +
                'dark:border-neutral-700 dark:bg-neutral-950 ' +
                'dark:text-neutral-100 dark:placeholder-neutral-500'
              }
            />
            <button
              type="button"
              onClick={toggleShowPassword}
              disabled={submitting}
              aria-label={
                showPassword ? 'Hide password' : 'Show password'
              }
              className={
                'absolute right-2 top-1/2 -translate-y-1/2 ' +
                'rounded p-1 text-neutral-500 ' +
                'hover:bg-neutral-100 hover:text-neutral-800 ' +
                'disabled:cursor-not-allowed disabled:opacity-60 ' +
                'dark:text-neutral-400 dark:hover:bg-neutral-800 ' +
                'dark:hover:text-neutral-100'
              }
            >
              {showPassword ? (
                <EyeOff size={16} aria-hidden="true" />
              ) : (
                <Eye size={16} aria-hidden="true" />
              )}
            </button>
          </div>
          {isEditMode && (
            <p
              className={
                'mt-1 text-xs text-neutral-500 ' +
                'dark:text-neutral-400'
              }
            >
              Leave the field blank to keep the user&rsquo;s current
              password.
            </p>
          )}
        </div>

        {/* ---- Role ---- */}
        <div>
          <label
            htmlFor="user-form-role"
            className={
              'mb-1.5 block text-sm font-medium ' +
              'text-text dark:text-neutral-200'
            }
          >
            Role
          </label>
          <select
            id="user-form-role"
            value={values.role}
            onChange={handleRoleChange}
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
            {ROLE_OPTIONS.map((role) => (
              <option key={role} value={role}>
                {ROLE_LABELS[role]}
              </option>
            ))}
          </select>
          <p
            className={
              'mt-1 text-xs text-neutral-500 ' +
              'dark:text-neutral-400'
            }
          >
            Admins can manage users and system-wide settings.
          </p>
        </div>

        {/* ---- Active ---- */}
        <div>
          <label className="flex cursor-pointer items-start gap-3">
            <input
              type="checkbox"
              checked={values.active}
              onChange={handleActiveChange}
              disabled={submitting}
              className={
                'mt-0.5 h-4 w-4 cursor-pointer rounded ' +
                'border-neutral-300 text-primary accent-primary ' +
                'focus:ring-primary ' +
                'disabled:cursor-not-allowed disabled:opacity-60 ' +
                'dark:border-neutral-600 dark:bg-neutral-950'
              }
            />
            <span className="text-sm text-text dark:text-neutral-200">
              <span className="font-medium">Active</span>
              <span className="ml-1 text-neutral-500 dark:text-neutral-400">
                — deactivated accounts cannot log in.
              </span>
            </span>
          </label>
        </div>
      </form>
    </Modal>
  );
};

// ============================================================
//  Default export
// ============================================================

/**
 * The `UserForm` component as the default export. The sibling
 * `Admin.tsx` page imports it with the default form
 * (`import UserForm from '../components/UserForm.js'`), so this
 * is the export that resolves that file's forward reference.
 */
export default UserForm;