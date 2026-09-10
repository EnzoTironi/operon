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
