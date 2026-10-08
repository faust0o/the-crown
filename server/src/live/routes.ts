import type http from "node:http";
import express, {
  type Express,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { Broadcast } from "./broadcast";
import { LIVE_ENABLED, LIVE_PASSWORD } from "./config";
import { ffmpegAvailable } from "./ffmpeg";
import {
  clearSession,
  passwordMatches,
  requireSession,
  sameOrigin,
  setSession,
  signedIn,
} from "./session";
import { LiveInputError, liveStore, publicDestination } from "./store";

/**
 * The livestream's API, under /api/live, and its ingest socket.
 *
 * REST for the settings — destinations and music — and one WebSocket for the
 * broadcast itself: the page sends its recording up it in half-second pieces,
 * and the server sends back how the encoder and every destination are doing.
 */

const INGEST_PATH = "/api/live/ingest";

/** Close codes the page acts on. 4001 means "don't reconnect". */
const REPLACED = 4001;
const REFUSED = 4400;
const FAILED = 4500;

/** The one broadcast there can be, and the socket feeding it. */
let current: { broadcast: Broadcast; ws: WebSocket } | null = null;
/**
 * The last broadcast's shutdown. A page that reconnects after a dropped socket
 * waits on it, so its pushers never meet the old ones' connections still open
 * on the same stream keys.
 */
let windingDown: Promise<void> = Promise.resolve();
/**
 * Bumped by every page that asks to go live. Starting takes a moment — the old
 * broadcast has to wind down first — and two pages asking at once must not both
 * come out of that wait on air: the later one wins, as a takeover does.
 */
let claims = 0;

const handle =
  (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

async function refreshDestinations(): Promise<void> {
  current?.broadcast.sync(await liveStore.destinations());
}

async function snapshot() {
  const [destinations, tracks, ffmpeg] = await Promise.all([
    liveStore.destinations(),
    liveStore.tracks(),
    ffmpegAvailable(),
  ]);
  return {
    ffmpeg,
    destinations: destinations.map(publicDestination),
    tracks,
    broadcast: current?.broadcast.status() ?? null,
  };
}

export function mountLive(app: Express, server: http.Server, loginLimiter: RequestHandler): void {
  if (!LIVE_ENABLED) {
    app.use("/api/live", (_req, res) => {
      res.status(404).json({ error: "The livestream is off: set LIVE_PASSWORD on the server." });
    });
    server.on("upgrade", (_req, socket) => socket.destroy());
    return;
  }

  if (LIVE_PASSWORD.length < 12) {
    console.warn("⚠  LIVE_PASSWORD is shorter than 12 characters — /live is only as safe as it.");
  }

  const api = express.Router();
  api.use(express.json({ limit: "16kb" }));

  api.get("/session", (req, res) => {
    res.json({ signedIn: signedIn(req) });
  });

  api.post("/login", loginLimiter, (req, res) => {
    if (!sameOrigin(req)) {
      res.status(403).json({ error: "Cross-origin request refused." });
      return;
    }
    if (!passwordMatches(LIVE_PASSWORD, req.body?.password)) {
      res.status(401).json({ error: "That's not the password." });
      return;
    }
    setSession(res);
    res.json({ signedIn: true });
  });

  api.post("/logout", (_req, res) => {
    clearSession(res);
    res.json({ signedIn: false });
  });

  api.use(requireSession);

  api.get(
    "/state",
    handle(async (_req, res) => {
      res.json(await snapshot());
    })
  );

  api.post(
    "/destinations",
    handle(async (req, res) => {
      const d = await liveStore.addDestination(req.body ?? {});
      await refreshDestinations();
      res.status(201).json(publicDestination(d));
    })
  );

  api.patch(
    "/destinations/:id",
    handle(async (req, res) => {
      const d = await liveStore.updateDestination(req.params.id, req.body ?? {});
      await refreshDestinations();
      res.json(publicDestination(d));
    })
  );

  api.delete(
    "/destinations/:id",
    handle(async (req, res) => {
      await liveStore.removeDestination(req.params.id);
      await refreshDestinations();
      res.status(204).end();
    })
  );

  // The body is the file itself, not a form — or one part of it, when the
  // upload is sent in pieces (see `addTrackPart`). The name and the part's
  // place ride in headers because there is no form to carry them.
  api.post(
    "/tracks",
    handle(async (req, res) => {
      const name = req.get("x-track-name");
      const upload = req.get("x-upload-id");
      if (!upload) {
        res.status(201).json(await liveStore.addTrack(name, req));
        return;
      }
      const { track, received } = await liveStore.addTrackPart(
        {
          upload,
          offset: Number(req.get("x-upload-offset") ?? NaN),
          final: req.get("x-upload-final") === "1",
          name,
        },
        req
      );
      if (track) res.status(201).json(track);
      else res.status(202).json({ received });
    })
  );

  api.put(
    "/tracks/order",
    handle(async (req, res) => {
      res.json(await liveStore.reorderTracks(req.body?.ids));
    })
  );

  api.delete(
    "/tracks/:id",
    handle(async (req, res) => {
      await liveStore.removeTrack(req.params.id);
      res.status(204).end();
    })
  );

  api.get(
    "/tracks/:id/audio",
    handle(async (req, res) => {
      const file = await liveStore.trackFile(req.params.id);
      if (!file) {
        res.status(404).end();
        return;
      }
      res.sendFile(file, {
        headers: { "Content-Type": "audio/mpeg", "Cache-Control": "private, max-age=86400" },
      });
    })
  );

  // Not the SPA shell, which is what an unmatched path would fall through to.
  api.use((_req, res) => {
    res.status(404).json({ error: "No such route." });
  });

  api.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    if (err instanceof LiveInputError) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error("live:", err);
    res.status(500).json({ error: "Something went wrong." });
  });

  app.use("/api/live", api);

  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
  server.on("upgrade", (req, socket, head) => {
    // A reset mid-handshake is an `error` on a socket nobody else is listening
    // to any more, and an unheard `error` is a crash.
    socket.on("error", () => socket.destroy());
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    // Nothing else on this server takes a WebSocket.
    if (path !== INGEST_PATH) {
      socket.destroy();
      return;
    }
    // A browser always sends Origin on a handshake, so a missing one is refused
    // here rather than waved through as it is for plain requests.
    if (!req.headers.origin || !sameOrigin(req) || !signedIn(req)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => broadcaster(ws));
  });
}

