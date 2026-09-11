import type {
  AccessibleFocusNode,
  SurfaceComponent,
  SurfaceLifecycleState,
} from "@operon/schema";
import { Predicate } from "effect";
import type { Schema } from "effect";

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

export type CardValue = Record<string, Schema.Json> | string | number;

/**
 * Options for rendering an accessible card with distinct active vs proposed states (OPR-FULL-035)
 */
export interface StateDistinctCardOptions {
  readonly activeValue: CardValue;
  readonly ariaLabel?: string;
  readonly componentId?: string;
  readonly proposedValue?: CardValue;
  readonly title: string;
}

function formatCardValue(value: CardValue): string {
  if (Predicate.isString(value)) {
    return sanitizeEvidenceContent(value);
  }
  if (Predicate.isObject(value)) {
    return JSON.stringify(value, null, 2);
  }
  return String(value);
}

function renderProposedSection(proposedValue?: CardValue): string {
  if (proposedValue === undefined) {
    return "";
  }
  const propStr = formatCardValue(proposedValue);
  return `\n\n#### [STATE: PROPOSED] Pending Action Proposal\n\`\`\`json\n${propStr}\n\`\`\``;
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

  const activeStr = formatCardValue(options.activeValue);
  const proposedSection = renderProposedSection(options.proposedValue);
  const markup = `### ${title}\n\n#### [STATE: ACCEPTED] Current Canonical Value\n\`\`\`json\n${activeStr}\n\`\`\`${proposedSection}`;

  const focusNode: AccessibleFocusNode = {
    ariaLabel: options.ariaLabel ?? `${title} Details and Proposals`,
    ariaRole: "region",
    focusId: `focus-${componentId}`,
    keyboardShortcut: "Alt+P",
    tabIndex: 0,
  };

  const state: SurfaceLifecycleState =
    options.proposedValue === undefined ? "ACCEPTED" : "PROPOSED";

  return {
    activeValue: options.activeValue,
    componentId,
    focusNode,
    proposedValue: options.proposedValue,
    renderedMarkup: markup,
    state,
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
  readonly rows: readonly Record<string, Schema.Json>[];
  readonly state?: SurfaceLifecycleState;
  readonly title: string;
}

function formatTableCell(val: Schema.Json | undefined): string {
  if (val === undefined || val === null) {
    return "";
  }
  const strVal = Predicate.isObject(val) ? JSON.stringify(val) : String(val);
  return sanitizeEvidenceContent(strVal);
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
    (r) => `| ${columns.map((col) => formatTableCell(r[col])).join(" | ")} |`
  );

  const markup = `### ${options.title} [STATE: ${state}]\n\n${header}\n${separator}\n${lines.join("\n")}`;

  const focusNode: AccessibleFocusNode = {
    ariaLabel: options.ariaLabel ?? `${options.title} Data Table`,
    ariaRole: "table",
    focusId: `focus-${componentId}`,
    keyboardShortcut: options.keyboardShortcut ?? "Alt+T",
    tabIndex: 0,
  };

  const title = options.title;

  return {
    activeValue: options.rows,
    componentId,
    focusNode,
    renderedMarkup: markup,
    state,
    title,
    type: "TABLE",
  };
}
