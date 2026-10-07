import type { Express, Request, Response } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";

import { RPC_URL } from "./program";

/**
 * The browser's route to the chain, without the browser holding the key.
 *
 * A paid RPC endpoint carries its key in the URL, and `VITE_SOLANA_RPC_URL` is
 * substituted into the bundle at build time — so configuring the client with a
 * Helius URL directly ships that key to every visitor, in plain text, in
 * `dist/assets/CasinoApp-*.js`. Anyone who opens the page can read it and spend
 * the quota. The endpoint being "just config" is what makes the mistake so easy:
 * nothing fails, and the bill arrives later.
 *
 * So the client points at this instead, same-origin and keyless, and the key
 * lives only in the server's environment.
 *
 * ## Why this is not an open proxy
 *
 * Forwarding whatever arrives would hand the internet an anonymous, funded RPC
 * endpoint — strictly worse than leaking the key, because it costs the same and
 * is easier to use. Two things bound it:
 *
 * - **A method allowlist.** Only what the wallet card and the setup transaction
 *   actually need. Notably absent are the expensive scans (`getProgramAccounts`,
 *   `getSignaturesForAddress`) that make an RPC endpoint worth stealing.
 * - **A rate limit per address**, well above what a player generates and far
 *   below what makes the endpoint useful to somebody else.
 *
 * The server does not come through here. It runs in this process and holds the real
 * endpoint directly, so the limit below can be sized for browsers alone.
 */

/**
 * What a browser is allowed to ask.
 *
 * Reads to render the wallet card, plus the three calls it takes to send the one
 * transaction a player ever signs. Anything absent from this list is not a
 * judgement about danger — it is that no path in `src/casino/chain/` calls it,
 * and an allowlist that grows on speculation is not an allowlist.
 */
const ALLOWED = new Set([
  "getAccountInfo",
  "getMultipleAccounts",
  "getBalance",
  "getTokenAccountBalance",
  "getLatestBlockhash",
  "getMinimumBalanceForRentExemption",
  "getSignatureStatuses",
  // Both are what a *polled* confirmation needs, and the client polls because it
  // has no websocket to us — see `src/casino/chain/confirm.ts`. Refusing them
  // would leave the browser unable to find out what happened to a transaction it
  // had just been asked to sign.
  "getBlockHeight",
  "sendTransaction",
  "simulateTransaction",
  "getVersion",
  "getHealth",
]);

interface JsonRpcCall {
  jsonrpc?: string;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

const refuse = (id: unknown, code: number, message: string) => ({
  jsonrpc: "2.0",
  id: id ?? null,
  error: { code, message },
});

/**
 * Batches are allowed but bounded: web3.js coalesces reads into arrays, so
 * refusing them outright would break `getMultipleAccountsInfo`. A batch is only
 * as acceptable as its least acceptable member.
 */
const MAX_BATCH = 10;

export function mountRpcProxy(app: Express): void {
  app.post(
    "/rpc",
    rateLimit({
      windowMs: 60_000,
      // A viewer polls the wallet card a few times a minute and sends one
      // transaction, ever. This is roughly two orders of magnitude of headroom
      // over that, and nowhere near enough to be worth pointing a bot at.
      limit: 240,
      standardHeaders: true,
      legacyHeaders: false,
      keyGenerator: (req) => ipKeyGenerator(req.ip ?? ""),
      message: { error: "Too many RPC requests." },
    }),
    async (req: Request, res: Response) => {
      const body = req.body as JsonRpcCall | JsonRpcCall[];
      const calls = Array.isArray(body) ? body : [body];

      if (!calls.length) return void res.status(400).json(refuse(null, -32600, "Empty request."));
      if (calls.length > MAX_BATCH) {
        return void res.status(413).json(refuse(null, -32600, "Batch too large."));
      }

      for (const call of calls) {
        const method = typeof call?.method === "string" ? call.method : "";
        if (!ALLOWED.has(method)) {
          // Named in the reply on purpose. The alternative is a silent failure
          // in a browser against a proxy the developer forgot exists, which is a
          // miserable afternoon.
          return void res
            .status(403)
            .json(refuse(call?.id, -32601, `Method not permitted through this proxy: ${method || "(none)"}`));
        }
      }

      try {
        const upstream = await fetch(RPC_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(15_000),
        });
        const text = await upstream.text();
        res
          .status(upstream.status)
          .type(upstream.headers.get("content-type") ?? "application/json")
          .send(text);
      } catch (err) {
        // The upstream URL is never echoed: it is the thing being protected, and
        // a timeout message carrying the key would undo the entire point.
        const reason = err instanceof Error && err.name === "TimeoutError" ? "timed out" : "unavailable";
        res.status(502).json(refuse(null, -32603, `Upstream RPC ${reason}.`));
      }
    }
  );
}
