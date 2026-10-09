/**
 * portAllocator — Chrome DevTools Protocol debug-port allocation.
 *
 * Every Chrome instance the WriteSpeare pipeline drives over CDP
 * needs its own dedicated debug port. Two Chrome instances cannot
 * share a port — the second one fails to open its debug server
 * and the pipeline loses control of it. The port therefore has to
 * be unique per running instance, freed when the instance is
 * killed, and re-usable by the next instance that needs one.
 *
 * This module owns that allocation. It is the single source of
 * truth for "which ports are currently in use" in the main
 * process.
 *
 * The problem it solves:
 *
 *   The plan's user journey allows two topics to research in
 *   parallel — a user who starts a second topic while the first is
 *   still running gets two concurrent Chrome instances. Each one
 *   needs a port, and neither can know in advance which port the
 *   other chose. A naive "just use 9222" approach would produce
 *   two Chrome launches competing for the same port: one wins, one
 *   silently hands off to the winner, and the second Chrome's
 *   automation loses its debug connection. The pipeline would
 *   stall with no clear error.
 *
 *   The allocator prevents that by handing out a distinct port to
 *   each caller until the caller explicitly releases it. Ports are
 *   held for the entire lifetime of a Chrome instance — from the
 *   moment the caller asks for one until the moment the Chrome
 *   process is killed — so two concurrent instances always get two
 *   distinct ports.
 *
 * The allocation strategy:
 *
 *   Ports are drawn from the range [CHROME_BASE_PORT,
 *   CHROME_BASE_PORT + PORT_RANGE_SIZE). The allocator scans the
 *   range from the base upward and returns the first port that is
 *   not currently in use. This is the standard "find the first free
 *   slot in a fixed range" algorithm — cheap, deterministic (a
 *   fresh allocation returns the base port when nothing is held),
 *   and simple to reason about.
 *
 *   If every port in the range is in use, the allocator throws.
 *   The alternative — extending the range indefinitely — would
 *   hide a leak: a caller that failed to release its port would
 *   accumulate ports forever, and the failure would surface not as
 *   a clear error but as Chrome instances launching on ports far
 *   outside anything the firewall or a user's mental model
 *   expects. A bounded range plus a throw on exhaustion makes the
 *   leak visible the moment it happens.
 *
 *   The range size (PORT_RANGE_SIZE) is chosen to be generously
 *   larger than the number of concurrent Chrome instances the plan
 *   ever contemplates. The plan's user journey shows one or two
 *   parallel topics; a hundred-port range leaves two orders of
 *   magnitude of headroom.
 *
 * Port re-use:
 *
 *   A released port is immediately available for the next
 *   allocation. The allocator does NOT wait for the operating
 *   system's TIME_WAIT state to expire before re-using a port,
 *   because a Chrome debug port is a listening socket on a live
 *   process — the OS does not put it into TIME_WAIT on the
 *   process's exit. TIME_WAIT applies to outbound connections
 *   that closed, not to listening sockets. A fresh Chrome process
 *   can bind to the same port immediately after the previous one
 *   exits, and the allocator's behavior (return the port as soon
 *   as the caller releases it) matches that reality.
 *
 * Thread safety:
 *
 *   The allocator is used exclusively in the main process, which
 *   is single-threaded in Node's event-loop model. Two `await`ed
 *   call sequences interleave at their `await` points, but the
 *   `allocatePort` and `releasePort` functions are both
 *   synchronous — no `await`, no callback, no microtask boundary.
 *   That means the allocator's state cannot be corrupted by two
 *   concurrent callers: each function runs to completion before
 *   the next one starts. No locking is needed.
 *
 * What this module does NOT do:
 *
 *   - It does not launch Chrome. The `chromeLauncher.ts` module
 *     (a sibling in the plan's tree) is responsible for that; it
 *     calls `allocatePort()` before launching and `releasePort()`
 *     after killing the Chrome process.
 *
 *   - It does not track which port belongs to which Chrome
 *     instance. The allocator knows only "in use" or "not in use";
 *     the caller that received the port remembers what it launched
 *     on it. This keeps the allocator's state minimal and makes it
 *     trivially replaceable — a future session that wants to add
 *     per-port metadata would extend the caller, not this module.
 *
 *   - It does not probe the OS to check whether a port is
 *     physically free. A port that Chrome has bound on a live
 *     process will not be returned by `allocatePort` because it
 *     is marked in use; a port that an unrelated process on the
 *     user's machine has bound is outside this module's concern
 *     (the range 9222+ is not a well-known port range that other
 *     software typically uses). If Chrome's launch fails because
 *     its debug port is occupied by something else, the failure
 *     surfaces in `chromeLauncher.ts`, and the caller's error path
 *     is what recovers.
 *
 *   - It does not persist allocations across app restarts. Ports
 *     are process-local. When the app exits, every Chrome instance
 *     it spawned is killed and every port is freed. A fresh launch
 *     starts with an empty allocation set.
 */

