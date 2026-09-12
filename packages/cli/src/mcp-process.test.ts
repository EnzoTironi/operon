import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Effect, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_MCP_AGENT_TIER, parseMcpOptions } from "./commands/mcp.js";

const cli = fileURLToPath(new URL("../dist/bin.js", import.meta.url));
const folders: string[] = [];
const clients: Client[] = [];
const decodeContent = Schema.decodeUnknownSync(
  Schema.Struct({
    content: Schema.Array(
      Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })
    ),
    isError: Schema.optionalKey(Schema.Boolean),
  })
);
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json));

async function connect(
  directory: string,
  role: "consumer" | "builder",
  workspaceId?: string
) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      cli,
      "mcp",
      "start",
      "--role",
      role,
      "--agent-tier",
      "2",
      "--db",
      path.join(directory, "cell.db"),
      ...(workspaceId ? ["--workspace", workspaceId] : []),
    ],
    cwd: directory,
    env: { PATH: process.env.PATH ?? "", OPERON_IN_MEMORY: "false" },
    stderr: "pipe",
  });
  const client = new Client({
    name: "zoen-integration-test",
    version: "1.0.0",
  });
  clients.push(client);
  await client.connect(transport);
  return {
    client,
    transport,
    call: async (name: string, args: Record<string, unknown>) => {
      const result = decodeContent(
        await client.callTool({ name, arguments: args })
      );
      return {
        body: decodeJson(result.content[0]?.text),
        isError: result.isError === true,
      };
    },
  };
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(
    folders
      .splice(0)
      .map((folder) => rm(folder, { recursive: true, force: true }))
  );
});

describe("MCP start defaults", () => {
  it("defaults to consumer agent tier 2", async () => {
    const options = await Effect.runPromise(parseMcpOptions(["start"]));
    expect(DEFAULT_MCP_AGENT_TIER).toBe(2);
    expect(options.agentTier).toBe(2);
    expect(options.role).toBe("consumer");
  });

  it("keeps explicit --agent-tier 4 when the host opts in", async () => {
    const options = await Effect.runPromise(
      parseMcpOptions(["start", "--agent-tier", "4"])
    );
    expect(options.agentTier).toBe(4);
  });
});

describe("MCP process boundary", () => {
  it.each([undefined, "personal:workspace-a"])(
    "preserves acknowledged ingestion after an abrupt restart (%s) and refuses Consumer writes",
    async (workspaceId) => {
      const directory = await mkdtemp(path.join(tmpdir(), "operon-mcp-"));
      folders.push(directory);
      const builder = await connect(directory, "builder", workspaceId);
      const source = {
        locator: "mailbox://pilot/one.eml",
        mediaType: "application/json",
        payload: [{ email: "ana@example.test", displayName: "Ana" }],
        tenantId: "pilot-a",
        idempotencyKey: "message-revision-1",
      };
      const ingested = await builder.call("operon_ingest_source", source);
      expect(ingested.isError).toBe(false);
      const receipt = Schema.decodeUnknownSync(
        Schema.Struct({
          sourceArtifact: Schema.Struct({ sourceId: Schema.String }),
        })
      )(ingested.body);
      const pid = builder.transport.pid;
      expect(pid).not.toBeNull();
      const closed = Promise.withResolvers<undefined>();
      // oxlint-disable-next-line unicorn/prefer-add-event-listener -- MCP Client exposes onclose, not EventTarget.
      builder.client.onclose = () => closed.resolve(undefined);
      if (pid === null) throw new Error("MCP process did not start");
      process.kill(pid, "SIGKILL");
      await closed.promise;

      const consumer = await connect(directory, "consumer", workspaceId);
      const recovered = await consumer.call("operon_get_source", {
        sourceId: receipt.sourceArtifact.sourceId,
        tenantId: "pilot-a",
      });
      expect(recovered.isError).toBe(false);
      expect(recovered.body).toMatchObject({
        sourceId: receipt.sourceArtifact.sourceId,
      });
      const denied = await consumer.call("operon_ingest_source", source);
      expect(denied.isError).toBe(true);
      expect(denied.body).toMatchObject({ error: "McpSecurityError" });
    }
  );

  it("does not turn a Builder process into a human reviewer", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "operon-approver-"));
    folders.push(directory);
    const builder = await connect(directory, "builder");
    const denied = await builder.call("operon_review_mapping_proposal", {
      proposalId: "someone-elses-proposal",
      reviewerId: "forged-owner",
      reviewerRoles: ["admin"],
      verdict: "approve",
      viewedDigest: "forged",
    });
    expect(denied.isError).toBe(true);
    expect(denied.body).toMatchObject({ error: "ApproverNotBoundError" });
  });

  it.each(["0", "2.5", "5", "invalid"])(
    "rejects invalid agent tier %s before starting a server",
    (tier) => {
      const result = spawnSync(
        process.execPath,
        [cli, "mcp", "start", "--agent-tier", tier],
        { encoding: "utf-8" }
      );
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("--agent-tier must be");
    }
  );
});
