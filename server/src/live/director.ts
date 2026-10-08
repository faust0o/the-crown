import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ffmpegAvailable } from "./ffmpeg";
import type { FromRenderer, RendererStatus, ToRenderer } from "./renderer/protocol";
import { LiveInputError, liveStore } from "./store";

/**
 * Keeps the stream on air.
 *
 * The broadcast is made by a renderer process (see renderer/main.ts); this is
 * the part of the server that starts it, feeds it the destinations and the
 * playlist, restarts it when it dies, and remembers — on the volume — that it
 * should be running. So the stream does not depend on anybody's browser: it
 * runs from Go live until Stop, and a deploy or a crash interrupts it for as
 * long as the server takes to come back.
 */

const ENTRY = fileURLToPath(new URL("./renderer/main.ts", import.meta.url));
const RETRY_MS = [2_000, 5_000, 10_000, 30_000];
/** Up this long, and the next crash starts the backoff over. */
const STABLE_MS = 60_000;

export interface DirectorState {
  /** Whether the stream should be on air. */
  onAir: boolean;
  /** Whether a renderer is running right now. */
  running: boolean;
  /** Waiting to restart a renderer that stopped. */
  restarting: boolean;
  /** Why the last renderer stopped, if it did not mean to. */
  error: string | null;
  status: RendererStatus | null;
}

class Director {
  private child: ChildProcess | null = null;
  private wanted = false;
  private status: RendererStatus | null = null;
  private preview: Buffer | null = null;
  private error: string | null = null;
  private attempt = 0;
  private retry: NodeJS.Timeout | null = null;
  private spawnedAt = 0;

  /** At startup: back on air if that is where the last process left it. */
  async boot(): Promise<void> {
    if (!(await liveStore.settings()).onAir) return;
    console.log("📺  livestream: resuming — it was on air when the server stopped");
    this.wanted = true;
    await this.spawn();
  }

  async goLive(): Promise<void> {
    if (!(await ffmpegAvailable())) {
      throw new LiveInputError("ffmpeg isn't installed on the server — set RAILPACK_DEPLOY_APT_PACKAGES=ffmpeg.");
    }
    if (!(await liveStore.destinations()).some((d) => d.enabled)) {
      throw new LiveInputError("Add a destination, or switch one on, before going live.");
    }
    await liveStore.updateSettings({ onAir: true });
    this.wanted = true;
    this.error = null;
    this.attempt = 0;
    if (!this.child && !this.retry) await this.spawn();
  }

  /** Off air until somebody presses Go live again. */
  async stop(): Promise<void> {
    await liveStore.updateSettings({ onAir: false });
    this.wanted = false;
    await this.halt();
  }

  /** For the server shutting down: stop, but stay on air for the next process. */
  async shutdown(): Promise<void> {
    this.wanted = false;
    await this.halt();
  }

  /** Tell a running renderer about changed destinations, music or volume. */
  async refresh(): Promise<void> {
    if (!this.child) return;
    const [destinations, tracks, settings] = await Promise.all([
      liveStore.destinations(),
      liveStore.playlist(),
      liveStore.settings(),
    ]);
    this.send({ type: "destinations", destinations });
    this.send({ type: "tracks", tracks });
    this.send({ type: "volume", volume: settings.volume });
  }

  rehearse(): boolean {
    return this.send({ type: "rehearse" });
  }

  nextTrack(): boolean {
    return this.send({ type: "next" });
  }

  state(): DirectorState {
    return {
      onAir: this.wanted,
      running: Boolean(this.child),
      restarting: Boolean(this.retry),
      error: this.error,
      status: this.child ? this.status : null,
    };
  }

  previewJpeg(): Buffer | null {
    return this.child ? this.preview : null;
  }

  private send(message: ToRenderer): boolean {
    if (!this.child?.connected) return false;
    this.child.send(message);
    return true;
  }

  private async spawn(): Promise<void> {
    this.retry = null;
    const [destinations, tracks, settings] = await Promise.all([
      liveStore.destinations(),
      liveStore.playlist(),
      liveStore.settings(),
    ]);
    if (!this.wanted || this.child) return;

    const child = fork(ENTRY, [], {
      // Same loader (tsx) and env file as the server, but never `--watch`: a
      // renderer that watched files would restart itself mid-broadcast.
      execArgv: process.execArgv.filter((a) => !a.startsWith("--watch")),
      stdio: ["ignore", "inherit", "inherit", "ipc"],
      // Structured clone, so preview frames cross as bytes rather than base64.
      serialization: "advanced",
    });
    this.child = child;
    this.spawnedAt = Date.now();
    this.status = null;
    this.preview = null;

    child.on("message", (m: FromRenderer) => {
      if (m.type === "ready") child.send({ type: "start", destinations, tracks, volume: settings.volume } satisfies ToRenderer);
      else if (m.type === "status") {
        this.status = m.status;
        if (m.status.state === "failed" && m.status.error) this.error = m.status.error;
      } else if (m.type === "preview") this.preview = Buffer.from(m.jpeg);
    });
    child.on("error", (err) => {
      this.error = err.message;
    });
    child.on("exit", (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      if (!this.wanted) return;
      if (code !== 0) this.error ??= `The renderer stopped (${signal ?? `exit ${code}`}).`;
      if (Date.now() - this.spawnedAt > STABLE_MS) this.attempt = 0;
      const wait = RETRY_MS[Math.min(this.attempt, RETRY_MS.length - 1)];
      this.attempt++;
      console.warn(`⚠  livestream: renderer stopped (${signal ?? code}); restarting in ${wait / 1000}s`);
      this.retry = setTimeout(() => void this.spawn(), wait);
    });
  }

  private async halt(): Promise<void> {
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    const child = this.child;
    if (!child) return;
    await new Promise<void>((resolve) => {
      const kill = setTimeout(() => child.kill("SIGKILL"), 10_000);
      child.once("exit", () => {
        clearTimeout(kill);
        resolve();
      });
      if (!this.send({ type: "stop" })) child.kill("SIGTERM");
    });
  }
}

export const director = new Director();
