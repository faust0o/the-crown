// Mints fresh invite codes and prints them, one per line.
// Run via `bun run invites:mint -- [count] [--uses N] [--note "text"]`.
import { mintInviteCodes } from "./invites";
import { prisma } from "./prisma";

const USAGE = `Usage: bun run invites:mint -- [count] [--uses N] [--note "text"]

  count        how many codes to mint (default 1)
  --uses N     accounts each code can create before it's spent (default 1)
  --note TEXT  why these were minted, stored alongside the code
`;

function parseArgs(argv: string[]) {
  let count = 1;
  let maxUses = 1;
  let note: string | undefined;
  let sawCount = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      process.exit(0);
    } else if (arg === "--uses" || arg === "--note") {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      if (arg === "--note") {
        note = value;
      } else {
        maxUses = Number(value);
        if (!Number.isInteger(maxUses) || maxUses < 1) {
          throw new Error(`--uses must be a positive integer, got "${value}"`);
        }
      }
    } else if (!sawCount) {
      count = Number(arg);
      if (!Number.isInteger(count) || count < 1) {
        throw new Error(`count must be a positive integer, got "${arg}"`);
      }
      sawCount = true;
    } else {
      throw new Error(`unexpected argument "${arg}"`);
    }
  }

  return { count, maxUses, note };
}

try {
  const { count, maxUses, note } = parseArgs(process.argv.slice(2));
  const codes = await mintInviteCodes(count, { maxUses, note });
  for (const code of codes) console.log(code);
} catch (err) {
  console.error(`✗ ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
