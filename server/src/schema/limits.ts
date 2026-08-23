import {
  getNamedType,
  GraphQLError,
  isInterfaceType,
  isListType,
  isNonNullType,
  isObjectType,
  Kind,
  type ASTNode,
  type DocumentNode,
  type FieldNode,
  type FragmentDefinitionNode,
  type GraphQLNamedType,
  type GraphQLOutputType,
  type SelectionSetNode,
  type ValidationContext,
  type ValidationRule,
} from "graphql";

/**
 * What a single request is allowed to ask for.
 *
 * Authentication says who may call a field and the rate limits say how often;
 * neither says anything about how much one call may cost, and on a public
 * GraphQL endpoint that is the gap that matters. One HTTP request can ask for a
 * field five hundred times under five hundred aliases, and each `roundReplay`
 * behind it is a range scan over the samples table. The rate limiter counts that
 * as one call, because it is.
 *
 * So the document itself is budgeted before a resolver runs: how deep it may
 * nest, and how much work the whole selection adds up to. Both are validation
 * rules, which means they are checked during parse/validate — before the
 * execution phase allocates anything and before the first database round-trip.
 */

/** Nesting past this is a client bug or an attack; the schema's own depth is 3. */
export const MAX_DEPTH = 10;
/**
 * Total weighted field count. A normal page load costs a few hundred; the
 * pathological shapes cost tens of thousands.
 */
export const MAX_COST = 5_000;
/** What we assume a list returns when the query doesn't say. */
const DEFAULT_LIST_SIZE = 20;
/** Ceiling on a caller-supplied `limit`, for costing only — resolvers clamp separately. */
const MAX_LIST_SIZE = 200;

const fragmentsOf = (doc: DocumentNode): Map<string, FragmentDefinitionNode> =>
  new Map(
    doc.definitions
      .filter((d): d is FragmentDefinitionNode => d.kind === Kind.FRAGMENT_DEFINITION)
      .map((d) => [d.name.value, d])
  );

/**
 * Reject documents nested deeper than `max`.
 *
 * Fragments are walked in place — a query that stays shallow by hiding its
 * nesting behind a fragment is exactly as deep as one that inlines it. A cyclic
 * fragment spread is left to graphql's own `NoFragmentCycles` rule; the `seen`
 * set here only stops *this* walk from recursing forever while that rule is
 * still collecting its own error.
 */
export function depthLimit(max = MAX_DEPTH): ValidationRule {
  return (context: ValidationContext) => {
    const fragments = fragmentsOf(context.getDocument());

    const depthOf = (
      node: { selectionSet?: SelectionSetNode },
      depth: number,
      seen: Set<string>
    ): number => {
      if (!node.selectionSet) return depth;
      let deepest = depth;
      for (const selection of node.selectionSet.selections) {
        if (selection.kind === Kind.FIELD) {
          // Introspection meta-fields are answered from the schema, not the DB.
          const cost = selection.name.value.startsWith("__") ? 0 : 1;
          deepest = Math.max(deepest, depthOf(selection, depth + cost, seen));
        } else if (selection.kind === Kind.INLINE_FRAGMENT) {
          deepest = Math.max(deepest, depthOf(selection, depth, seen));
        } else {
          const name = selection.name.value;
          const fragment = fragments.get(name);
          if (!fragment || seen.has(name)) continue;
          seen.add(name);
          deepest = Math.max(deepest, depthOf(fragment, depth, seen));
          seen.delete(name);
        }
      }
      return deepest;
    };

    return {
      OperationDefinition(operation) {
        const depth = depthOf(operation, 0, new Set());
        if (depth > max) {
          context.reportError(
            new GraphQLError(`Query is too deeply nested (${depth} > ${max}).`, {
              nodes: [operation as ASTNode],
              extensions: { code: "QUERY_TOO_DEEP" },
            })
          );
        }
      },
    };
  };
}

