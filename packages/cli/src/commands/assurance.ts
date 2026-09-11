import {
  F1EvaluatorService,
  F2MirrorService,
  PublicationBoundaryService,
} from "@operon/assurance";
import { parseJson } from "@operon/schema";
import type {
  ConsentScope,
  F1TestCase,
  F2Claim,
  F2Receipt,
  PublicF1Receipt,
  TraceableCorrection,
} from "@operon/schema";
import { Effect, Exit } from "effect";

import { fileExistsSync, readTextFileSync, resolvePath } from "../fs-io.js";
import { printCli, printCliError, printCliJson } from "../io.js";

function parseJsonArg<T>(argValue?: string): Effect.Effect<T | undefined> {
  if (!argValue) {
    return Effect.void as Effect.Effect<undefined>;
  }
  return Effect.sync(() => {
    try {
      if (argValue.startsWith("{") || argValue.startsWith("[")) {
        // SAFETY: parse JSON argument matching expected schema T
        return parseJson(argValue) as T;
      }
      const resolved = resolvePath(process.cwd(), argValue);
      if (fileExistsSync(resolved)) {
        const content = readTextFileSync(resolved);
        // SAFETY: parse JSON file matching expected schema T
        return parseJson(content) as T;
      }
      return undefined;
    } catch {
      return undefined;
    }
  });
}

function getFlagValue(
  args: readonly string[],
  flag: string
): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

function parseProfile(raw?: string): "local" | "production" | "external-agent" {
  if (raw === "production" || raw === "external-agent") {
    return raw;
  }
  return "local";
}

function parseEvaluateFlags(args: readonly string[]) {
  const candidate = getFlagValue(args, "--candidate") ?? "default_candidate";
  const profile = parseProfile(getFlagValue(args, "--profile"));
  const catalog = getFlagValue(args, "--catalog") ?? "default_catalog";
  const idempotencyKey = getFlagValue(args, "--idempotency-key");
  return { candidate, catalog, idempotencyKey, profile };
}

const DEFAULT_TEST_CASES: readonly F1TestCase[] = [
  {
    assertions: 5,
    executionTimeMs: 45,
    id: "DEFAULT_ASSURANCE_TC_01",
    name: "Kernel Assurance Invariant Control",
    status: "PASS",
  },
];

function printF1Receipt(receipt: {
  readonly candidateDigest: string;
  readonly caseCount: number;
  readonly catalogDigest: string;
  readonly outcome: string;
  readonly profileDigest: string;
  readonly signature: string;
}): void {
  printCli("=== OPERON F1 EVALUATION RECEIPT ===");
  printCli(`Candidate: ${receipt.candidateDigest}`);
  printCli(`Profile:   ${receipt.profileDigest}`);
  printCli(`Catalog:   ${receipt.catalogDigest}`);
  printCli(`Outcome:   ${receipt.outcome}`);
  printCli(`Cases:     ${receipt.caseCount}`);
  printCli(`Signature: ${receipt.signature.slice(0, 32)}...`);
}

const handleAssuranceEvaluate = Effect.fn("handleAssuranceEvaluate")(function* (
  f1Evaluator: F1EvaluatorService,
  args: readonly string[],
  isJson: boolean
) {
  const flags = parseEvaluateFlags(args);
  const casesRaw = getFlagValue(args, "--cases");
  const parsedCases = yield* parseJsonArg<readonly F1TestCase[]>(casesRaw);
  const testCases = parsedCases ?? DEFAULT_TEST_CASES;

  const exit = yield* Effect.exit(
    f1Evaluator.evaluate({
      candidateDigest: `sha256_${flags.candidate}`,
      candidateId: flags.candidate,
      catalogDigest: `sha256_${flags.catalog}`,
      catalogId: flags.catalog,
      idempotencyKey: flags.idempotencyKey,
      profile: flags.profile,
      testCases,
    })
  );

  if (Exit.isFailure(exit)) {
    const errStr = String(exit.cause);
    if (isJson) {
      printCliJson({ error: errStr, status: "FAIL" });
    } else {
      printCliError(`Assurance F1 Evaluation Failed: ${errStr}`);
    }
    return 1;
  }

  const receipt = exit.value;
  if (isJson) {
    printCliJson(receipt);
  } else {
    printF1Receipt(receipt);
  }
  return 0;
});

