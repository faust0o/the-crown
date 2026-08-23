import { useEffect, useRef } from "react";
import { useScrollLock } from "./useScrollLock";

const STEPS = [
  {
    title: "Ten assets, one crown",
    body: "The field is ranked by how much was actually traded in the trailing hour — not by price. Volume comes from tokens.xyz and refreshes about once a minute; the flow feed on the right lists every place the ranking has changed this round.",
  },
  {
    title: "Bet on rank, not price",
    body: "For each coin you back Higher, Same or Lower: where its rank lands versus where it started the round. Rank is zero-sum — one coin only climbs if another falls — so 'everything goes up' isn't a strategy here.",
  },
  {
    title: "Prices differ for a reason",
    body: "A token clinging to its spot is priced differently from one being chased. Steady rows pay little for Same; contested rows pay a lot.",
  },
  {
    title: "You can't bet the crown",
    body: "Whoever finished first last round wears the crown, and you can't back it. Any token can take it — win the crown by ending a round in first place.",
  },
  {
    title: "The cut",
    body: "Betting closes a minute before the round ends, then the round settles at a random instant inside that final minute rather than at a known deadline — so volume bought at the buzzer can't decide it.",
  },
  {
    title: "Provably not rigged",
    body: "That instant is committed before the round opens: we publish sha256(seed), and reveal the seed at settlement. The cut is HMAC(seed, roundId), so anyone can recompute it and check it against the commitment.",
  },
];

/** Modal explaining the market. Focus is trapped to the close button on open. */
export function HowItWorks({ open, onClose }: { open: boolean; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useScrollLock(open);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="How The Crown works"
        onClick={(e) => e.stopPropagation()}
        className="casino-animate-in max-h-[85dvh] w-full max-w-lg overflow-y-auto rounded-lg border border-hairline bg-surface p-6"
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <h2 className="text-lg font-semibold text-foreground">How The Crown works</h2>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded px-2 py-1 text-muted hover:text-foreground"
          >
            ✕
          </button>
        </div>
        <ol className="m-0 list-none space-y-4 p-0">
          {STEPS.map((s, i) => (
            <li key={s.title} className="flex gap-3">
              <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-inset font-mono text-xs text-secondary">
                {i + 1}
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-foreground">{s.title}</span>
                <span className="mt-0.5 block text-sm leading-relaxed text-secondary">
                  {s.body}
                </span>
              </span>
            </li>
          ))}
        </ol>
        <p className="mt-5 text-xs text-muted">
          Credits are play money. Nothing here is a real financial instrument.
        </p>
      </div>
    </div>
  );
}
