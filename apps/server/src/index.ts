/**
 * Local development and long-running-server entry point for the
 * WriteSpeare backend.
 *
 * Responsibilities, in the order they execute:
 *
 *   1. Load environment variables via the `dotenv/config` side
 *      effect. This runs first because everything below reads from
 *      `process.env`.
 *
 *   2. Connect to MongoDB. If the connection cannot be
 *      established, the process exits with a non-zero code rather
 *      than serving requests against an unavailable database. A
 *      listener that accepts traffic but fails every query is
 *      worse than no listener at all — it turns a clear startup
 *      failure into a confusing runtime one.
 *
 *   3. Start the HTTP listener on the resolved port. The Express
 *      app itself is imported from `./app.js`, where all
 *      middleware and routes are configured. This file does not
 *      know what routes exist — its only job is to give them a
 *      socket to listen on.
 *
 *   4. Register the process-level signal handlers (SIGINT,
 *      SIGTERM) and the fatal-error handlers (uncaughtException,
 *      unhandledRejection). Both categories route through the
 *      same shutdown routine so the database connection is closed
 *      cleanly in every exit path.
 *
 * Why this file is not used on Vercel:
 *
 *   Vercel invokes a single exported handler function per
 *   request; it never starts a long-running HTTP listener. The
 *   serverless entry point lives in `handler/index.ts`, which
 *   imports the same Express app and hands it each incoming
 *   request. Both entry points share the app instance via the
 *   module cache, so the middleware configuration and route table
 *   are identical regardless of which one is serving.
 *
 * Why the `PORT` resolution is a function and not a constant:
 *
 *   The environment variable arrives as a string, may be absent,
 *   may be an empty string, or may contain garbage. The
 *   `noUncheckedIndexedAccess` compiler flag means
 *   `process.env['PORT']` is typed as `string | undefined`, so the
 *   resolution has to be explicit at every read. Wrapping it in a
 *   function that returns a validated `number` (or the default)
 *   keeps the rest of the file free of ad-hoc parsing.
 *
 * Why there is no top-level `await`:
 *
 *   The `startServer` function is exported and the call to it at
 *   the bottom of the file is deliberately un-awaited. Awaiting it
 *   at module scope would require the file to be an async module,
 *   which changes how the module cache behaves under some Node
 *   versions and interacts badly with the singleton pattern used
 *   by `app.ts`. The un-awaited call is fine: `startServer` handles
 *   every failure internally and only throws if `process.exit`
 *   itself fails, which is not a recoverable condition.
 */

import 'dotenv/config';

import type { Server } from 'node:http';

import app from './app.js';
import { connectDB, disconnectDB } from './features/shared/config/db.js';

// ============================================================
//  Configuration
// ============================================================

/**
 * Port the listener falls back to when the environment does not
 * provide a valid one. Five thousand is a widely used default for
 * local Node development, and it does not collide with the ports
 * the desktop app's embedded Chrome instances occupy (those start
 * at 9222 and climb from there).
 */
const DEFAULT_PORT = 5000;

/**
 * The environment name, defaulting to `'development'`.
 *
 * Read once here and referenced from every log line and branch
 * below. Using a single constant means the environment cannot be
 * logged differently from the way it is checked — a class of bug
 * that would only show up when someone wonders why production logs
 * say "development" or vice versa.
 */
const NODE_ENV = process.env['NODE_ENV'] ?? 'development';

/**
 * Resolve the listener port from the environment.
 *
 * Order of preference:
 *
 *   1. `process.env['PORT']` if it parses to a valid TCP port.
 *   2. `DEFAULT_PORT` if the variable is absent, empty, whitespace-
 *      only, non-numeric, negative, zero, or above 65535.
 *
 * The validation is deliberately strict rather than permissive. A
 * typo in `.env` that produced `PORT=50O0` (letter O) would parse
 * as `50` under a lenient `parseInt` call, silently binding the
 * server to a port nobody expects. Failing over to the default is
 * louder than that: the startup log line will show the port the
 * server actually bound to, and the discrepancy between that and
 * what the developer typed is visible at a glance.
 *
 * Only the `PORT` variable is read here. The database URI and the
 * JWT secret are validated by their own modules (`db.ts` and
 * `jwt.ts` respectively) — each module owns the validation for the
 * variables it consumes, so a missing secret fails at the JWT
 * module's load time with a message that names the variable.
 */
const resolvePort = (): number => {
  const raw = process.env['PORT'];
  if (typeof raw !== 'string') return DEFAULT_PORT;

  const trimmed = raw.trim();
  if (trimmed.length === 0) return DEFAULT_PORT;

  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_PORT;
  if (parsed <= 0 || parsed > 65535) return DEFAULT_PORT;

  return parsed;
};

// ============================================================
//  Graceful shutdown
// ============================================================

