# @operon/osdk

The Type-Safe Operational SDK (OSDK) client and TypeScript code generator for **Operon**.

`@operon/osdk` enables application developers and frontend engineers to interact with Operon ontologies using strongly-typed, fluent client APIs with support for object lookups, property filters, set algebra, and governed action execution.

---

## Features

- **Fluent Object Access**: Direct lookups via `client.objects[typeName].get(id)`.
- **Predicate Filtering**: Query instances matching specific predicates via `client.objects[typeName].list(predicate)`.
- **Set Algebra**: Compose object sets and query them asynchronously via `client.objects[typeName].set().all()`.
- **Governed Action Invocation**: Execute actions with caller security credentials and receive typed `DecisionRecord` results via `client.actions[actionId].execute(params, securityContext)`.
- **TypeScript Code Generator**: Generate compile-time typed client wrappers directly from ontology schema models via `generateOsdkSource({ objectTypes, actionTypes, linkTypes })`.

---

## Usage

### 1. Creating an OSDK Client

```typescript
import { createOperonClient } from "@operon/osdk";
import { InMemoryObjectStore, InMemoryAuditStore } from "@operon/runtime";
import { PatientType, AdjustDoseAction } from "./ontology.js";

const client = createOperonClient({
  objectTypes: [PatientType],
  actionTypes: [AdjustDoseAction],
  objectStore: new InMemoryObjectStore(),
  auditStore: new InMemoryAuditStore(),
});

// Fetch object
const patient = await Effect.runPromise(client.objects["Patient"].get("P001"));

// Execute action
const result = await Effect.runPromise(
  client.actions["adjust_dose"].execute({
    patientId: "P001",
    proposedDose: 40,
  })
);
```

### 2. Generating OSDK TypeScript Source

```typescript
import { generateOsdkSource } from "@operon/osdk";
import {
  PatientType,
  DoctorPatientLink,
  AdjustDoseAction,
} from "./ontology.js";

const code = generateOsdkSource({
  objectTypes: [PatientType],
  linkTypes: [DoctorPatientLink],
  actionTypes: [AdjustDoseAction],
});

// Generates fully typed client definitions, Interfaces, and Action cards
```
