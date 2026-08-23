import { ApolloProvider } from "@apollo/client/react";
import { apolloClient } from "../apollo";
import { WalletBridge } from "./chain/WalletBridge";
import CrownPage from "./crypto/CryptoPage";

/**
 * The whole app. One game — The Crown — and no routes: the npm/jsDelivr package
 * markets this used to sit beside are gone, and so is the landing page it was
 * lazy-loaded from when it lived on utopiancontributors.com/casino.
 *
 * WalletBridge sits outside the Apollo provider because the two identities are
 * independent: the invite code is what creates an account and holds credits, and
 * the wallet is an optional second one that removes the prompt from every bet.
 * Neither provider needs anything from the other.
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
