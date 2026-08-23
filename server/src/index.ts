import http from "node:http";
import { ApolloServer } from "@apollo/server";
import { expressMiddleware } from "@apollo/server/express4";
import { ApolloServerPluginDrainHttpServer } from "@apollo/server/plugin/drainHttpServer";
import { ApolloServerPluginLandingPageDisabled } from "@apollo/server/plugin/disabled";
import { unwrapResolverError } from "@apollo/server/errors";
import compression from "compression";
import cors from "cors";
import express from "express";
import { GraphQLError } from "graphql";
import { seedDesks, startBots, stopBots } from "./bots";
import { createContext, type Context } from "./context";
import {
  CORS_ORIGINS,
  HAS_DATABASE_URL,
  IS_PRODUCTION,
  LOG_INVITE_CODES,
  PORT,
} from "./env";
import { graphqlLimiter, logoLimiter, securityHeaders, serveHealth, trustProxy } from "./http";
import { mountRpcProxy } from "./chain/rpc-proxy";
import { startChain, stopChain } from "./chain/runner";
import { CHAIN_MODE } from "./env";
import { seedInviteCodes } from "./invites";
import { serveLogoProxy } from "./logo-proxy";
import { oracle } from "./oracle/index";
import { prisma } from "./prisma";
import { startRoundLoop, stopRoundLoop } from "./rounds";
import { startSessionSweep, stopSessionSweep } from "./sessions";
import { schema } from "./schema/index";
import { costLimit, depthLimit } from "./schema/limits";
import { CLIENT_DIR, hasClientBuild, serveClient } from "./static";

/**
 * What a client is allowed to learn from a failed request.
 *
 * Errors we raise on purpose carry a `code` and a message written for a player,
 * so those pass through. Everything else is an accident — a Prisma constraint
 * name, a failed connection string, a stack — and the only safe thing to say
 * about an accident is that one happened. Apollo strips stack traces only when
 * `NODE_ENV=production`, which is a thing the platform sets rather than a thing
 * we control, so the decision is made here instead of inherited.
 */
const SAFE_CODES = new Set([
  "BAD_USER_INPUT",
  "GRAPHQL_VALIDATION_FAILED",
  "GRAPHQL_PARSE_FAILED",
  "UNAUTHENTICATED",
  "RATE_LIMITED",
  "QUERY_TOO_DEEP",
  "QUERY_TOO_COMPLEX",
  "PERSISTED_QUERY_NOT_FOUND",
  "PERSISTED_QUERY_NOT_SUPPORTED",
]);


/**
 * An RPC that is refusing us must not take the website down with it.
 *
 * web3.js confirms transactions over a websocket, and when the provider
 * rate-limits that socket the error surfaces from a subscription callback with
 * nothing awaiting it. Node treats that as an uncaught exception and exits — so
 * a burst of 429s, which is a thing that happens on a shared endpoint several
 * times an hour, was killing a process that also serves the board, the API and
 * the logo proxy. The symptom people reported was images intermittently failing
 * to load; the cause was the server restarting under them.
 *
 * Narrow on purpose. Only the transport errors are swallowed, and each is
 * logged: a programming mistake still crashes, loudly, which is what a crash is
 * for. The chain loop already treats every RPC call as failable and retries on
 * the next tick, so surviving one is a real recovery rather than a pretence.
 */
function survivesTransportErrors(): void {
  const transportish = (err: unknown): boolean => {
    const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return (
      /429|rate limit|Too Many Requests/i.test(text) ||
      /ECONNRESET|ETIMEDOUT|EPIPE|socket hang up|fetch failed/i.test(text) ||
      /Unexpected server response/i.test(text)
    );
  };

  process.on("uncaughtException", (err) => {
    if (!transportish(err)) throw err;
    console.warn("⚠  rpc transport:", err instanceof Error ? err.message.slice(0, 160) : err);
  });

  process.on("unhandledRejection", (reason) => {
    if (!transportish(reason)) throw reason;
    console.warn(
      "⚠  rpc transport:",
      reason instanceof Error ? reason.message.slice(0, 160) : String(reason).slice(0, 160)
    );
  });
}

