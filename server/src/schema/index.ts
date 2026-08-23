import { makeSchema } from "nexus";
import { applyMiddleware } from "graphql-middleware";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as scalars from "./scalars";
import * as enums from "./enums";
import * as types from "./types";
import { queries } from "./queries";
import { mutations } from "./mutations";
import { guards } from "./guards";

const here = dirname(fileURLToPath(import.meta.url)); // .../src/schema

const base = makeSchema({
  types: [scalars, enums, types, queries, mutations],
  outputs: {
    schema: join(here, "../generated/schema.graphql"),
    typegen: join(here, "../generated/nexus-typegen.d.ts"),
  },
  // Only write typegen/SDL when explicitly reflecting (bun run nexus:reflect).
  // The server itself never generates artifacts, so booting never touches the
  // typegen formatter (which can throw under Bun).
  shouldGenerateArtifacts: process.env.NEXUS_REFLECT === "true",
  contextType: {
    module: join(here, "../context.ts"),
    export: "Context",
  },
});

/**
 * The executable schema, with every field's auth and rate limit already on it.
 *
 * Wrapped here rather than at the server, so there is no way to construct an
 * unguarded schema — a test, a script or a second transport all get the same one
 * the API serves. `nexus:reflect` still reflects `base`, since the SDL is the
 * same either way and middleware has no place in a generated artifact.
 */
export const schema = applyMiddleware(base, guards);
