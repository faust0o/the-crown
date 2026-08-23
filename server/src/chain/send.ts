import type { Keypair, Transaction } from "@solana/web3.js";

import { COMMITMENT, connection } from "./program";
import idl from "./idl/crown.json" with { type: "json" };

/**
 * Sending a transaction and finding out what happened to it.
 *
 * Replaces Anchor's `.rpc()` on every path that writes. Two reasons, and the
 * second is the one that matters in production.
 *
 * ## No websocket
 *
 * `.rpc()` confirms over a signature subscription, so every write opens one. A
 * provider that rate-limits websockets — which is every shared endpoint —
 * refuses them under load, and the refusal arrives from a socket callback with
 * nothing awaiting it. That took the process down until the handler in
 * `index.ts` caught it, and it is still a failure mode nobody needs: polling a
 * signature costs about the same in requests and cannot be refused in a way that
 * kills anything.
 *
 * ## The error survives
 *
 * Anchor 0.32 builds `SendTransactionError` with the old positional signature
 * (`provider.js:122`) and web3.js 1.98 destructures an object from it — so the
 * message lands where `action` belongs, the switch falls through, and every
 * failure carrying logs became the string `Unknown action 'undefined'` with the
 * real message and the logs both discarded. An entire class of production
 * failure was unreadable, and the code that tried to recognise the benign ones
 * by matching on the text could not.
 *
 * Here the error is built from what the cluster actually returned, and a custom
 * program error is looked up in the IDL — so `BadReveal` arrives as
 * "BadReveal: The revealed seed does not match the published commitment" rather
 * than as a number, or as nothing.
 */

interface IdlError {
  code: number;
  name: string;
  msg?: string;
}

const PROGRAM_ERRORS = new Map<number, IdlError>(
  ((idl as { errors?: IdlError[] }).errors ?? []).map((e) => [e.code, e])
);

/** How long to keep asking before giving up on an answer. */
const CONFIRM_TIMEOUT_MS = Number(process.env.CHAIN_CONFIRM_TIMEOUT_MS ?? 45_000);

/** How often to ask. Slow enough not to spend the budget on impatience. */
const POLL_MS = Number(process.env.CHAIN_CONFIRM_POLL_MS ?? 1_200);

export class ChainSendError extends Error {
  readonly signature: string | null;
  readonly code: number | null;
  readonly logs: string[] | null;

  constructor(message: string, opts: { signature?: string | null; code?: number | null; logs?: string[] | null } = {}) {
    super(message);
    this.name = "ChainSendError";
    this.signature = opts.signature ?? null;
    this.code = opts.code ?? null;
    this.logs = opts.logs ?? null;
  }
}

/**
 * Turn whatever the cluster said into a sentence.
 *
 * A custom program error is a number on the wire; the IDL is what makes it a
 * name and a message, and it is right there in this package.
 */
export function describeChainError(err: unknown, signature: string | null, logs: string[] | null): ChainSendError {
  const text = err instanceof Error ? err.message : String(err);

  // `{"InstructionError":[0,{"Custom":6005}]}` in either its object or its
  // stringified form, depending on which layer produced it.
  // **Each form is parsed in the base it is written in.**
  //
  // The cluster spells a custom error two ways: decimal inside an
  // `InstructionError` payload, and hexadecimal in the human-readable
  // "custom program error: 0x1775". They were being matched into one variable
  // and the base then *guessed* from the string's shape, which is inferring
  // something already known and got it wrong twice — `0x1775` read as decimal
  // 1775 and named the wrong error, and a hex code containing letters produced
  // `Number("abc")`, which is how "refused it with code NaN" reached the log.
  const decimal = /"?Custom"?\s*:\s*(\d+)/.exec(text)?.[1];
  const hex = /custom program error:\s*0x([0-9a-f]+)/i.exec(text)?.[1];
  const custom = decimal ?? hex;
  if (custom) {
    const code = decimal ? Number(decimal) : parseInt(hex!, 16);
    const known = PROGRAM_ERRORS.get(code);
    if (known) {
      return new ChainSendError(`${known.name}: ${known.msg ?? "no message in the IDL"}`, {
        signature,
        code,
        logs,
      });
    }
    // An unknown code still names itself in both bases, because the next person
    // reading this log will be looking it up in a source file that uses one and
    // an explorer that uses the other.
    return new ChainSendError(
      `the program refused it with code ${code} (0x${code.toString(16)})`,
      { signature, code, logs }
    );
  }

  return new ChainSendError(text.split("\n")[0].slice(0, 200), { signature, logs });
}

/**
 * Sign, send, and wait for a verdict.
 *
 * Resolves with the signature once the cluster has confirmed it, and throws a
 * `ChainSendError` naming the reason otherwise. Never resolves on "sent but
 * unknown": a caller that needs to know whether money moved must not be told
 * "probably", so an unresolved transaction throws with `signature` set for
 * whoever has to reconcile it.
 */
export async function sendChainTx(opts: {
  tx: Transaction;
  signers: Keypair[];
  /**
   * Skip the preflight simulation.
   *
   * Worth it where a refusal is ordinary and cheap to discover late — the
   * settlement sweep races itself by design, and simulating every attempt to
   * learn that costs a request per position for information the send returns
   * anyway.
   */
  skipPreflight?: boolean;
}): Promise<string> {
  const conn = connection();
  const { tx, signers } = opts;

  const latest = await conn.getLatestBlockhash(COMMITMENT);
  tx.recentBlockhash = latest.blockhash;
  tx.feePayer ??= signers[0]?.publicKey;
  tx.sign(...signers);

  let signature: string;
  try {
    signature = await conn.sendRawTransaction(tx.serialize(), {
      skipPreflight: opts.skipPreflight ?? false,
      preflightCommitment: COMMITMENT,
    });
  } catch (err) {
    // Refused before it was forwarded, so nothing can land. Preflight failures
    // arrive here with their logs attached, which is the good case.
    const logs = (err as { logs?: string[] }).logs ?? null;
    throw describeChainError(err, null, logs);
  }

  const deadline = Date.now() + CONFIRM_TIMEOUT_MS;
  for (;;) {
    let status = null;
    try {
      status = (await conn.getSignatureStatus(signature, { searchTransactionHistory: true })).value;
    } catch {
      // A failed read says nothing about the transaction; ask again.
    }

    if (status?.err) {
      // The logs live on the transaction, not the status, and they are the only
      // place the program's own `msg!` output appears.
      let logs: string[] | null = null;
      try {
        const parsed = await conn.getTransaction(signature, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        });
        logs = parsed?.meta?.logMessages ?? null;
      } catch {
        /* the error stands without them */
      }
      throw describeChainError(JSON.stringify(status.err), signature, logs);
    }

    if (status && (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized")) {
      return signature;
    }

    if (!status) {
      // Only an expired blockhash makes absence conclusive.
      try {
        if ((await conn.getBlockHeight(COMMITMENT)) > latest.lastValidBlockHeight) {
          throw new ChainSendError("the transaction expired before it was confirmed", { signature });
        }
      } catch (err) {
        if (err instanceof ChainSendError) throw err;
        /* could not check the height — keep waiting */
      }
    }

    if (Date.now() > deadline) {
      throw new ChainSendError(
        "the transaction was sent but not confirmed in time — it may still land",
        { signature }
      );
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}
