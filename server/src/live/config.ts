import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The livestream's settings.
 *
 * `LIVE_PASSWORD` is the switch as well as the lock. Unset, every /api/live
 * route answers 404 and /live has nothing to sign in to: a broadcast relay that
 * shipped switched on with no password would push to whatever RTMP key anybody
 * cared to store on it.
 */
export const LIVE_PASSWORD = process.env.LIVE_PASSWORD ?? "";
export const LIVE_ENABLED = LIVE_PASSWORD.length > 0;

/**
 * Where the destinations, the music and whether the stream is on air are kept —
 * beside the token logos, on the volume Railway mounts, so all of it outlives a
 * deploy. Off Railway with no `LIVE_DIR` this is a temp directory, and a reboot
 * forgets them.
 */
export const LIVE_DIR =
  process.env.LIVE_DIR ??
  join(process.env.RAILWAY_VOLUME_MOUNT_PATH ?? join(tmpdir(), "crown"), "live");

/**
 * The ffmpeg binary. Railpack installs one when the service sets
 * `RAILPACK_DEPLOY_APT_PACKAGES=ffmpeg`; without it, going live fails with a
 * message saying so and nothing else about the game is affected.
 */
export const FFMPEG_PATH = process.env.FFMPEG_PATH || "ffmpeg";

/**
 * How the renderer reaches this server for the board and the logos — the same
 * public GraphQL and /logo a visitor's browser uses, over loopback.
 */
export const LIVE_ORIGIN = process.env.LIVE_ORIGIN ?? `http://127.0.0.1:${process.env.PORT ?? 4000}`;

/** Printed in the corner of every frame, so a clip that travels says where it came from. */
export const LIVE_HOST = (() => {
  try {
    return new URL(process.env.SITE_ORIGIN ?? "https://thecrowngame.fun").host;
  } catch {
    return "thecrowngame.fun";
  }
})();

/**
 * What goes out to every destination: 1280×720 at 30 fps, 3.5 Mbit/s of H.264
 * — inside what YouTube, Twitch, Kick, X and pump.fun ask for at 720p — and
 * 160 kbit/s of AAC. The scene is mostly still, so it spends little of it.
 */
export const STREAM = {
  width: 1280,
  height: 720,
  fps: 30,
  videoKbps: Number(process.env.LIVE_VIDEO_KBPS ?? 3500),
  audioKbps: 160,
  sampleRate: 44_100,
  channels: 2,
  /** x264's speed/quality trade. `veryfast` holds 720p30 on one core. */
  preset: process.env.LIVE_X264_PRESET ?? "veryfast",
};
