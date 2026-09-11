import { parseJson } from "@operon/schema";
import type { ObjectTypeId, Subject } from "@operon/schema";
import type { Schema } from "effect";
import { Effect, Exit } from "effect";

import { printCli, printCliError, printCliJson } from "../io.js";
import type { RuntimeContext } from "../state.js";
import { createRuntimeContext } from "../state.js";

function getFlagValue(
  args: readonly string[],
  flag: string
): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

function printSourceReceipt(receipt: {
  readonly batchId: string;
  readonly sourceArtifact: {
    readonly digest: string;
    readonly locator: string;
    readonly sourceId: string;
  };
  readonly status: string;
}): void {
  printCli(`Source artifact successfully ${receipt.status}:`);
  printCli(`  Source ID: ${receipt.sourceArtifact.sourceId}`);
  printCli(`  Batch ID: ${receipt.batchId}`);
  printCli(`  Locator: ${receipt.sourceArtifact.locator}`);
  printCli(`  Digest: ${receipt.sourceArtifact.digest}`);
  printCli(`  Status: ${receipt.status.toUpperCase()}`);
}

function printSourceList(
  sources: readonly {
    readonly batchId: string;
    readonly digest: string;
    readonly locator: string;
    readonly mediaType: string;
    readonly sourceId: string;
  }[]
): void {
  printCli(`Cataloged Sources (${sources.length}):`);
  for (const s of sources) {
    printCli(`  - [${s.sourceId}] ${s.locator} (${s.mediaType})`);
    printCli(`    Digest: ${s.digest}`);
    printCli(`    Batch: ${s.batchId}`);
  }
}

function printSourceDetails(source: {
  readonly batchId: string;
  readonly digest: string;
  readonly locator: string;
  readonly mediaType: string;
  readonly receivedAt: number;
  readonly sensitivity: string;
  readonly sourceId: string;
}): void {
  printCli(`Source: ${source.sourceId}`);
  printCli(`  Locator: ${source.locator}`);
  printCli(`  Media Type: ${source.mediaType}`);
  printCli(`  Digest: ${source.digest}`);
  printCli(`  Batch ID: ${source.batchId}`);
  printCli(`  Sensitivity: ${source.sensitivity}`);
  printCli(`  Received At: ${new Date(source.receivedAt).toISOString()}`);
}

function printProposalDetails(
  proposal: {
    readonly confidence: number;
    readonly proposalId: string;
    readonly records: readonly unknown[];
    readonly status: string;
  },
  targetObjectTypeId: string
): void {
  printCli(`Mapping Proposal Created: ${proposal.proposalId}`);
  printCli(`  Target Type: ${targetObjectTypeId}`);
  printCli(`  Candidate Records: ${proposal.records.length}`);
  printCli(`  Confidence: ${proposal.confidence}`);
  printCli(`  Status: ${proposal.status.toUpperCase()}`);
}

function printAdmittedDetails(admitted: {
  readonly proposalId: string;
  readonly records: readonly unknown[];
  readonly status: string;
}): void {
  printCli(
    `Mapping Proposal '${admitted.proposalId}' admitted successfully (S03 passed):`
  );
  printCli(`  Admitted Objects: ${admitted.records.length}`);
  printCli(`  Status: ${admitted.status.toUpperCase()}`);
}

function parseIngestFlags(args: readonly string[]) {
  const locator = getFlagValue(args, "--locator");
  const mediaType = getFlagValue(args, "--media-type");
  const rawPayloadStr = getFlagValue(args, "--payload");
  if (!locator || !mediaType || !rawPayloadStr) {
    return null;
  }
  return {
    idempotencyKey: getFlagValue(args, "--idempotency-key"),
    locator,
    mediaType,
    rawPayloadStr,
  };
}

