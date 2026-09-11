import {
  AviationSkywisePack,
  BUILTIN_RECIPES,
  RecipeService,
} from "@operon/recipes";
import type {
  RecipeManifest,
  RecipePack,
  RecipeRegistryService,
} from "@operon/recipes";
import { parseJson } from "@operon/schema";
import { SkillService } from "@operon/skills";
import type { SkillRegistryService } from "@operon/skills";
import { Data, Effect, Exit } from "effect";

import { readTextFileSync } from "../fs-io.js";
import { printCli, printCliError, printCliJson } from "../io.js";

class RecipeReadError extends Data.TaggedError("RecipeReadError")<{
  readonly cause: unknown;
  readonly path: string;
}> {}

function printRecipeList(recipes: readonly RecipeManifest[]): void {
  printCli(`Registered Recipes (${recipes.length}):`);
  for (const r of recipes) {
    printCli(`  - [${r.id}] ${r.name} (v${r.version})`);
    printCli(`    ${r.description}`);
    printCli(`    Author: ${r.author}`);
    printCli(`    Skills: ${r.skills.join(", ")}`);
    printCli(`    Digest: ${r.digest}`);
  }
}

function printRecipeDetails(recipe: RecipeManifest): void {
  printCli(`Recipe: ${recipe.name} (${recipe.id})`);
  printCli(`Version: ${recipe.version}`);
  printCli(`Author: ${recipe.author}`);
  printCli(`Description: ${recipe.description}`);
  printCli(`Ontologies: ${recipe.ontologies.join(", ")}`);
  printCli(`Skills: ${recipe.skills.join(", ")}`);
  printCli(`Digest: ${recipe.digest}`);
}

function printImportReceipt(receipt: {
  readonly grantedAuthorityCount: number;
  readonly ontologiesCount: number;
  readonly recipeId: string;
  readonly skillsCount: number;
  readonly version: string;
}): void {
  printCli(
    `Successfully imported recipe pack '${receipt.recipeId}' (v${receipt.version})`
  );
  printCli(`  Skills registered: ${receipt.skillsCount}`);
  printCli(`  Ontology types declared: ${receipt.ontologiesCount}`);
  printCli(
    `  Granted authority count: ${receipt.grantedAuthorityCount} (S14 invariant: declarative only)`
  );
}

const handleRecipeList = Effect.fn("handleRecipeList")(function* (
  recipeService: RecipeRegistryService,
  isJson: boolean
) {
  const recipes = yield* recipeService.listRecipes();
  if (isJson) {
    printCliJson(recipes);
  } else {
    printRecipeList(recipes);
  }
  return 0;
});

const handleRecipeGet = Effect.fn("handleRecipeGet")(function* (
  recipeService: RecipeRegistryService,
  recipeId: string | undefined,
  isJson: boolean
) {
  if (!recipeId) {
    printCliError(
      "Error: Missing recipe ID. Usage: operon recipe get <recipeId> [--json]"
    );
    return 1;
  }
  const recipe = yield* recipeService.getRecipe(recipeId).pipe(
    Effect.catchTag("RecipeNotFoundError", (err) => {
      printCliError(`Error: Recipe '${err.recipeId}' not found.`);
      return Effect.void as Effect.Effect<undefined>;
    })
  );
  if (!recipe) {
    return 1;
  }

  if (isJson) {
    printCliJson(recipe);
  } else {
    printRecipeDetails(recipe);
  }
  return 0;
});

function loadRecipePack(
  pathOrBuiltin: string
): Effect.Effect<RecipePack, RecipeReadError> {
  if (
    pathOrBuiltin === "aviation-skywise" ||
    pathOrBuiltin === "operon.recipe.aviation-skywise"
  ) {
    return Effect.succeed(AviationSkywisePack);
  }
  return Effect.try({
    catch: (cause: unknown) =>
      new RecipeReadError({ cause, path: pathOrBuiltin }),
    try: () => {
      const content = readTextFileSync(pathOrBuiltin);
      // SAFETY: recipe pack JSON validated downstream by recipeService.importRecipe
      return parseJson(content) as RecipePack;
    },
  });
}

const handleRecipeImport = Effect.fn("handleRecipeImport")(function* (
  recipeService: RecipeRegistryService,
  skillService: SkillRegistryService,
  pathOrBuiltin: string | undefined,
  isJson: boolean
) {
  if (!pathOrBuiltin) {
    printCliError(
      "Error: Missing path or recipe name. Usage: operon recipe import <path-or-builtin> [--json]"
    );
    return 1;
  }

  const fileResult = yield* loadRecipePack(pathOrBuiltin).pipe(Effect.exit);
  if (Exit.isFailure(fileResult)) {
    printCliError(
      `Error reading recipe file '${pathOrBuiltin}': ${String(fileResult.cause)}`
    );
    return 1;
  }
  const pack = fileResult.value;

  const receipt = yield* recipeService.importRecipe(pack, skillService).pipe(
    Effect.catchTag("CorruptRecipePackError", (err) => {
      printCliError(
        `Error: Failed to import recipe pack '${err.recipeId}': ${err.reason}`
      );
      return Effect.void as Effect.Effect<undefined>;
    })
  );

  if (!receipt) {
    return 1;
  }

  if (isJson) {
    printCliJson(receipt);
  } else {
    printImportReceipt(receipt);
  }
  return 0;
});

export const runRecipe = Effect.fn("runRecipe")(function* (
  args: string[]
): Effect.fn.Return<number> {
  const action = args[0];
  const isJson = args.includes("--json");

  const recipeService = RecipeService.make();
  const skillService = SkillService.make();

  yield* Effect.forEach(
    BUILTIN_RECIPES,
    (recipe) => recipeService.registerRecipe(recipe),
    { concurrency: 1 }
  );

  if (action === "list" || !action) {
    return yield* handleRecipeList(recipeService, isJson);
  }

  if (action === "get") {
    return yield* handleRecipeGet(recipeService, args[1], isJson);
  }

  if (action === "import") {
    return yield* handleRecipeImport(
      recipeService,
      skillService,
      args[1],
      isJson
    );
  }

  printCliError(
    `Unknown recipe action: ${action}. Use 'list', 'get', or 'import'.`
  );
  return 1;
});
