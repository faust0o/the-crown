import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import type { Readable } from "node:stream";
import { FFMPEG_PATH, STREAM } from "./config";
import { encoderArgs, ProgressReader, pusherArgs, type EncodeOptions, type Progress } from "./ffmpeg";
import { redact, targetOf, type Destination } from "./store";

/**
 * One broadcast: the page's recording in, one encoder, a pusher per destination.
 *
 * See `ffmpeg.ts` for why the work is split that way. What this file owns is
 * the lifecycle — who is running, who has dropped and when to try them again,
 * and how to stop everything without leaving an ffmpeg behind.
 */

export type DestinationState = "connecting" | "live" | "retrying";

export interface DestinationStatus {
  id: string;
  label: string;
  state: DestinationState;
  /** What ffmpeg said last time this destination dropped, with the key taken out. */
  error: string | null;
  kbps: number | null;
  /** When it last went live. */
  since: number | null;
}

export interface BroadcastStatus {
  state: "starting" | "live" | "stopping" | "stopped" | "failed";
  startedAt: number;
  error: string | null;
  fps: number | null;
  speed: number | null;
  kbps: number | null;
  destinations: DestinationStatus[];
}

/**
 * How much unread input a process may build up before it is cut off. An
 * encoder that far behind will never catch up; a pusher that far behind has a
 * destination that has stopped reading, and holding its backlog would be
 * holding the whole broadcast's memory for one dead socket.
 */
const ENCODER_BACKLOG = 64 * 1024 * 1024;
const PUSHER_BACKLOG = 16 * 1024 * 1024;
const RETRY_MS = [2_000, 5_000, 10_000, 30_000];
/** Live this long, and a destination's next drop starts the backoff over. */
const STABLE_MS = 60_000;
const KILL_AFTER_MS = 5_000;

const MISSING = "ffmpeg isn't installed on the server — set RAILPACK_DEPLOY_APT_PACKAGES=ffmpeg.";

/** The last few lines a process wrote to stderr — its last words, when it dies. */
function keepTail(lines: string[], chunk: string, keep = 8): void {
  for (const line of chunk.split("\n")) {
    const text = line.trim();
    if (text) lines.push(text.slice(0, 300));
  }
  if (lines.length > keep) lines.splice(0, lines.length - keep);
}

/**
 * Resolves once a process has gone, killing it if it takes too long to go.
 * `close` fires even for a binary that never started, so this cannot hang.
 */
function exited(proc: ChildProcess, ms = KILL_AFTER_MS): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => proc.kill("SIGKILL"), ms);
    proc.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function spawnFfmpeg(args: string[], fds: number): ChildProcess {
  const proc = spawn(FFMPEG_PATH, args, { stdio: Array(fds).fill("pipe") });
  // EPIPE when it dies mid-write. Its `close` is what reports that.
  proc.stdin?.on("error", () => {});
  return proc;
}

class Pusher {
  state: DestinationState = "connecting";
  error: string | null = null;
  kbps: number | null = null;
  since: number | null = null;
  readonly target: string;
  private proc: ChildProcess | null = null;
  private attempt = 0;
  private retry: NodeJS.Timeout | null = null;
  private closed = false;
  /** Why we killed it ourselves, which outranks whatever ffmpeg said on the way out. */
  private cause: string | null = null;

  constructor(
    public dest: Destination,
    private readonly changed: () => void
  ) {
    this.target = targetOf(dest);
    this.start();
  }

  private start(): void {
    this.state = "connecting";
    this.cause = null;
    const proc = spawnFfmpeg(pusherArgs(this.target), 3);
    this.proc = proc;
    const lines: string[] = [];
    const progress = new ProgressReader();

    proc.stdout!.setEncoding("utf8").on("data", (chunk: string) => {
      for (const p of progress.push(chunk)) {
        this.kbps = p.kbps;
        // Bytes out and time advancing: the ingest has accepted the stream.
        if (this.state !== "live" && (p.totalBytes ?? 0) > 0 && (p.outTimeMs ?? 0) > 0) {
          this.state = "live";
          this.since = Date.now();
          this.error = null;
          this.changed();
        }
        if (this.since && Date.now() - this.since > STABLE_MS) this.attempt = 0;
      }
    });
    proc.stderr!.setEncoding("utf8").on("data", (chunk: string) => keepTail(lines, chunk));
    proc.on("error", (err: NodeJS.ErrnoException) => {
      this.cause = err.code === "ENOENT" ? MISSING : err.message;
    });
    proc.on("close", (code, signal) => {
      if (this.proc !== proc) return;
      this.proc = null;
      if (this.closed) return;
      const said = this.cause ?? lines.at(-1) ?? `ffmpeg exited (${signal ?? code})`;
      this.state = "retrying";
      this.error = redact(said, [this.dest]);
      this.since = null;
      this.kbps = null;
      const wait = RETRY_MS[Math.min(this.attempt, RETRY_MS.length - 1)];
      this.attempt++;
      this.retry = setTimeout(() => {
        this.retry = null;
        if (!this.closed) this.start();
      }, wait);
      this.changed();
    });
    this.changed();
  }