const handleSourceIngest = Effect.fn("handleSourceIngest")(function* (
  ctx: RuntimeContext,
  args: readonly string[],
  tenantId: string | undefined,
  isJson: boolean
) {
  const flags = parseIngestFlags(args);
  if (!flags) {
    printCliError(
      "Error: Missing required flags for source ingest: --locator, --media-type, --payload"
    );
    printCliError(
      "  Usage: operon source ingest --locator <loc> --media-type <mime> --payload '<json>' [--idempotency-key <k>] [--tenant <t>] [--json]"
    );
    return 1;
  }

  const payloadExit = yield* Effect.try({
    catch: () => flags.rawPayloadStr,
    try: () => parseJson(flags.rawPayloadStr),
  }).pipe(Effect.exit);
  // SAFETY: JSON parse output conforms to Json structure
  const payload: Schema.Json = Exit.isSuccess(payloadExit)
    ? (payloadExit.value as Schema.Json)
    : flags.rawPayloadStr;

  const receipt = yield* ctx.ingestion
    .ingestRawSource({
      idempotencyKey: flags.idempotencyKey,
      locator: flags.locator,
      mediaType: flags.mediaType,
      rawPayload: payload,
      tenantId,
    })
    .pipe(
      Effect.catchTag("IdempotencyConflictError", (err) => {
        printCliError(`Error: Idempotency conflict: ${err.message}`);
        return Effect.void as Effect.Effect<undefined>;
      }),
      Effect.catchTag("CorruptInputError", (err) => {
        printCliError(`Error: Corrupt input: ${err.reason}`);
        return Effect.void as Effect.Effect<undefined>;
      })
    );

  if (!receipt) {
    return 1;
  }

  if (isJson) {
    printCliJson(receipt);
  } else {
    printSourceReceipt(receipt);
  }
  return 0;
});

const handleSourceList = Effect.fn("handleSourceList")(function* (
  ctx: RuntimeContext,
  tenantId: string | undefined,
  isJson: boolean
) {
  const sources = yield* ctx.ingestion.listSources(tenantId);
  if (isJson) {
    printCliJson(sources);
  } else {
    printSourceList(sources);
  }
  return 0;
});

const handleSourceGet = Effect.fn("handleSourceGet")(function* (
  ctx: RuntimeContext,
  sourceId: string | undefined,
  tenantId: string | undefined,
  isJson: boolean
) {
  if (!sourceId) {
    printCliError(
      "Error: Missing source ID. Usage: operon source get <sourceId> [--tenant <t>] [--json]"
    );
    return 1;
  }

  const source = yield* ctx.ingestion.getSource(sourceId, tenantId).pipe(
    Effect.catchTag("UnknownSourceError", (err) => {
      printCliError(`Error: Source '${err.sourceId}' not found.`);
      return Effect.void as Effect.Effect<undefined>;
    })
  );

  if (!source) {
    return 1;
  }

  if (isJson) {
    printCliJson(source);
  } else {
    printSourceDetails(source);
  }
  return 0;
});

function normalizeMappings(
  rawMappings:
    | Record<string, string>
    | readonly {
        readonly sourceField: string;
        readonly targetPropertyName: string;
      }[]
): readonly {
  readonly sourceField: string;
  readonly targetPropertyName: string;
}[] {
  if (Array.isArray(rawMappings)) {
    return rawMappings;
  }
  return Object.entries(rawMappings).map(
    ([sourceField, targetPropertyName]) => ({
      sourceField,
      targetPropertyName,
    })
  );
}

function parseProposeMappingFlags(args: readonly string[]) {
  const sourcesStr = getFlagValue(args, "--sources");
  const targetTypeStr = getFlagValue(args, "--target-type");
  const pkField = getFlagValue(args, "--pk");
  const mappingsStr = getFlagValue(args, "--mappings");
  const defDigest = getFlagValue(args, "--definition");
  if (!sourcesStr || !targetTypeStr || !pkField || !mappingsStr || !defDigest) {
    return null;
  }
  // SAFETY: string flag passed from CLI is treated as ObjectTypeId
  const targetObjectTypeId = targetTypeStr as ObjectTypeId;
  // SAFETY: mappings JSON flag is parsed and normalized to { sourceField, targetPropertyName }[]
  const rawMappings = JSON.parse(mappingsStr) as
    | Record<string, string>
    | readonly {
        readonly sourceField: string;
        readonly targetPropertyName: string;
      }[];
  const propertyMappings = normalizeMappings(rawMappings);
  const sourceIds = sourcesStr.split(",").map((s) => s.trim());
  return {
    definitionDigest: defDigest,
    primaryKeyField: pkField,
    propertyMappings,
    sourceIds,
    targetObjectTypeId,
  };
}

