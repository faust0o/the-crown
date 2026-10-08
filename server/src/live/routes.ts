import express, {
  type Express,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import { LIVE_ENABLED, LIVE_PASSWORD } from "./config";
import { director } from "./director";
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
 * The livestream's API, under /api/live: the studio's remote control.
 *
 * The broadcast itself runs on the server (see director.ts) — this is where
 * the studio page switches it on and off, edits where it goes and what plays
 * under it, and watches it. Nothing here needs the page to stay open.
 */

/** Give the server a moment to listen and the oracle to warm before resuming. */
const RESUME_AFTER_MS = 3_000;

const handle =
  (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

async function snapshot() {
  const [destinations, tracks, settings, ffmpeg] = await Promise.all([
    liveStore.destinations(),
    liveStore.tracks(),
    liveStore.settings(),
    ffmpegAvailable(),
  ]);
  return {
    ffmpeg,
    destinations: destinations.map(publicDestination),
    tracks,
    volume: settings.volume,
    ...director.state(),
  };
}

export function mountLive(app: Express, loginLimiter: RequestHandler): void {
  if (!LIVE_ENABLED) {
    app.use("/api/live", (_req, res) => {
      res.status(404).json({ error: "The livestream is off: set LIVE_PASSWORD on the server." });
    });
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

  // On air until somebody switches it off: the choice is saved, so a deploy
  // or a crash brings it back by itself.
  api.post(
    "/broadcast",
    handle(async (req, res) => {
      if (req.body?.onAir === true) await director.goLive();
      else if (req.body?.onAir === false) await director.stop();
      else throw new LiveInputError("Say whether it should be on air.");
      res.json(await snapshot());
    })
  );

  api.post("/rehearse", (_req, res) => {
    if (!director.rehearse()) {
      res.status(409).json({ error: "The stream isn't running." });
      return;
    }
    res.status(204).end();
  });

  api.post("/music/next", (_req, res) => {
    if (!director.nextTrack()) {
      res.status(409).json({ error: "The stream isn't running." });
      return;
    }
    res.status(204).end();
  });

  api.put(
    "/settings",
    handle(async (req, res) => {
      const settings = await liveStore.updateSettings({ volume: req.body?.volume });
      await director.refresh();
      res.json(settings);
    })
  );

  // What is going out, about once a second — the studio's preview is the
  // stream itself, not a second drawing of it.
  api.get("/preview.jpg", (_req, res) => {
    const jpeg = director.previewJpeg();
    if (!jpeg) {
      res.status(404).end();
      return;
    }
    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Cache-Control", "no-store");
    res.end(jpeg);
  });

  api.post(
    "/destinations",
    handle(async (req, res) => {
      const d = await liveStore.addDestination(req.body ?? {});
      await director.refresh();
      res.status(201).json(publicDestination(d));
    })
  );

  api.patch(
    "/destinations/:id",
    handle(async (req, res) => {
      const d = await liveStore.updateDestination(req.params.id, req.body ?? {});
      await director.refresh();
      res.json(publicDestination(d));
    })
  );

  api.delete(
    "/destinations/:id",
    handle(async (req, res) => {
      await liveStore.removeDestination(req.params.id);
      await director.refresh();
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
        const track = await liveStore.addTrack(name, req);
        await director.refresh();
        res.status(201).json(track);
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
      if (!track) {
        res.status(202).json({ received });
        return;
      }
      await director.refresh();
      res.status(201).json(track);
    })
  );

  api.put(
    "/tracks/order",
    handle(async (req, res) => {
      const tracks = await liveStore.reorderTracks(req.body?.ids);
      await director.refresh();
      res.json(tracks);
    })
  );

  api.delete(
    "/tracks/:id",
    handle(async (req, res) => {
      await liveStore.removeTrack(req.params.id);
      await director.refresh();
      res.status(204).end();
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

  setTimeout(() => {
    director.boot().catch((err) => console.warn("⚠  livestream: could not resume:", err?.message ?? err));
  }, RESUME_AFTER_MS).unref();
}

/** For shutdown: stop the stream, but leave it on air for the next process to resume. */
export async function stopLive(): Promise<void> {
  if (LIVE_ENABLED) await director.shutdown();
}
