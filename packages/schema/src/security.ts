import { Schema } from "effect";

export type SubjectType = "user" | "agent" | "system";

/**
 * 4-Tier Agent Authorization Ladder from Chapter 11
 */
export type AgentAuthorizationTier =
  | 1 // Observe: Read-only access
  | 2 // Propose: Creates proposal in Human Inbox
  | 3 // Execute with Approval: Agent is executor, Human confirms
  | 4; // Bounded Autonomy: Automatic execution within risk envelope

export interface Subject {
  readonly id: string;
  readonly type: SubjectType;
  readonly name: string;
  readonly roles: readonly string[];
  readonly agentTier?: AgentAuthorizationTier;
  readonly metadata?: Record<string, unknown>;
}

export const SubjectSchema = Schema.Struct({
  id: Schema.String,
  type: Schema.Literals(["user", "agent", "system"]),
  name: Schema.String,
  roles: Schema.Array(Schema.String),
  agentTier: Schema.optional(Schema.Literals([1, 2, 3, 4])),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});

/**
 * Canonical decision algebra per ADR-D05:
 * ALLOW | DENY | REVIEW_REQUIRED | EVIDENCE_INSUFFICIENT
 */
export type DecisionVerdict =
  | "allow"
  | "review"
  | "deny"
  | "review_required"
  | "evidence_insufficient";

export const DecisionVerdictSchema = Schema.Literals([
  "allow",
  "review",
  "deny",
  "review_required",
  "evidence_insufficient",
]);

export interface SecurityContext {
  readonly subject: Subject;
  readonly correlationId: string;
  readonly clientIp?: string;
  readonly timestamp: number;
}
