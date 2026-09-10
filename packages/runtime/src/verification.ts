import type {
  ActionType,
  InterfaceType,
  LinkType,
  ObjectInstance,
  ObjectType,
  OntologyBranch,
  OntologyProposal,
} from "@operon/schema";
import { Data, Effect } from "effect";

export class StructuralVerificationError extends Data.TaggedError(
  "StructuralVerificationError"
)<{
  readonly message: string;
  readonly issues: readonly string[];
}> {}

/**
 * Chapter 16 Layer 2: Output Quality Evaluation
 * DQ(o, c, q, π) = Correct(o, c) ∧ Complete(o, q) ∧ Cited(o) ∧ Compliant(o, π)
 */
export interface AgentOutputAssertion {
  readonly property: string;
  readonly assertedValue: unknown;
  readonly sourceObjectId?: string;
  readonly sourceVersion?: number;
  readonly sourceProperty?: string;
  readonly sourceSpan?: string;
}

export interface AgentDecisionOutput {
  readonly outputId: string;
  readonly actionTypeId: string;
  readonly proposedParameters: Record<string, unknown>;
  readonly assertions: readonly AgentOutputAssertion[];
  readonly requiredQuestionsAnswered: readonly string[];
  readonly agentTier: number;
}

export interface DecisionContextSubgraph {
  readonly objects: readonly ObjectInstance[];
}

export interface DecisionQueryGoal {
  readonly mustAnswerSet: readonly string[];
}

export interface GoverningPolicy {
  readonly allowedAgentTier: number;
  readonly forbiddenParameters?: readonly string[];
  readonly scenarioRedLines?: readonly {
    readonly property: string;
    readonly condition: (val: unknown) => boolean;
    readonly description: string;
  }[];
}

export interface DecisionQualityL2 {
  readonly isQualityPassed: boolean;
  readonly correct: {
    readonly passed: boolean;
    readonly contradictions: readonly string[];
  };
  readonly complete: {
    readonly passed: boolean;
    readonly missingMustAnswer: readonly string[];
  };
  readonly cited: {
    readonly passed: boolean;
    readonly uncitedAssertions: readonly string[];
  };
  readonly compliant: {
    readonly passed: boolean;
    readonly violations: readonly string[];
  };
  readonly issues: readonly string[];
}

/**
 * Chapter 16 Joint Formalization of Two-Layer 4C:
 * Evaluates Layer 2 Output Quality (Correct, Complete, Cited, Compliant).
 */
export function evaluateDecisionQualityL2(
  output: AgentDecisionOutput,
  context: DecisionContextSubgraph,
  query: DecisionQueryGoal,
  policy: GoverningPolicy
): Effect.Effect<DecisionQualityL2> {
  return Effect.sync(() => {
    const objectMap = new Map<string, ObjectInstance>();
    for (const obj of context.objects) {
      objectMap.set(obj.id, obj);
    }

    const contradictions: string[] = [];
    const uncitedAssertions: string[] = [];
    const missingMustAnswer: string[] = [];
    const violations: string[] = [];

    // 1. Correct(o, c): Factual assertions in output agree with context objects
    for (const assertion of output.assertions) {
      if (assertion.sourceObjectId) {
        const sourceObj = objectMap.get(assertion.sourceObjectId);
        if (sourceObj) {
          if (
            assertion.sourceVersion !== undefined &&
            assertion.sourceVersion !== sourceObj.version
          ) {
            contradictions.push(
              `Assertion on '${assertion.property}' references version ${assertion.sourceVersion}, but context object '${sourceObj.id}' is version ${sourceObj.version}`
            );
          }

          if (assertion.sourceProperty) {
            const props = sourceObj.properties as Record<string, unknown>;
            if (
              assertion.sourceProperty in props &&
              props[assertion.sourceProperty] !== undefined
            ) {
              const actualVal = props[assertion.sourceProperty];
              if (actualVal !== assertion.assertedValue) {
                contradictions.push(
                  `Contradiction on '${assertion.property}': asserted '${String(assertion.assertedValue)}', but context object '${sourceObj.id}' has '${String(actualVal)}'`
                );
              }
            } else {
              contradictions.push(
                `Assertion on '${assertion.property}' references nonexistent property '${assertion.sourceProperty}' on object '${sourceObj.id}'`
              );
            }
          }
        } else {
          contradictions.push(
            `Assertion on '${assertion.property}' references nonexistent object '${assertion.sourceObjectId}'`
          );
        }
      }
    }

    // 2. Complete(o, q): Must-answer set is fulfilled without omissions
    const answeredSet = new Set(output.requiredQuestionsAnswered);
    for (const requiredQ of query.mustAnswerSet) {
      if (!answeredSet.has(requiredQ)) {
        missingMustAnswer.push(
          `Must-answer question '${requiredQ}' was omitted from output`
        );
      }
    }

    // 3. Cited(o): Every assertion binds to verified evidence and source identifiers
    for (const assertion of output.assertions) {
      if (!assertion.sourceObjectId || !assertion.sourceSpan) {
        uncitedAssertions.push(
          `Assertion on '${assertion.property}' is uncited: missing sourceObjectId or sourceSpan`
        );
      }
    }

    // 4. Compliant(o, π): Stays within agent tier and respects scenario red lines
    if (output.agentTier > policy.allowedAgentTier) {
      violations.push(
        `Agent tier ${output.agentTier} exceeds policy maximum allowed tier ${policy.allowedAgentTier}`
      );
    }

    if (policy.forbiddenParameters) {
      for (const forbidden of policy.forbiddenParameters) {
        if (forbidden in output.proposedParameters) {
          violations.push(`Output contains forbidden parameter '${forbidden}'`);
        }
      }
    }

    if (policy.scenarioRedLines) {
      for (const redLine of policy.scenarioRedLines) {
        const val = output.proposedParameters[redLine.property];
        if (val !== undefined && redLine.condition(val)) {
          violations.push(`Scenario red line violated: ${redLine.description}`);
        }
      }
    }

    const issues = [
      ...contradictions,
      ...missingMustAnswer,
      ...uncitedAssertions,
      ...violations,
    ];

    return {
      cited: {
        passed: uncitedAssertions.length === 0,
        uncitedAssertions,
      },
      complete: {
        missingMustAnswer,
        passed: missingMustAnswer.length === 0,
      },
      compliant: {
        passed: violations.length === 0,
        violations,
      },
      correct: {
        contradictions,
        passed: contradictions.length === 0,
      },
      isQualityPassed: issues.length === 0,
      issues,
    };
  });
}

