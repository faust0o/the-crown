import { WalletReadyState } from "@solana/wallet-adapter-base";
import { useWallet } from "@solana/wallet-adapter-react";
import { useRef } from "react";
import { CLUSTER } from "../chain/program";
import { Button, Dialog, Tag } from "../ui";

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

  // Unsupported is not "install this" — it is a wallet that cannot run on this
  // platform at all, and offering it is offering a dead end.
  const usable = wallets.filter((w) => w.readyState !== WalletReadyState.Unsupported);
  const detected = usable.filter((w) => w.readyState === WalletReadyState.Installed);
  const rest = usable.filter((w) => w.readyState !== WalletReadyState.Installed);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Connect a wallet"
      headerAside={<Tag>{CLUSTER}</Tag>}
      initialFocus={first}
      footer={
        <Button block onClick={onClose}>
          Cancel
        </Button>
      }
    >
      <p className="m-0 text-xs leading-relaxed text-secondary">
        Your wallet is your account here. Connecting signs nothing; the next
        step asks for a signature on a plain sentence, which costs no fees.
      </p>

      {usable.length === 0 ? (
        <p className="mat-inset mt-4 rounded-lg px-3 py-4 text-center text-xs text-muted">
          No Solana wallet found in this browser.{" "}
          <a
            href="https://phantom.app/download"
            target="_blank"
            rel="noreferrer"
            className="text-accent-ink hover:underline"
          >
            Install Phantom
          </a>{" "}
          and reload.
        </p>
      ) : (
        <ul className="m-0 mt-4 list-none space-y-1.5 p-0">
          {[...detected, ...rest].map((w, i) => {
            const installed = w.readyState === WalletReadyState.Installed;
            const shared =
              "mat-key mat-grain flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left";
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
                    <span className="mat-engrave flex-1 text-sm text-foreground">
                      {w.adapter.name}
                    </span>
                    {installed && <Tag>detected</Tag>}
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
    </Dialog>
  );
}
