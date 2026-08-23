import { asNexusMethod } from "nexus";
import { DateTimeResolver } from "graphql-scalars";

// Registers the "DateTime" scalar and a `t.dateTime()` builder method.
export const DateTime = asNexusMethod(DateTimeResolver, "dateTime");
