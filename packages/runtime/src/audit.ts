import { createHash } from "node:crypto";

import type { Subject } from "@operon/schema";

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
 * Deterministically serialize a JavaScript value to canonical JSON.
 * Keys in objects are recursively sorted alphabetically.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value
      .map((element) =>
        element === undefined ? "null" : canonicalJson(element)
      )
      .join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const sortedKeys = Object.keys(obj)
    .filter((key) => obj[key] !== undefined)
    .sort();
  const pairs = sortedKeys.map(
    (key) => `${JSON.stringify(key)}:${canonicalJson(obj[key])}`
  );
  return `{${pairs.join(",")}}`;
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
  ) => Promise<DecisionRecord>;
  readonly appendOverride: (record: OverrideRecord) => Promise<void>;
  readonly getDecision: (id: string) => Promise<DecisionRecord | undefined>;
  readonly listDecisions: (filter?: {
    actionTypeId?: string;
    limit?: number;
  }) => Promise<readonly DecisionRecord[]>;
  readonly listOverrides: () => Promise<readonly OverrideRecord[]>;
  readonly verifyAuditChain: () => Promise<boolean>;
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
  ): Promise<DecisionRecord> {
    const cloned = structuredClone(record);
    const recordHash = computeRecordHash(cloned, this.lastHash);

    const completeRecord: DecisionRecord = Object.freeze({
      ...cloned,
      previousRecordHash: this.lastHash,
      recordHash,
    });

    this.decisions.push(completeRecord);
    this.lastHash = recordHash;
    return Promise.resolve(structuredClone(completeRecord));
  }

  appendOverride(record: OverrideRecord): Promise<void> {
    const cloned: OverrideRecord = Object.freeze(structuredClone(record));
    this.overrides.push(cloned);
    return Promise.resolve();
  }

  getDecision(id: string): Promise<DecisionRecord | undefined> {
    const found = this.decisions.find((d) => d.id === id);
    return Promise.resolve(found ? structuredClone(found) : undefined);
  }

  listDecisions(filter?: {
    actionTypeId?: string;
    limit?: number;
  }): Promise<readonly DecisionRecord[]> {
    let result = [...this.decisions];
    if (filter?.actionTypeId) {
      result = result.filter((d) => d.actionTypeId === filter.actionTypeId);
    }
    if (filter?.limit) {
      result = result.slice(-filter.limit);
    }
    return Promise.resolve(result.map((d) => structuredClone(d)));
  }

  listOverrides(): Promise<readonly OverrideRecord[]> {
    return Promise.resolve(this.overrides.map((o) => structuredClone(o)));
  }

  verifyAuditChain(): Promise<boolean> {
    let expectedPrevious = "GENESIS_HASH";
    for (const record of this.decisions) {
      if (record.previousRecordHash !== expectedPrevious) {
        return Promise.resolve(false);
      }
      const { recordHash, ...withoutHash } = record;
      const expectedHash = computeRecordHash(withoutHash, expectedPrevious);
      if (recordHash !== expectedHash) {
        return Promise.resolve(false);
      }
      expectedPrevious = recordHash;
    }
    return Promise.resolve(true);
  }
}
