import type { ActionType, ObjectType } from "@operon/schema";
import { Predicate, SchemaAST } from "effect";
import type { Schema } from "effect";

export type JsonSchemaProperty = Schema.Json;

export interface ExtractedToolProperties {
  readonly properties: Record<string, JsonSchemaProperty>;
  readonly required: readonly string[];
}

export interface ProjectedMcpTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: {
    readonly type: "object";
    readonly properties: Record<string, JsonSchemaProperty>;
    readonly required?: readonly string[];
  };
  readonly actionId: string;
}

const PRIMITIVE_JSON_TYPE_MAP: ReadonlyMap<string, string> = new Map([
  ["Boolean", "boolean"],
  ["BooleanKeyword", "boolean"],
  ["Number", "number"],
  ["NumberKeyword", "number"],
  ["String", "string"],
  ["StringKeyword", "string"],
]);

function convertPrimitiveAst(ast: SchemaAST.AST) {
  const jsonType = PRIMITIVE_JSON_TYPE_MAP.get(ast._tag);
  return jsonType ? { type: jsonType } : undefined;
}

function convertArrayAst(
  ast: SchemaAST.AST,
  toJsonSchema: (ast?: SchemaAST.AST) => Record<string, JsonSchemaProperty>
) {
  if (!Predicate.isTagged(ast, "Arrays")) {
    return undefined;
  }
  // SAFETY: Arrays AST contains rest array element AST
  const arraysNode = ast as SchemaAST.Arrays;
  const restAst = arraysNode.rest[0];
  const items = restAst ? toJsonSchema(restAst) : { type: "string" };
  return { items, type: "array" };
}

function convertLiteralAst(ast: SchemaAST.AST) {
  if (!Predicate.isTagged(ast, "Literal")) {
    return undefined;
  }
  // SAFETY: ast.literal is a JSON-compatible literal value
  return { const: ast.literal as Schema.Json };
}

function getLiteralType(
  val: string | number | boolean | bigint | null | undefined
): string {
  if (Predicate.isString(val)) {
    return "string";
  }
  if (Predicate.isNumber(val)) {
    return "number";
  }
  if (Predicate.isBoolean(val)) {
    return "boolean";
  }
  return "string";
}

function renderLiteralEnumUnion(literals: readonly SchemaAST.Literal[]) {
  const first = literals[0];
  return {
    // SAFETY: SchemaAST Literal value is JSON-serializable
    enum: literals.map((l) => l.literal as Schema.Json),
    type: getLiteralType(first.literal),
  };
}

function convertUnionAst(
  ast: SchemaAST.AST,
  toJsonSchema: (ast?: SchemaAST.AST) => Record<string, JsonSchemaProperty>
) {
  if (!Predicate.isTagged(ast, "Union")) {
    return undefined;
  }
  const nonUndefined = ast.types.filter(
    (t) => !Predicate.isTagged(t, "Undefined")
  );
  if (nonUndefined.length === 1) {
    return toJsonSchema(nonUndefined[0]);
  }
  const allLiteral =
    nonUndefined.length > 0 &&
    nonUndefined.every((t): t is SchemaAST.Literal =>
      Predicate.isTagged(t, "Literal")
    );
  if (allLiteral) {
    return renderLiteralEnumUnion(nonUndefined);
  }
  return {
    anyOf: nonUndefined.map((t) => toJsonSchema(t)),
  };
}

function isAstOptional(p: SchemaAST.PropertySignature): boolean {
  if (SchemaAST.isOptional(p.type)) {
    return true;
  }
  const pType = p.type;
  if (Predicate.isTagged(pType, "Undefined")) {
    return true;
  }
  if (Predicate.isTagged(pType, "Union")) {
    return pType.types.some((t) => Predicate.isTagged(t, "Undefined"));
  }
  return false;
}

function extractObjectProperties(
  ast: SchemaAST.Objects,
  toJsonSchema: (ast?: SchemaAST.AST) => Record<string, JsonSchemaProperty>
) {
  const props: Record<string, JsonSchemaProperty> = {};
  const req: string[] = [];
  for (const p of ast.propertySignatures) {
    const pName = String(p.name);
    props[pName] = toJsonSchema(p.type);
    if (!isAstOptional(p)) {
      req.push(pName);
    }
  }
  return { props, req };
}

function convertObjectAst(
  ast: SchemaAST.AST,
  toJsonSchema: (ast?: SchemaAST.AST) => Record<string, JsonSchemaProperty>
) {
  if (!SchemaAST.isObjects(ast)) {
    return undefined;
  }
  const { props, req } = extractObjectProperties(ast, toJsonSchema);
  return {
    properties: props,
    required: req.length > 0 ? req : undefined,
    type: "object",
  };
}

function convertSimpleAst(
  ast: SchemaAST.AST,
  toJsonSchema: (ast?: SchemaAST.AST) => Record<string, JsonSchemaProperty>
) {
  return (
    convertPrimitiveAst(ast) ??
    convertArrayAst(ast, toJsonSchema) ??
    convertLiteralAst(ast)
  );
}

/**
 * Recursively projects an Effect Schema AST node into a faithful JSON Schema definition.
 */
export function astToJsonSchema(ast?: SchemaAST.AST) {
  if (!ast) {
    return { type: "string" };
  }
  const simple = convertSimpleAst(ast, astToJsonSchema);
  if (simple) {
    return simple;
  }
  return (
    convertUnionAst(ast, astToJsonSchema) ??
    convertObjectAst(ast, astToJsonSchema) ?? { type: "string" }
  );
}

function extractToolPropertiesFromAst(
  schemaAst: SchemaAST.Objects
): ExtractedToolProperties {
  const properties: Record<string, JsonSchemaProperty> = {};
  const required: string[] = [];

  for (const prop of schemaAst.propertySignatures) {
    const propName = String(prop.name);
    const subSchema = astToJsonSchema(prop.type);
    properties[propName] = {
      description: `Parameter ${propName}`,
      ...subSchema,
    };
    if (!isAstOptional(prop)) {
      required.push(propName);
    }
  }
  return { properties, required };
}

const DEFAULT_REQUIRED: readonly string[] = [];

function getToolParametersSchema(
  schemaAst?: SchemaAST.AST
): ExtractedToolProperties {
  if (schemaAst && SchemaAST.isObjects(schemaAst)) {
    return extractToolPropertiesFromAst(schemaAst);
  }
  return {
    properties: {
      params: {
        description: "Parameters object for the action",
        type: "object",
      },
    },
    required: DEFAULT_REQUIRED,
  };
}

/**
 * Projects an ActionType definition into an MCP Tool specification
 */
export function projectActionToTool(action: ActionType): ProjectedMcpTool {
  // SAFETY: parametersSchema AST contains Effect Schema AST definition
  const schemaAst = (
    action.parametersSchema as { readonly ast?: SchemaAST.AST }
  )?.ast;
  const { properties, required } = getToolParametersSchema(schemaAst);

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
