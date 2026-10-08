import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Button, Input, Label, Panel, Rail } from "../casino/ui";
import { api, ApiError } from "./api";
import { Studio } from "./Studio";

/**
 * /live — the livestream studio, behind its password.
 *
 * Always the dark theme: the stream is the dark object whatever the operator's
 * browser prefers, and a control room previewing it on an ivory page would be
 * judging the picture against the wrong light.
 */
export default function LiveApp() {
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", "dark");
    document.title = "Studio · The Crown";
  }, []);

  const [session, setSession] = useState<"checking" | "out" | "in" | "off">("checking");
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    api
      .session()
      .then((s) => setSession(s.signedIn ? "in" : "out"))
      .catch((err) => {
        if (err instanceof ApiError && err.status === 404) {
          setSession("off");
          setProblem(err.message);
        } else {
          setSession("out");
          setProblem(err instanceof Error ? err.message : "Couldn't reach the server.");
        }
      });
  }, []);

  const signedOut = useCallback(() => setSession("out"), []);

  return (
    <div className="casino flex min-h-dvh flex-col">
      {session === "in" ? (
        <Studio onSignedOut={signedOut} />
      ) : (
        <main className="flex flex-1 items-center justify-center px-6 py-10">
          {session === "checking" ? null : session === "off" ? (
            <Panel className="w-full max-w-sm p-6 text-sm text-secondary">
              <Heading />
              <p className="m-0 mt-4">{problem}</p>
            </Panel>
          ) : (
            <Gate onSignedIn={() => setSession("in")} initialError={problem} />
          )}
        </main>
      )}
      {session !== "in" && <Rail groove className="mt-auto" />}
    </div>
  );
}

function Heading() {
  return (
    <div className="flex items-center gap-2.5">
      <img src="/crown-icon.svg" alt="" aria-hidden="true" width={28} height={28} className="h-7 w-7 rounded" />
      <span className="mat-engrave text-lg font-semibold text-foreground">The Crown · Studio</span>
    </div>
  );
}

function Gate({ onSignedIn, initialError }: { onSignedIn: () => void; initialError: string | null }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(initialError);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(password);
      onSignedIn();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't sign in.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel as="form" onSubmit={submit} className="w-full max-w-sm p-6">
      <Heading />
      <p className="m-0 mt-2 text-sm text-secondary">
        The livestream studio. Enter the password to run the broadcast.
      </p>
      <Label htmlFor="live-password" className="mt-5 mb-1.5">
        Password
      </Label>
      <Input
        id="live-password"
        type="password"
        autoComplete="current-password"
        autoFocus
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      {error && (
        <p role="alert" className="m-0 mt-2 text-xs text-down">
          {error}
        </p>
      )}
      <Button type="submit" variant="glass" block className="mt-5" disabled={busy || !password}>
        {busy ? "Signing in…" : "Sign in"}
      </Button>
    </Panel>
  );
}
