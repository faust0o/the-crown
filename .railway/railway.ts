import {
  defineRailway,
  github,
  postgres,
  preserve,
  project,
  service,
  volume,
} from "railway/iac";

export default defineRailway(() => {
  const Postgres = postgres("Postgres", { region: "us-west2" });
  Postgres.networking = { privateNetworkEndpoint: "postgres" };
  const postgresVolume = volume("postgres-volume", {
    alerts: { usage: { "100": {}, "80": {}, "95": {} } },
    allowOnlineResize: true,
    region: "us-west2",
    sizeMB: 5000,
  });
  // Token logos (server/src/logo-store.ts). A volume means each redeploy has a
  // few seconds of downtime: Railway will not run two deployments on one volume.
  const serverData = volume("server-data", { region: "us-west2", sizeMB: 50000 });
  const TheCrownServer = service("The Crown Server", {
    source: github("faust0o/the-crown", { branch: "main" }),
    build: "bun run build",
    start: "bun run start",
    preDeploy:
      "cd server && bun install && bun run migrate:deploy && bun run chain:preflight",
    replicas: { "us-west2": 1 },
    domains: [{ domain: "thecrowngame.fun", port: 4000 }],
    networking: { privateNetworkEndpoint: "marvelous-achievement" },
    volumeMounts: { "/data": serverData },
    env: {
      // ffmpeg for the livestream (server/src/live). Railpack installs it into
      // the image; without it /live cannot go on air and nothing else notices.
      RAILPACK_DEPLOY_APT_PACKAGES: "ffmpeg",
      CHAIN_MODE: preserve(),
      CORS_ORIGINS: preserve(),
      CROWN_AUTHORITY_KEY: preserve(),
      CROWN_CREDIT_MINT: preserve(),
      CROWN_RELAYER_KEY: preserve(),
      DATABASE_URL: preserve(),
      LIVE_PASSWORD: preserve(),
      PORT: preserve(),
      SOLANA_RPC_URL: preserve(),
      TEST: preserve(),
      VITE_SOLANA_CLUSTER: preserve(),
      VITE_SOLANA_RPC_URL: preserve(),
    },
  });

  return project("The Crown Game", {
    resources: [Postgres, TheCrownServer, postgresVolume, serverData],
  });
});
