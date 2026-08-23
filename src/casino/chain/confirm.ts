import type { Connection } from "@solana/web3.js";

/**
 * Waiting for a transaction, without a websocket.
 *
 * `connection.confirmTransaction` subscribes over a socket. In this app that
 * cannot work and fails slowly: the client talks to `/rpc` on our own origin —
 * so a provider key never reaches the browser — and web3.js derives a websocket
 * endpoint from that by swapping the scheme. Nothing upgrades `/rpc`, so the
 * socket cannot connect, and the player waits for that to be discovered before
 * anything falls back.
 *
 * The cost lands on the two transactions a player ever signs, which are the two
 * moments they are watching the screen: connecting a wallet, and cashing out.
 *
 * Polling is unglamorous and correct here. Every request goes through the same
 * proxy as the rest, and the whole point of that proxy is that the browser only
 * ever speaks HTTP to us.
 */

const POLL_MS = 900;

export class ConfirmTimeout extends Error {
  readonly signature: string;
  constructor(signature: string) {
    super("The network did not confirm in time. Your transaction may still land.");
    this.name = "ConfirmTimeout";
    this.signature = signature;
  }
}

export async function confirmSignature(
  connection: Connection,
  opts: { signature: string; blockhash: string; lastValidBlockHeight: number; timeoutMs?: number }
): Promise<void> {
  const deadline = Date.now() + (opts.timeoutMs ?? 45_000);

  for (;;) {
    let status = null;
    try {
      status = (await connection.getSignatureStatus(opts.signature)).value;
    } catch {
      // A failed read says nothing about the transaction; ask again.
    }

    if (status?.err) {
      throw new Error(`The transaction was rejected on chain: ${JSON.stringify(status.err)}`);
    }
    if (
      status &&
      (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized")
    ) {
      return;
    }

    // Absence is only conclusive once the blockhash it was signed against can no
    // longer be accepted.
    if (!status) {
      try {
        if ((await connection.getBlockHeight()) > opts.lastValidBlockHeight) {
          throw new Error("The transaction expired before it was confirmed. Nothing was spent.");
        }
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("The transaction expired")) throw err;
        // Could not read the height — keep waiting rather than guessing.
      }
    }

    if (Date.now() > deadline) throw new ConfirmTimeout(opts.signature);
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}
