/**
 * Check this deployment can run the chain, before trusting it to.
 *
 * ```sh
 * cd server && bun run chain:preflight
 * ```
 *
 * Exits non-zero when something fatal is wrong, so a deploy pipeline can gate on
 * it. Run it with `CHAIN_MODE=on` in the environment you are about to enable.
 */
import { reportPreflight } from "./preflight";

reportPreflight()
  .then((ok) => {
    console.log(ok ? "\n✅ this deployment can run on-chain play" : "\n✗ on-chain play would not work here");
    process.exit(ok ? 0 : 1);
  })
  .catch((err) => {
    console.error("✗ preflight failed:", err?.message ?? err);
    process.exit(1);
  });
