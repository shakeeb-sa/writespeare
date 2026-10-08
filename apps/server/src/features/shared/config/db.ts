/**
 * MongoDB connection module.
 *
 * Exposes a process-wide singleton connection to the WriteSpeare
 * database, shared by both the local Node server entry point and
 * the Vercel serverless entry point. The singleton contract is
 * important because a serverless platform can invoke the handler
 * many times per process — reconnecting on every invocation would
 * exhaust the connection pool and add hundreds of milliseconds of
 * latency to each request.
 *
 * The connection URI is read lazily, at the moment `connectDB()`
 * is first called rather than at module load. This is deliberate:
 * environment variables are populated by `dotenv/config` before
 * the server boots, but ES module imports are evaluated in
 * declaration order, so a module-level read of `process.env` would
 * race the dotenv side effect if the import graph is ever
 * reorganised. Reading on demand removes that class of bug
 * entirely.
 */

import mongoose from 'mongoose';

// ============================================================
//  Configuration
// ============================================================

/**
 * Fallback URI used when `MONGODB_URI` is absent from the
 * environment. This is the correct default for a developer running
 * a local `mongod` instance; production deployments must set the
 * env var explicitly and will fail loudly at startup if they do
 * not, because the fallback points at a database that does not
 * exist on the deployed machine.
 */
const DEFAULT_MONGODB_URI = 'mongodb://localhost:27017/writespeare';

/**
 * Connection options applied to every `mongoose.connect()` call.
 *
 * Each option is chosen for a specific reason:
 *
 *   autoIndex — builds schema indexes automatically on first
 *               connect. Safe for this application because the
 *               collections are small and index creation is a
 *               one-time cost. A larger deployment would flip
 *               this off and build indexes out of band.
 *
 *   maxPoolSize — upper bound on concurrent sockets to MongoDB.
 *                 Ten is well above the concurrent-query ceiling
 *                 of this application; a higher value would let a
 *                 single runaway request starve the pool without
 *                 buying any throughput.
 *
 *   serverSelectionTimeoutMS — how long the driver waits for a
 *                 reachable primary before giving up. Five seconds
 *                 is short enough that a misconfigured URI fails
 *                 fast during startup, long enough to survive a
 *                 brief network blip on the way up.
 *
 *   socketTimeoutMS — per-socket inactivity timeout. Forty-five
 *                 seconds is the driver default and is generous
 *                 enough that a slow aggregate query does not get
 *                 killed mid-flight.
 *
 *   family — pin the driver to IPv4. Some Node builds resolve
 *                 `localhost` to `::1` first, and the default
 *                 `mongod` listener binds only to IPv4. Pinning
 *                 to 4 avoids the resolution-order surprise on
 *                 those machines.
 */
const MONGOOSE_OPTIONS: mongoose.ConnectOptions = {
  autoIndex: true,
  maxPoolSize: 10,
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS: 45000,
  family: 4,
};

// ============================================================
//  Internal state
// ============================================================

/**
 * Tracks whether the module believes the connection is live.
 *
 * Kept separate from `mongoose.connection.readyState` because the
 * readyState reflects the driver's view, not ours — it flips to
 * `disconnected` on transient errors that our reconnect logic
 * should retry transparently, and it can lag a manual
 * `disconnect()` by a tick. This boolean is the authoritative
 * answer to "did WE open a connection that WE are responsible
 * for closing?".
 *
 * Mutated only by `connectDB`, `disconnectDB`, and the driver's
 * own lifecycle event handlers below. Not exported — callers that
 * need to know the connection state use `isDBConnected()`, which
 * consults the driver directly and therefore cannot be fooled by
 * this flag drifting out of sync.
 */
let isConnected = false;

// ============================================================
//  Internal helpers
// ============================================================

/**
 * Resolve the connection URI to use for this process.
 *
 * Returns the `MONGODB_URI` environment variable if it is a
 * non-empty, non-whitespace string. Otherwise returns the
 * development fallback. The whitespace check guards against a
 * misconfigured `.env` file where the key exists but the value is
 * empty or a placeholder, which would otherwise cause the driver
 * to attempt a connection to an empty hostname.
 */
const resolveMongoUri = (): string => {
  const fromEnv = process.env['MONGODB_URI'];
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) {
    return fromEnv;
  }
  return DEFAULT_MONGODB_URI;
};

// ============================================================
//  Public API
// ============================================================

/**
 * Establish the process-wide MongoDB connection.
 *
 * Idempotent: calling this a second time on a live connection is
 * a no-op that returns immediately. Calling it after a failed
 * previous attempt retries from a clean state — the driver is
 * disconnected first so the pool is rebuilt rather than reused
 * with a corrupted handshake.
 *
 * Throws on connection failure. Callers at the top of the app
 * (`src/index.ts` and `handler/index.ts`) treat that as fatal,
 * log the error, and exit with a non-zero code rather than
 * serving requests against an unavailable database.
 */
