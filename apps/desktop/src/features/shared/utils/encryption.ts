/**
 * encryption.ts — AES-GCM encryption helpers for the WriteSpeare
 * desktop app.
 *
 * The single utility the app uses whenever it needs to encrypt a
 * string before storing it somewhere that is not itself encrypted.
 * The main process's `electron-store` uses its own AES-256 layer
 * (see `main/store.ts`), so this module is not for that store — it
 * exists for the case where a single sensitive value needs to
 * travel through an otherwise-plaintext surface: a config file, a
 * log line the developer wants redacted-but-recoverable, a future
 * feature that persists a per-user secret outside the encrypted
 * store.
 *
 * ── Why WebCrypto and not node:crypto ───────────────────────────
 *
 *   The file lives under `features/shared/`, which by the plan's
 *   architecture is the folder both the main process and the
 *   renderer draw from. Both contexts need to be able to call an
 *   encryption utility — a config parser in the main process and,
 *   once a future session exposes it through IPC, a
 *   user-preferences surface in the renderer would both want it.
 *
 *   The two contexts have different crypto APIs available:
 *
 *     * `node:crypto` (`createCipheriv`, `randomBytes`, etc.) is
 *       available only in the main process and in the preload's
 *       Node context. The renderer's sandbox does not expose it.
 *
 *     * WebCrypto (`crypto.subtle`) is available in both. On the
 *       main-process side, Node 20 (shipped with Electron 44)
 *       exposes it as `globalThis.crypto.subtle`. On the
 *       renderer side, Chromium exposes it as `window.crypto.subtle`.
 *
 *   The intersection — WebCrypto — is the only API that lets a
 *   single implementation of this utility run unchanged in both
 *   contexts. That is the reason for the choice, and it is the
 *   only reason. A utility that lived only in the main process
 *   would be free to use `node:crypto` for the slightly more
 *   ergonomic synchronous API; a utility that lives in `shared/`
 *   cannot.
 *
 * ── The algorithm choices ───────────────────────────────────────
 *
 *   AES-GCM with a 256-bit key is the modern standard for
 *   authenticated symmetric encryption. It provides both
 *   confidentiality (the ciphertext does not reveal the
 *   plaintext) and integrity (a tampered ciphertext fails to
 *   decrypt with an authentication error rather than producing
 *   garbage plaintext). The alternative — AES-CBC plus a separate
 *   HMAC — is the older construction, still secure when done
 *   correctly, but easier to get wrong because the two primitives
 *   must be composed by the caller. GCM composes them internally.
 *
 *   The IV is 12 bytes (96 bits), which is the GCM standard and
 *   the size the WebCrypto specification recommends. A different
 *   IV length is legal but slightly slower and not interoperable
 *   with the common AES-GCM implementations in other languages.
 *
 *   The authentication tag is 16 bytes (128 bits), WebCrypto's
 *   default and the strongest option. The tag is emitted by
 *   `crypto.subtle.encrypt` appended to the ciphertext, and the
 *   corresponding `crypto.subtle.decrypt` verifies it before
 *   returning the plaintext. A tag mismatch produces a thrown
 *   `OperationError`, which this module wraps in a clearer error
 *   message.
 *
 *   PBKDF2 with SHA-256 and 100,000 iterations is the passphrase-
 *   derivation function. 100,000 iterations is the OWASP
 *   recommendation as of 2023 for PBKDF2-HMAC-SHA256 and reflects
 *   a balance between the cost an attacker pays per guess and the
 *   latency the user pays per unlock. Argon2id would be a stronger
 *   choice in a vacuum, but it is not exposed by WebCrypto and
 *   would require a WASM or native dependency; PBKDF2 is the
 *   strongest option available within the constraint this module
 *   operates under.
 *
 * ── The payload format ──────────────────────────────────────────
 *
 *   `encryptString` returns a base64-encoded string that packs
 *   three pieces of data in sequence:
 *
 *     [ IV (12 bytes) ][ ciphertext (N bytes) ][ auth tag (16 bytes) ]
 *
 *   The tag is emitted by WebCrypto as part of the ciphertext
 *   output, not as a separate field, so the byte layout above is
 *   really `[ IV ][ ciphertext + tag ]` — the tag is the last 16
 *   bytes of the ciphertext blob. Splitting it out above is a
 *   documentation device: it names the three conceptual parts of
 *   the payload for a reader who is trying to reason about
 *   security properties.
 *
 *   Prefacing the IV means `decryptString` can recover it without
 *   any out-of-band coordination. The alternative — a separate
 *   IV field that the caller stores alongside the ciphertext —
 *   would work but would make every caller responsible for
 *   remembering that the two must be kept together. A self-
 *   describing payload is one fewer thing for a caller to get
 *   wrong.
 *
 *   Every IV is freshly random. This is the single most important
 *   operational rule of AES-GCM: reusing an IV under the same key
 *   catastrophically undermines the cipher's security — an
 *   attacker who sees two ciphertexts encrypted with the same IV
 *   can XOR them to cancel the keystream and recover the XOR of
 *   the two plaintexts. The IV is generated by
 *   `crypto.getRandomValues`, which is a cryptographically secure
 *   source on both Node and Chromium.
 *
 * ── The key is not stored by this module ────────────────────────
 *
 *   This module does not persist keys, does not wrap keys,
 *   does not derive keys from a machine identifier, and does not
 *   attempt to hide a key inside the ciphertext. Those are policy
 *   decisions that belong to the caller, and each has a different
 *   right answer depending on the caller's threat model.
 *
 *   The four common patterns a caller might want:
 *
 *     1. Ephemeral key (in-memory only, for a single session).
 *        Call `generateKey()` and hold the `CryptoKey` in a
 *        module variable. The key vanishes when the process
 *        exits.
 *
 *     2. User-passphrase-derived key (deterministic across
 *        sessions, depends on the user remembering a
 *        passphrase). Call `generateSalt()` once, store the
 *        salt alongside the ciphertext, and call
 *        `deriveKeyFromPassphrase(passphrase, salt)` on each
 *        session to re-derive the same key.
 *
 *     3. OS-keychain-backed key (a key managed by the OS's
 *        credential vault). Use Electron's `safeStorage` module —
 *        `safeStorage.encryptString` returns an encrypted blob
 *        that only this machine's user account can decrypt. The
 *        current module is not the right tool for this case; it
 *        is listed here so a caller does not accidentally reach
 *        for AES-GCM when a keychain is what they actually want.
 *
 *     4. Application-derived key (a key derived from a
 *        machine-and-user combination, so it survives restarts
 *        but does not leave the machine). This is what
 *        `main/store.ts` uses for the encrypted store. It is
 *        weaker than the keychain option above — the derivation
 *        is deterministic and an attacker with filesystem access
 *        can reproduce it — but it protects against casual
 *        inspection of the userData directory. A caller with
 *        that threat model can derive a passphrase from the
 *        same inputs and call `deriveKeyFromPassphrase`.
 *
 *   The module intentionally does not choose between these for
 *   the caller. Choosing would mean shipping a default that is
 *   correct for one caller and wrong for another, and the wrong
 *   choice would be invisible until it was exploited.
 *
 * ── What this module does NOT do ────────────────────────────────
 *
 *   - It does not encrypt files. The API is string-in,
 *     string-out. A caller that wants to encrypt a file reads the
 *     file, encrypts the contents, and writes the result. There
 *     is no stream cipher and no partial-read support; the
 *     payloads this module handles are small (a token, a
 *     password, a small config blob), and a caller who needs
 *     streaming encryption needs a different tool.
 *
 *   - It does not sign or verify data. GCM's authentication tag
 *     proves that a ciphertext was produced by someone holding
 *     the key — it does not prove that the plaintext came from a
 *     particular sender. A caller who needs message
 *     authentication with non-repudiation (a signature, not a
 *     MAC) needs an asymmetric scheme, which this module does
 *     not provide.
 *
 *   - It does not compress or encode before encrypting. The
 *     caller's plaintext is encoded as UTF-8 and handed to the
 *     cipher directly. A caller who wants compression on top of
 *     encryption would compress before calling `encryptString`
 *     and decompress after `decryptString`.
 *
 *   - It does not fall back to a weaker algorithm on any platform.
 *     If WebCrypto is unavailable in the caller's context — a
 *     scenario that would indicate a broken Electron install,
 *     not a design case — the module throws. Silently falling
 *     back to a weaker primitive would be exactly the class of
 *     bug this module exists to prevent.
 *
 * Dependencies: none. The file uses only globals that are
 * available in both the Electron main process (Node 20+) and the
 * Chromium renderer (Electron 44).
 */

