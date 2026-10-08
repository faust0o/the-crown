import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The livestream's settings.
 *
 * `LIVE_PASSWORD` is the switch as well as the lock. Unset, every /api/live
 * route answers 404 and /live has nothing to sign in to: a broadcast relay that
 * shipped switched on with no password would push anybody's video to whatever
 * RTMP key they cared to store on it.
 */
export const LIVE_PASSWORD = process.env.LIVE_PASSWORD ?? "";
export const LIVE_ENABLED = LIVE_PASSWORD.length > 0;

/**
 * Where the destinations and the uploaded music are kept — beside the token
 * logos, on the volume Railway mounts, so both outlive a deploy. Off Railway
 * with no `LIVE_DIR` this is a temp directory, and a reboot forgets them.
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
 * What goes out to every destination. The page draws 1280×720; 3.5 Mbit/s of
 * H.264 at 30 fps is inside what YouTube, Twitch, Kick and X all ask for at
 * 720p, and the scene is mostly still, so it spends little of it.
 */
export const STREAM = {
  fps: 30,
  videoKbps: Number(process.env.LIVE_VIDEO_KBPS ?? 3500),
  audioKbps: 160,
  /** x264's speed/quality trade. `veryfast` holds 720p30 on one core. */
  preset: process.env.LIVE_X264_PRESET ?? "veryfast",
};
