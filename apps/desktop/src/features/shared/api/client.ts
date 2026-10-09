/**
 * Axios client for talking to the WriteSpeare backend.
 *
 * This module owns the one HTTP connection the desktop app makes
 * to the backend. It is used by the main process's feature
 * services — for example `topics/services/topicsApi.ts` — which
 * call `apiGet`, `apiPost`, and the other wrappers below. The
 * IPC handlers that feature modules register then pass the
 * resulting envelope straight through to the preload, which
 * resolves the renderer's `window.electronAPI.*` call with the
 * same envelope. See the file header of `src/main/preload.ts`
 * for the full chain.
 *
 * The renderer does not import this module. The golden rules
 * forbid the renderer from making backend calls directly —
 * everything goes through `window.electronAPI.*`. The compiled
 * renderer bundle therefore does not contain any of the code
 * below; the module is compiled only into the main-process
 * output (via tsc) because only the main process reaches it.
 *
 * The three concerns this module owns:
 *
 *   1. Base URL. The axios instance's `baseURL` is set to the
 *      `API_BASE_URL` constant declared in
 *      `shared/constants/index.ts`. That constant is the app's
 *      default; a future session that adds a runtime override
 *      (the settings page can, in principle, point the app at a
 *      self-hosted backend) will call `setBaseURL(url)` — the
 *      setter is not defined yet because no caller needs it, and
 *      adding it speculatively would give future code a place
 *      to write state that nothing currently reads.
 *
 *   2. Auth header. A module-level `authToken` holds the bearer
 *      token, and the request interceptor attaches it to every
 *      outgoing request as `Authorization: Bearer <token>`. The
 *      token is injected by the main process via `setAuthToken`,
 *      which `main/index.ts` and the auth IPC handler call on
 *      every login and logout. Storing the token in a module
 *      variable rather than in the electron-store is deliberate:
 *      the store is the source of truth, and the variable here
 *      is a fast-access cache of it. When the store changes, the
 *      variable is updated. When the process restarts, the
 *      variable is reinitialized from the store during startup.
 *
 *   3. 401 handling. The response interceptor inspects every
 *      error response for a 401 status. On a 401, it clears the
 *      module-level token and invokes the handler registered via
 *      `setUnauthorizedHandler`. That handler is expected to
 *      clear the persistent store and notify the renderer (via
 *      IPC) to redirect to the login page. The interceptor
 *      itself does neither — it has no access to the store or
 *      the window — which is why the handler indirection exists.
 *
 * The uniform return contract:
 *
 *   The four wrapper functions (`apiGet`, `apiPost`, `apiPatch`,
 *   `apiDelete`) all return `Promise<ApiResponse<T>>` and never
 *   reject. Any failure — a 4xx/5xx from the server, a network
 *   error, a DNS failure, a JSON parse failure, a timeout — is
 *   converted into an envelope with `success: false` and a
 *   human-readable `error` string. This mirrors the backend's
 *   own response contract and the IPC contract, so the same
 *   envelope flows from the HTTP boundary all the way to the
 *   renderer's caller without any conversion layer in between.
 *
 *   The alternative — throwing on failure — would force every
 *   caller (each feature's service, each IPC handler, each
 *   renderer hook) to wrap its call in a try/catch. That
 *   duplication is exactly what the envelope pattern exists to
 *   avoid.
 *
 * Why the module-level state and not a factory:
 *
 *   The plan's file-tree description for this module says
 *   "Axios instance" — singular. There is one backend, one
 *   token, and one 401 handler per process; a factory that
 *   produced multiple instances would have no caller. A
 *   module-level singleton with setters for the two pieces of
 *   mutable state (the token, the handler) is the simplest
 *   shape that fits the description and the usage.
 */

import axios, { type AxiosError, type AxiosInstance } from 'axios';

import { API_BASE_URL } from '../constants/index.js';
import type { ApiResponse } from '../types/index.js';

// ============================================================
//  Module state
// ============================================================

/**
 * The bearer token the request interceptor attaches to every
 * outgoing request. `null` means "no active session" — the
 * interceptor skips the Authorization header in that case, which
 * is what the login endpoint needs and what the app wants before
 * any session exists.
 *
 * Mutated only by `setAuthToken` below. The interceptor reads it
 * on every request; there is no caching to invalidate.
 */
let authToken: string | null = null;

/**
 * The callback the response interceptor invokes when the backend
 * returns a 401. Registered by `main/index.ts` (or by the auth
 * IPC handler) at startup. `null` means "no handler registered"
 * — the interceptor still clears the local token but cannot
 * trigger a UI redirect, which is the correct fallback when the
 * app is shutting down or the handler has not yet been wired.
 */
let unauthorizedHandler: (() => void) | null = null;

