import { useEffect } from "react";
import { useScrollLock } from "./useScrollLock";
import { useQuery } from "@apollo/client/react";
import { CoinIcon } from "./CoinIcon";
import { ROUNDS, type CryptoBet, type Round } from "./graphql";

/** Settled rounds. Picking one replays it in place of the live board. */
export function PreviousRounds({
  open,
  onClose,
  onReplay,
  bets,
}: {
  open: boolean;
  onClose: () => void;
  /** Hand the chosen round to the page, which switches into replay. */
  onReplay: (round: Round) => void;
  bets: CryptoBet[];
}) {
  const { data } = useQuery(ROUNDS, {
    variables: { limit: 12 },
    skip: !open,
    fetchPolicy: "cache-and-network",
  });

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useScrollLock(open);

  if (!open) return null;

  const rounds = (data?.cryptoRounds ?? []).filter((r) => r.status === "SETTLED");

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 py-10"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Previous rounds"
        onClick={(e) => e.stopPropagation()}
        className="casino-animate-in w-full max-w-3xl rounded-lg border border-hairline bg-surface"
      >
        <div className="flex items-center justify-between border-b border-hairline px-5 py-3">
          <h2 className="text-base font-semibold text-foreground">Previous rounds</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded px-2 py-1 text-muted hover:text-foreground"
          >
            ✕
          </button>
        </div>

        {!rounds.length ? (
          <p className="px-5 py-10 text-center text-sm text-muted">
            No rounds have settled yet.
          </p>
        ) : (
          <ul className="m-0 list-none p-0">
            {rounds.map((r) => (
              <RoundRow
                key={r.id}
                round={r}
                bets={bets.filter((b) => b.roundId === r.id)}
                onReplay={() => onReplay(r)}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function RoundRow({
  round,
  bets,
  onReplay,
}: {
  round: Round;
  bets: CryptoBet[];
  onReplay: () => void;
}) {
  const winner = round.entries.find((e) => e.cutRank === 1);
  const net = bets.reduce((n, b) => n + b.payout - b.stake, 0);
  const when = new Date(round.startsAt).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <li className="border-b border-hairline/60 last:border-b-0">
      <button
        type="button"
        onClick={onReplay}
        title="Replay this round"
        className="flex w-full items-center gap-3 px-5 py-3 text-left hover:bg-inset"
      >
        <span className="font-mono text-xs tabular-nums text-muted">{when}</span>
        {winner && (
          <CoinIcon ticker={winner.ticker} src={winner.imageUrl} size={20} />
        )}
        <span className="min-w-0 flex-1 truncate text-sm text-foreground">
          <span className="font-semibold">{winner?.ticker ?? "—"}</span>
          <span className="ml-1.5 text-muted">took the crown</span>
        </span>
        {bets.length > 0 && (
          <span
            className="font-mono text-xs tabular-nums"
            style={{ color: net > 0 ? "var(--up)" : net < 0 ? "var(--down)" : "var(--text-muted)" }}
          >
            {net > 0 ? "+" : ""}
            {net}
          </span>
        )}
        <span className="shrink-0 text-xs text-secondary">Replay →</span>
      </button>
    </li>
  );
}
