import type {
  AccessibleFocusNode,
  DecisionCanvasRecord,
  SurfaceComponent,
} from "@operon/schema";

import { sanitizeEvidenceContent } from "./surface-generator.js";

/**
 * Render a Decision Canvas capturing decision owner, alternatives, evidence R(d), rules, and deliverables (OPR-ORG-001)
 */
export function renderDecisionCanvas(
  record: DecisionCanvasRecord
): SurfaceComponent {
  const {
    alternatives,
    applicableRules,
    canvasId,
    decisionOwner,
    decisionTitle,
    deliverablesStatus,
    evidenceReferences,
    proposedActions,
    sourceSystems,
    stage,
  } = record;

  const deliverablesTable = Object.entries(deliverablesStatus)
    .map(
      ([del, passed]) =>
        `- [${passed ? "x" : " "}] **${del}**: ${passed ? "COMPLETE" : "PENDING"}`
    )
    .join("\n");

  const markup = `## Decision Canvas: ${sanitizeEvidenceContent(decisionTitle)} [STAGE: ${stage}]

- **Canvas ID:** \`${canvasId}\`
- **Decision Owner:** \`${decisionOwner}\`
- **Current Stage:** \`${stage}\`

### 1. Alternatives Evaluated
${alternatives.map((alt, i) => `${i + 1}. ${sanitizeEvidenceContent(alt)}`).join("\n")}

### 2. Evidence Context R(d) & Sources
- **Source Systems:** ${sourceSystems.map((s) => `\`${s}\``).join(", ")}
- **Evidence References:** ${evidenceReferences.map((e) => `\`${e}\``).join(", ")}

### 3. Applicable Rules & Constraints
${applicableRules.map((r) => `- **Rule:** \`${sanitizeEvidenceContent(r)}\``).join("\n")}

### 4. Proposed Actions
${proposedActions.map((a) => `- **Action:** \`${sanitizeEvidenceContent(a)}\``).join("\n")}

### 5. Eight-Stage Deliverables Status
${deliverablesTable}
`;

  const focusNode: AccessibleFocusNode = {
    ariaLabel: `Decision Canvas for ${decisionTitle}`,
    ariaRole: "article",
    focusId: `focus-canvas-${canvasId}`,
    keyboardShortcut: "Alt+D",
    tabIndex: 0,
  };

  return {
    activeValue: record,
    componentId: canvasId,
    focusNode,
    renderedMarkup: markup,
    state: stage === "OPERATION" ? "CONFIRMED" : "PROPOSED",
    title: decisionTitle,
    type: "DECISION_CANVAS",
  };
}
