import { Effect } from "effect";

import { LockAcquisitionError, StaleFencingTokenError } from "./errors.js";

export interface DistributedLock {
  readonly resource: string;
  readonly ownerId: string;
  readonly fencingToken: number;
  readonly acquiredAt: number;
  readonly leaseExpiresAt: number;
}

/**
 * Distributed Lock Manager (DLM) providing fencing tokens and lease timeouts for multi-node clusters
 */
export class DistributedLockManager {
  private static readonly sharedLocks = new Map<string, DistributedLock>();
  private static readonly sharedFencingCounters = new Map<string, number>();

  public static reset(): void {
    DistributedLockManager.sharedLocks.clear();
    DistributedLockManager.sharedFencingCounters.clear();
  }

  private get locks(): Map<string, DistributedLock> {
    return DistributedLockManager.sharedLocks;
  }

  private get fencingCounters(): Map<string, number> {
    return DistributedLockManager.sharedFencingCounters;
  }

  public acquire(
    resource: string,
    ownerId: string,
    ttlMs = 5000
  ): Effect.Effect<DistributedLock, LockAcquisitionError> {
    const now = Date.now();
    const existing = this.locks.get(resource);

    // Check if lock exists and lease is still valid
    if (
      existing &&
      existing.leaseExpiresAt > now &&
      existing.ownerId !== ownerId
    ) {
      return Effect.fail(
        new LockAcquisitionError({
          resource,
          currentOwner: existing.ownerId,
        })
      );
    }

    // Increment fencing token monotonically
    const currentToken = this.fencingCounters.get(resource) ?? 0;
    const nextToken = currentToken + 1;
    this.fencingCounters.set(resource, nextToken);

    const lock: DistributedLock = {
      resource,
      ownerId,
      fencingToken: nextToken,
      acquiredAt: now,
      leaseExpiresAt: now + ttlMs,
    };

    this.locks.set(resource, lock);
    return Effect.succeed(lock);
  }

  public renew(
    lock: DistributedLock,
    extensionMs = 5000
  ): Effect.Effect<DistributedLock, LockAcquisitionError> {
    const now = Date.now();
    const existing = this.locks.get(lock.resource);

    if (
      !existing ||
      existing.ownerId !== lock.ownerId ||
      existing.fencingToken !== lock.fencingToken ||
      existing.leaseExpiresAt < now
    ) {
      return Effect.fail(
        new LockAcquisitionError({
          resource: lock.resource,
          currentOwner: existing?.ownerId ?? "unknown",
        })
      );
    }

    const renewed: DistributedLock = {
      ...existing,
      leaseExpiresAt: now + extensionMs,
    };
    this.locks.set(lock.resource, renewed);
    return Effect.succeed(renewed);
  }

  public release(lock: DistributedLock): Effect.Effect<void> {
    return Effect.sync(() => {
      const existing = this.locks.get(lock.resource);
      if (
        existing &&
        existing.ownerId === lock.ownerId &&
        existing.fencingToken === lock.fencingToken
      ) {
        this.locks.delete(lock.resource);
      }
    });
  }

  public validateFencingToken(
    resource: string,
    fencingToken: number
  ): Effect.Effect<boolean, StaleFencingTokenError> {
    const current = this.fencingCounters.get(resource) ?? 0;
    if (fencingToken < current) {
      return Effect.fail(
        new StaleFencingTokenError({
          resource,
          presentedToken: fencingToken,
          expectedToken: current,
        })
      );
    }
    return Effect.succeed(true);
  }
}

/**
 * Distributed Cluster Coordinator for Multi-Node Write Pipelines and Linearizable Transactions
 */
export class DistributedClusterCoordinator {
  public constructor(private readonly lockManager: DistributedLockManager) {}

  /**
   * Executes a write operation guarded by a distributed lock and fencing token
   */
  public executeGuardedWrite<A, E, R>(
    resource: string,
    nodeId: string,
    writeOp: (lock: DistributedLock) => Effect.Effect<A, E, R>,
    ttlMs = 5000
  ): Effect.Effect<A, E | LockAcquisitionError | StaleFencingTokenError, R> {
    return Effect.gen({ self: this }, function* () {
      const lock = yield* this.lockManager.acquire(resource, nodeId, ttlMs);

      const result = yield* writeOp(lock).pipe(
        Effect.tap(() =>
          this.lockManager.validateFencingToken(resource, lock.fencingToken)
        ),
        Effect.ensuring(this.lockManager.release(lock))
      );

      return result;
    });
  }
}
