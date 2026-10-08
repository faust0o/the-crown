import { useState, type FormEvent } from "react";
import { Button, Caption, IconButton, Input, Label, Section } from "../casino/ui";
import { api, type BroadcastStatus, type Destination } from "./api";
import type { Guard } from "./Studio";

type Live = BroadcastStatus["destinations"][number];

const LAMP: Record<Live["state"], { label: string; color: string }> = {
  live: { label: "live", color: "var(--up)" },
  connecting: { label: "connecting", color: "var(--gold)" },
  retrying: { label: "retrying", color: "var(--down)" },
};

/**
 * Where the stream goes: RTMP ingests, each a server URL and a stream key.
 *
 * Every enabled destination gets the same broadcast, and each is its own
 * connection — one dropping, or being added or switched off while on air,
 * leaves the others alone. The key is write-only: once saved, the page only
 * ever sees its last few characters.
 */
export function Destinations({
  destinations,
  live,
  guard,
  refresh,
}: {
  destinations: Destination[];
  live: Live[];
  guard: Guard;
  refresh: () => Promise<void>;
}) {
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const byId = new Map(live.map((d) => [d.id, d]));

  const add = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const added = await guard(() => api.addDestination({ label, url, key }));
    setBusy(false);
    if (!added) return;
    setLabel("");
    setUrl("");
    setKey("");
    await refresh();
  };

  const toggle = async (d: Destination) => {
    await guard(() => api.updateDestination(d.id, { enabled: !d.enabled }));
    await refresh();
  };

  const remove = async (d: Destination) => {
    if (!window.confirm(`Remove ${d.label}? Its stream key is deleted with it.`)) return;
    await guard(() => api.removeDestination(d.id));
    await refresh();
  };

  return (
    <Section title="Destinations" aside={`${destinations.filter((d) => d.enabled).length} on`}>
      <ul className="m-0 flex list-none flex-col p-0">
        {destinations.map((d) => {
          const state = d.enabled ? byId.get(d.id) : undefined;
          const lamp = state ? LAMP[state.state] : null;
          return (
            <li key={d.id} className="border-b border-[var(--bevel-lo)] py-2.5 last:border-b-0">
              <div className="flex items-center gap-2">
                <span
                  aria-hidden="true"
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ background: lamp?.color ?? "var(--hairline)" }}
                />
                <span className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">{d.label}</span>
                {lamp && (
                  <span className="font-mono text-[11px]" style={{ color: lamp.color }}>
                    {lamp.label}
                  </span>
                )}
                <Button size="xs" onClick={() => toggle(d)} aria-pressed={d.enabled}>
                  {d.enabled ? "On" : "Off"}
                </Button>
                <IconButton label={`Remove ${d.label}`} size="xs" onClick={() => remove(d)}>
                  <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" aria-hidden="true" fill="none">
                    <path d="M7 7l10 10M17 7L7 17" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                  </svg>
                </IconButton>
              </div>
              <div className="mt-0.5 truncate pl-4 font-mono text-[11px] text-muted" title={d.url}>
                {d.url}
                {d.keyHint && <span className="ml-1.5">key {d.keyHint}</span>}
              </div>
              {state?.error && state.state === "retrying" && (
                <div className="mt-0.5 pl-4 font-mono text-[11px] text-down">{state.error}</div>
              )}
            </li>
          );
        })}
        {!destinations.length && (
          <li className="py-3 text-xs text-muted">
            No destinations yet. Add the RTMP server and stream key from YouTube, Twitch, Kick, X or
            any other platform.
          </li>
        )}
      </ul>

      <form onSubmit={add} className="mt-3 flex flex-col gap-2.5 border-t border-hairline pt-3">
        <Caption>Add a destination</Caption>
        <div>
          <Label htmlFor="dest-url" className="mb-1">
            RTMP server URL
          </Label>
          <Input
            id="dest-url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="rtmp://a.rtmp.youtube.com/live2"
            autoComplete="off"
            spellCheck={false}
            required
          />
        </div>
        <div>
          <Label htmlFor="dest-key" className="mb-1">
            Stream key
          </Label>
          <Input
            id="dest-key"
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="Leave empty if the URL already ends in it"
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <div>
          <Label htmlFor="dest-label" className="mb-1">
            Name <span className="normal-case tracking-normal">(optional)</span>
          </Label>
          <Input
            id="dest-label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="YouTube"
            maxLength={60}
          />
        </div>
        <Button type="submit" disabled={busy || !url.trim()} className="self-start">
          {busy ? "Adding…" : "Add destination"}
        </Button>
      </form>
    </Section>
  );
}
