import { computeCanonicalDigest } from "@operon/schema";
import { Schema } from "effect";

export const SkillManifestSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  version: Schema.String,
  description: Schema.String,
  minContract: Schema.String,
  requiredTools: Schema.Array(Schema.String),
  authorityPrerequisites: Schema.Array(Schema.String),
  inputSchema: Schema.Record(Schema.String, Schema.Unknown),
  outputSchema: Schema.Record(Schema.String, Schema.Unknown),
  digest: Schema.String,
});

export type SkillManifest = Schema.Schema.Type<typeof SkillManifestSchema>;

export function computeSkillDigest(
  manifest: Omit<SkillManifest, "digest">
): string {
  return computeCanonicalDigest(manifest);
}

export function defineSkill(
  manifest: Omit<SkillManifest, "digest">
): SkillManifest {
  return {
    ...manifest,
    digest: computeSkillDigest(manifest),
  };
}
