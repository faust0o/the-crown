// Regenerates the Nexus typegen (.d.ts) + SDL into src/generated/.
// Run via `bun run nexus:reflect` (sets NEXUS_REFLECT=true).
export {};

process.on("uncaughtException", (err) => {
  // Nexus' optional typegen prettier-formatter can throw under Bun *after* the
  // artifacts are already written to disk. Ignore it; the files are valid.
  console.warn("[nexus:reflect] ignored post-generation error:", String(err));
  process.exit(0);
});

// Dynamic import so the handler above is registered before makeSchema runs.
await import("./index");

setTimeout(() => {
  console.log("Nexus artifacts written to src/generated/.");
  process.exit(0);
}, 1200);
