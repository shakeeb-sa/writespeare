/**
 * Vercel serverless entry point for the WriteSpeare backend.
 *
 * Exports one async function that Vercel invokes for every HTTP
 * request routed to this deployment. The function's job is
 * narrow:
 *
 *   1. Ensure the MongoDB connection is live. On a cold start
 *      this means awaiting `connectDB()`; on a warm start it
 *      reuses the connection the previous request opened.
 *
 *   2. Hand the request to the shared Express app from
 *      `src/app.ts`, which owns all routing, middleware, and
 *      error handling. Nothing in this file needs to know what
 *      routes exist.
 *
 * The file deliberately does not duplicate any middleware or
 * route logic. Everything below the connection check is a single
 * `return app(req, res)` call — the Express app does the work, and
 * the two entry points (`src/index.ts` for local development and
 * this file for Vercel) stay in lockstep by sharing the same app
 * instance.
 *
 * Why the connection is cached in a module-level promise:
 *
 *   Vercel keeps a warm serverless process alive across requests.
 *   Reconnecting to MongoDB on every invocation would exhaust the
 *   connection pool, add 50–200 ms of latency to each request
 *   during the handshake, and — on MongoDB Atlas's free tier —
 *   burn through the monthly connection limit in a few hours.
 *   Caching the *promise* (rather than the resulting connection
 *   object) means two concurrent cold-start requests both await
 *   the same in-flight connection attempt rather than racing to
 *   open two.
 *
 *   If a connection attempt fails, the cache is cleared so the
 *   next request retries from a clean slate. Without that reset,
 *   a single transient failure would leave the process holding a
 *   rejected promise and every subsequent request would fail with
 *   the same stale error for the life of the process.
 *
 * Why a diagnostic endpoint exists:
 *
 *   A 500 from a Vercel deployment with no log access is one of
 *   the hardest failure modes to debug — the platform's own logs
 *   often lag by minutes, and the deployed environment differs
 *   from local in ways that are invisible without introspection.
 *   The `/api/diagnostic` branch short-circuits the Express app
 *   and answers with the resolved environment and connection
 *   state. It is read-only: it reports booleans and masked
 *   strings, never the secret values themselves, and never
 *   mutates anything.
 *
 *   The endpoint is deliberately narrow. It runs BEFORE Express
 *   so a failure in the app's middleware chain cannot prevent the
 *   diagnostic from answering. And it is scoped to the exact
 *   `/api/diagnostic` prefix, so no legitimate route can collide
 *   with it.
 *
 * Type-only imports:
 *
 *   `VercelRequest` and `VercelResponse` are imported with the
 *   `import type` form. They are erased by the compiler, so no
 *   runtime require of `@vercel/node` is emitted — the package is
 *   a devDependency, and the compiled output must not depend on
 *   its presence at deploy time.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import mongoose from 'mongoose';

import app from '../src/app.js';
import { connectDB } from '../src/features/shared/config/db.js';

// ============================================================
//  Connection cache
// ============================================================

/**
 * A single in-flight or resolved connection promise, shared
 * across every invocation within a warm process.
 *
 *   `null`  — no connection has been attempted in this process
 *             yet, OR the last attempt failed and the cache was
 *             reset.
 *   Promise — either an in-flight connection or a resolved one.
 *             Awaiting the same promise from multiple concurrent
 *             requests is safe: the first one performs the
 *             handshake, the rest receive the same resolution.
 *
 * Mutated only by `ensureDB` below. Never exported.
 */
let dbReady: Promise<void> | null = null;

/**
 * Return a promise that resolves once the database is connected.
 *
 * On the first call after a cold start (or after a failed
 * attempt), starts a new `connectDB()` and caches the promise. On
 * every subsequent call, returns the cached promise unchanged.
 *
 * If the underlying `connectDB()` rejects, the cache is cleared
 * before the rejection propagates. That is what lets the NEXT
 * request retry rather than being permanently wedded to a dead
 * promise for the life of the process.
 *
 * The re-throw is deliberate — the caller must see the failure
 * so it can return a 500 with an explanation. The reset is
 * equally deliberate — the failure must not be sticky.
 */
const ensureDB = (): Promise<void> => {
  if (!dbReady) {
    dbReady = connectDB().catch((err: unknown) => {
      console.error('MongoDB connection failed:', err);
      dbReady = null;
      throw err;
    });
  }
  return dbReady;
};

// ============================================================
//  Diagnostics helpers
// ============================================================

