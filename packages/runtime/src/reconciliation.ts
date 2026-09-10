import { computeCanonicalDigest } from "@operon/schema";
import type {
  ExactQueryRequest,
  IdentityResolutionAction,
  IdentityResolutionProposal,
  ObjectInstance,
  ObjectTypeId,
  QueryCoverage,
  ResolutionReceipt,
  WorldView,
} from "@operon/schema";
import { Context, Effect } from "effect";

import type { BitemporalObjectStore } from "./bitemporal-store.js";
import { IdempotencyConflictError } from "./errors.js";
import type { ObjectStore } from "./object-store.js";
import type { AmbiguousIdentityError } from "./reconciliation-errors.js";
import {
  IdentityResolutionNotFoundError,
  StaleDependencyError,
} from "./reconciliation-errors.js";
import { SqlSchemaGenerator } from "./sql-store.js";

export interface CanonicalIdentityRecord {
  readonly canonicalId: string;
  readonly sourceKeys: Set<string>;
  readonly history: readonly {
    readonly action: IdentityResolutionAction;
    readonly decisionRef: string;
    readonly timestamp: number;
    readonly sourceKey: string;
  }[];
}

export interface ResolveIdentityOptions {
  readonly forceOverride?: boolean;
  readonly idempotencyKey?: string;
  readonly tenantId?: string;
  readonly environmentId?: string;
}

export interface QueryOptions {
  readonly maxStalenessMs?: number;
  readonly failOnStale?: boolean;
  readonly predicate?: (instance: ObjectInstance) => boolean;
}

export interface ReconciliationServiceConfig {
  readonly confidenceThreshold?: number; // default 0.85 per open fork decision
  readonly tenantId?: string;
  readonly environmentId?: string;
}

export interface ReconciliationSnapshot {
  readonly proposals: readonly IdentityResolutionProposal[];
  readonly receipts: readonly ResolutionReceipt[];
  readonly canonicalRegistry: readonly {
    readonly canonicalId: string;
    readonly sourceKeys: readonly string[];
    readonly history: readonly {
      readonly action: IdentityResolutionAction;
      readonly decisionRef: string;
      readonly timestamp: number;
      readonly sourceKey: string;
    }[];
  }[];
}

/**
 * ReconciliationService
 * Implements S03 (distinct evidence, claims, admitted state) and
 * S04 (exact bitemporal queries and independently checkable receipts).
 */
export class ReconciliationService {
  private readonly confidenceThreshold: number;
  private readonly defaultTenantId?: string;
  private readonly defaultEnvironmentId?: string;

  private readonly proposals = new Map<string, IdentityResolutionProposal>();
  private readonly receipts = new Map<string, ResolutionReceipt>();
  private readonly idempotency = new Map<
    string,
    { payloadDigest: string; receipt: ResolutionReceipt }
  >();
  private readonly canonicalRegistry = new Map<
    string,
    CanonicalIdentityRecord
  >();
  // Reverse lookup: sourceKey -> canonicalId
  private readonly sourceKeyToCanonical = new Map<string, string>();

  constructor(config?: ReconciliationServiceConfig) {
    this.confidenceThreshold = config?.confidenceThreshold ?? 0.85;
    this.defaultTenantId = config?.tenantId;
    this.defaultEnvironmentId = config?.environmentId;
  }

  static make(config?: ReconciliationServiceConfig): ReconciliationService {
    return new ReconciliationService(config);
  }

  /**
   * Propose an identity resolution (deterministic or language-model matching)
   */
  proposeIdentityResolution(
    proposal: Omit<
      IdentityResolutionProposal,
      "status" | "proposedAt" | "tenantId" | "environmentId" | "idempotencyKey"
    > & {
      readonly status?: IdentityResolutionProposal["status"];
      readonly proposedAt?: number;
      readonly tenantId?: string;
      readonly environmentId?: string;
      readonly idempotencyKey?: string | null;
    }
  ): Effect.Effect<IdentityResolutionProposal> {
    return Effect.sync(() => {
      const fullProposal: IdentityResolutionProposal = {
        action: proposal.action,
        confidence: proposal.confidence,
        environmentId:
          proposal.environmentId || this.defaultEnvironmentId || "default",
        evidence: proposal.evidence,
        idempotencyKey: proposal.idempotencyKey ?? null,
        proposalId: proposal.proposalId,
        proposedAt: proposal.proposedAt ?? Date.now(),
        sourceKey: proposal.sourceKey,
        sourceSystem: proposal.sourceSystem,
        splitDetails: proposal.splitDetails ?? null,
        status: proposal.status ?? "proposed",
        targetCanonicalId: proposal.targetCanonicalId,
        tenantId: proposal.tenantId || this.defaultTenantId || "default",
      };

      this.proposals.set(fullProposal.proposalId, fullProposal);
      return fullProposal;
    });
  }

