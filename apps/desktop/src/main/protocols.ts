/**
 * Custom protocol registration for the WriteSpeare desktop app.
 *
 * A "custom protocol" is a scheme that the app itself defines and
 * that Electron's Chromium instance knows how to resolve. This
 * file registers one such scheme — `writespeare-asset://` — so
 * that the renderer can load the app's bundled images with
 * ordinary HTML URLs:
 *
 *   <img src="writespeare-asset://images/logo.svg" alt="WriteSpeare" />
 *
 * Without the custom scheme, the renderer would have to know the
 * absolute filesystem path of every asset, which differs between
 * development (source tree) and production (packaged app
 * resources). With the scheme, the URL is the same in both
 * environments: the scheme's handler resolves it against a base
 * directory it computes at request time from `app.isPackaged`.
 *
 * Two-phase registration — why this file exports two functions
 * instead of one:
 *
 *   Electron requires custom schemes to be declared to Chromium
 *   BEFORE the app's `ready` event fires, so that Chromium knows
 *   how to treat URLs of that scheme when the first renderer
 *   starts loading. After `ready`, the handler that actually
 *   serves responses can be installed.
 *
 *   These two phases use two different Electron APIs:
 *
 *     `protocol.registerSchemesAsPrivileged(...)` — must run
 *       before `ready`. Declares the scheme's properties
 *       (whether it's a standard scheme, whether it's considered
 *       secure, etc.). Calling it after `ready` throws.
 *
 *     `protocol.handle(scheme, handler)` — must run after
 *       `ready`. Installs the request handler that returns
 *       responses for URLs of this scheme.
 *
 *   Because the APIs have different timing requirements, they
 *   live in two functions. `main/index.ts` calls
 *   `registerProtocolSchemes()` at module load (before the
 *   `app.whenReady().then(...)` block) and calls
 *   `registerProtocolHandlers()` inside the `whenReady` block.
 *   Trying to combine the two into one function would force the
 *   caller to invoke a single function at one of the two
 *   timings, which would be wrong either way.
 *
 * The URL shape:
 *
 *   `writespeare-asset://images/logo.svg`
 *     host     = 'images'
 *     pathname = '/logo.svg'
 *
 *   The handler below treats the union of host and pathname as
 *   the path relative to the resource base. The triple-slash
 *   form `writespeare-asset:///images/logo.svg` also works — it
 *   puts `images/logo.svg` entirely in the pathname with an
 *   empty host — and produces the same resolved file. Both
 *   forms are accepted because the handler strips any leading
 *   slashes before joining.
 *
 * The resource base:
 *
 *   In production (`app.isPackaged === true`), the base is
 *   `process.resourcesPath`, which is where electron-builder
 *   copies the `extraResources` blocks declared in package.json.
 *   The four extraResources sources (`src/resources/images`,
 *   `.../config`, `.../python`, `.../scripts`) all land as
 *   direct subdirectories of that path, so
 *   `writespeare-asset://images/logo.svg` resolves to
 *   `<resourcesPath>/images/logo.svg`.
 *
 *   In development (`app.isPackaged === false`), the base is
 *   `apps/desktop/src/resources/`, computed relative to this
 *   module's own location. The compiled file lives at
 *   `dist/main/protocols.js`, so the relative path from there to
 *   the source resources is `../../src/resources`.
 *
 * Path traversal protection:
 *
 *   The handler resolves the requested path against the base
 *   directory, then verifies that the resolved path still lives
 *   inside the base. A request like
 *   `writespeare-asset://images/../../../etc/passwd` — if the
 *   URL parser did not already normalize the `..` segments —
 *   would resolve outside the base directory and be rejected
 *   with a 403.
 *
 *   The check compares the resolved path against the base
 *   followed by a path separator, which ensures that a sibling
 *   directory whose name shares a prefix with the base (say,
 *   `resources-secret` when the base is `resources`) does not
 *   pass the check.
 *
 *   The check does NOT guard against symlinks inside the base
 *   directory that point outside it. Symlinks are the app's own
 *   responsibility — nothing in the bundled resources tree is a
 *   symlink, and the plan does not call for one. If a future
 *   session adds a symlinked resource, the check would need to
 *   be strengthened with `fs.realpath` and a second prefix
 *   comparison against the resolved real path.
 *
 * Security posture:
 *
 *   The scheme is registered as `secure: true`, which means
 *   Chromium treats it as a secure context — no mixed-content
 *   warnings, and resources loaded through it are not flagged
 *   as insecure by any future browser-level policy.
 *
 *   The scheme is registered as `standard: true`, which makes
 *   Chromium parse URLs of this scheme as standard URLs (with
 *   host, port, and path components) rather than as opaque
 *   strings. Without this privilege, `<img src="writespeare-asset://...">`
 *   would not be treated as a URL by the resource loader and
 *   the tag would fail silently.
 *
 *   The scheme is registered as `supportFetchAPI: true` so that
 *   a future renderer component that wants to `fetch()` an SVG
 *   and inline it as text — a common technique for styling SVG
 *   fills with CSS — can do so. It costs nothing today: the
 *   flag only affects what APIs Chromium exposes for URLs of
 *   this scheme.
 *
 *   The scheme is NOT registered with `corsEnabled: true`.
 *   Without CORS enforcement, `<img>` tags work from any origin
 *   (the renderer in dev is at `http://localhost:5173`, in prod
 *   at `file://`) and cross-origin restrictions do not apply to
 *   display of the image. If a future feature needs the
 *   renderer to `fetch()` an asset and READ its body (as
 *   opposed to just displaying it), the correct change is to
 *   add `corsEnabled: true` here and add the appropriate
 *   `Access-Control-Allow-Origin` response header in the
 *   handler. Until then, the simpler posture is correct.
 */

