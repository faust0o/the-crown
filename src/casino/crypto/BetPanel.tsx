import { useQuery } from "@apollo/client/react";
import { useId, useState } from "react";
import { formatCompact, formatCredits } from "../format";
import { CoinIcon } from "./CoinIcon";
import { Marquee } from "./Marquee";
import {
  BUY_QUOTE,
  SELL_QUOTE,
  type CryptoBet,
  type CryptoBuyQuote,
  type Direction,
  type Entry,
  type Standing,
} from "./graphql";
import { Amount, Button, Chip, cx, Empty, Panel, Seam, type Tone } from "../ui";

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

const SIDES = [
  { value: "buy", label: "Buy" },
  { value: "sell", label: "Sell" },
] as const satisfies readonly { value: Side; label: string }[];

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
  /**
   * Resolves true once the bet is placed — not on a sign-in prompt or a failure.
   * `maxCents` is the fill this ticket quoted; worse than that is refused.
   */
  onPlace: (stake: number, maxCents: number) => Promise<boolean>;
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

  /**
   * What this stake would fill at and pay, from the server, at this size.
   *
   * Not `amount * line.multiplier`. The board's price is what the *next* credit
   * pays; a stake that is big against the pool walks the line up as it fills
   * and pays the average of the walk. Multiplying the board price out quoted a
   * 10,000 stake on a 17¢ line at nearly 60,000 to win, and it paid 14,000.
   */
  const { data: bought, loading: quoting } = useQuery(BUY_QUOTE, {
    variables: { symbol: standing?.symbol ?? "", direction, stake: amount },
    skip: !isBuy || !standing || amount <= 0 || !line?.available,
    pollInterval: POLL_MS,
    fetchPolicy: "cache-and-network",
    errorPolicy: "all",
  });
  const fill = isBuy ? (bought?.cryptoBuyQuote ?? null) : null;

  if (!standing || !entry) {
    return (
      <Panel as="section" aria-label="Ticket" className="mb-4">
        <Empty>Pick a coin from the board to place a bet.</Empty>
      </Panel>
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
    fill != null &&
    amount > 0 &&
    (!signedIn || (credits ?? 0) >= amount);
  const canSell =
    signedIn && roundOpen && !selling && amount > 0 && position > 0 && sale != null;
  const ready = isBuy ? canPlace : canSell;

  /** Why the key is dark. Never a guess: the round, the amount, the balance, the book, in that order. */
  const refusal = isBuy
    ? crowned
      ? "The reigning coin can't be bet on."
      : (disabledReason ??
        (amount <= 0
          ? "Enter an amount."
          : signedIn && (credits ?? 0) < amount
            ? "Not enough balance."
            : "Unavailable for this coin."))
    : !signedIn
      ? "Sign in to see what you're holding."
      : position === 0
        ? `No open position on ${standing.ticker}.`
        : (disabledReason ?? "That line is no longer on the book.");

  return (
    /*
      A card, where every other section on the page is flat: this is the one
      instrument on it you operate rather than read, and it is built the way the
      dialogs are — a plate across the top saying what it is about, a seam, and
      the face under it.
    */
    <Panel as="section" aria-label="Ticket" className="mb-4">
      <div className="mat-plate px-4 pt-3">
        <div className="flex items-center gap-3">
          <CoinIcon ticker={standing.ticker} src={standing.imageUrl} size={40} />
          <div className="min-w-0 flex-1">
            {/* What the market is about, then what is being traded in it. */}
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
            <div className="flex min-w-0 items-baseline gap-2">
              <span className="mat-engrave shrink-0 text-lg font-semibold leading-snug text-foreground">
                {standing.ticker}
              </span>
              <Marquee text={standing.name} className="min-w-0 flex-1 text-sm text-muted" />
            </div>
          </div>
        </div>

        {/* The switch, at the foot of the plate: everything under the seam
            changes with it. Opposite it, the number that caps the amount — the
            balance while buying, the position while selling. Signed out it is
            blank rather than "$0": neither exists until there is an account to
            hold it, and a zero would read as an empty balance rather than as
            no balance. */}
        <div className="mt-2 flex items-baseline justify-between gap-3">
          <SideTabs value={side} onChange={setSide} />
          {signedIn && (
            <span className="font-mono text-[11px] tabular-nums text-muted">
              {isBuy ? `${formatCredits(credits)} free` : `${formatCredits(position)} held`}
            </span>
          )}
        </div>
      </div>
      <Seam />

      <div className="p-4">
        {crowned && isBuy && (
          <div
            title="The reigning token can't be backed. Win the crown by finishing first."
            className="mb-3 cursor-help text-sm text-gold"
          >
            Wearing the crown — no book this round.
          </div>
        )}

        {/* The three outcomes. Buying, each carries its price; selling, what is
            standing on it. What a line claims is in the tooltip rather than a
            paragraph underneath — the wording never changes, and it cost the
            panel two lines forever. */}
        <div className="grid grid-cols-3 gap-2">
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
                className="px-2 py-2"
              >
                <span
                  className="block text-center text-[10px] font-semibold uppercase tracking-wide"
                  style={{ color: "var(--tone)" }}
                >
                  {tone.label}
                </span>
                <span className="block text-center font-mono text-base font-semibold tabular-nums text-foreground">
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

        <div className="mt-4 flex items-center justify-between gap-3">
          <label htmlFor={amountId} className="shrink-0 text-sm text-foreground">
            Amount
          </label>
          <Amount
            id={amountId}
            value={amount}
            onValue={setAmount}
            aria-label={isBuy ? "Stake in dollars" : "Dollars of position to sell"}
          />
        </div>

        <div className="mt-2.5 flex items-center justify-end gap-1.5">
          {isBuy
            ? STAKES.map((s) => (
                <Button
                  key={s}
                  size="sm"
                  disabled={ceiling != null && amount >= ceiling}
                  onClick={() => addAmount(s)}
                  aria-label={`Add $${s}`}
                  className="min-w-12 font-mono tabular-nums"
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
                  className="min-w-12 font-mono tabular-nums"
                >
                  {f * 100}%
                </Button>
              ))}
          <Button
            size="sm"
            disabled={!ceiling || amount >= ceiling}
            onClick={() => ceiling != null && setAmount(ceiling)}
            title={isBuy ? "Stake every credit you hold" : "Sell the whole position"}
            className="min-w-12 font-mono uppercase tabular-nums"
          >
            Max
          </Button>
        </div>
      </div>

      {/* A tear line, not a seam: what is above it is the order being composed,
          and below it is what the order comes to. */}
      <div aria-hidden="true" className="border-t border-dashed border-hairline" />

      <div className="p-4">
        {/* What the ticket is worth on the other side of the key. Buying, that
            is the payout if the line lands; selling, it is the cash, now. With
            no line to buy there is no payout to quote, so the row is left out. */}
        {isBuy ? (
          line?.available && (
            <Payout
              label="To win"
              detail={fill ? fillDetail(fill, line.cents, amount) : `price ${line.cents}¢`}
              value={fill ? formatCredits(fill.payout) : "—"}
              color="var(--up)"
            />
          )
        ) : (
          <Payout
            label="You receive"
            detail={sale ? `price ${sale.cents}¢ · ${formatSigned(sale.payout - sale.sold)}` : "no bid"}
            value={sale ? formatCredits(sale.payout) : "—"}
            color="var(--sell-ink)"
          />
        )}

        {/* The one lit control on the page: the thing the page is for. Blue
            buying and amber selling — the same lamp, and which colour it is is
            the whole statement about which way the money goes. */}
        <Button
          variant="glass"
          side={isBuy ? "buy" : "sell"}
          size="lg"
          block
          disabled={!ready}
          onClick={() => {
            if (isBuy) {
              if (!fill) return;
              setSide("buy");
              // Cleared once the bet is in, so the next tap can't buy the same
              // stake again by accident. Kept on a failure or a sign-in prompt,
              // and kept if they started typing the next one while it placed.
              void onPlace(amount, fill.cents).then((placed) => {
                if (placed) setStake((s) => (s === amount ? 0 : s));
              });
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
        {!ready && !(isBuy ? quoting && fill == null : pricing && sale == null) && (
          <p className="mt-2 mb-0 text-center text-[11px] text-muted">{refusal}</p>
        )}
      </div>
    </Panel>
  );
}

/**
 * Buy or sell, as tabs along the foot of the ticket's plate.
 *
 * Underlined rather than a segmented key, because they are the plate's own edge:
 * the bar under the chosen side sits on the seam, in the colour of the key at
 * the bottom of the ticket — blue in, amber out.
 */
function SideTabs({ value, onChange }: { value: Side; onChange: (side: Side) => void }) {
  return (
    <div role="tablist" aria-label="Buy or sell" className="flex gap-4">
      {SIDES.map((s) => {
        const on = s.value === value;
        return (
          <button
            key={s.value}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onChange(s.value)}
            className={cx(
              "border-b-2 bg-transparent px-0 pt-0.5 pb-2 text-sm transition-colors",
              on
                ? "mat-engrave font-semibold text-foreground"
                : "border-transparent text-muted hover:text-foreground"
            )}
            style={on ? { borderColor: s.value === "buy" ? "var(--buy-ink)" : "var(--sell-ink)" } : undefined}
          >
            {s.label}
          </button>
        );
      })}
    </div>
  );
}

/** What the order comes to: a caption and how it was priced, and the figure. */
function Payout({
  label,
  detail,
  value,
  color,
}: {
  label: string;
  detail: string;
  value: string;
  color: string;
}) {
  return (
    <div className="mb-3 flex items-end justify-between gap-3">
      <span className="min-w-0">
        <span className="block text-sm text-foreground">{label}</span>
        <span className="block font-mono text-[11px] tabular-nums text-muted">{detail}</span>
      </span>
      <span className="shrink-0 font-mono text-3xl leading-none tabular-nums" style={{ color }}>
        {value}
      </span>
    </div>
  );
}

/**
 * How a buy was priced. A stake big enough to move the line fills above the
 * board's price, and saying both is what explains a payout smaller than the
 * board's multiplier would suggest.
 */
function fillDetail(fill: CryptoBuyQuote, boardCents: number, stake: number): string {
  const price = fill.cents > boardCents ? `avg ${fill.cents}¢ (board ${boardCents}¢)` : `price ${fill.cents}¢`;
  return `${price} · ${(fill.payout / stake).toFixed(2)}x`;
}

/** A gain or a loss on a sale, against what the credits sold cost. */
function formatSigned(n: number): string {
  return `${n > 0 ? "+" : ""}${formatCredits(n)}`;
}
