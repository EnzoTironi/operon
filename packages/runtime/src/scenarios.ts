import type {
  ContractCandidate,
  ScenarioManifest,
  ScenarioReceipt,
} from "@operon/schema";
import {
  computeScenarioManifestDigest,
  computeScenarioReceiptHash,
} from "@operon/schema";
import { Clock, Effect, Exit } from "effect";

import { SandboxContainmentError } from "./actions-errors.js";

export interface SimulatedDispatchCommand {
  readonly command: string;
  readonly payload: Record<string, unknown>;
  readonly isProductionTarget: boolean;
}

export class SimulatedEffectBroker {
  private readonly dispatchedCommands: SimulatedDispatchCommand[] = [];
  private blockedEgressCount = 0;

  dispatch(
    cmd: SimulatedDispatchCommand
  ): Effect.Effect<void, SandboxContainmentError> {
    if (cmd.isProductionTarget) {
      this.blockedEgressCount++;
      return Effect.fail(
        new SandboxContainmentError({
          escapeType: "effect",
          message: `Simulation attempted to emit production effect '${cmd.command}'; blocked by SimulatedEffectBroker`,
          target: cmd.command,
        })
      );
    }
    this.dispatchedCommands.push(cmd);
    return Effect.void;
  }

  getBlockedEgressCount(): number {
    return this.blockedEgressCount;
  }

  getDispatchedCommands(): readonly SimulatedDispatchCommand[] {
    return this.dispatchedCommands;
  }
}

export class ScenarioRunner {
  private readonly broker = new SimulatedEffectBroker();

  getBroker(): SimulatedEffectBroker {
    return this.broker;
  }

  /**
   * Validate containment against network, filesystem, and credential escape attempts (S10)
   */
  readonly validateContainment = Effect.fn(
    "ScenarioRunner.validateContainment"
  )(function* (
    this: ScenarioRunner,
    probe: {
      readonly networkTarget?: string;
      readonly filePath?: string;
      readonly credentialAccessKey?: string;
      readonly isProductionDispatcher?: boolean;
    }
  ): Effect.fn.Return<void, SandboxContainmentError> {
    // 1. Network escape test: metadata endpoints and non-permitted egress
    if (probe.networkTarget) {
      const target = probe.networkTarget;
      const forbidden = [
        "169.254.169.254", // Cloud metadata service
        "10.0.0.",
        "192.168.",
        "production.internal",
        "api.stripe.com",
      ];
      if (forbidden.some((f) => target.includes(f))) {
        return yield* new SandboxContainmentError({
          escapeType: "network",
          message: `Forbidden network egress to '${target}' blocked`,
          target,
        });
      }
    }

    // 2. Filesystem escape test: path traversal and host secrets
    if (probe.filePath) {
      const filePath = probe.filePath;
      const forbiddenPaths = [
        "../",
        "/etc/passwd",
        "/etc/shadow",
        "/proc",
        "/root",
        ".ssh",
        ".env",
      ];
      if (forbiddenPaths.some((p) => filePath.includes(p))) {
        return yield* new SandboxContainmentError({
          escapeType: "filesystem",
          message: `Filesystem escape via path '${filePath}' blocked`,
          target: filePath,
        });
      }
    }

    // 3. Credential escape test: access to runtime production secrets
    if (probe.credentialAccessKey) {
      const protectedSecrets = [
        "OPERON_DATABASE_URL",
        "OPERON_SECRET_KEY",
        "PROD_API_KEY",
        "SIGNING_PRIVATE_KEY",
      ];
      if (protectedSecrets.includes(probe.credentialAccessKey)) {
        return yield* new SandboxContainmentError({
          escapeType: "credential",
          message: `Credential escape attempt on key '${probe.credentialAccessKey}' blocked`,
          target: probe.credentialAccessKey,
        });
      }
    }

    // 4. Production effect escape test
    if (probe.isProductionDispatcher) {
      return yield* new SandboxContainmentError({
        escapeType: "effect",
        message:
          "Simulation attempted to access production dispatcher directly",
        target: "production_dispatcher",
      });
    }
  });

  /**
   * runScenario (S10 / V1-06 Contract Sketch):
   * runScenario(manifest, candidate): Promise<ScenarioReceipt> (or Effect)
   */
  readonly runScenario = Effect.fn("ScenarioRunner.runScenario")(function* (
    this: ScenarioRunner,
    manifest: ScenarioManifest,
    candidate: ContractCandidate,
    simulationWork?: (
      runner: ScenarioRunner
    ) => Effect.Effect<number, SandboxContainmentError>
  ): Effect.fn.Return<ScenarioReceipt, SandboxContainmentError> {
    const now = yield* Clock.currentTimeMillis;
    const manifestDigest = computeScenarioManifestDigest(manifest);

    const violations: string[] = [];
    let executedActionsCount = 0;

    if (simulationWork) {
      const workExit = yield* Effect.exit(simulationWork(this));
      if (Exit.isSuccess(workExit)) {
        executedActionsCount = workExit.value;
      } else {
        const err = workExit.cause;
        violations.push(String(err));
      }
    }

    const status: "completed" | "failed" | "contained" =
      violations.length > 0 ? "contained" : "completed";

    const receiptWithoutHash = {
      candidateDigest: candidate.candidateDigest,
      containmentViolations: violations,
      egressAttemptsBlocked: this.broker.getBlockedEgressCount(),
      executedActionsCount,
      executedAt: now,
      manifestDigest,
      productionEffectsEmitted: 0 as const, // Invariant: strictly 0
      scenarioId: manifest.scenarioId,
      status,
    };

    const receipt: ScenarioReceipt = {
      ...receiptWithoutHash,
      receiptHash: computeScenarioReceiptHash(receiptWithoutHash),
    };

    return receipt;
  });
}
