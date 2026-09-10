import type { SkillRegistryService } from "@operon/skills";
import { Context, Effect, Layer } from "effect";

import { CorruptRecipePackError, RecipeNotFoundError } from "./errors.js";
import { computeRecipeDigest } from "./manifest.js";
import type { RecipeManifest, RecipePack } from "./manifest.js";

export interface RecipeImportReceipt {
  readonly imported: true;
  readonly recipeId: string;
  readonly version: string;
  readonly skillsCount: number;
  readonly ontologiesCount: number;
  /**
   * S14 Invariant: Recipe import is purely declarative and grants NO authority.
   * Authority must be granted explicitly through TaskMandates and IntentGrants.
   */
  readonly grantedAuthorityCount: 0;
  readonly timestamp: number;
}

export interface RecipeRegistryService {
  readonly registerRecipe: (recipe: RecipeManifest) => Effect.Effect<void>;
  readonly getRecipe: (
    id: string
  ) => Effect.Effect<RecipeManifest, RecipeNotFoundError>;
  readonly listRecipes: () => Effect.Effect<readonly RecipeManifest[]>;
  readonly importRecipe: (
    pack: RecipePack,
    skillService?: SkillRegistryService
  ) => Effect.Effect<RecipeImportReceipt, CorruptRecipePackError>;
}

export class RecipeService extends Context.Service<
  RecipeService,
  RecipeRegistryService
>()("@operon/recipes/RecipeService") {
  static make(): RecipeRegistryService {
    const recipes = new Map<string, RecipeManifest>();

    return {
      registerRecipe: (recipe: RecipeManifest) =>
        Effect.sync(() => {
          recipes.set(recipe.id, recipe);
        }),

      getRecipe: (id: string) =>
        Effect.gen(function* () {
          const recipe = recipes.get(id);
          if (!recipe) {
            return yield* Effect.fail(
              new RecipeNotFoundError({ recipeId: id })
            );
          }
          return recipe;
        }),

      listRecipes: () => Effect.succeed([...recipes.values()]),

      importRecipe: (pack: RecipePack, skillService?: SkillRegistryService) =>
        Effect.gen(function* () {
          const { manifest, skills } = pack;

          // Verify recipe manifest digest integrity
          const { digest: _digest, ...manifestWithoutDigest } = manifest;
          const expectedDigest = computeRecipeDigest(manifestWithoutDigest);
          if (manifest.digest !== expectedDigest) {
            return yield* Effect.fail(
              new CorruptRecipePackError({
                reason: `Manifest digest mismatch: declared '${manifest.digest}', expected '${expectedDigest}'`,
                recipeId: manifest.id,
              })
            );
          }

          // Register recipe
          recipes.set(manifest.id, manifest);

          // If skill registry service is supplied, register packaged skills
          if (skillService) {
            for (const skill of skills) {
              yield* skillService.registerSkill(skill).pipe(
                Effect.catchTag("IncompatibleContractError", (err) =>
                  Effect.fail(
                    new CorruptRecipePackError({
                      reason: `Skill '${skill.id}' contract incompatibility: ${err.minContract} > ${err.kernelContract}`,
                      recipeId: manifest.id,
                    })
                  )
                )
              );
            }
          }

          const receipt: RecipeImportReceipt = {
            grantedAuthorityCount: 0,
            imported: true,
            ontologiesCount: manifest.ontologies.length,
            recipeId: manifest.id,
            skillsCount: skills.length,
            timestamp: Date.now(),
            version: manifest.version,
          };

          return receipt;
        }),
    };
  }

  static readonly live = Layer.succeed(RecipeService, RecipeService.make());
}
