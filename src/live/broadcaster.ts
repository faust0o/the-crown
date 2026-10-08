import type { BroadcastStatus } from "./api";

/**
 * The page's end of a broadcast: record the stage and its music, and send the
 * recording up the ingest socket in half-second pieces.
 *
 * The server does the rest — see server/src/live/. What this owns is staying
 * on air: a dropped socket or a failed encoder is reconnected with a backoff
 * for as long as the operator wants to be live, and only three things end a
 * broadcast for good — Stop, another window taking over, and the server
 * refusing to start one at all.
 */

export type Phase = "idle" | "connecting" | "live" | "reconnecting" | "stopping";

export interface OnAir {
  phase: Phase;
  /** The server's account of the encoder and every destination. */
  status: BroadcastStatus | null;
  /** The last thing that went wrong, for the operator. */
  error: string | null;
  /** Recording not yet sent — grows when the uplink is slower than the stream. */
  queued: number;
  since: number | null;
}

/** Codes the server closes with; see server/src/live/routes.ts. */
const REPLACED = 4001;
const REFUSED = 4400;
const FAILED = 4500;
const BACKLOG = 4000;

const RETRY_MS = [2_000, 5_000, 10_000, 20_000];
/** The uplink is this far behind: start over rather than send stale video. */
const MAX_QUEUED = 64 * 1024 * 1024;
const SLICE_MS = 500;

/** WebM, because that is what ffmpeg reads off a pipe without a seekable file. */
const MIMES = [
  "video/webm;codecs=vp8,opus",
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=h264,opus",
  "video/webm",
];

export function recorderMime(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  return MIMES.find((m) => MediaRecorder.isTypeSupported(m)) ?? null;
}

export class Broadcaster {
  state: OnAir = { phase: "idle", status: null, error: null, queued: 0, since: null };
  private readonly capture: () => MediaStream;
  private readonly onChange: (state: OnAir) => void;
  private ws: WebSocket | null = null;
  private recorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private wanted = false;
  private attempt = 0;
  private retry: ReturnType<typeof setTimeout> | null = null;

  /** `capture` is asked for a fresh stream on every connection. */
  constructor(capture: () => MediaStream, onChange: (state: OnAir) => void) {
    this.capture = capture;
    this.onChange = onChange;
  }

  private set(patch: Partial<OnAir>) {
    this.state = { ...this.state, ...patch };
    this.onChange(this.state);
  }

  start(): void {
    if (this.wanted) return;
    const mime = recorderMime();
    if (!mime) {
      this.set({ error: "This browser can't record WebM. Use Chrome, Edge or Firefox." });
      return;
    }
    this.wanted = true;
    this.attempt = 0;
    this.set({ error: null, since: Date.now() });
    this.connect(mime);
  }

  stop(): void {
    this.wanted = false;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    const ws = this.ws;
    if (!ws) {
      this.set({ phase: "idle", since: null });
      return;
    }
    this.set({ phase: "stopping" });
    // The last slice is handed over when the recorder stops, and only then is
    // the server told to finish — so the stream ends on its last frame.
    const finish = () => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "stop" }));
      setTimeout(() => ws.close(), 10_000);
    };
    if (this.recorder && this.recorder.state !== "inactive") {
      this.recorder.addEventListener("stop", finish, { once: true });
      this.recorder.stop();
    } else {
      finish();
    }
  }

  private connect(mime: string): void {
    this.set({ phase: this.attempt ? "reconnecting" : "connecting" });
    const scheme = window.location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${scheme}://${window.location.host}/api/live/ingest`);
    this.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ type: "start", mime }));
    ws.onmessage = (e) => {
      if (typeof e.data !== "string") return;
      let message: { type?: string; status?: BroadcastStatus; message?: string };
      try {
        message = JSON.parse(e.data);
      } catch {
        return;
      }
      if (message.type === "ready") this.record(ws, mime);
      else if (message.type === "error") this.set({ error: message.message ?? null });
      else if (message.type === "status" && message.status) {
        // Live long enough for a destination to take it: the next drop starts
        // the backoff over.
        if (message.status.destinations.some((d) => d.state === "live")) this.attempt = 0;
        this.set({ status: message.status });
      }
    };
    ws.onclose = (e) => this.closed(ws, e);
  }

  private record(ws: WebSocket, mime: string): void {
    this.stream = this.capture();
    const recorder = new MediaRecorder(this.stream, {
      mimeType: mime,
      // Generous, because the server encodes it again: this only has to carry
      // the picture to the encoder intact.
      videoBitsPerSecond: 6_000_000,
      audioBitsPerSecond: 160_000,
    });
    recorder.ondataavailable = (e) => {
      if (!e.data.size || ws.readyState !== WebSocket.OPEN) return;
      ws.send(e.data);
      this.set({ queued: ws.bufferedAmount });
      if (ws.bufferedAmount > MAX_QUEUED) {
        ws.close(BACKLOG, "The upload fell behind.");
      }
    };
    recorder.onerror = () => ws.close(BACKLOG, "The recorder stopped.");
    recorder.start(SLICE_MS);
    this.recorder = recorder;
    this.set({ phase: "live", error: null });
  }

  private closed(ws: WebSocket, e: CloseEvent): void {
    if (this.ws !== ws) return;
    this.ws = null;
    if (this.recorder && this.recorder.state !== "inactive") this.recorder.stop();
    this.recorder = null;
    // The canvas capture is per connection; the music's track is not ours to end.
    for (const track of this.stream?.getVideoTracks() ?? []) track.stop();
    this.stream = null;

    if (!this.wanted) {
      this.set({ phase: "idle", since: null, queued: 0 });
      return;
    }
    if (e.code === REPLACED || e.code === REFUSED) {
      this.wanted = false;
      this.set({
        phase: "idle",
        since: null,
        queued: 0,
        error: e.code === REPLACED ? "Another window took over the broadcast." : (e.reason || this.state.error),
      });
      return;
    }
    const wait = RETRY_MS[Math.min(this.attempt, RETRY_MS.length - 1)];
    this.attempt++;
    this.set({
      phase: "reconnecting",
      queued: 0,
      error:
        e.code === FAILED
          ? `The encoder stopped: ${e.reason}`
          : e.code === BACKLOG
            ? e.reason
            : "Lost the connection to the server.",
    });
    this.retry = setTimeout(() => {
      this.retry = null;
      const mime = recorderMime();
      if (this.wanted && mime) this.connect(mime);
    }, wait);
  }

  dispose(): void {
    this.stop();
  }
}
