import { GraphQLError } from "graphql";
import type { GraphQLResolveInfo } from "graphql";
import type { IMiddlewareTypeMap } from "graphql-middleware";
import type { Context } from "../context";

/**
 * The one place a field says who may call it and how often.
 *
 * These checks used to live inside the resolvers, one `if (!ctx.userId)` at a
 * time, which meant every new field was a fresh chance to forget one — and the
 * failure is silent, because a field that forgets simply works. Here the guard
 * sits next to the field name, so what is unguarded is visible by reading a list
 * rather than by reading every resolver.
 *
 * Guards run before the resolver and can refuse without it ever executing, so a
 * rate-limited mutation costs a map lookup rather than a transaction.
 */

type Args = Record<string, unknown>;
type Next = (root?: unknown, args?: Args, ctx?: Context, info?: GraphQLResolveInfo) => unknown;
type Guard = (
  resolve: Next,
  root: unknown,
  args: Args,
  ctx: Context,
  info: GraphQLResolveInfo
) => Promise<unknown>;

const unauthorized = (message: string) =>
  new GraphQLError(message, { extensions: { code: "UNAUTHENTICATED" } });

const rateLimited = (retryAfterMs: number) =>
  new GraphQLError("You're going too fast — try again in a moment.", {
    extensions: {
      code: "RATE_LIMITED",
      retryAfterSeconds: Math.ceil(retryAfterMs / 1000),
    },
  });

/** Refuse anonymous callers. */
export const requireUser: Guard = async (resolve, root, args, ctx, info) => {
  if (!ctx.userId) throw unauthorized("Log in to do that.");
  return resolve(root, args, ctx, info);
};

/**
 * A caller's own rows — and for a caller who is nobody, no rows.
 *
 * `requireUser` is right for anything that *acts*: refusing is the only sound
 * answer to an anonymous attempt to place a bet. It is the wrong answer for a
 * field that means "the ones that are mine", because an anonymous caller does
 * have an answer to that and it is the empty list. Throwing instead was not a
 * stricter version of the same thing — it was a different, worse thing:
 *
 * `myCryptoBets` is declared `nonNull.list.nonNull`, so a throw could not stay
 * local to the field. GraphQL propagates the null up to the nearest nullable
 * parent, and for a root field that parent is `data` itself — so the entire
 * response came back `data: null`. A logged-out visitor asking for the board,
 * the tape, the oracle and their own bets in one document got *nothing*: a blank
 * board, an "oracle down" tape and "waiting for the first round…" printed over a
 * round that was demonstrably open. The server had the answers and discarded
 * them because the same document had also asked one question the caller could
 * not ask.
 *
 * Nothing is loosened by this. An anonymous caller still cannot see anybody's
 * bets; they see their own, of which there are none.
 */
export const mineOrEmpty: Guard = async (resolve, root, args, ctx, info) => {
  if (!ctx.userId) return [];
  return resolve(root, args, ctx, info);
};

/**
 * The same reasoning as `mineOrEmpty`, for a field whose empty answer is null.
 *
 * A nullable field can carry its own "there is nothing here" without taking the
 * document down with it, and "what would my position fetch" has an honest answer
 * for a caller who holds nothing: none.
 */
export const mineOrNull: Guard = async (resolve, root, args, ctx, info) => {
  if (!ctx.userId) return null;
  return resolve(root, args, ctx, info);
};

/**
 * Fixed-window counter, in memory.
 *
 * In memory because there is one server process and the limits exist to stop a
 * single client hammering a mutation, not to enforce a quota across a fleet.
 * Move it to Redis the day a second instance exists — until then a shared store
 * would add a network hop to every bet for no protection this doesn't give.
 *
 * Keyed on the user where there is one and the address where there isn't, so a
 * logged-in abuser can't shed their limit by rotating IPs and a logged-out one
 * can't consume everybody else's budget.
 */
interface Window {
  count: number;
  resetAt: number;
}
const windows = new Map<string, Window>();

/** Keep the map from growing without bound on a long-lived process. */
function sweep(now: number): void {
  if (windows.size < 10_000) return;
  for (const [key, w] of windows) if (w.resetAt <= now) windows.delete(key);
}

export function limit(max: number, windowMs: number): Guard {
  return async (resolve, root, args, ctx, info) => {
    const now = Date.now();
    const key = `${info.parentType.name}.${info.fieldName}|${ctx.userId ?? `ip:${ctx.ip}`}`;
    const w = windows.get(key);

    if (!w || w.resetAt <= now) {
      sweep(now);
      windows.set(key, { count: 1, resetAt: now + windowMs });
    } else if (w.count >= max) {
      throw rateLimited(w.resetAt - now);
    } else {
      w.count += 1;
    }

    return resolve(root, args, ctx, info);
  };
}

/** Test seam — the counters are process-global and would otherwise leak between tests. */
export function resetLimits(): void {
  windows.clear();
}

/**
 * Run guards left to right, each deciding whether the next one gets to run.
 *
 * The inner call rebuilds the `(root, args, ctx, info)` tuple rather than
 * forwarding whatever a guard happened to pass, so a guard cannot — by accident
 * or otherwise — hand the resolver a different context than the one it was
 * checked against. That is the whole safety property of a chain like this.
 */
const chain =
  (...guards: Guard[]): Guard =>
  (resolve, root, args, ctx, info) => {
    const step = (i: number): Promise<unknown> =>
      i === guards.length
        ? Promise.resolve(resolve(root, args, ctx, info))
        : guards[i](() => step(i + 1), root, args, ctx, info);
    return step(0);
  };

/**
 * Budgets are per field and deliberately generous — the game ticks every second
 * and the UI polls, so these are a ceiling on abuse rather than a throttle
 * anyone playing normally will meet.
 *
 * The two wallet sign-in fields are the strict ones. They are the only
 * unauthenticated writes, one of them creates rows, and together they are the
 * single gate on the whole product — so they are where the cost of hammering
 * has to stay high. `walletChallenge` is the looser of the pair because it is
 * the retry path: a rejected wallet prompt, a switched account or an expired
 * nonce all send an honest player back through it.
 */
export const guards: IMiddlewareTypeMap<unknown, Context, Args> = {
  Query: {
    me: limit(120, 60_000),
    myCryptoBets: chain(mineOrEmpty, limit(240, 60_000)),
    roundReplay: limit(120, 60_000),
    roundTokens: limit(120, 60_000),
    cryptoRounds: limit(120, 60_000),
    cryptoRankHistory: limit(240, 60_000),
    orders: limit(600, 60_000),
    // Polled while the amount is being typed, so its budget is a panel's, not a
    // trade's — the trade it precedes is `sellCryptoPosition` below.
    cryptoSellQuote: chain(mineOrNull, limit(600, 60_000)),
    // The buy side's, public like the board it prices.
    cryptoBuyQuote: limit(600, 60_000),
  },
  Mutation: {
    walletChallenge: limit(20, 10 * 60_000),
    walletLogin: limit(10, 10 * 60_000),
    prepareCreditPurchase: chain(requireUser, limit(20, 60_000)),
    confirmCreditPurchase: chain(requireUser, limit(20, 60_000)),
    placeCryptoBet: chain(requireUser, limit(60, 60_000)),
    cashOutCryptoBet: chain(requireUser, limit(60, 60_000)),
    sellCryptoPosition: chain(requireUser, limit(60, 60_000)),
    logout: chain(requireUser, limit(20, 60_000)),
  },
};
