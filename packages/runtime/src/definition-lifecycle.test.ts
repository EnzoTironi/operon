import type {
  DefinitionArtifact,
  ProposalReview,
  Subject,
} from "@operon/schema";
import { canonicalJson, computeCanonicalDigest } from "@operon/schema";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import type { AgentContext } from "./auth.js";
import type { AuthorizationError, CompilationError } from "./errors.js";
import { OntologyMetadataService } from "./oms.js";

const sampleAuthor: Subject = {
  id: "lead_architect_1",
  name: "Lead Architect",
  roles: ["lead_architect"],
  type: "user",
};

const sampleReviewer: Subject = {
  id: "specialist_reviewer_1",
  name: "Specialist Reviewer",
  roles: ["domain_specialist", "reviewer"],
  type: "user",
};

const sampleArtifact: DefinitionArtifact = {
  actions: [
    {
      description: "Dispatch urgent transport unit",
      effectClass: "state_mutation",
      id: "dispatch_unit",
      name: "Dispatch Unit",
      parametersSchema: { unitId: "string" },
      requiredRoles: ["dispatcher"],
      riskTier: "high",
    },
  ],
  freshness: [
    {
      maxStalenessMs: 30000,
      onStale: "warn",
      propertyName: "callSign",
      typeId: "Vehicle",
    },
  ],
  links: [
    {
      cardinality: "1:N",
      id: "station_vehicles",
      name: "stationVehicles",
      sourceTypeId: "Station",
      targetTypeId: "Vehicle",
    },
  ],
  policies: [
    {
      id: "high_risk_gate",
      name: "High Risk Review Gate",
      requiredReviewerRoles: ["domain_specialist"],
      ruleExpression: "action.riskTier == 'high'",
    },
  ],
  queries: [
    {
      description: "Find available vehicles in station",
      id: "find_station_vehicles",
      name: "Find Station Vehicles",
      parameters: { stationId: "string" },
      returnTypeId: "Vehicle",
    },
  ],
  types: [
    {
      classification: "internal",
      id: "Station",
      name: "Station",
      primaryKey: "id",
      properties: {
        id: { name: "id", required: true, type: "string" },
        location: { name: "location", type: "string" },
      },
      typology: "master",
    },
    {
      classification: "internal",
      id: "Vehicle",
      name: "Vehicle",
      primaryKey: "id",
      properties: {
        callSign: { name: "callSign", type: "string" },
        id: { name: "id", required: true, type: "string" },
        status: { name: "status", type: "string" },
      },
      typology: "master",
    },
  ],
};

