import * as fs from "node:fs";
import path from "node:path";

import {
  F1EvaluatorService,
  F2MirrorService,
  PublicationBoundaryService,
} from "@operon/assurance";
import type {
  ConsentScope,
  F1TestCase,
  F2Claim,
  F2Receipt,
  PublicF1Receipt,
  TraceableCorrection,
} from "@operon/schema";
import { Effect, Exit, Option } from "effect";

function parseJsonArg<T>(argValue?: string): Effect.Effect<T | undefined> {
  if (!argValue) return Effect.succeed(undefined);
  if (argValue.startsWith("{") || argValue.startsWith("[")) {
    return Effect.try(() => JSON.parse(argValue) as T).pipe(
      Effect.option,
      Effect.map(Option.getOrUndefined)
    );
  }
  // Try reading as file path
  return Effect.try(() => {
    const resolved = path.resolve(process.cwd(), argValue);
    if (fs.existsSync(resolved)) {
      const content = fs.readFileSync(resolved, "utf-8");
      return JSON.parse(content) as T;
    }
    return undefined;
  }).pipe(Effect.option, Effect.map(Option.getOrUndefined));
}

export function runAssurance(
  args: string[]
): Effect.Effect<number, unknown, never> {
  const sub = args[0];
  const isJson = args.includes("--json");

  const f1Evaluator = new F1EvaluatorService();
  const f2Mirror = new F2MirrorService();
  const publicationBoundary = new PublicationBoundaryService();

  return Effect.gen(function* () {
    const resultExit = yield* Effect.exit(
      Effect.gen(function* () {
        switch (sub) {
          case "evaluate": {
            const candidateIndex = args.indexOf("--candidate");
            const candidate =
              candidateIndex === -1
                ? "default_candidate"
                : (args[candidateIndex + 1] ?? "default_candidate");

            const profileIndex = args.indexOf("--profile");
            const profileRaw =
              profileIndex === -1
                ? "local"
                : (args[profileIndex + 1] ?? "local");
            const profile =
              profileRaw === "production" || profileRaw === "external-agent"
                ? profileRaw
                : "local";

            const catalogIndex = args.indexOf("--catalog");
            const catalog =
              catalogIndex === -1
                ? "default_catalog"
                : (args[catalogIndex + 1] ?? "default_catalog");

            const casesIndex = args.indexOf("--cases");
            const casesRaw =
              casesIndex === -1 ? undefined : args[casesIndex + 1];
            const parsedCases =
              yield* parseJsonArg<readonly F1TestCase[]>(casesRaw);
            const testCases = parsedCases ?? [
              {
                assertions: 5,
                executionTimeMs: 45,
                id: "DEFAULT_ASSURANCE_TC_01",
                name: "Kernel Assurance Invariant Control",
                status: "PASS",
              },
            ];

            const keyIndex = args.indexOf("--idempotency-key");
            const idempotencyKey =
              keyIndex === -1 ? undefined : args[keyIndex + 1];

            const exit = yield* Effect.exit(
              f1Evaluator.evaluate({
                candidateDigest: `sha256_${candidate}`,
                candidateId: candidate,
                catalogDigest: `sha256_${catalog}`,
                catalogId: catalog,
                idempotencyKey,
                profile,
                testCases,
              })
            );

            if (exit._tag === "Failure") {
              const errStr = String(exit.cause);
              if (isJson) {
                console.log(
                  JSON.stringify({ error: errStr, status: "FAIL" }, null, 2)
                );
              } else {
                console.error(`Assurance F1 Evaluation Failed: ${errStr}`);
              }
              return 1;
            }

            const receipt = exit.value;
            if (isJson) {
              console.log(JSON.stringify(receipt, null, 2));
            } else {
              console.log("=== OPERON F1 EVALUATION RECEIPT ===");
              console.log(`Candidate: ${receipt.candidateDigest}`);
              console.log(`Profile:   ${receipt.profileDigest}`);
              console.log(`Catalog:   ${receipt.catalogDigest}`);
              console.log(`Outcome:   ${receipt.outcome}`);
              console.log(`Cases:     ${receipt.caseCount}`);
              console.log(`Signature: ${receipt.signature.slice(0, 32)}...`);
            }
            return 0;
          }

          case "mirror": {
            const participantIndex = args.indexOf("--participant");
            const participantId =
              participantIndex === -1
                ? "metro_health_hospital"
                : (args[participantIndex + 1] ?? "metro_health_hospital");

            const consentIndex = args.indexOf("--consent");
            const consentRaw =
              consentIndex === -1 ? undefined : args[consentIndex + 1];
            const parsedConsent = yield* parseJsonArg<ConsentScope>(consentRaw);
            const consentScope = parsedConsent ?? {
              consentGrantId: `consent_${participantId}`,
              createdAt: Date.now() - 1000,
              dataScope: ["patients", "clinical_trials", "vitals"],
              expiresAt: Date.now() + 86400000,
              participantId,
              purpose: "Real-company mirror evaluation",
            };

            const correctionsIndex = args.indexOf("--corrections");
            const correctionsRaw =
              correctionsIndex === -1 ? undefined : args[correctionsIndex + 1];
            const parsedCorrections =
              yield* parseJsonArg<readonly TraceableCorrection[]>(
                correctionsRaw
              );
            const corrections = parsedCorrections ?? [
              {
                correctedAt: Date.now(),
                correctedBy: "attending_physician",
                correctedValue: 10,
                correctionId: "corr_initial_01",
                observedTarget: "Patient/P001/currentDose",
                priorValue: 14,
                reason: "Impaired renal clearance and reduced oral intake",
              },
            ];

            const claimIndex = args.indexOf("--claim");
            const claim = (
              claimIndex === -1 || !args[claimIndex + 1]
                ? "observed-action"
                : args[claimIndex + 1]
            ) as F2Claim;

            const exit = yield* Effect.exit(
              f2Mirror.evaluateMirror({
                candidateDigest: "cand_f2_mirror_reference",
                claim,
                companyEvidenceRef: `evidence://${participantId}/mirror_audit`,
                consentScope,
                corrections,
                participantId,
                profileDigest: "prof_postgres_mirror_reference",
                rubricDigest: "rubric_real_company_v0",
              })
            );

            if (exit._tag === "Failure") {
              const errStr = String(exit.cause);
              if (isJson) {
                console.log(
                  JSON.stringify({ error: errStr, status: "FAIL" }, null, 2)
                );
              } else {
                console.error(
                  `Assurance F2 Mirror Evaluation Failed: ${errStr}`
                );
              }
              return 1;
            }

            const receipt = exit.value;
            if (isJson) {
              console.log(JSON.stringify(receipt, null, 2));
            } else {
              console.log("=== OPERON F2 MIRROR EVALUATION RECEIPT ===");
              console.log(`Participant: ${receipt.participantId}`);
              console.log(`Claim:       ${receipt.claim}`);
              console.log(`Corrections: ${receipt.correctionRefs.join(", ")}`);
              console.log(`Signature:   ${receipt.signature.slice(0, 32)}...`);
            }
            return 0;
          }

          case "scan": {
            const targetDir =
              args[1] && !args[1].startsWith("-")
                ? path.resolve(process.cwd(), args[1])
                : process.cwd();

            const allowedPublicOnly = args.includes("--public-only");

            const exit = yield* Effect.exit(
              publicationBoundary.scanDirectory(targetDir, {
                allowedPublicOnly,
              })
            );

            if (exit._tag === "Failure") {
              const errStr = String(exit.cause);
              if (isJson) {
                console.log(
                  JSON.stringify({ error: errStr, isClean: false }, null, 2)
                );
              } else {
                console.error(`Publication Scan Failed: ${errStr}`);
              }
              return 1;
            }

            const result = exit.value;
            if (isJson) {
              console.log(JSON.stringify(result, null, 2));
            } else {
              console.log("=== OPERON PUBLICATION BOUNDARY SCAN ===");
              console.log(`Target:    ${targetDir}`);
              console.log(`Clean:     ${result.isClean}`);
              console.log(`Scanned:   ${result.scannedPaths.length} files`);
              console.log(`Violations: ${result.violations.length}`);
              for (const v of result.violations) {
                console.log(
                  `  - [${v.classification}] ${v.path}: ${v.details}`
                );
              }
            }
            return result.isClean ? 0 : 1;
          }

          case "verify-receipt": {
            const filePath = args[1];
            if (!filePath || filePath.startsWith("-")) {
              console.error(
                "Usage: operon assurance verify-receipt <receipt-file.json> [--json]"
              );
              return 1;
            }

            const resolved = path.resolve(process.cwd(), filePath);
            if (!fs.existsSync(resolved)) {
              console.error(`File not found: ${resolved}`);
              return 1;
            }

            const content = JSON.parse(fs.readFileSync(resolved, "utf-8"));
            let isValid = false;

            if (content.outcome) {
              // F1 Receipt
              const exit = yield* Effect.exit(
                f1Evaluator.verifyReceipt(content as PublicF1Receipt)
              );
              isValid = exit._tag === "Success" && exit.value === true;
            } else if (content.claim) {
              // F2 Receipt
              const exit = yield* Effect.exit(
                f2Mirror.verifyReceipt(content as F2Receipt)
              );
              isValid = exit._tag === "Success" && exit.value === true;
            }

            if (isJson) {
              console.log(
                JSON.stringify({ isValid, receipt: filePath }, null, 2)
              );
            } else {
              console.log(
                `Receipt ${filePath}: ${isValid ? "VALID (Ed25519 Verified)" : "INVALID"}`
              );
            }
            return isValid ? 0 : 1;
          }

          default: {
            console.log(`Operon Assurance & Release Evaluation (Gate V0-F)

Usage:
  operon assurance evaluate [flags]         Run Company-in-a-Box evaluator (F1)
  operon assurance mirror [flags]           Run consented real-company mirror (F2)
  operon assurance scan [path] [flags]      Scan publication boundary for leaks
  operon assurance verify-receipt <file>    Verify Ed25519 signature on receipt

Flags:
  --candidate <id>       Release candidate digest or ID
  --profile <profile>    Execution profile: local | production | external-agent
  --catalog <id>         Test catalogue identifier
  --participant <id>     Participant ID for consented mirror
  --consent <json|file>  ConsentScope JSON string or path
  --corrections <json>   Traceable corrections JSON array
  --public-only          Enforce public-only file path patterns
  --json                 Output machine-readable JSON`);
            return 0;
          }
        }
      })
    );

    if (Exit.isFailure(resultExit)) {
      const errorMsg = String(resultExit.cause);
      if (isJson) {
        console.log(JSON.stringify({ error: errorMsg }, null, 2));
      } else {
        console.error("Assurance command failed:", errorMsg);
      }
      return 1;
    }

    return resultExit.value;
  });
}
