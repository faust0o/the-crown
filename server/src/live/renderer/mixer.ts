import { spawn, type ChildProcess } from "node:child_process";
import { FFMPEG_PATH } from "../config";

/**
 * The music under the stream: the uploaded tracks in order, on a loop.
 *
 * Each track is decoded by its own small ffmpeg into raw PCM, and the renderer
 * takes exactly one frame's worth of sound for every frame of picture it
 * writes — so sound and picture share one clock and cannot drift, however long
 * the broadcast runs. Changing the playlist never touches the encoder: the next
 * track simply comes from somewhere else.
 *
 * Silence fills any gap, and is what plays when there is no music at all: every
 * ingest wants a stream with sound in it.
 */

export const SAMPLE_RATE = 44_100;
export const CHANNELS = 2;
/** One sample for each channel. */
const FRAME_BYTES = CHANNELS * 2;
const BYTES_PER_SECOND = SAMPLE_RATE * FRAME_BYTES;
/** Decoded audio held ahead: enough to ride out a slow disk, not a track's worth of memory. */
const HIGH_WATER = BYTES_PER_SECOND * 4;
const LOW_WATER = BYTES_PER_SECOND * 1;
/** A track that decodes to nothing is skipped after this, so a playlist of broken files does not spin. */
const BROKEN_PAUSE_MS = 2_000;

/** Decoded PCM waiting to be played, pulled out in exact amounts at a volume. */
export class PcmQueue {
  private chunks: Buffer[] = [];
  private head = 0;
  size = 0;

  push(chunk: Buffer): void {
    if (!chunk.length) return;
    this.chunks.push(chunk);
    this.size += chunk.length;
  }

  clear(): void {
    this.chunks = [];
    this.head = 0;
    this.size = 0;
  }

  /**
   * Exactly `bytes` of s16le stereo, scaled by `gain`, with silence for
   * whatever is missing. Taken only in whole frames (both channels' samples):
   * a pipe can split a sample between two reads, and handing out the half that
   * arrived would shift every sample after it — noise, or left and right
   * swapped — until the track ended. The odd bytes wait for the rest.
   */
  pull(bytes: number, gain: number): Buffer {
    const out = Buffer.alloc(bytes);
    const take = Math.min(bytes, this.size - (this.size % FRAME_BYTES));
    let filled = 0;
    while (filled < take) {
      const chunk = this.chunks[0];
      const n = Math.min(take - filled, chunk.length - this.head);
      chunk.copy(out, filled, this.head, this.head + n);
      filled += n;
      this.head += n;
      this.size -= n;
      if (this.head >= chunk.length) {
        this.chunks.shift();
        this.head = 0;
      }
    }
    if (gain !== 1) {
      const samples = new Int16Array(out.buffer, out.byteOffset, filled / 2);
      for (let i = 0; i < samples.length; i++) {
        samples[i] = Math.max(-32768, Math.min(32767, Math.round(samples[i] * gain)));
      }
    }
    return out;
  }
}

export interface PlaylistTrack {
  id: string;
  name: string;
  file: string;
}

export class Mixer {
  volume = 0.8;
  private tracks: PlaylistTrack[] = [];
  private index = -1;
  private readonly queue = new PcmQueue();
  private decoder: ChildProcess | null = null;
  private decoding = false;
  private decodedBytes = 0;
  private resumeAt = 0;

  get current(): PlaylistTrack | null {
    return this.decoder || this.queue.size ? (this.tracks[this.index] ?? null) : null;
  }

  /**
   * A new playlist. The track playing carries on if it is still in it; one that
   * was deleted stops, and the track that took its place plays next.
   */
  setTracks(tracks: PlaylistTrack[]): void {
    const playing = this.tracks[this.index]?.id;
    this.tracks = tracks;
    if (!playing) {
      this.index = -1;
      return;
    }
    const kept = tracks.findIndex((t) => t.id === playing);
    if (kept >= 0) {
      this.index = kept;
      return;
    }
    this.index = Math.max(-1, Math.min(this.index, tracks.length) - 1);
    this.stopDecoder();
    this.queue.clear();
  }

  next(): void {
    this.stopDecoder();
    this.queue.clear();
  }

  /** One frame's sound. */
  pull(bytes: number): Buffer {
    if (!this.decoding && this.queue.size < LOW_WATER && Date.now() >= this.resumeAt) this.startNext();
    if (this.decoder?.stdout?.isPaused() && this.queue.size < LOW_WATER) this.decoder.stdout.resume();
    return this.queue.pull(bytes, this.volume);
  }

  private startNext(): void {
    if (!this.tracks.length) return;
    this.index = (((this.index + 1) % this.tracks.length) + this.tracks.length) % this.tracks.length;
    const track = this.tracks[this.index];
    const proc = spawn(
      FFMPEG_PATH,
      ["-hide_banner", "-loglevel", "error", "-nostdin", "-i", track.file, "-vn", "-f", "s16le", "-ac", String(CHANNELS), "-ar", String(SAMPLE_RATE), "pipe:1"],
      { stdio: ["ignore", "pipe", "ignore"] }
    );
    this.decoder = proc;
    this.decoding = true;
    this.decodedBytes = 0;
    proc.stdout!.on("data", (chunk: Buffer) => {
      this.decodedBytes += chunk.length;
      this.queue.push(chunk);
      if (this.queue.size > HIGH_WATER) proc.stdout!.pause();
    });
    proc.on("error", () => {});
    proc.on("close", () => {
      if (this.decoder !== proc) return;
      this.decoder = null;
      this.decoding = false;
      if (!this.decodedBytes) this.resumeAt = Date.now() + BROKEN_PAUSE_MS;
    });
  }

  private stopDecoder(): void {
    const proc = this.decoder;
    this.decoder = null;
    this.decoding = false;
    proc?.kill("SIGKILL");
  }

  close(): void {
    this.stopDecoder();
  }
}