describe("V0-CH-02: Definition Artifact, Branch and Atomic ChangeSet", () => {
  it("performs valid complete artifact round-trip and digest calculation", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const oms = new OntologyMetadataService();
        yield* oms.createBranch("feature/emergency-response", sampleAuthor);

        const receipt = yield* oms.applyArtifact({
          artifact: sampleArtifact,
          branch: "feature/emergency-response",
          expectedRevision: 1,
          idempotencyKey: "apply-key-1",
        });

        expect(receipt.status).toBe("applied");
        expect(receipt.branch).toBe("feature/emergency-response");
        expect(receipt.revision).toBe(2);

        const expectedDigest = computeCanonicalDigest(sampleArtifact);
        expect(receipt.candidateDigest).toBe(expectedDigest);
        expect(receipt.changeSet.canonicalDigest).toBe(expectedDigest);

        // Verify canonicalJson stability regardless of key reordering
        const reorderedArtifact = {
          actions: sampleArtifact.actions,
          freshness: sampleArtifact.freshness,
          links: sampleArtifact.links,
          policies: sampleArtifact.policies,
          presentation: undefined,
          queries: sampleArtifact.queries,
          types: sampleArtifact.types,
        };
        expect(canonicalJson(reorderedArtifact)).toBe(
          canonicalJson(sampleArtifact)
        );
        expect(computeCanonicalDigest(reorderedArtifact)).toBe(expectedDigest);

        // Verify candidate inspection
        const inspected = yield* oms.inspectCandidate(receipt.candidateDigest);
        expect(inspected.canonicalDigest).toBe(expectedDigest);
        expect(inspected.artifact.types.length).toBe(2);

        // Verify diff
        const diff = yield* oms.diffCandidate(receipt.candidateDigest);
        expect(diff.addedTypes).toContain("Station");
        expect(diff.addedTypes).toContain("Vehicle");
        expect(diff.addedActions).toContain("dispatch_unit");
      })
    );
  });

  it("rejects undefined references, missing primary keys, and unsafe effect widening", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const oms = new OntologyMetadataService();
        yield* oms.createBranch("feature/invalid-refs", sampleAuthor);

        const invalidArtifact: DefinitionArtifact = {
          actions: [
            {
              description: "Unsafe action",
              effectClass: "invalid_effect_class" as any,
              id: "bad_action",
              name: "Bad Action",
              parametersSchema: {},
              requiredRoles: [],
              riskTier: "low",
            },
          ],
          freshness: [
            {
              maxStalenessMs: 1000,
              onStale: "reject",
              propertyName: "nonExistentProp",
              typeId: "NonExistentType",
            },
          ],
          links: [
            {
              cardinality: "1:1",
              id: "broken_link",
              name: "broken",
              sourceTypeId: "MissingSource",
              targetTypeId: "MissingTarget",
            },
          ],
          policies: [],
          queries: [
            {
              id: "broken_query",
              name: "Broken Query",
              parameters: {},
              returnTypeId: "UnknownReturnType",
            },
          ],
          types: [
            {
              id: "BadType",
              name: "Bad Type",
              primaryKey: "missingKey",
              properties: {
                foo: { name: "foo", type: "string" },
              },
            },
          ],
        };

        const error = yield* Effect.flip(
          oms.applyArtifact({
            artifact: invalidArtifact,
            branch: "feature/invalid-refs",
          })
        );

        expect(error._tag).toBe("CompilationError");
        const compError = error as CompilationError;
        expect(compError.errors.length).toBeGreaterThanOrEqual(4);
        expect(compError.errors.some((e) => e.includes("missingKey"))).toBe(
          true
        );
        expect(compError.errors.some((e) => e.includes("MissingSource"))).toBe(
          true
        );
        expect(
          compError.errors.some((e) => e.includes("UnknownReturnType"))
        ).toBe(true);
        expect(
          compError.errors.some((e) => e.includes("invalid_effect_class"))
        ).toBe(true);
      })
    );
  });

  it("crash injection leaves whole candidate or none (atomicity)", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const oms = new OntologyMetadataService();
        yield* oms.createBranch("feature/crash-branch", sampleAuthor);

        const branchBefore = yield* oms.getBranch("feature/crash-branch");
        const schemaBefore = yield* oms.getSchema("feature/crash-branch");
        const initialTypeCount = schemaBefore.objectTypes.size;

        // Apply with crash injection
        const error = yield* Effect.flip(
          oms.applyArtifact({
            artifact: sampleArtifact,
            branch: "feature/crash-branch",
            crashInject: true,
          })
        );

        expect(error._tag).toBe("CompilationError");

        // Verify branch and schema state were untouched
        const branchAfter = yield* oms.getBranch("feature/crash-branch");
        const schemaAfter = yield* oms.getSchema("feature/crash-branch");

        expect(branchAfter.revision).toBe(branchBefore.revision);
        expect(schemaAfter.objectTypes.size).toBe(initialTypeCount);
      })
    );
  });

  it("enforces tenant and environment non-disclosure (access denied without entity disclosure)", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const oms = new OntologyMetadataService();
        yield* oms.createBranch("feature/secure-branch", sampleAuthor);

        const agentContext: AgentContext = {
          actorId: "agent_42",
          environmentId: "staging",
          grants: ["author"],
          profile: "external-agent",
          sponsorId: "sponsor_1",
          tenantId: "tenant_alpha",
        };

        // Mismatched tenant must return Access denied without revealing branch existence
        const tenantError = yield* Effect.flip(
          oms.applyArtifact({
            agentContext,
            artifact: sampleArtifact,
            branch: "feature/secure-branch",
            expectedTenantId: "tenant_secret_bank",
          })
        );
        expect(tenantError._tag).toBe("AuthorizationError");
        expect((tenantError as AuthorizationError).reason).toBe(
          "Access denied"
        );

        // Mismatched environment must also return Access denied
        const envError = yield* Effect.flip(
          oms.applyArtifact({
            agentContext,
            artifact: sampleArtifact,
            branch: "feature/secure-branch",
            expectedEnvironmentId: "production",
          })
        );
        expect(envError._tag).toBe("AuthorizationError");
        expect((envError as AuthorizationError).reason).toBe("Access denied");
      })
    );
  });

  it("detects idempotency conflict on same key with different input", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const oms = new OntologyMetadataService();
        yield* oms.createBranch("feature/idemp-branch", sampleAuthor);

        // First application
        const firstReceipt = yield* oms.applyArtifact({
          artifact: sampleArtifact,
          branch: "feature/idemp-branch",
          idempotencyKey: "idem-key-99",
        });

        // Identical resubmission returns the same receipt
        const repeatReceipt = yield* oms.applyArtifact({
          artifact: sampleArtifact,
          branch: "feature/idemp-branch",
          idempotencyKey: "idem-key-99",
        });
        expect(repeatReceipt.candidateDigest).toBe(
          firstReceipt.candidateDigest
        );

        // Same key with different branch or artifact fails with IdempotencyConflictError
        const conflictError = yield* Effect.flip(
          oms.applyArtifact({
            artifact: {
              ...sampleArtifact,
              actions: [],
            },
            branch: "feature/idemp-branch",
            idempotencyKey: "idem-key-99",
          })
        );

        expect(conflictError._tag).toBe("IdempotencyConflictError");
      })
    );
  });
});

