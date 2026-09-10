import type { ObjectTypeId, Subject } from "@operon/schema";
import { Effect } from "effect";

import { createRuntimeContext } from "../state.js";

export function runSource(
  args: string[]
): Effect.Effect<number, unknown, never> {
  return Effect.gen(function* () {
    const action = args[0];
    const isJson = args.includes("--json");

    const dbIndex = args.indexOf("--db");
    const dbPath = dbIndex === -1 ? undefined : args[dbIndex + 1];

    const ctx = yield* Effect.promise(() => createRuntimeContext(dbPath));
    const ingestion = ctx.ingestion;

    const tenantIndex = args.indexOf("--tenant");
    const tenantId = tenantIndex === -1 ? undefined : args[tenantIndex + 1];

    try {
      if (action === "ingest") {
        const locatorIndex = args.indexOf("--locator");
        const mediaTypeIndex = args.indexOf("--media-type");
        const payloadIndex = args.indexOf("--payload");
        const idempIndex = args.indexOf("--idempotency-key");

        if (
          locatorIndex === -1 ||
          mediaTypeIndex === -1 ||
          payloadIndex === -1
        ) {
          console.error(
            "Error: Missing required flags for source ingest: --locator, --media-type, --payload"
          );
          console.error(
            "  Usage: operon source ingest --locator <loc> --media-type <mime> --payload '<json>' [--idempotency-key <k>] [--tenant <t>] [--json]"
          );
          return 1;
        }

        const locator = args[locatorIndex + 1];
        const mediaType = args[mediaTypeIndex + 1];
        const rawPayloadStr = args[payloadIndex + 1];
        const idempotencyKey =
          idempIndex === -1 ? undefined : args[idempIndex + 1];

        let payload: unknown;
        try {
          payload = JSON.parse(rawPayloadStr);
        } catch {
          payload = rawPayloadStr;
        }

        const receipt = yield* ingestion
          .ingestRawSource({
            idempotencyKey,
            locator,
            mediaType,
            rawPayload: payload,
            tenantId,
          })
          .pipe(
            Effect.catchTag("IdempotencyConflictError", (err) => {
              console.error(`Error: Idempotency conflict: ${err.message}`);
              return Effect.succeed(undefined);
            }),
            Effect.catchTag("CorruptInputError", (err) => {
              console.error(`Error: Corrupt input: ${err.reason}`);
              return Effect.succeed(undefined);
            })
          );

        if (!receipt) return 1;

        if (isJson) {
          console.log(JSON.stringify(receipt, null, 2));
        } else {
          console.log(`Source artifact successfully ${receipt.status}:`);
          console.log(`  Source ID: ${receipt.sourceArtifact.sourceId}`);
          console.log(`  Batch ID: ${receipt.batchId}`);
          console.log(`  Locator: ${receipt.sourceArtifact.locator}`);
          console.log(`  Digest: ${receipt.sourceArtifact.digest}`);
          console.log(`  Status: ${receipt.status.toUpperCase()}`);
        }
        return 0;
      }

      if (action === "list") {
        const sources = yield* ingestion.listSources(tenantId);
        if (isJson) {
          console.log(JSON.stringify(sources, null, 2));
        } else {
          console.log(`Cataloged Sources (${sources.length}):`);
          for (const s of sources) {
            console.log(`  - [${s.sourceId}] ${s.locator} (${s.mediaType})`);
            console.log(`    Digest: ${s.digest}`);
            console.log(`    Batch: ${s.batchId}`);
          }
        }
        return 0;
      }

      if (action === "get") {
        const sourceId = args[1];
        if (!sourceId) {
          console.error(
            "Error: Missing source ID. Usage: operon source get <sourceId> [--tenant <t>] [--json]"
          );
          return 1;
        }

        const source = yield* ingestion.getSource(sourceId, tenantId).pipe(
          Effect.catchTag("UnknownSourceError", (err) => {
            console.error(`Error: Source '${err.sourceId}' not found.`);
            return Effect.succeed(undefined);
          })
        );

        if (!source) return 1;

        if (isJson) {
          console.log(JSON.stringify(source, null, 2));
        } else {
          console.log(`Source: ${source.sourceId}`);
          console.log(`  Locator: ${source.locator}`);
          console.log(`  Media Type: ${source.mediaType}`);
          console.log(`  Digest: ${source.digest}`);
          console.log(`  Batch ID: ${source.batchId}`);
          console.log(`  Sensitivity: ${source.sensitivity}`);
          console.log(
            `  Received At: ${new Date(source.receivedAt).toISOString()}`
          );
        }
        return 0;
      }

      if (action === "propose-mapping") {
        const sourcesIndex = args.indexOf("--sources");
        const targetTypeIndex = args.indexOf("--target-type");
        const pkIndex = args.indexOf("--pk");
        const mappingsIndex = args.indexOf("--mappings");
        const defIndex = args.indexOf("--definition");

        if (
          sourcesIndex === -1 ||
          targetTypeIndex === -1 ||
          pkIndex === -1 ||
          mappingsIndex === -1 ||
          defIndex === -1
        ) {
          console.error(
            "Error: Missing required flags for propose-mapping: --sources, --target-type, --pk, --mappings, --definition"
          );
          return 1;
        }

        const sourceIds = args[sourcesIndex + 1]
          .split(",")
          .map((s) => s.trim());
        const targetObjectTypeId = args[targetTypeIndex + 1] as ObjectTypeId;
        const primaryKeyField = args[pkIndex + 1];
        const propertyMappings = JSON.parse(args[mappingsIndex + 1]);
        const definitionDigest = args[defIndex + 1];

        const author: Subject = {
          id: "cli_agent",
          name: "CLI Operator",
          roles: ["fde_agent"],
          type: "agent",
        };

        const proposal = yield* ingestion
          .proposeMapping({
            author,
            definitionDigest,
            primaryKeyField,
            propertyMappings,
            sourceIds,
            targetObjectTypeId,
            tenantId,
          })
          .pipe(
            Effect.catchTag("UnknownSourceError", (err) => {
              console.error(`Error: Source '${err.sourceId}' not found.`);
              return Effect.succeed(undefined);
            }),
            Effect.catchTag("ContradictoryInputError", (err) => {
              console.error(
                `Error: Contradictory input for record '${err.recordId}': ${err.reason}`
              );
              return Effect.succeed(undefined);
            })
          );

        if (!proposal) return 1;

        if (isJson) {
          console.log(JSON.stringify(proposal, null, 2));
        } else {
          console.log(`Mapping Proposal Created: ${proposal.proposalId}`);
          console.log(`  Target Type: ${targetObjectTypeId}`);
          console.log(`  Candidate Records: ${proposal.records.length}`);
          console.log(`  Confidence: ${proposal.confidence}`);
          console.log(`  Status: ${proposal.status.toUpperCase()}`);
        }
        return 0;
      }

      if (action === "admit-mapping") {
        const proposalId = args[1];
        if (!proposalId) {
          console.error(
            "Error: Missing proposal ID. Usage: operon source admit-mapping <proposalId> [--json]"
          );
          return 1;
        }

        const author: Subject = {
          id: "cli_admin",
          name: "CLI Administrator",
          roles: ["admin"],
          type: "user",
        };

        const admitted = yield* ingestion
          .admitProposal(proposalId, author)
          .pipe(
            Effect.catchTag("UnknownSourceError", (err) => {
              console.error(`Error: Proposal '${err.sourceId}' not found.`);
              return Effect.succeed(undefined);
            }),
            Effect.catchTag("ConcurrentModificationError", (err) => {
              console.error(
                `Error: Concurrent modification conflict during admission: ${err.message}`
              );
              return Effect.succeed(undefined);
            })
          );

        if (!admitted) return 1;

        if (isJson) {
          console.log(JSON.stringify(admitted, null, 2));
        } else {
          console.log(
            `Mapping Proposal '${admitted.proposalId}' admitted successfully (S03 passed):`
          );
          console.log(`  Admitted Objects: ${admitted.records.length}`);
          console.log(`  Status: ${admitted.status.toUpperCase()}`);
        }
        return 0;
      }

      console.error(
        `Unknown source action: ${action}. Use 'ingest', 'list', 'get', 'propose-mapping', or 'admit-mapping'.`
      );
      return 1;
    } finally {
      ctx.close();
    }
  });
}
