import { Schema } from "effect";

/**
 * Five unambiguous lifecycle states for generated application surfaces (S13 / OPR-FULL-035)
 */
export const SurfaceLifecycleState = Schema.Literals([
  "ACCEPTED",
  "PROPOSED",
  "RUNNING",
  "CONFIRMED",
  "HYPOTHETICAL",
]);
export type SurfaceLifecycleState = Schema.Schema.Type<
  typeof SurfaceLifecycleState
>;

/**
 * Component typology for generated application surfaces
 */
export const SurfaceComponentType = Schema.Literals([
  "CARD",
  "TABLE",
  "DECISION_CANVAS",
  "ACTION_BAR",
  "TIMELINE",
  "EVIDENCE_DRAWER",
]);
export type SurfaceComponentType = Schema.Schema.Type<
  typeof SurfaceComponentType
>;

/**
 * Accessible focus node for keyboard navigation and screen-reader accessibility (OPR-UX-003, OPR-FULL-037)
 */
export const AccessibleFocusNode = Schema.Struct({
  ariaLabel: Schema.String,
  ariaRole: Schema.String,
  focusId: Schema.String,
  keyboardShortcut: Schema.optional(Schema.String),
  tabIndex: Schema.Number,
});
export type AccessibleFocusNode = Schema.Schema.Type<
  typeof AccessibleFocusNode
>;

/**
 * Declarative component on a generated surface
 */
export const SurfaceComponent = Schema.Struct({
  activeValue: Schema.optional(Schema.Unknown),
  componentId: Schema.String,
  focusNode: Schema.optional(AccessibleFocusNode),
  proposedValue: Schema.optional(Schema.Unknown),
  renderedMarkup: Schema.String,
  state: SurfaceLifecycleState,
  title: Schema.String,
  type: SurfaceComponentType,
});
export type SurfaceComponent = Schema.Schema.Type<typeof SurfaceComponent>;

/**
 * Eight stages of evidence and decision deliverables (OPR-ORG-001)
 */
export const DecisionCanvasStage = Schema.Literals([
  "DISCOVERY",
  "INVENTORY",
  "MINIMAL_MODEL",
  "LOGIC",
  "ACTION",
  "SECURITY",
  "PILOT",
  "OPERATION",
]);
export type DecisionCanvasStage = Schema.Schema.Type<
  typeof DecisionCanvasStage
>;

/**
 * Decision Canvas tracking decision owner, alternatives, evidence R(d), rules, and deliverables (OPR-ORG-001)
 */
export const DecisionCanvasRecord = Schema.Struct({
  alternatives: Schema.Array(Schema.String),
  applicableRules: Schema.Array(Schema.String),
  canvasId: Schema.String,
  decisionOwner: Schema.String,
  decisionTitle: Schema.String,
  deliverablesStatus: Schema.Record(Schema.String, Schema.Boolean),
  evidenceReferences: Schema.Array(Schema.String),
  proposedActions: Schema.Array(Schema.String),
  sourceSystems: Schema.Array(Schema.String),
  stage: DecisionCanvasStage,
});
export type DecisionCanvasRecord = Schema.Schema.Type<
  typeof DecisionCanvasRecord
>;

/**
 * Audience membership status for rooms and protected collaboration groups (OPR-FULL-038)
 */
export const AudienceMembershipStatus = Schema.Literals(["ACTIVE", "REVOKED"]);
export type AudienceMembershipStatus = Schema.Schema.Type<
  typeof AudienceMembershipStatus
>;

/**
 * Room and protected collaboration group audience record (OPR-FULL-038)
 */
export const RoomAudienceMembership = Schema.Struct({
  joinedAt: Schema.Number,
  membershipId: Schema.String,
  revokedAt: Schema.optional(Schema.Number),
  role: Schema.String,
  roomId: Schema.String,
  status: AudienceMembershipStatus,
  userId: Schema.String,
});
export type RoomAudienceMembership = Schema.Schema.Type<
  typeof RoomAudienceMembership
>;

/**
 * Operational metrics derived from recorded proposal, override, and execution events (OPR-ORG-003)
 */
export const OperationalMetricsRecord = Schema.Struct({
  acceptedProposals: Schema.Number,
  averageCycleTimeMs: Schema.Number,
  calculatedAt: Schema.Number,
  overrideRate: Schema.Number,
  readinessRatio: Schema.Number,
  rejectedOverrides: Schema.Number,
  totalProposals: Schema.Number,
});
export type OperationalMetricsRecord = Schema.Schema.Type<
  typeof OperationalMetricsRecord
>;
