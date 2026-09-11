import { Clock, Data, Effect, Ref } from "effect";

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

interface InternalBreakerState {
  readonly state: CircuitBreakerState;
  readonly failureCount: number;
  readonly successCount: number;
  readonly lastFailureTime: number;
}

/**
 * Enterprise Circuit Breaker (Chapter 17: Incident Response & Failure Modes)
 * Protects downstream systems (ERP, SCADA, EHR) and gracefully degrades.
 */
const defaultCircuitBreakerConfig: CircuitBreakerConfig = {
  failureThreshold: 5,
  recoveryTimeoutMs: 10_000,
  successThreshold: 2,
};

export class CircuitBreaker {
  private readonly stateRef: Ref.Ref<InternalBreakerState>;

  constructor(
    readonly name: string,
    private readonly config: CircuitBreakerConfig = defaultCircuitBreakerConfig
  ) {
    this.stateRef = Ref.makeUnsafe<InternalBreakerState>({
      failureCount: 0,
      lastFailureTime: 0,
      state: "closed",
      successCount: 0,
    });
  }

  getState(): CircuitBreakerState {
    const current = Ref.getUnsafe(this.stateRef);
    if (
      current.state === "open" &&
      Date.now() - current.lastFailureTime > this.config.recoveryTimeoutMs
    ) {
      return "half_open";
    }
    return current.state;
  }

  readonly execute = Effect.fn("CircuitBreaker.execute")(function* <A, E>(
    this: CircuitBreaker,
    effect: Effect.Effect<A, E>
  ): Effect.fn.Return<A, E | CircuitBreakerOpenError> {
    const now = yield* Clock.currentTimeMillis;
    const currentState = yield* Ref.modify(this.stateRef, (current) => {
      if (
        current.state === "open" &&
        now - current.lastFailureTime > this.config.recoveryTimeoutMs
      ) {
        const next: InternalBreakerState = {
          ...current,
          state: "half_open",
        };
        return [next.state, next];
      }
      return [current.state, current];
    });

    if (currentState === "open") {
      return yield* new CircuitBreakerOpenError({
        message: `Circuit breaker '${this.name}' is OPEN. Requests shed.`,
        name: this.name,
      });
    }

    const recordFailure = Effect.fn("CircuitBreaker.recordFailure")(function* (
      breaker: CircuitBreaker
    ) {
      const errNow = yield* Clock.currentTimeMillis;
      yield* Ref.update(breaker.stateRef, (current): InternalBreakerState => {
        const newFailureCount = current.failureCount + 1;
        const shouldOpen = newFailureCount >= breaker.config.failureThreshold;
        return {
          ...current,
          failureCount: newFailureCount,
          lastFailureTime: errNow,
          state: shouldOpen ? "open" : current.state,
        };
      });
    });

    const result = yield* effect.pipe(
      Effect.tap(() =>
        Ref.update(this.stateRef, (current): InternalBreakerState => {
          if (current.state === "half_open") {
            const newSuccessCount = current.successCount + 1;
            if (newSuccessCount >= this.config.successThreshold) {
              return {
                ...current,
                failureCount: 0,
                state: "closed",
                successCount: 0,
              };
            }
            return { ...current, successCount: newSuccessCount };
          }
          return { ...current, failureCount: 0 };
        })
      ),
      Effect.tapError(() => recordFailure(this))
    );

    return result;
  });
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

  readonly assertActionPermitted = Effect.fn(
    "DegradeModeManager.assertActionPermitted"
  )(function* (
    this: DegradeModeManager,
    options: {
      readonly isVetoOrOverride?: boolean;
      readonly isCritical?: boolean;
    }
  ): Effect.fn.Return<void, DegradedModeViolationError> {
    if (this.currentMode === "normal") {
      return;
    }

    if (this.currentMode === "read_only") {
      return yield* new DegradedModeViolationError({
        mode: this.currentMode,
        message:
          "System is in read_only degrade mode. All operational writes are paused.",
      });
    }

    if (this.currentMode === "veto_only") {
      if (!options.isVetoOrOverride) {
        return yield* new DegradedModeViolationError({
          mode: this.currentMode,
          message:
            "System is in veto_only degrade mode. Only emergency human vetoes/overrides are permitted.",
        });
      }
      return;
    }

    if (
      this.currentMode === "critical_only" &&
      !options.isCritical &&
      !options.isVetoOrOverride
    ) {
      return yield* new DegradedModeViolationError({
        mode: this.currentMode,
        message:
          "System is in critical_only degrade mode. Non-critical background actions are shed.",
      });
    }
  });
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

      yield* Effect.forEach(
        [...this.probes.entries()],
        Effect.fn("AdaptiveResilienceService.checkProbe")(function* ([
          name,
          probe,
        ]) {
          const health = yield* probe();
          components[name] = health;
          if (health.status === "unhealthy") {
            hasUnhealthy = true;
          } else if (health.status === "degraded") {
            hasDegraded = true;
          }
        }),
        { concurrency: 1 }
      );

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
        timestamp: yield* Clock.currentTimeMillis,
      };
    });
  }
}
