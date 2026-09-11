import type { EntityTypology, RiskTier, Subject } from "@operon/schema";

export interface TelemetryConfig {
  readonly enabled?: boolean;
  readonly sentryDsn?: string;
  readonly sentryEnvironment?: string;
  readonly sentrySampleRate?: number;
  readonly posthogApiKey?: string;
  readonly posthogHost?: string;
  readonly release?: string;
  readonly scrubKeys?: readonly string[];
}

export interface ActionSubmittedPayload {
  readonly actionId: string;
  readonly riskTier: RiskTier;
  readonly agentTier?: number;
  readonly subjectId: string;
  readonly subjectType?: "user" | "agent" | "system";
  readonly executionMode: "automated" | "proposal";
  readonly correlationId: string;
}

export interface ActionExecutedPayload {
  readonly actionId: string;
  readonly decisionRecordId: string;
  readonly recordHash: string;
  readonly subjectId: string;
  readonly durationMs: number;
  readonly updatedObjectsCount: number;
}

export interface ProposalCreatedPayload {
  readonly proposalId: string;
  readonly actionId: string;
  readonly proposerId: string;
  readonly reason?: string;
  readonly evidenceHash: string;
}

export interface ProposalReviewedPayload {
  readonly proposalId: string;
  readonly actionId: string;
  readonly reviewerId: string;
  readonly reviewerRole: string;
  readonly verdict: "approved" | "rejected";
  readonly reviewDurationMs: number;
  readonly overrideCategory?: string;
  readonly overrideReason?: string;
}

export interface ReadinessEvaluatedPayload {
  readonly typeId: string;
  readonly typology?: EntityTypology;
  readonly id: string;
  readonly isReady: boolean;
  readonly c1CompletenessPassed: boolean;
  readonly c2CorrectnessPassed: boolean;
  readonly c3CurrentnessPassed: boolean;
  readonly c4ConsistencyPassed: boolean;
  readonly missingPropertiesCount: number;
  readonly violationsCount: number;
  readonly stalePropertiesCount: number;
}

export interface ModelExecutedPayload {
  readonly modelId: string;
  readonly version: string;
  readonly durationMs: number;
  readonly isDeterministic: boolean;
  readonly timedOut: boolean;
}

export interface McpToolInvokedPayload {
  readonly toolName: string;
  readonly clientId?: string;
  readonly success: boolean;
  readonly durationMs: number;
  readonly errorCode?: string;
}

export interface CliCommandPayload {
  readonly command: string;
  readonly exitCode: number;
  readonly durationMs: number;
}

export interface AgentPromotedPayload {
  readonly mandateId: string;
  readonly principalId: string;
  readonly previousTier: string;
  readonly newTier: string;
}

export interface AgentDemotedPayload {
  readonly mandateId: string;
  readonly principalId: string;
  readonly previousTier: string;
  readonly newTier: string;
  readonly reason: string;
  readonly violationsCount: number;
}

export interface PlanValidatedPayload {
  readonly isValid: boolean;
  readonly mandateId: string;
  readonly planId: string;
  readonly stepsCount: number;
  readonly violationsCount: number;
}

export interface MissionEvaluatedPayload {
  readonly allPredicatesSatisfied: boolean;
  readonly fictionalSuccessPrevented: boolean;
  readonly mandateId: string;
  readonly plannerReportedDone: boolean;
  readonly status: string;
}

export type OperonTelemetryEvent =
  | {
      readonly event: "operon_action_submitted";
      readonly properties: ActionSubmittedPayload;
      readonly subject?: Subject;
    }
  | {
      readonly event: "operon_action_executed";
      readonly properties: ActionExecutedPayload;
      readonly subject?: Subject;
    }
  | {
      readonly event: "operon_proposal_created";
      readonly properties: ProposalCreatedPayload;
      readonly subject?: Subject;
    }
  | {
      readonly event: "operon_proposal_reviewed";
      readonly properties: ProposalReviewedPayload;
      readonly subject?: Subject;
    }
  | {
      readonly event: "operon_readiness_evaluated";
      readonly properties: ReadinessEvaluatedPayload;
      readonly subject?: Subject;
    }
  | {
      readonly event: "operon_model_executed";
      readonly properties: ModelExecutedPayload;
      readonly subject?: Subject;
    }
  | {
      readonly event: "operon_mcp_tool_invoked";
      readonly properties: McpToolInvokedPayload;
      readonly subject?: Subject;
    }
  | {
      readonly event: "operon_cli_command";
      readonly properties: CliCommandPayload;
      readonly subject?: Subject;
    }
  | {
      readonly event: "operon_agent_promoted";
      readonly properties: AgentPromotedPayload;
      readonly subject?: Subject;
    }
  | {
      readonly event: "operon_agent_demoted";
      readonly properties: AgentDemotedPayload;
      readonly subject?: Subject;
    }
  | {
      readonly event: "operon_plan_validated";
      readonly properties: PlanValidatedPayload;
      readonly subject?: Subject;
    }
  | {
      readonly event: "operon_mission_evaluated";
      readonly properties: MissionEvaluatedPayload;
      readonly subject?: Subject;
    };