/**
 * Set or clear the bearer token the client attaches to
 * subsequent requests.
 *
 * Called at three points in the app's lifetime:
 *
 *   - On startup, from `main/index.ts`, with the token read from
 *     the encrypted store — this restores the session before any
 *     request is made.
 *   - On login success, from the auth IPC handler, with the
 *     token returned by the backend.
 *   - On logout (or 401-triggered session expiry), with `null`.
 *
 * Passing `null` is equivalent to clearing — there is no separate
 * `clearAuthToken` function because the two operations are the
 * same and a distinct name for the same behavior would be
 * redundant surface.
 */
export const setAuthToken = (token: string | null): void => {
  authToken = token;
};

/**
 * Register the callback the response interceptor invokes on a
 * 401 response. Passing `null` unregisters the current handler
 * * and leaves the interceptor's token-clearing behavior intact.
 *
 * The handler is expected to (a) clear the encrypted store's
 * token and cached user, (b) call `setAuthToken(null)` — though
 * the interceptor already does this — and (c) notify the
 * renderer via IPC so the UI can redirect to `/login`. The
 * interceptor does not attempt any of these itself; it only
 * signals that the session is gone.
 */
export const setUnauthorizedHandler = (
  handler: (() => void) | null
): void => {
  unauthorizedHandler = handler;
};

// ============================================================
//  Axios instance
// ============================================================

/**
 * The single axios instance shared by every feature service in
 * the main process. Constructed once at module load, with the
 * default base URL and a thirty-second timeout.
 *
 * The timeout is generous because the backend's endpoints are
 * all fast CRUD operations — the desktop-side operations that
 * take seconds (research, extraction, writing) run as Python
 * child processes in the main process and do not go through the
 * backend's HTTP API. A thirty-second ceiling catches a
 * genuinely hung connection without cutting off a legitimate
 * request during a moment of unusual load.
 *
 * `Content-Type` is set as a default for the same reason axios
 * would set it anyway on a request with a body. Making it
 * explicit here means a future code path that forgets to pass
 * a body still sends the header, and the backend's JSON parser
 * treats the (empty) body as an empty object rather than as a
 * form-encoded payload.
 */
const client: AxiosInstance = axios.create({
  baseURL: API_BASE_URL,
  timeout: 30_000,
  headers: {
    'Content-Type': 'application/json',
  },
});

// ============================================================
//  Request interceptor
// ============================================================

/**
 * Attach the bearer token to every outgoing request, when one
 * exists.
 *
 * The check is `if (authToken)` rather than `if (authToken !==
 * null)` — an empty string token and a null token both skip the
 * header, which is the correct behavior because the backend
 * would reject an empty-string token with the same 401 it would
 * return for a missing one.
 *
 * The header is set via `headers.set(...)` — the type-safe form
 * for axios v1's `AxiosHeaders` class — rather than by direct
 * property assignment. Both work at runtime; the `.set()` form
 * is the one axios v1 documents and type-checks cleanly under
 * the project's strict TypeScript settings.
 */
client.interceptors.request.use((config) => {
  if (authToken) {
    config.headers.set('Authorization', `Bearer ${authToken}`);
  }
  return config;
});

// ============================================================
//  Response interceptor
// ============================================================

/**
 * Detect 401 responses and dispatch to the unauthorized handler.
 *
 * The interceptor does three things on a 401:
 *
 *   1. Clears the module-level token so no subsequent request
 *      carries the stale credential. Without this, every
 *      request after the first 401 would fire another 401 —
 *      each one triggering the handler — until the app finally
 *      cleared the token through some other path.
 *
 *   2. Invokes the registered handler, if any. The handler
 *      performs the store cleanup and the IPC notification
 *      described in its own docstring.
 *
 *   3. Re-rejects the error so the wrapper function that
 *      initiated the request can convert it into a
 *      `{ success: false, error }` envelope. Rejecting rather
 *      than silently swallowing is what lets the caller see the
 *      failure; without the re-throw, the promise would resolve
 *      to `undefined` and every caller would need a null check.
 *
 * The handler invocation is wrapped in a `try`/`catch` so a
 * bug in the handler does not mask the original 401 from the
 * caller. The handler's own error is logged; the caller still
 * sees the 401 as the reason the request failed.
 *
 * The interceptor does NOT convert the 401 into a success
 * envelope — that is the wrapper functions' job, performed on
 * the way back up the chain. Keeping the interceptor's
 * responsibility narrow (detect and signal) and the wrappers'
 * responsibility broad (fully normalize any failure into the
 * envelope) means there is exactly one place where the envelope
 * is constructed.
 */
client.interceptors.response.use(
  (response) => response,
  (error: AxiosError) => {
    if (error.response?.status === 401) {
      authToken = null;
      if (unauthorizedHandler) {
        try {
          unauthorizedHandler();
        } catch (handlerError) {
          // The handler is expected to be well-behaved; a throw
          // from it is a bug in the handler. Log it and continue
          // — the caller still sees the 401 rejection.
          console.error(
            '[api/client] unauthorized handler threw:',
            handlerError
          );
        }
      }
    }
    return Promise.reject(error);
  }
);

