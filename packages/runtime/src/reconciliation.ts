import {
  computeCanonicalDigest,
  generatePrefixedId,
  identityKeyString,
} from "@operon/schema";
import type {
  ExactQueryRequest,
  IdentityKey,
  IdentityResolutionAction,
  IdentityResolutionProposal,
  ObjectInstance,
  ObjectTypeId,
  QueryCoverage,
  ResolutionReceipt,
} from "@operon/schema";
import { Clock, Context, Effect } from "effect";

import type { BitemporalObjectStore } from "./bitemporal-store.js";
import { IdempotencyConflictError } from "./errors.js";
import type { ObjectStore } from "./object-store.js";
import {
  IdentityResolutionNotFoundError,
  StaleDependencyError,
} from "./reconciliation-errors.js";
import type { BitemporalQueryOptions } from "./sql-store.js";
import { SqlSchemaGenerator } from "./sql-store.js";

export interface IdentityHistoryEntry {
  readonly action: IdentityResolutionAction;
  readonly decisionRef: string;
  readonly timestamp: number;
  readonly key: IdentityKey;
}

export interface CanonicalIdentityRecord {
  readonly canonicalId: string;
  /** Canonical strings (`identityKeyString`) of every key resolved to this id. */
  readonly identityKeys: Set<string>;
  readonly history: readonly IdentityHistoryEntry[];
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
    readonly identityKeys: readonly string[];
    readonly history: readonly IdentityHistoryEntry[];
  }[];
}

interface ResolutionState {
  readonly canonicalRegistry: Map<string, CanonicalIdentityRecord>;
  readonly idempotency: Map<
    string,
    { readonly payloadDigest: string; readonly receipt: ResolutionReceipt }
  >;
  readonly proposals: Map<string, IdentityResolutionProposal>;
  readonly receipts: Map<string, ResolutionReceipt>;
  readonly keyToCanonical: Map<string, string>;
}

function checkIdempotencyResolution(
  idempotency: Map<
    string,
    { readonly payloadDigest: string; readonly receipt: ResolutionReceipt }
  >,
  proposalId: string,
  decisionRef: string,
  options?: ResolveIdentityOptions
): Effect.Effect<ResolutionReceipt | null, IdempotencyConflictError> {
  if (!options?.idempotencyKey) {
    return Effect.succeed(null);
  }
  const payloadDigest = computeCanonicalDigest({
    decisionRef,
    forceOverride: options.forceOverride ?? false,
    proposalId,
  });
  const existing = idempotency.get(options.idempotencyKey);
  if (!existing) {
    return Effect.succeed(null);
  }
  if (existing.payloadDigest === payloadDigest) {
    return Effect.succeed(existing.receipt);
  }
  return new IdempotencyConflictError({
    idempotencyKey: options.idempotencyKey,
    message: `Identity resolution conflict for proposal '${proposalId}' on idempotency key '${options.idempotencyKey}'`,
  });
}

interface RecordAmbiguousOptions {
  readonly proposal: IdentityResolutionProposal;
  readonly proposalId: string;
  readonly decisionRef: string;
  readonly now: number;
  readonly resolutionId: string;
  readonly options?: ResolveIdentityOptions;
}

function recordAmbiguousResolution(
  params: RecordAmbiguousOptions,
  state: ResolutionState
): ResolutionReceipt {
  const { proposal, proposalId, decisionRef, now, resolutionId, options } =
    params;
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

  state.proposals.set(proposalId, {
    ...proposal,
    status: "unresolved_ambiguous",
  });
  state.receipts.set(resolutionId, ambiguousReceipt);

  if (options?.idempotencyKey) {
    const payloadDigest = computeCanonicalDigest({
      decisionRef,
      forceOverride: options.forceOverride ?? false,
      proposalId,
    });
    state.idempotency.set(options.idempotencyKey, {
      payloadDigest,
      receipt: ambiguousReceipt,
    });
  }

  return ambiguousReceipt;
}

interface ApplyResolutionHistoryParams {
  readonly proposal: IdentityResolutionProposal;
  readonly proposalId: string;
  readonly decisionRef: string;
  readonly now: number;
}

