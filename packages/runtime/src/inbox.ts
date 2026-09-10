import { createHash } from "node:crypto";

import type { ActionType, Subject } from "@operon/schema";
import { computeEffectDigest } from "@operon/schema";
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

export type ProposalStatusKind =
  | "pending"
  | "claimed"
  | "approved"
  | "rejected"
  | "expired";

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
    }
  | {
      readonly status: "expired";
      readonly claimedBy?: undefined;
      readonly claimedAt?: undefined;
    };

export type ActionProposalItem<Params = unknown> = {
  readonly id: string;
  readonly decisionRecord: DecisionRecord;
  readonly submission: ActionSubmission<Params>;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly proposerId: string;
  readonly tenantId?: string;
  readonly actionRelease: string;
  readonly policyRelease: string;
  readonly evidenceHash: string;
  readonly effectDigest: string;
  readonly proposalDigest: string;
} & ProposalStatus;

export interface ApprovalReceipt {
  readonly id: string;
  readonly proposalId: string;
  readonly expectedDigest: string;
  readonly effectDigest: string;
  readonly proposalDigest: string;
  readonly evidenceHash: string;
  readonly decision: "approved" | "rejected";
  readonly approver: Subject;
  readonly actionRelease: string;
  readonly policyRelease: string;
  readonly approvedAt: number;
  readonly expiresAt: number;
  readonly decisionRecord: DecisionRecord;
  readonly receiptHash: string;
}

export interface PrepareProposalIntent<Params = unknown> {
  readonly actionType: ActionType<Params>;
  readonly parameters: Params;
  readonly proposer: Subject;
  readonly correlationId?: string;
  readonly ttlMs?: number;
}

export interface InboxFilterOptions {
  readonly status?:
    | "pending"
    | "claimed"
    | "approved"
    | "rejected"
    | "expired"
    | "all";
  readonly proposerId?: string;
  readonly actionTypeId?: string;
  readonly tenantId?: string;
  readonly sortBy?: "createdAt" | "expiresAt" | "id";
  readonly sortDirection?: "asc" | "desc";
  readonly limit?: number;
  readonly offset?: number;
}

export interface ActionInboxSnapshot {
  readonly proposals: readonly ActionProposalItem<unknown>[];
  readonly receipts: readonly ApprovalReceipt[];
}

export class ActionInbox {
  private static readonly sharedProposals = new WeakMap<
    AuditStore,
    Map<string, ActionProposalItem<unknown>>
  >();

  private static readonly sharedReceipts = new WeakMap<
    AuditStore,
    Map<string, ApprovalReceipt>
  >();

  private readonly auditStore: AuditStore;
  private readonly objectStore: ObjectStore;

