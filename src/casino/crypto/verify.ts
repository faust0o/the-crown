import { useEffect, useState } from "react";

/**
 * Client-side check of a settled round's commitment.
 *
 * The server publishes sha256(seed) when a round opens and the seed once it
 * settles, deriving the cut instant as HMAC-SHA256(seed, roundId) mod the cut
 * window. Recomputing both in the browser is the whole point of committing to
 * it — a claim the client can't check is just a claim.
 *
 * WebCrypto is async, so this is a hook rather than a plain function. An earlier
 * version returned placeholders synchronously and compared those, which made
 * every honest round display as a MISMATCH.
 */
export type Verdict = "pending" | "verified" | "mismatch";

const enc = new TextEncoder();
const hex = (buf: ArrayBuffer) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

export function useRoundVerification(round: {
  id: string;
  seed: string | null;
  commitHash: string;
  cutAt: string | null;
  lockAt: string;
  cutWindowSeconds: number;
}): Verdict {
  const [verdict, setVerdict] = useState<Verdict>("pending");
  const { id, seed, commitHash, cutAt, lockAt, cutWindowSeconds } = round;

  useEffect(() => {
    if (!seed || !cutAt) {
      setVerdict("pending");
      return;
    }
    let live = true;
    void (async () => {
      try {
        const digest = hex(await crypto.subtle.digest("SHA-256", enc.encode(seed)));
        const key = await crypto.subtle.importKey(
          "raw",
          enc.encode(seed),
          { name: "HMAC", hash: "SHA-256" },
          false,
          ["sign"]
        );
        const sig = await crypto.subtle.sign("HMAC", key, enc.encode(id));
        const offset = new DataView(sig).getUint32(0) % (cutWindowSeconds * 1000);
        const expected = new Date(lockAt).getTime() + offset;
        // The loop ticks once a second, so the recorded cut can trail the
        // derived instant by up to that much without anything being wrong.
        const drift = Math.abs(new Date(cutAt).getTime() - expected);
        if (live) {
          setVerdict(digest === commitHash && drift <= 1500 ? "verified" : "mismatch");
        }
      } catch {
        if (live) setVerdict("pending");
      }
    })();
    return () => {
      live = false;
    };
  }, [id, seed, commitHash, cutAt, lockAt, cutWindowSeconds]);

  return verdict;
}
