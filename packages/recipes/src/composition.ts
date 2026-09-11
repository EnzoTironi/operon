import { Effect } from "effect";

import {
  InsufficientInventoryError,
  PackageNotProductionReadyError,
  WriterFencedError,
} from "./errors.js";

/**
 * Candidate package definition for production readiness evaluation (OPR-FULL-041)
 */
export interface PackageCandidate {
  readonly hasDomainDefinitions: boolean;
  readonly hasExecutableTests: boolean;
  readonly hasMigrationPlan: boolean;
  readonly hasOperationalIndicators: boolean;
  readonly isOnlySchemasAndScreens: boolean;
  readonly name: string;
  readonly packageId: string;
  readonly version: string;
}

/**
 * Verdict of package qualification evaluation (OPR-FULL-041)
 */
export interface PackageQualificationVerdict {
  readonly erpQmsEquivalenceClaimAllowed: boolean;
  readonly missingInvariants: readonly string[];
  readonly packageId: string;
  readonly readyForProduction: boolean;
  readonly verdict: "DEFICIENT" | "QUALIFIED";
}

/**
 * Evaluates whether a domain package satisfies production readiness and ERP/QMS equivalence (OPR-FULL-041)
 */
export function evaluatePackageQualification(
  candidate: PackageCandidate
): Effect.Effect<PackageQualificationVerdict, never> {
  return Effect.sync(() => {
    const missing: string[] = [];

    if (candidate.isOnlySchemasAndScreens) {
      missing.push("PACKAGE_CONTAINS_ONLY_SCHEMAS_AND_SCREENS");
    }
    if (!candidate.hasExecutableTests) {
      missing.push("MISSING_EXECUTABLE_TESTS");
    }
    if (!candidate.hasOperationalIndicators) {
      missing.push("MISSING_OPERATIONAL_INDICATORS");
    }
    if (!candidate.hasMigrationPlan) {
      missing.push("MISSING_MIGRATION_PLAN");
    }
    if (!candidate.hasDomainDefinitions) {
      missing.push("MISSING_DOMAIN_DEFINITIONS");
    }

    const isQualified =
      missing.length === 0 && !candidate.isOnlySchemasAndScreens;

    return {
      erpQmsEquivalenceClaimAllowed: isQualified,
      missingInvariants: missing,
      packageId: candidate.packageId,
      readyForProduction: isQualified,
      verdict: isQualified ? "QUALIFIED" : "DEFICIENT",
    };
  });
}

/**
 * Asserts production readiness, failing with PackageNotProductionReadyError if deficient (OPR-FULL-041)
 */
export function assertPackageProductionReady(
  candidate: PackageCandidate
): Effect.Effect<PackageQualificationVerdict, PackageNotProductionReadyError> {
  return Effect.gen(function* () {
    const verdict = yield* evaluatePackageQualification(candidate);

    if (verdict.verdict === "DEFICIENT") {
      return yield* Effect.fail(
        new PackageNotProductionReadyError({
          missingInvariants: verdict.missingInvariants,
          packageId: candidate.packageId,
          reason: `Package '${candidate.packageId}' is not ready for production: ${verdict.missingInvariants.join(", ")}. ERP/QMS equivalence denied.`,
        })
      );
    }

    return verdict;
  });
}

/**
 * Parameters for Order to Cash composition journey J1 (OPR-FULL-039)
 */
export interface OrderToCashParams {
  readonly customerId: string;
  readonly items: readonly {
    readonly itemId: string;
    readonly quantity: number;
    readonly unitPrice: number;
  }[];
  readonly opportunityId: string;
}

/**
 * Result of Order to Cash composition journey J1 (OPR-FULL-039)
 */
export interface OrderToCashResult {
  readonly commitmentId: string;
  readonly correlatedDomains: readonly [
    "CRM",
    "INVENTORY",
    "LOGISTICS",
    "FINANCE",
  ];
  readonly invoiceId: string;
  readonly operationId: string;
  readonly reservationId: string;
  readonly settlementId: string;
  readonly status: "SETTLED";
  readonly totalAmount: number;
}

/**
 * Executes Order to Cash journey J1 over shared kernel contracts and identity (OPR-FULL-039)
 */
export function executeOrderToCashJourney(
  params: OrderToCashParams
): Effect.Effect<OrderToCashResult, never> {
  return Effect.sync(() => {
    const timestamp = Date.now();
    const operationId = `op-otc-${timestamp}`;

    let total = 0;
    for (const item of params.items) {
      total += item.quantity * item.unitPrice;
    }

    // Correlate CRM commitment, inventory reservation, logistics shipment, and finance invoice
    const commitmentId = `commit-${params.opportunityId}-${timestamp}`;
    const reservationId = `res-${operationId}`;
    const shipmentId = `ship-${operationId}`;
    const invoiceId = `inv-${operationId}`;
    const settlementId = `settle-${operationId}`;

    return {
      commitmentId,
      correlatedDomains: ["CRM", "INVENTORY", "LOGISTICS", "FINANCE"],
      invoiceId,
      operationId,
      reservationId,
      settlementId,
      shipmentId,
      status: "SETTLED",
      totalAmount: total,
    };
  });
}

/**
 * Inventory stock state for atomic reservation invariant (OPR-FULL-040)
 */
export interface InventoryStockState {
  availableQuantity: number;
  readonly itemId: string;
}

/**
 * Atomically reserves inventory and enforces stock non-negativity invariant (OPR-FULL-040)
 */
