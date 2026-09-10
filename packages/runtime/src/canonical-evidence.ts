import {
  computeAdmissionReceiptDigest,
  computeQueryReceiptDigest,
} from "@operon/schema";
import type {
  AdmissionReceipt,
  CanonicalEvidenceEnvelope,
  Claim,
  ObjectInstance,
  ObjectTypeId,
  QueryReceipt,
  Subject,
} from "@operon/schema";
import { Data, Effect } from "effect";

import type { BitemporalObjectStore } from "./bitemporal-store.js";
import type { StorageError } from "./errors.js";
import { AuthorizationError } from "./errors.js";
import type { ObjectStore } from "./object-store.js";
import {
  EmbeddedSqlDriver,
  SqlBitemporalStore,
  SqlSchemaGenerator,
} from "./sql-store.js";

export class ClaimConflictError extends Data.TaggedError("ClaimConflictError")<{
  readonly conflictingProperties: readonly string[];
  readonly message: string;
}> {}

export class QuarantinedEvidenceError extends Data.TaggedError(
  "QuarantinedEvidenceError"
)<{
  readonly envelopeId: string;
  readonly reason: string;
}> {}

/**
 * Canonical Evidence and Admission Engine (S03, S04 / V1-02)
 *
 * Implements controlled admission of evidence envelopes, attributed claim lifecycles,
 * preservation of unresolved conflicts, and reproducible bitemporal queries.
 */
export class CanonicalEvidenceEngine {
  private readonly store: ObjectStore;
  private readonly sqlDriver?: EmbeddedSqlDriver;
  private readonly admittedClaims = new Map<string, Claim[]>();
  private readonly envelopes = new Map<string, CanonicalEvidenceEnvelope>();
  private readonly receipts = new Map<string, AdmissionReceipt>();

  constructor(store?: ObjectStore, sqlDriver?: EmbeddedSqlDriver) {
    if (store) {
      this.store = store;
      this.sqlDriver = sqlDriver;
    } else {
      const driver = new EmbeddedSqlDriver();
      this.sqlDriver = driver;
      this.store = new SqlBitemporalStore(driver, "postgres");
    }
  }

  /**
   * admit (S03):
   * Controls admission of raw evidence envelopes. Contradictory claims remain visible,
   * attributed, and unresolved rather than silently overwriting accepted state.
   */
  admit(
    envelope: CanonicalEvidenceEnvelope,
    principal: Subject
  ): Effect.Effect<
    AdmissionReceipt,
    AuthorizationError | QuarantinedEvidenceError
  > {
    return Effect.gen({ self: this }, function* () {
      // 1. Check authorization
      const isAuthorized =
        principal.roles.includes("admin") ||
        principal.roles.includes("operator") ||
        principal.roles.includes("ingest_service") ||
        principal.roles.includes("domain_specialist");
      if (!isAuthorized) {
        return yield* Effect.fail(
          new AuthorizationError({
            reason: `Principal '${principal.id}' lacks required role to admit evidence into '${envelope.targetTypeId}'`,
          })
        );
      }

      const now = Date.now();
      const subjectKey = `${envelope.targetTypeId}:${envelope.externalId}`;
      const existingClaims = this.admittedClaims.get(subjectKey) ?? [];

      // 2. Parse claims from envelope
      const rawPayload = envelope.rawPayload as Record<string, unknown> | null;
      const incomingProperties: Record<string, unknown> = {};

      if (rawPayload && typeof rawPayload === "object") {
        for (const [k, v] of Object.entries(rawPayload)) {
          incomingProperties[k] = v;
        }
      }

      const acceptedClaims: Claim[] = [];
      const conflictingClaims: Claim[] = [];

      for (const [propName, propVal] of Object.entries(incomingProperties)) {
        const claimId = `clm_${now}_${Math.random().toString(36).slice(2, 8)}`;
        const existingClaim = existingClaims.find(
          (c) => c.propertyName === propName && c.state === "accepted"
        );

        if (
          existingClaim &&
          JSON.stringify(existingClaim.propertyValue) !==
            JSON.stringify(propVal) &&
          existingClaim.sourceSystem !== envelope.sourceSystem
        ) {
          // Contradictory evidence: S03 requires contradictory claims to remain visible, attributed, and unresolved
          const contestedClaim: Claim = {
            attribution: principal,
            claimId,
            confidence: 0.5,
            conflictReason: `Conflicting value '${JSON.stringify(propVal)}' from '${envelope.sourceSystem}' vs existing '${JSON.stringify(existingClaim.propertyValue)}' from '${existingClaim.sourceSystem}'`,
            effectiveTime: envelope.effectiveTime,
            evidenceDigest: envelope.contentDigest,
            propertyName: propName,
            propertyValue: propVal,
            recordedAt: now,
            sourceSystem: envelope.sourceSystem,
            state: "contested",
            subjectId: envelope.externalId,
            targetTypeId: envelope.targetTypeId,
          };
          conflictingClaims.push(contestedClaim);
        } else {
          const acceptedClaim: Claim = {
            attribution: principal,
            claimId,
            confidence: 0.99,
            effectiveTime: envelope.effectiveTime,
            evidenceDigest: envelope.contentDigest,
            propertyName: propName,
            propertyValue: propVal,
            recordedAt: now,
            sourceSystem: envelope.sourceSystem,
            state: "accepted",
            subjectId: envelope.externalId,
            targetTypeId: envelope.targetTypeId,
          };
          acceptedClaims.push(acceptedClaim);
        }
      }

      const status = conflictingClaims.length > 0 ? "contested" : "admitted";

      // 3. If admitted properties exist, write them into the bitemporal store
      if (acceptedClaims.length > 0) {
        const existingObj = yield* this.store
          .getObject(envelope.targetTypeId, envelope.externalId)
          .pipe(Effect.orDie);

        const mergedProperties: Record<string, unknown> = existingObj
          ? { ...existingObj.properties }
          : {};

        for (const c of acceptedClaims) {
          mergedProperties[c.propertyName] = c.propertyValue;
        }

        const nextVersion = existingObj ? existingObj.version + 1 : 1;

        yield* this.store
          .putObject({
            id: envelope.externalId,
            lastModifiedAt: now,
            properties: mergedProperties,
            typeId: envelope.targetTypeId,
            validFrom: envelope.effectiveTime,
            version: nextVersion,
          })
          .pipe(Effect.orDie);
      }

      // Record claims in registry
      this.admittedClaims.set(subjectKey, [
        ...existingClaims,
        ...acceptedClaims,
        ...conflictingClaims,
      ]);
      this.envelopes.set(envelope.envelopeId, envelope);

      const admissionId = `adm_${now}_${Math.random().toString(36).slice(2, 8)}`;
      const receiptDigest = computeAdmissionReceiptDigest({
        admittedAt: now,
        claims: acceptedClaims,
        conflictingClaims,
        envelopeId: envelope.envelopeId,
        status,
        subjectId: envelope.externalId,
        targetTypeId: envelope.targetTypeId,
      });

      const receipt: AdmissionReceipt = {
        admissionId,
        admittedAt: now,
        admittedBy: principal,
        bitemporal: {
          transactionTime: {
            recordedAt: now,
          },
          validTime: {
            validFrom: envelope.effectiveTime,
          },
        },
        claims: acceptedClaims,
        conflictingClaims,
        envelopeId: envelope.envelopeId,
        receiptDigest,
        status,
        subjectId: envelope.externalId,
        targetTypeId: envelope.targetTypeId,
      };

      this.receipts.set(admissionId, receipt);
      return receipt;
    });
  }

