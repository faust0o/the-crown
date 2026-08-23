import { Buffer } from "buffer";

/**
 * Give `@solana/spl-token` the global it assumes.
 *
 * It depends on the `buffer` package but never imports it — every instruction
 * builder in there calls a bare `Buffer.alloc` — so in a browser the first
 * `createApproveInstruction` throws `Buffer is not defined`. web3.js imports the
 * same package properly, which is why only half the stack breaks and why the
 * failure looks like a bug in our code rather than a missing polyfill.
 *
 * Imported first by WalletBridge, and only there — the one place that needs it,
 * before anything that could reach for `Buffer` has run.
 */
(globalThis as { Buffer?: typeof Buffer }).Buffer ??= Buffer;
