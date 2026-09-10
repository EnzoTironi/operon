# @operon/schema

The declarative domain modeling language for **Operon**, defining type-safe operational ontologies with **Effect Schema**.

---

## Core Constructs

1. **`defineValueType`**: Domain primitives constrained by boundaries and branded types (e.g. `BloodGlucoseMgDl`, `Latitude`, `TSS`).
2. **`defineObjectType`**: Computable state representations with structural properties, primary keys, typology (`master`, `event`, `aggregate`), and property-level freshness budgets.
3. **`defineLinkType`**: Relationships between object types with structural cardinality (`one-to-one`, `one-to-many`, `many-to-many`), cascade delete policies, and directional naming.
4. **`defineInterfaceType`**: Abstract behavioral contracts (e.g. `LocationInterface`) that object types can implement.
5. **`defineActionType`**: Governed state transitions specifying:
   - Typed parameter schemas via `Schema.Struct`.
   - Autonomy risk tiers (`low`, `medium`, `high`, `critical`).
   - Default execution mode (`automated`, `proposal`, `propose_only`).
   - Submission criteria evaluated before state admission.
   - Required property freshness constraints.
   - Side effect definitions with Saga compensation rollback handlers.

---

## Example

```typescript
import { Schema, Effect } from "effect";
import {
  defineObjectType,
  defineActionType,
  defineProperty,
} from "@operon/schema";

export const PatientType = defineObjectType({
  id: "Patient",
  name: "Patient",
  description: "Hospital Inpatient",
  typology: "master",
  primaryKey: "patientId",
  properties: {
    patientId: defineProperty({
      schema: Schema.String,
      description: "Unique patient identifier",
      required: true,
    }),
    eGFR: defineProperty({
      schema: Schema.Number,
      description: "Glomerular filtration rate",
      required: true,
      freshnessBudget: {
        maxStalenessMs: 24 * 60 * 60 * 1000,
        onStale: "escalate_to_human",
      },
    }),
  },
});

export const UpdateVitalsAction = defineActionType({
  id: "update_vitals",
  name: "Update Patient Vitals",
  description: "Records fresh vital signs for an inpatient",
  riskTier: "low",
  defaultExecutionMode: "automated",
  minimumAgentTier: 4,
  parametersSchema: Schema.Struct({
    patientId: Schema.String,
    heartRate: Schema.Number,
  }),
});
```
