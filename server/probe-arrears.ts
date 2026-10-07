import { Keypair } from "@solana/web3.js";
import { roundsInArrears } from "/Users/ludwigschubert/the-crown/server/src/chain/arrears";

async function main() {
  const owed = await roundsInArrears(Keypair.generate());
  if (!owed.length) return console.log("nothing owed");
  console.log("the new arrears scan reports:");
  for (const a of owed) {
    console.log(
      `  round ${String(a.round.index).padStart(4)}  ${a.round.status.padEnd(8)} ` +
        `${String(a.positions).padStart(4)} open position(s)  ended ${a.round.endsAt.toISOString()}`
    );
  }
}
main().catch((e) => console.log("FAILED:", e.message));
