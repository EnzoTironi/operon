import {
  ActionInbox,
  InMemoryAuditStore,
  InMemoryObjectStore,
} from "@operon/runtime";

import { createWorkerFetchHandler } from "./worker-handler.js";

const objectStore = new InMemoryObjectStore();
const auditStore = new InMemoryAuditStore();
const inbox = new ActionInbox(auditStore, objectStore);

export const workerHandler = createWorkerFetchHandler({
  actionTypes: [],
  auditStore,
  inbox,
  objectStore,
  objectTypes: [],
});

export default {
  fetch(request: Request): Promise<Response> {
    return workerHandler(request);
  },
};
