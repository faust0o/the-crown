import { useWallet } from "@solana/wallet-adapter-react";
import { useCallback, useState } from "react";
import type { ReactNode } from "react";
import { useSession } from "../session/SessionProvider";
import { WalletPicker } from "./WalletPicker";

/**
 * The door, openable from anywhere on the page.
 *
 * `signIn()` on its own only *arms* the attempt — it waits for a key, and a
 * visitor with no wallet connected yet has none, so nothing at all appears to
 * happen. The picker is the missing half. Anything that wants to ask for an
 * account (the header button, the Buy key on a ticket composed while signed
 * out) needs both halves, so both live here rather than being remembered
 * correctly in one place and forgotten in the next.
 *
 * Returns the dialog as well as the call: render `picker` somewhere in the
 * caller's tree and it stays shut until `promptSignIn` needs it.
 */
export function useSignInPrompt(): { promptSignIn: () => void; picker: ReactNode } {
  const { connected } = useWallet();
  const { signIn } = useSession();
  const [picking, setPicking] = useState(false);

  const promptSignIn = useCallback(() => {
    // Armed either way: with a wallet already connected the signature prompt
    // goes up now, and without one it goes up the moment the picked wallet
    // finishes connecting.
    signIn();
    if (!connected) setPicking(true);
  }, [connected, signIn]);

  return {
    promptSignIn,
    picker: <WalletPicker open={picking} onClose={() => setPicking(false)} />,
  };
}
