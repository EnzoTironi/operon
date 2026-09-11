import { SkillService } from "@operon/skills";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  AviationSkywisePack,
  AviationSkywiseRecipe,
  BUILTIN_RECIPES,
  HealthcareClinicalPack,
  HealthcareClinicalRecipe,
  WaterWastewaterPack,
  WaterWastewaterRecipe,
} from "./builtin.js";
import { CorruptRecipePackError, RecipeNotFoundError } from "./errors.js";
import { computeRecipeDigest, defineRecipe } from "./manifest.js";
import type { RecipePack } from "./manifest.js";
import { RecipeService } from "./registry.js";

describe("@operon/recipes", () => {
  it("computes deterministic RFC 8785 canonical digests", () => {
    const raw = {
      author: "test-guild",
      description: "Test recipe pack",
      id: "test.recipe",
      name: "Test Recipe",
      ontologies: ["TestType1", "TestType2"],
      skills: ["skill.1", "skill.2"],
      version: "1.0.0",
    };

    const digest1 = computeRecipeDigest(raw);
    const digest2 = computeRecipeDigest(raw);
    expect(digest1).toBe(digest2);
    expect(digest1).toHaveLength(64);

    const recipe = defineRecipe(raw);
    expect(recipe.digest).toBe(digest1);
  });

  it("registers and lists recipes via RecipeService", async () => {
    const service = RecipeService.make();

    await Promise.all(
      BUILTIN_RECIPES.map((recipe) =>
        Effect.runPromise(service.registerRecipe(recipe))
      )
    );

    const list = await Effect.runPromise(service.listRecipes());
    expect(list).toHaveLength(3);
    const ids = list.map((r) => r.id);
    expect(ids).toContain(AviationSkywiseRecipe.id);
    expect(ids).toContain(HealthcareClinicalRecipe.id);
    expect(ids).toContain(WaterWastewaterRecipe.id);

    const retrieved = await Effect.runPromise(
      service.getRecipe(HealthcareClinicalRecipe.id)
    );
    expect(retrieved.id).toBe(HealthcareClinicalRecipe.id);
    expect(retrieved.digest).toBe(HealthcareClinicalRecipe.digest);
  });

  it("imports recipe pack and enforces S14: recipe import grants no authority", async () => {
    const recipeService = RecipeService.make();
    const skillService = SkillService.make();

    const receipt = await Effect.runPromise(
      recipeService.importRecipe(AviationSkywisePack, skillService)
    );

    expect(receipt.imported).toBe(true);
    expect(receipt.recipeId).toBe(AviationSkywiseRecipe.id);
    expect(receipt.skillsCount).toBe(2);
    expect(receipt.ontologiesCount).toBe(3);
    // S14: Critical Invariant - Recipe import grants NO authority
    expect(receipt.grantedAuthorityCount).toBe(0);

    // Verify skills were registered in skillService
    const skills = await Effect.runPromise(skillService.listSkills());
    expect(skills.map((s) => s.id)).toEqual([
      "operon.skill.audit-investigation",
      "operon.skill.action-review-proposal",
    ]);

    // An unauthenticated/unauthorized agent MUST still be blocked from executing the skill
    const executionError = await Effect.runPromise(
      skillService
        .validateExecution(
          "operon.skill.audit-investigation",
          ["operon_verify_audit_ledger", "operon_get_audit_records"],
          ["unauthorized_role"]
        )
        .pipe(Effect.flip)
    );

    expect(executionError._tag).toBe("InsufficientAuthorityError");
  });

  it("rejects recipe pack with corrupt/tampered manifest digest", async () => {
    const service = RecipeService.make();

    const tamperedPack: RecipePack = {
      manifest: {
        ...AviationSkywiseRecipe,
        digest:
          "0000000000000000000000000000000000000000000000000000000000000000",
      },
      skills: AviationSkywisePack.skills,
    };

    const error = await Effect.runPromise(
      service.importRecipe(tamperedPack).pipe(Effect.flip)
    );

    expect(error).toBeInstanceOf(CorruptRecipePackError);
    expect((error as CorruptRecipePackError).reason).toContain(
      "Manifest digest mismatch"
    );
  });

  it("returns RecipeNotFoundError for non-existent recipe ID", async () => {
    const service = RecipeService.make();

    const error = await Effect.runPromise(
      service.getRecipe("nonexistent.recipe").pipe(Effect.flip)
    );

    expect(error).toBeInstanceOf(RecipeNotFoundError);
    expect((error as RecipeNotFoundError).recipeId).toBe("nonexistent.recipe");
  });

  it("imports healthcare clinical pack and water wastewater pack with zero granted authority", async () => {
    const recipeService = RecipeService.make();
    const skillService = SkillService.make();

    const hcReceipt = await Effect.runPromise(
      recipeService.importRecipe(HealthcareClinicalPack, skillService)
    );
    expect(hcReceipt.imported).toBe(true);
    expect(hcReceipt.recipeId).toBe(HealthcareClinicalRecipe.id);
    expect(hcReceipt.skillsCount).toBe(2);
    expect(hcReceipt.ontologiesCount).toBe(4);
    expect(hcReceipt.grantedAuthorityCount).toBe(0);

    const wwReceipt = await Effect.runPromise(
      recipeService.importRecipe(WaterWastewaterPack, skillService)
    );
    expect(wwReceipt.imported).toBe(true);
    expect(wwReceipt.recipeId).toBe(WaterWastewaterRecipe.id);
    expect(wwReceipt.skillsCount).toBe(2);
    expect(wwReceipt.ontologiesCount).toBe(5);
    expect(wwReceipt.grantedAuthorityCount).toBe(0);
  });
});
