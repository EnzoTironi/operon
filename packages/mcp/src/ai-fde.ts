import type { OntologyMetadataService } from "@operon/runtime";
import type {
  ActionParameters,
  ActionType,
  LinkType,
  ObjectType,
  OntologyProposal,
  PropertyDefinition,
  ProposalChangeSet,
  Subject,
} from "@operon/schema";
import {
  defineActionType,
  defineLinkType,
  defineObjectType,
  defineProperty,
} from "@operon/schema";
import { Data, Effect, Schema } from "effect";

import { assertBuilderKey } from "./keys.js";

export class FdePermissionError extends Data.TaggedError("FdePermissionError")<{
  readonly reason: string;
}> {}

export interface SynthesizedChangeSet {
  readonly objectTypes: readonly ObjectType[];
  readonly linkTypes: readonly LinkType[];
  readonly actionTypes: readonly ActionType[];
}

export interface FdeInstructionRequest {
  readonly apiKey: string;
  readonly instruction: string;
  readonly targetBranchName: string;
  readonly author: Subject;
  readonly synthesizedChangeSet?: SynthesizedChangeSet;
}

export interface FdeProposalResult {
  readonly branchName: string;
  readonly proposal: OntologyProposal;
  readonly summary: string;
  readonly nextStep: string;
}

const OBJECT_TYPE_REGEX =
  /(?:create|define|add)\s+object\s+type\s+(?<typeName>[A-Za-z0-9_]+)(?:\s+with\s+properties\s+(?<props>[^.\n]+))?/giu;

const LINK_TYPE_REGEX =
  /(?:create|define|add)\s+link\s+(?<linkId>[A-Za-z0-9_]+)\s+from\s+(?<sourceId>[A-Za-z0-9_]+)\s+to\s+(?<targetId>[A-Za-z0-9_]+)(?:\s+cardinality\s+(?<cardinality>[1N]:[1N]))?/giu;

const ACTION_TYPE_REGEX =
  /(?:create|define|add)\s+action\s+(?<actId>[A-Za-z0-9_]+)(?:\s+targeting\s+(?<targetType>[A-Za-z0-9_]+))?(?:\s+with\s+parameters\s+(?<params>[^.\n]+))?/giu;

function mapTypeNameToSchema(
  normType?: string
): Schema.Codec<unknown, unknown, never> {
  if (normType === "number" || normType === "int" || normType === "float") {
    return Schema.Number;
  }
  if (normType === "boolean" || normType === "bool") {
    return Schema.Boolean;
  }
  return Schema.String;
}

function parsePropertyPair(
  pair: string,
  properties: Record<string, PropertyDefinition>,
  currentPk: string
): string {
  const [pName, pType] = pair.split(":").map((s) => s.trim());
  if (!pName) {
    return currentPk;
  }
  const normType = pType?.toLowerCase();
  const schema = mapTypeNameToSchema(normType);
  const isId = pName.toLowerCase().includes("id");
  properties[pName] = defineProperty({
    description: `Synthesized property ${pName}`,
    required: isId,
    schema,
  });
  return isId && currentPk === "id" ? pName : currentPk;
}

interface ParsedProperties {
  readonly properties: Record<string, PropertyDefinition>;
  readonly primaryKey: string;
}

function parseProperties(propsStr: string): ParsedProperties {
  const properties: Record<string, PropertyDefinition> = {};
  let pk = "id";
  if (propsStr) {
    const propPairs = propsStr.split(",").map((p) => p.trim());
    for (const pair of propPairs) {
      pk = parsePropertyPair(pair, properties, pk);
    }
  }
  if (!properties[pk]) {
    properties[pk] = defineProperty({
      description: `Primary key ${pk}`,
      required: true,
      schema: Schema.String,
    });
  }
  return { primaryKey: pk, properties };
}

function getRegexGroup(
  match: RegExpExecArray,
  name: string,
  index: number,
  fallback = ""
): string {
  return match.groups?.[name] ?? match[index] ?? fallback;
}

