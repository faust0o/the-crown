import { useQuery } from "@apollo/client/react";
import { CoinIcon } from "./CoinIcon";
import { ROUNDS, type CryptoBet, type RoundResult } from "./graphql";
import { Dialog, Seam } from "../ui";

/** Finished rounds. Picking one replays it in place of the live board. */
export function PreviousRounds({
  open,
  onClose,
  onReplay,
  bets,
}: {
  open: boolean;
  onClose: () => void;
  /** Hand the chosen round to the page, which switches into replay. */
  onReplay: (round: RoundResult) => void;
  bets: CryptoBet[];
}) {
  const { data } = useQuery(ROUNDS, {
    variables: { limit: 12 },
    skip: !open,
    fetchPolicy: "cache-and-network",
  });

  // No filter. A round belongs in the history once its cut is recorded, which
  // is what `cryptoRounds` now returns — the result is the board at that
  // instant, and whether the bets on it have been paid yet is a different job
  // with its own failure modes. Filtering on SETTLED here meant a stalled payout
  // run presented as an empty history.
  const rounds = data?.cryptoRounds ?? [];

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Previous rounds"
      size="xl"
      align="start"
      bodyClassName="p-0"
    >
      {!rounds.length ? (
        <p className="px-5 py-10 text-center text-sm text-muted">
          No rounds have finished yet.
        </p>
      ) : (
        <ul className="m-0 list-none p-0">
          {rounds.map((r, i) => (
            <li key={r.id}>
              {i > 0 && <Seam />}
              <RoundRow
                round={r}
                bets={bets.filter((b) => b.roundId === r.id)}
                onReplay={() => onReplay(r)}
              />
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}

function RoundRow({
  round,
  bets,
  onReplay,
}: {
  round: RoundResult;
  bets: CryptoBet[];
  onReplay: () => void;
}) {
  const winner = round.entries.find((e) => e.cutRank === 1);
  // Only once every position on it has resolved. An open bet has a payout of
  // zero because it has not been paid, not because it lost, so summing them
  // during the gap between the cut and the payout reports a loss the player
  // has not taken.
  const settled = bets.every((b) => b.status !== "OPEN");
  const net = bets.reduce((n, b) => n + b.payout - b.stake, 0);
  const when = new Date(round.startsAt).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <button
      type="button"
      onClick={onReplay}
      title="Replay this round"
      className="flex w-full items-center gap-3 px-5 py-3 text-left transition-colors hover:bg-[color-mix(in_oklch,var(--foreground)_5%,transparent)]"
    >
      <span className="font-mono text-xs tabular-nums text-muted">{when}</span>
      {winner && <CoinIcon ticker={winner.ticker} src={winner.imageUrl} size={20} />}
      <span className="min-w-0 flex-1 truncate text-sm text-foreground">
        <span className="font-semibold">{winner?.ticker ?? "—"}</span>
        <span className="ml-1.5 text-muted">took the crown</span>
      </span>
      {bets.length > 0 &&
        (settled ? (
          <span
            className="font-mono text-xs tabular-nums"
            style={{ color: net > 0 ? "var(--up)" : net < 0 ? "var(--down)" : "var(--text-muted)" }}
          >
            {net > 0 ? "+" : ""}
            {net}
          </span>
        ) : (
          <span className="text-xs text-muted">settling…</span>
        ))}
      <span className="shrink-0 text-xs text-secondary">Replay →</span>
    </button>
  );
}