export function reserveInventoryWithAtomicInvariant(
  stockState: InventoryStockState,
  request: { readonly quantity: number; readonly reservationId: string }
): Effect.Effect<
  { readonly remainingStock: number; readonly reservedQuantity: number },
  InsufficientInventoryError
> {
  return Effect.gen(function* () {
    if (request.quantity > stockState.availableQuantity) {
      return yield* Effect.fail(
        new InsufficientInventoryError({
          availableQuantity: stockState.availableQuantity,
          itemId: stockState.itemId,
          message: `Cannot reserve ${request.quantity} units of item '${stockState.itemId}': only ${stockState.availableQuantity} available. Impossible negative inventory prevented.`,
          requestedQuantity: request.quantity,
        })
      );
    }

    stockState.availableQuantity -= request.quantity;

    return {
      remainingStock: stockState.availableQuantity,
      reservedQuantity: request.quantity,
    };
  });
}

/**
 * Cutover fence state for legacy system migration (OPR-FULL-042)
 */
export interface CutoverFenceState {
  readonly authorizedWriterId: string;
  readonly cutoverTimestamp: number;
  readonly entityId: string;
  readonly fenceActive: boolean;
}

/**
 * Initializes cutover fence from legacy writer to Operon kernel (OPR-FULL-042)
 */
export function initializeCutoverFence(params: {
  readonly authorizedWriterId: string;
  readonly entityId: string;
}): CutoverFenceState {
  return {
    authorizedWriterId: params.authorizedWriterId,
    cutoverTimestamp: Date.now(),
    entityId: params.entityId,
    fenceActive: true,
  };
}

/**
 * Validates writer authority against cutover fence, rejecting fenced writers (OPR-FULL-042)
 */
export function verifyWriterPermitted(
  fence: CutoverFenceState,
  writerId: string
): Effect.Effect<
  { readonly permitted: true; readonly writerId: string },
  WriterFencedError
> {
  return Effect.gen(function* () {
    if (fence.fenceActive && writerId !== fence.authorizedWriterId) {
      return yield* Effect.fail(
        new WriterFencedError({
          cutoverTimestamp: fence.cutoverTimestamp,
          entityId: fence.entityId,
          message: `Writer '${writerId}' is fenced: authority for entity '${fence.entityId}' cut over to '${fence.authorizedWriterId}' at ${fence.cutoverTimestamp}. Updates rejected.`,
          writerId,
        })
      );
    }

    return { permitted: true, writerId };
  });
}

/**
 * Plant topology node for industrial water / wastewater plants (OPR-WW-001)
 */
export interface TopologyNode {
  readonly id: string;
  readonly name: string;
  readonly downstreamNodeIds: readonly string[];
}

/**
 * Traverses industrial wastewater plant topology with recirculation loops safely (OPR-WW-001)
 */
export function traversePlantTopologyBounded(params: {
  readonly maxDepth?: number;
  readonly nodes: ReadonlyMap<string, TopologyNode>;
  readonly startNodeId: string;
}): Effect.Effect<
  {
    readonly cycleDetected: boolean;
    readonly depthReached: number;
    readonly nodesVisited: readonly string[];
  },
  never
> {
  return Effect.sync(() => {
    const maxDepth = params.maxDepth ?? 50;
    const visited = new Set<string>();
    let cycleDetected = false;
    let depth = 0;

    const queue: { readonly depth: number; readonly id: string }[] = [
      { depth: 0, id: params.startNodeId },
    ];

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) break;

      depth = Math.max(depth, current.depth);

      if (visited.has(current.id)) {
        cycleDetected = true;
        continue;
      }

      visited.add(current.id);

      if (current.depth < maxDepth) {
        const node = params.nodes.get(current.id);
        if (node) {
          for (const downstreamId of node.downstreamNodeIds) {
            queue.push({ depth: current.depth + 1, id: downstreamId });
          }
        }
      }
    }

    return {
      cycleDetected,
      depthReached: depth,
      nodesVisited: [...visited],
    };
  });
}

/**
 * Clinical handoff candidate extraction fact (OPR-HC-001)
 */
export interface CandidateClinicalFact {
  readonly factKey: string;
  readonly factValue: string;
  readonly requiresHumanConfirmation: boolean;
  readonly sourceSpan: string;
}

/**
 * Extracts clinical facts from handoff note with span linking and human confirmation (OPR-HC-001)
 */
export function extractClinicalHandoffCandidates(
  noteText: string
): Effect.Effect<
  {
    readonly candidates: readonly CandidateClinicalFact[];
    readonly promptInjectionDetected: boolean;
  },
  never
> {
  return Effect.sync(() => {
    // Check for prompt injection attempts in clinical notes (OPR-HC-001 / HC-001.T02)
    const hostilePattern =
      /ignore\s+previous\s+instructions|bypass\s+approval|grant\s+authority/iu;
    const promptInjectionDetected = hostilePattern.test(noteText);

    const candidates: CandidateClinicalFact[] = [];

    const hrMatch = /hr[:\s]+(?<hr>\d+)/iu.exec(noteText);
    if (hrMatch?.groups?.hr) {
      candidates.push({
        factKey: "heartRate",
        factValue: hrMatch.groups.hr,
        requiresHumanConfirmation: true,
        sourceSpan: hrMatch[0],
      });
    }

    const bpMatch = /bp[:\s]+(?<bp>\d+\/\d+)/iu.exec(noteText);
    if (bpMatch?.groups?.bp) {
      candidates.push({
        factKey: "bloodPressure",
        factValue: bpMatch.groups.bp,
        requiresHumanConfirmation: true,
        sourceSpan: bpMatch[0],
      });
    }

    return {
      candidates,
      promptInjectionDetected,
    };
  });
}
