import { createHash } from "node:crypto";

import type { Subject } from "@operon/schema";
import { OperonTelemetryService } from "@operon/telemetry";
import { Effect } from "effect";

import type {
  AuditStore,
  DecisionRecord,
  OverrideCategory,
  OverrideRecord,
} from "./audit.js";
import { canonicalJson } from "./audit.js";
import {
  AuthorizationError,
  ProposalExecutionStateError,
  ProposalNotFoundError,
} from "./errors.js";
import type { StorageError } from "./errors.js";
import type { ObjectStore } from "./object-store.js";
import type { ActionSubmission } from "./write-pipeline.js";
import { executeWritePipeline } from "./write-pipeline.js";

export type ProposalStatus =
  | {
      readonly status: "pending";
      readonly claimedBy?: undefined;
      readonly claimedAt?: undefined;
    }
  | {
      readonly status: "claimed";
      readonly claimedBy: string;
      readonly claimedAt: number;
    }
  | {
      readonly status: "approved";
      readonly claimedBy?: string;
      readonly claimedAt?: number;
    }
  | {
      readonly status: "rejected";
      readonly claimedBy?: string;
      readonly claimedAt?: number;
    };

export type ActionProposalItem<Params = unknown> = {
  readonly id: string;
  readonly decisionRecord: DecisionRecord;
  readonly submission: ActionSubmission<Params>;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly proposerId: string;
  readonly evidenceHash: string;
} & ProposalStatus;

export class ActionInbox {
  private static readonly sharedProposals = new WeakMap<
    AuditStore,
    Map<string, ActionProposalItem<unknown>>
  >();

  private readonly auditStore: AuditStore;
  private readonly objectStore: ObjectStore;

  constructor(auditStore: AuditStore, objectStore: ObjectStore) {
    this.auditStore = auditStore;
    this.objectStore = objectStore;
    if (!ActionInbox.sharedProposals.has(auditStore)) {
      ActionInbox.sharedProposals.set(auditStore, new Map());
    }
  }

  private get proposals(): Map<string, ActionProposalItem<unknown>> {
    let map = ActionInbox.sharedProposals.get(this.auditStore);
    if (!map) {
      map = new Map();
      ActionInbox.sharedProposals.set(this.auditStore, map);
    }
    return map;
  }

  addProposal<Params = unknown>(
    submission: ActionSubmission<Params>,
    decisionRecord: DecisionRecord,
    ttlMs: number = 24 * 60 * 60 * 1000
  ): ActionProposalItem<Params> {
    const evidenceHash = createHash("sha256")
      .update(
        canonicalJson({
          actionTypeId: submission.actionType.id,
          decisionRecordId: decisionRecord.id,
          params: submission.rawParameters,
          recordHash: decisionRecord.recordHash,
        })
      )
      .digest("hex");

    const now = Date.now();
    const item: ActionProposalItem<Params> = {
      createdAt: now,
      decisionRecord,
      evidenceHash,
      expiresAt: now + ttlMs,
      id: decisionRecord.id,
      proposerId: submission.security.subject.id,
      status: "pending",
      submission,
    };
    this.proposals.set(item.id, item as ActionProposalItem<unknown>);
    return item;
  }

  getPendingProposals(): readonly ActionProposalItem<unknown>[] {
    return [...this.proposals.values()].filter((p) => p.status === "pending");
  }

  getProposal(proposalId: string): ActionProposalItem<unknown> | undefined {
    return this.proposals.get(proposalId);
  }

