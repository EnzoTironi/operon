import * as fs from "node:fs";
import path from "node:path";

import { computeCanonicalDigest } from "@operon/schema";
import type {
  ArtifactClassification,
  PublicationScanResult,
  PublicationViolation,
} from "@operon/schema";
import { Cause, Effect, Exit, Option } from "effect";

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

  checkNoProtectedMaterial(
    content: string | Buffer,
    extraProtectedMarkers?: readonly string[]
  ): Effect.Effect<void, PublicationLeakError> {
    const text =
      typeof content === "string" ? content : content.toString("utf-8");
    const markers = [
      ...this.protectedMarkers,
      ...(extraProtectedMarkers ?? []),
    ];

    for (const marker of markers) {
      if (text.includes(marker)) {
        return Effect.fail(
          new PublicationLeakError({
            path: "in-memory-artifact",
            violation: `Protected marker '${marker}' found in public artifact`,
          })
        );
      }
    }

    // Check if entire content or any line matches protected digests
    const contentDigest = computeCanonicalDigest(text);
    if (this.protectedDigests.has(contentDigest)) {
      return Effect.fail(
        new PublicationLeakError({
          matchedDigest: contentDigest,
          path: "in-memory-artifact",
          violation: "Artifact byte digest matches protected material index",
        })
      );
    }

    return Effect.void;
  }

  assertNoProtectedMaterial(
    content: string | Buffer,
    extraProtectedMarkers?: readonly string[]
  ): void {
    Effect.runSync(
      this.checkNoProtectedMaterial(content, extraProtectedMarkers)
    );
  }

  scanDirectory(
    targetDir: string,
    options?: {
      readonly allowedPublicOnly?: boolean;
      readonly failOnViolation?: boolean;
    }
  ): Effect.Effect<PublicationScanResult, PublicationLeakError> {
    const classifyPath = (p: string) => this.classify(p);
    const checkLeak = (content: string | Buffer) =>
      this.checkNoProtectedMaterial(content);

    return Effect.gen(function* () {
      const scannedPaths: string[] = [];
      const violations: PublicationViolation[] = [];
      const filesToScan: { fullPath: string; relativePath: string }[] = [];

      const walk = (currentDir: string): void => {
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
            filesToScan.push({ fullPath, relativePath });
          }
        }
      };

      walk(targetDir);

      for (const { fullPath, relativePath } of filesToScan) {
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

        const content = yield* Effect.try(() =>
          fs.readFileSync(fullPath, "utf-8")
        ).pipe(Effect.option, Effect.map(Option.getOrUndefined));

        if (content !== undefined) {
          const exit = yield* Effect.exit(checkLeak(content));
          if (Exit.isFailure(exit)) {
            const failReason = exit.cause.reasons.find(Cause.isFailReason);
            if (
              failReason &&
              failReason.error instanceof PublicationLeakError
            ) {
              const leak = failReason.error;
              violations.push({
                classification: "PROTECTED",
                details: leak.violation,
                matchedDigest: leak.matchedDigest,
                path: relativePath,
                rule: "S17-PROTECTED-CONTENT-LEAK",
              });
            }
          }
        }
      }

      const isClean = violations.length === 0;

      if (!isClean && options?.failOnViolation) {
        const first = violations[0]!;
        return yield* Effect.fail(
          new PublicationLeakError({
            matchedDigest: first.matchedDigest,
            path: first.path,
            violation: first.details,
          })
        );
      }

      return {
        isClean,
        scannedAt: Date.now(),
        scannedPaths,
        violations,
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
