import { readFile } from "node:fs/promises";
import path from "node:path";

import type { ObjectInstance } from "@operon/schema";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { AccountableIngestionService, FunnelService } from "./funnel.js";
import {
  ingestFromGateway,
  memoryHostSecretStore,
  pollGmailMailbox,
  recordedGmailMailbox,
} from "./gateway-ingestion.js";
import { InMemoryObjectStore } from "./object-store.js";

const STUB_TOKEN = "ya29.stub-readonly-token-must-not-leak";

const secrets = memoryHostSecretStore({
  "gmail.oauth.client_secret": "client-stub",
  "gmail.oauth.refresh_token": STUB_TOKEN,
});

class CountingObjectStore extends InMemoryObjectStore {
  putObjectCalls = 0;

  override putObject(
    instance: ObjectInstance
  ): ReturnType<InMemoryObjectStore["putObject"]> {
    this.putObjectCalls += 1;
    return super.putObject(instance);
  }
}

describe("Gmail poll into quarantine", () => {
  it("produces a SourceArtifact and Q items from a readonly poll", async () => {
    const store = new CountingObjectStore();
    const ingestion = new AccountableIngestionService(store);

    const result = await Effect.runPromise(
      pollGmailMailbox({
        idempotencyKey: "gmail-poll-clinic-1",
        ingestion,
        mailbox: recordedGmailMailbox,
        secrets,
        tenantId: "clinic",
      })
    );

    expect(result._tag).toBe("ingested");
    if (result._tag !== "ingested") {
      return;
    }
    expect(result.receipt.status).toBe("ingested");
    expect(result.receipt.sourceArtifact.locator).toBe(
      "gmail://me/users.messages.list"
    );
    expect(
      JSON.stringify(result.receipt.sourceArtifact).includes(STUB_TOKEN)
    ).toBe(false);

    const sources = await Effect.runPromise(ingestion.listSources("clinic"));
    expect(sources).toHaveLength(1);
    expect(sources[0]?.sourceId).toBe(result.receipt.sourceArtifact.sourceId);

    const hits = await Effect.runPromise(
      ingestion.searchQuarantine({ tenantId: "clinic" })
    );
    expect(hits).toHaveLength(3);
    expect(hits.every((hit) => hit.admission.grade === "quarantine")).toBe(
      true
    );
    expect(
      hits.some((hit) => JSON.stringify(hit.item).includes("Ana Silva"))
    ).toBe(true);
    expect(store.putObjectCalls).toBe(0);
  });

  it("does not reach ingestBatch, putObject, or write-pipeline step 7 for send/modify", async () => {
    const store = new CountingObjectStore();
    const ingestion = new AccountableIngestionService(store);
    const funnel = new FunnelService(store);
    let ingestBatchCalls = 0;
    const originalIngestBatch = funnel.ingestBatch;
    funnel.ingestBatch = ((pipelineId, records) => {
      ingestBatchCalls += 1;
      return originalIngestBatch.call(funnel, pipelineId, records);
    }) as typeof funnel.ingestBatch;

    const result = await Effect.runPromise(
      ingestFromGateway({
        idempotencyKey: "gmail-send-must-not-ingest",
        ingestion,
        readExecutor: () =>
          Effect.die(new Error("read executor must not run for send")),
        request: {
          arguments: { raw: "to:ana@unimed.com.br" },
          connectorId: "gmail-readonly",
          connectorKind: "gmail",
          method: "POST",
          operation: "users.messages.send",
        },
      })
    );

    expect(result._tag).toBe("writeCandidate");
    if (result._tag === "writeCandidate") {
      expect(result.candidate.reason).toBe("email_send_or_modify");
    }

    const sources = await Effect.runPromise(ingestion.listSources("clinic"));
    expect(sources).toEqual([]);
    expect(ingestBatchCalls).toBe(0);
    expect(store.putObjectCalls).toBe(0);

    const sourceText = await readFile(
      path.join(import.meta.dirname, "gateway-ingestion.ts"),
      "utf-8"
    );
    expect(sourceText.includes("FunnelService")).toBe(false);
    expect(sourceText.includes("putObject")).toBe(false);
    expect(sourceText.includes("executeWritePipeline")).toBe(false);
  });
});