  /**
   * Get an identity resolution proposal by ID with non-disclosure on tenant mismatch
   */
  getProposal(
    proposalId: string,
    tenantId?: string
  ): Effect.Effect<
    IdentityResolutionProposal,
    IdentityResolutionNotFoundError
  > {
    const proposal = this.proposals.get(proposalId);
    const expectedTenant = tenantId ?? this.defaultTenantId;
    if (!proposal || (expectedTenant && proposal.tenantId !== expectedTenant)) {
      return Effect.fail(
        new IdentityResolutionNotFoundError({
          proposalId,
        })
      );
    }
    return Effect.succeed(proposal);
  }

  /**
   * List proposals for tenant
   */
  listProposals(
    tenantId?: string
  ): Effect.Effect<readonly IdentityResolutionProposal[]> {
    const expectedTenant = tenantId ?? this.defaultTenantId;
    const all = [...this.proposals.values()];
    if (!expectedTenant) return Effect.succeed(all);
    return Effect.succeed(all.filter((p) => p.tenantId === expectedTenant));
  }

  /**
   * Resolve an identity proposal per S03.
   *
   * Invariants:
   * 1. Ambiguous identities stay unresolved (confidence < threshold without override).
   * 2. Merge/split correction preserves history.
   * 3. Splitting mistakenly merged identities invalidates affected projections.
   * 4. Idempotency replay vs conflict check.
   * 5. Tenant non-disclosure on mismatch.
   */
  resolveIdentity(
    proposalId: string,
    decisionRef: string,
    options?: ResolveIdentityOptions
  ): Effect.Effect<
    ResolutionReceipt,
    | IdentityResolutionNotFoundError
    | IdempotencyConflictError
    | AmbiguousIdentityError
  > {
    const {
      canonicalRegistry,
      confidenceThreshold,
      defaultTenantId,
      idempotency,
      proposals,
      receipts,
      sourceKeyToCanonical,
    } = this;
    return Effect.gen(function* () {
      const expectedTenant = options?.tenantId ?? defaultTenantId;
      const proposal = proposals.get(proposalId);

      // Non-disclosure of existence on tenant mismatch or not found
      if (
        !proposal ||
        (expectedTenant && proposal.tenantId !== expectedTenant)
      ) {
        return yield* Effect.fail(
          new IdentityResolutionNotFoundError({ proposalId })
        );
      }

      // Idempotency validation
      if (options?.idempotencyKey) {
        const payloadDigest = computeCanonicalDigest({
          decisionRef,
          forceOverride: options.forceOverride ?? false,
          proposalId,
        });
        const existing = idempotency.get(options.idempotencyKey);
        if (existing) {
          if (existing.payloadDigest === payloadDigest) {
            return existing.receipt;
          }
          return yield* Effect.fail(
            new IdempotencyConflictError({
              idempotencyKey: options.idempotencyKey,
              message: `Identity resolution conflict for proposal '${proposalId}' on idempotency key '${options.idempotencyKey}'`,
            })
          );
        }
      }

      const now = Date.now();
      const resolutionId = `res_${now}_${Math.random().toString(36).slice(2, 8)}`;

      // INVARIANT 1: Ambiguous identities stay unresolved unless explicit forceOverride is granted
      if (
        proposal.confidence < confidenceThreshold &&
        !options?.forceOverride
      ) {
        const ambiguousReceipt: ResolutionReceipt = {
          action: proposal.action,
          appliedAt: now,
          canonicalId: proposal.targetCanonicalId,
          decisionRef,
          historicalReferences: [],
          idempotencyKey: options?.idempotencyKey ?? null,
          invalidatedProjections: [],
          previousCanonicalId: null,
          proposalId,
          resolutionId,
          status: "unresolved_ambiguous",
        };

        const updatedProposal: IdentityResolutionProposal = {
          ...proposal,
          status: "unresolved_ambiguous",
        };
        proposals.set(proposalId, updatedProposal);
        receipts.set(resolutionId, ambiguousReceipt);

        if (options?.idempotencyKey) {
          const payloadDigest = computeCanonicalDigest({
            decisionRef,
            forceOverride: options.forceOverride ?? false,
            proposalId,
          });
          idempotency.set(options.idempotencyKey, {
            payloadDigest,
            receipt: ambiguousReceipt,
          });
        }

        return ambiguousReceipt;
      }

      // INVARIANT 2 & 3: Merge/split correction preserves history & invalidates projections
      const previousCanonicalId =
        sourceKeyToCanonical.get(proposal.sourceKey) ?? null;
      let historicalReferences: string[] = [];
      let invalidatedProjections: string[] = [];

      if (proposal.action === "merge" || proposal.action === "link") {
        const canonicalId = proposal.targetCanonicalId;
        const record = canonicalRegistry.get(canonicalId) ?? {
          canonicalId,
          history: [],
          sourceKeys: new Set<string>(),
        };

        const updatedHistory = [
          ...record.history,
          {
            action: proposal.action,
            decisionRef,
            sourceKey: proposal.sourceKey,
            timestamp: now,
          },
        ];

        record.sourceKeys.add(proposal.sourceKey);
        canonicalRegistry.set(canonicalId, {
          canonicalId,
          history: updatedHistory,
          sourceKeys: record.sourceKeys,
        });
        sourceKeyToCanonical.set(proposal.sourceKey, canonicalId);

        historicalReferences = [
          proposal.sourceKey,
          ...(previousCanonicalId ? [previousCanonicalId] : []),
          ...record.history.map(
            (h: {
              readonly action: IdentityResolutionAction;
              readonly decisionRef: string;
              readonly timestamp: number;
              readonly sourceKey: string;
            }) => `${h.action}:${h.sourceKey}@${h.timestamp}`
          ),
        ];

        invalidatedProjections = [
          `projection:${proposal.sourceSystem}:${proposal.sourceKey}`,
          `projection:canonical:${canonicalId}`,
        ];
      } else if (proposal.action === "split") {
        // Splitting two mistakenly merged entities per S03
        const canonicalId = proposal.targetCanonicalId;
        const record = canonicalRegistry.get(canonicalId);
        if (record) {
          record.sourceKeys.delete(proposal.sourceKey);
          const updatedHistory = [
            ...record.history,
            {
              action: "split" as const,
              decisionRef,
              sourceKey: proposal.sourceKey,
              timestamp: now,
            },
          ];
          canonicalRegistry.set(canonicalId, {
            ...record,
            history: updatedHistory,
          });
        }
        sourceKeyToCanonical.delete(proposal.sourceKey);

        const originalIds = proposal.splitDetails?.originalIds ?? [
          proposal.sourceKey,
        ];
        historicalReferences = [
          ...originalIds,
          ...(previousCanonicalId ? [previousCanonicalId] : []),
          `split_event:${proposalId}@${now}`,
        ];

        invalidatedProjections = [
          `projection:${proposal.sourceSystem}:${proposal.sourceKey}`,
          `projection:canonical:${canonicalId}`,
          `projection:split:${proposalId}`,
        ];
      }

      const receipt: ResolutionReceipt = {
        action: proposal.action,
        appliedAt: now,
        canonicalId: proposal.targetCanonicalId,
        decisionRef,
        historicalReferences,
        idempotencyKey: options?.idempotencyKey ?? null,
        invalidatedProjections,
        previousCanonicalId,
        proposalId,
        resolutionId,
        status: "resolved",
      };

      const updatedProposal: IdentityResolutionProposal = {
        ...proposal,
        status: "resolved",
      };
      proposals.set(proposalId, updatedProposal);
      receipts.set(resolutionId, receipt);

      if (options?.idempotencyKey) {
        const payloadDigest = computeCanonicalDigest({
          decisionRef,
          forceOverride: options.forceOverride ?? false,
          proposalId,
        });
        idempotency.set(options.idempotencyKey, {
          payloadDigest,
          receipt,
        });
      }

      return receipt;
    });
  }

