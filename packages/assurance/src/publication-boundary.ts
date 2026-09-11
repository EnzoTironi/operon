import { computeCanonicalDigest } from "@operon/schema";
import type {
  ArtifactClassification,
  PublicationScanResult,
  PublicationViolation,
} from "@operon/schema";
import { Cause, Clock, Effect, Exit, Option, Predicate } from "effect";

import { PublicationLeakError } from "./errors.js";
import {
  fileExistsSync,
  joinPath,
  readDirWithTypesSync,
  readTextFileSync,
  relativePath as getRelativePath,
} from "./fs-io.js";

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

interface ScannedFile {
  readonly fullPath: string;
  readonly relativePath: string;
}

interface BoundaryChecker {
  readonly classify: (filePath: string) => ArtifactClassification;
  readonly checkNoProtectedMaterial: (
    content: string | Buffer
  ) => Effect.Effect<void, PublicationLeakError>;
}

const IGNORED_SCAN_NAMES = new Set(["node_modules", ".git", "dist"]);

function collectFilesToScan(targetDir: string): ScannedFile[] {
  const files: ScannedFile[] = [];
  function walk(currentDir: string): void {
    if (!fileExistsSync(currentDir)) {
      return;
    }
    const entries = readDirWithTypesSync(currentDir);
    for (const entry of entries) {
      if (IGNORED_SCAN_NAMES.has(entry.name)) {
        continue;
      }
      const fullPath = joinPath(currentDir, entry.name);
      const relativePath = getRelativePath(targetDir, fullPath).replaceAll(
        "\\",
        "/"
      );
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        files.push({ fullPath, relativePath });
      }
    }
  }
  walk(targetDir);
  return files;
}

function checkPathViolation(
  relativePath: string,
  boundary: BoundaryChecker,
  allowedPublicOnly?: boolean
): Option.Option<PublicationViolation> {
  if (!allowedPublicOnly) {
    return Option.none();
  }
  const classification = boundary.classify(relativePath);
  if (classification === "PROTECTED") {
    return Option.some<PublicationViolation>({
      classification: "PROTECTED",
      details: `Protected path pattern detected in public release candidate: '${relativePath}'`,
      path: relativePath,
      rule: "S17-PROTECTED-PATH-FORBIDDEN",
    });
  }
  return Option.none();
}

const checkContentViolation = Effect.fn("checkContentViolation")(function* (
  fullPath: string,
  relativePath: string,
  boundary: BoundaryChecker
): Effect.fn.Return<Option.Option<PublicationViolation>> {
  const content = yield* Effect.try(() => readTextFileSync(fullPath)).pipe(
    Effect.option,
    Effect.map(Option.getOrUndefined)
  );

  if (content === undefined) {
    return Option.none();
  }

  const exit = yield* Effect.exit(boundary.checkNoProtectedMaterial(content));
  if (Exit.isSuccess(exit)) {
    return Option.none();
  }

  const failReason = exit.cause.reasons.find(Cause.isFailReason);
  if (failReason && failReason.error instanceof PublicationLeakError) {
    const leak = failReason.error;
    return Option.some<PublicationViolation>({
      classification: "PROTECTED",
      details: leak.violation,
      matchedDigest: leak.matchedDigest,
      path: relativePath,
      rule: "S17-PROTECTED-CONTENT-LEAK",
    });
  }

  return Option.none();
});

function checkFileViolation(
  file: ScannedFile,
  boundary: BoundaryChecker,
  allowedPublicOnly?: boolean
): Effect.Effect<Option.Option<PublicationViolation>> {
  const pathViolation = checkPathViolation(
    file.relativePath,
    boundary,
    allowedPublicOnly
  );
  if (Option.isSome(pathViolation)) {
    return Effect.succeed(pathViolation);
  }
  return checkContentViolation(file.fullPath, file.relativePath, boundary);
}

function maybeFailOnViolations(
  violations: readonly PublicationViolation[],
  failOnViolation?: boolean
): Effect.Effect<void, PublicationLeakError> {
  if (!failOnViolation || violations.length === 0) {
    return Effect.void;
  }
  const first = violations[0];
  if (!first) {
    return Effect.void;
  }
  return Effect.fail(
    new PublicationLeakError({
      matchedDigest: first.matchedDigest,
      path: first.path,
      violation: first.details,
    })
  );
}

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
    const text = Predicate.isString(content)
      ? content
      : content.toString("utf-8");
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

  readonly scanDirectory = Effect.fn(
    "PublicationBoundaryService.scanDirectory"
  )(function* (
    this: PublicationBoundaryService,
    targetDir: string,
    options?: {
      readonly allowedPublicOnly?: boolean;
      readonly failOnViolation?: boolean;
    }
  ): Effect.fn.Return<PublicationScanResult, PublicationLeakError> {
    const filesToScan = collectFilesToScan(targetDir);
    const scannedPaths: string[] = [];
    const violations: PublicationViolation[] = [];

    const scanOneFile = Effect.fn("scanOneFile")(function* (
      service: PublicationBoundaryService,
      file: ScannedFile
    ) {
      scannedPaths.push(file.relativePath);
      const violationOpt = yield* checkFileViolation(
        file,
        service,
        options?.allowedPublicOnly
      );
      if (Option.isSome(violationOpt)) {
        violations.push(violationOpt.value);
      }
    });

    yield* Effect.forEach(filesToScan, (file) => scanOneFile(this, file), {
      concurrency: 1,
    });

    yield* maybeFailOnViolations(violations, options?.failOnViolation);

    return {
      isClean: violations.length === 0,
      scannedAt: yield* Clock.currentTimeMillis,
      scannedPaths,
      violations,
    };
  });

  sanitizeReceipt<T extends object>(
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
        Object.assign(copy, { [key]: "[REDACTED]" });
      }
    }
    return copy;
  }
}
