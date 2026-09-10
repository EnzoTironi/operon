import * as fs from "node:fs";

import {
  AviationSkywisePack,
  BUILTIN_RECIPES,
  RecipeService,
} from "@operon/recipes";
import type { RecipePack } from "@operon/recipes";
import { SkillService } from "@operon/skills";
import { Effect } from "effect";

export function runRecipe(
  args: string[]
): Effect.Effect<number, unknown, never> {
  return Effect.gen(function* () {
    const action = args[0];
    const isJson = args.includes("--json");

    const recipeService = RecipeService.make();
    const skillService = SkillService.make();

    for (const recipe of BUILTIN_RECIPES) {
      yield* recipeService.registerRecipe(recipe);
    }

    if (action === "list" || !action) {
      const recipes = yield* recipeService.listRecipes();
      if (isJson) {
        console.log(JSON.stringify(recipes, null, 2));
      } else {
        console.log(`Registered Recipes (${recipes.length}):`);
        for (const r of recipes) {
          console.log(`  - [${r.id}] ${r.name} (v${r.version})`);
          console.log(`    ${r.description}`);
          console.log(`    Author: ${r.author}`);
          console.log(`    Skills: ${r.skills.join(", ")}`);
          console.log(`    Digest: ${r.digest}`);
        }
      }
      return 0;
    }

    if (action === "get") {
      const recipeId = args[1];
      if (!recipeId) {
        console.error(
          "Error: Missing recipe ID. Usage: operon recipe get <recipeId> [--json]"
        );
        return 1;
      }
      const recipe = yield* recipeService.getRecipe(recipeId).pipe(
        Effect.catchTag("RecipeNotFoundError", (err) => {
          console.error(`Error: Recipe '${err.recipeId}' not found.`);
          return Effect.succeed(undefined);
        })
      );
      if (!recipe) return 1;

      if (isJson) {
        console.log(JSON.stringify(recipe, null, 2));
      } else {
        console.log(`Recipe: ${recipe.name} (${recipe.id})`);
        console.log(`Version: ${recipe.version}`);
        console.log(`Author: ${recipe.author}`);
        console.log(`Description: ${recipe.description}`);
        console.log(`Ontologies: ${recipe.ontologies.join(", ")}`);
        console.log(`Skills: ${recipe.skills.join(", ")}`);
        console.log(`Digest: ${recipe.digest}`);
      }
      return 0;
    }

    if (action === "import") {
      const pathOrBuiltin = args[1];
      if (!pathOrBuiltin) {
        console.error(
          "Error: Missing path or recipe name. Usage: operon recipe import <path-or-builtin> [--json]"
        );
        return 1;
      }

      let pack: RecipePack;
      if (
        pathOrBuiltin === "aviation-skywise" ||
        pathOrBuiltin === "operon.recipe.aviation-skywise"
      ) {
        pack = AviationSkywisePack;
      } else {
        try {
          const content = fs.readFileSync(pathOrBuiltin, "utf-8");
          pack = JSON.parse(content) as RecipePack;
        } catch (error: any) {
          console.error(
            `Error reading recipe file '${pathOrBuiltin}': ${error.message}`
          );
          return 1;
        }
      }

      const receipt = yield* recipeService
        .importRecipe(pack, skillService)
        .pipe(
          Effect.catchTag("CorruptRecipePackError", (err) => {
            console.error(
              `Error: Failed to import recipe pack '${err.recipeId}': ${err.reason}`
            );
            return Effect.succeed(undefined);
          })
        );

      if (!receipt) return 1;

      if (isJson) {
        console.log(JSON.stringify(receipt, null, 2));
      } else {
        console.log(
          `Successfully imported recipe pack '${receipt.recipeId}' (v${receipt.version})`
        );
        console.log(`  Skills registered: ${receipt.skillsCount}`);
        console.log(`  Ontology types declared: ${receipt.ontologiesCount}`);
        console.log(
          `  Granted authority count: ${receipt.grantedAuthorityCount} (S14 invariant: declarative only)`
        );
      }
      return 0;
    }

    console.error(
      `Unknown recipe action: ${action}. Use 'list', 'get', or 'import'.`
    );
    return 1;
  });
}
