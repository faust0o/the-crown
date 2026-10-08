import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { join } from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { IS_PRODUCTION } from "../env";
import { isPrivateAddress } from "../logo-proxy";
import { LIVE_DIR } from "./config";

/**
 * Where the stream goes, and what plays under it.
 *
 * A destination is an RTMP ingest — the server URL a platform gives you and the
 * stream key that goes with it. The admin page calls them origins; there may be
 * several, and every enabled one gets the same broadcast.
 *
 * Kept as one JSON file on the volume beside the uploaded MP3s, not in
 * Postgres: the music has to be on disk anyway, it is one operator's settings
 * rather than game state, and it keeps the feature out of the migration path.
 */

export interface Destination {
  id: string;
  label: string;
  /** rtmp:// or rtmps://, as the platform gives it. */
  url: string;
  /** The stream key. Never sent back to the browser — see `publicDestination`. */
  key: string;
  enabled: boolean;
}

export interface Track {
  id: string;
  name: string;
  bytes: number;
  addedAt: string;
}

/**
 * Whether the stream should be on air, kept on disk so that a deploy, a crash
 * or a restart brings it back by itself — it runs until somebody presses Stop.
 */
export interface Settings {
  onAir: boolean;
  /** The music's level under the stream, 0–1. */
  volume: number;
}

interface Saved {
  destinations: Destination[];
  tracks: Track[];
  settings: Settings;
}

const DEFAULT_SETTINGS: Settings = { onAir: false, volume: 0.8 };

export const MAX_DESTINATIONS = 10;
export const MAX_TRACKS = 50;
export const MAX_TRACK_BYTES = 50 * 1024 * 1024;

/** A mistake in what the admin typed or sent — the message is for them. */
export class LiveInputError extends Error {}

const ID = /^[0-9a-f]{16}$/;
const newId = () => randomBytes(8).toString("hex");

/** No whitespace or control characters: either would end up inside an ffmpeg argument. */
const PRINTABLE = /^[^\s\p{Cc}]+$/u;

/**
 * Whether a host is somewhere inside our own network — loopback, a private or
 * link-local address, or a name only an internal resolver answers. `/logo`
 * refuses those for the same reason: a URL somebody typed must not become a
 * way to knock on the database's door. A name that resolves privately is not
 * caught here (ffmpeg does its own lookup); the password is the gate for that.
 */
export function isInternalHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (isIP(host)) return isPrivateAddress(host);
  return host === "localhost" || /\.(localhost|internal|local)$/.test(host);
}

export function parseIngestUrl(raw: unknown, { allowInternal = !IS_PRODUCTION } = {}): string {
  const url = typeof raw === "string" ? raw.trim() : "";
  if (!url || url.length > 500 || !PRINTABLE.test(url)) {
    throw new LiveInputError("Give the RTMP server URL, e.g. rtmp://a.rtmp.youtube.com/live2.");
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new LiveInputError("That RTMP URL doesn't parse.");
  }
  if (parsed.protocol !== "rtmp:" && parsed.protocol !== "rtmps:") {
    throw new LiveInputError("The URL has to start with rtmp:// or rtmps://.");
  }
  if (!parsed.hostname) throw new LiveInputError("The RTMP URL has no host.");
  if (!allowInternal && isInternalHost(parsed.hostname)) {
    throw new LiveInputError("That address is inside the server's own network.");
  }
  return url;
}

export function parseStreamKey(raw: unknown): string {
  const key = typeof raw === "string" ? raw.trim() : "";
  if (key && (key.length > 500 || !PRINTABLE.test(key))) {
    throw new LiveInputError("A stream key can't contain spaces.");
  }
  return key;
}

function parseLabel(raw: unknown, url: string): string {
  const label = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim().slice(0, 60) : "";
  return label || new URL(url).hostname;
}

/**
 * The address ffmpeg publishes to. Platforms hand out the server and the key
 * separately and expect them joined by a slash; a destination saved with no
 * key is taken to be the whole address already.
 */
