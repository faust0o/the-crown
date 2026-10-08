import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { defineConfig } from "vite";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    proxy: {
      // Dev convenience: proxy GraphQL to the local Apollo server so the SPA
      // calls a same-origin /graphql. Prod uses VITE_GRAPHQL_URL.
      "/graphql": "http://localhost:4000",
      // Same reasoning for the logo proxy: the chart reads pixels off each logo,
      // so it has to come from this origin or the canvas is tainted.
      "/logo": "http://localhost:4000",
      // The chain, via the server, so a paid RPC key never reaches the bundle —
      // see server/src/chain/rpc-proxy.ts.
      "/rpc": "http://localhost:4000",
      // The livestream studio's API and its ingest socket — see server/src/live.
      "/api/live": { target: "http://localhost:4000", ws: true },
    },
  },
});