function applyMergeHistory(
  params: ApplyResolutionHistoryParams,
  state: ResolutionState
): { historicalReferences: string[]; invalidatedProjections: string[] } {
  const { canonicalRegistry, keyToCanonical } = state;
  const { proposal, decisionRef, now } = params;
  const canonicalId = proposal.targetCanonicalId;
  const keyString = identityKeyString(proposal.key);
  const previousCanonicalId = keyToCanonical.get(keyString) ?? null;
  const record = canonicalRegistry.get(canonicalId) ?? {
    canonicalId,
    history: [],
    identityKeys: new Set<string>(),
  };

  const updatedHistory: IdentityHistoryEntry[] = [
    ...record.history,
    {
      action: proposal.action,
      decisionRef,
      key: proposal.key,
      timestamp: now,
    },
  ];

  record.identityKeys.add(keyString);
  canonicalRegistry.set(canonicalId, {
    canonicalId,
    history: updatedHistory,
    identityKeys: record.identityKeys,
  });
  keyToCanonical.set(keyString, canonicalId);

  const historicalReferences = [
    keyString,
    ...(previousCanonicalId ? [previousCanonicalId] : []),
    ...record.history.map(
      (h) => `${h.action}:${identityKeyString(h.key)}@${h.timestamp}`
    ),
  ];

  const invalidatedProjections = [
    `projection:${keyString}`,
    `projection:canonical:${canonicalId}`,
  ];

  return { historicalReferences, invalidatedProjections };
}

