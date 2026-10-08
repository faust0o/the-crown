import { useQuery } from "@apollo/client/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ROUNDS, type RankPoint } from "../casino/crypto/graphql";
import { fieldOf, moversOf } from "../casino/crypto/race";
import { STREAM_BOARD, type StreamEntry } from "./queries";
import type { Crowning, Race } from "./scene";

/** The oracle's own re-rank cadence, as on the board page. */
const POLL_MS = 2_000;
/** How long a finished round is asked after before it is given up on. */
const GIVE_UP_MS = 120_000;

interface Decided {
  id: string;
  startsAt: string;
  endsAt: string;
  entries: { symbol: string; ticker: string; imageUrl: string | null; startRank: number; cutRank: number | null }[];
}

/**
 * The race, polled, and the moment it is decided.
 *
 * A round is crowned when the stream sees its cut: the live round goes from
 * racing (OPEN, LOCKED) to CUT with a coin at rank 1. The cut lands at a random
 * instant in the round's last minute, so that is the moment the outcome exists
 * — announcing it then is announcing it live. If the cut and the round's end
 * fall between two polls, the round simply vanishes from the board, and the
 * finished round is fetched until it shows how it was cut.
 *
 * Only a round watched while it was still racing is ever announced. A stream
 * opened during a cut window would otherwise lead with a result from before it
 * went on air; a round cut with no ranks — the feed failed and every bet was
 * refunded — has no winner, and is let pass without one.
 */
export function useRace(): {
  race: Race;
  history: RankPoint[];
  crowning: Crowning | null;
  rehearse: () => void;
  error: boolean;
} {
  const { data, error } = useQuery(STREAM_BOARD, {
    variables: { minutes: 90 },
    pollInterval: POLL_MS,
    fetchPolicy: "cache-and-network",
    errorPolicy: "all",
  });
  const round = data?.cryptoRound ?? null;
  const standings = useMemo(() => data?.cryptoStandings ?? [], [data?.cryptoStandings]);
  const history = useMemo(() => data?.cryptoRankHistory ?? [], [data?.cryptoRankHistory]);

  const [crowning, setCrowning] = useState<Crowning | null>(null);
  const [ended, setEnded] = useState<string | null>(null);
  const racing = useRef(new Set<string>());
  const announced = useRef(new Set<string>());
  const watching = useRef<string | null>(null);

  const crown = useCallback((r: Decided) => {
    if (announced.current.has(r.id)) return;
    announced.current.add(r.id);
    const winner = r.entries.find((e) => e.cutRank === 1);
    if (!winner) return;
    setCrowning({
      roundId: r.id,
      symbol: winner.symbol,
      ticker: winner.ticker,
      imageUrl: winner.imageUrl,
      startRank: winner.startRank,
      startsAt: r.startsAt,
      endsAt: r.endsAt,
      rehearsal: false,
      at: performance.now(),
    });
  }, []);

  useEffect(() => {
    if (!round) return; // between rounds: nothing has changed hands yet
    if (round.status === "OPEN" || round.status === "LOCKED") racing.current.add(round.id);
    else if (racing.current.has(round.id)) crown(round);

    const previous = watching.current;
    if (previous && previous !== round.id && racing.current.has(previous) && !announced.current.has(previous)) {
      setEnded(previous);
    }
    watching.current = round.id;
  }, [round, crown]);

  const { data: recent } = useQuery(ROUNDS, {
    variables: { limit: 3 },
    skip: !ended,
    pollInterval: POLL_MS,
    fetchPolicy: "network-only",
  });
  useEffect(() => {
    if (!ended) return;
    const r = recent?.cryptoRounds.find(
      (x) => x.id === ended && (x.status === "CUT" || x.status === "SETTLED")
    );
    if (!r) return;
    crown(r);
    setEnded(null);
  }, [ended, recent, crown]);
  useEffect(() => {
    if (!ended) return;
    const timer = setTimeout(() => setEnded(null), GIVE_UP_MS);
    return () => clearTimeout(timer);
  }, [ended]);

  const entries = useMemo(
    () => new Map<string, StreamEntry>((round?.entries ?? []).map((e) => [e.symbol, e])),
    [round]
  );
  const field = useMemo(() => fieldOf(round, standings), [round, standings]);
  const movers = useMemo(() => moversOf(field, entries), [field, entries]);
  const race = useMemo<Race>(
    () => ({ field, entries, movers, round, window: data?.oracleStatus?.window ?? "1h" }),
    [field, entries, movers, round, data?.oracleStatus?.window]
  );

  /** Run the crown moment on whoever leads now, to see it before the room does. */
  const rehearse = useCallback(() => {
    const leader = field[0];
    if (!leader) return;
    setCrowning({
      roundId: `rehearsal-${Date.now()}`,
      symbol: leader.symbol,
      ticker: leader.ticker,
      imageUrl: leader.imageUrl,
      startRank: entries.get(leader.symbol)?.startRank ?? null,
      startsAt: round?.startsAt ?? null,
      endsAt: round?.endsAt ?? null,
      rehearsal: true,
      at: performance.now(),
    });
  }, [field, entries, round]);

  return { race, history, crowning, rehearse, error: Boolean(error) && !data };
}