  /**
   * Execute an exact bitemporal query under a WorldView per S04
   */
  query(
    request: ExactQueryRequest,
    objectStore: ObjectStore,
    options?: QueryOptions
  ): Effect.Effect<
    {
      readonly rows: readonly ObjectInstance[];
      readonly coverage: QueryCoverage;
      readonly worldView: WorldView;
      readonly cursor: string | null;
    },
    StaleDependencyError
  > {
    return Effect.gen(function* () {
      const { worldView, queryId, params } = request;

      // Freshness check: check if validTime is past max permitted staleness
      const maxStalenessMs =
        options?.maxStalenessMs ??
        (params.maxStalenessMs as number | undefined);
      const ageMs = Math.max(0, worldView.pinnedAt - worldView.validTime);

      let isStale = false;
      if (maxStalenessMs !== undefined && ageMs > maxStalenessMs) {
        isStale = true;
        if (options?.failOnStale) {
          return yield* Effect.fail(
            new StaleDependencyError({
              ageMs,
              dependencyId: queryId,
              maxStalenessMs,
              queryId,
            })
          );
        }
      }

      // Query from object store
      // If store is BitemporalObjectStore, use asOfValidTime
      const typeId = queryId as ObjectTypeId;
      let allObjects = yield* objectStore.findObjects(typeId);

      // Filter by asOfValidTime if store supports bitemporal timeline
      if (
        "asOfValidTime" in objectStore &&
        typeof (objectStore as any).asOfValidTime === "function"
      ) {
        const bitempStore = objectStore as BitemporalObjectStore;
        const validObjects: ObjectInstance[] = [];
        for (const obj of allObjects) {
          const matched = yield* bitempStore.asOfValidTime(
            typeId,
            obj.id,
            worldView.validTime
          );
          if (matched) {
            validObjects.push(matched);
          }
        }
        allObjects = validObjects;
      }

      // Apply predicate filter if provided
      if (options?.predicate) {
        allObjects = allObjects.filter(options.predicate);
      }

      // Apply parameter matching (e.g. key-value property matches)
      const paramKeys = Object.keys(params).filter(
        (k) => k !== "maxStalenessMs" && k !== "limit" && k !== "cursor"
      );
      if (paramKeys.length > 0) {
        allObjects = allObjects.filter((obj) => {
          const props = obj.properties as Record<string, unknown>;
          return paramKeys.every((k) => {
            if (k === "id") {
              return obj.id === params[k] || props[k] === params[k];
            }
            return props[k] === params[k];
          });
        });
      }

      const coverage: QueryCoverage = {
        completeness: isStale ? "stale" : "complete",
        evidenceDigests: worldView.evidenceCoverage,
        isStale,
        maxValidTime: worldView.validTime,
        minValidTime: worldView.validTime,
      };

      return {
        coverage,
        cursor: null,
        rows: allObjects,
        worldView,
      };
    });
  }

