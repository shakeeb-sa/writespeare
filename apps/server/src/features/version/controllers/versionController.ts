/**
 * HTTP handler for the WriteSpeare public version endpoint.
 *
 * The version feature is the only one in the backend whose read
 * path is intentionally unauthenticated. The reason is
 * structural, not incidental:
 *
 *   The desktop client's update checker runs before the user has
 *   logged in — on first launch, on every subsequent launch, and
 *   after any logout. If the endpoint were behind `authenticate`,
 *   the client would need a valid bearer token to discover that a
 *   security update is available, which is exactly the moment
 *   when the token might not exist yet. Requiring authentication
 *   for an update check would create a chicken-and-egg problem
 *   for the client, and would force the user to log in on an
 *   outdated build before being told they need to update.
 *
 *   The endpoint therefore returns only public information — the
 *   latest release version, its download URL, and its release
 *   notes — and no per-user data. There is nothing in the
 *   response that would not appear in a public changelog.
 *
 *   Every OTHER route in the application is behind
 *   `authenticate`. This is the one exception, and it is scoped
 *   to a single handler that reads a single collection with a
 *   single query. The exception does not generalize.
 *
 * The endpoint reads the most recent AppVersion document by
 * `createdAt`. That is the "latest version" the update checker
 * compares against its own build version. The compound index
 * `{ createdAt: -1 }` on the AppVersion schema serves this as a
 * single-record lookup with no collection scan and no in-memory
 * sort stage.
 *
 * The 404 case — "no versions have been published yet" — is
 * treated as a legitimate, non-error response. A fresh backend
 * deployment that has not yet had its first release created
 * would otherwise fail the client's update check with a 500,
 * which would surface as a mysterious startup error. The
 * correct behaviour is a 404 that says exactly what happened:
 * the client reads it, treats it as "no update available", and
 * proceeds normally.
 *
 * No `authenticate` middleware is applied to this route (see
 * the `versionRoutes.ts` file when it is created). That is
 * deliberate — the file header above explains why.
 */

import type { Request, Response } from 'express';

import { AppVersionModel } from '../models/AppVersion.js';
import type { ApiResponse, AppVersion } from '../../shared/types/index.js';

// ============================================================
//  GET /api/version
// ============================================================

/**
 * Return the most recently published release.
 *
 * Flow:
 *
 *   1. Query the AppVersion collection for the single document
 *      with the highest `createdAt` value. The `{ createdAt: -1 }`
 *      index on the schema makes this a single-record lookup —
 *      MongoDB scans the index from the top and stops at the
 *      first entry, without fetching the rest of the collection
 *      and without an in-memory sort.
 *
 *   2. If no document was found, respond with 404 and a message
 *      that names the actual state — "no version published yet"
 *      — rather than a generic "not found". The client treats
 *      this as "no update available" and proceeds without
 *      surfacing an error to the user.
 *
 *   3. Otherwise, respond with 200 and the AppVersion document,
 *      wrapped in the shared `ApiResponse` envelope. The client
 *      reads `data.version`, compares it against its own build
 *      version, and decides whether to prompt the user.
 *
 * The handler does not read `req` at all. There are no query
 * parameters, no route parameters, and no request body — the
 * endpoint's only input is "does a version exist, and which one
 * is the newest". The `_req` parameter is named with a leading
 * underscore to make clear that its absence of use is
 * intentional, matching the convention used elsewhere in the
 * codebase (for example, in `app.ts`'s health check handler).
 */
export const getLatestVersion = async (
  _req: Request,
  res: Response<ApiResponse<AppVersion>>
): Promise<void> => {
  // ---- 1. Query the latest release ----
  // The `findOne().sort()` form is used rather than `.find().limit(1)`
  // because Mongoose's `findOne` is the idiomatic way to express
  // "at most one document" and the return type is `Document | null`
  // rather than `Document[]`, which matches the shape of the
  // response without an intermediate array-unwrap.
  const version = await AppVersionModel.findOne().sort({
    createdAt: -1,
  });

  // ---- 2. Empty-collection case ----
  if (!version) {
    res.status(404).json({
      success: false,
      error: 'No version published yet.',
    });
    return;
  }

  // ---- 3. Respond ----
  res.status(200).json({
    success: true,
    data: version,
  });
};

// ============================================================
//  Default export
// ============================================================

export default {
  getLatestVersion,
};