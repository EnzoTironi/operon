# Learning more about Effect

This repository uses the Effect Typescript library.

Before writing any Effect code, first read `node_modules/effect/AGENTS.md` **completely**, and follow its links when required. Search `node_modules/effect/src` for APIs the guide does not cover.


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