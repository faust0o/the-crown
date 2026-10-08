/**
 * The studio's half of /api/live. The session is an HttpOnly cookie the server
 * sets at sign-in, so nothing here holds a token; every call is same-origin and
 * the cookie rides along.
 *
 * The broadcast itself runs on the server. This is its remote control.
 */

export interface Destination {
  id: string;
  label: string;
  url: string;
  /** The key's last characters, enough to tell two apart. Never the key. */
  keyHint: string;
  enabled: boolean;
}

export interface Track {
  id: string;
  name: string;
  bytes: number;
  addedAt: string;
}

export type DestinationState = "connecting" | "live" | "retrying";

export interface BroadcastStatus {
  state: "starting" | "live" | "stopping" | "stopped" | "failed";
  startedAt: number;
  error: string | null;
  fps: number | null;
  speed: number | null;
  kbps: number | null;
  destinations: {
    id: string;
    label: string;
    state: DestinationState;
    error: string | null;
    kbps: number | null;
    since: number | null;
  }[];
  nowPlaying: string | null;
  /** When the server's renderer last got an answer from the board. */
  boardAt: number;
  /** Milliseconds one frame takes to paint. */
  paintMs: number;
}

export interface StudioState {
  ffmpeg: boolean;
  destinations: Destination[];
  tracks: Track[];
  volume: number;
  /** Whether the stream should be on air — saved, so it survives restarts. */
  onAir: boolean;
  /** Whether it is being rendered right now. */
  running: boolean;
  restarting: boolean;
  /** Why the renderer last stopped, if it did not mean to. */
  error: string | null;
  status: BroadcastStatus | null;
}

/** The server said no, and said why. `status` 401 means the session is gone. */
export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/live${path}`, { credentials: "same-origin", ...init });
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(body?.error ?? `Request failed (${res.status}).`, res.status);
  return body as T;
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

/**
 * Small enough that a part arrives inside the server's 30-second limit on any
 * one request even over a slow uplink: 2 MB at 1 Mbit/s is sixteen seconds.
 */
const PART_BYTES = 2 * 1024 * 1024;

/** An MP3, sent in parts — see `addTrackPart` on the server. */
async function uploadTrack(file: File, onProgress?: (fraction: number) => void): Promise<Track> {
  const id = [...crypto.getRandomValues(new Uint8Array(8))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  for (let offset = 0; ; ) {
    const end = Math.min(file.size, offset + PART_BYTES);
    const final = end >= file.size;
    const result = await call<Track | { received: number }>("/tracks", {
      method: "POST",
      headers: {
        "Content-Type": "audio/mpeg",
        "X-Track-Name": encodeURIComponent(file.name),
        "X-Upload-Id": id,
        "X-Upload-Offset": String(offset),
        "X-Upload-Final": final ? "1" : "0",
      },
      body: file.slice(offset, end),
    });
    if (final) return result as Track;
    offset = end;
    onProgress?.(offset / file.size);
  }
}

export const api = {
  session: () => call<{ signedIn: boolean }>("/session"),
  login: (password: string) => call<{ signedIn: boolean }>("/login", json("POST", { password })),
  logout: () => call<{ signedIn: boolean }>("/logout", { method: "POST" }),
  state: () => call<StudioState>("/state"),
  setOnAir: (onAir: boolean) => call<StudioState>("/broadcast", json("POST", { onAir })),
  rehearse: () => call<void>("/rehearse", { method: "POST" }),
  nextTrack: () => call<void>("/music/next", { method: "POST" }),
  setVolume: (volume: number) => call<{ volume: number }>("/settings", json("PUT", { volume })),
  addDestination: (d: { label: string; url: string; key: string }) =>
    call<Destination>("/destinations", json("POST", d)),
  updateDestination: (id: string, patch: Partial<{ label: string; url: string; key: string; enabled: boolean }>) =>
    call<Destination>(`/destinations/${id}`, json("PATCH", patch)),
  removeDestination: (id: string) => call<void>(`/destinations/${id}`, { method: "DELETE" }),
  uploadTrack,
  reorderTracks: (ids: string[]) => call<Track[]>("/tracks/order", json("PUT", { ids })),
  removeTrack: (id: string) => call<void>(`/tracks/${id}`, { method: "DELETE" }),
};
