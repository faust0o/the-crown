// Apply pending Prisma migrations before the server boots.
//
// This is the step the deploy was missing. `start` used to run
// `bun install && prisma generate && vite build` and then launch — so a deploy
// carrying a schema change shipped a Prisma client that knew about columns the
// database did not have. Nothing fails at boot when that happens; it fails
// later, on the first query that touches the new column, in the middle of a
// live round. Generating a client is not the same as migrating a database, and
// only one of the two was happening.
//
// Failing the deploy is the point. A container that cannot migrate must not
// come up and start writing bets against whatever schema it found.

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "server");

// No database configured is the local "just look at the built site" case, which
// the server already handles by warning. Only production is required to have one
// — there, a missing URL is a misconfigured deploy, not a preference.
if (!process.env.DATABASE_URL) {
  if (process.env.NODE_ENV === "production") {
    console.error("✗ DATABASE_URL is not set — refusing to start without a database.");
    process.exit(1);
  }
  console.warn("⚠  DATABASE_URL is not set — skipping migrations.");
  process.exit(0);
}

const run = (cmd, args) =>
  spawnSync(cmd, args, { cwd: SERVER, stdio: "inherit", shell: process.platform === "win32" });

const deploy = run("npx", ["--no-install", "prisma", "migrate", "deploy"]);
if (deploy.status !== 0) {
  console.error("✗ prisma migrate deploy failed — not starting.");
  process.exit(deploy.status ?? 1);
}

// `deploy` applies what is pending; `status` is what confirms nothing still is.
// They can disagree when a migration was applied by hand, or partially, or when
// the deployed code is older than the database — all cases where the schema the
// code assumes is not the schema it will get.
const status = run("npx", ["--no-install", "prisma", "migrate", "status"]);
if (status.status !== 0) {
  console.error("✗ database schema does not match the migrations — not starting.");
  process.exit(status.status ?? 1);
}

console.log("✓ database schema is up to date.");
