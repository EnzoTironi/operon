import { Data, Effect } from "effect";

export class CircuitBreakerOpenError extends Data.TaggedError(
  "CircuitBreakerOpenError"
)<{
  readonly name: string;
  readonly message: string;
}> {}

export class DegradedModeViolationError extends Data.TaggedError(
  "DegradedModeViolationError"
)<{
  readonly mode: DegradeMode;
  readonly message: string;
}> {}

export type CircuitBreakerState = "closed" | "open" | "half_open";

export interface CircuitBreakerConfig {
  readonly failureThreshold: number;
  readonly recoveryTimeoutMs: number;
  readonly successThreshold: number;
}

/**
 * Enterprise Circuit Breaker (Chapter 17: Incident Response & Failure Modes)
 * Protects downstream systems (ERP, SCADA, EHR) and gracefully degrades.
 */
export class CircuitBreaker {
  private state: CircuitBreakerState = "closed";
  private failureCount = 0;
  private successCount = 0;
  private lastFailureTime = 0;

  constructor(
    readonly name: string,
    private readonly config: CircuitBreakerConfig = {
      failureThreshold: 5,
      recoveryTimeoutMs: 10000,
      successThreshold: 2,
    }
  ) {}

  getState(): CircuitBreakerState {
    if (
      this.state === "open" &&
      Date.now() - this.lastFailureTime > this.config.recoveryTimeoutMs
    ) {
      this.state = "half_open";
    }
    return this.state;
  }

  execute<A, E>(
    effect: Effect.Effect<A, E>
  ): Effect.Effect<A, E | CircuitBreakerOpenError> {
    return Effect.gen({ self: this }, function* () {
      const currentState = this.getState();
      if (currentState === "open") {
        return yield* Effect.fail(
          new CircuitBreakerOpenError({
            name: this.name,
            message: `Circuit breaker '${this.name}' is OPEN. Requests shed.`,
          })
        );
      }

      const result = yield* effect.pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            if (this.state === "half_open") {
              this.successCount += 1;
              if (this.successCount >= this.config.successThreshold) {
                this.state = "closed";
                this.failureCount = 0;
                this.successCount = 0;
              }
            } else {
              this.failureCount = 0;
            }
          })
        ),
        Effect.tapError(() =>
          Effect.sync(() => {
            this.failureCount += 1;
            this.lastFailureTime = Date.now();
            if (this.failureCount >= this.config.failureThreshold) {
              this.state = "open";
            }
          })
        )
      );

      return result;
    });
  }
}

export type DegradeMode =
  | "normal"
  | "read_only"
  | "veto_only"
  | "critical_only";

/**
 * Degrade Mode Manager (Chapter 17)
 * Controls permissible operational mutations during partial outages.
 */
export class DegradeModeManager {
  private currentMode: DegradeMode = "normal";

  getMode(): DegradeMode {
    return this.currentMode;
  }

  setMode(mode: DegradeMode): Effect.Effect<void> {
    return Effect.sync(() => {
      this.currentMode = mode;
    });
  }

  assertActionPermitted(options: {
    readonly isVetoOrOverride?: boolean;
    readonly isCritical?: boolean;
  }): Effect.Effect<void, DegradedModeViolationError> {
    return Effect.gen({ self: this }, function* () {
      if (this.currentMode === "normal") {
        return;
      }

      if (this.currentMode === "read_only") {
        return yield* Effect.fail(
          new DegradedModeViolationError({
            mode: this.currentMode,
            message:
              "System is in read_only degrade mode. All operational writes are paused.",
          })
        );
      }

      if (this.currentMode === "veto_only") {
        if (!options.isVetoOrOverride) {
          return yield* Effect.fail(
            new DegradedModeViolationError({
              mode: this.currentMode,
              message:
                "System is in veto_only degrade mode. Only emergency human vetoes/overrides are permitted.",
            })
          );
        }
        return;
      }

      if (
        this.currentMode === "critical_only" &&
        !options.isCritical &&
        !options.isVetoOrOverride
      ) {
        return yield* Effect.fail(
          new DegradedModeViolationError({
            mode: this.currentMode,
            message:
              "System is in critical_only degrade mode. Non-critical background actions are shed.",
          })
        );
      }
    });
  }
}

export interface ComponentHealth {
  readonly name: string;
  readonly status: "healthy" | "degraded" | "unhealthy";
  readonly details: string;
  readonly lastChecked: number;
}

export interface SystemHealthStatus {
  readonly overall: "healthy" | "degraded" | "critical";
  readonly activeDegradeMode: DegradeMode;
  readonly components: Record<string, ComponentHealth>;
  readonly timestamp: number;
}

/**
 * Failure Mode Health Map (Chapter 17, Figure 17-01)
 * Collects runtime telemetry across OSv2, OMS, OSS, Funnel, and Action Pipeline.
 */
export class SystemHealthMap {
  private probes = new Map<string, () => Effect.Effect<ComponentHealth>>();

  constructor(private readonly degradeManager: DegradeModeManager) {}

  registerProbe(
    name: string,
    probe: () => Effect.Effect<ComponentHealth>
  ): void {
    this.probes.set(name, probe);
  }

  evaluateHealth(): Effect.Effect<SystemHealthStatus> {
    return Effect.gen({ self: this }, function* () {
      const components: Record<string, ComponentHealth> = {};
      let hasUnhealthy = false;
      let hasDegraded = false;

      for (const [name, probe] of this.probes.entries()) {
        const health = yield* probe();
        components[name] = health;
        if (health.status === "unhealthy") {
          hasUnhealthy = true;
        } else if (health.status === "degraded") {
          hasDegraded = true;
        }
      }

      let overall: "healthy" | "degraded" | "critical" = "healthy";
      if (hasUnhealthy) {
        overall = "critical";
      } else if (hasDegraded) {
        overall = "degraded";
      }

      return {
        overall,
        activeDegradeMode: this.degradeManager.getMode(),
        components,
        timestamp: Date.now(),
      };
    });
  }
}