export const connectDB = async (): Promise<void> => {
  if (isConnected) {
    console.log('MongoDB: already connected, reusing existing connection');
    return;
  }

  // The driver may hold a half-open connection from a previous
  // attempt that failed after the TCP handshake but before the
  // driver marked itself ready. Disconnect first so the next
  // `connect()` starts from a truly blank slate.
  if (mongoose.connection.readyState !== 0) {
    console.log('MongoDB: stale connection state detected, resetting');
    await mongoose.disconnect();
  }

  try {
    console.log('MongoDB: connecting...');
    await mongoose.connect(resolveMongoUri(), MONGOOSE_OPTIONS);
    isConnected = true;
    console.log('MongoDB: connected');
  } catch (error) {
    console.error('MongoDB: connection failed:', error);
    throw error;
  }
};

/**
 * Close the process-wide MongoDB connection.
 *
 * Idempotent: calling this when no connection is open is a no-op
 * that logs and returns. Throws on a disconnect failure — that
 * path indicates the socket is in an unrecoverable state and the
 * caller should treat it the same as a failed connect.
 *
 * Used by the shutdown path (see the signal handlers at the
 * bottom of this file) and by tests that need to reset connection
 * state between cases.
 */
export const disconnectDB = async (): Promise<void> => {
  if (!isConnected) {
    console.log('MongoDB: not connected, skipping disconnect');
    return;
  }

  try {
    await mongoose.disconnect();
    isConnected = false;
    console.log('MongoDB: disconnected');
  } catch (error) {
    console.error('MongoDB: disconnect failed:', error);
    throw error;
  }
};

/**
 * Report whether the driver currently holds an open connection.
 *
 * Reads `mongoose.connection.readyState` directly rather than the
 * module-level `isConnected` flag. This is intentional — the
 * readyState is the driver's own truth, and consumers that use
 * this for a health check or a route guard need the driver's
 * answer, not ours. A readyState of `1` means "connected",
 * anything else means "not usable right now".
 */
export const isDBConnected = (): boolean => {
  return mongoose.connection.readyState === 1;
};

// ============================================================
//  Connection lifecycle events
// ============================================================
//
// These handlers fire on the driver's own lifecycle transitions,
// not on our API calls. They exist to:
//
//   1. Log every transition, so a disconnect in production is
//      visible in the server log without instrumenting call sites.
//
//   2. Force `isConnected` to `false` whenever the driver reports
//      an error or a disconnection. Without this, a crashed socket
//      would leave the module believing it is still connected and
//      the next `connectDB()` call would return early instead of
//      reopening the pool.

mongoose.connection.on('connected', () => {
  console.log('MongoDB: connected event');
});

mongoose.connection.on('error', (err: Error) => {
  console.error('MongoDB: connection error event:', err);
  isConnected = false;
});

mongoose.connection.on('disconnected', () => {
  console.warn('MongoDB: disconnected event');
  isConnected = false;
});

// ============================================================
//  Graceful shutdown
// ============================================================
//
// Registering signal handlers on a module import is safe under
// Node's module cache: the top-level statements run exactly once
// per process, so the handlers are not duplicated on subsequent
// imports. In a serverless environment the platform terminates
// the process without sending SIGTERM, so these handlers are
// inert there — they exist for the local development and
// long-running-server cases, where Ctrl+C or a service manager
// sends the signal before killing the process.

/**
 * Close the connection and exit. Shared body for both signal
 * handlers so the shutdown logic lives in one place. Swallows
 * disconnect errors on the way out — a failure to close cleanly
 * should not prevent the process from exiting, and there is no
 * useful recovery at that point.
 */
const shutdown = async (signal: string): Promise<void> => {
  console.log(`MongoDB: received ${signal}, closing connection`);
  try {
    await disconnectDB();
  } catch {
    // swallow — the process is going down regardless
  }
  process.exit(0);
};

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});

// ============================================================
//  Raw access re-exports
// ============================================================
//
// Exposed for the two categories of consumer that legitimately
// need more than the function surface:
//
//   - Health checks that want to inspect `connection.readyState`
//     directly rather than via the boolean probe.
//
//   - Tests that need to reset connection state or inspect the
//     underlying driver.

export const connection = mongoose.connection;
export { mongoose };

// ============================================================
//  Default export
// ============================================================

export default {
  connectDB,
  disconnectDB,
  isDBConnected,
  connection,
  mongoose,
};