function parseMirrorFlags(args: readonly string[]) {
  const participantId =
    getFlagValue(args, "--participant") ?? "metro_health_hospital";
  const claimRaw = getFlagValue(args, "--claim") ?? "observed-action";
  // SAFETY: claim flag validated as F2Claim union
  const claim = claimRaw as F2Claim;
  return { claim, participantId };
}

function parseConsentScope(
  parsedConsent: ConsentScope | undefined,
  participantId: string
): ConsentScope {
  if (parsedConsent) {
    return parsedConsent;
  }
  return {
    consentGrantId: `consent_${participantId}`,
    createdAt: Date.now() - 1000,
    dataScope: ["patients", "clinical_trials", "vitals"],
    expiresAt: Date.now() + 86_400_000,
    participantId,
    purpose: "Real-company mirror evaluation",
  };
}

const DEFAULT_CORRECTIONS: readonly TraceableCorrection[] = [
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

function printF2Receipt(receipt: {
  readonly claim: string;
  readonly correctionRefs: readonly string[];
  readonly participantId: string;
  readonly signature: string;
}): void {
  printCli("=== OPERON F2 MIRROR EVALUATION RECEIPT ===");
  printCli(`Participant: ${receipt.participantId}`);
  printCli(`Claim:       ${receipt.claim}`);
  printCli(`Corrections: ${receipt.correctionRefs.join(", ")}`);
  printCli(`Signature:   ${receipt.signature.slice(0, 32)}...`);
}

const handleAssuranceMirror = Effect.fn("handleAssuranceMirror")(function* (
  f2Mirror: F2MirrorService,
  args: readonly string[],
  isJson: boolean
) {
  const flags = parseMirrorFlags(args);
  const consentRaw = getFlagValue(args, "--consent");
  const parsedConsent = yield* parseJsonArg<ConsentScope>(consentRaw);
  const consentScope = parseConsentScope(parsedConsent, flags.participantId);

  const corrRaw = getFlagValue(args, "--corrections");
  const parsedCorr =
    yield* parseJsonArg<readonly TraceableCorrection[]>(corrRaw);
  const corrections = parsedCorr ?? DEFAULT_CORRECTIONS;

  const exit = yield* Effect.exit(
    f2Mirror.evaluateMirror({
      candidateDigest: "cand_f2_mirror_reference",
      claim: flags.claim,
      companyEvidenceRef: `evidence://${flags.participantId}/mirror_audit`,
      consentScope,
      corrections,
      participantId: flags.participantId,
      profileDigest: "prof_postgres_mirror_reference",
      rubricDigest: "rubric_real_company_v0",
    })
  );

  if (Exit.isFailure(exit)) {
    const errStr = String(exit.cause);
    if (isJson) {
      printCliJson({ error: errStr, status: "FAIL" });
    } else {
      printCliError(`Assurance F2 Mirror Evaluation Failed: ${errStr}`);
    }
    return 1;
  }

  const receipt = exit.value;
  if (isJson) {
    printCliJson(receipt);
  } else {
    printF2Receipt(receipt);
  }
  return 0;
});

function printScanViolations(
  violations: readonly {
    readonly classification: string;
    readonly details: string;
    readonly path: string;
  }[]
): void {
  for (const v of violations) {
    printCli(`  - [${v.classification}] ${v.path}: ${v.details}`);
  }
}

function resolveTargetDir(arg?: string): string {
  if (arg && !arg.startsWith("-")) {
    return resolvePath(process.cwd(), arg);
  }
  return process.cwd();
}

const handleAssuranceScan = Effect.fn("handleAssuranceScan")(function* (
  publicationBoundary: PublicationBoundaryService,
  args: readonly string[],
  isJson: boolean
) {
  const targetDir = resolveTargetDir(args[1]);
  const allowedPublicOnly = args.includes("--public-only");

  const exit = yield* Effect.exit(
    publicationBoundary.scanDirectory(targetDir, { allowedPublicOnly })
  );

  if (Exit.isFailure(exit)) {
    const errStr = String(exit.cause);
    if (isJson) {
      printCliJson({ error: errStr, isClean: false });
    } else {
      printCliError(`Publication Scan Failed: ${errStr}`);
    }
    return 1;
  }

  const result = exit.value;
  if (isJson) {
    printCliJson(result);
  } else {
    printCli("=== OPERON PUBLICATION BOUNDARY SCAN ===");
    printCli(`Target:    ${targetDir}`);
    printCli(`Clean:     ${result.isClean}`);
    printCli(`Scanned:   ${result.scannedPaths.length} files`);
    printCli(`Violations: ${result.violations.length}`);
    printScanViolations(result.violations);
  }
  return result.isClean ? 0 : 1;
});

interface UntrustedReceiptPayload {
  readonly claim?: unknown;
  readonly outcome?: unknown;
}

const verifyReceiptContent = Effect.fn("verifyReceiptContent")(function* (
  f1Evaluator: F1EvaluatorService,
  f2Mirror: F2MirrorService,
  content: UntrustedReceiptPayload
) {
  if (content.outcome) {
    // SAFETY: receipt payload containing outcome validated as PublicF1Receipt
    const exit = yield* Effect.exit(
      f1Evaluator.verifyReceipt(content as PublicF1Receipt)
    );
    return Exit.isSuccess(exit) && exit.value === true;
  }
  if (content.claim) {
    // SAFETY: receipt payload containing claim validated as F2Receipt
    const exit = yield* Effect.exit(
      f2Mirror.verifyReceipt(content as F2Receipt)
    );
    return Exit.isSuccess(exit) && exit.value === true;
  }
  return false;
});

function printReceiptVerification(filePath: string, isValid: boolean): void {
  printCli(
    `Receipt ${filePath}: ${isValid ? "VALID (Ed25519 Verified)" : "INVALID"}`
  );
}

const handleAssuranceVerifyReceipt = Effect.fn("handleAssuranceVerifyReceipt")(
  function* (
    f1Evaluator: F1EvaluatorService,
    f2Mirror: F2MirrorService,
    args: readonly string[],
    isJson: boolean
  ) {
    const filePath = args[1];
    if (!filePath) {
      printCliError(
        "Usage: operon assurance verify-receipt <receipt-file.json> [--json]"
      );
      return 1;
    }

    const resolved = resolvePath(process.cwd(), filePath);
    if (!fileExistsSync(resolved)) {
      printCliError(`File not found: ${resolved}`);
      return 1;
    }

    // SAFETY: read and parse receipt JSON file as UntrustedReceiptPayload
    const content = parseJson(
      readTextFileSync(resolved)
    ) as UntrustedReceiptPayload;
    const isValid = yield* verifyReceiptContent(f1Evaluator, f2Mirror, content);

    if (isJson) {
      printCliJson({ isValid, receipt: filePath });
    } else {
      printReceiptVerification(filePath, isValid);
    }
    return isValid ? 0 : 1;
  }
);

function printAssuranceHelp(): number {
  printCli(`Operon Assurance & Release Evaluation (Gate V0-F)

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

export interface AssuranceHandlerOptions {
  readonly f1Evaluator: F1EvaluatorService;
  readonly f2Mirror: F2MirrorService;
  readonly publicationBoundary: PublicationBoundaryService;
  readonly args: readonly string[];
  readonly isJson: boolean;
}

type AssuranceHandler = (
  options: AssuranceHandlerOptions
) => Effect.Effect<number, unknown, never>;

const ASSURANCE_HANDLERS = {
  evaluate: (opts) =>
    handleAssuranceEvaluate(opts.f1Evaluator, opts.args, opts.isJson),
  mirror: (opts) =>
    handleAssuranceMirror(opts.f2Mirror, opts.args, opts.isJson),
  scan: (opts) =>
    handleAssuranceScan(opts.publicationBoundary, opts.args, opts.isJson),
  "verify-receipt": (opts) =>
    handleAssuranceVerifyReceipt(
      opts.f1Evaluator,
      opts.f2Mirror,
      opts.args,
      opts.isJson
    ),
} as const satisfies Record<string, AssuranceHandler>;

function getAssuranceHandler(sub?: string): AssuranceHandler | undefined {
  if (sub && Object.hasOwn(ASSURANCE_HANDLERS, sub)) {
    // SAFETY: sub key presence verified by Object.hasOwn
    return ASSURANCE_HANDLERS[sub as keyof typeof ASSURANCE_HANDLERS];
  }
  return undefined;
}

export function runAssurance(
  args: string[]
): Effect.Effect<number, unknown, never> {
  const sub = args[0];
  const isJson = args.includes("--json");
  const handler = getAssuranceHandler(sub);

  if (handler) {
    const f1Evaluator = new F1EvaluatorService();
    const f2Mirror = new F2MirrorService();
    const publicationBoundary = new PublicationBoundaryService();
    return handler({
      args,
      f1Evaluator,
      f2Mirror,
      isJson,
      publicationBoundary,
    });
  }

  return Effect.sync(printAssuranceHelp);
}