/**
 * Close the database connection and exit the process.
 *
 * Called from every terminal signal handler below. Swallows the
 * disconnect error on the way out — at this point the process is
 * terminating regardless, and there is no useful recovery from a
 * failed close. Logging the error and exiting with a non-zero
 * code would be a stronger signal, but that would also cause a
 * monitoring platform to distinguish "clean shutdown" from
 * "shutdown after a close error" for what is, from the outside,
 * the same event: the process is going down.
 *
 * The `signal` argument is included in the log so an operator
 * reading the console can tell whether the shutdown was user-
 * initiated (SIGINT from Ctrl+C), service-manager-initiated
 * (SIGTERM from a supervisor), or a crash (uncaughtException /
 * unhandledRejection).
 */
const gracefulShutdown = async (signal: string): Promise<void> => {
  console.log(`Received ${signal}. Shutting down...`);
  try {
    await disconnectDB();
    console.log('Database connection closed.');
    process.exit(0);
  } catch (error) {
    console.error('Error during shutdown:', error);
    process.exit(1);
  }
};

// ============================================================
//  Server bootstrap
// ============================================================

/**
 * Connect the database, start the listener, and install the
 * process-level handlers.
 *
 * Ordering rationale:
 *
 *   The database connection is awaited before the listener starts.
 *   A listener that accepts traffic before the database is ready
 *   would return 500s for the brief window between `app.listen()`
 *   returning and the first successful query — and a health check
 *   that happens to hit during that window would restart the
 *   process on a platform that treats a failing health check as a
 *   signal to recycle. Serializing the two eliminates the window.
 *
 *   The signal handlers are registered after the listener starts.
 *   Before that point there is no connection to close gracefully
 *   and no reason to intercept signals — the default behaviour of
 *   terminating the process is already the correct response to a
 *   SIGINT that arrives during startup.
 *
 * Returns the `http.Server` instance the caller can use to close
 * the listener from a test or from a future admin endpoint. The
 * return type is `Promise<Server>` rather than `Promise<void>`
 * because the caller may legitimately want to await shutdown, and
 * exposing the server handle costs nothing while making that
 * possible.
 *
 * Throws only if `connectDB` throws. That throw is not caught here
 * — it propagates to the caller at the bottom of the file, where
 * it is logged and converted into a `process.exit(1)`. Every other
 * failure inside the function is handled locally so the caller
 * only has to reason about one throw path.
 */
export const startServer = async (): Promise<Server> => {
  // ---- 1. Connect to the database ----
  // The `connectDB` function is idempotent, so a test that boots
  // the app more than once in the same process reuses the
  // existing connection rather than opening a second one.
  await connectDB();
  console.log('Database connected.');

  // ---- 2. Start the HTTP listener ----
  // `app.listen` returns the `http.Server` instance. The callback
  // runs once the listener is bound; the log lines inside it are
  // the first indication that the server is ready to accept
  // traffic.
  const server = app.listen(resolvePort(), () => {
    console.log(
      `Server listening on http://localhost:${resolvePort()}`
    );
    console.log(`API base:    http://localhost:${resolvePort()}/api`);
    console.log(`Health:      http://localhost:${resolvePort()}/health`);
    console.log(`Environment: ${NODE_ENV}`);
    console.log('Press Ctrl+C to stop.');
  });

  // ---- 3. Register the shutdown handlers ----
  // SIGINT: the user pressed Ctrl+C in the terminal. SIGTERM: a
  // service manager or process supervisor asked the process to
  // stop. Both route through `gracefulShutdown` so the database
  // connection is closed cleanly regardless of who initiated the
  // shutdown.
  process.on('SIGINT', () => {
    void gracefulShutdown('SIGINT');
  });

  process.on('SIGTERM', () => {
    void gracefulShutdown('SIGTERM');
  });

  // ---- 4. Register the fatal-error handlers ----
  // An uncaught exception or an unhandled promise rejection means
  // the process is in an undefined state. Node's default behaviour
  // is to print the error and exit with a non-zero code; the only
  // thing this handler adds is a clean database disconnect before
  // that exit, so a monitoring platform does not see a dangling
  // TCP socket that it has to reap.
  process.on('uncaughtException', (error: Error) => {
    console.error('Uncaught exception:', error);
    void gracefulShutdown('uncaughtException');
  });

  process.on('unhandledRejection', (reason: unknown) => {
    console.error('Unhandled rejection:', reason);
    void gracefulShutdown('unhandledRejection');
  });

  return server;
};

// ============================================================
//  Bootstrap
// ============================================================

/**
 * Boot the server immediately when this module is imported.
 *
 * The call is un-awaited because `startServer` handles every
 * internal failure except `process.exit` itself. The `.catch` is
 * a defensive net against an unexpected synchronous throw from
 * `resolvePort` (which is total, so it cannot throw) or from
 * `app.listen` (which only throws if the port is invalid, but
 * `resolvePort` guarantees a valid port). If the catch ever runs,
 * the input is a bug worth surfacing, not a state worth
 * recovering from.
 *
 * The log line inside the catch names the file so the failure is
 * traceable without a stack dive.
 */
void startServer().catch((error: unknown) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});

// ============================================================
//  Default export
// ============================================================

export default {
  startServer,
};