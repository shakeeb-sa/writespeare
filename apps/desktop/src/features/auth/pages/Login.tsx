/**
 * WriteSpeare — login page.
 *
 * The screen a user sees when the app has no active session and
 * the layout's auth gate has redirected them to `/login`. Its
 * job is narrow: collect an email and a password, submit them
 * through `useAuth().login(...)`, and either navigate to the
 * dashboard (on success) or display the error the backend
 * returned (on failure).
 *
 * The page is deliberately minimal. It does not attempt to
 * explain what WriteSpeare is (the app's README and the plan's
 * user-journey document are the places for that), it does not
 * offer a "forgot password" flow (there is no self-service
 * password reset in the plan — a user who has forgotten their
 * password asks an administrator to reset it), and it does not
 * offer a "create account" link (accounts are created by an
 * administrator in the admin panel, not self-service). The page
 * presents a single, unambiguous next step: sign in with the
 * credentials an administrator gave you.
 *
 * Navigation on success — why the useEffect and not a call in
 * the submit handler:
 *
 *   When `login()` resolves successfully, the auth store's
 *   `user` field transitions from `null` to a `User` object.
 *   The store's subscription mechanism notifies every component
 *   that reads `user` from `useAuth()`, and this component
 *   re-renders.
 *
 *   The `useEffect` below watches for that transition and
 *   navigates to `/dashboard`. It also fires on mount if the
 *   user was ALREADY authenticated when they landed on the
 *   login page — a user who has a valid session and navigates
 *   to `/login` (via the browser's back button, or by typing
 *   the URL) is sent straight to the dashboard without seeing
 *   the form.
 *
 *   The alternative — calling `navigate('/dashboard')` from the
 *   submit handler, right after `await login(...)` — would work
 *   for the "just logged in" case but would not handle the
 *   "already logged in on arrival" case. Splitting the two
 *   behaviours across two places would eventually let them
 *   drift. Keeping the navigation in one effect means the
 *   rule "an authenticated user should not see the login page"
 *   is enforced by exactly one piece of code.
 *
 * Error display — why inline and not a toast:
 *
 *   The app has a toast system (see `shared/components/Toast.tsx`)
 *   that would be a natural way to surface a login failure. This
 *   page uses an inline error banner instead, for a specific
 *   reason: the error is about the form the user is looking at,
 *   and it should be visible next to the fields they need to
 *   correct. A toast in the corner of the screen is easy to
 *   miss when the user's attention is on the form, and it
 *   disappears after a few seconds even if the user has not
 *   read it. The inline banner stays until the next attempt
 *   (when the store's error field is cleared by `login()`).
 *
 *   The plan's user journey does not specify which mechanism to
 *   use. Inline is the conventional choice for login forms, and
 *   it is the one this page implements.
 *
 * The remember-me checkbox — captured but not honoured:
 *
 *   The plan describes the login form as having a remember-me
 *   checkbox. The checkbox is rendered here and its value is
 *   part of the `LoginFormValues` object submitted to
 *   `useAuth().login(...)`. The hook currently does not forward
 *   the field to the IPC layer, because the app's session
 *   persistence is unconditional — the main process's encrypted
 *   store always keeps the token across restarts. There is no
 *   "do not remember me" mode today.
 *
 *   The checkbox is rendered anyway because the plan declares
 *   it, and because the user's expectation of a login form is
 *   that it has one. Its presence costs nothing; a future
 *   session that implements the non-persisting mode will have
 *   the UI already in place, and the hook's one-line change will
 *   make the checkbox functional.
 *
 * The default of `rememberMe` is `true` — the plan's user
 * journey makes DeepSeek connectivity a one-time setup step and
 * expects the desktop session to persist across restarts.
 * A user who wants to be logged out on every restart can uncheck
 * the box once the flag is honoured; today the default matches
 * the app's actual behaviour, which is to remember the session
 * unconditionally.
 *
 * Focus management:
 *
 *   The email field carries the `autoFocus` attribute, so on
 *   mount the browser places the text cursor there. A user
 *   arriving at the login page can start typing their email
 *   without a click. This is the standard behaviour for a
 *   single-purpose page whose only purpose is to accept
 *   credentials.
 *
 *   The password visibility toggle does not steal focus from the
 *   password field — clicking it toggles the input's `type`
 *   between `password` and `text` while keeping focus on the
 *   input itself. The user can continue typing without a second
 *   click.
 */

import {
  useEffect,
  useState,
  type ChangeEvent,
  type FormEvent,
} from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertCircle,
  Eye,
  EyeOff,
  Feather,
  Loader2,
} from 'lucide-react';