function applySplitHistory(
  params: ApplyResolutionHistoryParams,
  state: ResolutionState
): { historicalReferences: string[]; invalidatedProjections: string[] } {
  const { canonicalRegistry, keyToCanonical } = state;
  const { proposal, proposalId, decisionRef, now } = params;
  const canonicalId = proposal.targetCanonicalId;
  const keyString = identityKeyString(proposal.key);
  const previousCanonicalId = keyToCanonical.get(keyString) ?? null;
  const record = canonicalRegistry.get(canonicalId);
  if (record) {
    record.identityKeys.delete(keyString);
    const updatedHistory: IdentityHistoryEntry[] = [
      ...record.history,
      {
        action: "split",
        decisionRef,
        key: proposal.key,
        timestamp: now,
      },
    ];
    canonicalRegistry.set(canonicalId, {
      ...record,
      history: updatedHistory,
    });
  }
  keyToCanonical.delete(keyString);

  const originalIds = proposal.splitDetails?.originalIds ?? [keyString];
  const historicalReferences = [
    ...originalIds,
    ...(previousCanonicalId ? [previousCanonicalId] : []),
    `split_event:${proposalId}@${now}`,
  ];

  const invalidatedProjections = [
    `projection:${keyString}`,
    `projection:canonical:${canonicalId}`,
    `projection:split:${proposalId}`,
  ];

  return { historicalReferences, invalidatedProjections };
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
  // Reverse lookup: identityKeyString(key) -> canonicalId
  private readonly keyToCanonical = new Map<string, string>();

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
  proposeIdentityResolution = Effect.fn(
    "ReconciliationService.proposeIdentityResolution"
  )(function* (
    this: ReconciliationService,
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
  ): Effect.fn.Return<IdentityResolutionProposal, never> {
    const now = yield* Clock.currentTimeMillis;
    const fullProposal: IdentityResolutionProposal = {
      action: proposal.action,
      confidence: proposal.confidence,
      environmentId:
        proposal.environmentId || this.defaultEnvironmentId || "default",
      evidence: proposal.evidence,
      idempotencyKey: proposal.idempotencyKey ?? null,
      proposalId: proposal.proposalId,
      key: proposal.key,
      proposedAt: proposal.proposedAt ?? now,
      splitDetails: proposal.splitDetails ?? null,
      status: proposal.status ?? "proposed",
      targetCanonicalId: proposal.targetCanonicalId,
      tenantId: proposal.tenantId || this.defaultTenantId || "default",
    };

    this.proposals.set(fullProposal.proposalId, fullProposal);
    return fullProposal;
  });

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
    if (!expectedTenant) {
      return Effect.succeed(all);
    }
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
  resolveIdentity = Effect.fn("ReconciliationService.resolveIdentity")(
    function* (
      this: ReconciliationService,
      proposalId: string,
      decisionRef: string,
      options?: ResolveIdentityOptions
    ) {
      const {
        canonicalRegistry,
        confidenceThreshold,
        defaultTenantId,
        idempotency,
        proposals,
        receipts,
        keyToCanonical,
      } = this;

      const state: ResolutionState = {
        canonicalRegistry,
        idempotency,
        keyToCanonical,
        proposals,
        receipts,
      };

      const expectedTenant = options?.tenantId ?? defaultTenantId;
      const proposal = proposals.get(proposalId);

      // Non-disclosure of existence on tenant mismatch or not found
      if (
        !proposal ||
        (expectedTenant && proposal.tenantId !== expectedTenant)
      ) {
        return yield* new IdentityResolutionNotFoundError({ proposalId });
      }

      // Idempotency validation
      const existingReceipt = yield* checkIdempotencyResolution(
        idempotency,
        proposalId,
        decisionRef,
        options
      );
      if (existingReceipt) {
        return existingReceipt;
      }

      const now = yield* Clock.currentTimeMillis;
      const resolutionId = generatePrefixedId("res", now);

      // INVARIANT 1: Ambiguous identities stay unresolved unless explicit forceOverride is granted
      if (
        proposal.confidence < confidenceThreshold &&
        !options?.forceOverride
      ) {
        return recordAmbiguousResolution(
          { decisionRef, now, options, proposal, proposalId, resolutionId },
          state
        );
      }

      // INVARIANT 2 & 3: Merge/split correction preserves history & invalidates projections
      const previousCanonicalId =
        keyToCanonical.get(identityKeyString(proposal.key)) ?? null;
      let historicalReferences: string[] = [];
      let invalidatedProjections: string[] = [];
      const historyParams: ApplyResolutionHistoryParams = {
        decisionRef,
        now,
        proposal,
        proposalId,
      };

      if (proposal.action === "merge" || proposal.action === "link") {
        const mergeResult = applyMergeHistory(historyParams, state);
        historicalReferences = mergeResult.historicalReferences;
        invalidatedProjections = mergeResult.invalidatedProjections;
      } else if (proposal.action === "split") {
        const splitResult = applySplitHistory(historyParams, state);
        historicalReferences = splitResult.historicalReferences;
        invalidatedProjections = splitResult.invalidatedProjections;
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

      proposals.set(proposalId, {
        ...proposal,
        status: "resolved",
      });
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
    }
  );

  /**
   * Execute an exact bitemporal query under a WorldView per S04
   */
  query = Effect.fn("ReconciliationService.query")(function* (
    this: ReconciliationService,
    request: ExactQueryRequest,
    objectStore: ObjectStore,
    options?: QueryOptions
  ) {
    const { worldView, queryId, params } = request;

    // Freshness check: check if validTime is past max permitted staleness
    const maxStalenessMs =
      options?.maxStalenessMs ?? (params.maxStalenessMs as number | undefined);
    const ageMs = Math.max(0, worldView.pinnedAt - worldView.validTime);

    let isStale = false;
    if (maxStalenessMs !== undefined && ageMs > maxStalenessMs) {
      isStale = true;
      if (options?.failOnStale) {
        return yield* new StaleDependencyError({
          ageMs,
          dependencyId: queryId,
          maxStalenessMs,
          queryId,
        });
      }
    }

    // Query from object store
    // If store is BitemporalObjectStore, use asOfValidTime
    const typeId = queryId as ObjectTypeId;
    let allObjects = yield* objectStore.findObjects(typeId);

    // Filter by asOfValidTime if store supports bitemporal timeline
    if (
      "asOfValidTime" in objectStore &&
      typeof (objectStore as Record<string, unknown>).asOfValidTime ===
        "function"
    ) {
      const bitempStore = objectStore as BitemporalObjectStore;
      const validObjects = yield* Effect.forEach(
        allObjects,
        (obj) => bitempStore.asOfValidTime(typeId, obj.id, worldView.validTime),
        { concurrency: 10 }
      );
      allObjects = validObjects.filter(
        (matched): matched is ObjectInstance => matched !== undefined
      );
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

  /**
   * Explain a bitemporal point query (compiles plan without executing) per S04
   */
  explainQuery(options: BitemporalQueryOptions): {
    readonly sql: string;
    readonly params: readonly unknown[];
  } {
    return SqlSchemaGenerator.compileBitemporalQuery(options);
  }

  /**
   * Export snapshot for state persistence and crash recovery
   */
  exportSnapshot(): ReconciliationSnapshot {
    return {
      canonicalRegistry: [...this.canonicalRegistry.values()].map((r) => ({
        canonicalId: r.canonicalId,
        history: r.history,
        identityKeys: [...r.identityKeys],
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
    this.keyToCanonical.clear();
    for (const reg of snapshot.canonicalRegistry) {
      this.canonicalRegistry.set(reg.canonicalId, {
        canonicalId: reg.canonicalId,
        history: reg.history,
        identityKeys: new Set(reg.identityKeys),
      });
      for (const keyString of reg.identityKeys) {
        this.keyToCanonical.set(keyString, reg.canonicalId);
      }
    }
  }
}

export class ReconciliationContextService extends Context.Service<
  ReconciliationContextService,
  ReconciliationService
>()("@operon/runtime/ReconciliationContextService") {}
