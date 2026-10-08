import type { BroadcastStatus } from "../broadcast";
import type { Destination } from "../store";
import type { PlaylistTrack } from "./mixer";

/**
 * What the server and its renderer process say to each other over the IPC
 * channel. Kept apart from the renderer itself so the server can import the
 * shapes without importing — and so starting — the renderer.
 */

export type ToRenderer =
  | { type: "start"; destinations: Destination[]; tracks: PlaylistTrack[]; volume: number }
  | { type: "destinations"; destinations: Destination[] }
  | { type: "tracks"; tracks: PlaylistTrack[] }
  | { type: "volume"; volume: number }
  | { type: "next" }
  | { type: "rehearse" }
  | { type: "stop" };

export interface RendererStatus extends BroadcastStatus {
  nowPlaying: string | null;
  /** When the board last answered; a stale board is still drawn. */
  boardAt: number;
  /** Milliseconds one frame takes to paint. */
  paintMs: number;
  /** Frames let go because painting or the encoder fell behind. */
  dropped: number;
}

export type FromRenderer =
  | { type: "ready" }
  | { type: "status"; status: RendererStatus }
  /** The current frame as a JPEG, about once a second, for the studio's preview. */
  | { type: "preview"; jpeg: Uint8Array };
