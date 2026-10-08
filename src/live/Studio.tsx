import { useCallback, useEffect, useReducer, useRef, useState, type ReactNode } from "react";
import { useClock } from "../casino/hooks/useClock";
import { Button, Rail, Readout, Section, Tag, cx } from "../casino/ui";
import { api, ApiError, type StudioState } from "./api";
import { Broadcaster, recorderMime, type OnAir, type Phase } from "./broadcaster";
import { Destinations } from "./Destinations";
import { Music } from "./music";
import { MusicPanel } from "./MusicPanel";
import { FPS, Stage } from "./Stage";
import { useRace } from "./useRace";

/** Runs an API call, sending a lost session back to the gate and anything else to the notice. */
export type Guard = <T>(work: () => Promise<T>) => Promise<T | undefined>;

const PHASE: Record<Phase, string> = {
  idle: "Off air",
  connecting: "Connecting…",
  live: "On air",
  reconnecting: "Reconnecting…",
  stopping: "Stopping…",
};

/**
 * The control room: the stream as it goes out, the switch that puts it on air,
 * where it goes and what plays under it.
 */
export function Studio({ onSignedOut }: { onSignedOut: () => void }) {
  const { race, history, crowning, rehearse, error: boardDown } = useRace();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [studio, setStudio] = useState<StudioState | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const guard = useCallback<Guard>(
    async (work) => {
      try {
        return await work();
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) onSignedOut();
        else setProblem(err instanceof Error ? err.message : "Something went wrong.");
        return undefined;
      }
    },
    [onSignedOut]
  );

  // Polled too, for what this window does not hear about on its own socket: a
  // broadcast running from another window, and edits made from one.
  const refresh = useCallback(async () => {
    const next = await guard(() => api.state());
    if (next) setStudio(next);
  }, [guard]);
  useEffect(() => {
    void refresh();
    const timer = setInterval(refresh, 5_000);
    return () => clearInterval(timer);
  }, [refresh]);

  // Created in an effect, not during render, so StrictMode's double mount
  // closes the first rather than leaving two audio graphs running.
  const [music, setMusic] = useState<Music | null>(null);
  useEffect(() => {
    const m = new Music();
    setMusic(m);
    return () => m.close();
  }, []);
  const [, musicChanged] = useReducer((n: number) => n + 1, 0);
  useEffect(() => music?.subscribe(musicChanged), [music]);
  const tracks = studio?.tracks;
  useEffect(() => {
    if (music && tracks) music.setTracks(tracks);
  }, [music, tracks]);

  const [onAir, setOnAir] = useState<OnAir | null>(null);
  const [broadcaster, setBroadcaster] = useState<Broadcaster | null>(null);
  useEffect(() => {
    if (!music) return;
    const b = new Broadcaster(
      () =>
        new MediaStream([...canvasRef.current!.captureStream(FPS).getVideoTracks(), music.track]),
      setOnAir
    );
    setBroadcaster(b);
    setOnAir(b.state);
    return () => b.dispose();
  }, [music]);

  const phase = onAir?.phase ?? "idle";
  const here = phase !== "idle";
  const elsewhere =
    !here && (studio?.broadcast?.state === "live" || studio?.broadcast?.state === "starting");
  const status = here ? onAir?.status : studio?.broadcast;
  const enabled = (studio?.destinations ?? []).filter((d) => d.enabled).length;

  // Leaving the page ends the broadcast; say so before it happens.
  useEffect(() => {
    if (!here) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [here]);

  const goLive = async () => {
    if (!music || !broadcaster) return;
    setProblem(null);
    // In the click, so the browser lets the audio start.
    await music.play();
    broadcaster.start();
  };
  const stop = () => {
    broadcaster?.stop();
    music?.pause();
  };
  const signOut = async () => {
    stop();
    await api.logout().catch(() => {});
    onSignedOut();
  };

  const canRecord = recorderMime() !== null;
  const blocked = !studio ? "Loading…" : !studio.ffmpeg ? "No ffmpeg on the server" : !enabled ? "Add a destination" : null;

  return (
    <>
      <header className="mat-panel-flush mat-grain sticky top-0 z-30 rounded-none border-x-0 border-t-0">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-6 py-3">
          <a href="/" className="flex items-center gap-2.5 no-underline">
            <img src="/crown-icon.svg" alt="" aria-hidden="true" width={28} height={28} className="h-7 w-7 shrink-0 rounded" />
            <span className="mat-engrave text-lg font-semibold text-foreground">The Crown</span>
          </a>
          <Tag>Studio</Tag>
          <span className="flex items-center gap-2 text-sm text-secondary" role="status">
            <span
              aria-hidden="true"
              className={cx("inline-block h-3.5 w-3.5 rounded-full", phase === "live" ? "mat-glass mat-dome" : "mat-inset")}
            />
            {elsewhere ? "On air from another window" : PHASE[phase]}
          </span>
          <div className="ml-auto flex items-center gap-3">
            <Button variant="ghost" className="text-xs" onClick={signOut}>
              Sign out
            </Button>
          </div>
        </div>
        <Rail groove />
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-5">
        {problem && (
          <div role="alert" className="mb-4 flex items-start justify-between gap-4 rounded-lg border border-hairline px-3 py-2 text-sm text-down">
            <span>{problem}</span>
            <Button variant="ghost" className="text-xs" onClick={() => setProblem(null)}>
              Dismiss
            </Button>
          </div>
        )}

        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="flex min-w-0 flex-col gap-5">
            <Section
              title="The stream"
              aside={<span className="font-mono tabular-nums">1280×720 · {FPS} fps</span>}
            >
              <Stage race={race} history={history} crowning={crowning} canvasRef={canvasRef} />

              <div className="mt-4 flex flex-wrap items-center gap-3">
                {here ? (
                  <Button size="lg" onClick={stop} disabled={phase === "stopping"}>
                    {phase === "stopping" ? "Stopping…" : "Stop broadcast"}
                  </Button>
                ) : (
                  <Button
                    size="lg"
                    variant="glass"
                    onClick={goLive}
                    disabled={Boolean(blocked) || !canRecord}
                    title={blocked ?? undefined}
                  >
                    {elsewhere ? "Take over and go live" : "Go live"}
                  </Button>
                )}
                <Button onClick={rehearse} disabled={!race.field.length}>
                  Rehearse the crown
                </Button>
                {(here || elsewhere) && status && (
                  <div className="ml-auto flex flex-wrap gap-5">
                    <Readout size="sm" label="On air" value={<Uptime since={here ? onAir?.since ?? null : status.startedAt} />} />
                    <Readout size="sm" label="Encoder" value={status.fps != null ? `${status.fps.toFixed(0)} fps` : "—"} />
                    <Readout size="sm" label="Speed" value={status.speed != null ? `${status.speed.toFixed(2)}×` : "—"} />
                    <Readout size="sm" label="Bitrate" value={status.kbps != null ? `${(status.kbps / 1000).toFixed(1)} Mb/s` : "—"} />
                  </div>
                )}
              </div>

              <ul className="m-0 mt-4 flex list-none flex-col gap-1.5 p-0 text-xs">
                {!canRecord && <Hint tone="down">This browser can't record WebM. Broadcast from Chrome, Edge or Firefox.</Hint>}
                {studio && !studio.ffmpeg && (
                  <Hint tone="down">
                    The server has no ffmpeg. Set <code>RAILPACK_DEPLOY_APT_PACKAGES=ffmpeg</code> on the
                    service and redeploy.
                  </Hint>
                )}
                {studio?.ffmpeg && !enabled && <Hint>Add a destination, or switch one on, to go live.</Hint>}
                {onAir?.error && <Hint tone="down">{onAir.error}</Hint>}
                {status?.state === "failed" && status.error && !here && <Hint tone="down">{status.error}</Hint>}
                {elsewhere && <Hint>Another window is broadcasting. Going live here takes over from it.</Hint>}
                {here && (onAir?.queued ?? 0) > 4 * 1024 * 1024 && (
                  <Hint tone="down">
                    The upload is {((onAir?.queued ?? 0) / 1024 / 1024).toFixed(0)} MB behind — this
                    connection may be too slow for the stream.
                  </Hint>
                )}
                {boardDown && <Hint tone="down">Can't reach the board. The stream is showing the last reading.</Hint>}
                <Hint>
                  The stream goes out from this tab: keep it open, and on screen. A hidden tab keeps
                  broadcasting, but the chart only moves while the tab is visible.
                </Hint>
                <Hint>
                  When a round's cut lands, the chart fades out and the winner takes the crown for
                  fourteen seconds. Rehearse it to see it before the room does — it goes out on
                  air if you are live.
                </Hint>
              </ul>
            </Section>
          </div>

          <div className="flex min-w-0 flex-col gap-5">
            <Destinations
              destinations={studio?.destinations ?? []}
              live={here ? (onAir?.status?.destinations ?? []) : (studio?.broadcast?.destinations ?? [])}
              guard={guard}
              refresh={refresh}
            />
            <MusicPanel music={music} tracks={studio?.tracks ?? []} guard={guard} refresh={refresh} />
          </div>
        </div>
      </main>

      <Rail groove className="mt-auto" />
    </>
  );
}

function Hint({ tone, children }: { tone?: "down"; children: ReactNode }) {
  return (
    <li className={cx("m-0 leading-relaxed", tone === "down" ? "text-down" : "text-muted")}>{children}</li>
  );
}

/** Its own component, so the second hand re-renders this and not the studio. */
function Uptime({ since }: { since: number | null }) {
  const now = useClock();
  if (!since) return <>—</>;
  const s = Math.max(0, Math.floor((now.getTime() - since) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return (
    <>
      {h ? `${h}:${String(m).padStart(2, "0")}` : m}:{String(s % 60).padStart(2, "0")}
    </>
  );
}
