import * as fs from "node:fs";
import path from "node:path";

import { computeCanonicalDigest } from "@operon/schema";
import type {
  ArtifactClassification,
  PublicationScanResult,
  PublicationViolation,
} from "@operon/schema";
import { Effect } from "effect";

import { PublicationLeakError } from "./errors.js";

const DEFAULT_PROTECTED_PATH_PATTERNS = [
  /gold/iu,
  /oracle/iu,
  /hidden[-_]cases/iu,
  /private[-_]weights/iu,
  /evaluator[-_]weights/iu,
  /evaluator[-_]keys/iu,
  /\.evidence\/gold/iu,
  /private[-_]oracles/iu,
];

const DEFAULT_PROTECTED_MARKERS = [
  "__OPERON_PROTECTED_GOLD__",
  "__OPERON_PRIVATE_ORACLE__",
  "__OPERON_EVALUATOR_WEIGHTS__",
  "__OPERON_SECRET_THRESHOLD__",
];

export class PublicationBoundaryService {
  private readonly protectedPatterns: readonly RegExp[];
  private readonly protectedMarkers: readonly string[];
  private readonly protectedDigests: Set<string>;

  constructor(options?: {
    readonly protectedPatterns?: readonly RegExp[];
    readonly protectedMarkers?: readonly string[];
    readonly protectedDigests?: readonly string[];
  }) {
    this.protectedPatterns =
      options?.protectedPatterns ?? DEFAULT_PROTECTED_PATH_PATTERNS;
    this.protectedMarkers =
      options?.protectedMarkers ?? DEFAULT_PROTECTED_MARKERS;
    this.protectedDigests = new Set(options?.protectedDigests);
  }

  classify(filePath: string): ArtifactClassification {
    const normalized = filePath.replaceAll("\\", "/");
    for (const pattern of this.protectedPatterns) {
      if (pattern.test(normalized)) {
        return "PROTECTED";
      }
    }
    return "PUBLIC";
  }

  assertNoProtectedMaterial(
    content: string | Buffer,
    extraProtectedMarkers?: readonly string[]
  ): void {
    const text =
      typeof content === "string" ? content : content.toString("utf-8");
    const markers = [
      ...this.protectedMarkers,
      ...(extraProtectedMarkers ?? []),
    ];

    for (const marker of markers) {
      if (text.includes(marker)) {
        throw new PublicationLeakError({
          path: "in-memory-artifact",
          violation: `Protected marker '${marker}' found in public artifact`,
        });
      }
    }

    // Check if entire content or any line matches protected digests
    const contentDigest = computeCanonicalDigest(text);
    if (this.protectedDigests.has(contentDigest)) {
      throw new PublicationLeakError({
        path: "in-memory-artifact",
        violation: "Artifact byte digest matches protected material index",
        matchedDigest: contentDigest,
      });
    }
  }

  scanDirectory(
    targetDir: string,
    options?: {
      readonly allowedPublicOnly?: boolean;
      readonly failOnViolation?: boolean;
    }
  ): Effect.Effect<PublicationScanResult, PublicationLeakError> {
    const classifyPath = (p: string) => this.classify(p);
    const assertClean = (c: string | Buffer) =>
      this.assertNoProtectedMaterial(c);

    return Effect.gen(function* () {
      const scannedPaths: string[] = [];
      const violations: PublicationViolation[] = [];

      function walk(currentDir: string) {
        if (!fs.existsSync(currentDir)) return;
        const entries = fs.readdirSync(currentDir, { withFileTypes: true });

        for (const entry of entries) {
          const fullPath = path.join(currentDir, entry.name);
          const relativePath = path
            .relative(targetDir, fullPath)
            .replaceAll("\\", "/");

          if (
            entry.name === "node_modules" ||
            entry.name === ".git" ||
            entry.name === "dist"
          ) {
            continue;
          }

          if (entry.isDirectory()) {
            walk(fullPath);
          } else if (entry.isFile()) {
            scannedPaths.push(relativePath);
            const classification = classifyPath(relativePath);

            if (options?.allowedPublicOnly && classification === "PROTECTED") {
              violations.push({
                classification: "PROTECTED",
                details: `Protected path pattern detected in public release candidate: '${relativePath}'`,
                path: relativePath,
                rule: "S17-PROTECTED-PATH-FORBIDDEN",
              });
              continue;
            }

            try {
              const content = fs.readFileSync(fullPath, "utf-8");
              assertClean(content);
            } catch (error: unknown) {
              if (error instanceof PublicationLeakError) {
                violations.push({
                  classification: "PROTECTED",
                  details: error.violation,
                  matchedDigest: error.matchedDigest,
                  path: relativePath,
                  rule: "S17-PROTECTED-CONTENT-LEAK",
                });
              }
            }
          }
        }
      }

      walk(targetDir);

      const isClean = violations.length === 0;

      if (!isClean && options?.failOnViolation) {
        const first = violations[0]!;
        return yield* Effect.fail(
          new PublicationLeakError({
            path: first.path,
            violation: first.details,
            matchedDigest: first.matchedDigest,
          })
        );
      }

      return {
        isClean,
        scannedPaths,
        violations,
        scannedAt: Date.now(),
      };
    });
  }

  sanitizeReceipt<T extends Record<string, any>>(
    receipt: T,
    protectedKeys: readonly string[] = [
      "privateKey",
      "secret",
      "password",
      "token",
      "internalId",
    ]
  ): T {
    const copy = { ...receipt };
    for (const key of Object.keys(copy)) {
      if (
        protectedKeys.some((pk) => key.toLowerCase().includes(pk.toLowerCase()))
      ) {
        (copy as any)[key] = "[REDACTED]";
      }
    }
    return copy;
  }
}
