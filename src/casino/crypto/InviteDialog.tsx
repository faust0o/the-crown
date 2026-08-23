import { useEffect, useRef, useState } from "react";
import { useScrollLock } from "./useScrollLock";

/**
 * The only way in. Codes are minted server-side and each one is single-use, so
 * there's no demo bypass — an account exists because a code was spent on it.
 */
export function InviteDialog({
  open,
  onClose,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (code: string) => Promise<{ ok: boolean; error?: string }>;
}) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useScrollLock(open);

  if (!open) return null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = code.trim().toUpperCase();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    const res = await onSubmit(trimmed);
    setBusy(false);
    if (res.ok) {
      setCode("");
      onClose();
    } else {
      setError(res.error ?? "That code didn't work.");
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-label="Enter an invite code"
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
        className="casino-animate-in w-full max-w-sm rounded-lg border border-hairline bg-surface p-6"
      >
        <h2 className="text-base font-semibold text-foreground">Enter an invite code</h2>
        <p className="mt-1 text-xs leading-relaxed text-secondary">
          The Crown is invite-only. Each code creates one account with a starting
          balance of play credits.
        </p>
        <input
          ref={input}
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          placeholder="CROWN-XXXXXX"
          autoComplete="off"
          spellCheck={false}
          aria-invalid={Boolean(error)}
          className="mt-4 w-full rounded border border-hairline bg-inset px-3 py-2 text-center font-mono text-sm tracking-widest text-foreground outline-none focus:border-accent"
        />
        {error && (
          <p role="alert" className="mt-2 text-center text-xs" style={{ color: "var(--down)" }}>
            {error}
          </p>
        )}
        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded-md border border-hairline px-3 py-2 text-sm text-muted"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || !code.trim()}
            className="flex-1 rounded-md bg-accent px-3 py-2 text-sm font-semibold text-white disabled:opacity-40"
          >
            {busy ? "Checking…" : "Redeem"}
          </button>
        </div>
      </form>
    </div>
  );
}
