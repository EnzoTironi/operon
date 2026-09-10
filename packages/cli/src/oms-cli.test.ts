import * as fs from "node:fs";
import path from "node:path";

import { computeCanonicalDigest } from "@operon/schema";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { runCli } from "./index.js";

const makeScopedTempFile = (prefix: string, content: string) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const filePath = path.resolve(
        process.cwd(),
        `.${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`
      );
      fs.writeFileSync(filePath, content, "utf-8");
      return filePath;
    }),
    (filePath) =>
      Effect.sync(() => {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      })
  );

describe("V0-CH-02 & V0-CH-03: CLI OMS authoring and publication lifecycle", () => {
  it("executes full OMS workflow: active check -> apply artifact -> inspect -> diff -> publish -> get", () =>
    Effect.gen(function* () {
      const sampleArtifact = {
        actions: [
          {
            description: "Deploy incident response squad",
            effectClass: "state_mutation",
            id: "deploy_squad",
            name: "Deploy Squad",
            parametersSchema: { squadId: "string" },
            requiredRoles: ["incident_commander"],
            riskTier: "high",
          },
        ],
        freshness: [],
        links: [],
        policies: [],
        queries: [],
        types: [
          {
            classification: "internal",
            id: "Squad",
            name: "Squad",
            primaryKey: "id",
            properties: {
              id: { name: "id", required: true, type: "string" },
              status: { name: "status", type: "string" },
            },
            typology: "master",
          },
        ],
      };

      const candidateDigest = computeCanonicalDigest(sampleArtifact);
      const artifactFile = yield* makeScopedTempFile(
        "cli-artifact-v0b",
        JSON.stringify(sampleArtifact, null, 2)
      );
      const stateFile = yield* makeScopedTempFile("cli-state-oms", "{}");
      const prevEnvState = process.env.OPERON_STATE_PATH;
      process.env.OPERON_STATE_PATH = stateFile;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (prevEnvState === undefined) {
            delete process.env.OPERON_STATE_PATH;
          } else {
            process.env.OPERON_STATE_PATH = prevEnvState;
          }
        })
      );

      // 1. Initial check: operon oms release active
      const activeCode = yield* runCli(["oms", "release", "active", "--json"]);
      expect(activeCode).toBe(0);

      // 2. Apply artifact: operon oms artifact apply main --file <path> --idempotency-key <key>
      const applyCode = yield* runCli([
        "oms",
        "artifact",
        "apply",
        "main",
        "--file",
        artifactFile,
        "--idempotency-key",
        "cli-apply-key-01",
        "--json",
      ]);
      expect(applyCode).toBe(0);

      // 3. Inspect candidate: operon oms candidate inspect <candidateDigest>
      const inspectCode = yield* runCli([
        "oms",
        "candidate",
        "inspect",
        candidateDigest,
        "--json",
      ]);
      expect(inspectCode).toBe(0);

      // 4. Diff candidate: operon oms candidate diff <candidateDigest>
      const diffCode = yield* runCli([
        "oms",
        "candidate",
        "diff",
        candidateDigest,
        "--json",
      ]);
      expect(diffCode).toBe(0);

      // 5. Publish release: operon oms release publish --candidate <digest> --initial --reviewer <id>
      const publishCode = yield* runCli([
        "oms",
        "release",
        "publish",
        "--candidate",
        candidateDigest,
        "--initial",
        "--reviewer",
        "lead_architect_cli",
        "--idempotency-key",
        "cli-pub-key-01",
        "--json",
      ]);
      expect(publishCode).toBe(0);

      // 6. Recover publication: operon oms release get --idempotency-key <key>
      const getCode = yield* runCli([
        "oms",
        "release",
        "get",
        "--idempotency-key",
        "cli-pub-key-01",
        "--json",
      ]);
      expect(getCode).toBe(0);

      // 7. Active release now reports published release
      const finalActiveCode = yield* runCli([
        "oms",
        "release",
        "active",
        "--json",
      ]);
      expect(finalActiveCode).toBe(0);
    }).pipe(Effect.scoped, Effect.runPromise));
});