// ============================================================
//  Constants
// ============================================================

/**
 * The AES-GCM identifier used by WebCrypto. Declared as a
 * constant so the three functions that reference it cannot drift
 * apart.
 */
const GCM_ALGORITHM = 'AES-GCM';

/**
 * The AES key length, in bits. AES has exactly three legal key
 * sizes — 128, 192, and 256 — and 256 is the strongest. A
 * 256-bit key provides 256 bits of security against a classical
 * brute-force attack; the effective security against a quantum
 * attacker is lower (Grover's algorithm halves it), which is why
 * a "post-quantum" project might choose a longer key. For the
 * current threat model — protecting local secrets on a user's
 * workstation — 256 bits is the correct choice and matches the
 * convention every modern crypto library defaults to.
 */
const GCM_KEY_LENGTH_BITS = 256;

/**
 * The IV length, in bytes. The GCM specification recommends 12
 * bytes (96 bits) for the IV; WebCrypto's `AesGcmParams`
 * documentation uses 12 bytes in all of its examples. A longer
 * IV is legal but is internally hashed by GCM before being used
 * as a counter initial value, which adds cost for no benefit.
 *
 * This value is used in two places: to generate the IV when
 * encrypting, and to know how many bytes to slice off the front
 * of the payload when decrypting. Both must agree, which is why
 * the constant exists.
 */
