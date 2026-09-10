import { computeCanonicalDigest } from "@operon/schema";
import { SkillManifestSchema } from "@operon/skills";
import { Schema } from "effect";

export const RecipeManifestSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  version: Schema.String,
  description: Schema.String,
  skills: Schema.Array(Schema.String),
  ontologies: Schema.Array(Schema.String),
  author: Schema.String,
  digest: Schema.String,
});

export type RecipeManifest = Schema.Schema.Type<typeof RecipeManifestSchema>;

export const RecipePackSchema = Schema.Struct({
  manifest: RecipeManifestSchema,
  skills: Schema.Array(SkillManifestSchema),
});

export type RecipePack = Schema.Schema.Type<typeof RecipePackSchema>;

export function computeRecipeDigest(
  manifest: Omit<RecipeManifest, "digest">
): string {
  return computeCanonicalDigest(manifest);
}

export function defineRecipe(
  manifest: Omit<RecipeManifest, "digest">
): RecipeManifest {
  return {
    ...manifest,
    digest: computeRecipeDigest(manifest),
  };
}