  constructor(auditStore: AuditStore, objectStore: ObjectStore) {
    this.auditStore = auditStore;
    this.objectStore = objectStore;
    if (!ActionInbox.sharedProposals.has(auditStore)) {
      ActionInbox.sharedProposals.set(auditStore, new Map());
    }
    if (!ActionInbox.sharedReceipts.has(auditStore)) {
      ActionInbox.sharedReceipts.set(auditStore, new Map());
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

  private get receipts(): Map<string, ApprovalReceipt> {
    let map = ActionInbox.sharedReceipts.get(this.auditStore);
    if (!map) {
      map = new Map();
      ActionInbox.sharedReceipts.set(this.auditStore, map);
    }
    return map;
  }

  addProposal<Params = unknown>(
    submission: ActionSubmission<Params>,
    decisionRecord: DecisionRecord,
    ttlMs?: number
  ): ActionProposalItem<Params> {
    const rawParams = (submission.rawParameters ?? {}) as Record<
      string,
      unknown
    >;
    const actionId = submission.actionType.id;
    const actionRelease = "1.0.0";
    const policyRelease = "1.0.0";

    const effectDigest = computeEffectDigest({
      actionId,
      normalizedParameters: rawParams,
      requestedEffects: (submission.actionType.sideEffects ?? []).map((se) => ({
        description: se.description,
        effectId: se.id,
        isLiveExternal: true,
      })),
    });

    const evidenceHash = createHash("sha256")
      .update(
        canonicalJson({
          actionTypeId: actionId,
          decisionRecordId: decisionRecord.id,
          params: submission.rawParameters,
          recordHash: decisionRecord.recordHash,
        })
      )
      .digest("hex");

    const defaultTtlMs = process.env.OPERON_ACTION_TTL_SECONDS
      ? Number(process.env.OPERON_ACTION_TTL_SECONDS) * 1000
      : 24 * 60 * 60 * 1000;
    const effectiveTtlMs = ttlMs ?? defaultTtlMs;

    const now = Date.now();
    const expiresAt = now + effectiveTtlMs;
    const proposerId = submission.security.subject.id;
    const tenantId = (submission.security.subject as any).tenantId;

    const proposalDigest = createHash("sha256")
      .update(
        canonicalJson({
          actionId,
          actionRelease,
          effectDigest,
          evidenceHash,
          expiresAt,
          id: decisionRecord.id,
          policyRelease,
          proposerId,
          tenantId: tenantId ?? "",
        })
      )
      .digest("hex");

    const item: ActionProposalItem<Params> = {
      actionRelease,
      createdAt: now,
      decisionRecord,
      effectDigest,
      evidenceHash,
      expiresAt,
      id: decisionRecord.id,
      policyRelease,
      proposalDigest,
      proposerId,
      status: "pending",
      submission,
      tenantId,
    };
    this.proposals.set(item.id, item as ActionProposalItem<unknown>);
    return item;
  }

  prepare<Params = unknown>(
    intent: PrepareProposalIntent<Params>
  ): Effect.Effect<ActionProposalItem<Params>, unknown> {
    const submission: ActionSubmission<Params> = {
      actionType: intent.actionType,
      rawParameters: intent.parameters,
      security: {
        correlationId:
          intent.correlationId ??
          `corr_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        subject: intent.proposer,
        timestamp: Date.now(),
      },
    };

    return executeWritePipeline(
      submission,
      this.objectStore,
      this.auditStore
    ).pipe(
      Effect.map((res) =>
        this.addProposal(submission, res.decisionRecord, intent.ttlMs)
      )
    );
  }

  listProposals(
    options: InboxFilterOptions = {}
  ): readonly ActionProposalItem<unknown>[] {
    const now = Date.now();
    for (const [id, p] of this.proposals) {
      if (p.status === "pending" && now > p.expiresAt) {
        this.proposals.set(id, { ...p, status: "expired" });
      }
    }

    let items = [...this.proposals.values()];

    const targetStatus = options.status ?? "all";
    if (targetStatus !== "all") {
      items = items.filter((p) => p.status === targetStatus);
    }

    if (options.proposerId) {
      items = items.filter((p) => p.proposerId === options.proposerId);
    }

    if (options.actionTypeId) {
      items = items.filter(
        (p) => p.submission.actionType.id === options.actionTypeId
      );
    }

    if (options.tenantId) {
      items = items.filter((p) => p.tenantId === options.tenantId);
    }

    const sortBy = options.sortBy ?? "createdAt";
    const dir = options.sortDirection === "desc" ? -1 : 1;
    items.sort((a, b) => {
      let cmp = 0;
      if (sortBy === "createdAt") {
        cmp = a.createdAt - b.createdAt;
      } else if (sortBy === "expiresAt") {
        cmp = a.expiresAt - b.expiresAt;
      } else if (sortBy === "id") {
        cmp = a.id.localeCompare(b.id);
      }
      if (cmp !== 0) return cmp * dir;
      return a.id.localeCompare(b.id);
    });

    const offset = options.offset ?? 0;
    if (offset > 0) {
      items = items.slice(offset);
    }
    if (options.limit !== undefined && options.limit >= 0) {
      items = items.slice(0, options.limit);
    }

    return items;
  }

  getPendingProposals(): readonly ActionProposalItem<unknown>[] {
    return this.listProposals({
      sortBy: "createdAt",
      sortDirection: "asc",
      status: "pending",
    });
  }

  getProposal(proposalId: string): ActionProposalItem<unknown> | undefined {
    const proposal = this.proposals.get(proposalId);
    if (
      proposal &&
      proposal.status === "pending" &&
      Date.now() > proposal.expiresAt
    ) {
      const expired: ActionProposalItem<unknown> = {
        ...proposal,
        status: "expired",
      };
      this.proposals.set(proposalId, expired);
      return expired;
    }
    return proposal;
  }

  /**
   * Approve proposal and produce an immutable, durable ApprovalReceipt (S07 / V1-04)
   * Binds exact normalized proposal, release, evidence, and effect digest.
   */
  approve(
    proposalId: string,
    expectedDigest: string,
    principal: Subject
  ): Effect.Effect<ApprovalReceipt, unknown> {
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
      this.proposals.set(proposalId, { ...proposal, status: "expired" });
      return Effect.fail(
        new ProposalExecutionStateError({
          message: `Proposal ${proposalId} has expired`,
          proposalId,
        })
      );
    }

    // 2. Human Approver check: Must be a human operator, not an AI agent
    if (principal.type === "agent") {
      return Effect.fail(
        new AuthorizationError({
          reason: `Approval requires an authenticated human operator, got agent '${principal.id}'`,
        })
      );
    }

    // 3. Independence check: Proposer cannot self-approve
    if (principal.id === proposal.proposerId) {
      return Effect.fail(
        new AuthorizationError({
          reason: `Independent review required: proposer '${proposal.proposerId}' cannot self-approve proposal`,
        })
      );
    }

    // 4. Role & Capability check
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
    const hasApproverRole = principal.roles.some((r) =>
      allowedRoles.has(r.toLowerCase())
    );
    if (!hasApproverRole) {
      return Effect.fail(
        new AuthorizationError({
          reason: `Subject '${principal.id}' lacks required approval capability`,
        })
      );
    }

    // 5. Evidence & Effect Hash Binding: verify that current proposal parameters match original hashes
    const currentEffectDigest = computeEffectDigest({
      actionId: proposal.submission.actionType.id,
      normalizedParameters: (proposal.submission.rawParameters ?? {}) as Record<
        string,
        unknown
      >,
      requestedEffects: (proposal.submission.actionType.sideEffects ?? []).map(
        (se) => ({
          description: se.description,
          effectId: se.id,
          isLiveExternal: true,
        })
      ),
    });

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
      currentEffectDigest !== proposal.effectDigest
    ) {
      return Effect.fail(
        new ProposalExecutionStateError({
          message:
            "Evidence hash mismatch: proposal parameters or context have drifted",
          proposalId,
        })
      );
    }

    const matchesExpected =
      expectedDigest === proposal.effectDigest ||
      expectedDigest === proposal.proposalDigest ||
      expectedDigest === proposal.evidenceHash;

    if (!matchesExpected) {
      return Effect.fail(
        new ProposalExecutionStateError({
          message: `Evidence hash mismatch: expected digest '${expectedDigest}' does not match proposal digest '${proposal.effectDigest}'`,
          proposalId,
        })
      );
    }

    // 6. Atomic Claim Lock: immediately mark claimed to prevent concurrent duplicate execution
    this.proposals.set(proposalId, {
      ...proposal,
      claimedAt: Date.now(),
      claimedBy: principal.id,
      status: "claimed",
    });

    const elevatedSubmission: ActionSubmission = {
      ...proposal.submission,
      approvalToken: {
        approvedAt: Date.now(),
        approver: principal,
        evidenceHash: proposal.evidenceHash,
        proposalId,
      },
      isApprovedProposal: true,
      kind: "approved_proposal",
      security: {
        ...proposal.submission.security,
        subject: principal,
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
          const approvedAt = Date.now();
          this.proposals.set(proposalId, {
            ...proposal,
            claimedAt: proposal.claimedAt ?? approvedAt,
            claimedBy: principal.id,
            status: "approved",
          });

          const receiptId = `rcpt_${approvedAt}_${Math.random().toString(36).slice(2, 7)}`;
          const receiptWithoutHash = {
            actionRelease: proposal.actionRelease,
            approvedAt,
            approver: principal,
            decision: "approved" as const,
            decisionRecord: result.decisionRecord,
            effectDigest: proposal.effectDigest,
            evidenceHash: proposal.evidenceHash,
            expectedDigest,
            expiresAt: proposal.expiresAt,
            id: receiptId,
            policyRelease: proposal.policyRelease,
            proposalDigest: proposal.proposalDigest,
            proposalId,
          };
          const receiptHash = createHash("sha256")
            .update(
              canonicalJson({
                actionRelease: receiptWithoutHash.actionRelease,
                approvedAt: receiptWithoutHash.approvedAt,
                approverId: principal.id,
                decision: receiptWithoutHash.decision,
                decisionRecordHash: result.decisionRecord.recordHash,
                effectDigest: receiptWithoutHash.effectDigest,
                evidenceHash: receiptWithoutHash.evidenceHash,
                expectedDigest: receiptWithoutHash.expectedDigest,
                id: receiptId,
                policyRelease: receiptWithoutHash.policyRelease,
                proposalDigest: receiptWithoutHash.proposalDigest,
                proposalId,
              })
            )
            .digest("hex");

          const receipt: ApprovalReceipt = {
            ...receiptWithoutHash,
            receiptHash,
          };
          this.receipts.set(receipt.id, receipt);

          OperonTelemetryService.getInstance().trackEvent({
            event: "operon_proposal_reviewed",
            properties: {
              actionId: proposal.submission.actionType.id,
              proposalId,
              reviewDurationMs: approvedAt - proposal.createdAt,
              reviewerId: principal.id,
              reviewerRole: principal.roles[0] ?? "reviewer",
              verdict: "approved",
            },
            subject: principal,
          });
          return Effect.succeed(receipt);
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
   * Human confirms / approves proposal with independent approver check, capability verification,
   * evidence hash integrity, and atomic claim locking.
   * Returns the committed DecisionRecord.
   */
  approveProposal(
    proposalId: string,
    approverSubject: Subject,
    expectedEvidenceHash?: string
  ): Effect.Effect<DecisionRecord, unknown> {
    const proposal = this.proposals.get(proposalId);
    const digest =
      expectedEvidenceHash ??
      proposal?.effectDigest ??
      proposal?.evidenceHash ??
      "";
    return this.approve(proposalId, digest, approverSubject).pipe(
      Effect.map((receipt) => receipt.decisionRecord)
    );
  }

  getApprovalReceipt(receiptId: string): ApprovalReceipt | undefined {
    return this.receipts.get(receiptId);
  }

  getApprovalReceiptForProposal(
    proposalId: string
  ): ApprovalReceipt | undefined {
    for (const r of this.receipts.values()) {
      if (r.proposalId === proposalId) return r;
    }
    return undefined;
  }

  listApprovalReceipts(): readonly ApprovalReceipt[] {
    return [...this.receipts.values()];
  }

  exportSnapshot(): ActionInboxSnapshot {
    return {
      proposals: [...this.proposals.values()],
      receipts: [...this.receipts.values()],
    };
  }

  importSnapshot(snapshot: ActionInboxSnapshot): void {
    this.proposals.clear();
    this.receipts.clear();
    for (const p of snapshot.proposals) {
      this.proposals.set(p.id, p);
    }
    for (const r of snapshot.receipts) {
      this.receipts.set(r.id, r);
    }
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
