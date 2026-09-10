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

export type DecisionVerdict = "allow" | "review" | "deny";

export interface SecurityContext {
  readonly subject: Subject;
  readonly correlationId: string;
  readonly clientIp?: string;
  readonly timestamp: number;
}