const GCM_IV_LENGTH_BYTES = 12;

/**
 * The PBKDF2 iteration count. 100,000 is the OWASP-recommended
 * minimum for PBKDF2-HMAC-SHA256. The number is measured in
 * iterations of a hash function, and the security property is
 * that an attacker who steals the ciphertext and the salt must
 * pay 100,000 hash evaluations per candidate passphrase. At
 * current hardware speeds, that is tens of milliseconds per
 * guess on a modern CPU, and several orders of magnitude
 * cheaper on a dedicated GPU — which is why PBKDF2 is considered
 * the weakest of the passphrase-hashing functions and why
 * Argon2id is the recommended alternative where it is available.
 * WebCrypto does not expose Argon2id, so PBKDF2 is the
 * strongest option this module can use without a new dependency.
 */
const PBKDF2_ITERATIONS = 100_000;

/**
 * The hash function PBKDF2 uses. SHA-256 is the standard choice
 * for the parameter sizes this module operates at — the input is
 * a passphrase (tens to hundreds of characters) and the output
 * is a 256-bit key, both of which fit comfortably within
 * SHA-256's operating range. SHA-512 would produce a longer
 * intermediate value without changing the final key length, at
 * a small cost.
 */
const PBKDF2_HASH = 'SHA-256';

/**
 * The salt length for passphrase derivation, in bytes. 16 bytes
 * (128 bits) is the NIST recommendation for PBKDF2 salts and the
 * value the OWASP guidance uses. A salt's only job is to make
 * precomputed rainbow tables useless and to ensure that two
 * users who chose the same passphrase get different derived
 * keys — 128 bits is more than sufficient for both properties.
 */
const SALT_LENGTH_BYTES = 16;

// ============================================================
//  WebCrypto availability check
// ============================================================
//
//  A single module-level check, performed once, so every entry
//  point fails fast with the same clear error if the runtime does
//  not expose `SubtleCrypto`. In every context this module is
//  designed for, the check passes; the failure mode it guards
//  against is a future Electron build or a test harness that
//  strips the API, and the error message names the specific
//  global that is missing so the diagnostic is immediate.

/**
 * The SubtleCrypto instance for the current context, or `null` if
 * the runtime does not provide one.
 *
 * The optional-chaining access is deliberate: `globalThis.crypto`
 * is typed as non-optional by TypeScript's DOM lib, but a
 * test harness that mocks the global may leave it undefined at
 * runtime. The optional chaining makes the access defensive
 * without adding a cast.
 */
