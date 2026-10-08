import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { Broadcast } from "../broadcast";
import { LIVE_HOST, LIVE_ORIGIN, STREAM } from "../config";
import { Board } from "./board";
import { Logos } from "./images";
import { Mixer } from "./mixer";
import { readPalette } from "./palette";
import type { FromRenderer, RendererStatus, ToRenderer } from "./protocol";
import { HEIGHT, Scene, WIDTH } from "./scene";

/**
 * The renderer: a process of its own, started by the server's director, that
 * paints the broadcast and feeds it to ffmpeg — no browser anywhere.
 *
 * A process rather than a thread or the server itself, because painting thirty
 * frames a second is steady work the game's API must never queue behind, and
 * because a crash in native drawing code should cost a stream reconnect, not
 * the game. The director restarts it if it dies.
 *
 * One clock drives everything: every 1/30 s it paints a frame and writes it,
 * with exactly 1/30 s of music, to the encoder. If painting ever falls behind,
 * the last frame is written again so the stream keeps its pace; sound is never
 * skipped or doubled, so the two stay together.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FRAME_MS = 1000 / STREAM.fps;
const SOUND_BYTES = (STREAM.sampleRate / STREAM.fps) * STREAM.channels * 2;
const PREVIEW_MS = 1_000;

const send = (message: FromRenderer) => process.send?.(message);

const board = new Board(`${LIVE_ORIGIN}/graphql`);
const logos = new Logos(LIVE_ORIGIN);
const crownIcon = await loadImage(join(HERE, "../../../../public/crown-icon.svg")).catch(() => null);
const scene = new Scene(readPalette(), logos, LIVE_HOST, crownIcon);
const canvas = createCanvas(WIDTH, HEIGHT);
const ctx = canvas.getContext("2d");
const mixer = new Mixer();

let broadcast: Broadcast | null = null;
let stopping = false;
let paintMs = 0;

function status(): RendererStatus | null {
  if (!broadcast) return null;
  return {
    ...broadcast.status(),
    nowPlaying: mixer.current?.name ?? null,
    boardAt: board.updatedAt,
    paintMs: Math.round(paintMs * 10) / 10,
  };
}

function start(m: Extract<ToRenderer, { type: "start" }>): void {
  if (broadcast) return;
  mixer.setTracks(m.tracks);
  mixer.volume = m.volume;
  board.start();
  broadcast = new Broadcast(m.destinations);
  broadcast.on("status", () => {
    const s = status();
    if (s) send({ type: "status", status: s });
  });
  broadcast.on("end", (final) => {
    const s = status();
    if (s) send({ type: "status", status: { ...s, ...final } });
    board.stop();
    mixer.close();
    // Failing is the director's cue to start a fresh renderer.
    setTimeout(() => process.exit(final.state === "failed" ? 1 : 0), 100);
  });
  setInterval(() => {
    const s = status();
    if (s) send({ type: "status", status: s });
  }, 1_000).unref();

  const t0 = performance.now();
  let written = 0;
  let lastPreview = 0;
  const tick = () => {
    if (stopping || !broadcast) return;
    const now = performance.now();
    let due = Math.floor((now - t0) / FRAME_MS) + 1;
    // Seconds behind — the process was starved. Let the time go rather than
    // burst it all into the encoder at once.
    if (due - written > STREAM.fps * 2) written = due - 1;
    if (written < due) {
      const began = performance.now();
      scene.paint(ctx, board.race, board.crowning, Date.now(), now);
      const picture = canvas.data();
      paintMs = paintMs * 0.9 + (performance.now() - began) * 0.1;
      while (written < due) {
        broadcast.writeFrame(picture, mixer.pull(SOUND_BYTES));
        written++;
      }
      if (now - lastPreview >= PREVIEW_MS) {
        lastPreview = now;
        send({ type: "preview", jpeg: canvas.encodeSync("jpeg", 72) });
      }
    }
    due = written;
    setTimeout(tick, Math.max(1, t0 + due * FRAME_MS - performance.now()));
  };
  tick();
}

async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  board.stop();
  mixer.close();
  if (broadcast) await broadcast.stop();
  else process.exit(0);
}

process.on("message", (m: ToRenderer) => {
  switch (m.type) {
    case "start":
      start(m);
      break;
    case "destinations":
      broadcast?.sync(m.destinations);
      break;
    case "tracks":
      mixer.setTracks(m.tracks);
      break;
    case "volume":
      mixer.volume = m.volume;
      break;
    case "next":
      mixer.next();
      break;
    case "rehearse":
      board.rehearse();
      break;
    case "stop":
      void stop();
      break;
  }
});

// The server went away without saying so. Nothing must keep publishing as it.
process.on("disconnect", () => void stop());
send({ type: "ready" });