  /**
   * query (S04):
   * Point-in-time bitemporal query returning exact independently checkable QueryReceipt.
   */
  query(
    targetTypeId: ObjectTypeId,
    asOf: { readonly valid: number; readonly transaction: number }
  ): Effect.Effect<QueryReceipt, StorageError> {
    const store = this.store;
    return Effect.gen(function* () {
      const allObjects = yield* store
        .findObjects(targetTypeId)
        .pipe(Effect.orDie);

      const matched: ObjectInstance[] = [];

      for (const obj of allObjects) {
        if ("asOfBitemporal" in store) {
          const pointInTime = yield* (
            store as SqlBitemporalStore
          ).asOfBitemporal(targetTypeId, obj.id, asOf.valid, asOf.transaction);
          if (pointInTime) {
            matched.push(pointInTime);
          }
        } else if ("asOfValidTime" in store) {
          const vMatched = yield* (
            store as BitemporalObjectStore
          ).asOfValidTime(targetTypeId, obj.id, asOf.valid);
          if (vMatched) {
            matched.push(vMatched);
          }
        }
      }

      const now = Date.now();
      const queryId = `qry_${now}_${Math.random().toString(36).slice(2, 8)}`;
      const receiptDigest = computeQueryReceiptDigest({
        asOf: {
          transactionTime: asOf.transaction,
          validTime: asOf.valid,
        },
        objects: matched,
        queryId,
        targetTypeId,
      });

      return {
        asOf: {
          transactionTime: asOf.transaction,
          validTime: asOf.valid,
        },
        count: matched.length,
        objects: matched,
        queriedAt: now,
        queryId,
        receiptDigest,
        targetTypeId,
      };
    });
  }

  /**
   * Directly executes independent SQL compilation against underlying tables to prove
   * independent SQL/oracle parity with API result per S04 acceptance criteria.
   */
  executeIndependentSqlOracle(
    targetTypeId: string,
    id: string,
    validTime: number,
    txTime: number
  ): Effect.Effect<unknown, StorageError> {
    if (!this.sqlDriver) {
      return Effect.succeed(undefined);
    }
    const compiled = SqlSchemaGenerator.compileBitemporalQuery(
      targetTypeId,
      id,
      validTime,
      txTime,
      "postgres"
    );
    return this.sqlDriver
      .execute(compiled.sql, compiled.params)
      .pipe(Effect.map((res) => res.rows[0] ?? undefined));
  }

  getClaimsForSubject(
    targetTypeId: ObjectTypeId,
    externalId: string
  ): readonly Claim[] {
    return this.admittedClaims.get(`${targetTypeId}:${externalId}`) ?? [];
  }
}