// =============================================================================
//  Constants
// =============================================================================

/**
 * The first port the allocator will hand out, and the lowest port
 * in the allocation range.
 *
 * 9222 is Chrome's own default remote-debugging port — the port a
 * developer gets when they launch Chrome with
 * `--remote-debugging-port=9222` and no other value. Choosing it
 * as the base for WriteSpeare means:
 *
 *   1. A developer who manually starts Chrome on 9222 and then
 *      runs the app can be told "connect to port 9222" without a
 *      translation step.
 *
 *   2. The Python side's `core/browser.py` declares the same
 *      default (`DEFAULT_DEBUG_PORT = 9222`). A caller that does
 *      not specify a port on the Python side gets the same
 *      behavior as a caller that asks the allocator for a port
 *      and gets 9222.
 *
 *   3. The port is outside the well-known range (0–1023), so no
 *      privileged access is required to bind it.
 */
export const CHROME_BASE_PORT = 9222;

/**
 * The number of ports in the allocation range, starting at
 * `CHROME_BASE_PORT`.
 *
 * The range is `[CHROME_BASE_PORT, CHROME_BASE_PORT +
 * PORT_RANGE_SIZE)` — one hundred ports, 9222 through 9321. This
 * is vastly larger than the number of concurrent Chrome instances
 * the plan contemplates (one or two in the common case), so
 * exhaustion of the range indicates a bug — a caller that never
 * released a port — rather than a legitimate capacity limit.
 *
 * The bound exists so that a leak surfaces as a clear error
 * (`throw` in `allocatePort`) rather than as a slow drift into
 * unusable port numbers. See the file header for the full
 * rationale.
 */
export const PORT_RANGE_SIZE = 100;

/**
 * The highest port in the allocation range, inclusive.
 *
 * Derived from the two constants above so that changing
 * `PORT_RANGE_SIZE` propagates correctly without a second edit.
 *
 * The `- 1` is what makes the value inclusive: with
 * `CHROME_BASE_PORT = 9222` and `PORT_RANGE_SIZE = 100`, the range
 * is `[9222, 9321]` — one hundred distinct port numbers, exactly
 * matching `PORT_RANGE_SIZE`.
 *
 * Module-private — a caller that wants the range's bounds should
 * compute them from the two exported constants. Not re-exported so
 * that a future change to the range size does not require auditing
 * external call sites.
 */
const MAX_PORT = CHROME_BASE_PORT + PORT_RANGE_SIZE - 1;

// =============================================================================
//  Module state
// =============================================================================

/**
 * The set of ports currently held by callers.
 *
 * A port that has been returned by `allocatePort` and not yet
 * released via `releasePort` is a member of this set. The set is
 * the allocator's single piece of mutable state — the entire
 * mechanism is "ask the set what is free, add on allocate, remove
 * on release".
 *
 * A `Set<number>` rather than a `boolean[]` sized to the range:
 * the set grows to exactly the size of the concurrent allocations
 * (one to three elements in practice) and its membership test is
 * O(1). An array indexed by `port - CHROME_BASE_PORT` would
 * allocate the full one-hundred-element backing store on first use
 * and offer no advantage over the set for the sizes involved.
 *
 * Not exported. A caller that needs to inspect the current
 * allocation state uses `getInUsePorts()`, which returns a
 * snapshot copy — see that function's docstring for why the copy
 * matters.
 */
const inUsePorts: Set<number> = new Set<number>();

// =============================================================================
//  Public API — allocation
// =============================================================================

