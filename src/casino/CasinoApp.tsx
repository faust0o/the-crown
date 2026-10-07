import { ApolloProvider } from "@apollo/client/react";
import { apolloClient } from "../apollo";
import { WalletBridge } from "./chain/WalletBridge";
import CrownPage from "./crypto/CryptoPage";

/**
 * The whole app. One game — The Crown — and no routes: the npm/jsDelivr package
 * markets this used to sit beside are gone, and so is the landing page it was
 * lazy-loaded from when it lived on utopiancontributors.com/casino.
 *
 * WalletBridge sits outside the Apollo provider because signing in needs both:
 * the session is a signature by the connected wallet, so `SessionProvider` —
 * which lives inside Apollo — has to be able to reach the adapter. Wrapping the
 * whole tree is what puts it in that order.
 */
export default function CasinoApp() {
  return (
    <WalletBridge>
      <ApolloProvider client={apolloClient}>
        <CrownPage />
      </ApolloProvider>
    </WalletBridge>
  );
}
