import { useSession } from "../session/SessionProvider";
import { useWallet } from "@solana/wallet-adapter-react";
import { useEffect, useState } from "react";
import { CLUSTER, explorerUrl, shortAddress } from "../chain/program";
import { useCrownWallet } from "../chain/wallet";
import { formatSol } from "../format";
import { Button, Menu, MenuGroup, MenuItem, MenuLink, Seam, Tag } from "../ui";
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

export function WalletButton() {
  const { connected } = useWallet();
  const { address } = useCrownWallet();
  const { user } = useSession();
  const [picking, setPicking] = useState(false);

  const wired = connected && address;

  // Signed out there is no account to open a menu on. `SignInButton` stands in
  // its place — see the header.
  if (!user) return null;

  return (
    <>
      <Menu
        trigger={({ open, toggle }) => (
          <Button
            size="sm"
            aria-expanded={open}
            aria-haspopup="menu"
            onClick={toggle}
            title={wired ? address : (user?.handle ?? "Account")}
          >
            <span className="font-mono text-xs tabular-nums text-foreground">
              {wired ? shortAddress(address) : (user?.handle ?? "Account")}
            </span>
          </Button>
        )}
      >
        {(close) => <AccountItems onClose={close} onConnect={() => setPicking(true)} />}
      </Menu>
      <WalletPicker open={picking} onClose={() => setPicking(false)} />
    </>
  );
}

/**
 * What the account menu holds: the wallet behind the session, and the way out.
 *
 * Its own component because it has two homes — the account menu beside the
 * balance on a wide screen, and the one menu a phone's header has room for.
 * `onConnect` is the caller's, not this one's: picking a wallet happens in a
 * dialog that has to outlive the menu it was asked for from.
 */
export function AccountItems({
  onClose,
  onConnect,
}: {
  onClose: () => void;
  onConnect: () => void;
}) {
  const { wallet, connected, disconnect } = useWallet();
  const { address, sol } = useCrownWallet();
  const { user, logout } = useSession();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(timer);
  }, [copied]);

  if (!user) return null;
  const wired = connected && address;

  const leave = () => {
    onClose();
    // The wallet goes with the session because it *is* the session: leaving one
    // connected after signing out would re-offer the signature prompt to
    // somebody who just said they were done.
    void disconnect().catch(() => {});
    logout();
  };

  return (
    <>
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

      <MenuGroup>
        {wired ? (
          <>
            <MenuItem
              onClick={() => {
                void navigator.clipboard?.writeText(address).then(
                  () => setCopied(true),
                  () => {}
                );
              }}
            >
              {copied ? "Copied" : "Copy address"}
            </MenuItem>
            <MenuLink href={explorerUrl(address)} target="_blank" rel="noreferrer">
              View on explorer ↗
            </MenuLink>
          </>
        ) : (
          // A session with no wallet behind it yet. The picker is the one
          // thing this menu can offer that the header no longer does.
          <MenuItem
            onClick={() => {
              onClose();
              onConnect();
            }}
          >
            Connect a wallet
          </MenuItem>
        )}
      </MenuGroup>

      <MenuGroup>
        <MenuItem onClick={leave}>Log out</MenuItem>
      </MenuGroup>
    </>
  );
}