/**
 * Reserve a port for a Chrome instance and return its number.
 *
 * The port is guaranteed to be unused by any other caller of this
 * module at the moment of return — the allocator scans for the
 * first free slot and marks it in use before returning. A
 * subsequent call returns a DIFFERENT port (until the first is
 * released), so two concurrent Chrome launches always get two
 * distinct ports.
 *
 * Throws if every port in the range is currently in use. See the
 * file header for why throwing is the correct response to
 * exhaustion (it surfaces a leak as a clear error) rather than
 * silently extending the range.
 *
 * Synchronous — no `await`, no callback. The caller can call this
 * from any code path, including a top-level statement or a
 * non-async function.
 *
 * @returns The allocated port number, in the range
 *          `[CHROME_BASE_PORT, CHROME_BASE_PORT + PORT_RANGE_SIZE)`.
 * @throws  `Error` if every port in the range is in use.
 */
export const allocatePort = (): number => {
  // Scan from the base upward. The loop is bounded by
  // `PORT_RANGE_SIZE` iterations — if no free port is found in
  // that many tries, every port in the range is held.
  for (let i = 0; i < PORT_RANGE_SIZE; i += 1) {
    const candidate = CHROME_BASE_PORT + i;
    if (!inUsePorts.has(candidate)) {
      inUsePorts.add(candidate);
      return candidate;
    }
  }

  throw new Error(
    `portAllocator: no free port in the range ` +
      `[${CHROME_BASE_PORT}, ${MAX_PORT}]. ` +
      `${inUsePorts.size} port(s) in use. ` +
      `This usually indicates a caller that failed to release a port ` +
      `after killing its Chrome instance.`
  );
};

/**
 * Release a port back to the pool.
 *
 * After this call, the port is available for the next allocation.
 * The caller is expected to call this ONLY after the Chrome
 * process bound to the port has exited — the allocator does not
 * verify that, because it has no way to (it does not hold a
 * reference to any Chrome process, by design).
 *
 * Releasing a port that was never allocated, or that has already
 * been released, is a no-op. The alternative — throwing — would
 * create a footgun where a cleanup path that runs on both success
 * and failure has to track whether it has already released. A
 * `Set.delete` that returns `false` for a not-present value is
 * the correct semantic: the caller's intent ("this port should no
 * longer be held") is satisfied either way.
 *
 * Synchronous. Safe to call from any context.
 *
 * @param port - The port number previously returned by
 *               `allocatePort`. A port outside the allocation
 *               range is silently ignored — the same no-op
 *               semantic as releasing a port that was never
 *               allocated.
 */
export const releasePort = (port: number): void => {
  inUsePorts.delete(port);
};

/**
 * Release every port currently held.
 *
 * Intended for app-shutdown cleanup: when the app exits and the
 * `before-quit` handler has killed every Chrome instance, the
 * allocator's state is reset to empty so that a subsequent
 * allocation (in the unlikely event one happens during shutdown)
 * starts from a clean slate.
 *
 * Not intended as a per-operation cleanup. A caller that wants to
 * free a single port uses `releasePort`; calling `releaseAllPorts`
 * after an operation would free ports held by OTHER callers, which
 * is exactly the bug the allocator exists to prevent.
 *
 * Also useful in tests: a test that exercises the allocator can
 * call this in its `beforeEach` to guarantee a known starting
 * state without needing a fresh module instance.
 *
 * Synchronous. Idempotent — calling it when nothing is held is a
 * no-op.
 */
export const releaseAllPorts = (): void => {
  inUsePorts.clear();
};

// =============================================================================
//  Public API — introspection
// =============================================================================

/**
 * Return the set of ports currently in use.
 *
 * Returns a fresh `readonly number[]` on every call — a snapshot,
 * not a live view. The caller cannot mutate the allocator's
 * internal state by mutating the returned array, and the returned
 * array does not change if the allocator's state changes after
 * the call. Both properties are what a caller wants when
 * inspecting state for a log line or a test assertion.
 *
 * The array is sorted ascending so that a log line reading
 * "ports in use: 9222, 9224" is deterministic regardless of the
 * order in which the ports were allocated. The sort is a small
 * extra cost (at most one hundred elements) and pays for itself
 * the first time a developer reads the output.
 *
 * Exported for tests and for a future diagnostics endpoint. The
 * production code paths in the pipeline do not call this — they
 * hold references to their own allocated ports and do not need to
 * query the allocator.
 */
export const getInUsePorts = (): readonly number[] => {
  return Array.from(inUsePorts).sort((a, b) => a - b);
};