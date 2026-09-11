import type { IntentGrant } from "@operon/schema";
import { Predicate } from "effect";
import type { Schema } from "effect";

export type ViewLifecycleState =
  | "ACCEPTED"
  | "PROPOSED"
  | "RUNNING"
  | "CONFIRMED"
  | "HYPOTHETICAL";

export type ViewRecord = Record<string, Schema.Json>;

export interface GenerateViewOptions {
  readonly title: string;
  readonly state: ViewLifecycleState;
  readonly data: ViewRecord | readonly ViewRecord[];
  readonly grant?: IntentGrant;
  readonly audience?: string;
  readonly format?: "markdown" | "table" | "card" | "json";
}

export interface DisposableGeneratedView {
  readonly id: string;
  readonly title: string;
  readonly state: ViewLifecycleState;
  readonly isDisposable: true;
  readonly sourceOfTruth: "OPERON_KERNEL";
  readonly rendered: string;
  readonly filteredPropertiesCount: number;
  readonly generatedAt: number;
}

export interface AttenuatedResult {
  readonly filtered: ViewRecord;
  readonly prunedCount: number;
}

function isAudienceUnauthorized(
  grant: IntentGrant,
  audience?: string
): boolean {
  if (!audience || grant.destinationAudiences.length === 0) {
    return false;
  }
  return (
    !grant.destinationAudiences.includes(audience) &&
    !grant.destinationAudiences.includes("*")
  );
}

const PII_KEY_REGEX = /ssn|secret|token|password|credential|private_key/iu;
const PII_CONDITION_REGEX = /mask_pii|no_pii|sanitize/iu;

function shouldMaskKey(key: string, grant: IntentGrant): boolean {
  if (!PII_KEY_REGEX.test(key)) {
    return false;
  }
  return grant.dataUseConditions.some((c: string) =>
    PII_CONDITION_REGEX.test(c)
  );
}

/**
 * Filter data object according to IntentGrant data-use conditions and destination audience (S06, S13)
 */
function attenuateProperties(
  obj: ViewRecord,
  grant?: IntentGrant,
  audience?: string
): AttenuatedResult {
  if (!grant) {
    return { filtered: { ...obj }, prunedCount: 0 };
  }

  if (isAudienceUnauthorized(grant, audience)) {
    return { filtered: {}, prunedCount: Object.keys(obj).length };
  }

  let prunedCount = 0;
  const filtered: ViewRecord = {};

  for (const [key, value] of Object.entries(obj)) {
    if (shouldMaskKey(key, grant)) {
      filtered[key] = "[REDACTED_BY_GRANT]";
      prunedCount++;
    } else {
      filtered[key] = value;
    }
  }

  return { filtered, prunedCount };
}

function formatTableCell(val: Schema.Json | undefined): string {
  if (val === undefined || val === null) {
    return "";
  }
  return Predicate.isObject(val) ? JSON.stringify(val) : String(val);
}

/**
 * Render Markdown Table from rows
 */
function renderMarkdownTable(rows: readonly ViewRecord[]): string {
  if (rows.length === 0) {
    return "*No records to display.*";
  }
  const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const header = `| ${columns.join(" | ")} |`;
  const separator = `| ${columns.map(() => "---").join(" | ")} |`;
  const lines = rows.map(
    (r) => `| ${columns.map((col) => formatTableCell(r[col])).join(" | ")} |`
  );
  return [header, separator, ...lines].join("\n");
}

export interface AttenuatedDataset {
  readonly processedData: ViewRecord | readonly ViewRecord[];
  readonly prunedTotal: number;
}

function isViewRecordArray(
  data: ViewRecord | readonly ViewRecord[]
): data is readonly ViewRecord[] {
  return Array.isArray(data);
}

function attenuateDataset(
  data: ViewRecord | readonly ViewRecord[],
  grant?: IntentGrant,
  audience?: string
): AttenuatedDataset {
  if (isViewRecordArray(data)) {
    const attenuatedRows: ViewRecord[] = [];
    let prunedTotal = 0;
    for (const row of data) {
      const { filtered, prunedCount } = attenuateProperties(
        row,
        grant,
        audience
      );
      attenuatedRows.push(filtered);
      prunedTotal += prunedCount;
    }
    return { processedData: attenuatedRows, prunedTotal };
  }

  const { filtered, prunedCount } = attenuateProperties(data, grant, audience);
  return { processedData: filtered, prunedTotal: prunedCount };
}

function formatEntryValue(v: Schema.Json): string {
  return Predicate.isObject(v) ? JSON.stringify(v) : String(v);
}

function renderCardItem(item: ViewRecord, index?: number): string {
  const prefix = index === undefined ? "" : `### Item ${index + 1}\n`;
  const lines = Object.entries(item)
    .map(([k, v]) => `- **${k}**: ${formatEntryValue(v)}`)
    .join("\n");
  return `${prefix}${lines}`;
}

function renderCardView(
  processedData: ViewRecord | readonly ViewRecord[]
): string {
  if (isViewRecordArray(processedData)) {
    return processedData
      .map((item, idx) => renderCardItem(item, idx))
      .join("\n\n");
  }
  return renderCardItem(processedData);
}

function renderViewContent(
  format: "markdown" | "table" | "card" | "json",
  title: string,
  state: ViewLifecycleState,
  processedData: ViewRecord | readonly ViewRecord[]
): string {
  if (format === "json") {
    return JSON.stringify(
      {
        data: processedData,
        disposable: true,
        sourceOfTruth: "OPERON_KERNEL",
        state,
        title,
      },
      null,
      2
    );
  }

  const headerBadge = `[STATE: ${state}]`;
  const footerNote = `\n\n> *Note: This view is disposable. Kernel state and execution receipts are the sole source of truth.*`;

  if (
    format === "table" ||
    (Array.isArray(processedData) && format === "markdown")
  ) {
    const rows = Array.isArray(processedData) ? processedData : [processedData];
    return `# ${title} ${headerBadge}\n\n${renderMarkdownTable(rows)}${footerNote}`;
  }

  return `# ${title} ${headerBadge}\n\n${renderCardView(processedData)}${footerNote}`;
}

/**
 * Generate a disposable, grant-bounded application view (S13 / V0-CH-09).
 * The view distinguishes lifecycle state (ACCEPTED | PROPOSED | RUNNING | CONFIRMED | HYPOTHETICAL),
 * attenuates properties to never exceed grant authority, and remains strictly disposable.
 */
export function generateDisposableAppView(
  options: GenerateViewOptions
): DisposableGeneratedView {
  const format = options.format ?? "markdown";
  const now = Date.now();
  const id = `view_${now}_${Math.random().toString(36).slice(2, 7)}`;

  const { processedData, prunedTotal } = attenuateDataset(
    options.data,
    options.grant,
    options.audience
  );

  const rendered = renderViewContent(
    format,
    options.title,
    options.state,
    processedData
  );

  return {
    filteredPropertiesCount: prunedTotal,
    generatedAt: now,
    id,
    isDisposable: true,
    rendered,
    sourceOfTruth: "OPERON_KERNEL",
    state: options.state,
    title: options.title,
  };
}