describe("V0-CH-03: Validate, Inspect, Diff, Review, and Publish Immutable Release", () => {
  it("ensures proposal never mutates active release", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const oms = new OntologyMetadataService();
        yield* oms.createBranch("feature/release-test", sampleAuthor);

        const receipt = yield* oms.applyArtifact({
          artifact: sampleArtifact,
          branch: "feature/release-test",
        });

        // Prior to publication, active release must be null
        const initialActive = yield* oms.getActiveRelease();
        expect(initialActive).toBeNull();

        // Create proposal
        const proposal = yield* oms.createProposal({
          author: sampleAuthor,
          candidateDigest: receipt.candidateDigest,
          changeSet: {
            addedActionTypes: [],
            addedLinkTypes: [],
            addedObjectTypes: [],
            deletedActionTypeIds: [],
            deletedLinkTypeIds: [],
            deletedObjectTypeIds: [],
            modifiedActionTypes: [],
            modifiedLinkTypes: [],
            modifiedObjectTypes: [],
          },
          description: "Emergency response ontology upgrade",
          sourceBranch: "feature/release-test",
          title: "Emergency Response V1",
        });

        expect(proposal.status).toBe("open");

        // Active release MUST STILL be null (proposal never mutates active release)
        const afterProposalActive = yield* oms.getActiveRelease();
        expect(afterProposalActive).toBeNull();
      })
    );
  });

  it("denies self-review and stale review", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const oms = new OntologyMetadataService();
        yield* oms.createBranch("feature/review-test", sampleAuthor);

        const receipt = yield* oms.applyArtifact({
          artifact: sampleArtifact,
          branch: "feature/review-test",
        });

        const proposal = yield* oms.createProposal({
          author: sampleAuthor,
          candidateDigest: receipt.candidateDigest,
          changeSet: {
            addedActionTypes: [],
            addedLinkTypes: [],
            addedObjectTypes: [],
            deletedActionTypeIds: [],
            deletedLinkTypeIds: [],
            deletedObjectTypeIds: [],
            modifiedActionTypes: [],
            modifiedLinkTypes: [],
            modifiedObjectTypes: [],
          },
          description: "Self review test",
          sourceBranch: "feature/review-test",
          title: "Test Self Approval",
        });

        // 1. Self review: Author attempts to review their own proposal
        const selfReview: ProposalReview = {
          comments: "Self approval attempt",
          reviewedAt: Date.now(),
          reviewer: sampleAuthor, // same as proposal.author
          verdict: "approve",
        };

        const selfError = yield* Effect.flip(
          oms.reviewProposal(proposal.id, selfReview)
        );
        expect(selfError._tag).toBe("SelfReviewDeniedError");

        // 2. Stale review: Reviewer targets a stale candidate digest
        const independentReview: ProposalReview = {
          comments: "Approved",
          reviewedAt: Date.now(),
          reviewer: sampleReviewer,
          verdict: "approve",
        };

        const staleError = yield* Effect.flip(
          oms.reviewProposal(proposal.id, independentReview, {
            expectedCandidateDigest: "stale_outdated_digest_12345",
          })
        );
        expect(staleError._tag).toBe("StaleReviewError");

        // Valid independent review succeeds
        const reviewedProposal = yield* oms.reviewProposal(
          proposal.id,
          independentReview,
          {
            expectedCandidateDigest: receipt.candidateDigest,
          }
        );
        expect(reviewedProposal.status).toBe("under_review");
      })
    );
  });

  it("publishes immutable release and recovers lost response via publication.get", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const oms = new OntologyMetadataService();
        yield* oms.createBranch("feature/pub-test", sampleAuthor);

        const receipt = yield* oms.applyArtifact({
          artifact: sampleArtifact,
          branch: "feature/pub-test",
        });

        const publisher: Subject = {
          id: "chief_architect",
          name: "Chief Architect",
          roles: ["lead_architect"],
          type: "user",
        };

        // Initial publish expects kind: "none"
        const pubReceipt = yield* oms.publishRelease({
          candidateDigest: receipt.candidateDigest,
          expectedCurrentRelease: { kind: "none" },
          idempotencyKey: "pub-idemp-101",
          publisher,
          reviewRefs: ["rev_approval_verified"],
        });

        expect(pubReceipt.status).toBe("published");
        expect(pubReceipt.release.revision).toBe(1);
        expect(pubReceipt.release.candidateDigest).toBe(
          receipt.candidateDigest
        );

        // Active release is now updated and immutable
        const active = yield* oms.getActiveRelease();
        expect(active).not.toBeNull();
        expect(active?.releaseId).toBe(pubReceipt.release.releaseId);

        // Recovery: lost response recovered by publication.get via publicationId
        const recoveredById = yield* oms.getPublication({
          publicationId: pubReceipt.publicationId,
        });
        expect(recoveredById.publicationId).toBe(pubReceipt.publicationId);
        expect(recoveredById.release.candidateDigest).toBe(
          receipt.candidateDigest
        );

        // Recovery: lost response recovered by publication.get via idempotencyKey
        const recoveredByKey = yield* oms.getPublication({
          idempotencyKey: "pub-idemp-101",
        });
        expect(recoveredByKey.publicationId).toBe(pubReceipt.publicationId);

        // Resubmitting publish with same idempotency key returns cached receipt
        const repeatPublish = yield* oms.publishRelease({
          candidateDigest: receipt.candidateDigest,
          expectedCurrentRelease: { kind: "none" },
          idempotencyKey: "pub-idemp-101",
          publisher,
          reviewRefs: ["rev_approval_verified"],
        });
        expect(repeatPublish.publicationId).toBe(pubReceipt.publicationId);

        // Conflict: publishing again with expectedCurrentRelease: { kind: "none" } fails with ReleaseConflictError
        const conflictError = yield* Effect.flip(
          oms.publishRelease({
            candidateDigest: receipt.candidateDigest,
            expectedCurrentRelease: { kind: "none" },
            publisher,
            reviewRefs: ["rev_approval_verified"],
          })
        );
        expect(conflictError._tag).toBe("ReleaseConflictError");

        // Conflict: publishing with same idempotency key but different candidate digest fails with IdempotencyConflictError
        const keyConflict = yield* Effect.flip(
          oms.publishRelease({
            candidateDigest: "different_candidate_digest",
            expectedCurrentRelease: { kind: "none" },
            idempotencyKey: "pub-idemp-101",
            publisher,
            reviewRefs: ["rev_approval_verified"],
          })
        );
        expect(keyConflict._tag).toBe("IdempotencyConflictError");
      })
    );
  });
});
