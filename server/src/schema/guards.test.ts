import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { graphql, type GraphQLResolveInfo } from "graphql";
import type { PrismaClient } from "../generated/prisma";
import type { Context } from "../context";
import { limit, requireUser, resetLimits } from "./guards";
import { schema } from "./index";

/**
 * A database that reports being touched.
 *
 * The point of a guard is that a refused request never reaches the resolver, and
 * "never reaches" is not something an error message can demonstrate — a resolver
 * that ran, queried, and then threw looks identical from outside. Handing the
 * context a Prisma that throws on any access makes the difference observable.
 */
const forbiddenPrisma = new Proxy(
  {},
  {
    get(_t, prop) {
      throw new Error(`resolver reached the database (.${String(prop)}) despite the guard`);
    },
  }
) as PrismaClient;

const ctxFor = (userId: string | null, ip = "203.0.113.7"): Context => ({
  prisma: forbiddenPrisma,
  userId,
  sessionId: userId ? `s-${userId}` : null,
  ip,
});

const infoFor = (parent: string, field: string) =>
  ({ parentType: { name: parent }, fieldName: field }) as GraphQLResolveInfo;

const call = (guard: ReturnType<typeof limit>, ctx: Context, info: GraphQLResolveInfo) =>
  guard(() => "ok", null, {}, ctx, info);

describe("field guards", () => {
  beforeEach(() => resetLimits());

  it("refuses an anonymous caller and lets a signed-in one through", async () => {
    const info = infoFor("Mutation", "placeCryptoBet");
    await assert.rejects(
      () => requireUser(() => "ok", null, {}, ctxFor(null), info),
      /Log in/
    );
    assert.equal(await requireUser(() => "ok", null, {}, ctxFor("u1"), info), "ok");
  });

  it("allows exactly `max` calls in a window, then refuses", async () => {
    const guard = limit(3, 60_000);
    const info = infoFor("Mutation", "walletLogin");
    const ctx = ctxFor(null);

    for (let i = 0; i < 3; i++) assert.equal(await call(guard, ctx, info), "ok");
    await assert.rejects(() => call(guard, ctx, info), /going too fast/);
  });

  it("tells the caller how long to wait", async () => {
    const guard = limit(1, 60_000);
    const info = infoFor("Mutation", "walletLogin");
    await call(guard, ctxFor(null), info);
    await assert.rejects(
      () => call(guard, ctxFor(null), info),
      (err: { extensions?: Record<string, unknown> }) => {
        assert.equal(err.extensions?.code, "RATE_LIMITED");
        assert.ok(Number(err.extensions?.retryAfterSeconds) > 0);
        return true;
      }
    );
  });

  it("counts one user's calls separately from another's", async () => {
    const guard = limit(1, 60_000);
    const info = infoFor("Mutation", "placeCryptoBet");
    await call(guard, ctxFor("alice"), info);
    // Bob's budget is his own, and neither has spent the anonymous one.
    assert.equal(await call(guard, ctxFor("bob"), info), "ok");
    await assert.rejects(() => call(guard, ctxFor("alice"), info), /going too fast/);
  });

  it("does not let a signed-in caller shed their limit by changing address", async () => {
    const guard = limit(1, 60_000);
    const info = infoFor("Mutation", "placeCryptoBet");
    await call(guard, ctxFor("alice", "198.51.100.1"), info);
    await assert.rejects(
      () => call(guard, ctxFor("alice", "198.51.100.2"), info),
      /going too fast/
    );
  });

  it("budgets each field on its own", async () => {
    const guard = limit(1, 60_000);
    await call(guard, ctxFor("alice"), infoFor("Mutation", "placeCryptoBet"));
    assert.equal(
      await call(guard, ctxFor("alice"), infoFor("Mutation", "cashOutCryptoBet")),
      "ok"
    );
  });

  it("forgets a window once it has passed", async () => {
    const guard = limit(1, 1);
    const info = infoFor("Mutation", "walletLogin");
    await call(guard, ctxFor(null), info);
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(await call(guard, ctxFor(null), info), "ok");
  });
});

/**
 * The guards are only worth anything if they are actually on the schema the
 * server serves. These execute against that schema rather than against the
 * guard functions, so removing a line from the guard map fails a test.
 */
describe("the served schema carries its guards", () => {
  beforeEach(() => resetLimits());

  const run = (source: string, ctx: Context) =>
    graphql({ schema, source, contextValue: ctx });

  it("answers myCryptoBets for an anonymous caller with an empty list, not an error", async () => {
    const result = await run("{ myCryptoBets { id } }", ctxFor(null));
    assert.equal(result.errors, undefined);
    assert.deepEqual(result.data?.myCryptoBets, []);
  });

  it("does not let an anonymous myCryptoBets discard the rest of the document", async () => {
    // The regression this exists for. `myCryptoBets` is `nonNull.list.nonNull`,
    // so throwing inside it propagated the null to the nearest nullable parent —
    // for a root field, `data` itself. A logged-out visitor asking for the round
    // *and* their own bets in one document got `data: null`: a blank board and
    // "waiting for the first round…" printed over a round that was open.
    //
    // Asserting the empty list alone would not catch a reintroduction, because
    // the interesting part is what happens to the *other* fields beside it.
    const result = await run("{ cryptoRound { id } myCryptoBets { id } }", ctxFor(null));
    assert.equal(result.errors, undefined);
    assert.ok(result.data, "the document resolved rather than collapsing to data: null");
    assert.deepEqual(result.data?.myCryptoBets, []);
    assert.ok("cryptoRound" in (result.data ?? {}), "the round survived alongside it");
  });

  it("refuses logout to an anonymous caller, before the resolver runs", async () => {
    const result = await run("mutation { logout }", ctxFor(null));
    assert.equal(result.errors?.[0]?.extensions?.code, "UNAUTHENTICATED");
  });

  it("rate-limits walletLogin without ever reaching the database", async () => {
    const ctx = ctxFor(null);
    const source =
      'mutation { walletLogin(address: "11111111111111111111111111111111", ' +
      'nonce: "deadbeef", signature: "AA==") { token } }';

    // The budget is 10 per ten minutes. The first ten are refused by the
    // resolver — a nonce nobody issued — but they get that far; the eleventh
    // must be stopped by the guard, and either way `forbiddenPrisma` reports if
    // one of them ever reached the database.
    for (let i = 0; i < 10; i++) await run(source, ctx);

    const refused = await run(source, ctx);
    assert.equal(refused.errors?.[0]?.extensions?.code, "RATE_LIMITED");
  });
});
