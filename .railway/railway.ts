import { defineRailway, postgres, preserve, project, service, volume } from "railway/iac";

export default defineRailway(() => {
  const Postgres = postgres("Postgres", { region: "us-west2" });
  Postgres.networking = { privateNetworkEndpoint: "postgres" };
  const postgresVolume = volume("postgres-volume", { alerts: { usage: { "100": {}, "80": {}, "95": {} } }, allowOnlineResize: true, region: "us-west2", sizeMB: 5000 });
  const TheCrownServer = service("The Crown Server", {
    build: "bun run build",
    start: "bun run start",
    preDeploy: "cd server && bun install && bun run migrate:deploy && bun run chain:preflight",
    replicas: { "us-west2": 1 },
    domains: [{ domain: "thecrowngame.fun", port: 4000 }],
    networking: { privateNetworkEndpoint: "marvelous-achievement" },
    env: { CHAIN_MODE: preserve(), CORS_ORIGINS: preserve(), CROWN_AUTHORITY_KEY: preserve(), CROWN_CREDIT_MINT: preserve(), CROWN_RELAYER_KEY: preserve(), DATABASE_URL: preserve(), DESK_SECRET: preserve(), PORT: preserve(), SOLANA_RPC_URL: preserve(), TEST: preserve(), VITE_CROWN_CREDIT_MINT: preserve(), VITE_CROWN_RELAYER: preserve(), VITE_SOLANA_CLUSTER: preserve(), VITE_SOLANA_RPC_URL: preserve() },
  });

  return project("The Crown Game", {
    resources: [Postgres, TheCrownServer, postgresVolume],
  });
});
