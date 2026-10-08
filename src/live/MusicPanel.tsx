import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { Button, Caption, IconButton, Section, cx } from "../casino/ui";
import { api, type Track } from "./api";
import type { Guard } from "./Studio";

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/**
 * What plays under the stream: uploaded MP3s, in this order, on a loop.
 *
 * The music is mixed on the server, into the stream, so what the room hears is
 * exactly this list — whether or not anybody has this page open. To hear it,
 * watch the stream.
 */
export function MusicPanel({
  tracks,
  volume,
  nowPlaying,
  running,
  guard,
  refresh,
}: {
  tracks: Track[];
  volume: number;
  nowPlaying: string | null;
  running: boolean;
  guard: Guard;
  refresh: () => Promise<void>;
}) {
  const picker = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState<string | null>(null);

  // The slider answers at once; the server hears where it settled.
  const [level, setLevel] = useState(volume);
  const dragging = useRef(false);
  useEffect(() => {
    if (!dragging.current) setLevel(volume);
  }, [volume]);
  useEffect(() => {
    if (Math.abs(level - volume) < 0.001) return;
    const timer = setTimeout(() => {
      dragging.current = false;
      void guard(() => api.setVolume(level));
    }, 300);
    return () => clearTimeout(timer);
  }, [level, volume, guard]);

  const upload = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = [...(e.target.files ?? [])];
    e.target.value = "";
    // One at a time: the list should fill in the order they were picked.
    for (const [i, file] of files.entries()) {
      const which = files.length > 1 ? ` ${i + 1} of ${files.length}` : "";
      setUploading(`Uploading${which}…`);
      await guard(() =>
        api.uploadTrack(file, (f) => setUploading(`Uploading${which}… ${Math.round(f * 100)}%`))
      );
    }
    setUploading(null);
    await refresh();
  };

  const move = async (index: number, by: -1 | 1) => {
    const ids = tracks.map((t) => t.id);
    const [id] = ids.splice(index, 1);
    ids.splice(index + by, 0, id);
    await guard(() => api.reorderTracks(ids));
    await refresh();
  };

  const remove = async (t: Track) => {
    if (!window.confirm(`Delete ${t.name}?`)) return;
    await guard(() => api.removeTrack(t.id));
    await refresh();
  };

  return (
    <Section title="Music" aside={tracks.length ? `${tracks.length} on a loop` : "silence"}>
      <div className="mat-inset rounded-lg px-3 py-2.5">
        <Caption>{nowPlaying ? "Playing on the stream" : running ? "Silence" : "Off air"}</Caption>
        <div className="mt-0.5 truncate text-sm text-foreground">
          {nowPlaying ?? (tracks.length ? "Plays while the stream is on air" : "Upload an MP3 to play under the stream")}
        </div>
        <div className="mt-2.5 flex items-center gap-2">
          <Button size="sm" disabled={!running || tracks.length < 2} onClick={() => guard(() => api.nextTrack())}>
            Next track
          </Button>
          <label className="ml-auto flex items-center gap-2 text-[11px] text-muted">
            Volume
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={level}
              onChange={(e) => {
                dragging.current = true;
                setLevel(Number(e.target.value));
              }}
              className="w-24 accent-[var(--accent)]"
            />
          </label>
        </div>
      </div>

      <ol className="m-0 mt-2 flex list-none flex-col p-0">
        {tracks.map((t, i) => (
          <li
            key={t.id}
            className={cx(
              "flex items-center gap-2 rounded border-b border-[var(--bevel-lo)] px-1 py-1.5 last:border-b-0",
              nowPlaying === t.name && "mat-row-on"
            )}
          >
            <span className="w-5 shrink-0 text-right font-mono text-[11px] text-muted">{i + 1}</span>
            <span className="min-w-0 flex-1 truncate text-sm text-foreground" title={t.name}>
              {t.name}
            </span>
            <span className="shrink-0 font-mono text-[10px] text-muted">{mb(t.bytes)}</span>
            <IconButton label={`Move ${t.name} up`} size="xs" disabled={i === 0} onClick={() => move(i, -1)}>
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" aria-hidden="true" fill="none">
                <path d="M7 14l5-5 5 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </IconButton>
            <IconButton label={`Move ${t.name} down`} size="xs" disabled={i === tracks.length - 1} onClick={() => move(i, 1)}>
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" aria-hidden="true" fill="none">
                <path d="M7 10l5 5 5-5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </IconButton>
            <IconButton label={`Delete ${t.name}`} size="xs" onClick={() => remove(t)}>
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" aria-hidden="true" fill="none">
                <path d="M7 7l10 10M17 7L7 17" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            </IconButton>
          </li>
        ))}
      </ol>

      <div className="mt-3 flex items-center gap-3">
        <input ref={picker} type="file" accept="audio/mpeg,.mp3" multiple className="hidden" onChange={upload} />
        <Button onClick={() => picker.current?.click()} disabled={Boolean(uploading)}>
          {uploading ?? "Upload MP3s"}
        </Button>
        <span className="text-[11px] text-muted">Up to 50 MB each</span>
      </div>
    </Section>
  );
}