function buildSynthesizedObjectType(
  match: RegExpExecArray,
  instruction: string
): ObjectType {
  const typeName = getRegexGroup(match, "typeName", 1);
  const propsStr = getRegexGroup(match, "props", 2);
  const { primaryKey, properties } = parseProperties(propsStr);
  return defineObjectType({
    description: `Synthesized by AI FDE from instruction: "${instruction}"`,
    id: typeName,
    name: typeName,
    primaryKey,
    properties,
    typology: "master",
  });
}

function parseObjectTypes(instruction: string): readonly ObjectType[] {
  const objectTypes: ObjectType[] = [];
  const regex = new RegExp(OBJECT_TYPE_REGEX.source, OBJECT_TYPE_REGEX.flags);
  let match: RegExpExecArray | null;

  while ((match = regex.exec(instruction)) !== null) {
    objectTypes.push(buildSynthesizedObjectType(match, instruction));
  }
  return objectTypes;
}

function resolveCardinality(
  rawCard?: string
): "one-to-one" | "many-to-many" | "one-to-many" {
  if (rawCard === "1:1") {
    return "one-to-one";
  }
  if (rawCard === "M:N") {
    return "many-to-many";
  }
  return "one-to-many";
}

function buildSynthesizedLinkType(match: RegExpExecArray): LinkType {
  const linkId = getRegexGroup(match, "linkId", 1);
  const sourceTypeId = getRegexGroup(match, "sourceId", 2);
  const targetTypeId = getRegexGroup(match, "targetId", 3);
  const rawCard = getRegexGroup(match, "cardinality", 4);
  return defineLinkType({
    cardinality: resolveCardinality(rawCard),
    description: `Synthesized link ${linkId} from ${sourceTypeId} to ${targetTypeId}`,
    id: linkId,
    sourceToTargetName: targetTypeId.toLowerCase(),
    sourceTypeId,
    targetToSourceName: sourceTypeId.toLowerCase(),
    targetTypeId,
  });
}

function parseLinkTypes(instruction: string): readonly LinkType[] {
  const linkTypes: LinkType[] = [];
  const regex = new RegExp(LINK_TYPE_REGEX.source, LINK_TYPE_REGEX.flags);
  let match: RegExpExecArray | null;

  while ((match = regex.exec(instruction)) !== null) {
    linkTypes.push(buildSynthesizedLinkType(match));
  }
  return linkTypes;
}

function mapParamTypeToSchema(normType?: string): Schema.Schema<unknown> {
  if (normType === "number") {
    return Schema.Number;
  }
  if (normType === "boolean") {
    return Schema.Boolean;
  }
  return Schema.String;
}

function parseActionParameters(paramsStr: string) {
  const structProps: Record<string, Schema.Schema<unknown>> = {};
  if (!paramsStr) {
    return structProps;
  }
  const paramPairs = paramsStr.split(",").map((p) => p.trim());
  for (const pair of paramPairs) {
    const [pName, pType] = pair.split(":").map((s) => s.trim());
    if (pName) {
      structProps[pName] = mapParamTypeToSchema(pType?.toLowerCase());
    }
  }
  return structProps;
}

function buildSynthesizedActionType(match: RegExpExecArray): ActionType {
  const actId = getRegexGroup(match, "actId", 1);
  const targetType = getRegexGroup(match, "targetType", 2);
  const paramsStr = getRegexGroup(match, "params", 3);
  const structProps = parseActionParameters(paramsStr);
  return defineActionType({
    defaultExecutionMode: "proposal",
    description: `Synthesized action ${actId}`,
    id: actId,
    minimumAgentTier: 2,
    name: actId,
    // SAFETY: structProps are parsed as Json schema properties matching ActionParameters contract
    parametersSchema: Schema.Struct(
      structProps
    ) as Schema.Schema<ActionParameters>,
    riskTier: "medium",
    targetObjectTypeId: targetType,
  });
}