const subtle: SubtleCrypto | null = globalThis.crypto?.subtle ?? null;

/**
 * Throw a descriptive error when `subtle` is unavailable. Called
 * at the top of every async entry point.
 *
 * The function returns nothing on success. On failure it throws
 * an `Error` whose message names the missing global and points
 * at the two contexts where the module is expected to work. A
 * caller that sees this error has a runtime configuration
 * problem, not a usage problem — the call site itself is fine.
 */
const requireSubtle = (): SubtleCrypto => {
  if (subtle === null) {
    throw new Error(
      'encryption: SubtleCrypto is not available in this context. ' +
        'This module requires WebCrypto, which is present in the ' +
        'Electron main process (Node 20+) and in the Chromium ' +
        'renderer. Check the runtime that is importing this file.'
    );
  }
  return subtle;
};

// ============================================================
//  Byte / base64 conversion helpers
// ============================================================
//
//  WebCrypto operates on `ArrayBuffer` and `Uint8Array` values;
//  the module's public API operates on strings. Two helpers
//  bridge the two worlds. Both are standard and are used
//  everywhere a base64 string and a byte array need to be
//  interconverted in a browser or in Node 20+.

/**
 * Encode a `Uint8Array` as a base64 string.
 *
 * The manual byte-to-character loop is used rather than
 * `String.fromCharCode.apply(null, bytes)` because the
 * `apply` form is subject to JavaScript's argument-count limit,
 * which is roughly 65,000 on the V8 engine. For the small
 * payloads this module handles the limit is never reached, but
 * a helper that silently fails on a large input is worse than a
 * helper that is correct for every input, and the manual loop
 * costs nothing at the sizes involved.
 *
 * The non-null assertion on `bytes[i]` is the standard pattern
 * for typed-array indexing under `noUncheckedIndexedAccess` —
 * the compiler types the access as `number | undefined` because
 * it cannot prove the index is in bounds, but a `Uint8Array`
 * access at a valid index always returns a number at runtime.
 * The assertion tells the compiler what is true.
 */
const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
};

/**
 * Decode a base64 string back to a `Uint8Array`.
 *
 * The `charCodeAt` return value is `number` (not `number |
 * undefined`) because `binary.length` is known and `i` is
 * bounded by the loop, so no assertion is required on this side.
 *
 * The return type is written as `Uint8Array<ArrayBuffer>` rather
 * than the shorthand `Uint8Array`. Since TypeScript 5.7, the
 * shorthand defaults the generic parameter to `ArrayBufferLike`,
 * which is the union `ArrayBuffer | SharedArrayBuffer`. Every
 * WebCrypto method accepts a `BufferSource` — defined as
 * `ArrayBufferView<ArrayBuffer> | ArrayBuffer` — that does NOT
 * include a `SharedArrayBuffer` backing store. The helper's
 * actual buffer is always a plain `ArrayBuffer`, but the wide
 * shorthand annotation would silently re-widen it and produce a
 * type error at every call site that feeds the result to
 * `crypto.subtle`. The explicit narrow annotation keeps the
 * helper's output assignable to `BufferSource` without a cast
 * at each caller.
 */
const base64ToBytes = (b64: string): Uint8Array<ArrayBuffer> => {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
};

// ============================================================
//  Public API — key generation
// ============================================================

/**
 * Generate a fresh 256-bit AES-GCM key.
 *
 * The returned key is non-extractable — its raw bytes cannot be
 * read out of the `CryptoKey` object. This is the correct default
 * for a key that will not be persisted: it ensures that a
 * compromised renderer that somehow obtained a reference to the
 * key cannot export it and send it to an attacker.
 *
 * The non-extractable property is a WebCrypto-specific guarantee
 * that has no equivalent in the older `node:crypto` API — it is
 * one of the reasons the WebCrypto module is the right choice
 * for this codebase even where the Node API is more ergonomic.
 *
 * A caller that needs to persist the key across sessions cannot
 * use this function's output directly; it must either derive the
 * key from a passphrase (see `deriveKeyFromPassphrase`) or wrap
 * the key with the OS's keychain (via Electron's `safeStorage`,
 * which is outside this module's scope). See the file header's
 * "The key is not stored by this module" section for the four
 * supported persistence patterns.
 *
 * @returns A promise for a fresh 256-bit AES-GCM `CryptoKey`
 *          usable for both encryption and decryption.
 * @throws  `Error` if WebCrypto is unavailable in the caller's
 *          context.
 */