import { app, protocol } from 'electron';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// ============================================================
//  Constants
// ============================================================

/**
 * The custom scheme this module registers.
 *
 * Exported so that main/index.ts (or a future preload helper)
 * can reference the scheme by its constant name rather than by a
 * string literal. The literal form `'writespeare-asset'` also
 * works — the string appears in exactly this one place, and any
 * consumer that needs it can import it from here.
 */
export const SCHEME = 'writespeare-asset';

/**
 * The prefix that every URL of this scheme starts with. Cached
 * at module load so the handler does not recompute it on every
 * request.
 */
const SCHEME_PREFIX = `${SCHEME}://`;

/**
 * MIME type lookup keyed by lowercased file extension.
 *
 * This map covers only image types — that is the class of asset
 * the plan describes the scheme as serving ("the logo and UI
 * assets"). A request for a file whose extension is not in this
 * map is served with `application/octet-stream`, which causes
 * the browser to treat the response as a binary download rather
 * than attempting to render it as an image or a document.
 *
 * Adding a new type to this map is a two-line change: add the
 * extension (with its leading dot) as a key, and the MIME type
 * string as the value. If a future session needs to serve fonts
 * or JSON through this scheme, that is where the change goes.
 */
const MIME_TYPES: Record<string, string> = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
};

// ============================================================
//  Helpers
// ============================================================

/**
 * Resolve the resource base directory — the parent of every file
 * the scheme is allowed to serve. See the file header for the
 * distinction between the two branches.
 *
 * The function is called on every request rather than computed
 * once at module load, because `app.isPackaged` is a property
 * whose value is stable across the app's lifetime but whose
 * correctness depends on the value being read AFTER Electron has
 * finished its own initialization. Reading it at module load
 * would work for a packaged app (where the value is set before
 * the main script loads) but is fragile if the module is ever
 * imported earlier than expected. Reading it per-request is
 * cheap — it is a property access and a `path.resolve` call —
 * and correct regardless of when the module is first loaded.
 */
const resolveResourceBase = (): string => {
  if (app.isPackaged) {
    return process.resourcesPath;
  }

  // In development, this module is at `dist/main/protocols.js`.
  // The source resources directory is at `src/resources/`, two
  // levels up from `dist/main/` and then into `src/resources`.
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(currentDir, '../../src/resources');
};

/**
 * Return the MIME type for a resolved file path, based on its
 * extension. Falls back to `application/octet-stream` for any
 * extension not in the map — see the file header for the
 * consequences of that fallback.
 */
const getContentType = (filePath: string): string => {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] ?? 'application/octet-stream';
};

// ============================================================
//  Phase 1 — register the scheme as privileged
// ============================================================

/**
 * Declare the `writespeare-asset` scheme and its privileges to
 * Chromium.
 *
 * MUST be called BEFORE `app.whenReady()` resolves — Electron
 * enforces this by throwing if the call happens after `ready`.
 * See the file header for the three privileges chosen and the
 * reasoning behind each.
 *
 * Synchronous, no return value. `main/index.ts` calls this once
 * at module scope, at the top of the file, before the
 * `app.whenReady().then(...)` block.
 */
