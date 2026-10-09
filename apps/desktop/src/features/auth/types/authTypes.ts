/**
 * Feature-local types for the auth feature.
 *
 * This module declares the types that are scoped to the auth
 * feature and that do not belong in the shared types module. The
 * distinction is intentional and worth being explicit about:
 *
 *   Shared types (`features/shared/types/index.ts`) describe
 *   domain entities and payloads that cross the desktop↔backend
 *   boundary. `User`, `LoginRequest`, `LoginResponse`,
 *   `ApiResponse<T>` — every one of them is a wire shape that
 *   both sides of the app agree on.
 *
 *   Feature-local types (this module) describe the shape of a
 *   component's own form state or the shape of an error the
 *   feature produces. They never cross the network. If a
 *   future change ever needed one of these types on the
 *   backend, that would be the signal that the type had been
 *   misclassified — and it would move to the shared module in
 *   the same change.
 *
 * Only two types are declared here, and both are consumed by the
 * auth feature's Login page and its `useAuth` hook. The plan's
 * description of this file — "LoginFormValues, AuthError" — is
 * the complete list; nothing has been added for symmetry or
 * anticipation.
 *
 * Why this file exists as its own module rather than as types
 * declared inline in the Login page:
 *
 *   The same two types appear in at least three places in the
 *   feature. `LoginFormValues` is used by the Login page's
 *   state, by its `onSubmit` handler, and by the `useAuth`
 *   hook's `login` function signature (which receives the
 *   credentials the form produces). `AuthError` is used by the
 *   `useAuth` hook's `error` return value and by the Login
 *   page's error-display logic. Declaring either type inline in
 *   one of those files would force the other files to import
 *   it from a component, which inverts the natural dependency
 *   direction — a hook should not depend on a page. This module
 *   is the shared vocabulary the feature's modules agree on.
 */

// ============================================================
//  Form values
// ============================================================

/**
 * The shape of the Login form's controlled values.
 *
 * The Login page holds one object of this shape in `useState`
 * and updates it on every keystroke; the form's `onSubmit`
 * handler reads the object to build the request it sends through
 * `useAuth().login(...)`.
 *
 * All three fields are required. The form's initial state sets
 * `email` and `password` to empty strings and `rememberMe` to
 * `true` — the app's default is to remember the session, since
 * the plan's user journey makes DeepSeek connectivity a one-time
 * setup step and expects the desktop session to persist across
 * restarts without requiring a re-login.
 *
 * Why `rememberMe` is part of the form values rather than
 * tracked separately in a piece of state or as a prop:
 *
 *   The checkbox is rendered as part of the same form element
 *   as the two text inputs, and the form's initial values and
 *   its submit payload are both naturally a single object. A
 *   separate piece of state would force the form's initialiser
 *   and the submit handler to read from two sources to build
 *   the same logical unit of data — a small friction with no
 *   benefit. The three values move together because they are
 *   chosen together.
 */
export interface LoginFormValues {
  /** The email address the user typed. Not validated on the
   *  client beyond HTML's `type="email"` on the input — the
   *  backend's schema is the authoritative validator, and a
   *  client-side format check that disagreed with the backend's
   *  would produce worse UX than letting the server reject it. */
  email: string;

  /** The password the user typed. Not validated on the client
   *  beyond the requirement that it not be empty — the backend
   *  is the authority, and the frontend has no business
   *  enforcing a password policy it does not own. */
  password: string;

  /** Whether to persist the session across app restarts. Read by
   *  the Login page after a successful login to decide whether
   *  to call the "persist this session" IPC path or to leave
   *  the token ephemeral. See the file header for the default. */
  rememberMe: boolean;
}

// ============================================================
//  Errors
// ============================================================

/**
 * The shape of an auth error as the renderer consumes it.
 *
 * The backend returns errors as a message string inside the
 * standard `ApiResponse` envelope — `{ success: false, error:
 * 'Invalid email or password' }`. The IPC layer passes that
 * envelope through unchanged, and the auth API wrapper in the
 * renderer converts the envelope's `error` string into this
 * shape before handing it to the hook and the page.
 *
 * The interface has exactly one field today. A plain `string`
 * would also work, and would be marginally simpler at every read
 * site. The reason `AuthError` is an object anyway:
 *
 *   The renderer's error-handling code is uniform across the
 *   app — a component that displays an error reads `.message`
 *   off of whatever object it receives. Keeping the auth error
 *   an object preserves that uniformity, and it means a future
 *   addition to the shape (a machine-readable code for
 *   distinguishing "wrong password" from "account deactivated"
 *   from "network timeout", a retryable flag, a field-level
 *   breakdown) does not require a breaking change at every
 *   consumer. The cost of the extra `.message` at each read
 *   site is trivially small compared to the cost of a breaking
 *   change that ripples through the feature's files.
 *
 * The type does not currently carry a code field because the
 * backend does not currently return one — its error responses
 * are human-readable strings, and inventing a code mapping here
 * would mean the renderer had to classify the backend's messages
 * by string matching, which is fragile. If a future session
 * adds codes on the backend, the field is added here in the
 * same change.
 */
export interface AuthError {
  /**
   * The user-facing message. Rendered as-is in the login form's
   * error banner. The backend's messages are already written for
   * a user to read — "Invalid email or password", "Account is
   * deactivated. Please contact an administrator." — and the
   * renderer does not modify them.
   */
  message: string;
}