// ============================================================
//  Error conversion
// ============================================================

/**
 * Convert any thrown value — an axios error, a network failure,
 * a parsing error, a programming error in a caller — into a
 * standard `ApiResponse<T>` with `success: false`.
 *
 * Three cases, handled in order of specificity:
 *
 *   1. An axios error whose `response.data` already looks like
 *      our envelope. This is the common case — the backend
 *      returns `{ success: false, error: '...' }` for 4xx and
 *      5xx responses — and the correct behavior is to pass the
 *      envelope through unchanged. The check for
 *      `typeof body.success === 'boolean'` is what distinguishes
 *      a real envelope from an arbitrary JSON object the server
 *      might have returned (a raw 404 body, a proxy's HTML
 *      error page that got parsed as JSON, and so on).
 *
 *   2. An axios error with a response but no recognizable
 *      envelope. This happens when a proxy or an intermediary
 *      returns a non-JSON error body, or when the backend
 *      itself returns a shape the desktop does not recognize.
 *      The response's status code is used to build a generic
 *      message — enough for the caller to log or display
 *      something actionable, without leaking the raw body.
 *
 *   3. An axios error with no response at all — a network
 *      timeout, a DNS failure, a connection refused. The
 *      axios error's `message` carries the reason; it is used
 *      directly.
 *
 * Any non-axios error falls through to the last branch, which
 * wraps its message (or a generic string for non-`Error` values)
 * into the envelope. This branch should never fire in production
 * — every path in this module produces an axios error — but
 * treating it as an explicit case avoids an `any`-typed fallback.
 */
const toApiResponse = <T>(error: unknown): ApiResponse<T> => {
  if (axios.isAxiosError(error)) {
    const data: unknown = error.response?.data;

    if (
      typeof data === 'object' &&
      data !== null &&
      typeof (data as { success?: unknown }).success === 'boolean'
    ) {
      return data as ApiResponse<T>;
    }

    if (error.response) {
      return {
        success: false,
        error: `Request failed with status ${error.response.status}.`,
      };
    }

    return {
      success: false,
      error: error.message || 'Unable to reach the server.',
    };
  }

  return {
    success: false,
    error:
      error instanceof Error
        ? error.message
        : 'An unexpected error occurred.',
  };
};

// ============================================================
//  Typed wrappers
// ============================================================

/**
 * Send a GET request and return the response body as an
 * `ApiResponse<T>`. Never rejects. See the file header for why
 * the uniform "always returns an envelope" contract is the
 * right one for this layer.
 */
export const apiGet = async <T>(url: string): Promise<ApiResponse<T>> => {
  try {
    const response = await client.get<ApiResponse<T>>(url);
    return response.data;
  } catch (error) {
    return toApiResponse<T>(error);
  }
};

/**
 * Send a POST request with an optional JSON body. Never rejects.
 */
export const apiPost = async <T>(
  url: string,
  body?: unknown
): Promise<ApiResponse<T>> => {
  try {
    const response = await client.post<ApiResponse<T>>(url, body);
    return response.data;
  } catch (error) {
    return toApiResponse<T>(error);
  }
};

/**
 * Send a PATCH request with an optional JSON body. Never rejects.
 */
export const apiPatch = async <T>(
  url: string,
  body?: unknown
): Promise<ApiResponse<T>> => {
  try {
    const response = await client.patch<ApiResponse<T>>(url, body);
    return response.data;
  } catch (error) {
    return toApiResponse<T>(error);
  }
};

/**
 * Send a DELETE request with an optional JSON body. Never rejects.
 *
 * The body parameter is optional because the backend's delete
 * endpoints do not currently accept one, but the signature
 * accepts it so that a future endpoint that needs to carry a
 * reason or a confirmation token can do so without a signature
 * change here.
 */
export const apiDelete = async <T>(
  url: string,
  body?: unknown
): Promise<ApiResponse<T>> => {
  try {
    const response = await client.delete<ApiResponse<T>>(url, {
      data: body,
    });
    return response.data;
  } catch (error) {
    return toApiResponse<T>(error);
  }
};

// ============================================================
//  Default export
// ============================================================

/**
 * The raw axios instance, exported for consumers that need to
 * configure something the typed wrappers do not expose — a
 * request with a custom response type, a streaming response, a
 * request that overrides the default timeout for one call.
 *
 * The feature services should use the wrappers. The default
 * export exists as an escape hatch, not as the recommended
 * interface. If a caller reaches for the raw instance, the
 * caller takes on responsibility for handling the axios error
 * shape — the wrappers do not.
 */
export default client;