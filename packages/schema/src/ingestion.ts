import { computeCanonicalDigest } from "./definition.js";
import type { Subject } from "./security.js";
import type { ObjectTypeId } from "./types.js";

export type SensitivityLevel =
  | "public"
  | "internal"
  | "confidential"
  | "restricted";

/**
 * SourceArtifact (S03, S15, Chapter 15 & 16)
 * Raw evidence artifact cataloged before mapping or admission.
 */
export interface SourceArtifact {
  readonly sourceId: string;
  readonly digest: string;
  readonly mediaType: string;
  readonly permittedUses: readonly string[];
  readonly sensitivity: SensitivityLevel;
  readonly locator: string;
  readonly receivedAt: number;
  readonly batchId: string;
  readonly tenantId?: string;
  readonly environmentId?: string;
  readonly rawPayload: unknown;
}

/**
 * Provenance pointer linking every accepted field back to raw evidence.
 */
export interface FieldProvenance {
  readonly sourceId: string;
  readonly locator: string;
  readonly batchId: string;
  readonly digest: string;
  readonly fieldPath: string;
}

/**
 * CandidateRecord produced by mapping proposal.
 */
export interface CandidateRecord {
  readonly rawRecordId: string;
  readonly targetObjectTypeId: ObjectTypeId;
  readonly properties: Record<string, unknown>;
  readonly confidence: number;
  readonly provenance: {
    readonly sourceId: string;
    readonly locator: string;
    readonly batchId: string;
    readonly digest: string;
    readonly fieldProvenances: Record<string, FieldProvenance>;
  };
}

/**
 * MappingProposal (V0-CH-05)
 * Accountable mapping from raw sources to candidate records.
 */
export interface MappingProposal {
  readonly proposalId: string;
  readonly definitionDigest: string;
  readonly sources: readonly string[];
  readonly records: readonly CandidateRecord[];
  readonly openQuestions: readonly string[];
  readonly confidence: number;
  readonly status: "draft" | "submitted" | "approved" | "rejected";
  readonly createdAt: number;
  readonly createdBy: Subject;
}

/**
 * IngestionReceipt returned upon successful accountable ingestion.
 */
export interface IngestionReceipt {
  readonly batchId: string;
  readonly sourceArtifact: SourceArtifact;
  readonly status: "ingested" | "replayed";
  readonly idempotencyKey?: string;
  readonly timestamp: number;
}

export function computeSourceDigest(payload: unknown): string {
  return computeCanonicalDigest(payload);
}
