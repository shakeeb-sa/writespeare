/**
 * Express application factory for the WriteSpeare backend.
 *
 * Creates and configures the Express instance that serves every
 * HTTP request. The factory pattern (rather than a module-level
 * singleton alone) exists so that tests can build a fresh app with
 * different middleware configuration without tearing down a shared
 * instance, and so the serverless entry point and the local
 * development entry point can each own their own app if they ever
 * need to.
 *
 * Middleware order matters and is not alphabetical:
 *
 *   1. helmet          — sets security headers on every response.
 *                        Runs first so even an error response
 *                        carries them.
 *   2. cors            — governs cross-origin access. In
 *                        development, the request origin is
 *                        reflected (any origin allowed); in
 *                        production, CORS is disabled entirely
 *                        because the only client is the desktop
 *                        app's main process, which is Node — no
 *                        browser origin is enforced there anyway.
 *   3. body parsers    — JSON and URL-encoded. Registered before
 *                        any route so a controller never has to
 *                        think about raw request bodies.
 *   4. morgan          — HTTP request logging, development only.
 *                        Suppressed in production because the
 *                        hosting platform's own log drain already
 *                        captures request metadata, and duplicating
 *                        it wastes the function's stdout budget.
 *   5. routes          — /health, then the API routers.
 *   6. 404 handler     — runs when no route matched. Registered
 *                        after every real route so it only fires on
 *                        unmatched paths.
 *   7. error handler   — four-parameter function Express recognises
 *                        as the terminal error handler. Must be
 *                        registered last or it never fires.
 *
 * Route mounting is deliberately incremental. The plan builds the
 * backend in numbered sessions — Session 1 is auth only; Session 2
 * adds topics, documents, articles, reports, settings, and version;
 * Session 3 adds users and admin. Mounting a router whose module
 * has no default export yet would throw at startup, so this file
 * mounts exactly the routers that exist and grows by one
 * `app.use(...)` line per session.
 *
 * Env vars are loaded here via `import 'dotenv/config'` as a
 * defensive side effect. The real entry points (src/index.ts and
 * handler/index.ts) also load dotenv, and because ESM evaluates
 * imports in declaration order the side effect runs before any
 * code in this file. The duplicate import is idempotent and means
 * this module is safe to import from a test harness or a script
 * that forgot to load dotenv itself.
 */

import 'dotenv/config';

import express, { type Express, type Request, type Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';

import authRoutes from './features/auth/routes/authRoutes.js';
import {
  errorHandler,
  notFoundHandler,
} from './features/shared/middleware/errorHandler.js';

// ============================================================
//  Constants
// ============================================================

/**
 * Maximum request body size accepted by the JSON and URL-encoded
 * parsers.
 *
 * The largest payload this API accepts is an article body or a
 * document's content field — both in the tens of kilobytes in the
 * common case. One megabyte is a generous ceiling that still
 * prevents a malicious client from streaming gigabytes into a
 * single request and exhausting the process's memory.
 */
const REQUEST_BODY_LIMIT = '1mb';

// ============================================================
//  App factory
// ============================================================

/**
 * Build and return a fully configured Express application.
 *
 * Does not start an HTTP listener. That is the caller's job — see
 * `src/index.ts` for the local development entry point and
 * `handler/index.ts` for the serverless one.
 */
export const createApp = (): Express => {
  const app = express();

  // ---- 1. Security headers ----
  // helmet sets a baseline of HTTP response headers (CSP,
  // X-Content-Type-Options, HSTS, and others) on every response.
  // Applied before any route so even an error response carries
  // them — a 500 is still a response, and a browser rendering the
  // error body benefits from the same protections a success body
  // would.
  app.use(helmet());

  // ---- 2. Cross-origin resource sharing ----
  // In development, reflect the request origin so a browser-based
  // test client can hit the API without CORS friction. In
  // production, CORS is disabled entirely because the only caller
  // is the desktop app's main process, which runs in Node and does
  // not enforce CORS. `credentials` is false in both cases: this
  // API authenticates with bearer tokens in the Authorization
  // header, not with cookies, so the browser's credential-handling
  // rules never apply.
  app.use(
    cors({
      origin: process.env['NODE_ENV'] === 'production' ? false : true,
      credentials: false,
    })
  );

  // ---- 3. Body parsers ----
  // JSON is the wire format for every request body in this API.
  // The URL-encoded parser is included because some HTTP clients
  // (and every HTML form) default to that encoding, and it costs
  // nothing to support. Both are bounded at REQUEST_BODY_LIMIT.
  app.use(express.json({ limit: REQUEST_BODY_LIMIT }));
  app.use(express.urlencoded({ extended: true, limit: REQUEST_BODY_LIMIT }));

  // ---- 4. Request logging (development only) ----
  // The 'dev' format is compact and colour-coded, which is what a
  // developer wants while iterating. Production logging is handled
  // by the hosting platform's log drain, so emitting our own would
  // double the stdout volume without adding signal.
  if (process.env['NODE_ENV'] === 'development') {
    app.use(morgan('dev'));
  }

  // ---- 5a. Health check ----
  // A trivial, unauthenticated endpoint that a load balancer, a
  // health monitor, or a curious developer can hit to confirm the
  // process is alive and serving requests. It deliberately does
  // NOT check the database: a database health check here would
  // turn a transient DB blip into a health-check failure, which on
  // many platforms triggers a process restart — the opposite of
  // what a transient blip needs.
  app.get('/health', (_req: Request, res: Response) => {
    res.status(200).json({
      status: 'ok',
      timestamp: new Date().toISOString(),
    });
  });

  // ---- 5b. API routes ----
  // Auth is the only feature whose router exists at this point in
  // the build. Later sessions add the remaining mounts:
  // users, topics, documents, articles, reports, settings, version,
  // and admin. Each is a one-line addition in its session; none of
  // them can be mounted now because their route modules have no
  // default export yet, and importing one would throw at startup.
  app.use('/api/auth', authRoutes);

  // ---- 6. 404 handler ----
  // Runs when no route above matched. Registered after every real
  // route so it only fires on unmatched paths.
  app.use(notFoundHandler);

  // ---- 7. Error handler ----
  // The four-parameter signature is what Express uses to identify
  // this as the terminal error handler. Must be registered last or
  // it never fires.
  app.use(errorHandler);

  return app;
};

// ============================================================
//  Singleton instance
// ============================================================

/**
 * The app instance used by both entry points.
 *
 * Built once at module load. `src/index.ts` imports it to start
 * the local HTTP listener; `handler/index.ts` imports it as the
 * Vercel serverless handler. Tests that need a fresh app should
 * call `createApp()` directly rather than importing this singleton
 * — the factory exists precisely so they can.
 */
const app = createApp();

export default app;