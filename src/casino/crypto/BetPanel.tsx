import { useQuery } from "@apollo/client/react";
import { useId, useState } from "react";
import { formatCompact, formatCredits } from "../format";
import { CoinIcon } from "./CoinIcon";
import { Marquee } from "./Marquee";
import { SELL_QUOTE, type CryptoBet, type Direction, type Entry, type Standing } from "./graphql";
import {
  Amount,
  Button,
  Caption,
  Chip,
  Empty,
  Label,
  Section,
  Segmented,
  type Tone,
} from "../ui";

/** Buying, the chips stack: four taps on +25 is a hundred. */
const STAKES = [5, 25, 100] as const;

/**
 * Selling, they don't stack — they set.
 *
 * A sell already opens at the whole position, so chips that only add would be
 * four dead keys under it. A fraction of what is held is the useful move anyway
 * ("take half off"), and it is what every book's sell ticket offers.
 */
const FRACTIONS = [0.25, 0.5, 0.75] as const;

/** Matches the board's cadence: a quote older than the price beside it is a lie. */
const POLL_MS = 2_000;

const DIRECTIONS = ["HIGHER", "DRAW", "LOWER"] as const;

const TONE: Record<Direction, { label: string; blurb: string; tone: Tone }> = {
  HIGHER: { label: "Higher", blurb: "climbs the board", tone: "up" },
  DRAW: { label: "Same", blurb: "holds its rank", tone: "gold" },
  LOWER: { label: "Lower", blurb: "slips down", tone: "down" },
};

/** Which way the ticket is pointed. Buy opens a position, sell closes one. */
type Side = "buy" | "sell";

/**
 * Ticket for the selected coin.
 *
 * Every line is a claim about where this coin's *rank* lands at the cut,
 * relative to where it started the round — not about price. Rank is zero-sum
 * across the field, which is what stops "everything goes up" being a strategy.
 *
 * ## One panel, two directions
 *
 * Buy and sell are the same ticket, deliberately: three outcomes carrying a
 * number, one amount, what it pays, one key. Only the numbers differ — a buy
 * chip quotes the line's price and a sell chip quotes what you hold on it; the
 * buy pays out if it lands and the sell pays out now. A player who has learned
 * the panel once has learned it in both directions, which is the entire argument
 * for the shape every prediction market already uses.
 *
 * The sell side sells a *line*, not a lot. Three bets on HIGHER are one position
 * to the person holding them, and the server fills a sale oldest-lot-first out of
 * whichever rows it is spread across — so the amount here can be any part of it.
 * Which is why settled lots are nowhere on this panel: what is left of them is a
 * number in the portfolio, not a control here.
 */
