import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useClock } from "../casino/hooks/useClock";
import { Button, Rail, Readout, Section, Tag, cx } from "../casino/ui";
import { api, ApiError, type StudioState } from "./api";
import { Destinations } from "./Destinations";
import { MusicPanel } from "./MusicPanel";

/** Runs an API call, sending a lost session back to the gate and anything else to the notice. */
export type Guard = <T>(work: () => Promise<T>) => Promise<T | undefined>;

const POLL_MS = 2_000;
const PREVIEW_MS = 1_000;
/** The board this long silent, and the stream is showing an old reading. */
const STALE_MS = 30_000;

/**
 * The control room.
 *
 * The broadcast runs on the server — a renderer draws it and ffmpeg sends it —
 * so this page is a remote control and a monitor, nothing more. Going live is a
 * setting the server keeps: the stream carries on with this page closed, and
 * comes back by itself after a deploy, until somebody presses Stop.
 */
export function Studio({ onSignedOut }: { onSignedOut: () => void }) {
  const [studio, setStudio] = useState<StudioState | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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

  const refresh = useCallback(async () => {
    const next = await guard(() => api.state());
    if (next) setStudio(next);
  }, [guard]);
  useEffect(() => {
    void refresh();
    const timer = setInterval(refresh, POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const switchTo = async (onAir: boolean) => {
    if (!onAir && !window.confirm("Stop the broadcast? It stays off until somebody presses Go live.")) return;
    setProblem(null);
    setBusy(true);
    const next = await guard(() => api.setOnAir(onAir));
    setBusy(false);
    if (next) setStudio(next);
  };

  const signOut = async () => {
    await api.logout().catch(() => {});
    onSignedOut();
  };

  const status = studio?.status ?? null;
  const onAir = studio?.onAir ?? false;
  const running = studio?.running ?? false;
  const enabled = (studio?.destinations ?? []).filter((d) => d.enabled).length;
  const phase = !onAir
    ? "Off air"
    : running && status?.state === "live"
      ? "On air"
      : studio?.restarting
        ? "Restarting…"
        : "Starting…";
  const blocked = !studio ? "Loading…" : !studio.ffmpeg ? "No ffmpeg on the server" : !enabled ? "Add a destination" : null;
  const boardSilent = status && status.boardAt ? Date.now() - status.boardAt > STALE_MS : Boolean(status);

  return (
    <>
      <header className="mat-panel-flush mat-grain sticky top-0 z-30 rounded-none border-x-0 border-t-0">
        <div className="casino-gutter mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 py-3">
          <a href="/" className="flex items-center gap-2.5 no-underline">
            <img src="/crown-icon.svg" alt="" aria-hidden="true" width={28} height={28} className="h-7 w-7 shrink-0 rounded" />
            <span className="mat-engrave text-lg font-semibold text-foreground">The Crown</span>
          </a>
          <Tag>Studio</Tag>
          <span className="flex items-center gap-2 text-sm text-secondary" role="status">
            <span
              aria-hidden="true"
              className={cx("inline-block h-3.5 w-3.5 rounded-full", phase === "On air" ? "mat-glass mat-dome" : "mat-inset")}
            />
            {phase}
          </span>
          <div className="ml-auto flex items-center gap-3">
            <Button variant="ghost" className="text-xs" onClick={signOut}>
              Sign out
            </Button>
          </div>
        </div>
        <Rail groove />
      </header>

      <main className="casino-gutter mx-auto w-full max-w-6xl flex-1 py-5">
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
            <Section title="The stream" aside={<span className="font-mono tabular-nums">1280×720 · 30 fps</span>}>
              <Preview running={running} onAir={onAir} />

              <div className="mt-4 flex flex-wrap items-center gap-3">
                {onAir ? (
                  <Button size="lg" onClick={() => switchTo(false)} disabled={busy}>
                    Stop broadcast
                  </Button>
                ) : (
                  <Button
                    size="lg"
                    variant="glass"
                    onClick={() => switchTo(true)}
                    disabled={busy || Boolean(blocked)}
                    title={blocked ?? undefined}
                  >
                    {busy ? "Starting…" : "Go live"}
                  </Button>
                )}
                <Button onClick={() => guard(() => api.rehearse())} disabled={!running}>
                  Rehearse the crown
                </Button>
                {running && status && (
                  <div className="ml-auto flex flex-wrap gap-5">
                    <Readout size="sm" label="On air" value={<Uptime since={status.startedAt} />} />
                    <Readout size="sm" label="Encoder" value={status.fps != null ? `${status.fps.toFixed(0)} fps` : "—"} />
                    <Readout size="sm" label="Speed" value={status.speed != null ? `${status.speed.toFixed(2)}×` : "—"} />
                    <Readout size="sm" label="Bitrate" value={status.kbps != null ? `${(status.kbps / 1000).toFixed(1)} Mb/s` : "—"} />
                  </div>
                )}
              </div>

              <ul className="m-0 mt-4 flex list-none flex-col gap-1.5 p-0 text-xs">
                {studio && !studio.ffmpeg && (
                  <Hint tone="down">
                    The server has no ffmpeg. Set <code>RAILPACK_DEPLOY_APT_PACKAGES=ffmpeg</code> on the
                    service and redeploy.
                  </Hint>
                )}
                {studio?.ffmpeg && !enabled && <Hint>Add a destination, or switch one on, to go live.</Hint>}
                {onAir && studio?.error && <Hint tone="down">{studio.error}</Hint>}
                {onAir && studio?.restarting && <Hint tone="down">The renderer stopped and is being restarted.</Hint>}
                {running && boardSilent && (
                  <Hint tone="down">The board hasn't answered for a while. The stream shows its last reading.</Hint>
                )}
                {running && status && status.speed != null && status.speed < 0.95 && status.state === "live" &&
                  Date.now() - status.startedAt > 60_000 && (
                  <Hint tone="down">
                    The server is encoding slower than real time ({status.speed.toFixed(2)}×). A faster
                    x264 preset (<code>LIVE_X264_PRESET=superfast</code>) or more CPU will fix it.
                  </Hint>
                )}
                {running && status && status.dropped > 30 && (
                  <Hint tone="down">
                    {status.dropped.toLocaleString()} frames dropped since going live — the server
                    fell behind, and let them go rather than fall further behind.
                  </Hint>
                )}
                <Hint>
                  The stream runs on the server. Close this page whenever you like: it keeps
                  broadcasting, and comes back by itself after a deploy, until somebody presses Stop.
                </Hint>
                <Hint>
                  When a round's cut lands, the chart fades out and the winner takes the crown for
                  fourteen seconds. Rehearsing shows it on the stream, on air, to whoever is watching.
                </Hint>
              </ul>
            </Section>
          </div>

          <div className="flex min-w-0 flex-col gap-5">
            <Destinations
              destinations={studio?.destinations ?? []}
              live={status?.destinations ?? []}
              guard={guard}
              refresh={refresh}
            />
            <MusicPanel
              tracks={studio?.tracks ?? []}
              volume={studio?.volume ?? 0.8}
              nowPlaying={running ? (status?.nowPlaying ?? null) : null}
              running={running}
              guard={guard}
              refresh={refresh}
            />
          </div>
        </div>
      </main>

      <Rail groove className="mt-auto" />
    </>
  );
}

/**
 * What is going out: the server's own frame, refreshed every second. Each
 * frame is loaded off-screen and swapped in once it has arrived, so the
 * picture never blanks between them.
 */
function Preview({ running, onAir }: { running: boolean; onAir: boolean }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!running) {
      setSrc(null);
      return;
    }
    let live = true;
    const load = () => {
      const url = `/api/live/preview.jpg?t=${Date.now()}`;
      const img = new Image();
      img.onload = () => live && setSrc(url);
      img.src = url;
    };
    load();
    const timer = setInterval(load, PREVIEW_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [running]);

  return (
    <div className="mat-inset grid aspect-video w-full place-items-center overflow-hidden rounded-lg">
      {src ? (
        <img src={src} alt="The stream, as it goes out" className="block h-full w-full object-cover" />
      ) : (
        <p className="m-0 px-6 text-center text-sm text-muted">
          {onAir ? "Starting the stream…" : "Off air. Go live to start the stream on the server."}
        </p>
      )}
    </div>
  );
}

function Hint({ tone, children }: { tone?: "down"; children: ReactNode }) {
  return <li className={cx("m-0 leading-relaxed", tone === "down" ? "text-down" : "text-muted")}>{children}</li>;
}

/** Its own component, so the second hand re-renders this and not the studio. */
function Uptime({ since }: { since: number }) {
  const now = useClock();
  const s = Math.max(0, Math.floor((now.getTime() - since) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return (
    <>
      {h ? `${h}:${String(m).padStart(2, "0")}` : m}:{String(s % 60).padStart(2, "0")}
    </>
  );
}