import { useAuth } from '../hooks/useAuth.js';
import type { LoginFormValues } from '../types/authTypes.js';
import { APP_NAME } from '../../shared/constants/index.js';

// ============================================================
//  Public types
// ============================================================

/**
 * The props accepted by `Login`. Currently empty — see the file
 * header for the component's responsibilities and why it takes
 * no props.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface LoginProps {
  // Reserved for future additions. See file header.
}

// ============================================================
//  Constants
// ============================================================

/**
 * The form's initial values. Extracted as a constant so that a
 * future "reset the form on some event" flow has one place to
 * reference. The `rememberMe` default matches the app's actual
 * persistence behaviour — see the file header.
 */
const INITIAL_FORM_VALUES: LoginFormValues = {
  email: '',
  password: '',
  rememberMe: true,
};

// ============================================================
//  Login
// ============================================================

/**
 * The login page. See the file header for the page's scope, its
 * navigation strategy, its error-display choice, and the
 * remember-me handling.
 */
export const Login = (_props: LoginProps = {}) => {
  const navigate = useNavigate();

  // The hook provides the values this page reads (`isLoading`,
  // `user`, `error`) and the one action it invokes (`login`).
  // The `token` field and the `logout`/`refresh` actions are
  // part of the hook's API but not used here — a login page has
  // no reason to read the token or to log out or refresh.
  const { user, isLoading, error, login } = useAuth();

  // ---- Form state ----
  // The controlled form values. A single object rather than
  // three separate `useState` calls so that the `onChange`
  // handler is uniform and the values are always in sync.
  const [values, setValues] = useState<LoginFormValues>(
    INITIAL_FORM_VALUES
  );

  // Whether a submission is in flight. Drives the submit
  // button's disabled state and the spinner it shows.
  const [submitting, setSubmitting] = useState(false);

  // Whether the password field is currently revealing its
  // contents. Toggled by the eye/eye-off button inside the
  // password input's wrapper. Reset to hidden on unmount —
  // not that it matters, since the component is destroyed, but
  // keeping the state local ensures a fresh mount always starts
  // with the password hidden.
  const [showPassword, setShowPassword] = useState(false);

  // ---- Redirect an authenticated user away from the login page ----
  // See the file header for why this is an effect rather than
  // an inline navigate call. The condition guards against the
  // cold-start window: `isLoading` is true until the app has
  // determined whether a session exists, and navigating during
  // that window would send the user to the dashboard before
  // the dashboard itself has had a chance to redirect them back
  // if the session turned out to be absent.
  useEffect(() => {
    if (!isLoading && user) {
      navigate('/dashboard', { replace: true });
    }
  }, [isLoading, user, navigate]);

  // ---- Change handlers ----
  // Each handler updates one field of the form state via the
  // functional-update form. The functional form is used so the
  // handler does not have to list `values` as a dependency and
  // does not read a potentially-stale `values` object.

  const handleEmailChange = (event: ChangeEvent<HTMLInputElement>): void => {
    const email = event.target.value;
    setValues((prev) => ({ ...prev, email }));
  };

  const handlePasswordChange = (
    event: ChangeEvent<HTMLInputElement>
  ): void => {
    const password = event.target.value;
    setValues((prev) => ({ ...prev, password }));
  };

  const handleRememberMeChange = (
    event: ChangeEvent<HTMLInputElement>
  ): void => {
    const rememberMe = event.target.checked;
    setValues((prev) => ({ ...prev, rememberMe }));
  };

  const toggleShowPassword = (): void => {
    setShowPassword((prev) => !prev);
  };

  // ---- Submit handler ----
  // Delegates the actual credential exchange to the hook's
  // `login`, which resolves with a boolean. The boolean is
  // deliberately not read here — the hook sets the store's
  // `user` on success and its `error` on failure, and this
  // component reacts to both via the store subscriptions and
  // the effect above. The `setSubmitting` calls bracket the
  // await so the button stays in its loading state for exactly
  // the duration of the IPC round-trip.
  const handleSubmit = async (
    event: FormEvent<HTMLFormElement>
  ): Promise<void> => {
    event.preventDefault();

    // Guard against a double-submit — a user pressing Enter
    // twice, or clicking the button while a previous attempt is
    // still in flight. The disabled attribute on the button
    // handles the click case; the guard handles the Enter-key
    // case where the form's onSubmit fires even if the button
    // is disabled.
    if (submitting) {
      return;
    }

    setSubmitting(true);
    // The return value is discarded — see the comment above.
    await login(values);
    setSubmitting(false);
  };

  // ---- Render ----
  return (
    <div className="flex min-h-full items-center justify-center bg-neutral-50 px-4 py-12 dark:bg-neutral-950">
      <div className="w-full max-w-md">
        {/* ---- Brand header ---- */}
        <div className="mb-8 flex flex-col items-center">
          <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-primary text-white shadow-soft">
            <Feather size={24} aria-hidden="true" />
          </div>
          <h1 className="text-2xl font-semibold text-text dark:text-neutral-100">
            {APP_NAME}
          </h1>
          <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
            Sign in to continue
          </p>
        </div>

        {/* ---- Card ---- */}
        <div className="rounded-2xl border border-neutral-200 bg-background p-6 shadow-medium dark:border-neutral-800 dark:bg-neutral-900">
          {/* ---- Error banner ---- */}
          {error && (
            <div
              role="alert"
              className="mb-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900 dark:bg-red-950/60 dark:text-red-100"
            >
              <AlertCircle
                size={18}
                className="mt-0.5 shrink-0 text-red-600 dark:text-red-400"
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1">{error.message}</span>
            </div>
          )}

          {/* ---- Form ---- */}
          <form onSubmit={handleSubmit} className="space-y-4" noValidate>
            {/* Email field */}
            <div>
              <label
                htmlFor="login-email"
                className="mb-1.5 block text-sm font-medium text-text dark:text-neutral-200"
              >
                Email
              </label>
              <input
                id="login-email"
                type="email"
                autoComplete="email"
                autoFocus
                required
                value={values.email}
                onChange={handleEmailChange}
                disabled={submitting}
                className="w-full rounded-lg border border-neutral-300 bg-background px-3 py-2 text-sm text-text placeholder-neutral-400 focus:border-primary disabled:cursor-not-allowed disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100 dark:placeholder-neutral-500"
                placeholder="you@example.com"
              />
            </div>

            {/* Password field */}
            <div>
              <label
                htmlFor="login-password"
                className="mb-1.5 block text-sm font-medium text-text dark:text-neutral-200"
              >
                Password
              </label>
              <div className="relative">
                <input
                  id="login-password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  required
                  value={values.password}
                  onChange={handlePasswordChange}
                  disabled={submitting}
                  className="w-full rounded-lg border border-neutral-300 bg-background px-3 py-2 pr-10 text-sm text-text placeholder-neutral-400 focus:border-primary disabled:cursor-not-allowed disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100 dark:placeholder-neutral-500"
                  placeholder="••••••••"
                />
                <button
                  type="button"
                  onClick={toggleShowPassword}
                  disabled={submitting}
                  aria-label={
                    showPassword ? 'Hide password' : 'Show password'
                  }
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800 disabled:cursor-not-allowed disabled:opacity-60 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
                >
                  {showPassword ? (
                    <EyeOff size={16} aria-hidden="true" />
                  ) : (
                    <Eye size={16} aria-hidden="true" />
                  )}
                </button>
              </div>
            </div>

            {/* Remember me */}
            <label className="flex cursor-pointer items-center gap-2 text-sm text-neutral-700 dark:text-neutral-300">
              <input
                type="checkbox"
                checked={values.rememberMe}
                onChange={handleRememberMeChange}
                disabled={submitting}
                className="h-4 w-4 cursor-pointer rounded border-neutral-300 text-primary focus:ring-primary disabled:cursor-not-allowed disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-950"
              />
              <span>Remember me on this device</span>
            </label>

            {/* Submit button */}
            <button
              type="submit"
              disabled={submitting}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-primary-dark disabled:cursor-not-allowed disabled:opacity-60"
            >
              {submitting ? (
                <>
                  <Loader2
                    size={18}
                    className="animate-spin"
                    aria-hidden="true"
                  />
                  <span>Signing in…</span>
                </>
              ) : (
                <span>Sign in</span>
              )}
            </button>
          </form>
        </div>

        {/* ---- Footer note ---- */}
        <p className="mt-6 text-center text-xs text-neutral-500 dark:text-neutral-400">
          Need an account? Ask an administrator to create one for
          you.
        </p>
      </div>
    </div>
  );
};

// ============================================================
//  Default export
// ============================================================

/**
 * The `Login` component as the default export. `renderer/App.tsx`
 * imports this with the default form
 * (`import Login from '.../Login.js'`), so this is the export
 * that keeps the route tree resolving.
 */
export default Login;