export function BetPanel({
  standing,
  entry,
  bets,
  roundOpen,
  signedIn,
  disabledReason,
  direction,
  onDirection,
  busy,
  credits,
  onPlace,
  onSell,
  selling,
}: {
  standing: Standing | null;
  entry: Entry | null;
  bets: CryptoBet[];
  /** The round is open and taking money. Says nothing about who is asking. */
  roundOpen: boolean;
  /**
   * Whether there is an account behind the ticket.
   *
   * Signed out the panel is fully live rather than absent or greyed: the prices
   * are public, composing a bet is how someone decides they want one, and the
   * Buy key opens the wallet dialog instead of placing. Only the two things
   * that need an account — the balance and the position — are missing, and both
   * are missing rather than shown as zero, because "$0 free" is a claim about
   * an account that does not exist yet.
   */
  signedIn: boolean;
  disabledReason: string | null;
  direction: Direction;
  onDirection: (d: Direction) => void;
  busy: boolean;
  credits: number | null;
  onPlace: (stake: number) => void;
  /** Sell part or all of one line's position. */
  onSell: (direction: Direction, stake: number) => void;
  selling: boolean;
}) {
  const amountId = useId();
  const [side, setSide] = useState<Side>("buy");
  const [stake, setStake] = useState<number>(50);
  /**
   * How much of the position to sell — null until they say otherwise, which
   * means all of it.
   *
   * Selling out is the common exit and used to be one tap on a Close button; it
   * still is. Typing or tapping a chip takes it off the default and the number
   * is theirs from then on, clamped to what they hold.
   */
  const [sellInput, setSellInput] = useState<number | null>(null);
  const [sellLine, setSellLine] = useState<Direction | null>(null);

  /**
   * Point the ticket back at Buy when the coin changes.
   *
   * Adjusted during render rather than in an effect — switching coins is a
   * decision about the new one, and arriving on its Sell tab because the *last*
   * coin was being sold would be the panel remembering the wrong thing.
   */
  const [shown, setShown] = useState<string | null>(standing?.symbol ?? null);
  if (standing && standing.symbol !== shown) {
    setShown(standing.symbol);
    setSide("buy");
    setSellInput(null);
    setSellLine(null);
  }

  /**
   * What is still open, by line.
   *
   * Only `OPEN` rows: a settled or sold lot is history, and history is the
   * portfolio's panel. Listing them here put a Close button on a position that
   * was already closed — disabled, unexplained, and the only trace of a trade
   * that had gone through.
   */
  const held: Record<Direction, number> = { HIGHER: 0, DRAW: 0, LOWER: 0 };
  for (const bet of bets) if (bet.status === "OPEN") held[bet.direction] += bet.stake;
  const holding = DIRECTIONS.filter((d) => held[d] > 0);

  // The line the sell side is pointed at: what they picked, else the biggest
  // thing they hold, else whatever the board has them looking at.
  const sellDirection =
    sellLine && held[sellLine] > 0
      ? sellLine
      : (holding.sort((a, b) => held[b] - held[a])[0] ?? sellLine ?? direction);

  const isBuy = side === "buy";
  const line = entry?.lines.find((l) => l.direction === direction) ?? null;

  /** The stake, and the ceiling it may not pass: a balance to buy, a position to sell. */
  const position = held[sellDirection];
  const ceiling = isBuy
    ? credits == null || !signedIn
      ? null
      : Math.max(0, Math.floor(credits))
    : position;
  const amount = isBuy ? stake : Math.min(sellInput ?? position, position);
  const setAmount = (n: number) =>
    isBuy ? setStake(n) : setSellInput(ceiling == null ? n : Math.min(n, ceiling));
  const addAmount = (n: number) => setAmount(ceiling == null ? amount + n : Math.min(amount + n, ceiling));

  /**
   * What this sale would fetch, from the server, at this size.
   *
   * Not derived from each lot's `liveValue`: closing walks the pool back down, so
   * the price depends on how much is leaving, and only the server holds that
   * curve. The last time the two were confused the screen quoted the resting bid
   * against a size-aware payout, and the number on the screen was reliably the
   * kinder of the two.
   */
  const { data: quoted, loading: pricing } = useQuery(SELL_QUOTE, {
    variables: { symbol: standing?.symbol ?? "", direction: sellDirection, stake: amount },
    skip: isBuy || !standing || amount <= 0,
    pollInterval: POLL_MS,
    fetchPolicy: "cache-and-network",
    errorPolicy: "all",
  });
  const sale = isBuy ? null : (quoted?.cryptoSellQuote ?? null);

  if (!standing || !entry) {
    return (
      <Section title="Ticket">
        <Empty>Pick a coin from the board to place a bet.</Empty>
      </Section>
    );
  }

  const crowned = entry.isCrown;
  const moved = standing.rank - entry.startRank;
  const active = isBuy ? direction : sellDirection;

  // Signed out the key is lit against the book alone — there is no balance to
  // fall short of, and what it does is open the wallet dialog, which a closed
  // round or a coin with no line would not make any truer.
  const canPlace =
    roundOpen &&
    !busy &&
    Boolean(line?.available) &&
    amount > 0 &&
    (!signedIn || (credits ?? 0) >= amount);
  const canSell =
    signedIn && roundOpen && !selling && amount > 0 && position > 0 && sale != null;
  const ready = isBuy ? canPlace : canSell;

  /** Why the key is dark. Never a guess: the round, the balance, the book, in that order. */
  const refusal = isBuy
    ? crowned
      ? "The reigning coin can't be bet on."
      : (disabledReason ??
        (signedIn && (credits ?? 0) < amount
          ? "Not enough balance."
          : "Unavailable for this coin."))
    : !signedIn
      ? "Sign in to see what you're holding."
      : position === 0
        ? `No open position on ${standing.ticker}.`
        : (disabledReason ?? "That line is no longer on the book.");

  return (
    <Section title="Ticket">
      <div className="flex items-center gap-2.5 pb-2.5">
        <CoinIcon ticker={standing.ticker} src={standing.imageUrl} size={32} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-baseline gap-2 text-sm font-semibold text-foreground">
            <span className="shrink-0">{standing.ticker}</span>
            <Marquee text={standing.name} className="min-w-0 flex-1 font-normal text-muted" />
          </div>
          <div className="font-mono text-[11px] tabular-nums text-muted">
            rank {entry.startRank} → {standing.rank}
            {moved !== 0 && (
              <span style={{ color: moved < 0 ? "var(--up)" : "var(--down)" }}>
                {" "}
                {moved < 0 ? "▲" : "▼"} {Math.abs(moved)}
              </span>
            )}
            {" · $"}
            {formatCompact(standing.quoteVolume)}
          </div>
        </div>
      </div>

      {/* The switch, across the whole ticket: everything under it changes with it. */}
      <div className="border-b border-hairline pb-2">
        <Segmented
          tabs
          block
          size="sm"
          label="Buy or sell"
          value={side}
          onChange={setSide}
          options={[
            { value: "buy", label: "Buy" },
            { value: "sell", label: "Sell" },
          ]}
        />
      </div>

      {crowned && isBuy && (
        <div
          title="The reigning token can't be backed. Win the crown by finishing first."
          className="cursor-help pt-2.5 text-sm text-gold"
        >
          Wearing the crown — no book this round.
        </div>
      )}

      {/* The three outcomes. Buying, each carries its price; selling, what is
          standing on it. What a line claims is in the tooltip rather than a
          paragraph underneath — the wording never changes, and it cost the panel
          two lines forever. */}
      <div className="mt-2.5 grid grid-cols-3 gap-1.5">
        {DIRECTIONS.map((d) => {
          const tone = TONE[d];
          const l = entry.lines.find((x) => x.direction === d);
          const available = isBuy ? Boolean(l?.available) : held[d] > 0;
          return (
            <Chip
              key={d}
              tone={tone.tone}
              active={d === active}
              disabled={!available}
              onClick={() => {
                if (isBuy) onDirection(d);
                else {
                  setSellLine(d);
                  setSellInput(null);
                }
              }}
              title={`${standing.ticker} ${tone.blurb} by the cut, against its rank of ${entry.startRank} at the open`}
              className="px-2 py-1.5"
            >
              <span
                className="block text-[10px] font-semibold uppercase tracking-wide"
                style={{ color: "var(--tone)" }}
              >
                {tone.label}
              </span>
              <span className="block font-mono text-sm tabular-nums text-foreground">
                {isBuy
                  ? l?.available
                    ? `${l.cents}¢`
                    : "—"
                  : held[d] > 0
                    ? formatCredits(held[d])
                    : "—"}
              </span>
            </Chip>
          );
        })}
      </div>

      {/* The amount, and under its label the number that caps it — the balance
          while buying, the position while selling. */}
      <div className="mt-3 flex items-center justify-between gap-3">
        <span className="shrink-0">
          <Label htmlFor={amountId}>amount</Label>
          {/* Signed out this is blank rather than "$0": neither number exists
              until there is an account to hold it, and printing a zero would
              read as an empty balance rather than as no balance. */}
          {signedIn && (
            <span className="block font-mono text-[11px] tabular-nums text-muted">
              {isBuy ? `${formatCredits(credits)} free` : `${formatCredits(position)} held`}
            </span>
          )}
        </span>
        <Amount
          id={amountId}
          value={amount}
          onValue={setAmount}
          aria-label={isBuy ? "Stake in dollars" : "Dollars of position to sell"}
        />
      </div>

      <div className="mt-2 flex items-center gap-1.5">
        {isBuy
          ? STAKES.map((s) => (
              <Button
                key={s}
                size="sm"
                disabled={ceiling != null && amount >= ceiling}
                onClick={() => addAmount(s)}
                aria-label={`Add $${s}`}
                className="flex-1 font-mono tabular-nums"
              >
                +${s}
              </Button>
            ))
          : FRACTIONS.map((f) => (
              <Button
                key={f}
                size="sm"
                disabled={position <= 0}
                onClick={() => setAmount(Math.max(1, Math.floor(position * f)))}
                aria-label={`Sell ${f * 100}% of the position`}
                className="flex-1 font-mono tabular-nums"
              >
                {f * 100}%
              </Button>
            ))}
        <Button
          size="sm"
          disabled={!ceiling || amount >= ceiling}
          onClick={() => ceiling != null && setAmount(ceiling)}
          title={isBuy ? "Stake every credit you hold" : "Sell the whole position"}
          className="flex-1 font-mono uppercase tabular-nums"
        >
          Max
        </Button>
      </div>

      {/* What the ticket is worth on the other side of the key. Buying, that is
          the payout if the line lands; selling, it is the cash, now. */}
      <div className="mt-3 flex items-end justify-between gap-3 border-t border-hairline pt-2.5">
        <span className="min-w-0">
          <Caption>{isBuy ? "to win" : "you receive"}</Caption>
          <span className="block font-mono text-[11px] tabular-nums text-muted">
            {isBuy
              ? line?.available
                ? `${line.cents}¢ · ${line.multiplier.toFixed(2)}x`
                : "no line"
              : sale
                ? `${sale.cents}¢ · ${formatSigned(sale.payout - sale.sold)}`
                : "no bid"}
          </span>
        </span>
        <span
          className="shrink-0 font-mono text-xl tabular-nums"
          style={{ color: isBuy ? "var(--up)" : "var(--sell-ink)" }}
        >
          {isBuy
            ? line?.available
              ? formatCredits(amount * line.multiplier)
              : "—"
            : sale
              ? formatCredits(sale.payout)
              : "—"}
        </span>
      </div>

      {/* The one lit control on the page: the thing the page is for. Blue buying
          and amber selling — the same lamp, and which colour it is is the whole
          statement about which way the money goes. */}
      <Button
        variant="glass"
        side={isBuy ? "buy" : "sell"}
        size="lg"
        block
        className="mt-2.5"
        disabled={!ready}
        onClick={() => {
          if (isBuy) {
            setSide("buy");
            onPlace(amount);
          } else {
            onSell(sellDirection, amount);
            setSellInput(null);
          }
        }}
      >
        {isBuy
          ? busy
            ? "Placing…"
            : signedIn
              ? `Buy ${TONE[direction].label}`
              : // Says what the tap does. A lit key reading "Buy Higher" that
                // produces a wallet dialog is a small lie, and the ticket under
                // it survives the sign-in — nothing composed here is lost.
                "Sign in to buy"
          : selling
            ? "Selling…"
            : `Sell ${TONE[sellDirection].label}`}
      </Button>
      {/* Silent while the first quote is in flight: "no bid" is a claim about
          the book, and a panel that makes it before it has asked is wrong for
          the couple of hundred milliseconds anybody would actually read it. */}
      {!ready && !(pricing && sale == null) && (
        <p className="mt-2 mb-0 text-center text-[11px] text-muted">{refusal}</p>
      )}
    </Section>
  );
}

/** A gain or a loss on a sale, against what the credits sold cost. */
function formatSigned(n: number): string {
  return `${n > 0 ? "+" : ""}${formatCredits(n)}`;
}