/**
 * How many rows a list field is being asked for, for costing purposes.
 *
 * Read off the literal argument, because that is the only value available at
 * validation time — a `$limit` variable has not been coerced yet. Taking the
 * default for a variable is the conservative reading in both directions: it
 * cannot be gamed downward (the ceiling still applies to the multiplied total),
 * and it doesn't reject an ordinary paginated query for asking politely.
 */
function listSize(field: FieldNode): number {
  for (const arg of field.arguments ?? []) {
    if (arg.name.value !== "limit" && arg.name.value !== "maxPoints") continue;
    if (arg.value.kind !== Kind.INT) return DEFAULT_LIST_SIZE;
    return Math.min(MAX_LIST_SIZE, Math.max(1, parseInt(arg.value.value, 10)));
  }
  return DEFAULT_LIST_SIZE;
}

/** A type whose fields a selection set can be walked against. */
type Composite = ReturnType<typeof asComposite>;

const asComposite = (type: GraphQLNamedType | null | undefined) =>
  type && (isObjectType(type) || isInterfaceType(type)) ? type : null;

/** Does this field return many of something, or one? Only the former multiplies. */
function isListLike(type: GraphQLOutputType): boolean {
  const inner = isNonNullType(type) ? type.ofType : type;
  return isListType(inner);
}

/**
 * Reject documents whose total selection is too expensive.
 *
 * A field costs one, plus the cost of its own selection — multiplied by how many
 * rows it returns, but *only if it returns rows*. That distinction is the whole
 * model: charging every nested object as though it were a list made
 * `cryptoRound { entries { lines { … } } }` — the query the board draws itself
 * with — cost seventeen thousand, and a budget that rejects the client's own
 * first request is not a budget, it is an outage. So the multiplier comes from
 * the schema's type for the field rather than from its shape in the document.
 *
 * Aliases are counted separately by construction: they are distinct field nodes
 * in the AST, so asking for the same field five hundred times costs five hundred
 * times as much, which is the point.
 */
export function costLimit(max = MAX_COST): ValidationRule {
  return (context: ValidationContext) => {
    const schema = context.getSchema();
    const fragments = fragmentsOf(context.getDocument());

    const costOf = (
      parent: Composite,
      selectionSet: SelectionSetNode | undefined,
      seen: Set<string>
    ): number => {
      if (!selectionSet) return 0;
      let total = 0;

      for (const selection of selectionSet.selections) {
        if (total > max) break; // already over; no need to price the rest

        if (selection.kind === Kind.FIELD) {
          if (selection.name.value.startsWith("__")) continue;
          total += 1;
          if (!selection.selectionSet) continue;

          const def = parent?.getFields()[selection.name.value];
          // An unknown field is graphql's own error to report; price its
          // selection at face value rather than guessing a multiplier.
          const rows = def && isListLike(def.type) ? listSize(selection) : 1;
          const next = def ? asComposite(getNamedType(def.type)) : null;
          total += rows * costOf(next, selection.selectionSet, seen);
        } else if (selection.kind === Kind.INLINE_FRAGMENT) {
          const named = selection.typeCondition
            ? schema.getType(selection.typeCondition.name.value)
            : parent;
          total += costOf(asComposite(named) ?? parent, selection.selectionSet, seen);
        } else {
          const name = selection.name.value;
          const fragment = fragments.get(name);
          if (!fragment || seen.has(name)) continue;
          seen.add(name);
          const named = schema.getType(fragment.typeCondition.name.value);
          total += costOf(asComposite(named) ?? parent, fragment.selectionSet, seen);
          seen.delete(name);
        }
      }
      return total;
    };

    return {
      OperationDefinition(operation) {
        const root =
          operation.operation === "mutation"
            ? schema.getMutationType()
            : operation.operation === "subscription"
              ? schema.getSubscriptionType()
              : schema.getQueryType();

        const cost = costOf(asComposite(root), operation.selectionSet, new Set());
        if (cost > max) {
          context.reportError(
            new GraphQLError(`Query is too expensive (cost ${cost} > ${max}).`, {
              nodes: [operation as ASTNode],
              extensions: { code: "QUERY_TOO_COMPLEX" },
            })
          );
        }
      },
    };
  };
}