  /**
   * Human confirms / approves proposal with independent approver check, capability verification,
   * evidence hash integrity, and atomic claim locking.
   */
  approveProposal(
    proposalId: string,
    approverSubject: Subject,
    expectedEvidenceHash?: string
  ): Effect.Effect<DecisionRecord, unknown> {
    const proposal = this.proposals.get(proposalId);
    if (!proposal || proposal.status !== "pending") {
      return Effect.fail(
        new ProposalNotFoundError({
          message: `Proposal ${proposalId} not found or not pending (status: ${proposal?.status ?? "not_found"})`,
          proposalId,
        })
      );
    }

    // 1. Expiration check
    if (Date.now() > proposal.expiresAt) {
      this.proposals.set(proposalId, { ...proposal, status: "rejected" });
      return Effect.fail(
        new ProposalExecutionStateError({
          message: `Proposal ${proposalId} has expired`,
          proposalId,
        })
      );
    }

    // 2. Human Approver check: Must be a human operator, not an AI agent
    if (approverSubject.type === "agent") {
      return Effect.fail(
        new AuthorizationError({
          reason: `Approval requires an authenticated human operator, got agent '${approverSubject.id}'`,
        })
      );
    }

    // 3. Independence check: Proposer cannot self-approve
    if (approverSubject.id === proposal.proposerId) {
      return Effect.fail(
        new AuthorizationError({
          reason: `Independent review required: proposer '${proposal.proposerId}' cannot self-approve proposal`,
        })
      );
    }

    // 4. Role & Capability check (exact match to prevent substring matching like not-an-admin)
    const allowedRoles = new Set([
      "academic_adviser",
      "admin",
      "approver",
      "chief_engineer",
      "department_director",
      "director",
      "operator",
      "physician",
      "reviewer",
      "specialist",
    ]);
    const hasApproverRole = approverSubject.roles.some((r) =>
      allowedRoles.has(r.toLowerCase())
    );
    if (!hasApproverRole) {
      return Effect.fail(
        new AuthorizationError({
          reason: `Subject '${approverSubject.id}' lacks required approval capability`,
        })
      );
    }

    // 5. Evidence Hash Binding: verify that current proposal submission parameters match the original evidence hash
    const currentHash = createHash("sha256")
      .update(
        canonicalJson({
          actionTypeId: proposal.submission.actionType.id,
          decisionRecordId: proposal.decisionRecord.id,
          params: proposal.submission.rawParameters,
          recordHash: proposal.decisionRecord.recordHash,
        })
      )
      .digest("hex");

    if (
      currentHash !== proposal.evidenceHash ||
      (expectedEvidenceHash && expectedEvidenceHash !== proposal.evidenceHash)
    ) {
      return Effect.fail(
        new ProposalExecutionStateError({
          message:
            "Evidence hash mismatch: proposal parameters or context have drifted",
          proposalId,
        })
      );
    }

    // 6. Atomic Claim Lock: immediately mark claimed to prevent concurrent duplicate execution
    this.proposals.set(proposalId, {
      ...proposal,
      claimedAt: Date.now(),
      claimedBy: approverSubject.id,
      status: "claimed",
    });

    const elevatedSubmission: ActionSubmission = {
      ...proposal.submission,
      approvalToken: {
        approvedAt: Date.now(),
        approver: approverSubject,
        evidenceHash: proposal.evidenceHash,
        proposalId,
      },
      isApprovedProposal: true,
      kind: "approved_proposal",
      security: {
        ...proposal.submission.security,
        subject: approverSubject,
        timestamp: Date.now(),
      },
    };

    return executeWritePipeline(
      elevatedSubmission,
      this.objectStore,
      this.auditStore
    ).pipe(
      Effect.flatMap((result) => {
        if (result.status === "executed") {
          this.proposals.set(proposalId, { ...proposal, status: "approved" });
          OperonTelemetryService.getInstance().trackEvent({
            event: "operon_proposal_reviewed",
            properties: {
              actionId: proposal.submission.actionType.id,
              proposalId,
              reviewDurationMs: Date.now() - proposal.createdAt,
              reviewerId: approverSubject.id,
              reviewerRole: approverSubject.roles[0] ?? "reviewer",
              verdict: "approved",
            },
            subject: approverSubject,
          });
          return Effect.succeed(result.decisionRecord);
        }
        this.proposals.set(proposalId, { ...proposal, status: "pending" });
        return Effect.fail(
          new ProposalExecutionStateError({
            message: "Approved execution did not resolve to executed state",
            proposalId,
          })
        );
      }),
      Effect.tapError(() =>
        Effect.sync(() => {
          this.proposals.set(proposalId, { ...proposal, status: "pending" });
        })
      )
    );
  }

  /**
   * Human exercises veto / rejects proposal with structured reason (First-Class Override)
   */
  rejectProposal(
    proposalId: string,
    humanSubject: Subject,
    category: OverrideCategory,
    structuredReason: string
  ): Effect.Effect<
    OverrideRecord,
    ProposalNotFoundError | AuthorizationError | StorageError
  > {
    const proposal = this.proposals.get(proposalId);
    if (!proposal || proposal.status !== "pending") {
      return Effect.fail(
        new ProposalNotFoundError({
          message: `Proposal ${proposalId} not found or not pending`,
          proposalId,
        })
      );
    }

    if (humanSubject.type === "agent") {
      return Effect.fail(
        new AuthorizationError({
          reason: "Proposal veto/override requires a human operator",
        })
      );
    }

    const overrideRecord: OverrideRecord = {
      decisionRecordId: proposal.decisionRecord.id,
      finalDecision: { action: "veto", status: "rejected" },
      humanSubject,
      id: `override_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      originalProposal: proposal.decisionRecord.parameters,
      reasonCategory: category,
      structuredReason,
      timestamp: Date.now(),
    };

    return this.auditStore.appendOverride(overrideRecord).pipe(
      Effect.as(overrideRecord),
      Effect.tap(() =>
        Effect.sync(() => {
          this.proposals.set(proposalId, { ...proposal, status: "rejected" });
          OperonTelemetryService.getInstance().trackEvent({
            event: "operon_proposal_reviewed",
            properties: {
              actionId: proposal.submission.actionType.id,
              overrideCategory: category,
              overrideReason: structuredReason,
              proposalId,
              reviewDurationMs: Date.now() - proposal.createdAt,
              reviewerId: humanSubject.id,
              reviewerRole: humanSubject.roles[0] ?? "reviewer",
              verdict: "rejected",
            },
            subject: humanSubject,
          });
        })
      )
    );
  }
}
