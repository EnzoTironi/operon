import type { ObjectTypeId } from "@operon/schema";
import type { Schema } from "effect";
import { Clock, Effect, Exit } from "effect";

import type {
  FunnelIngestionError,
  FunnelService,
  PipelineNotFoundError,
} from "./funnel.js";

export interface DebeziumSourceMeta {
  readonly version?: string;
  readonly connector?: string;
  readonly name?: string;
  readonly ts_ms: number;
  readonly db: string;
  readonly table: string;
  readonly lsn?: number;
  readonly txId?: string;
}

export type DebeziumCdcPayload =
  | {
      readonly op: "c" | "r"; // create, read (snapshot)
      readonly before?: Record<string, Schema.Json> | null;
      readonly after: Record<string, Schema.Json>;
      readonly source: DebeziumSourceMeta;
      readonly ts_ms: number;
    }
  | {
      readonly op: "u"; // update
      readonly before?: Record<string, Schema.Json> | null;
      readonly after: Record<string, Schema.Json>;
      readonly source: DebeziumSourceMeta;
      readonly ts_ms: number;
    }
  | {
      readonly op: "d"; // delete
      readonly before: Record<string, Schema.Json>;
      readonly after?: Record<string, Schema.Json> | null;
      readonly source: DebeziumSourceMeta;
      readonly ts_ms: number;
    };

export interface DebeziumCdcMessage {
  readonly schema?: unknown;
  readonly payload: DebeziumCdcPayload;
}

export interface CdcTableMapping {
  readonly pipelineId: string;
  readonly targetTypeId: ObjectTypeId;
  readonly primaryKeyField: string;
  readonly propertyTransform?: (
    raw: Record<string, Schema.Json>
  ) => Record<string, Schema.Json>;
}

export interface CdcConnectorStats {
  readonly processedCount: number;
  readonly lastLsn?: number;
  readonly lastTimestampMs: number;
  readonly errorsCount: number;
}

/**
 * Physical Kafka / Debezium CDC Connector for Streaming Operational Ingestion into the Funnel
 */
export class KafkaCdcConnector {
  private readonly tableMappings = new Map<string, CdcTableMapping>();
  private processedCount = 0;
  private errorsCount = 0;
  private lastLsn: number | undefined;
  private lastTimestampMs = 0;

  public constructor(private readonly funnel: FunnelService) {}

  public registerTableMapping(
    tableName: string,
    mapping: CdcTableMapping
  ): void {
    this.tableMappings.set(tableName.toLowerCase(), mapping);
  }

  /**
   * Consumes a single Debezium CDC message and routes it through the Funnel
   */
  public readonly consumeMessage = Effect.fn(
    "DebeziumPostgresConnector.consumeMessage"
  )(function* (
    this: KafkaCdcConnector,
    message: DebeziumCdcMessage
  ): Effect.fn.Return<void, PipelineNotFoundError | FunnelIngestionError> {
    const { payload } = message;
    const tableName = payload.source.table.toLowerCase();
    const mapping = this.tableMappings.get(tableName);

    if (!mapping) {
      // Table not registered for replication
      return;
    }

    this.lastTimestampMs = payload.ts_ms;
    if (payload.source.lsn !== undefined) {
      this.lastLsn = payload.source.lsn;
    }

    // Handle deletes
    if (payload.op === "d") {
      if (!payload.before) {
        return;
      }
      const row = payload.before;
      const properties = mapping.propertyTransform
        ? mapping.propertyTransform(row)
        : row;
      yield* this.funnel
        .ingestStreamRecord(mapping.pipelineId, {
          ...properties,
          _deleted: true,
        })
        .pipe(
          Effect.tapError(() =>
            Effect.sync(() => {
              this.errorsCount++;
            })
          )
        );
      this.processedCount++;
      return;
    }

    // Handle create, update, snapshot read
    const row = payload.after;
    if (!row) {
      return;
    }

    const properties = mapping.propertyTransform
      ? mapping.propertyTransform(row)
      : row;

    yield* this.funnel.ingestStreamRecord(mapping.pipelineId, properties).pipe(
      Effect.tapError(() =>
        Effect.sync(() => {
          this.errorsCount++;
        })
      )
    );

    this.processedCount++;
  });

  public getStats(): CdcConnectorStats {
    return {
      processedCount: this.processedCount,
      lastLsn: this.lastLsn,
      lastTimestampMs: this.lastTimestampMs,
      errorsCount: this.errorsCount,
    };
  }
}

export interface BatchIngestOptions {
  readonly pipelineId: string;
  readonly targetTypeId: ObjectTypeId;
  readonly chunkSize?: number;
  readonly sourceSystem: string;
}

export interface BatchIngestReport {
  readonly totalRecords: number;
  readonly chunksProcessed: number;
  readonly durationMs: number;
  readonly errors: readonly string[];
}

/**
 * Enterprise Warehouse Batch Connector (Snowflake / Databricks / BigQuery / S3 Tabular dumps)
 */
export class WarehouseBatchConnector {
  public constructor(private readonly funnel: FunnelService) {}

  /**
   * Ingests a large array of records in chunks with backpressure and funnel conflict resolution
   */
  public ingestBatch(
    records: readonly Record<string, Schema.Json>[],
    options: BatchIngestOptions
  ): Effect.Effect<BatchIngestReport> {
    const chunkSize = options.chunkSize ?? 100;

    return Effect.gen({ self: this }, function* () {
      const startTime = yield* Clock.currentTimeMillis;
      let chunksProcessed = 0;
      const errors: string[] = [];

      const chunkCount = Math.ceil(records.length / chunkSize);
      const chunkIndices = Array.from({ length: chunkCount }, (_, i) => i);

      const { funnel } = this;
      yield* Effect.forEach(
        chunkIndices,
        Effect.fn("ContractedConnector.processChunk")(function* (currentChunk) {
          const start = currentChunk * chunkSize;
          const slice = records.slice(start, start + chunkSize);
          const res = yield* funnel
            .ingestBatch(options.pipelineId, slice)
            .pipe(Effect.exit);

          if (Exit.isFailure(res)) {
            errors.push(`Chunk ${currentChunk} failed: ${String(res.cause)}`);
          }

          chunksProcessed++;
        }),
        { concurrency: 1 }
      );

      const endTime = yield* Clock.currentTimeMillis;
      const report: BatchIngestReport = {
        chunksProcessed,
        durationMs: endTime - startTime,
        errors,
        totalRecords: records.length,
      };
      return report;
    });
  }
}