const handleSourceProposeMapping = Effect.fn("handleSourceProposeMapping")(
  function* (
    ctx: RuntimeContext,
    args: readonly string[],
    tenantId: string | undefined,
    isJson: boolean
  ) {
    const flags = parseProposeMappingFlags(args);
    if (!flags) {
      printCliError(
        "Error: Missing required flags for propose-mapping: --sources, --target-type, --pk, --mappings, --definition"
      );
      return 1;
    }

    const author: Subject = {
      id: "cli_agent",
      name: "CLI Operator",
      roles: ["fde_agent"],
      type: "agent",
    };

    const proposal = yield* ctx.ingestion
      .proposeMapping({
        author,
        definitionDigest: flags.definitionDigest,
        primaryKeyField: flags.primaryKeyField,
        propertyMappings: flags.propertyMappings,
        sourceIds: flags.sourceIds,
        targetObjectTypeId: flags.targetObjectTypeId,
        tenantId,
      })
      .pipe(
        Effect.catchTag("UnknownSourceError", (err) => {
          printCliError(`Error: Source '${err.sourceId}' not found.`);
          return Effect.void as Effect.Effect<undefined>;
        }),
        Effect.catchTag("ContradictoryInputError", (err) => {
          printCliError(
            `Error: Contradictory input for record '${err.recordId}': ${err.reason}`
          );
          return Effect.void as Effect.Effect<undefined>;
        })
      );

    if (!proposal) {
      return 1;
    }

    if (isJson) {
      printCliJson(proposal);
    } else {
      printProposalDetails(proposal, flags.targetObjectTypeId);
    }
    return 0;
  }
);

const handleSourceAdmitMapping = Effect.fn("handleSourceAdmitMapping")(
  function* (
    ctx: RuntimeContext,
    proposalId: string | undefined,
    isJson: boolean
  ) {
    if (!proposalId) {
      printCliError(
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

    const admitted = yield* ctx.ingestion
      .admitProposal(proposalId, author)
      .pipe(
        Effect.catchTag("UnknownSourceError", (err) => {
          printCliError(`Error: Proposal '${err.sourceId}' not found.`);
          return Effect.void as Effect.Effect<undefined>;
        }),
        Effect.catchTag("ConcurrentModificationError", (err) => {
          printCliError(
            `Error: Concurrent modification conflict during admission: ${err.message}`
          );
          return Effect.void as Effect.Effect<undefined>;
        })
      );

    if (!admitted) {
      return 1;
    }

    if (isJson) {
      printCliJson(admitted);
    } else {
      printAdmittedDetails(admitted);
    }
    return 0;
  }
);

interface ExecuteSourceOptions {
  readonly action?: string;
  readonly args: readonly string[];
  readonly ctx: RuntimeContext;
  readonly isJson: boolean;
  readonly tenantId?: string;
}

const executeSource = Effect.fn("executeSource")(function* (
  options: ExecuteSourceOptions
) {
  const { action, args, ctx, isJson, tenantId } = options;
  if (action === "ingest") {
    return yield* handleSourceIngest(ctx, args, tenantId, isJson);
  }
  if (action === "list") {
    return yield* handleSourceList(ctx, tenantId, isJson);
  }
  if (action === "get") {
    return yield* handleSourceGet(ctx, args[1], tenantId, isJson);
  }
  if (action === "propose-mapping") {
    return yield* handleSourceProposeMapping(ctx, args, tenantId, isJson);
  }
  if (action === "admit-mapping") {
    return yield* handleSourceAdmitMapping(ctx, args[1], isJson);
  }

  printCliError(
    `Unknown source action: ${action}. Use 'ingest', 'list', 'get', 'propose-mapping', or 'admit-mapping'.`
  );
  return 1;
});

export function runSource(args: string[]): Effect.Effect<number> {
  const action = args[0];
  const isJson = args.includes("--json");
  const dbPath = getFlagValue(args, "--db");
  const tenantId = getFlagValue(args, "--tenant");

  return Effect.acquireUseRelease(
    Effect.promise(() => createRuntimeContext(dbPath)),
    (ctx) => executeSource({ action, args, ctx, isJson, tenantId }),
    (ctx) => Effect.sync(() => ctx.close())
  );
}