/** Stop whatever is on air. For shutdown. */
export async function stopLive(): Promise<void> {
  const live = current;
  current = null;
  if (!live) return;
  closeSafely(live.ws, 1001, "The server is restarting.");
  await live.broadcast.stop();
}

/**
 * A close frame's reason is capped at 123 bytes and `ws` throws past it — from
 * inside an event handler, which this process treats as fatal. ffmpeg's error
 * lines are arbitrary text, so they are cut to fit by bytes, not characters.
 */
function closeSafely(ws: WebSocket, code: number, reason = ""): void {
  let text = reason;
  while (Buffer.byteLength(text) > 120) text = text.slice(0, -1);
  try {
    ws.close(code, text);
  } catch {
    ws.terminate();
  }
}

const asBuffer = (data: RawData): Buffer =>
  Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);

/**
 * One page's broadcast.
 *
 * The page opens the socket, says `start` with the recorder's MIME type, waits
 * for `ready`, then streams. Closing the socket — the tab closing, the network
 * dropping, the Stop button — ends the broadcast, and a second page going live
 * takes over from the first rather than fighting it for the same stream keys.
 */
function broadcaster(ws: WebSocket): void {
  let broadcast: Broadcast | null = null;
  let started = false;
  let alive = true;

  const send = (message: object) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
  };
  const refuse = (message: string) => {
    send({ type: "error", message });
    closeSafely(ws, REFUSED, message);
  };

  // Railway's edge drops a socket it thinks is idle; a ping keeps it honest,
  // and a missed pong means the page is gone without having said so.
  const heartbeat = setInterval(() => {
    if (!alive) {
      ws.terminate();
      return;
    }
    alive = false;
    ws.ping();
  }, 15_000);
  ws.on("pong", () => {
    alive = true;
  });
  // A frame over `maxPayload`, or one that is not a frame at all. `ws` closes
  // the socket itself; this is only here so the error is heard, since an
  // EventEmitter with no `error` listener throws, and this process would die.
  ws.on("error", (err) => console.warn("live: ingest socket:", err.message));

  const start = async (mime: unknown) => {
    if (typeof mime !== "string" || !/^video\/(webm|x-matroska)\b/i.test(mime)) {
      refuse("The page has to record WebM. Use Chrome, Edge or Firefox.");
      return;
    }
    if (!(await ffmpegAvailable())) {
      refuse("ffmpeg isn't installed on the server — set RAILPACK_DEPLOY_APT_PACKAGES=ffmpeg.");
      return;
    }
    const destinations = (await liveStore.destinations()).filter((d) => d.enabled);
    if (!destinations.length) {
      refuse("Add a destination, or switch one on, before going live.");
      return;
    }
    if (ws.readyState !== ws.OPEN) return;

    // Two broadcasts would publish to the same keys, and every platform
    // refuses the second connection — so the old one is stopped first.
    const claim = ++claims;
    const previous = current;
    current = null;
    if (previous) {
      closeSafely(previous.ws, REPLACED, "Another window took over the broadcast.");
      windingDown = previous.broadcast.stop();
    }
    await windingDown;
    if (ws.readyState !== ws.OPEN) return;
    if (claim !== claims) {
      send({ type: "error", message: "Another window took over the broadcast." });
      closeSafely(ws, REPLACED, "Another window took over the broadcast.");
      return;
    }

    const mine = new Broadcast(destinations);
    broadcast = mine;
    current = { broadcast: mine, ws };
    mine.on("status", (status) => send({ type: "status", status }));
    mine.on("end", (status) => {
      send({ type: "status", status });
      if (current?.broadcast === mine) current = null;
      if (status.state === "failed") closeSafely(ws, FAILED, status.error ?? "The broadcast failed.");
      else closeSafely(ws, 1000);
    });
    send({ type: "ready" });
  };

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      broadcast?.write(asBuffer(data));
      return;
    }
    let message: { type?: string; mime?: unknown };
    try {
      message = JSON.parse(asBuffer(data).toString("utf8"));
    } catch {
      return;
    }
    if (message.type === "start" && !started) {
      started = true;
      start(message.mime).catch((err) => {
        console.error("live: could not start a broadcast:", err);
        refuse("The broadcast couldn't start.");
      });
    } else if (message.type === "stop") {
      void broadcast?.stop();
    }
  });

  ws.on("close", () => {
    clearInterval(heartbeat);
    if (broadcast) windingDown = broadcast.stop();
    if (current?.ws === ws) current = null;
  });
}
