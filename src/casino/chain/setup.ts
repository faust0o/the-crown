import { getToken } from "../../apollo";
/**
 * Asking the server for the setup transaction.
 *
 * A plain fetch rather than the Apollo client this app already has, for one
 * reason: `WalletBridge` sits outside the casino's provider tree — it wraps it —
 * so a hook-based client is not available where this is called. The document is
 * a single mutation with two scalar arguments, which is the case where the
 * difference between a client and a fetch is nothing but the client.
 */

export interface PreparedSetup {
  /** Base64 of a transaction already carrying the relayer's signature. */
  transaction: string;
  blockhash: string;
  lastValidBlockHeight: number;
  relayer: string;
}

/** The same endpoint `src/apollo.ts` uses, resolved the same way. */
const GRAPHQL_URL: string = import.meta.env.VITE_GRAPHQL_URL ?? "/graphql";

/**
 * The same request Apollo would have made, including the part that says who is
 * asking.
 *
 * This is a plain `fetch` because `WalletBridge` wraps the casino's provider
 * tree rather than sitting inside it, so the hook-based client is not available
 * here. What that loses is the auth link — and losing it is not a subtle
 * degradation: the session is a **bearer token in a header**, read from
 * localStorage, not a cookie. `credentials: "include"` therefore sends nothing
 * at all, every call arrives anonymous, and `requireUser` answers "Log in to do
 * that" to somebody who is plainly logged in.
 */
async function callGraphQL<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const token = getToken();
  const res = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ query, variables }),
  });

  const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
  // GraphQL reports failure in the body with a 200, so the status alone says
  // nothing. The server's message is the useful one — it names the actual
  // refusal rather than a status code that sends someone to the wrong place.
  if (body.errors?.length) throw new Error(body.errors[0].message);
  if (!body.data) throw new Error("The server returned no data.");
  return body.data;
}

const PREPARE = `
  mutation PrepareCreditPurchase($lamports: String!) {
    prepareCreditPurchase(lamports: $lamports) {
      transaction
      blockhash
      lastValidBlockHeight
      lamports
      credits
      solPriceUsd
    }
  }
`;

const CONFIRM = `
  mutation ConfirmCreditPurchase($signature: String!) {
    confirmCreditPurchase(signature: $signature) {
      credits
      balance
    }
  }
`;

export interface PreparedPurchase {
  transaction: string;
  blockhash: string;
  lastValidBlockHeight: number;
  lamports: string;
  /** Credits the buyer receives, decided server-side from the rate below. */
  credits: number;
  solPriceUsd: number;
}

/**
 * Quote a top-up and get the transfer to sign.
 *
 * The same call serves the quote shown while typing and the transaction that
 * gets signed, because they must not be able to disagree: a quote from one code
 * path and a transaction from another is how somebody ends up approving a number
 * they were never shown.
 */
export async function prepareCreditPurchase(lamports: string): Promise<PreparedPurchase> {
  const data = await callGraphQL<{ prepareCreditPurchase: PreparedPurchase }>(PREPARE, { lamports });
  return data.prepareCreditPurchase;
}

export interface CreditedPurchase {
  /** Credits added. Zero if this signature had already been counted. */
  credits: number;
  balance: number;
}

/**
 * Tell the server the payment landed.
 *
 * Only the signature crosses. What it was worth is read off the chain by the
 * server — a client that named its own figure would be a mint button — and the
 * signature can only be counted once, so a retry after a dropped response is
 * safe rather than a second credit.
 */
export async function confirmCreditPurchase(signature: string): Promise<CreditedPurchase> {
  const data = await callGraphQL<{ confirmCreditPurchase: CreditedPurchase }>(CONFIRM, { signature });
  return data.confirmCreditPurchase;
}