function parseActionTypes(instruction: string): readonly ActionType[] {
  const actionTypes: ActionType[] = [];
  const regex = new RegExp(ACTION_TYPE_REGEX.source, ACTION_TYPE_REGEX.flags);
  let match: RegExpExecArray | null;

  while ((match = regex.exec(instruction)) !== null) {
    actionTypes.push(buildSynthesizedActionType(match));
  }
  return actionTypes;
}

const registerSynthesizedElements = Effect.fn("registerSynthesizedElements")(
  function* (
    oms: OntologyMetadataService,
    branchName: string,
    synthesized: SynthesizedChangeSet
  ) {
    yield* Effect.forEach(
      synthesized.objectTypes,
      (ot) => oms.registerObjectType(branchName, ot),
      { concurrency: 1 }
    );
    yield* Effect.forEach(
      synthesized.linkTypes,
      (lt) => oms.registerLinkType(branchName, lt),
      { concurrency: 1 }
    );
    yield* Effect.forEach(
      synthesized.actionTypes,
      (at) => oms.registerActionType(branchName, at),
      { concurrency: 1 }
    );
    return {
      addedActionTypes: [...synthesized.actionTypes],
      addedLinkTypes: [...synthesized.linkTypes],
      addedObjectTypes: [...synthesized.objectTypes],
    };
  }
);

/**
 * AI FDE (AI-Powered Forward Deployed Engineer)
 * Translates operational business requirements in natural language into sandboxed working branches and proposals.
 */
export class AIFdeAgent {
  private readonly oms: OntologyMetadataService;

  constructor(oms: OntologyMetadataService) {
    this.oms = oms;
  }

  /**
   * Compiles natural language requirements into concrete schema change sets.
   */
  public synthesizeFromInstruction(instruction: string): SynthesizedChangeSet {
    return {
      actionTypes: parseActionTypes(instruction),
      linkTypes: parseLinkTypes(instruction),
      objectTypes: parseObjectTypes(instruction),
    };
  }

  executeInstruction(
    req: FdeInstructionRequest
  ): Effect.Effect<FdeProposalResult, FdePermissionError | unknown> {
    const { oms } = this;

    return Effect.gen({ self: this }, function* () {
      // 1. Strict Boundary Assertion: Builder Key required
      yield* assertBuilderKey(req.apiKey).pipe(
        Effect.mapError(
          (err: Error) => new FdePermissionError({ reason: err.message })
        )
      );

      // 2. Synthesize change set if not explicitly supplied
      const synthesized =
        req.synthesizedChangeSet ??
        this.synthesizeFromInstruction(req.instruction);

      // 3. Fork isolated working branch
      const branch = yield* oms.createBranch(
        req.targetBranchName,
        req.author,
        "main"
      );

      // 4. Register synthesized elements on the branch
      const { addedActionTypes, addedLinkTypes, addedObjectTypes } =
        yield* registerSynthesizedElements(oms, branch.name, synthesized);

      const changeSet: ProposalChangeSet = {
        addedActionTypes,
        addedLinkTypes,
        addedObjectTypes,
        deletedActionTypeIds: [],
        deletedLinkTypeIds: [],
        deletedObjectTypeIds: [],
        modifiedActionTypes: [],
        modifiedLinkTypes: [],
        modifiedObjectTypes: [],
      };

      // 5. Submit Ontology Proposal for human review
      const proposal = yield* oms.createProposal({
        author: req.author,
        changeSet,
        description: `Automated proposal synthesized by AI FDE for instruction: "${req.instruction}"`,
        sourceBranch: branch.name,
        targetBranch: "main",
        title: `AI FDE: ${req.instruction.slice(0, 50)}...`,
      });

      const summary = `AI FDE created branch '${branch.name}' with ${addedObjectTypes.length} Object Types, ${addedLinkTypes.length} Link Types, and ${addedActionTypes.length} Action Types.`;

      return {
        branchName: branch.name,
        nextStep: `Proposal '${proposal.id}' submitted for human review in the Approvals App before merge into 'main'.`,
        proposal,
        summary,
      };
    });
  }
}