async function main() {
  survivesTransportErrors();

  const app = express();
  const httpServer = http.createServer(app);

  const server = new ApolloServer<Context>({
    schema,
    // The schema is public knowledge for anyone reading the bundle, but an
    // always-on introspection endpoint is still a free map for a scanner — and
    // Apollo's own default keys off NODE_ENV, which the platform may not set.
    introspection: !IS_PRODUCTION,
    includeStacktraceInErrorResponses: !IS_PRODUCTION,
    validationRules: [depthLimit(), costLimit()],
    plugins: [
      ApolloServerPluginDrainHttpServer({ httpServer }),
      ...(IS_PRODUCTION ? [ApolloServerPluginLandingPageDisabled()] : []),
    ],
    formatError: (formatted, error) => {
      const code = formatted.extensions?.code;
      if (typeof code === "string" && SAFE_CODES.has(code)) return formatted;

      // Log the real thing where only we can read it, return a shape that says
      // nothing about how the server is built.
      console.error("graphql:", unwrapResolverError(error) ?? formatted.message);
      return new GraphQLError("Something went wrong.", {
        extensions: { code: "INTERNAL_SERVER_ERROR" },
      });
    },
  });
  await server.start();

  trustProxy(app);
  securityHeaders(app);
  serveHealth(app);

  // Inlined CSS makes the HTML ~40 KB; gzip takes it back under 10 KB.
  app.use(compression());

  // The browser's keyless route to the chain. Mounted before the SPA's static
  // handler so it is a route rather than a 404 rewritten to index.html.
  app.use("/rpc", express.json({ limit: "64kb" }));
  mountRpcProxy(app);

  // The SPA is now same-origin, so CORS only matters for outside callers.
  app.use(
    "/graphql",
    graphqlLimiter,
    cors<cors.CorsRequest>({ origin: CORS_ORIGINS }),
    // A GraphQL document is text. 1 MB of it is 1 MB to parse and validate
    // before a single limit gets a look at it; 64 KB is far beyond any real
    // query this client sends.
    express.json({ limit: "64kb" }),
    expressMiddleware(server, {
      context: async ({ req }) =>
        createContext(req.headers.authorization ?? null, req.ip ?? ""),
    })
  );

  serveLogoProxy(app, logoLimiter);
  serveClient(app);

  // A connection that opens and then dribbles bytes holds a socket for as long
  // as the server will let it. Node's defaults are generous; these are not.
  httpServer.headersTimeout = 20_000;
  httpServer.requestTimeout = 30_000;
  httpServer.keepAliveTimeout = 20_000;

  await new Promise<void>((resolve) => {
    httpServer.listen({ port: PORT }, resolve);
  });

  // The desks bet real credits out of real accounts, so those have to exist
  // before any of them arrives. Failing here must not take the API down — it
  // just means the board has no market makers this run.
  try {
    await seedDesks();
  } catch (err) {
    console.warn("⚠  could not open desk accounts:", err instanceof Error ? err.message : err);
  }

  // Subscribe before the first poll so the desks see every publish, and put them
  // on their own clocks.
  // **Only one set of desks trades at a time.**
  //
  // The chain desks are the same eight identities as these, over the same coins,
  // sizing themselves against the same shared position map. Running both meant
  // two desks named Vega Trading buying the same leg of the same coin in two
  // ledgers, and a per-coin exposure limit computed for one of them out of the
  // other's trades — a limit sized against a bankroll twenty times larger than
  // the desk it was being applied to.
  if (CHAIN_MODE === "off") startBots();
  startSessionSweep();

  // Four timers now outlive a request: the desks tick every second, the round
  // loop every second, the oracle every ten, the session sweep hourly.
  // `tsx --watch` restarts on SIGTERM, so without this a reload leaves the old
  // process printing into a market it no longer serves while the new one opens
  // a book on the same round.
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    stopBots();
    stopChain();
    stopRoundLoop();
    stopSessionSweep();
    oracle.stop();
    // Don't let a held-open keep-alive connection outlast the signal.
    setTimeout(() => process.exit(0), 5_000).unref();
    httpServer.close(() => {
      void prisma.$disconnect().finally(() => process.exit(0));
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  // Seeds the trailing-hour windows from REST, then streams live aggTrades.
  // Failing here must not take the API down — the oracle reports "degraded".
  oracle.start()
    .then(() => startRoundLoop())
    // After the round loop, never before: the chain mirrors whichever database
    // round is live, so starting it first would find nothing to mirror and log a
    // failure a second until the first round opened.
    .then(() => startChain().catch((err) => console.warn("⚠  chain:", err?.message ?? err)))
    .catch((err) => {
      console.warn("⚠  oracle failed to start:", err?.message ?? err);
    });

  // Invite codes are the only way in, so the server must always hold some.
  try {
    const codes = await seedInviteCodes();
    if (LOG_INVITE_CODES) {
      console.log(`🎟   Invite codes (${codes.length} unused): ${codes.join("  ")}`);
    } else {
      console.log(`🎟   ${codes.length} unused invite code(s) in circulation.`);
    }
  } catch (err) {
    console.warn("⚠  could not seed invite codes:", err instanceof Error ? err.message : err);
  }

  console.log(`👑  The Crown API ready at http://localhost:${PORT}/graphql`);
  if (hasClientBuild()) {
    console.log(`🌐  Website ready at http://localhost:${PORT}/`);
  } else {
    console.warn(
      [
        `⚠  No client build at ${CLIENT_DIR} — the site will 404.`,
        "   Run `bun run build` in the repo root first (or `bun run start`).",
      ].join("\n")
    );
  }
  if (!HAS_DATABASE_URL) {
    console.warn(
      [
        "⚠  DATABASE_URL is not set — DB-backed queries will error.",
        "   1. Copy server/.env.example to server/.env and set DATABASE_URL",
        "   2. bun run migrate:deploy   (apply the schema)",
      ].join("\n")
    );
  }
  if (IS_PRODUCTION && !CORS_ORIGINS.length) {
    console.log("ℹ  CORS_ORIGINS unset — /graphql accepts same-origin calls only.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
