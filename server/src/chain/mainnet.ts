/**
 * Mainnet, whichever chain the game itself is on.
 *
 * Two things this server needs are facts about the real market rather than
 * about the cluster the program lives on: what SOL costs, and what slot mainnet
 * has reached. Devnet has no market and its slots count something else, so the
 * chain's URL is *rewritten* rather than reused — the Helius key the server
 * already holds is the entire configuration. `CROWN_PRICE_RPC_URL` is for when
 * there is nothing to rewrite: a local validator, or a provider that is not
 * Helius.
 */
export function mainnetRpcUrl(): string {
  const explicit = process.env.CROWN_PRICE_RPC_URL;
  if (explicit) return explicit;

  const rpc = process.env.SOLANA_RPC_URL ?? "";
  if (/\.helius-rpc\.com/i.test(rpc)) {
    return rpc.replace(/\b(?:devnet|testnet)\.helius-rpc\.com/i, "mainnet.helius-rpc.com");
  }
  throw new Error("No mainnet RPC is configured — set CROWN_PRICE_RPC_URL to a mainnet RPC.");
}

/** Whether `mainnetRpcUrl` has anything to return. */
export function hasMainnetRpc(): boolean {
  try {
    mainnetRpcUrl();
    return true;
  } catch {
    return false;
  }
}

/**
 * The slot mainnet has confirmed, straight from the chain.
 *
 * The oracle's clock. Jupiter stamps every price with the slot it was read at,
 * and comparing that against this is a measure of staleness that no provider
 * can get wrong on our behalf — a response that is freshly generated and
 * carries frozen numbers still carries frozen *slots*.
 */
export async function mainnetSlot(): Promise<number> {
  const res = await fetch(mainnetRpcUrl(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "oracle-slot",
      method: "getSlot",
      params: [{ commitment: "confirmed" }],
    }),
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) throw new Error(`getSlot: ${res.status} ${res.statusText}`);
  const body = (await res.json()) as { result?: number; error?: { message?: string } };
  if (body.error) throw new Error(`getSlot: ${body.error.message ?? "rpc error"}`);
  if (typeof body.result !== "number" || !(body.result > 0)) throw new Error("getSlot: no slot");
  return body.result;
}
