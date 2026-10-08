import { spawn } from "node:child_process";
import { FFMPEG_PATH } from "./config";

/**
 * The two ffmpeg jobs a broadcast is made of.
 *
 * **The encoder** takes what the page records — WebM, whatever codec the
 * browser chose, at whatever frame rate it managed — and makes one clean
 * stream of it: constant 30 fps, H.264 with a keyframe every two seconds, AAC.
 * Platforms reject or stutter on anything looser, and a browser's recorder
 * promises none of it.
 *
 * **A pusher**, one per destination, copies that stream to an RTMP ingest
 * without touching it. Splitting the two is what lets one destination fail,
 * reconnect, be added or be switched off without the others noticing: the
 * expensive part runs once, and each copy is a process of its own.
 *
 * Between them is MPEG-TS, chosen because it is the one container a reader can
 * join part-way through — a pusher restarted mid-broadcast resynchronises on
 * the next packet and starts publishing from the next keyframe.
 */

export interface EncodeOptions {
  fps: number;
  videoKbps: number;
  audioKbps: number;
  preset: string;
}

/** Progress goes to fd 3, because stdout is the stream itself. */
export function encoderArgs(o: EncodeOptions): string[] {
  const gop = String(o.fps * 2);
  return [
    "-hide_banner",
    "-loglevel", "warning",
    "-nostats",
    "-progress", "pipe:3",
    // Start on the first second of input, not the default five.
    "-analyzeduration", "1000000",
    "-fflags", "+genpts",
    "-thread_queue_size", "1024",
    "-i", "pipe:0",
    "-map", "0:v:0",
    "-map", "0:a:0?",
    // A canvas is only recorded when it is painted, so the input's frame rate
    // wanders; `fps` makes it constant by repeating or dropping frames.
    "-vf", `fps=${o.fps},scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p`,
    "-c:v", "libx264",
    "-preset", o.preset,
    "-profile:v", "high",
    "-b:v", `${o.videoKbps}k`,
    "-maxrate", `${o.videoKbps}k`,
    "-bufsize", `${o.videoKbps * 2}k`,
    // Fixed two-second GOPs: what every ingest asks for, and the longest a
    // reconnecting pusher waits before it has a picture to send.
    "-g", gop,
    "-keyint_min", gop,
    "-sc_threshold", "0",
    "-c:a", "aac",
    "-b:a", `${o.audioKbps}k`,
    "-ar", "44100",
    "-ac", "2",
    "-f", "mpegts",
    "-muxdelay", "0",
    "-flush_packets", "1",
    "pipe:1",
  ];
}

/** Progress on stdout, which a pusher has no other use for. */
export function pusherArgs(target: string): string[] {
  return [
    "-hide_banner",
    "-loglevel", "error",
    "-nostats",
    "-progress", "pipe:1",
    "-fflags", "+discardcorrupt",
    "-f", "mpegts",
    "-i", "pipe:0",
    "-map", "0",
    "-c", "copy",
    "-f", "flv",
    "-flvflags", "no_duration_filesize",
    target,
  ];
}

export interface Progress {
  fps: number | null;
  kbps: number | null;
  speed: number | null;
  outTimeMs: number | null;
  totalBytes: number | null;
}

/**
 * `-progress` output: `key=value` lines, a block per report, each block ending
 * in `progress=continue` (or `progress=end` on the last). Fed whatever the pipe
 * delivers, it returns the blocks completed so far.
 */
export class ProgressReader {
  private partial = "";
  private block = new Map<string, string>();

  push(chunk: string): Progress[] {
    const lines = (this.partial + chunk).split("\n");
    this.partial = lines.pop() ?? "";
    const out: Progress[] = [];
    for (const line of lines) {
      const eq = line.indexOf("=");
      if (eq < 0) continue;
      const key = line.slice(0, eq).trim();
      const value = line.slice(eq + 1).trim();
      if (key !== "progress") {
        this.block.set(key, value);
        continue;
      }
      out.push(toProgress(this.block));
      this.block = new Map();
    }
    return out;
  }
}

function num(raw: string | undefined): number | null {
  if (raw == null) return null;
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : null;
}

function toProgress(b: Map<string, string>): Progress {
  // `out_time_ms` is microseconds despite its name; `out_time_us` says so.
  const us = num(b.get("out_time_us")) ?? num(b.get("out_time_ms"));
  return {
    fps: num(b.get("fps")),
    kbps: num(b.get("bitrate")), // "3456.7kbits/s", or "N/A"
    speed: num(b.get("speed")), // "1.01x", or "N/A"
    outTimeMs: us == null ? null : Math.max(0, Math.round(us / 1000)),
    totalBytes: num(b.get("total_size")),
  };
}

let available: Promise<boolean> | null = null;

/** Whether there is an ffmpeg to run. A yes is kept; a no is asked again next time. */
export function ffmpegAvailable(): Promise<boolean> {
  available ??= new Promise<boolean>((resolve) => {
    const proc = spawn(FFMPEG_PATH, ["-hide_banner", "-version"], { stdio: "ignore" });
    proc.on("error", () => resolve(false));
    proc.on("close", (code) => resolve(code === 0));
  }).then((yes) => {
    if (!yes) available = null;
    return yes;
  });
  return available;
}
