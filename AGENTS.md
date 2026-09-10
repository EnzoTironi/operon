# Learning more about Effect

This repository uses the Effect Typescript library.

Before writing any Effect code, first read `node_modules/effect/AGENTS.md` **completely**, and follow its links when required. Search `node_modules/effect/src` for APIs the guide does not cover. Also `.agents/skills/effect` **completely**

## Pre-launch Evolution

Operon has not launched and has no production users or production data. Revisit this policy before the first production deployment.

Optimize for the smallest coherent design that represents the product today.

Remove obsolete code, schemas, APIs, configuration, aliases, and transitional paths directly.

Do not add backward-compatibility shims, legacy aliases, dual-read or dual-write paths, or data-preserving backfills unless the user explicitly asks for them.

Internal interfaces are not public compatibility contracts. Update their callers and tests atomically when they change.

Development and test data are disposable. Prefer recreating those databases over complicating the product to preserve local data.

Treat migration history as a replaceable development baseline but keep the checked-in migration chain and setup workflow coherent. Do not rewrite an already-applied migration without also resetting affected development and test databases.

Preserve database invariants, transactional safety, migration idempotence, and deterministic setup. These are correctness properties, not backward-compatibility requirements.

Consolidate the migration baseline only as an explicit coordinated change rather than as incidental work in a feature branch.

**Agents: apply this policy every turn** until the first production deployment. Prefer delete/migrate-callers-atomically over compatibility layers.

## Type-Sistem Discipline

Type System Discipline The type checker is a proof assistant. Use it to eliminate impossible states, mismatched primitives, and unhandled variants at compile time. A case the types let you ignore becomes a runtime failure the compiler could have stopped. Prefer defining errors and special cases out of existence over proliferating handlers. Unrepresentable states, total functions, and interface redesign (the patterns below) are the tools.

Applies to any typed language. Skills like typescript-best-practices ground it in specific syntax.

The patterns:

Make illegal states unrepresentable. Model variants as sum types: discriminated unions in TypeScript, enums with payloads in Rust/Swift/Kotlin, sealed classes in Scala, ADTs in Haskell/OCaml. Don't model state as a bag of optional fields where contradictory combinations compile. A subtle anti-pattern: { completed: boolean; completedAt?: Date } admits completed: true; completedAt: undefined, which is meaningless. Derive the boolean from a single source like completedAt !== null, or model the variants explicitly as { kind: 'open' } | { kind: 'done'; at: Date }. If a bug forces the question "wait, can this combination actually happen?", the type is too loose. Types are constructions, not restrictions. Build the type up from the values you want instead of carving them out of a looser type with checks. The invariant that seems to need a refinement type is usually a construction away. A non-empty list is a head plus a rest, not a list with a length check. A valid time range is a start plus a duration, not two timestamps you must keep ordered. No representation is privileged. A list of pairs is an even-length list if you interpret it that way, so choose the shape that cannot build the illegal value and expose the interface callers need on top. Brand semantic primitives. UserId and OrderId are strings underneath but should not be interchangeable. Newtypes in Rust, opaque types in Swift, value classes in Kotlin, phantom types in Haskell, branded intersections in TypeScript. Validate once at creation, trust the type downstream. External data is untyped until parsed. RPC payloads, JSON, IPC messages, CLI args, config files, environment variables, database rows. Have a parse function at every boundary that turns unstructured input into the typed model. See the boundary-discipline principle skill for where to put validation. Don't lie to the type system. Casts, unsafe coercions, and assertion functions that bypass the compiler are latent runtime crashes. If the compiler can't prove a fact, prove it (validate, narrow, refine the model) or accept that the cast is a hazard. Exhaustive matching is the compiler's job. When you match on a sum type, the compiler must fail compilation if a new variant is added without handling. Use the idiom your language provides: never-typed binding in TypeScript, unannotated match in Rust, -Wincomplete-patterns in Haskell, sealed-class match exhaustiveness in Kotlin. Derive types from authoritative schemas. When a protocol buffer, OpenAPI spec, GraphQL schema, database migration, or design-system token file defines a shape, derive from it instead of hand-rolling a parallel type. See the encode-lessons-in-structure principle skill. Strengthen a type only where partiality appears. A runtime assertion, null check, or "this should never happen" throw marks the place a type is too weak. Push that check up into the type. Then stop. The type system's job is to track the cases each use site must handle, not to describe the data as precisely as possible. Prefer total functions. sum of an empty list is 0, so it takes the plain list. head of an empty list has no answer, so it demands the non-empty one. The tests:

"Can I write a comment explaining when this combination of fields is valid?" If yes, the type is too loose. Split it into a sum type. "Do two of my function arguments share a primitive type but mean different things?" Brand them. "Where did this any, this as, this assertNotNull come from?" Trace it to the boundary and validate there instead. "If a new variant is added next month, will the compiler tell the next agent where to add a case?" If no, the match isn't exhaustive. "Is this type duplicating a shape another file owns?" Derive instead. "Am I strengthening this type to keep an operation total, or just to be more precise?" If nothing would otherwise panic, keep the plain type.

## Narrow Effect Contracts (Live Code Path Discipline)

Production execution paths are the sole source of truth for the type contract. Do not dilute Effect schemas, service interfaces, or function signatures to accommodate test fixtures, mocks, or transitional scaffolding.

The rules:

- **Live code paths determine the contract.** Audit actual production call sites (`packages/runtime`, `packages/osdk`, `packages/cli`, `packages/mcp`, `packages/schema`) before modifying types. Do not use unit tests or mocks as justification for widened, optional types.
- **Do not preserve optional fields or `Option<T>` for test convenience.** Never make schema fields or service arguments optional just so unit tests can omit them. If a test is difficult to set up, build a test fixture or generator in test utilities; do not weaken the production contract.
- **Make illegal states unrepresentable with Tagged Unions.** Replace bags of optional properties (`Schema.optional(...)`) with discriminated sum types (`Schema.Union`, `Data.TaggedClass`).
- **Narrow the Error channel (`E` in `Effect<A, E, R>`).** Eliminate phantom errors from error unions that upstream invariants have already ruled out. Prefer total functions (`never` in `E`) where partiality has been eliminated.
- **Prune defensive fallbacks.** Remove defensive unwraps (`Option.getOrElse`, `?? []`, `?? 0`, defensive null checks) once types guarantee values exist.
- **Internal contracts are not public compatibility layers.** When narrowing a contract, update all callers, downstream pipeline stages, and test suites atomically. Do not add backwards-compatibility shims or fallback branches. See skill `narrow-effect-contracts`.

## Aggressive Testing

Treat tests as the blueprint for correct behavior, not as passive regression checks that assume the implementation is the source of truth.

Name tests declaratively: `"should do X"` → `"does X"`; `"should do X if Y"` → `"does X if Y"`. Write comprehensive tests that define what the code must do. If the tests pass, the behavior is correct.
