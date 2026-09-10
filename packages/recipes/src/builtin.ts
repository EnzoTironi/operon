import {
  ActionReviewProposalSkill,
  AuditInvestigationSkill,
} from "@operon/skills";

import { defineRecipe } from "./manifest.js";
import type { RecipeManifest, RecipePack } from "./manifest.js";

export const AviationSkywiseRecipe: RecipeManifest = defineRecipe({
  author: "operon-aviation-guild",
  description:
    "Aviation operational ontology pack with fleet safety, flight tracking, and maintenance audit skills",
  id: "operon.recipe.aviation-skywise",
  name: "Aviation Skywise Operations Pack",
  ontologies: [
    "aviation.Flight",
    "aviation.Aircraft",
    "aviation.MaintenanceLog",
  ],
  skills: [AuditInvestigationSkill.id, ActionReviewProposalSkill.id],
  version: "1.0.0",
});

export const AviationSkywisePack: RecipePack = {
  manifest: AviationSkywiseRecipe,
  skills: [AuditInvestigationSkill, ActionReviewProposalSkill],
};

export const BUILTIN_RECIPES: readonly RecipeManifest[] = [
  AviationSkywiseRecipe,
];
