import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import CrownApp from "./casino/CasinoApp.tsx";
import "./index.css";

// The game is the whole app now — it used to be a lazy-loaded route on the
// Utopian Contributors site, where the split existed to keep Apollo, liveline,
// web3.js and the wallet adapters off the landing page. There is no landing
// page here, so the split would only cost a round trip.
//
// The one exception is /live, the livestream studio: a page one operator
// opens, so its recorder, its audio graph and its broadcast scene are a chunk
// of their own rather than weight in every player's bundle.
const LiveApp = lazy(() => import("./live/LiveApp.tsx"));
const path = window.location.pathname;
const live = path === "/live" || path.startsWith("/live/");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {live ? (
      <Suspense fallback={null}>
        <LiveApp />
      </Suspense>
    ) : (
      <CrownApp />
    )}
  </StrictMode>
);