export function targetOf(d: Pick<Destination, "url" | "key">): string {
  return d.key ? `${d.url.replace(/\/+$/, "")}/${d.key}` : d.url;
}

/** What the browser sees: enough of the key to tell two apart, never the key. */
export function publicDestination(d: Destination) {
  return {
    id: d.id,
    label: d.label,
    url: d.url,
    keyHint: d.key ? (d.key.length >= 12 ? `••••${d.key.slice(-4)}` : "••••") : "",
    enabled: d.enabled,
  };
}

export type PublicDestination = ReturnType<typeof publicDestination>;

/**
 * Take every stream key out of a line of ffmpeg's output before it goes
 * anywhere. ffmpeg names the URL it failed on, and that URL ends in the key.
 */
export function redact(text: string, destinations: Pick<Destination, "url" | "key">[]): string {
  let out = text;
  for (const d of destinations) {
    if (d.key.length >= 4) out = out.split(d.key).join("••••");
  }
  return out;
}

/**
 * The name a track is listed under: the upload's filename, without its
 * extension or anything a filesystem or a terminal would read as structure.
 */
export function trackName(raw: string | undefined): string {
  let name = "";
  try {
    name = decodeURIComponent(raw ?? "");
  } catch {
    name = raw ?? "";
  }
  name = name
    .split(/[\\/]/)
    .pop()!
    .replace(/\p{Cc}/gu, "")
    .replace(/\.mp3$/i, "")
    .trim()
    .slice(0, 120);
  return name || "Untitled";
}

/**
 * An MP3 starts with an ID3 tag or with an MPEG audio frame: eleven sync bits,
 * then a version and a layer that are not the reserved values. The browser
 * would decode almost anything, but an upload is a file kept on our disk and
 * served back from our origin, so it is held to being what it says.
 */
export function looksLikeMp3(head: Buffer): boolean {
  if (head.length >= 3 && head.toString("latin1", 0, 3) === "ID3") return true;
  if (head.length < 2 || head[0] !== 0xff || (head[1] & 0xe0) !== 0xe0) return false;
  const version = (head[1] >> 3) & 0b11;
  const layer = (head[1] >> 1) & 0b11;
  return version !== 0b01 && layer !== 0b00;
}

