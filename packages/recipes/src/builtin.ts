import {
  ActionReviewProposalSkill,
  AuditInvestigationSkill,
  ChemicalDosingDossierSkill,
  ClinicalHandoffExtractionSkill,
  DosageVerificationSkill,
  TelemetryLoopInspectionSkill,
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

export const HealthcareClinicalRecipe: RecipeManifest = defineRecipe({
  author: "operon-healthcare-guild",
  description:
    "Clinical operational ontology pack with patient vitals, safe dosage titration, handoff notes, and physician approval",
  id: "operon.recipe.healthcare-clinical",
  name: "Healthcare Clinical Operations Pack",
  ontologies: [
    "healthcare.Patient",
    "healthcare.DosageOrder",
    "healthcare.ClinicalObservation",
    "healthcare.TriageRecord",
  ],
  skills: [DosageVerificationSkill.id, ClinicalHandoffExtractionSkill.id],
  version: "1.0.0",
});

export const HealthcareClinicalPack: RecipePack = {
  manifest: HealthcareClinicalRecipe,
  skills: [DosageVerificationSkill, ClinicalHandoffExtractionSkill],
};

export const WaterWastewaterRecipe: RecipeManifest = defineRecipe({
  author: "operon-industrial-guild",
  description:
    "Industrial wastewater operational ontology pack with treatment plants, aeration tanks, chemical dosers, and telemetry sensors",
  id: "operon.recipe.water-wastewater",
  name: "Water & Wastewater Industrial Operations Pack",
  ontologies: [
    "water.TreatmentPlant",
    "water.AerationTank",
    "water.ChemicalDoser",
    "water.TelemetrySensor",
    "water.EffluentSample",
  ],
  skills: [ChemicalDosingDossierSkill.id, TelemetryLoopInspectionSkill.id],
  version: "1.0.0",
});

export const WaterWastewaterPack: RecipePack = {
  manifest: WaterWastewaterRecipe,
  skills: [ChemicalDosingDossierSkill, TelemetryLoopInspectionSkill],
};

export const BUILTIN_RECIPES: readonly RecipeManifest[] = [
  AviationSkywiseRecipe,
  HealthcareClinicalRecipe,
  WaterWastewaterRecipe,
];
