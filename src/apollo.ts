import { ApolloClient, InMemoryCache, HttpLink, ApolloLink } from "@apollo/client";
import { SetContextLink } from "@apollo/client/link/context";

const TOKEN_KEY = "utcc.casino.token";

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // localStorage unavailable (Safari private mode / quota) — stay in-memory.
  }
}

const httpLink = new HttpLink({
  // Dev: same-origin "/graphql" proxied to :4000 by Vite. Prod: VITE_GRAPHQL_URL.
  uri: import.meta.env.VITE_GRAPHQL_URL ?? "/graphql",
});

const authLink = new SetContextLink((prevContext) => {
  const token = getToken();
  const headers =
    (prevContext as { headers?: Record<string, string> }).headers ?? {};
  return {
    headers: token ? { ...headers, authorization: `Bearer ${token}` } : headers,
  };
});

export const apolloClient = new ApolloClient({
  link: ApolloLink.from([authLink, httpLink]),
  cache: new InMemoryCache(),
});