  feed(chunk: Buffer): void {
    const stdin = this.proc?.stdin;
    if (!stdin?.writable) return;
    if (stdin.writableLength > PUSHER_BACKLOG) {
      this.cause = "Fell behind: the destination stopped taking data.";
      this.proc!.kill("SIGKILL");
      return;
    }
    stdin.write(chunk);
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.retry) clearTimeout(this.retry);
    const proc = this.proc;
    if (!proc) return;
    proc.stdin?.end();
    await exited(proc);
  }

  status(): DestinationStatus {
    return {
      id: this.dest.id,
      label: this.dest.label,
      state: this.state,
      error: this.error,
      kbps: this.kbps,
      since: this.since,
    };
  }
}

/**
 * Emits `status` whenever something worth showing changes — at most once a
 * second for progress, immediately for a state change — and `end` once, when
 * every process it started has exited.
 */
export class Broadcast extends EventEmitter {
  private state: BroadcastStatus["state"] = "starting";
  private error: string | null = null;
  readonly startedAt = Date.now();
  private stats: Progress | null = null;
  private readonly encoder: ChildProcess;
  private readonly pushers = new Map<string, Pusher>();
  private readonly lines: string[] = [];
  private cause: string | null = null;
  private ending: Promise<void> | null = null;
  private pending: NodeJS.Timeout | null = null;

  constructor(destinations: Destination[], options: EncodeOptions = STREAM) {
    super();
    this.encoder = spawnFfmpeg(encoderArgs(options), 4);

    this.encoder.stdout!.on("data", (chunk: Buffer) => {
      if (this.state === "starting") {
        this.state = "live";
        this.notify(true);
      }
      for (const p of this.pushers.values()) p.feed(chunk);
    });

    const progress = new ProgressReader();
    (this.encoder.stdio[3] as Readable).setEncoding("utf8").on("data", (chunk: string) => {
      const reports = progress.push(chunk);
      if (!reports.length) return;
      this.stats = reports[reports.length - 1];
      this.notify();
    });
    this.encoder.stderr!.setEncoding("utf8").on("data", (chunk: string) => keepTail(this.lines, chunk));
    this.encoder.on("error", (err: NodeJS.ErrnoException) => {
      this.cause = err.code === "ENOENT" ? MISSING : err.message;
    });
    this.encoder.on("close", () => {
      if (this.running) {
        this.fail(this.cause ?? this.lines.at(-1) ?? "The encoder stopped.");
      }
    });

    this.sync(destinations);
  }

  private get running(): boolean {
    return this.state === "starting" || this.state === "live";
  }

  /** A piece of the page's recording. */
  write(chunk: Buffer): void {
    if (!this.running) return;
    const stdin = this.encoder.stdin!;
    if (stdin.writableLength > ENCODER_BACKLOG) {
      this.fail("The server can't encode as fast as the page is recording.");
      return;
    }
    stdin.write(chunk);
  }

  /**
   * Bring the pushers in line with the saved destinations: start the ones
   * newly switched on, stop the ones switched off or deleted, and restart any
   * whose address changed. Nobody else is interrupted.
   */
  sync(destinations: Destination[]): void {
    if (!this.running) return;
    const wanted = new Map(destinations.filter((d) => d.enabled).map((d) => [d.id, d]));
    for (const [id, pusher] of this.pushers) {
      const d = wanted.get(id);
      if (d && targetOf(d) === pusher.target) {
        pusher.dest = d;
        continue;
      }
      this.pushers.delete(id);
      void pusher.close();
    }
    for (const [id, d] of wanted) {
      if (!this.pushers.has(id)) this.pushers.set(id, new Pusher(d, () => this.notify(true)));
    }
    this.notify(true);
  }

  /** Let the encoder flush what it holds, then each pusher what it was given. */
  stop(): Promise<void> {
    if (this.running) this.state = "stopping";
    this.ending ??= this.finish(false);
    return this.ending;
  }

  private fail(message: string): void {
    if (!this.running) return;
    this.state = "failed";
    this.error = message;
    this.ending ??= this.finish(true);
  }

  private async finish(abort: boolean): Promise<void> {
    this.notify(true);
    if (abort) this.encoder.kill("SIGKILL");
    else this.encoder.stdin?.end();
    await exited(this.encoder);
    await Promise.all([...this.pushers.values()].map((p) => p.close()));
    this.pushers.clear();
    if (this.state === "stopping") this.state = "stopped";
    if (this.pending) clearTimeout(this.pending);
    this.emit("end", this.status());
  }

  private notify(now = false): void {
    if (now) {
      if (this.pending) clearTimeout(this.pending);
      this.pending = null;
      this.emit("status", this.status());
      return;
    }
    this.pending ??= setTimeout(() => {
      this.pending = null;
      this.emit("status", this.status());
    }, 1_000);
  }

  status(): BroadcastStatus {
    return {
      state: this.state,
      startedAt: this.startedAt,
      error: this.error,
      fps: this.stats?.fps ?? null,
      speed: this.stats?.speed ?? null,
      kbps: this.stats?.kbps ?? null,
      destinations: [...this.pushers.values()].map((p) => p.status()),
    };
  }
}