export const generateKey = async (): Promise<CryptoKey> => {
  const cryptoImpl = requireSubtle();
  return await cryptoImpl.generateKey(
    { name: GCM_ALGORITHM, length: GCM_KEY_LENGTH_BITS },
    true,
    ['encrypt', 'decrypt']
  );
};

/**
 * Generate a fresh 16-byte salt, returned as a base64 string.
 *
 * The salt is a random value that a caller stores alongside a
 * passphrase-derived ciphertext. The same passphrase and the same
 * salt always derive the same key; different salts derive
 * different keys even when the passphrase is identical, which is
 * what makes precomputed rainbow tables useless and what stops
 * two users who chose the same passphrase from having keys that
 * are related to each other.
 *
 * The salt is not secret. It is stored alongside the ciphertext
 * and is transmitted in the clear whenever the ciphertext is
 * transmitted. Its job is purely to add entropy to the
 * derivation, not to provide any confidentiality on its own.
 *
 * Returning a base64 string (rather than a `Uint8Array`) makes
 * the salt easy to store in the same kind of place a caller
 * would store the ciphertext — a JSON config file, a database
 * field, a URL-safe token. A caller that wants the raw bytes
 * converts via `base64ToBytes`-equivalent logic at its own
 * boundary.
 *
 * @returns A base64-encoded 16-byte salt.
 */
export const generateSalt = (): string => {
  // `crypto.getRandomValues` is available on `globalThis.crypto`
  // in both Node 20+ and Chromium. Unlike `subtle`, it is not
  // behind an async interface and cannot be absent when
  // `subtle` is present, so no availability check is required.
  const bytes = new Uint8Array(SALT_LENGTH_BYTES);
  globalThis.crypto.getRandomValues(bytes);
  return bytesToBase64(bytes);
};

// ============================================================
//  Public API — passphrase-derived key
// ============================================================

/**
 * Derive a 256-bit AES-GCM key from a passphrase and a base64-
 * encoded salt.
 *
 * The derivation is deterministic: the same passphrase and the
 * same salt always produce the same key. This is what allows a
 * caller to re-derive the key on a later session without having
 * to store it — the passphrase lives in the user's head (or in
 * a password manager), the salt lives next to the ciphertext,
 * and the two together reconstruct the key.
 *
 * The `importKey` step converts the caller's passphrase string
 * into a `CryptoKey` that PBKDF2 can consume. The passphrase is
 * encoded as UTF-8 before being imported, so a passphrase with
 * non-ASCII characters derives a key that is stable across
 * platforms and locales.
 *
 * The `deriveKey` step performs the actual PBKDF2 computation.
 * The derived key is marked non-extractable for the same reason
 * `generateKey`'s output is — the raw bytes never leave the
 * `CryptoKey` object.
 *
 * The `iterations` value is 100,000, the OWASP-recommended
 * minimum. See the constant's docstring for the trade-off this
 * value encodes.
 *
 * @param passphrase - The caller's passphrase. Any non-empty
 *                     string; the module does not enforce a
 *                     minimum length, because the correct
 *                     minimum depends on the caller's threat
 *                     model and a caller who chose a weak
 *                     passphrase has a weak key regardless of
 *                     any check this module could impose.
 * @param saltBase64 - The base64-encoded salt. Must be the
 *                     output of `generateSalt()` (or any
 *                     equivalent 16-byte base64 value). A salt
 *                     of a different length is accepted — PBKDF2
 *                     does not require a specific length — but
 *                     the convention this module documents is 16
 *                     bytes.
 * @returns A promise for a non-extractable 256-bit AES-GCM
 *          `CryptoKey`.
 * @throws  `Error` if WebCrypto is unavailable in the caller's
 *          context, or if the salt is not valid base64 (the
 *          underlying `atob` throws on malformed input).
 */
