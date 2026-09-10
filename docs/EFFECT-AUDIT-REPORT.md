# Full Effect-TS & Type-System Audit Report

**Date:** 2026-09-10  
**Scope:** Monorepo packages ([packages/schema](file:///Users/enzotironi/operationalonto/packages/schema), [packages/runtime](file:///Users/enzotironi/operationalonto/packages/runtime), [packages/osdk](file:///Users/enzotironi/operationalonto/packages/osdk), [packages/mcp](file:///Users/enzotironi/operationalonto/packages/mcp), [packages/cli](file:///Users/enzotironi/operationalonto/packages/cli), [packages/telemetry](file:///Users/enzotironi/operationalonto/packages/telemetry), and [packages/alchemy](file:///Users/enzotironi/operationalonto/packages/alchemy)).  
**Guiding Directives:** [AGENTS.md](file:///Users/enzotironi/operationalonto/AGENTS.md) (_Type-System Discipline_, _Narrow Effect Contracts_, _Pre-launch Evolution_, _Effect Idioms_).

---

## 1. Executive Assessment

Operon possesses strong domain foundations—Effect 4, branded identifier utilities, and declarative ontology modeling. However, the codebase is currently in a transitional state between standard imperative TypeScript (classes, mutable singletons, native `Promise`, bags of optional properties, and `as any` casts) and idiomatic Effect-TS (first-class `Context.Tag` / `Layer`, immutable `Ref` concurrency, typed `Schema.TaggedError`, and discriminated tagged unions).

Applying the [AGENTS.md](file:///Users/enzotironi/operationalonto/AGENTS.md) directives systematically will eliminate hundreds of lines of defensive fallback guessing, prevent latent multi-tenant security bypasses, and align the architecture with Effect best practices.

---

## 2. Detailed Audit by Directive

### Directive A: Type-System Discipline

> _"The type checker is a proof assistant. Use it to eliminate impossible states, mismatched primitives, and unhandled variants at compile time... Don't lie to the type system."_

#### A.1. Bags of Optionals Admitting Illegal States (vs. Discriminated Unions)

A prevalent pattern in the domain models is grouping mutually exclusive variants or interdependent fields into a single interface as optional properties:

1. **`ActionSubmission` in [`packages/runtime/src/write-pipeline.ts:34-46`](file:///Users/enzotironi/operationalonto/packages/runtime/src/write-pipeline.ts#L34-L46):**

   ```ts
   export interface ActionSubmission<Params = unknown> {
     readonly actionType: ActionType<Params>;
     readonly rawParameters: unknown;
     readonly security: SecurityContext;
     readonly isApprovedProposal?: boolean; // Optional boolean
     readonly approvalToken?: ApprovalToken; // Independent optional token
   }
   ```
   - **Illegal State:** Allows `{ isApprovedProposal: true }` without an `approvalToken`, or supplying an `approvalToken` when `isApprovedProposal: false`.
   - **Remedy:** Model as a discriminated sum type:
     ```ts
     export type ActionSubmission<Params = unknown> =
       StandardActionSubmission<Params> | ApprovedProposalSubmission<Params>; // requires approvalToken
     ```

2. **`ObjectMutation` in [`packages/runtime/src/object-store.ts:11-16`](file:///Users/enzotironi/operationalonto/packages/runtime/src/object-store.ts#L11-L16):**

   ```ts
   export interface ObjectMutation {
     readonly type: "put" | "delete";
     readonly instance?: ObjectInstance;
     readonly typeId?: ObjectTypeId;
     readonly id?: string;
   }
   ```
   - **Illegal State:** Allows `{ type: "put" }` without `instance`, or `{ type: "delete" }` without `typeId` / `id`.
   - **Remedy:**
     ```ts
     export type ObjectMutation =
       | { readonly type: "put"; readonly instance: ObjectInstance }
       | {
           readonly type: "delete";
           readonly typeId: ObjectTypeId;
           readonly id: string;
         };
     ```

3. **`ActionProposalItem` in [`packages/runtime/src/inbox.ts:23-34`](file:///Users/enzotironi/operationalonto/packages/runtime/src/inbox.ts#L23-L34):**

   ```ts
   readonly status: "pending" | "claimed" | "approved" | "rejected";
   readonly claimedBy?: string;
   readonly claimedAt?: number;
   ```
   - **Illegal State:** Allows a `pending` proposal to have `claimedBy` populated, or a `claimed` proposal to have `claimedBy: undefined`.
   - **Remedy:** Model variants as tagged records (`PendingProposalItem`, `ClaimedProposalItem`, etc.).

4. **`SubmissionCriterion` in [`packages/schema/src/action-type.ts:36-40`](file:///Users/enzotironi/operationalonto/packages/schema/src/action-type.ts#L36-L40):**

   ```ts
   evaluate: (...) => Effect.Effect<{
     readonly passed: boolean;
     readonly verdict?: DecisionVerdict;
     readonly failureReason?: string;
   }>;
   ```
   - **Illegal State:** Allows `passed: false` without a `failureReason`, or `passed: true` with an erroneous failure reason attached.
   - **Remedy:** Tagged union: `{ readonly passed: true } | { readonly passed: false; readonly verdict: DecisionVerdict; readonly failureReason: string }`.

5. **`DebeziumCdcPayload` in [`packages/runtime/src/connectors.ts:21-27`](file:///Users/enzotironi/operationalonto/packages/runtime/src/connectors.ts#L21-L27):**
   ```ts
   readonly before: Record<string, unknown> | null;
   readonly after: Record<string, unknown> | null;
   readonly op: "c" | "u" | "d" | "r";
   ```
   - **Illegal State:** In CDC, create (`"c"`) requires `before: null` and `after: non-null`; delete (`"d"`) requires `after: null` and `before: non-null`. The current type permits contradictory combinations.

---

#### A.2. Don't Lie to the Type System (`as any` & Unsafe Coercions)

There are **over 60 occurrences** of `as any` in production code:

- **Error Constructors in [`packages/runtime/src/errors.ts:15-258`](file:///Users/enzotironi/operationalonto/packages/runtime/src/errors.ts#L15-L258):** Virtually every `Data.TaggedError` subclass bypasses typechecking with `super(args as any)`:

  ```ts
  export class ParameterValidationError extends Data.TaggedError("ParameterValidationError")<{ ... }> {
    constructor(args: { ... }) {
      super(args as any); // 19 instances of "super(args as any)"
    }
  }
  ```
  - **Remedy:** Migrate to `Schema.TaggedError` (as already done cleanly in [`CandidateNotFoundError`](file:///Users/enzotironi/operationalonto/packages/runtime/src/errors.ts#L305-L312)), which automatically generates type-safe constructors, JSON serialization, and Schema decoding with zero `as any`.

- **Cast Escapes in Migrations ([`packages/runtime/src/migration.ts:82, 85, 99, 104, 130`](file:///Users/enzotironi/operationalonto/packages/runtime/src/migration.ts#L82-L130)):**

  ```ts
  const existing = yield * this.store.getObject(objectTypeId as any, id);
  ```
  - **Violation:** Accepts `objectTypeId: string` instead of `ObjectTypeId`, then forces it past the store with `as any`.

- **Untyped AST Access in OSDK & MCP Projection:**
  - [`packages/mcp/src/projection.ts:100`](file:///Users/enzotironi/operationalonto/packages/mcp/src/projection.ts#L100): `const schemaAst = (action.parametersSchema as any)?.ast;`
  - [`packages/osdk/src/generator.ts:64, 90`](file:///Users/enzotironi/operationalonto/packages/osdk/src/generator.ts#L64): `const ast = (at.parametersSchema as any)?.ast;`
  - **Remedy:** Use Effect’s typed AST APIs (`Schema.AST`) instead of casting schemas to `any`.

---

#### A.3. Missing Semantic Primitive Branding

In [`packages/schema/src/types.ts`](file:///Users/enzotironi/operationalonto/packages/schema/src/types.ts), branded primitives (`ObjectId`, `ObjectTypeId`, `LinkTypeId`, `ActionTypeId`) are defined:

```ts
export const ObjectId = Schema.String.pipe(Schema.brand("ObjectId"));
```

However, core definition schemas do not use them:

- In [`packages/schema/src/definition.ts:29-84`](file:///Users/enzotironi/operationalonto/packages/schema/src/definition.ts#L29-L84), `TypeDef.id`, `LinkDef.id`, `LinkDef.sourceTypeId`, `LinkDef.targetTypeId`, and `ActionDef.id` revert to unbranded `Schema.String`.
- This allows callers to swap strings freely, forcing downstream modules to re-cast via `as ObjectTypeId` or `as any`.

---

#### A.4. Non-Exhaustive Matching

- In [`packages/runtime/src/funnel.ts:193-210`](file:///Users/enzotironi/operationalonto/packages/runtime/src/funnel.ts#L193-L210), conflict resolution uses:
  ```ts
  switch (policy) {
    case "source_wins": ...
    case "user_edit_wins": ...
    case "timestamp_wins": ...
    default: return true; // Destroys exhaustiveness
  }
  ```
  If a new `ConflictResolutionPolicy` is added, the compiler will not signal unhandled cases.
- **Remedy:** Replace imperative `switch` with Effect's `Match.typeTags` or `Match.value`, or verify exhaustive branch termination using `const _exhaustiveCheck: never = policy;`.

---

### Directive B: Narrow Effect Contracts (Live Code Path Discipline)

> _"Live code paths determine the contract... Prune defensive fallbacks... Do not preserve optional fields or `Option<T>` for test convenience."_

#### B.1. Multi-Tier Parameter Guessing Ladders

- **5-Way Guessing Ladder in [`packages/runtime/src/write-pipeline.ts:196-200`](file:///Users/enzotironi/operationalonto/packages/runtime/src/write-pipeline.ts#L196-L200):**

  ```ts
  const targetId =
    (pRecord.targetId as string | undefined) ??
    (pRecord[typeKey] as string | undefined) ??
    (pRecord.patientId as string | undefined) ??
    (pRecord.id as string | undefined) ??
    (pRecord.targetObjectId as string | undefined);
  ```

  Rather than enforcing an authoritative schema for action targets, the runtime guesses across 5 property names to satisfy varied test setups.

- **Multi-Tier Identity Defaulting in [`packages/runtime/src/auth.ts:257-293`](file:///Users/enzotironi/operationalonto/packages/runtime/src/auth.ts#L257-L293):**
  ```ts
  const tenantId =
    claims.tenantId ??
    (claims.attributes?.tenantId as string | undefined) ??
    process.env.OPERON_TENANT_ID ??
    "tenant-default";
  ```
  Boundary parsing failures are silenced by cascading default fallbacks. External tokens must be decoded through a strict `Schema.Schema` at ingress.

---

#### B.2. Optional Security Contexts Creating Silent Auth Bypasses

- In [`packages/runtime/src/oms.ts:142-155`](file:///Users/enzotironi/operationalonto/packages/runtime/src/oms.ts#L142-L155):
  ```ts
  private checkContext(
    context?: ContextOptions | AgentContext // Optional
  ): Effect.Effect<void, AuthorizationError> {
    if (!context) return Effect.void; // Bypasses security checks!
  ```
  Because `context` was made optional to make unit testing easy, production callers in [`packages/cli/src/commands/oms.ts:40`](file:///Users/enzotironi/operationalonto/packages/cli/src/commands/oms.ts#L40) omit it:
  ```ts
  const branch = yield * ctx.oms.createBranch(branchName, author); // No context passed!
  ```
  **Result:** Multi-tenant isolation and environment fencing are silently bypassed in production CLI execution.

---

#### B.3. Synthetic Mock Leakage into Production Modules

- **Disconnected OMS in MCP Server ([`packages/mcp/src/server.ts:36, 52`](file:///Users/enzotironi/operationalonto/packages/mcp/src/server.ts#L36-L52)):**

  ```ts
  export interface OperonMcpServerOptions {
    readonly oms?: OntologyMetadataService; // Optional
  }
  // ...
  const oms = options.oms ?? new OntologyMetadataService(); // Fallback instance!
  ```

  Because `oms` was made optional for unit tests, [`packages/cli/src/commands/mcp.ts:33-47`](file:///Users/enzotironi/operationalonto/packages/cli/src/commands/mcp.ts#L33-L47) failed to provide `ctx.oms`. The running MCP server silently boots an empty, in-memory OMS instance disconnected from the CLI database.

- **Fabricated Identity in OSDK ([`packages/osdk/src/client.ts:97-107`](file:///Users/enzotironi/operationalonto/packages/osdk/src/client.ts#L97-L107)):**
  ```ts
  const effectiveSecurity = security ??
    config.defaultSecurity ?? {
      correlationId: `osdk_${Date.now()}`,
      subject: {
        id: "osdk-client",
        name: "OSDK Client",
        roles: ["client"],
        type: "agent",
      },
      timestamp: Date.now(),
    };
  ```
  The client silently manufactures an unverified `"osdk-client"` agent identity if security is omitted. Callers should be forced to pass verified credentials.

---

#### B.4. `Effect.succeed(undefined)` vs. Typed Absence

- In [`packages/runtime/src/object-store.ts:24-27`](file:///Users/enzotironi/operationalonto/packages/runtime/src/object-store.ts#L24-L27) and [`packages/runtime/src/bitemporal-store.ts:31-39`](file:///Users/enzotironi/operationalonto/packages/runtime/src/bitemporal-store.ts#L31-L39):
  ```ts
  getObject: (typeId: ObjectTypeId, id: string) =>
    Effect.Effect<ObjectInstance | undefined>;
  ```
  Returning `undefined` inside `Effect.succeed` forces callers into raw JS null checks (`if (!obj)`), disabling Effect's functional composition (`Option.match`, `Effect.flatten`, `Effect.some`).
  - **Remedy:** Signature should be `Effect.Effect<Option.Option<ObjectInstance>>` or `Effect.Effect<ObjectInstance, ObjectNotFoundError>`.

---

#### B.5. Over-Widened Error Channels (`unknown` / generic `Error`)

- **OSDK Action Execution ([`packages/osdk/src/client.ts:38`](file:///Users/enzotironi/operationalonto/packages/osdk/src/client.ts#L38)):**
  ```ts
  readonly execute: (params: Params, security?: SecurityContext) => Effect.Effect<ActionExecutionResult, unknown>;
  ```
  The error channel `E` is completely erased to `unknown`.
- **Sandboxed Model Runner ([`packages/runtime/src/sandbox.ts:14`](file:///Users/enzotironi/operationalonto/packages/runtime/src/sandbox.ts#L14)):**
  ```ts
  readonly compute: (inputs: Record<string, unknown>) => Effect.Effect<Record<string, unknown>, Error>;
  ```
  Error channel is widened to untyped JavaScript `Error` instead of a tagged error union.
- **CLI `catch: (e) => e` Pattern (21 occurrences across `packages/cli/src/commands/`):**
  ```ts
  yield* Effect.tryPromise({ catch: (e) => e, try: () => ... })
  ```
  Because error channels are caught into `unknown`, downstream CLI commands resort to `(error as any)?.message` to print failures.

---

### Directive C: Idiomatic Effect Architecture

> _"Search `node_modules/effect/src` for APIs the guide does not cover... Prefer total functions."_

#### C.1. Inconsistent Async Model: `Promise` vs. `Effect` in Core Stores

There is an architectural split between the storage interfaces:

- [`ObjectStore`](file:///Users/enzotironi/operationalonto/packages/runtime/src/object-store.ts#L23-L56) is **Effect-native** (`Effect.Effect<...>`).
- [`AuditStore`](file:///Users/enzotironi/operationalonto/packages/runtime/src/audit.ts#L85-L97) is **Promise-native**:
  ```ts
  export interface AuditStore {
    readonly appendDecision: (record: Omit<DecisionRecord, "recordHash">) => Promise<DecisionRecord>;
    readonly getDecision: (id: string) => Promise<DecisionRecord | undefined>;
    readonly listDecisions: (...) => Promise<readonly DecisionRecord[]>;
    readonly verifyAuditChain: () => Promise<boolean>;
  }
  ```
  **Consequence:** The write pipeline in [`packages/runtime/src/write-pipeline.ts:525-535`](file:///Users/enzotironi/operationalonto/packages/runtime/src/write-pipeline.ts#L525-L535) is forced to bridge `AuditStore` with `Effect.tryPromise`, which erases errors to `unknown` and requires defensive error casting.
  - **Remedy:** Standardize `AuditStore` on `Effect.Effect<DecisionRecord, StorageError>`.

---

#### C.2. Complete Absence of `Context.Tag` and `Layer`

Throughout the monorepo, **`Context.Tag` is used 0 times**, and **`Layer` is used only once** (in telemetry). Instead, dependencies are passed manually via constructors or stored in mutable singletons:

- [`OperonTelemetryService`](file:///Users/enzotironi/operationalonto/packages/telemetry/src/service.ts#L22-L49) uses a mutable static singleton: `private static instance: OperonTelemetryService | null = null;`.
- [`TokenRevocationRegistry`](file:///Users/enzotironi/operationalonto/packages/runtime/src/auth.ts#L38-L46) uses a global module-level mutable `Set<string>`.
- [`ActionInbox.sharedProposals`](file:///Users/enzotironi/operationalonto/packages/runtime/src/inbox.ts#L37-L40) uses a static `WeakMap`.

**Idiomatic Effect Solution:** Define service dependencies as `Context.Tag`:

```ts
export class ObjectStoreService extends Context.Tag("ObjectStore")<
  ObjectStoreService,
  ObjectStore
>() {}

export class AuditStoreService extends Context.Tag("AuditStore")<
  AuditStoreService,
  AuditStore
>() {}
```

Use `Layer` to compose live implementations (`SqlObjectStoreLive`, `BitemporalObjectStoreLive`, `AuditStoreLive`) and test mock implementations. This eliminates singleton resets, static registries, and manual constructor plumbing.

---

#### C.3. Fiber-Unsafe Mutable State in Concurrency Primitives

- **[`CircuitBreaker`](file:///Users/enzotironi/operationalonto/packages/runtime/src/resilience.ts#L29-L42) in `resilience.ts`:**
  ```ts
  export class CircuitBreaker {
    private state: CircuitBreakerState = "closed";
    private failureCount = 0;
    private lastFailureTime = 0;
  ```
  Using raw mutable variables in classes executed across concurrent Effect fibers introduces race conditions.
  - **Remedy:** Use Effect's atomic concurrency primitives: `Ref.Ref<CircuitBreakerState>`, `SynchronizedRef`, or native Effect `Schedule` policies for backoff and retries.

---

#### C.4. Worker Handler Bypassing Effect HTTP Pipeline

In [`packages/alchemy/src/worker-handler.ts:51-65`](file:///Users/enzotironi/operationalonto/packages/alchemy/src/worker-handler.ts#L51-L65):

```ts
const authResult = await Effect.runPromise(
  authMiddleware.authenticateHeader(authHeader, clientIp).pipe(Effect.result)
);
if (authResult._tag === "Failure") {
  // Accessing failure cause via (authResult.failure as any).reason!
```

The HTTP handler runs an individual effect, inspects the raw `Exit` object with unsafe casts `(authResult.failure as any).reason`, and catches errors with `(err as any)._tag === "AuthorizationError"`.

- **Remedy:** Keep the entire request-response lifecycle inside an `Effect.gen` and run it once at the outer worker boundary using `Effect.catchTags` to map domain errors cleanly to HTTP status codes (401, 403, 404, 500).

---

### Directive D: Pre-launch Evolution

> _"Operon has not launched... Optimize for the smallest coherent design that represents the product today. Remove obsolete code, schemas, APIs, configuration, aliases, and transitional paths directly."_

- **Duplicated Utilities:**
  - [`canonicalJson`](file:///Users/enzotironi/operationalonto/packages/schema/src/definition.ts#L179-L200) is implemented in `packages/schema/src/definition.ts` AND duplicated verbatim in [`packages/runtime/src/audit.ts:47-79`](file:///Users/enzotironi/operationalonto/packages/runtime/src/audit.ts#L47-L79).
  - **Action:** Consolidate into `@operon/schema` and export once.
- **Transitional Fallback Aliases:**
  - Field aliases in `write-pipeline.ts` (`targetId`, `[typeKey]`, `patientId`, `id`, `targetObjectId`) were retained during refactoring.
  - **Action:** Delete the 4 legacy aliases directly; update all callers and tests to supply the canonical parameter name atomically.

---

## 3. Prioritized Architectural Roadmap

| Phase | Target Area | Directives Addressed | Key Actions |
| :-- | :-- | :-- | :-- |
| **Phase 1** | **Sum Types & Domain Invariants** | _Type-System Discipline_, _Narrow Contracts_ | Refactor `ObjectMutation`, `ActionSubmission`, `ActionProposalItem`, and `SubmissionCriterion` into Discriminated Tagged Unions. Eliminate impossible states. |
| **Phase 2** | **Error Hierarchy & Cast Cleanup** | _Don't Lie to Type System_, _Narrow Contracts_ | Migrate all errors in `packages/runtime/src/errors.ts` to `Schema.TaggedError`. Remove `super(args as any)`. Eliminate `catch: (e) => e` in CLI. |
| **Phase 3** | **Unify Store Signatures** | _Effect Idioms_, _Pre-launch Evolution_ | Migrate `AuditStore` from `Promise` to `Effect.Effect`. Transition `ObjectStore.getObject` from `undefined` to `Option<ObjectInstance>`. |
| **Phase 4** | **Enforce Security Boundaries** | _Narrow Contracts_, _Live Paths Truth_ | Make `AgentContext` strictly required in `OMS` and `MCP`. Eliminate fallback mock identities in OSDK and disconnected OMS fallbacks. |
| **Phase 5** | **Prune Fallback Guessing & Branding** | _Boundary Discipline_, _Brand Primitives_ | Enforce `ObjectTypeId` / `LinkTypeId` in `definition.ts`. Replace multi-tier guessing in `write-pipeline.ts` and `auth.ts` with strict boundary schemas. |
| **Phase 6** | **Service Layers & Concurrency** | _Effect Idioms_ | Introduce `Context.Tag` and `Layer` for `ObjectStore`, `AuditStore`, `OMS`, and `Telemetry`. Replace mutable class state in `CircuitBreaker` with Effect `Ref`. |