export class LiveStore {
  private state: Saved | null = null;
  /** Writes in order, one at a time — two saves racing would lose one of them. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly dir: string) {}

  private get configFile() {
    return join(this.dir, "config.json");
  }

  private get trackDir() {
    return join(this.dir, "tracks");
  }

  private async load(): Promise<Saved> {
    if (this.state) return this.state;
    let saved: Saved = { destinations: [], tracks: [], settings: { ...DEFAULT_SETTINGS } };
    try {
      const parsed = JSON.parse(await readFile(this.configFile, "utf8")) as Partial<Saved>;
      saved = {
        destinations: Array.isArray(parsed.destinations) ? parsed.destinations : [],
        tracks: Array.isArray(parsed.tracks) ? parsed.tracks : [],
        settings: { ...DEFAULT_SETTINGS, ...parsed.settings },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        // Unreadable rather than absent. Set it aside instead of saving over it,
        // so a bad write costs the operator a re-entry, not their keys.
        console.warn("⚠  live config unreadable, starting empty:", (err as Error).message);
        await rename(this.configFile, `${this.configFile}.unreadable-${Date.now()}`).catch(() => {});
      }
    }
    this.state = saved;
    return saved;
  }

  /** Written to a temporary name and renamed, so a crash never leaves half a file. */
  private async save(saved: Saved): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const tmp = `${this.configFile}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(saved, null, 2), { mode: 0o600 });
    await rename(tmp, this.configFile);
  }

  private mutate<T>(change: (saved: Saved) => T | Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const saved = await this.load();
      const out = await change(saved);
      await this.save(saved);
      return out;
    });
    this.queue = run.catch(() => {});
    return run;
  }

  async destinations(): Promise<Destination[]> {
    return [...(await this.load()).destinations];
  }

  addDestination(input: { label?: unknown; url?: unknown; key?: unknown }): Promise<Destination> {
    const url = parseIngestUrl(input.url);
    const destination: Destination = {
      id: newId(),
      label: parseLabel(input.label, url),
      url,
      key: parseStreamKey(input.key),
      enabled: true,
    };
    return this.mutate((saved) => {
      if (saved.destinations.length >= MAX_DESTINATIONS) {
        throw new LiveInputError(`That's the limit of ${MAX_DESTINATIONS} destinations.`);
      }
      saved.destinations.push(destination);
      return destination;
    });
  }

  /**
   * Change what was given and leave the rest. An empty `key` keeps the stored
   * one — the form never has the key to show, so blank means "unchanged".
   */
  updateDestination(
    id: string,
    patch: { label?: unknown; url?: unknown; key?: unknown; enabled?: unknown }
  ): Promise<Destination> {
    const url = patch.url === undefined ? undefined : parseIngestUrl(patch.url);
    const key = patch.key === undefined ? "" : parseStreamKey(patch.key);
    return this.mutate((saved) => {
      const d = saved.destinations.find((x) => x.id === id);
      if (!d) throw new LiveInputError("No such destination.");
      if (url) d.url = url;
      if (key) d.key = key;
      if (patch.label !== undefined) d.label = parseLabel(patch.label, d.url);
      if (typeof patch.enabled === "boolean") d.enabled = patch.enabled;
      return { ...d };
    });
  }

  removeDestination(id: string): Promise<void> {
    return this.mutate((saved) => {
      saved.destinations = saved.destinations.filter((d) => d.id !== id);
    });
  }

  async tracks(): Promise<Track[]> {
    return [...(await this.load()).tracks];
  }

  /** The playlist as the renderer plays it: each track with the file it is in. */
  async playlist(): Promise<{ id: string; name: string; file: string }[]> {
    return (await this.load()).tracks.map((t) => ({ id: t.id, name: t.name, file: join(this.trackDir, `${t.id}.mp3`) }));
  }

  async settings(): Promise<Settings> {
    return { ...(await this.load()).settings };
  }

  async updateSettings(patch: { onAir?: unknown; volume?: unknown }): Promise<Settings> {
    if (patch.volume !== undefined && (typeof patch.volume !== "number" || !(patch.volume >= 0 && patch.volume <= 1))) {
      throw new LiveInputError("The volume is a number from 0 to 1.");
    }
    return this.mutate((saved) => {
      if (typeof patch.onAir === "boolean") saved.settings.onAir = patch.onAir;
      if (typeof patch.volume === "number") saved.settings.volume = patch.volume;
      return { ...saved.settings };
    });
  }

  /** The file a track is stored in, or null for an id we never issued. */
  async trackFile(id: string): Promise<string | null> {
    if (!ID.test(id)) return null;
    return (await this.load()).tracks.some((t) => t.id === id) ? join(this.trackDir, `${id}.mp3`) : null;
  }

  /** A whole file in one request. */
  addTrack(rawName: string | undefined, body: Readable): Promise<Track> {
    return this.addTrackPart({ upload: newId(), offset: 0, final: true, name: rawName }, body).then(
      (r) => r.track!
    );
  }

  /**
   * One part of an upload: streamed onto the end of the file so far, and on
   * the last part checked, named and listed.
   *
   * In parts because the server gives any one request 30 seconds to arrive —
   * the defence against connections that dribble — and a 50 MB file on an
   * ordinary uplink takes longer than that. Each part is its own short request,
   * and an upload that loses its place (a part missing, or sent twice) is
   * refused rather than stitched together wrong.
   *
   * Streamed rather than buffered so a part is never held in memory, and capped
   * while it streams so a body that never ends stops at the limit, not the disk.
   */
  async addTrackPart(
    o: { upload: string; offset: number; final: boolean; name?: string },
    body: Readable
  ): Promise<{ track: Track | null; received: number }> {
    if (!ID.test(o.upload)) throw new LiveInputError("That upload has no valid id.");
    if (!Number.isSafeInteger(o.offset) || o.offset < 0) throw new LiveInputError("That upload has no valid offset.");
    await mkdir(this.trackDir, { recursive: true });
    const part = join(this.trackDir, `${o.upload}.upload`);

    if (o.offset === 0) {
      if ((await this.load()).tracks.length >= MAX_TRACKS) {
        throw new LiveInputError(`That's the limit of ${MAX_TRACKS} tracks.`);
      }
      await this.sweepAbandoned();
    } else if ((await stat(part).catch(() => null))?.size !== o.offset) {
      throw new LiveInputError("The upload lost its place. Try it again.");
    }

    let bytes = o.offset;
    let head = Buffer.alloc(0);
    const meter = new Transform({
      transform(chunk: Buffer, _enc, done) {
        bytes += chunk.length;
        if (o.offset === 0 && head.length < 4) head = Buffer.concat([head, chunk]).subarray(0, 4);
        if (bytes > MAX_TRACK_BYTES) {
          done(new LiveInputError(`Tracks are limited to ${MAX_TRACK_BYTES / 1024 / 1024} MB.`));
          return;
        }
        done(null, chunk);
      },
    });

    const file = join(this.trackDir, `${o.upload}.mp3`);
    try {
      await pipeline(body, meter, createWriteStream(part, { flags: o.offset === 0 ? "w" : "a", mode: 0o600 }));
      if (o.offset === 0 && bytes > 0 && !looksLikeMp3(head)) {
        throw new LiveInputError("That doesn't look like an MP3.");
      }
      if (!o.final) return { track: null, received: bytes };
      if (!bytes) throw new LiveInputError("That file is empty.");
      await rename(part, file);
    } catch (err) {
      await rm(part, { force: true });
      throw err;
    }

    const track: Track = { id: o.upload, name: trackName(o.name), bytes, addedAt: new Date().toISOString() };
    try {
      return await this.mutate((saved) => {
        if (saved.tracks.length >= MAX_TRACKS) {
          throw new LiveInputError(`That's the limit of ${MAX_TRACKS} tracks.`);
        }
        if (saved.tracks.some((t) => t.id === track.id)) {
          throw new LiveInputError("That upload has already finished.");
        }
        saved.tracks.push(track);
        return { track, received: bytes };
      });
    } catch (err) {
      await rm(file, { force: true });
      throw err;
    }
  }

  /** Parts of uploads nobody finished, left by a closed tab. */
  private async sweepAbandoned(): Promise<void> {
    const cutoff = Date.now() - 6 * 60 * 60_000;
    for (const name of await readdir(this.trackDir).catch(() => [] as string[])) {
      if (!name.endsWith(".upload")) continue;
      const path = join(this.trackDir, name);
      const s = await stat(path).catch(() => null);
      if (s && s.mtimeMs < cutoff) await rm(path, { force: true });
    }
  }

  removeTrack(id: string): Promise<void> {
    return this.mutate(async (saved) => {
      saved.tracks = saved.tracks.filter((t) => t.id !== id);
      if (ID.test(id)) await rm(join(this.trackDir, `${id}.mp3`), { force: true });
    });
  }

  /** The play order. Must name every track exactly once. */
  reorderTracks(ids: unknown): Promise<Track[]> {
    return this.mutate((saved) => {
      const order = Array.isArray(ids) ? ids : [];
      const byId = new Map(saved.tracks.map((t) => [t.id, t]));
      if (order.length !== byId.size || new Set(order).size !== order.length || !order.every((id) => byId.has(id))) {
        throw new LiveInputError("The new order has to list every track once.");
      }
      saved.tracks = order.map((id) => byId.get(id)!);
      return [...saved.tracks];
    });
  }
}

export const liveStore = new LiveStore(LIVE_DIR);
