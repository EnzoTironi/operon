import type {
  AccessibleFocusNode,
  SurfaceComponent,
  SurfaceLifecycleState,
} from "@operon/schema";

/**
 * Sanitize hostile text / evidence content to prevent script execution (OPR-UX-004)
 */
export function sanitizeEvidenceContent(rawContent: string): string {
  return rawContent
    .replaceAll(
      /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/giu,
      "[REMOVED_SCRIPT]"
    )
    .replaceAll(
      /<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/giu,
      "[REMOVED_IFRAME]"
    )
    .replaceAll(/javascript:[^"'\s]*/giu, "[REMOVED_JAVASCRIPT]")
    .replaceAll(/onerror\s*=\s*["'][^"']*["']/giu, "")
    .replaceAll(/onload\s*=\s*["'][^"']*["']/giu, "");
}

/**
 * Options for rendering an accessible card with distinct active vs proposed states (OPR-FULL-035)
 */
export interface StateDistinctCardOptions {
  readonly activeValue: Record<string, unknown> | string | number;
  readonly ariaLabel?: string;
  readonly componentId?: string;
  readonly proposedValue?: Record<string, unknown> | string | number;
  readonly title: string;
}

/**
 * Render an accessible UI component that strictly separates active canonical state from proposal (OPR-FULL-035 / FULL-ACC-035)
 */
export function renderStateDistinctCard(
  options: StateDistinctCardOptions
): SurfaceComponent {
  const componentId =
    options.componentId ??
    `comp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const title = options.title;

  const sanitizedActive =
    typeof options.activeValue === "string"
      ? sanitizeEvidenceContent(options.activeValue)
      : options.activeValue;

  const sanitizedProposed =
    typeof options.proposedValue === "string"
      ? sanitizeEvidenceContent(options.proposedValue)
      : options.proposedValue;

  const activeStr =
    typeof sanitizedActive === "object"
      ? JSON.stringify(sanitizedActive, null, 2)
      : String(sanitizedActive);

  let proposedSection = "";
  if (sanitizedProposed !== undefined) {
    const propStr =
      typeof sanitizedProposed === "object"
        ? JSON.stringify(sanitizedProposed, null, 2)
        : String(sanitizedProposed);

    proposedSection = `\n\n#### [STATE: PROPOSED] Pending Action Proposal\n\`\`\`json\n${propStr}\n\`\`\``;
  }

  const markup = `### ${title}\n\n#### [STATE: ACCEPTED] Current Canonical Value\n\`\`\`json\n${activeStr}\n\`\`\`${proposedSection}`;

  const focusNode: AccessibleFocusNode = {
    ariaLabel: options.ariaLabel ?? `${title} Details and Proposals`,
    ariaRole: "region",
    focusId: `focus-${componentId}`,
    keyboardShortcut: "Alt+P",
    tabIndex: 0,
  };

  return {
    activeValue: options.activeValue,
    componentId,
    focusNode,
    proposedValue: options.proposedValue,
    renderedMarkup: markup,
    state: options.proposedValue === undefined ? "ACCEPTED" : "PROPOSED",
    title,
    type: "CARD",
  };
}

/**
 * Options for rendering an accessible data table (OPR-FULL-037, OPR-UX-003)
 */
export interface AccessibleTableOptions {
  readonly ariaLabel?: string;
  readonly componentId?: string;
  readonly keyboardShortcut?: string;
  readonly rows: readonly Record<string, unknown>[];
  readonly state?: SurfaceLifecycleState;
  readonly title: string;
}

/**
 * Render an accessible data table navigable via keyboard without requiring chat (OPR-FULL-037 / FULL-ACC-037)
 */
export function renderAccessibleTable(
  options: AccessibleTableOptions
): SurfaceComponent {
  const componentId =
    options.componentId ??
    `tbl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const state: SurfaceLifecycleState = options.state ?? "CONFIRMED";

  if (options.rows.length === 0) {
    return {
      componentId,
      renderedMarkup: `### ${options.title} [STATE: ${state}]\n*No records available.*`,
      state,
      title: options.title,
      type: "TABLE",
    };
  }

  const columns = [...new Set(options.rows.flatMap((r) => Object.keys(r)))];
  const header = `| ${columns.join(" | ")} |`;
  const separator = `| ${columns.map(() => "---").join(" | ")} |`;
  const lines = options.rows.map(
    (r) =>
      `| ${columns
        .map((col) => {
          const val = r[col];
          if (val === undefined || val === null) return "";
          const strVal =
            typeof val === "object" ? JSON.stringify(val) : String(val);
          return sanitizeEvidenceContent(strVal);
        })
        .join(" | ")} |`
  );

  const markup = `### ${options.title} [STATE: ${state}]\n\n${header}\n${separator}\n${lines.join("\n")}`;

  const focusNode: AccessibleFocusNode = {
    ariaLabel: options.ariaLabel ?? `${options.title} Data Table`,
    ariaRole: "table",
    focusId: `focus-${componentId}`,
    keyboardShortcut: options.keyboardShortcut ?? "Alt+T",
    tabIndex: 0,
  };

  return {
    activeValue: options.rows,
    componentId,
    focusNode,
    renderedMarkup: markup,
    state,
    title: options.title,
    type: "TABLE",
  };
}