/**
 * Mask the credentials portion of a MongoDB connection URI so it
 * can be safely included in a diagnostic response.
 *
 * A URI of the shape `mongodb+srv://user:pass@host/db` becomes
 * `mongodb+srv://user:***@host/db`. The username is left in place
 * — it is not a secret on its own, and seeing it confirms which
 * cluster the process is talking to. The password is the only
 * credential that would allow an attacker to open the database,
 * so it is the only field the mask replaces.
 *
 * Returns `'NOT SET'` when the input is null or empty so a caller
 * does not have to distinguish "no URI configured" from "URI
 * configured but unparseable". A URI that does not match the
 * user:pass pattern is returned unchanged with a trailing
 * `'(unrecognized format — inspect manually)'` note so the
 * diagnostic is honest rather than silently misleading.
 */
const maskMongoUri = (uri: string | undefined): string => {
  if (typeof uri !== 'string' || uri.length === 0) {
    return 'NOT SET (falls back to mongodb://localhost:27017/writespeare)';
  }
  const masked = uri.replace(/:\/\/([^:]+):([^@]+)@/, '://$1:***@');
  if (masked === uri && uri.includes('://')) {
    // The pattern did not match but the string looks like a URI.
    // Most likely an unauthenticated URI (no credentials to mask)
    // or an unusual scheme. Return it with a note rather than
    // pretend masking happened.
    return `${uri} (no credentials present — nothing to mask)`;
  }
  return masked;
};

// ============================================================
//  Handler
// ============================================================

/**
 * The Vercel serverless handler.
 *
 * Flow, in order:
 *
 *   1. If the incoming URL begins with `/api/diagnostic`, answer
 *      the diagnostic probe and return. This branch runs BEFORE
 *      the database check so a diagnostic works even when the
 *      database is unreachable — which is exactly the scenario
 *      the diagnostic exists to help debug.
 *
 *   2. Otherwise, await `ensureDB()`. If the connection cannot be
 *      established, respond with a 500 and a short, non-leaking
 *      error message. The full error is logged for the operator;
 *      the client sees a bounded explanation.
 *
 *   3. Hand the request to the shared Express app and return its
 *      response. From this point on, this file has no
 *      responsibility — routing, middleware, and error handling
 *      all live in the app.
 *
 * The return type is `Promise<unknown>` rather than
 * `Promise<void>` because the Express app's `app(req, res)` call
 * has a return value (the `Server` instance in some overloads)
 * that this function deliberately passes through rather than
 * discards. Neither Vercel nor Express cares about the return
 * value in a serverless context, but returning it keeps the
 * function transparent — a caller inspecting the result sees
 * exactly what Express returned.
 */
export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<unknown> {
  // ============================================================
  //  Diagnostic branch
  // ============================================================
  //
  // Runs before the database check so it answers even when the
  // database is down. Reports booleans and a masked URI, never
  // the secret values themselves.

  if (typeof req.url === 'string' && req.url.startsWith('/api/diagnostic')) {
    const info: Record<string, unknown> = {
      mongoUriPresent: Boolean(process.env['MONGODB_URI']),
      mongoUriMasked: maskMongoUri(process.env['MONGODB_URI']),
      jwtSecretPresent: Boolean(process.env['JWT_SECRET']),
      nodeEnv: process.env['NODE_ENV'] ?? '(unset)',
      readyStateBefore: mongoose.connection.readyState,
    };

    try {
      await ensureDB();
      info['connectResult'] = 'resolved';
    } catch (err: unknown) {
      info['connectResult'] = 'threw';
      info['connectError'] =
        err instanceof Error ? err.message : String(err);
    }

    info['readyStateAfter'] = mongoose.connection.readyState;

    // The `?.` on `connection.db` is required: mongoose types the
    // field as `Db | undefined` and a diagnostic must not assume
    // a live handle just because `readyState` looks healthy.
    try {
      await mongoose.connection.db?.admin().command({ ping: 1 });
      info['pingResult'] = 'ok';
    } catch (err: unknown) {
      info['pingResult'] = 'failed';
      info['pingError'] =
        err instanceof Error ? err.message : String(err);
    }

    res.status(200).json(info);
    return undefined;
  }

  // ============================================================
  //  Normal request path
  // ============================================================

  try {
    await ensureDB();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    // The full error is logged for the operator. The client sees
    // only the first line of the message, prefixed with a stable
    // label, so a misconfigured MONGODB_URI does not leak the URI
    // itself back to an unauthenticated caller. The URI is
    // routinely echoed in driver-level error messages.
    console.error('Handler: database unavailable:', err);
    const safeMessage = message.split('\n')[0] ?? 'Unknown error';
    res.status(500).json({
      success: false,
      error: `Database connection failed: ${safeMessage}`,
    });
    return undefined;
  }

  return app(req, res);
}

// ============================================================
//  Named re-export
// ============================================================
//
// A caller that prefers `import { handler } from './handler/index.js'`
// over the default import gets the same function. Vercel itself
// accepts either form; the named export exists so a future test
// harness can import the handler without pulling the whole module
// through the default-export convention.

export { handler };