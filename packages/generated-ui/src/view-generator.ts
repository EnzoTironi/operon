import type { IntentGrant } from "@operon/schema";

export type ViewLifecycleState =
  | "ACCEPTED"
  | "PROPOSED"
  | "RUNNING"
  | "CONFIRMED"
  | "HYPOTHETICAL";

export interface GenerateViewOptions {
  readonly title: string;
  readonly state: ViewLifecycleState;
  readonly data: Record<string, unknown> | readonly Record<string, unknown>[];
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

/**
 * Filter data object according to IntentGrant data-use conditions and destination audience (S06, S13)
 */
function attenuateProperties(
  obj: Record<string, unknown>,
  grant?: IntentGrant,
  audience?: string
): { filtered: Record<string, unknown>; prunedCount: number } {
  if (!grant) {
    return { filtered: { ...obj }, prunedCount: 0 };
  }

  // Check destination audience
  if (
    audience &&
    grant.destinationAudiences.length > 0 &&
    !grant.destinationAudiences.includes(audience) &&
    !grant.destinationAudiences.includes("*")
  ) {
    // Complete attenuation if audience unauthorized
    return { filtered: {}, prunedCount: Object.keys(obj).length };
  }

  // Check data use conditions
  let prunedCount = 0;
  const filtered: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    // If grant restricts certain fields (e.g. dataUseConditions contains "mask_pii" or specific disallowed keys)
    const isPiiKey = /ssn|secret|token|password|credential|private_key/iu.test(
      key
    );
    const hasPiiCondition = grant.dataUseConditions.some((c: string) =>
      /mask_pii|no_pii|sanitize/iu.test(c)
    );

    if (isPiiKey && hasPiiCondition) {
      filtered[key] = "[REDACTED_BY_GRANT]";
      prunedCount++;
    } else {
      filtered[key] = value;
    }
  }

  return { filtered, prunedCount };
}

/**
 * Render Markdown Table from rows
 */
function renderMarkdownTable(rows: readonly Record<string, unknown>[]): string {
  if (rows.length === 0) return "*No records to display.*";
  const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const header = `| ${columns.join(" | ")} |`;
  const separator = `| ${columns.map(() => "---").join(" | ")} |`;
  const lines = rows.map(
    (r) =>
      `| ${columns
        .map((col) => {
          const val = r[col];
          if (val === undefined || val === null) return "";
          if (typeof val === "object") return JSON.stringify(val);
          return String(val);
        })
        .join(" | ")} |`
  );
  return [header, separator, ...lines].join("\n");
}

/**
 * Generate a disposable, grant-bounded application view (S13 / V0-CH-09).
 * The view distinguishes lifecycle state (ACCEPTED | PROPOSED | RUNNING | CONFIRMED | HYPOTHETICAL),
 * attenuates properties to never exceed grant authority, and remains strictly disposable.
 */
export function generateDisposableAppView(
  options: GenerateViewOptions
): DisposableGeneratedView {
  const { title, state, data, grant, audience, format = "markdown" } = options;
  const now = Date.now();
  const id = `view_${now}_${Math.random().toString(36).slice(2, 7)}`;

  let prunedTotal = 0;
  let processedData:
    | Record<string, unknown>
    | readonly Record<string, unknown>[];

  if (Array.isArray(data)) {
    const attenuatedRows: Record<string, unknown>[] = [];
    for (const row of data) {
      const { filtered, prunedCount } = attenuateProperties(
        row,
        grant,
        audience
      );
      attenuatedRows.push(filtered);
      prunedTotal += prunedCount;
    }
    processedData = attenuatedRows;
  } else {
    const singleData = data as Record<string, unknown>;
    const { filtered, prunedCount } = attenuateProperties(
      singleData,
      grant,
      audience
    );
    processedData = filtered;
    prunedTotal += prunedCount;
  }

  let rendered = "";
  const headerBadge = `[STATE: ${state}]`;
  const footerNote = `\n\n> *Note: This view is disposable. Kernel state and execution receipts are the sole source of truth.*`;

  if (format === "json") {
    rendered = JSON.stringify(
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
  } else if (
    format === "table" ||
    (Array.isArray(processedData) && format === "markdown")
  ) {
    const rows = Array.isArray(processedData) ? processedData : [processedData];
    rendered = `# ${title} ${headerBadge}\n\n${renderMarkdownTable(rows)}${footerNote}`;
  } else {
    // Card / Markdown Key-Value
    const entries = Array.isArray(processedData)
      ? processedData
          .map(
            (item, idx) =>
              `### Item ${idx + 1}\n${Object.entries(item)
                .map(
                  ([k, v]) =>
                    `- **${k}**: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`
                )
                .join("\n")}`
          )
          .join("\n\n")
      : Object.entries(processedData)
          .map(
            ([k, v]) =>
              `- **${k}**: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`
          )
          .join("\n");
    rendered = `# ${title} ${headerBadge}\n\n${entries}${footerNote}`;
  }

  return {
    filteredPropertiesCount: prunedTotal,
    generatedAt: now,
    id,
    isDisposable: true,
    rendered,
    sourceOfTruth: "OPERON_KERNEL",
    state,
    title,
  };
}
