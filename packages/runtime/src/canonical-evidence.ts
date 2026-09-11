import {
  computeAdmissionReceiptDigest,
  computeQueryReceiptDigest,
  generatePrefixedId,
} from "@operon/schema";
import type {
  AdmissionReceipt,
  CanonicalEvidenceEnvelope,
  Claim,
  ObjectInstance,
  ObjectProperties,
  ObjectTypeId,
  QueryReceipt,
  Subject,
} from "@operon/schema";
import type { Schema } from "effect";
import { Clock, Data, Effect } from "effect";

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

function isJsonObject(
  value: Schema.Json
): value is Record<string, Schema.Json> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkEvidenceAuthorization(
  principal: Subject,
  targetTypeId: string
): Effect.Effect<void, AuthorizationError> {
  const isAuthorized =
    principal.roles.includes("admin") ||
    principal.roles.includes("operator") ||
    principal.roles.includes("ingest_service") ||
    principal.roles.includes("domain_specialist");
  if (!isAuthorized) {
    return new AuthorizationError({
      reason: `Principal '${principal.id}' lacks required role to admit evidence into '${targetTypeId}'`,
    });
  }
  return Effect.void;
}

function classifyIncomingClaims(
  envelope: CanonicalEvidenceEnvelope,
  principal: Subject,
  existingClaims: readonly Claim[],
  now: number
): { acceptedClaims: Claim[]; conflictingClaims: Claim[] } {
  const incomingProperties: Record<string, Schema.Json> = {};
  if (isJsonObject(envelope.rawPayload)) {
    for (const [k, v] of Object.entries(envelope.rawPayload)) {
      incomingProperties[k] = v;
    }
  }

  const acceptedClaims: Claim[] = [];
  const conflictingClaims: Claim[] = [];

  for (const [propName, propVal] of Object.entries(incomingProperties)) {
    const claimId = generatePrefixedId("clm", now);
    const existingClaim = existingClaims.find(
      (c) => c.propertyName === propName && c.state === "accepted"
    );

    const isConflict =
      existingClaim &&
      JSON.stringify(existingClaim.propertyValue) !== JSON.stringify(propVal) &&
      existingClaim.sourceSystem !== envelope.sourceSystem;

    if (isConflict) {
      conflictingClaims.push({
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
      });
    } else {
      acceptedClaims.push({
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
      });
    }
  }

  return { acceptedClaims, conflictingClaims };
}

function persistAcceptedClaims(
  store: ObjectStore,
  envelope: CanonicalEvidenceEnvelope,
  acceptedClaims: readonly Claim[],
  now: number
): Effect.Effect<void> {
  if (acceptedClaims.length === 0) {
    return Effect.void;
  }
  return Effect.gen(function* () {
    const existingObj = yield* store.getObject(
      envelope.targetTypeId,
      envelope.externalId
    );

    const mergedProperties: ObjectProperties = existingObj
      ? { ...existingObj.properties }
      : {};

    for (const c of acceptedClaims) {
      mergedProperties[c.propertyName] = c.propertyValue;
    }

    const nextVersion = existingObj ? existingObj.version + 1 : 1;

    yield* store
      .putObject({
        id: envelope.externalId,
        lastModifiedAt: now,
        properties: mergedProperties,
        typeId: envelope.targetTypeId,
        validFrom: envelope.effectiveTime,
        version: nextVersion,
      })
      .pipe(Effect.catchTag("ConcurrentModificationError", Effect.die));
  });
}

const queryObjPointInTime = Effect.fn("queryObjPointInTime")(function* (
  store: ObjectStore,
  targetTypeId: ObjectTypeId,
  objId: string,
  asOf: { readonly valid: number; readonly transaction: number }
): Effect.fn.Return<ObjectInstance | undefined, StorageError> {
  if ("asOfBitemporal" in store) {
    return yield* (store as SqlBitemporalStore).asOfBitemporal(
      targetTypeId,
      objId,
      asOf.valid,
      asOf.transaction
    );
  }
  if ("asOfValidTime" in store) {
    return yield* (store as BitemporalObjectStore).asOfValidTime(
      targetTypeId,
      objId,
      asOf.valid
    );
  }
  return undefined;
});

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
  admit = Effect.fn("CanonicalEvidenceEngine.admit")(function* (
    this: CanonicalEvidenceEngine,
    envelope: CanonicalEvidenceEnvelope,
    principal: Subject
  ): Effect.fn.Return<
    AdmissionReceipt,
    AuthorizationError | QuarantinedEvidenceError
  > {
    yield* checkEvidenceAuthorization(principal, envelope.targetTypeId);

    const now = yield* Clock.currentTimeMillis;
    const subjectKey = `${envelope.targetTypeId}:${envelope.externalId}`;
    const existingClaims = this.admittedClaims.get(subjectKey) ?? [];

    const { acceptedClaims, conflictingClaims } = classifyIncomingClaims(
      envelope,
      principal,
      existingClaims,
      now
    );

    const status = conflictingClaims.length > 0 ? "contested" : "admitted";

    yield* persistAcceptedClaims(this.store, envelope, acceptedClaims, now);

    this.admittedClaims.set(subjectKey, [
      ...existingClaims,
      ...acceptedClaims,
      ...conflictingClaims,
    ]);
    this.envelopes.set(envelope.envelopeId, envelope);

    const admissionId = generatePrefixedId("adm", now);
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

  /**
   * query (S04):
   * Point-in-time bitemporal query returning exact independently checkable QueryReceipt.
   */
  query = Effect.fn("CanonicalEvidenceEngine.query")(function* (
    this: CanonicalEvidenceEngine,
    targetTypeId: ObjectTypeId,
    asOf: { readonly valid: number; readonly transaction: number }
  ): Effect.fn.Return<QueryReceipt, StorageError> {
    const store = this.store;
    const allObjects = yield* store.findObjects(targetTypeId);

    const results = yield* Effect.forEach(
      allObjects,
      (obj) => queryObjPointInTime(store, targetTypeId, obj.id, asOf),
      { concurrency: 10 }
    );

    const matched: ObjectInstance[] = results.filter(
      (r): r is ObjectInstance => r !== undefined
    );

    const now = yield* Clock.currentTimeMillis;
    const queryId = generatePrefixedId("qry", now);
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
      return Effect.void;
    }
    const compiled = SqlSchemaGenerator.compileBitemporalQuery({
      dialect: "postgres",
      id,
      txTime,
      typeId: targetTypeId,
      validTime,
    });
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
