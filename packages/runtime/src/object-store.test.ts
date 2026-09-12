import { InMemoryObjectStore } from "./object-store.js";
import { describeObjectStoreContract } from "./testing/object-store-contract.js";

describeObjectStoreContract("InMemoryObjectStore", () =>
  Promise.resolve({
    close: () => Promise.resolve(),
    store: new InMemoryObjectStore(),
  })
);