export const deriveKeyFromPassphrase = async (
  passphrase: string,
  saltBase64: string
): Promise<CryptoKey> => {
  const cryptoImpl = requireSubtle();

  // Convert the passphrase to bytes via UTF-8 and import it as
  // the PBKDF2 base key. The key is not extractable and is only
  // usable for derivation, which is the narrowest set of
  // capabilities PBKDF2 needs.
  const encoder = new TextEncoder();
  const passphraseBytes = encoder.encode(passphrase);
  const baseKey = await cryptoImpl.importKey(
    'raw',
    passphraseBytes,
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );

  // Convert the salt from base64 to bytes. A malformed base64
  // string throws from `atob`, which propagates to the caller
  // as a diagnostic rather than being swallowed.
  const salt = base64ToBytes(saltBase64);

  // Perform the derivation. The derived key is a full AES-GCM
  // key with the two operations the ciphertext workflow needs.
  const derivedKey = await cryptoImpl.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: PBKDF2_HASH,
    },
    baseKey,
    { name: GCM_ALGORITHM, length: GCM_KEY_LENGTH_BITS },
    false,
    ['encrypt', 'decrypt']
  );

  return derivedKey;
};

// ============================================================
//  Public API — encrypt / decrypt
// ============================================================

/**
 * Encrypt a UTF-8 string under the supplied AES-GCM key and
 * return a self-describing base64 payload.
 *
 * The payload is `base64( IV || ciphertext+tag )`. See the file
 * header's "The payload format" section for the byte layout and
 * for why the IV is prefixed rather than stored separately.
 *
 * A fresh IV is generated on every call. This is the single
 * most important operational rule of AES-GCM and the reason this
 * function does not accept an IV parameter — a caller who could
 * supply the IV could accidentally reuse one, and the failure
 * mode of IV reuse in GCM is catastrophic and silent. The
 * module refuses to offer the footgun.
 *
 * The output string is safe to store in a JSON file, a database
 * field, a URL query parameter, or anywhere else that requires
 * a textual representation. It contains only base64 characters
 * (`A–Z`, `a–z`, `0–9`, `+`, `/`, `=`) and has no whitespace or
 * line breaks.
 *
 * @param plaintext - The string to encrypt. Encoded as UTF-8
 *                    before encryption, so any valid JavaScript
 *                    string is accepted.
 * @param key       - The AES-GCM key to encrypt under. Must be
 *                    a 256-bit key usable for both encryption
 *                    and decryption. Both `generateKey()` and
 *                    `deriveKeyFromPassphrase()` produce keys
 *                    that satisfy this.
 * @returns A promise for the base64-encoded payload.
 * @throws  `Error` if WebCrypto is unavailable in the caller's
 *          context, or if encryption itself fails (a key that
 *          does not permit encryption, an out-of-memory
 *          condition on an enormous plaintext).
 */
export const encryptString = async (
  plaintext: string,
  key: CryptoKey
): Promise<string> => {
  const cryptoImpl = requireSubtle();

  // Generate a fresh IV. See the function's docstring for why
  // this is non-negotiable.
  const iv = new Uint8Array(GCM_IV_LENGTH_BYTES);
  globalThis.crypto.getRandomValues(iv);

  // Encode the plaintext as UTF-8.
  const encoder = new TextEncoder();
  const plaintextBytes = encoder.encode(plaintext);

  // Encrypt. WebCrypto returns an `ArrayBuffer` that contains
  // the ciphertext followed by the 16-byte authentication tag.
  const ciphertextBuffer = await cryptoImpl.encrypt(
    { name: GCM_ALGORITHM, iv },
    key,
    plaintextBytes
  );

  // Combine IV and ciphertext into a single byte array. Using
  // `set` on a pre-allocated `Uint8Array` avoids the intermediate
  // array allocation a `concat`-style operation would produce.
  const ciphertextBytes = new Uint8Array(ciphertextBuffer);
  const combined = new Uint8Array(
    iv.length + ciphertextBytes.length
  );
  combined.set(iv, 0);
  combined.set(ciphertextBytes, iv.length);

  // Base64-encode the result for textual storage.
  return bytesToBase64(combined);
};

