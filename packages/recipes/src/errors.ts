import { Data } from "effect";

export class RecipeNotFoundError extends Data.TaggedError(
  "RecipeNotFoundError"
)<{
  readonly recipeId: string;
}> {}

export class CorruptRecipePackError extends Data.TaggedError(
  "CorruptRecipePackError"
)<{
  readonly recipeId: string;
  readonly reason: string;
}> {}

export class PackageNotProductionReadyError extends Data.TaggedError(
  "PackageNotProductionReadyError"
)<{
  readonly missingInvariants: readonly string[];
  readonly packageId: string;
  readonly reason: string;
}> {}

export class WriterFencedError extends Data.TaggedError("WriterFencedError")<{
  readonly cutoverTimestamp: number;
  readonly entityId: string;
  readonly message: string;
  readonly writerId: string;
}> {}

export class InsufficientInventoryError extends Data.TaggedError(
  "InsufficientInventoryError"
)<{
  readonly availableQuantity: number;
  readonly itemId: string;
  readonly message: string;
  readonly requestedQuantity: number;
}> {}
