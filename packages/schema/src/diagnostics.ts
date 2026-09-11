import { createHash } from "node:crypto";

import type { Schema } from "effect";

import type { DiagnosticSeverity } from "./compiler.js";
import { canonicalJson } from "./definition.js";

export type DiagnosticChannel = "business" | "policy" | "infrastructure";

export type DiagnosticDetails = Record<string, Schema.Json>;

export interface DiagnosticEntry {
  readonly channel: DiagnosticChannel;
  readonly code: string;
  readonly message: string;
  readonly severity: DiagnosticSeverity;
  readonly details?: DiagnosticDetails;
  readonly timestamp: number;
}

export interface DiagnosticBundle {
  readonly runId: string;
  readonly operation: string;
  readonly channelSummary: {
    readonly businessCount: number;
    readonly policyCount: number;
    readonly infrastructureCount: number;
  };
  readonly businessOutcome?: {
    readonly status: "success" | "violation" | "inconclusive";
    readonly reason?: string;
  };
  readonly policyOutcome?: {
    readonly verdict:
      | "ALLOW"
      | "DENY"
      | "REVIEW_REQUIRED"
      | "EVIDENCE_INSUFFICIENT";
    readonly reason?: string;
  };
  readonly infrastructureOutcome?: {
    readonly status: "healthy" | "degraded" | "failed";
    readonly error?: string;
  };
  readonly entries: readonly DiagnosticEntry[];
  readonly generatedAt: number;
  readonly bundleHash: string;
}

/**
 * Computes canonical SHA-256 hash of a diagnostic bundle
 */
export function computeDiagnosticBundleHash(
  bundle: Omit<DiagnosticBundle, "bundleHash">
): string {
  const json = canonicalJson(bundle);
  return createHash("sha256").update(Buffer.from(json, "utf-8")).digest("hex");
}