export interface StructuralReadinessL2 {
  readonly isReady: boolean;
  readonly correctness: {
    readonly valid: boolean;
    readonly danglingLinkReferences: readonly string[];
  };
  readonly completeness: {
    readonly valid: boolean;
    readonly missingInterfaceProperties: readonly string[];
  };
  readonly currency: {
    readonly valid: boolean;
    readonly isStale: boolean;
  };
  readonly consistency: {
    readonly valid: boolean;
    readonly issues: readonly string[];
  };
  readonly issues: readonly string[];
}

export interface VedoBoundaryConstraint {
  readonly property: string;
  readonly min?: number;
  readonly max?: number;
}

export interface VedoTransitionConstraint {
  readonly property: string;
  readonly allowedTransitions: Record<string, readonly string[]>;
}

export interface VedoInvariantSuite {
  readonly objectTypeId: string;
  readonly boundaries?: readonly VedoBoundaryConstraint[];
  readonly transitions?: readonly VedoTransitionConstraint[];
}

/**
 * Structural schema verification (dangling links, interfaces, branch timestamps)
 */
export function evaluateStructuralReadinessL2(
  objectTypes: readonly ObjectType[],
  linkTypes: readonly LinkType[],
  interfaceTypes: readonly InterfaceType[] = [],
  actionTypes: readonly ActionType<any>[] = [],
  branch?: OntologyBranch,
  upstreamMainTimestamp?: number
): Effect.Effect<StructuralReadinessL2> {
  return Effect.sync(() => {
    const objectTypeIds = new Set(objectTypes.map((o) => o.id as string));
    const danglingLinkReferences: string[] = [];
    const missingInterfaceProperties: string[] = [];
    const consistencyIssues: string[] = [];
    const issues: string[] = [];

    // 1. Correctness: Link target validity
    for (const link of linkTypes) {
      if (!objectTypeIds.has(link.sourceTypeId as string)) {
        danglingLinkReferences.push(
          `Link ${link.id}: source object type '${link.sourceTypeId}' does not exist.`
        );
      }
      if (!objectTypeIds.has(link.targetTypeId as string)) {
        danglingLinkReferences.push(
          `Link ${link.id}: target object type '${link.targetTypeId}' does not exist.`
        );
      }
    }

    // 2. Completeness: Interface compliance
    const interfaceMap = new Map(interfaceTypes.map((i) => [i.id, i]));
    for (const obj of objectTypes) {
      if (obj.implementedInterfaces) {
        for (const ifaceId of obj.implementedInterfaces) {
          const iface = interfaceMap.get(ifaceId);
          if (!iface) {
            missingInterfaceProperties.push(
              `Object ${obj.id} implements unknown interface '${ifaceId}'.`
            );
            continue;
          }
          for (const requiredProp of Object.keys(iface.properties)) {
            if (!(requiredProp in obj.properties)) {
              missingInterfaceProperties.push(
                `Object ${obj.id} implements interface '${ifaceId}' but is missing required property '${requiredProp}'.`
              );
            }
          }
        }
      }
    }

    // 3. Currency: Branch lineage freshness
    let isStale = false;
    if (branch && upstreamMainTimestamp) {
      // If upstream main was updated more than 7 days after branch creation without rebasing
      const branchAge = upstreamMainTimestamp - branch.createdAt;
      if (branchAge > 7 * 24 * 3600 * 1000) {
        isStale = true;
        issues.push(
          `Branch '${branch.name}' is stale relative to upstream main (diverged > 7 days). Rebase recommended.`
        );
      }
    }

    // 4. Consistency: Verify action targeting
    for (const action of actionTypes) {
      if (
        action.targetObjectTypeId &&
        !objectTypeIds.has(action.targetObjectTypeId as string)
      ) {
        consistencyIssues.push(
          `Action ${action.id} targets undefined object type '${action.targetObjectTypeId}'.`
        );
      }
    }

    issues.push(
      ...danglingLinkReferences,
      ...missingInterfaceProperties,
      ...consistencyIssues
    );

    const isReady = issues.length === 0 && !isStale;

    return {
      isReady,
      correctness: {
        valid: danglingLinkReferences.length === 0,
        danglingLinkReferences,
      },
      completeness: {
        valid: missingInterfaceProperties.length === 0,
        missingInterfaceProperties,
      },
      currency: {
        valid: !isStale,
        isStale,
      },
      consistency: {
        valid: consistencyIssues.length === 0,
        issues: consistencyIssues,
      },
      issues,
    };
  });
}