export const registerProtocolSchemes = (): void => {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
      },
    },
  ]);
};

// ============================================================
//  Phase 2 — install the request handler
// ============================================================

/**
 * Install the handler that answers every request to the
 * `writespeare-asset` scheme.
 *
 * MUST be called AFTER `app.whenReady()` resolves — the
 * `protocol.handle` API is only available once Chromium is ready
 * to route requests. `main/index.ts` calls this inside the
 * `whenReady` block, before the first BrowserWindow is created.
 *
 * The handler is `async` because serving a file is I/O bound.
 * Electron's `protocol.handle` supports async handlers and awaits
 * the returned promise before using the response.
 *
 * Flow:
 *
 *   1. Extract the requested path by stripping the scheme prefix
 *      and any leading slashes. Both `writespeare-asset://images/x.svg`
 *      and `writespeare-asset:///images/x.svg` reduce to the same
 *      `images/x.svg` at this point.
 *
 *   2. Reject with 404 if the resulting path is empty — an empty
 *      request has nothing to serve and is not a valid asset
 *      reference.
 *
 *   3. Percent-decode the path so that a URL like
 *      `writespeare-asset://images/logo%2Esvg` resolves to the
 *      same file as `logo.svg`. A malformed percent sequence is
 *      rejected with 400 — a client that produces one has a bug,
 *      and the correct response is a clear error.
 *
 *   4. Resolve the decoded path against the resource base. The
 *      `path.resolve` call normalizes any `.` and `..` segments
 *      in the decoded path, which is what makes the traversal
 *      check below meaningful.
 *
 *   5. Reject with 403 if the resolved path is not inside the
 *      resource base. The check appends a trailing separator to
 *      the base before comparing, so that a sibling directory
 *      whose name shares a prefix with the base does not pass.
 *
 *   6. Read the file. Any error — ENOENT (file does not exist),
 *      EISDIR (path is a directory), EACCES (permission), or
 *      anything else — is logged and converted to a 404. The
 *      caller receives a uniform "not found" response rather
 *      than a response that reveals which failure mode occurred,
 *      which would leak filesystem state to a renderer that
 *      probed the scheme.
 *
 *   7. Return the file contents with the correct MIME type and a
 *      one-hour cache directive. The assets are static and
 *      versioned by filename in practice — if the logo changes,
 *      the filename changes — so a one-hour cache is safe and
 *      substantially reduces the number of file reads during a
 *      long session.
 */
export const registerProtocolHandlers = (): void => {
  protocol.handle(SCHEME, async (request) => {
    // ---- 1. Extract the requested path ----
    const rawPath = request.url
      .slice(SCHEME_PREFIX.length)
      .replace(/^\/+/, '');

    // ---- 2. Reject empty paths ----
    if (rawPath.length === 0) {
      return new Response('Not Found', { status: 404 });
    }

    // ---- 3. Percent-decode ----
    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(rawPath);
    } catch {
      // A malformed percent sequence (`%2` with no following hex
      // digit, for example) throws a URIError. Reject with 400
      // rather than trying to salvage the string — a client that
      // produced a malformed URL has a bug, and silent recovery
      // would hide it.
      return new Response('Bad Request', { status: 400 });
    }

    // ---- 4. Resolve against the resource base ----
    const base = resolveResourceBase();
    const resolved = path.resolve(base, decodedPath);

    // ---- 5. Path traversal guard ----
    // The base is normalized to end with a path separator, so the
    // comparison cannot be fooled by a sibling directory whose
    // name shares a prefix (e.g. `resources-secret` when the base
    // is `resources`).
    const baseWithSep = base.endsWith(path.sep) ? base : base + path.sep;
    if (!resolved.startsWith(baseWithSep)) {
      return new Response('Forbidden', { status: 403 });
    }

    // ---- 6. Read and return the file ----
    try {
      const data = await readFile(resolved);
      return new Response(new Uint8Array(data), {
        status: 200,
        headers: {
          'Content-Type': getContentType(resolved),
          'Cache-Control': 'public, max-age=3600',
        },
      });
    } catch (err) {
      // The error is logged for the operator; the client sees a
      // uniform 404 regardless of which failure mode occurred.
      console.error(
        '[protocols] failed to serve asset:',
        resolved,
        err
      );
      return new Response('Not Found', { status: 404 });
    }
  });
};