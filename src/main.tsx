import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import CrownApp from "./casino/CasinoApp.tsx";
import "./index.css";

// The game is the whole app now — it used to be a lazy-loaded route on the
// Utopian Contributors site, where the split existed to keep Apollo, liveline,
// web3.js and the wallet adapters off the landing page. There is no landing
// page here, so the split would only cost a round trip.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <CrownApp />
  </StrictMode>
);