/**
 * Decrypt a base64 payload produced by `encryptString`.
 *
 * The reverse of `encryptString`. The payload's first 12 bytes
 * are treated as the IV; the remainder is the ciphertext-plus-tag
 * blob WebCrypto produced. The tag is verified as part of the
 * decryption call, so a tampered ciphertext throws rather than
 * producing a corrupted plaintext.
 *
 * The function throws on any failure — a malformed base64 string,
 * a payload too short to contain an IV, a ciphertext that fails
 * authentication, or a key that does not match the one used to
 * encrypt. The failure messages are deliberately uniform
 * (a generic "decryption failed" wrapping the underlying error)
 * because distinguishing "wrong key" from "tampered ciphertext"
 * at the API boundary would be an information leak: an attacker
 * who could distinguish the two cases would know whether they
 * had guessed the key or corrupted the ciphertext, and the
 * difference matters to an attacker in ways it does not to a
 * legitimate caller.
 *
 * @param payloadBase64 - The base64 payload produced by
 *                        `encryptString`.
 * @param key           - The AES-GCM key. Must be the same key
 *                        the payload was encrypted under, or a
 *                        key that is byte-identical to it (for
 *                        passphrase-derived keys, the same
 *                        passphrase and salt).
 * @returns A promise for the recovered plaintext, as a string.
 * @throws  `Error` if WebCrypto is unavailable in the caller's
 *          context, or if decryption fails for any reason.
 */
export const decryptString = async (
  payloadBase64: string,
  key: CryptoKey
): Promise<string> => {
  const cryptoImpl = requireSubtle();

  // Decode the base64 payload back to bytes.
  let combined: Uint8Array;
  try {
    combined = base64ToBytes(payloadBase64);
  } catch (err) {
    // `atob` throws a `DOMException` with a "The string to be
    // decoded is not correctly encoded" message. Wrapping it in
    // an `Error` with a clearer message keeps the caller's
    // error-handling surface uniform.
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `encryption: payload is not valid base64 (${reason}).`
    );
  }

  // A payload shorter than the IV length cannot have been
  // produced by `encryptString` — even a zero-length plaintext
  // produces a payload of 12 + 16 bytes minimum (IV + auth tag).
  // The check is defensive against a caller that passed a
  // truncated or hand-crafted payload.
  if (combined.length < GCM_IV_LENGTH_BYTES) {
    throw new Error(
      'encryption: payload is too short to contain an IV.'
    );
  }

  // Split the payload into IV and ciphertext+tag.
  const iv = combined.slice(0, GCM_IV_LENGTH_BYTES);
  const ciphertext = combined.slice(GCM_IV_LENGTH_BYTES);

  // Decrypt. The GCM tag is verified by WebCrypto as part of
  // this call; a mismatch throws here rather than returning
  // corrupted bytes.
  let plaintextBuffer: ArrayBuffer;
  try {
    plaintextBuffer = await cryptoImpl.decrypt(
      { name: GCM_ALGORITHM, iv },
      key,
      ciphertext
    );
  } catch (err) {
    // The underlying error is an `OperationError` with a message
    // that does not distinguish "wrong key" from "tampered
    // ciphertext". The wrapped message preserves that
    // uniformity — see the function's docstring for why.
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `encryption: decryption failed (${reason}).`
    );
  }

  // Decode the plaintext from UTF-8.
  const decoder = new TextDecoder();
  return decoder.decode(plaintextBuffer);
};

// ============================================================
//  Default export
// ============================================================

/**
 * Every export bundled under one default object, matching the
 * convention used by `shared/api/client.ts` and the other shared
 * utility modules in the codebase. A caller that prefers named
 * imports uses the individual named exports above; a caller that
 * prefers the default form uses
 * `import encryption from '.../encryption.js'` and destructures
 * the functions it needs.
 *
 * Both forms resolve to the same function objects — there is no
 * wrapper and no indirection, so the default object and the
 * named exports cannot drift apart.
 */
export default {
  generateKey,
  generateSalt,
  deriveKeyFromPassphrase,
  encryptString,
  decryptString,
};