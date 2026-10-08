import type { Track } from "./api";

export const trackUrl = (id: string) => `/api/live/tracks/${id}/audio`;

/**
 * The music under the stream: the uploaded tracks in order, looping forever.
 *
 * One <audio> element plays them, routed through Web Audio so the same signal
 * can go two ways — into the stream's audio track, always, and to the
 * operator's speakers only when they ask to hear it. A track that fails is
 * skipped after a pause, so a playlist of broken files does not spin.
 *
 * The audio track exists from the moment this does and carries silence until
 * something plays: every ingest wants a stream with sound in it, music or not.
 */
export class Music {
  readonly context = new AudioContext();
  private readonly element = new Audio();
  private readonly level = this.context.createGain();
  private readonly monitorLevel = this.context.createGain();
  private readonly output = this.context.createMediaStreamDestination();
  private tracks: Track[] = [];
  private index = 0;
  private wanted = false;
  private skip: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Set<() => void>();

  constructor() {
    this.element.preload = "auto";
    const source = this.context.createMediaElementSource(this.element);
    source.connect(this.level);
    this.level.connect(this.output);
    this.level.connect(this.monitorLevel);
    this.monitorLevel.connect(this.context.destination);
    this.monitorLevel.gain.value = 0;
    this.level.gain.value = 0.8;

    this.element.addEventListener("ended", () => this.advance());
    this.element.addEventListener("error", () => {
      if (!this.wanted) return;
      this.skip = setTimeout(() => this.advance(), 2_000);
    });
    for (const ev of ["play", "pause", "playing"] as const) {
      this.element.addEventListener(ev, () => this.changed());
    }
  }

  /** The stream's audio, to record beside the canvas. */
  get track(): MediaStreamTrack {
    return this.output.stream.getAudioTracks()[0];
  }

  get playing(): boolean {
    return this.wanted && !this.element.paused;
  }

  get current(): Track | null {
    return this.tracks[this.index] ?? null;
  }

  get volume(): number {
    return this.level.gain.value;
  }

  get monitoring(): boolean {
    return this.monitorLevel.gain.value > 0;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed() {
    for (const fn of this.listeners) fn();
  }

  /**
   * A new playlist. The track playing carries on if it is still in it; if it
   * was deleted, the one that took its place in the order plays instead.
   */
  setTracks(tracks: Track[]): void {
    const playing = this.current?.id;
    this.tracks = tracks;
    const kept = tracks.findIndex((t) => t.id === playing);
    if (kept >= 0) {
      this.index = kept;
    } else {
      this.index = tracks.length ? Math.min(this.index, tracks.length - 1) : 0;
      if (this.wanted) this.load();
    }
    this.element.loop = tracks.length === 1;
    this.changed();
  }

  /** Must be called from a click: browsers start audio only for a gesture. */
  async play(): Promise<void> {
    this.wanted = true;
    await this.context.resume();
    if (!this.tracks.length) {
      this.changed();
      return;
    }
    if (!this.element.src) this.load();
    else await this.element.play().catch(() => {});
    this.changed();
  }

  pause(): void {
    this.wanted = false;
    this.element.pause();
    this.changed();
  }

  next(): void {
    this.advance();
  }

  setVolume(v: number): void {
    this.level.gain.value = Math.min(1, Math.max(0, v));
    this.changed();
  }

  /** Hear it here. The stream gets the music either way. */
  setMonitoring(on: boolean): void {
    this.monitorLevel.gain.value = on ? 1 : 0;
    this.changed();
  }

  private advance(): void {
    if (this.skip) clearTimeout(this.skip);
    this.skip = null;
    if (!this.tracks.length) return;
    this.index = (this.index + 1) % this.tracks.length;
    this.load();
  }

  private load(): void {
    const t = this.current;
    if (!t) {
      this.element.removeAttribute("src");
      this.element.load();
      return;
    }
    this.element.src = trackUrl(t.id);
    if (this.wanted) void this.element.play().catch(() => {});
    this.changed();
  }

  close(): void {
    this.pause();
    if (this.skip) clearTimeout(this.skip);
    void this.context.close();
  }
}
