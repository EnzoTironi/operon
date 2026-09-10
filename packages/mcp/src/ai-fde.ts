import type { OntologyMetadataService } from "@operon/runtime";
import type {
  ActionType,
  LinkType,
  ObjectType,
  OntologyProposal,
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

export interface FdeInstructionRequest {
  readonly apiKey: string;
  readonly instruction: string;
  readonly targetBranchName: string;
  readonly author: Subject;
  readonly synthesizedChangeSet?: {
    readonly objectTypes?: readonly ObjectType[];
    readonly linkTypes?: readonly LinkType[];
    readonly actionTypes?: readonly ActionType<any>[];
  };
}

export interface FdeProposalResult {
  readonly branchName: string;
  readonly proposal: OntologyProposal;
  readonly summary: string;
  readonly nextStep: string;
}

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
  public synthesizeFromInstruction(instruction: string): {
    readonly objectTypes: ObjectType[];
    readonly linkTypes: LinkType[];
    readonly actionTypes: ActionType<any>[];
  } {
    const objectTypes: ObjectType[] = [];
    const linkTypes: LinkType[] = [];
    const actionTypes: ActionType<any>[] = [];

    // Parse Object Type definitions
    const objRegex =
      /(?:create|define|add)\s+object\s+type\s+(?<typeName>[A-Za-z0-9_]+)(?:\s+with\s+properties\s+(?<props>[^.\n]+))?/giu;
    let match: RegExpExecArray | null;

    while ((match = objRegex.exec(instruction)) !== null) {
      const typeName = match.groups?.typeName ?? match[1];
      const propsStr = match.groups?.props ?? match[2] ?? "";
      const properties: Record<string, any> = {};
      let pk = "id";

      if (propsStr) {
        const propPairs = propsStr.split(",").map((p) => p.trim());
        for (const pair of propPairs) {
          const [pName, pType] = pair.split(":").map((s) => s.trim());
          if (pName) {
            let schema: any = Schema.String;
            const normType = pType?.toLowerCase();
            if (
              normType === "number" ||
              normType === "int" ||
              normType === "float"
            ) {
              schema = Schema.Number;
            } else if (normType === "boolean" || normType === "bool") {
              schema = Schema.Boolean;
            }
            properties[pName] = defineProperty({
              description: `Synthesized property ${pName}`,
              required: pName.toLowerCase().includes("id"),
              schema,
            });
            if (pName.toLowerCase().includes("id") && pk === "id") {
              pk = pName;
            }
          }
        }
      }

      if (!properties[pk]) {
        properties[pk] = defineProperty({
          description: `Primary key ${pk}`,
          required: true,
          schema: Schema.String,
        });
      }

      objectTypes.push(
        defineObjectType({
          description: `Synthesized by AI FDE from instruction: "${instruction}"`,
          id: typeName,
          name: typeName,
          primaryKey: pk,
          properties,
          typology: "master",
        })
      );
    }

    // Parse Link Type definitions
    const linkRegex =
      /(?:create|define|add)\s+link\s+(?<linkId>[A-Za-z0-9_]+)\s+from\s+(?<sourceId>[A-Za-z0-9_]+)\s+to\s+(?<targetId>[A-Za-z0-9_]+)(?:\s+cardinality\s+(?<cardinality>[1N]:[1N]))?/giu;
    while ((match = linkRegex.exec(instruction)) !== null) {
      const linkId = match.groups?.linkId ?? match[1];
      const sourceTypeId = match.groups?.sourceId ?? match[2];
      const targetTypeId = match.groups?.targetId ?? match[3];
      const rawCard = match.groups?.cardinality ?? match[4];
      const cardinality =
        rawCard === "1:1"
          ? "one-to-one"
          : rawCard === "M:N"
            ? "many-to-many"
            : "one-to-many";

      linkTypes.push(
        defineLinkType({
          cardinality,
          description: `Synthesized link ${linkId} from ${sourceTypeId} to ${targetTypeId}`,
          id: linkId,
          sourceToTargetName: targetTypeId.toLowerCase(),
          sourceTypeId,
          targetToSourceName: sourceTypeId.toLowerCase(),
          targetTypeId,
        })
      );
    }

    // Parse Action Type definitions
    const actRegex =
      /(?:create|define|add)\s+action\s+(?<actId>[A-Za-z0-9_]+)(?:\s+targeting\s+(?<targetType>[A-Za-z0-9_]+))?(?:\s+with\s+parameters\s+(?<params>[^.\n]+))?/giu;
    while ((match = actRegex.exec(instruction)) !== null) {
      const actId = match.groups?.actId ?? match[1];
      const targetType = match.groups?.targetType ?? match[2];
      const paramsStr = match.groups?.params ?? match[3] ?? "";
      const structProps: Record<string, any> = {};

      if (paramsStr) {
        const paramPairs = paramsStr.split(",").map((p) => p.trim());
        for (const pair of paramPairs) {
          const [pName, pType] = pair.split(":").map((s) => s.trim());
          if (pName) {
            let schema: any = Schema.String;
            const normType = pType?.toLowerCase();
            if (normType === "number") schema = Schema.Number;
            else if (normType === "boolean") schema = Schema.Boolean;
            structProps[pName] = schema;
          }
        }
      }

      actionTypes.push(
        defineActionType({
          defaultExecutionMode: "proposal",
          description: `Synthesized action ${actId}`,
          id: actId,
          minimumAgentTier: 2,
          name: actId,
          parametersSchema: Schema.Struct(structProps),
          riskTier: "medium",
          targetObjectTypeId: targetType,
        })
      );
    }

    return { actionTypes, linkTypes, objectTypes };
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
      const addedObjectTypes: ObjectType[] = [];
      if (synthesized.objectTypes) {
        for (const ot of synthesized.objectTypes) {
          yield* oms.registerObjectType(branch.name, ot);
          addedObjectTypes.push(ot);
        }
      }

      const addedLinkTypes: LinkType[] = [];
      if (synthesized.linkTypes) {
        for (const lt of synthesized.linkTypes) {
          yield* oms.registerLinkType(branch.name, lt);
          addedLinkTypes.push(lt);
        }
      }

      const addedActionTypes: ActionType<any>[] = [];
      if (synthesized.actionTypes) {
        for (const at of synthesized.actionTypes) {
          yield* oms.registerActionType(branch.name, at);
          addedActionTypes.push(at);
        }
      }

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
