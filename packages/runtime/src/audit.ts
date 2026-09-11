import { createHash } from "node:crypto";

import { canonicalJson } from "@operon/schema";
import type { Subject } from "@operon/schema";
import { Effect, Option } from "effect";

import type { StorageError } from "./errors.js";

export { canonicalJson } from "@operon/schema";

export interface DecisionRecord {
  readonly id: string;
  readonly timestamp: number;
  readonly correlationId: string;
  readonly actionTypeId: string;
  readonly subject: Subject;
  readonly parameters: Record<string, unknown>;
  readonly stateSnapshot: Record<string, unknown>;
  readonly ruleVersion: string;
  readonly verdict: "allow" | "review" | "deny";
  readonly outcome: "executed" | "proposed" | "rejected" | "compensated";
  readonly reason?: string;
  readonly compensation?: {
    readonly compensatedAt: number;
    readonly error: string;
  };
  readonly previousRecordHash?: string;
  readonly recordHash: string;
}

export type OverrideCategory =
  | "missing_evidence"
  | "model_out_of_scope"
  | "clinical_discretion"
  | "operational_override"
  | "safety_veto";

export interface OverrideRecord {
  readonly id: string;
  readonly decisionRecordId: string;
  readonly originalProposal: Record<string, unknown>;
  readonly humanSubject: Subject;
  readonly finalDecision: Record<string, unknown>;
  readonly reasonCategory: OverrideCategory;
  readonly structuredReason: string;
  readonly timestamp: number;
}

/**
 * Computes the SHA-256 digest of a decision record with canonical JSON representation.
 */
export function computeRecordHash(
  record: Omit<DecisionRecord, "recordHash">,
  previousHash: string
): string {
  const canonicalPayload = canonicalJson({
    ...record,
    previousRecordHash: previousHash,
  });
  return createHash("sha256").update(canonicalPayload).digest("hex");
}

/**
 * Audit Store interface for persisting immutable DecisionRecords and Overrides
 */
export interface AuditStore {
  readonly appendDecision: (
    record: Omit<DecisionRecord, "recordHash">
  ) => Effect.Effect<DecisionRecord, StorageError>;
  readonly appendOverride: (
    record: OverrideRecord
  ) => Effect.Effect<void, StorageError>;
  readonly getDecision: (
    id: string
  ) => Effect.Effect<Option.Option<DecisionRecord>, StorageError>;
  readonly listDecisions: (filter?: {
    actionTypeId?: string;
    limit?: number;
  }) => Effect.Effect<readonly DecisionRecord[], StorageError>;
  readonly listOverrides: () => Effect.Effect<
    readonly OverrideRecord[],
    StorageError
  >;
  readonly verifyAuditChain: () => Effect.Effect<boolean, StorageError>;
}

/**
 * In-memory reference implementation of AuditStore with cryptographic SHA-256 hash chaining,
 * deep cloning on ingress and egress to prevent memory reference aliasing, and chain verification.
 */
export class InMemoryAuditStore implements AuditStore {
  private readonly decisions: DecisionRecord[] = [];
  private readonly overrides: OverrideRecord[] = [];
  private lastHash = "GENESIS_HASH";

  appendDecision(
    record: Omit<DecisionRecord, "recordHash">
  ): Effect.Effect<DecisionRecord, StorageError> {
    return Effect.sync(() => {
      const cloned = structuredClone(record);
      const recordHash = computeRecordHash(cloned, this.lastHash);

      const completeRecord: DecisionRecord = Object.freeze({
        ...cloned,
        previousRecordHash: this.lastHash,
        recordHash,
      });

      this.decisions.push(completeRecord);
      this.lastHash = recordHash;
      return structuredClone(completeRecord);
    });
  }

  appendOverride(record: OverrideRecord): Effect.Effect<void, StorageError> {
    return Effect.sync(() => {
      const cloned: OverrideRecord = Object.freeze(structuredClone(record));
      this.overrides.push(cloned);
    });
  }

  getDecision(
    id: string
  ): Effect.Effect<Option.Option<DecisionRecord>, StorageError> {
    return Effect.sync(() => {
      const found = this.decisions.find((d) => d.id === id);
      return found ? Option.some(structuredClone(found)) : Option.none();
    });
  }

  listDecisions(filter?: {
    actionTypeId?: string;
    limit?: number;
  }): Effect.Effect<readonly DecisionRecord[], StorageError> {
    return Effect.sync(() => {
      let result = [...this.decisions];
      if (filter?.actionTypeId) {
        result = result.filter((d) => d.actionTypeId === filter.actionTypeId);
      }
      if (filter?.limit) {
        result = result.slice(-filter.limit);
      }
      return result.map((d) => structuredClone(d));
    });
  }

  listOverrides(): Effect.Effect<readonly OverrideRecord[], StorageError> {
    return Effect.sync(() => this.overrides.map((o) => structuredClone(o)));
  }

  verifyAuditChain(): Effect.Effect<boolean, StorageError> {
    return Effect.sync(() => {
      let expectedPrevious = "GENESIS_HASH";
      for (const record of this.decisions) {
        if (record.previousRecordHash !== expectedPrevious) {
          return false;
        }
        const { recordHash, ...withoutHash } = record;
        const expectedHash = computeRecordHash(withoutHash, expectedPrevious);
        if (recordHash !== expectedHash) {
          return false;
        }
        expectedPrevious = recordHash;
      }
      return true;
    });
  }

  exportSnapshot(): InMemoryAuditSnapshot {
    return {
      decisions: [...this.decisions],
      lastHash: this.lastHash,
      overrides: [...this.overrides],
    };
  }

  importSnapshot(snapshot: InMemoryAuditSnapshot): void {
    this.decisions.length = 0;
    this.decisions.push(...snapshot.decisions.map((d) => structuredClone(d)));
    this.overrides.length = 0;
    if (snapshot.overrides) {
      this.overrides.push(...snapshot.overrides.map((o) => structuredClone(o)));
    }
    const tailHash = snapshot.decisions.at(-1)?.recordHash;
    this.lastHash = snapshot.lastHash ?? tailHash ?? "GENESIS_HASH";
  }
}

export interface InMemoryAuditSnapshot {
  readonly decisions: readonly DecisionRecord[];
  readonly overrides?: readonly OverrideRecord[];
  readonly lastHash?: string;
}
