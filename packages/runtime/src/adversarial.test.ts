import { createHmac } from "node:crypto";

import type {
  MultiDatasetObjectMapping,
  ObjectTypeId,
  RestrictedView,
  Subject,
} from "@operon/schema";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { HttpAuthMiddleware, OidcTokenVerifier } from "./auth.js";
import { InMemoryObjectStore } from "./object-store.js";
import { DynamicSecurityEngine } from "./security-views.js";

describe("Kernel-Level Adversarial Security & Invariant Testing", () => {
  it("Adversarial MDO Leak Resistance: Zero cell-level data leakage across 50 objects", async () => {
    const store = new InMemoryObjectStore();
    const typeId = "FinancialAccount" as ObjectTypeId;

    // Create 50 financial records with sensitive balances, SSNs, and public names
    const initItems: ObjectInstance[] = Array.from({ length: 50 }, (_, i) => ({
      id: `fa-${i}`,
      lastModifiedAt: Date.now(),
      properties: {
        accountHolder: `User ${i}`,
        balanceSecret: 10000 + i * 500,
        publicTier: "Standard",
        ssnTaxId: `000-12-${1000 + i}`,
      },
      typeId,
      validFrom: Date.now(),
      version: 1,
    }));

    await Effect.runPromise(
      Effect.all(
        initItems.map((item) => store.putObject(item)),
        { concurrency: 10 }
      )
    );

    const mapping: MultiDatasetObjectMapping = {
      authorizedRolesPerClassification: {
        confidential: ["compliance_officer"],
        internal: ["employee"],
        pii: ["dpo_officer"],
        public: ["public_user", "analyst"],
        restricted: ["cfo"],
      },
      datasetSources: {
        accountHolder: "crm",
        balanceSecret: "ledger",
        publicTier: "marketing",
        ssnTaxId: "tax_authority",
      },
      objectTypeId: typeId,
      propertyClassifications: {
        accountHolder: "public",
        balanceSecret: "confidential",
        publicTier: "public",
        ssnTaxId: "pii",
      },
    };

    const securityEngine = new DynamicSecurityEngine();
    securityEngine.registerMdoMapping(mapping);

    // Untrusted / Low-Privilege persona (only has 'analyst' role)
    const lowPrivSubject: Subject = {
      id: "analyst-1",
      name: "External Analyst",
      roles: ["analyst"],
      type: "user",
    };

    const allObjects = await Effect.runPromise(store.findObjects(typeId));
    const maskedObjects = allObjects.map((obj) =>
      securityEngine.projectInstance(obj, lowPrivSubject)
    );

    expect(maskedObjects.length).toBe(50);

    // Invariant: Across all 50 objects, NOT A SINGLE PII OR CONFIDENTIAL CELL IS LEAKED
    for (const obj of maskedObjects) {
      expect(obj.properties.publicTier).toBe("Standard");
      expect(obj.properties.accountHolder).toBeDefined();

      // PII and Confidential fields MUST be redacted
      expect(obj.properties.ssnTaxId).toBe("[REDACTED_BY_SECURITY_POLICY]");
      expect(obj.properties.balanceSecret).toBe(
        "[REDACTED_BY_SECURITY_POLICY]"
      );
    }
  });

  it("Cryptographic Bit-Flip Attack: Fails on single-bit corrupted JWT signatures", async () => {
    const secret = "kernel-tamper-proof-secret-999";
    const verifier = new OidcTokenVerifier({
      secretOrPublicKey: secret,
    });
    const middleware = new HttpAuthMiddleware(verifier);

    const header = Buffer.from(
      JSON.stringify({ alg: "HS256", typ: "JWT" })
    ).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        aud: "operon",
        exp: Math.floor(Date.now() / 1000) + 3600,
        roles: ["admin"],
        sub: "hacker",
      })
    ).toString("base64url");

    const validSig = createHmac("sha256", secret)
      .update(`${header}.${payload}`)
      .digest("base64url");

    // 1. Verify that the uncorrupted token succeeds
    const validToken = `${header}.${payload}.${validSig}`;
    const validRes = await Effect.runPromise(
      middleware.authenticateHeader(`Bearer ${validToken}`)
    );
    expect(validRes.subject.id).toBe("hacker");

    // 2. Adversarial Bit Flip: Invert first character in signature
    const corruptedFirstChar = validSig[0] === "A" ? "B" : "A";
    const tamperedSig = corruptedFirstChar + validSig.slice(1);
    const tamperedToken = `${header}.${payload}.${tamperedSig}`;

    const tamperedRes = await Effect.runPromise(
      middleware
        .authenticateHeader(`Bearer ${tamperedToken}`)
        .pipe(Effect.result)
    );

    // Invariant: Cryptographic tamper attempt must fail with AuthenticationError
    expect(tamperedRes._tag).toBe("Failure");
  });

  it("Restricted View (RV) Isolation: Row-level tenant boundary cannot be breached", async () => {
    const store = new InMemoryObjectStore();
    const typeId = "TenantAsset" as ObjectTypeId;

    // Assets belonging to Tenant Alpha and Tenant Beta
    await Effect.runPromise(
      store.putObject({
        id: "asset-alpha-1",
        lastModifiedAt: Date.now(),
        properties: { tenant: "alpha", value: 1000 },
        typeId,
        validFrom: Date.now(),
        version: 1,
      })
    );
    await Effect.runPromise(
      store.putObject({
        id: "asset-beta-1",
        lastModifiedAt: Date.now(),
        properties: { tenant: "beta", value: 5000 },
        typeId,
        validFrom: Date.now(),
        version: 1,
      })
    );

    const tenantRv: RestrictedView = {
      description: "Restricts viewing to objects matching user's tenantId",
      id: "rv_tenant_isolation",
      name: "Tenant Isolation RV",
      objectTypeId: typeId,
      predicate: (instance, subject) =>
        instance.properties.tenant === subject.metadata?.tenantId,
    };

    const securityEngine = new DynamicSecurityEngine();
    securityEngine.registerRestrictedView(tenantRv);

    const alphaUser: Subject = {
      id: "user-alpha",
      metadata: { tenantId: "alpha" },
      name: "Alpha User",
      roles: ["member"],
      type: "user",
    };

    const allObjects = await Effect.runPromise(store.findObjects(typeId));
    const filtered = securityEngine.filterInstances(allObjects, alphaUser);

    // Invariant: User Alpha can ONLY see Alpha assets, Beta is strictly invisible
    expect(filtered.length).toBe(1);
    expect(filtered[0].id).toBe("asset-alpha-1");
    expect(filtered.some((o) => o.properties.tenant === "beta")).toBe(false);
  });
});
