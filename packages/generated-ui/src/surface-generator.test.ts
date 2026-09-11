import { describe, expect, it } from "vitest";

import { renderDecisionCanvas } from "./decision-canvas.js";
import {
  renderAccessibleTable,
  renderStateDistinctCard,
  sanitizeEvidenceContent,
} from "./surface-generator.js";

describe("Generated Application Surfaces (WS07 / S13 / S14)", () => {
  describe("renderStateDistinctCard (FULL-ACC-035)", () => {
    it("does render active canonical state and proposed state distinctly side-by-side", () => {
      const card = renderStateDistinctCard({
        activeValue: {
          deadline: "2026-10-01",
          status: "ACCEPTED",
        },
        proposedValue: {
          deadline: "2026-11-15",
          status: "PENDING_APPROVAL",
        },
        title: "Project Alpha Schedule",
      });

      expect(card.type).toBe("CARD");
      expect(card.state).toBe("PROPOSED");
      expect(card.title).toBe("Project Alpha Schedule");
      expect(card.renderedMarkup).toContain(
        "[STATE: ACCEPTED] Current Canonical Value"
      );
      expect(card.renderedMarkup).toContain('"deadline": "2026-10-01"');
      expect(card.renderedMarkup).toContain(
        "[STATE: PROPOSED] Pending Action Proposal"
      );
      expect(card.renderedMarkup).toContain('"deadline": "2026-11-15"');
      expect(card.focusNode).toBeDefined();
      expect(card.focusNode?.ariaRole).toBe("region");
      expect(card.focusNode?.tabIndex).toBe(0);
      expect(card.focusNode?.keyboardShortcut).toBe("Alt+P");
    });

    it("does render only canonical state when no proposal is active", () => {
      const card = renderStateDistinctCard({
        activeValue: "Direct Value String",
        title: "Simple Property",
      });

      expect(card.state).toBe("ACCEPTED");
      expect(card.renderedMarkup).toContain("[STATE: ACCEPTED]");
      expect(card.renderedMarkup).not.toContain("[STATE: PROPOSED]");
    });
  });

  describe("renderAccessibleTable (FULL-ACC-037 / UX-003)", () => {
    it("does render accessible table with aria table role, tabIndex 0, shortcut and text status badge", () => {
      const table = renderAccessibleTable({
        keyboardShortcut: "Alt+T",
        rows: [
          { id: "TASK-1", priority: "HIGH", title: "Review ECG" },
          { id: "TASK-2", priority: "LOW", title: "Order Labs" },
        ],
        state: "CONFIRMED",
        title: "Clinical Task Roster",
      });

      expect(table.type).toBe("TABLE");
      expect(table.state).toBe("CONFIRMED");
      expect(table.renderedMarkup).toContain(
        "### Clinical Task Roster [STATE: CONFIRMED]"
      );
      expect(table.renderedMarkup).toContain("| id | priority | title |");
      expect(table.renderedMarkup).toContain("| TASK-1 | HIGH | Review ECG |");
      expect(table.focusNode).toBeDefined();
      expect(table.focusNode?.ariaRole).toBe("table");
      expect(table.focusNode?.tabIndex).toBe(0);
      expect(table.focusNode?.keyboardShortcut).toBe("Alt+T");
    });

    it("does render empty table placeholder gracefully when rows array is empty", () => {
      const table = renderAccessibleTable({
        rows: [],
        title: "Empty Roster",
      });

      expect(table.type).toBe("TABLE");
      expect(table.renderedMarkup).toContain("*No records available.*");
    });
  });

  describe("sanitizeEvidenceContent (UX-004.T02)", () => {
    it("does sanitize hostile script tags, iframes, javascript URLs and event handlers", () => {
      const jsUrl = ["java", "script:alert(1)"].join("");
      const hostile = `Safe text <script>alert('xss')</script> and <iframe src="evil.com"></iframe> with <a href="${jsUrl}">link</a> and <img src="x" onerror="steal()" onload="inject()">.`;
      const sanitized = sanitizeEvidenceContent(hostile);

      expect(sanitized).not.toContain("<script>");
      expect(sanitized).not.toContain("alert('xss')");
      expect(sanitized).toContain("[REMOVED_SCRIPT]");
      expect(sanitized).not.toContain("<iframe");
      expect(sanitized).toContain("[REMOVED_IFRAME]");
      expect(sanitized).not.toContain(jsUrl);
      expect(sanitized).toContain("[REMOVED_JAVASCRIPT]");
      expect(sanitized).not.toContain("onerror=");
      expect(sanitized).not.toContain("onload=");
    });
  });

  describe("renderDecisionCanvas (ORG-001.T01)", () => {
    it("does render decision canvas with 8-stage deliverables table and metadata", () => {
      const canvas = renderDecisionCanvas({
        alternatives: ["Admit to ICU", "Keep in Observation"],
        applicableRules: [
          "RULE-001: ICU criteria",
          "RULE-002: Oxygen saturation",
        ],
        canvasId: "canvas-adm-402",
        decisionOwner: "Dr. Smith",
        decisionTitle: "Patient 402 Admission Plan",
        deliverablesStatus: {
          EXECUTION: false,
          GOVERNANCE: false,
          INBOX: false,
          INGESTION: true,
          MONITORING: false,
          READINESS: true,
          REVIEW: false,
          SIMULATION: false,
        },
        evidenceReferences: ["EV-001-LABS", "EV-002-VITALS"],
        proposedActions: ["ACTION-ORDER-BED", "ACTION-ASSIGN-NURSE"],
        sourceSystems: ["EHR_EPIC", "MONITOR_PHILIPS"],
        stage: "EXECUTION",
      });

      expect(canvas.type).toBe("DECISION_CANVAS");
      expect(canvas.state).toBe("PROPOSED");
      expect(canvas.title).toBe("Patient 402 Admission Plan");
      expect(canvas.renderedMarkup).toContain(
        "## Decision Canvas: Patient 402 Admission Plan [STAGE: EXECUTION]"
      );
      expect(canvas.renderedMarkup).toContain("`canvas-adm-402`");
      expect(canvas.renderedMarkup).toContain("`Dr. Smith`");
      expect(canvas.renderedMarkup).toContain("1. Admit to ICU");
      expect(canvas.renderedMarkup).toContain("2. Keep in Observation");
      expect(canvas.renderedMarkup).toContain("`EHR_EPIC`");
      expect(canvas.renderedMarkup).toContain("`EV-001-LABS`");
      expect(canvas.renderedMarkup).toContain("RULE-001: ICU criteria");
      expect(canvas.renderedMarkup).toContain("ACTION-ORDER-BED");
      expect(canvas.renderedMarkup).toContain("- [x] **INGESTION**: COMPLETE");
      expect(canvas.renderedMarkup).toContain("- [ ] **EXECUTION**: PENDING");
      expect(canvas.focusNode?.ariaRole).toBe("article");
      expect(canvas.focusNode?.keyboardShortcut).toBe("Alt+D");
    });
  });
});
