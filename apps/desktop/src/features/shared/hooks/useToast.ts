/**
 * Re-export shim for the `useToast` hook.
 *
 * The hook's implementation lives in `../components/Toast.tsx`,
 * alongside the `ToastProvider` React context it consumes. The
 * provider and the hook are two halves of one contract — the
 * provider creates the context, the hook reads it — and keeping
 * them in the same file makes that contract easy to see. The
 * alternative (splitting the context, the provider, and the hook
 * across three files) is a common React pattern, but it forces a
 * reader who wants to understand the toast system to open three
 * files and hold the pieces in their head simultaneously.
 *
 * Why this file exists at all:
 *
 *   The codebase has a convention: hooks live in a `hooks/`
 *   directory. Components live in a `components/` directory.
 *   A consumer that wants a hook imports it from `hooks/`; a
 *   consumer that wants a component imports it from
 *   `components/`. The convention gives every file in the
 *   shared feature a predictable location, and it means an
 *   import line tells a reader what kind of thing they are
 *   bringing in.
 *
 *   The `useToast` hook technically lives in `components/`
 *   because that is where its provider lives. That would be a
 *   small exception to the convention, and this shim exists to
 *   close the gap: consumers who want `useToast` import it
 *   from `hooks/useToast.js`, and the shim forwards to the
 *   implementation. The convention holds, and the implementation
 *   location stays where it makes sense.
 *
 * What this file is NOT:
 *
 *   It is not a wrapper. It does not add behaviour, does not
 *   memoize anything, does not rename the hook. It re-exports
 *   the same function object that `../components/Toast.js`
 *   exports. A caller that imports `useToast` from this file
 *   and a caller that imports it directly from
 *   `../components/Toast.js` receive the *same reference* — so
 *   there is no risk of context mismatch or duplicated state
 *   from the two paths.
 *
 *   It is not a place to add a "convenience" wrapper in the
 *   future. If a session ever needs a variant of the hook that
 *   behaves differently (say, one that fires a toast with a
 *   default duration, or one that only fires errors), that
 *   variant belongs in `components/Toast.tsx` next to the hook
 *   itself, and this shim adds it to the re-export list. The
 *   shim's job is to be a forwarding address, not a wrapper.
 *
 * Re-exporting the associated types:
 *
 *   The four types — `ToastAPI`, `ToastVariant`, `ToastOptions`,
 *   and the hook's return type — are declared alongside the hook
 *   in `components/Toast.tsx`. They are re-exported here for the
 *   same reason the hook itself is: a consumer that imports from
 *   `hooks/` should not have to make a second import from
 *   `components/` to get the types that describe what the hook
 *   returns. The `type` modifier on the three interface/union
 *   re-exports tells TypeScript to erase them at emit time, so
 *   the compiled shim contains no runtime reference to the
 *   component module beyond the function re-export.
 */

export { useToast } from '../components/Toast.js';
export type {
  ToastAPI,
  ToastVariant,
  ToastOptions,
} from '../components/Toast.js';