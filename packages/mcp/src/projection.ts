import type { ActionType, ObjectType } from "@operon/schema";

export interface ProjectedMcpTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: {
    readonly type: "object";
    readonly properties: Record<string, unknown>;
    readonly required?: readonly string[];
  };
  readonly actionId: string;
}

/**
 * Recursively projects an Effect Schema AST node into a faithful JSON Schema definition.
 */
export function astToJsonSchema(ast: any): Record<string, unknown> {
  if (!ast) return { type: "string" };

  switch (ast._tag) {
    case "String":
    case "StringKeyword": {
      return { type: "string" };
    }
    case "Number":
    case "NumberKeyword": {
      return { type: "number" };
    }
    case "Boolean":
    case "BooleanKeyword": {
      return { type: "boolean" };
    }
    case "Arrays": {
      return {
        items: ast.rest?.[0]
          ? astToJsonSchema(ast.rest[0])
          : { type: "string" },
        type: "array",
      };
    }
    case "Literal": {
      return { const: ast.literal };
    }
    case "Union": {
      const nonUndefined =
        ast.types?.filter((t: any) => t._tag !== "Undefined") ?? [];
      if (nonUndefined.length === 1) {
        return astToJsonSchema(nonUndefined[0]);
      }
      if (
        nonUndefined.length > 0 &&
        nonUndefined.every((t: any) => t._tag === "Literal")
      ) {
        return {
          enum: nonUndefined.map((t: any) => t.literal),
          type: typeof nonUndefined[0].literal,
        };
      }
      return {
        anyOf: nonUndefined.map((t: any) => astToJsonSchema(t)),
      };
    }
    case "Objects":
    case "TypeLiteral": {
      const props: Record<string, unknown> = {};
      const req: string[] = [];
      for (const p of ast.propertySignatures ?? []) {
        const pName = String(p.name);
        props[pName] = astToJsonSchema(p.type);
        const isOpt =
          Boolean(p.isOptional) ||
          Boolean(p.type?.context?.isOptional) ||
          p.type?._tag === "Undefined" ||
          (p.type?._tag === "Union" &&
            p.type?.types?.some((t: any) => t._tag === "Undefined"));
        if (!isOpt) {
          req.push(pName);
        }
      }
      return {
        properties: props,
        required: req.length > 0 ? req : undefined,
        type: "object",
      };
    }
    default: {
      return { type: "string" };
    }
  }
}

/**
 * Projects an ActionType definition into an MCP Tool specification
 */
export function projectActionToTool(action: ActionType): ProjectedMcpTool {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  // Extract properties from parameter schema if available
  const schemaAst = (action.parametersSchema as any)?.ast;
  if (
    schemaAst &&
    (schemaAst._tag === "Objects" || schemaAst._tag === "TypeLiteral")
  ) {
    for (const prop of schemaAst.propertySignatures) {
      const propName = String(prop.name);
      const subSchema = astToJsonSchema(prop.type);
      properties[propName] = {
        description: `Parameter ${propName}`,
        ...subSchema,
      };
      const isOptional =
        Boolean(prop.isOptional) ||
        Boolean(prop.type?.context?.isOptional) ||
        prop.type?._tag === "Undefined" ||
        (prop.type?._tag === "Union" &&
          prop.type?.types?.some((t: any) => t._tag === "Undefined"));
      if (!isOptional) {
        required.push(propName);
      }
    }
  } else {
    properties["params"] = {
      description: "Parameters object for the action",
      type: "object",
    };
  }

  return {
    actionId: action.id,
    description: `${action.description} (Risk Tier: ${action.riskTier}, Min Agent Tier: ${action.minimumAgentTier})`,
    inputSchema: {
      properties,
      required: required.length > 0 ? required : undefined,
      type: "object",
    },
    name: `operon_${action.id}`,
  };
}

/**
 * Projects an ObjectType into a structured prompt grounding summary
 */
export function projectObjectTypeToGrounding(objectType: ObjectType): string {
  const propList = Object.entries(objectType.properties)
    .map(
      ([name, def]) =>
        `  - ${name}: ${def.description}${def.freshnessBudget ? ` [Max staleness: ${def.freshnessBudget.maxStalenessMs / 1000}s]` : ""}`
    )
    .join("\n");

  return `### ObjectType: ${objectType.name} (${objectType.id})
Typology: ${objectType.typology}
Description: ${objectType.description}
Primary Key: ${objectType.primaryKey}
Properties:
${propList}`;
}