  /**
   * Explain a bitemporal point query (compiles plan without executing) per S04
   */
  explainQuery(
    typeId: string,
    id: string,
    validTime: number,
    txTime: number,
    dialect: "postgres" | "sqlite" = "sqlite"
  ): { readonly sql: string; readonly params: readonly unknown[] } {
    return SqlSchemaGenerator.compileBitemporalQuery(
      typeId,
      id,
      validTime,
      txTime,
      dialect
    );
  }

  /**
   * Export snapshot for state persistence and crash recovery
   */
  exportSnapshot(): ReconciliationSnapshot {
    return {
      canonicalRegistry: [...this.canonicalRegistry.values()].map((r) => ({
        canonicalId: r.canonicalId,
        history: r.history,
        sourceKeys: [...r.sourceKeys],
      })),
      proposals: [...this.proposals.values()],
      receipts: [...this.receipts.values()],
    };
  }

  /**
   * Import snapshot
   */
  importSnapshot(snapshot: ReconciliationSnapshot): void {
    this.proposals.clear();
    for (const p of snapshot.proposals) {
      this.proposals.set(p.proposalId, p);
    }
    this.receipts.clear();
    for (const r of snapshot.receipts) {
      this.receipts.set(r.resolutionId, r);
    }
    this.canonicalRegistry.clear();
    this.sourceKeyToCanonical.clear();
    for (const reg of snapshot.canonicalRegistry) {
      this.canonicalRegistry.set(reg.canonicalId, {
        canonicalId: reg.canonicalId,
        history: reg.history,
        sourceKeys: new Set(reg.sourceKeys),
      });
      for (const sk of reg.sourceKeys) {
        this.sourceKeyToCanonical.set(sk, reg.canonicalId);
      }
    }
  }
}

export class ReconciliationContextService extends Context.Service<
  ReconciliationContextService,
  ReconciliationService
>()("@operon/runtime/ReconciliationContextService") {}