/**
 * CROV: Collaborative Real-time Ontology Verification (Chapter 16)
 * Continuous invariant verification engine for multi-stakeholder proposals.
 */
export class CROVEngine {
  verifyProposal(
    proposal: OntologyProposal,
    activeObjectTypes: readonly ObjectType[],
    activeLinkTypes: readonly LinkType[],
    activeInterfaces: readonly InterfaceType[] = []
  ): Effect.Effect<StructuralReadinessL2, StructuralVerificationError> {
    return Effect.gen(function* () {
      const mergedObjects = [
        ...activeObjectTypes.filter(
          (o) =>
            !proposal.changeSet.deletedObjectTypeIds.includes(o.id as string)
        ),
        ...proposal.changeSet.addedObjectTypes,
        ...proposal.changeSet.modifiedObjectTypes,
      ];

      const mergedLinks = [
        ...activeLinkTypes.filter(
          (l) => !proposal.changeSet.deletedLinkTypeIds.includes(l.id as string)
        ),
        ...proposal.changeSet.addedLinkTypes,
        ...proposal.changeSet.modifiedLinkTypes,
      ];

      const readiness = yield* evaluateStructuralReadinessL2(
        mergedObjects,
        mergedLinks,
        activeInterfaces,
        proposal.changeSet.addedActionTypes
      );

      if (!readiness.isReady) {
        return yield* Effect.fail(
          new StructuralVerificationError({
            message: `Proposal ${proposal.id} fails CROV structural verification.`,
            issues: readiness.issues,
          })
        );
      }

      return readiness;
    });
  }
}

/**
 * VEDO: Verified Enterprise Decision Ontology (Chapter 16)
 * Mathematical invariant verification (boundary limits, valid state transitions).
 */
export class VEDOVerifier {
  private suites = new Map<string, VedoInvariantSuite>();

  registerSuite(suite: VedoInvariantSuite): void {
    this.suites.set(suite.objectTypeId, suite);
  }

  verifyMutation(
    objectTypeId: string,
    nextProperties: Record<string, unknown>,
    previousProperties?: Record<string, unknown>
  ): Effect.Effect<void, StructuralVerificationError> {
    return Effect.gen({ self: this }, function* () {
      const suite = this.suites.get(objectTypeId);
      if (!suite) {
        return; // No invariant suite registered for this type
      }

      const violations: string[] = [];

      // Boundary constraints
      if (suite.boundaries) {
        const boundsList = Array.isArray(suite.boundaries)
          ? suite.boundaries
          : [suite.boundaries];
        for (const boundary of boundsList) {
          const val = nextProperties[boundary.property];
          if (typeof val === "number") {
            if (boundary.min !== undefined && val < boundary.min) {
              violations.push(
                `Property '${boundary.property}' value ${val} is below minimum bound ${boundary.min}.`
              );
            }
            if (boundary.max !== undefined && val > boundary.max) {
              violations.push(
                `Property '${boundary.property}' value ${val} exceeds maximum bound ${boundary.max}.`
              );
            }
          }
        }
      }

      // State transition constraints
      if (suite.transitions && previousProperties) {
        const transitionsList = Array.isArray(suite.transitions)
          ? suite.transitions
          : [suite.transitions];
        for (const transition of transitionsList) {
          const prevVal = previousProperties[transition.property];
          const nextVal = nextProperties[transition.property];

          if (
            typeof prevVal === "string" &&
            typeof nextVal === "string" &&
            prevVal !== nextVal
          ) {
            const allowed = transition.allowedTransitions[prevVal] ?? [];
            if (!allowed.includes(nextVal)) {
              violations.push(
                `Illegal state transition for '${transition.property}': cannot transition from '${prevVal}' to '${nextVal}'. Allowed: [${allowed.join(", ")}].`
              );
            }
          }
        }
      }

      if (violations.length > 0) {
        return yield* Effect.fail(
          new StructuralVerificationError({
            message: `VEDO formal invariant check failed for ${objectTypeId}.`,
            issues: violations,
          })
        );
      }
    });
  }
}
