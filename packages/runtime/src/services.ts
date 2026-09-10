import { Context, Layer } from "effect";

import type { AuditStore } from "./audit.js";
import { InMemoryAuditStore } from "./audit.js";
import type { ObjectStore } from "./object-store.js";
import { InMemoryObjectStore } from "./object-store.js";
import { OntologyMetadataService } from "./oms.js";

/**
 * Context Tag & Layer for ObjectStore
 */
export class ObjectStoreService extends Context.Service<
  ObjectStoreService,
  ObjectStore
>()("@operon/runtime/ObjectStore") {
  static readonly live = Layer.succeed(
    ObjectStoreService,
    new InMemoryObjectStore()
  );
}

/**
 * Context Tag & Layer for AuditStore
 */
export class AuditStoreService extends Context.Service<
  AuditStoreService,
  AuditStore
>()("@operon/runtime/AuditStore") {
  static readonly live = Layer.succeed(
    AuditStoreService,
    new InMemoryAuditStore()
  );
}

/**
 * Context Tag & Layer for OntologyMetadataService
 */
export class OntologyMetadataServiceTag extends Context.Service<
  OntologyMetadataServiceTag,
  OntologyMetadataService
>()("@operon/runtime/OntologyMetadataService") {
  static readonly live = Layer.succeed(
    OntologyMetadataServiceTag,
    new OntologyMetadataService()
  );
}
