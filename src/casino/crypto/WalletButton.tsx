import { WalletReadyState } from "@solana/wallet-adapter-base";
import { useSession } from "../session/SessionProvider";
import { useWallet } from "@solana/wallet-adapter-react";
import { useEffect, useRef, useState } from "react";
import { CLUSTER, explorerUrl, shortAddress } from "../chain/program";
import { useCrownWallet } from "../chain/wallet";
import { formatCredits, formatSol } from "../format";
import { useScrollLock } from "./useScrollLock";

/**
 * Pick a wallet.
 *
 * wallet-adapter ships this dialog, and its stylesheet is a fixed dark palette
 * with its own radii and font — dropped into the casino it reads as a different
 * product, and in light mode it is a black box on a white page. The list itself
 * is four lines, so this renders it in the app's own language instead. Selecting
 * is all it does: `autoConnect` on the provider takes it from there, and calling
 * `connect()` here would race the state update that `select()` schedules.
 */
export function WalletPicker({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { wallets, select } = useWallet();
  const first = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    first.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useScrollLock(open);

  if (!open) return null;

  // Unsupported is not "install this" — it is a wallet that cannot run on this
  // platform at all, and offering it is offering a dead end.
  const usable = wallets.filter((w) => w.readyState !== WalletReadyState.Unsupported);
  const detected = usable.filter((w) => w.readyState === WalletReadyState.Installed);
  const rest = usable.filter((w) => w.readyState !== WalletReadyState.Installed);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Connect a wallet"
        onClick={(e) => e.stopPropagation()}
        className="casino-animate-in w-full max-w-sm rounded-lg border border-hairline bg-surface p-6"
      >
        <div className="mb-1 flex items-start justify-between gap-4">
          <h2 className="text-base font-semibold text-foreground">Connect a wallet</h2>
          <span className="rounded border border-hairline px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-muted">
            {CLUSTER}
          </span>
        </div>
        <p className="text-xs leading-relaxed text-secondary">
          Your wallet is a second identity, not a replacement — you still need an
          invite code to hold credits. Connecting signs nothing.
        </p>

        {usable.length === 0 ? (
          <p className="mt-4 rounded border border-hairline bg-inset px-3 py-4 text-center text-xs text-muted">
            No Solana wallet found in this browser.{" "}
            <a
              href="https://phantom.app/download"
              target="_blank"
              rel="noreferrer"
              className="text-accent hover:underline"
            >
              Install Phantom
            </a>{" "}
            and reload.
          </p>
        ) : (
          <ul className="mt-4 m-0 list-none space-y-1.5 p-0">
            {[...detected, ...rest].map((w, i) => {
              const installed = w.readyState === WalletReadyState.Installed;
              const shared =
                "flex w-full items-center gap-3 rounded-md border border-hairline px-3 py-2.5 text-left transition-colors hover:border-accent";
              return (
                <li key={w.adapter.name}>
                  {installed || w.readyState === WalletReadyState.Loadable ? (
                    <button
                      ref={i === 0 ? first : undefined}
                      type="button"
                      onClick={() => {
                        select(w.adapter.name);
                        onClose();
                      }}
                      className={shared}
                    >
                      <img src={w.adapter.icon} alt="" aria-hidden="true" className="h-6 w-6" />
                      <span className="flex-1 text-sm text-foreground">{w.adapter.name}</span>
                      {installed && (
                        <span className="text-[10px] uppercase tracking-wider text-muted">
                          detected
                        </span>
                      )}
                    </button>
                  ) : (
                    // Not installed: a button here would select a wallet that
                    // can never connect, so the row becomes the install link it
                    // actually is.
                    <a
                      href={w.adapter.url}
                      target="_blank"
                      rel="noreferrer"
                      className={`${shared} no-underline`}
                    >
                      <img
                        src={w.adapter.icon}
                        alt=""
                        aria-hidden="true"
                        className="h-6 w-6 opacity-50"
                      />
                      <span className="flex-1 text-sm text-muted">{w.adapter.name}</span>
                      <span className="text-[10px] uppercase tracking-wider text-secondary">
                        install ↗
                      </span>
                    </a>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        <button
          type="button"
          onClick={onClose}
          className="mt-4 w-full rounded-md border border-hairline px-3 py-2 text-sm text-muted transition-colors hover:text-foreground"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * The header's wallet control: connect, or the account it is connected to.
 *
 * Sits beside the invite-code button rather than replacing it. Both can be
 * present, one can be present, neither can be — the game only requires the code.
 */
export function WalletButton() {
  const { wallet, connected } = useWallet();
  const { address, connecting, sol } = useCrownWallet();
  // The balance is the account's, not the wallet's — the wallet only pays for it.
  const { user } = useSession();
  const credits = user?.credits ?? null;
  const [picking, setPicking] = useState(false);
  const [menu, setMenu] = useState(false);
  const [copied, setCopied] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenu(false);
    // pointerdown, not click: a click listener fires after the target's own
    // handler has already re-opened the menu, so the toggle would never close.
    const onDown = (e: PointerEvent) => {
      if (!anchor.current?.contains(e.target as Node)) setMenu(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown);
    };
  }, [menu]);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(timer);
  }, [copied]);

  if (!connected || !address) {
    return (
      <>
        <button
          type="button"
          disabled={connecting}
          onClick={() => setPicking(true)}
          className="rounded-md border border-hairline px-3 py-1.5 text-xs font-semibold text-foreground transition-colors hover:border-accent disabled:opacity-50"
        >
          {connecting ? "Connecting…" : "Connect wallet"}
        </button>
        <WalletPicker open={picking} onClose={() => setPicking(false)} />
      </>
    );
  }

  return (
    <div ref={anchor} className="relative">
      <button
        type="button"
        aria-expanded={menu}
        aria-haspopup="menu"
        onClick={() => setMenu((v) => !v)}
        title={address}
        className="flex items-center gap-2 rounded-md border border-hairline px-3 py-1.5 transition-colors hover:border-accent"
      >
        <span
          aria-hidden="true"
          className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
          style={{ background: "var(--up)" }}
        />
        <span className="font-mono text-xs tabular-nums text-foreground">
          {shortAddress(address)}
        </span>
      </button>

      {menu && (
        <div
          role="menu"
          className="casino-animate-in absolute right-0 z-40 mt-2 w-64 rounded-lg border border-hairline bg-surface p-3 shadow-lg"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-foreground">
              {wallet?.adapter.name ?? "Wallet"}
            </span>
            <span className="rounded border border-hairline px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-muted">
              {CLUSTER}
            </span>
          </div>

          <p className="mt-2 break-all font-mono text-[11px] leading-snug text-secondary select-all">
            {address}
          </p>

          <dl className="mt-3 m-0 space-y-1 border-t border-hairline pt-2 text-[11px]">
            <div className="flex items-baseline justify-between gap-2">
              <dt className="text-muted">SOL</dt>
              <dd className="m-0 font-mono tabular-nums text-foreground">{formatSol(sol)}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-2">
              <dt className="text-muted">credits</dt>
              <dd className="m-0 font-mono tabular-nums text-foreground">
                {credits == null ? "—" : formatCredits(credits)}
              </dd>
            </div>
          </dl>

          <div className="mt-3 flex flex-col gap-1 border-t border-hairline pt-2">
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                void navigator.clipboard?.writeText(address).then(
                  () => setCopied(true),
                  () => {}
                );
              }}
              className="rounded px-2 py-1.5 text-left text-xs text-secondary transition-colors hover:bg-inset hover:text-foreground"
            >
              {copied ? "Copied" : "Copy address"}
            </button>
            <a
              role="menuitem"
              href={explorerUrl(address)}
              target="_blank"
              rel="noreferrer"
              className="rounded px-2 py-1.5 text-xs text-secondary no-underline transition-colors hover:bg-inset hover:text-foreground"
            >
              View on explorer ↗
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
