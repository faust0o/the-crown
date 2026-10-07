import { useSession } from "../session/SessionProvider";
import { useWallet } from "@solana/wallet-adapter-react";
import { useEffect, useRef, useState } from "react";
import { CLUSTER, explorerUrl, shortAddress } from "../chain/program";
import { useCrownWallet } from "../chain/wallet";
import { formatSol } from "../format";
import { Button, Panel, Seam, Tag } from "../ui";
import { useSignInPrompt } from "./useSignIn";
import { WalletPicker } from "./WalletPicker";

/**
 * Re-attach a wallet to a session that has one signed in already.
 *
 * Lives in the top-up card, which is the one place that still needs a wallet
 * without needing an account: the session is the token, so closing the
 * extension leaves a player signed in with nothing to pay from. Signing in is
 * `SignInButton`'s job, not this one's.
 */
export function ConnectWalletButton() {
  const { connecting } = useCrownWallet();
  const [picking, setPicking] = useState(false);
  return (
    <>
      <Button size="sm" disabled={connecting} onClick={() => setPicking(true)}>
        {connecting ? "Connecting…" : "Connect wallet"}
      </Button>
      <WalletPicker open={picking} onClose={() => setPicking(false)} />
    </>
  );
}

/**
 * The only door: connect a wallet and sign in with it.
 *
 * One control rather than two steps, because they are not two decisions. A
 * visitor picks a wallet, approves a sentence, and has an account — there is
 * nothing to register and no code to have been given. If a wallet is already
 * connected there is nothing to pick, so it goes straight to the signature.
 */
export function SignInButton() {
  const { connecting } = useCrownWallet();
  const { signingIn, error } = useSession();
  const { promptSignIn, picker } = useSignInPrompt();

  return (
    <>
      {/* The blue buy lamp rather than amber: signing in is the first step
          towards a buy, not a sell. */}
      <Button
        variant="glass"
        side="buy"
        size="sm"
        disabled={signingIn}
        title={error ?? undefined}
        onClick={promptSignIn}
      >
        {signingIn ? "Check your wallet…" : connecting ? "Connecting…" : "Sign in"}
      </Button>
      {picker}
    </>
  );
}

/** One row of the account menu. */
const ITEM =
  "rounded px-2 py-1.5 text-left text-xs text-secondary transition-colors " +
  "hover:bg-[color-mix(in_oklch,var(--foreground)_7%,transparent)] hover:text-foreground";

export function WalletButton() {
  const { wallet, connected, disconnect } = useWallet();
  const { address, sol } = useCrownWallet();
  const { user, logout } = useSession();
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

  const wired = connected && address;

  // Signed out there is no account to open a menu on. `SignInButton` stands in
  // its place — see the header.
  if (!user) return null;

  const leave = () => {
    setMenu(false);
    // The wallet goes with the session because it *is* the session: leaving one
    // connected after signing out would re-offer the signature prompt to
    // somebody who just said they were done.
    void disconnect().catch(() => {});
    logout();
  };

  return (
    <div ref={anchor} className="relative">
      <Button
        size="sm"
        aria-expanded={menu}
        aria-haspopup="menu"
        onClick={() => setMenu((v) => !v)}
        title={wired ? address : (user?.handle ?? "Account")}
      >
        <span className="font-mono text-xs tabular-nums text-foreground">
          {wired ? shortAddress(address) : (user?.handle ?? "Account")}
        </span>
      </Button>

      {menu && (
        <Panel
          role="menu"
          className="casino-animate-in absolute right-0 z-40 mt-2 w-64 p-3"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="mat-engrave text-xs font-semibold text-foreground">
              {wired ? (wallet?.adapter.name ?? "Wallet") : (user?.handle ?? "Account")}
            </span>
            <Tag>{CLUSTER}</Tag>
          </div>

          {wired && (
            <p className="mt-2 break-all font-mono text-[11px] leading-snug text-secondary select-all">
              {address}
            </p>
          )}

          {/*
            SOL, and not the credit balance beside it.

            The header already prints credits, permanently, two centimetres to
            the left of this panel — so the row was the same number twice, and
            the menu read as a balance sheet rather than as the account controls
            it exists for. What SOL is doing for is the only figure in here that
            is about the *wallet*, which is what this menu is about.
          */}
          {wired && (
            <>
              <Seam className="mt-3" />
              <dl className="m-0 mt-2 space-y-1 text-[11px]">
                <div className="flex items-baseline justify-between gap-2">
                  <dt className="text-muted">SOL</dt>
                  <dd className="m-0 font-mono tabular-nums text-foreground">{formatSol(sol)}</dd>
                </div>
              </dl>
            </>
          )}

          <Seam className="mt-3" />
          <div className="mt-2 flex flex-col gap-1">
            {wired ? (
              <>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    void navigator.clipboard?.writeText(address).then(
                      () => setCopied(true),
                      () => {}
                    );
                  }}
                  className={ITEM}
                >
                  {copied ? "Copied" : "Copy address"}
                </button>
                <a
                  role="menuitem"
                  href={explorerUrl(address)}
                  target="_blank"
                  rel="noreferrer"
                  className={`${ITEM} no-underline`}
                >
                  View on explorer ↗
                </a>
              </>
            ) : (
              // A session with no wallet behind it yet. The picker is the one
              // thing this menu can offer that the header no longer does.
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenu(false);
                  setPicking(true);
                }}
                className={ITEM}
              >
                Connect a wallet
              </button>
            )}
          </div>

          {user && (
            <>
              <Seam className="mt-3" />
              <div className="mt-2 flex flex-col gap-1">
                <button type="button" role="menuitem" onClick={leave} className={ITEM}>
                  Log out
                </button>
              </div>
            </>
          )}
        </Panel>
      )}
      <WalletPicker open={picking} onClose={() => setPicking(false)} />
    </div>
  );
}
