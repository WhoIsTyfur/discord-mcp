import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";
import { EXAMPLE_BLUEPRINT, FakeApi } from "./helpers.js";

async function setup(api = new FakeApi()): Promise<{ mcp: Client; api: FakeApi }> {
  const server = buildServer({ api, dryRun: false });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([
    server.connect(serverTransport),
    mcp.connect(clientTransport),
  ]);
  return { mcp, api };
}

function resultText(res: unknown): string {
  const content = (res as { content: Array<{ type: string; text: string }> })
    .content;
  return content[0]?.text ?? "";
}

function isError(res: unknown): boolean {
  return Boolean((res as { isError?: boolean }).isError);
}

describe("MCP server surface", () => {
  it("lists every tool", async () => {
    const { mcp } = await setup();
    const { tools } = await mcp.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "list_guilds",
        "get_guild",
        "list_channels",
        "list_roles",
        "get_bot_info",
        "get_blueprint_template",
        "create_guild",
        "apply_blueprint",
        "create_role",
        "create_channel",
        "set_channel_permissions",
        "reorder_channels",
        "rename_channel",
        "list_messages",
        "publish_resource",
        "reorder_roles",
        "delete_channel",
        "delete_role",
      ].sort(),
    );
  });

  it("marks delete tools as destructive and irreversible in their descriptions", async () => {
    const { mcp } = await setup();
    const { tools } = await mcp.listTools();
    for (const name of ["delete_channel", "delete_role"]) {
      const tool = tools.find((t) => t.name === name);
      expect(tool?.description?.toUpperCase()).toContain("IRREVERSIBLE");
      expect(tool?.annotations?.destructiveHint).toBe(true);
    }
  });

  it("get_bot_info reports guild count and the 10-guild headroom", async () => {
    const { mcp } = await setup();
    const res = await mcp.callTool({ name: "get_bot_info", arguments: {} });
    const body = JSON.parse(resultText(res)) as {
      guild_count: number;
      can_create_guilds: boolean;
    };
    expect(body.guild_count).toBe(1);
    expect(body.can_create_guilds).toBe(true);
  });

  it("renames an existing category without changing its identity or permissions and supports dry runs", async () => {
    const { mcp, api } = await setup();
    const category = await api.createChannel(api.guildId, { name: "10 · COMMUNITY", type: 4, position: 1, permission_overwrites: [] }, "test");
    const writes = api.writes;
    const original = structuredClone(category);
    const args = { channel_id: category.id, name: "COMMUNITY" };
    await mcp.callTool({ name: "rename_channel", arguments: { ...args, dry_run: true } });
    expect(api.writes).toBe(writes);
    expect(api.channels.find(c => c.id === category.id)).toEqual(original);
    const result = await mcp.callTool({ name: "rename_channel", arguments: args });
    expect(isError(result)).toBe(false);
    expect(api.channels.find(c => c.id === category.id)).toEqual({ ...original, name: "COMMUNITY" });
  });

  it("delete tools refuse to act without confirm=true", async () => {
    const { mcp, api } = await setup();
    const res = await mcp.callTool({
      name: "delete_channel",
      arguments: { channel_id: "500000000000000001", confirm: false },
    });
    expect(isError(res)).toBe(true);
    expect(resultText(res)).toContain("confirm");
    expect(api.writes).toBe(0);
  });

  it("surfaces unknown permission names as a structured error, not a crash", async () => {
    const { mcp, api } = await setup();
    const res = await mcp.callTool({
      name: "create_role",
      arguments: {
        guild_id: api.guildId,
        name: "Mod",
        permissions: ["NOT_A_PERMISSION"],
      },
    });
    expect(isError(res)).toBe(true);
    const text = resultText(res);
    expect(text).toContain("NOT_A_PERMISSION");
    expect(text).toContain("VIEW_CHANNEL"); // lists valid options
    expect(api.writes).toBe(0);
  });

  it("apply_blueprint provisions via the tool and is idempotent end to end", async () => {
    const { mcp, api } = await setup();

    const first = await mcp.callTool({
      name: "apply_blueprint",
      arguments: {
        guild_id: api.guildId,
        blueprint: EXAMPLE_BLUEPRINT,
        mode: "reconcile",
      },
    });
    expect(isError(first)).toBe(false);
    const firstBody = JSON.parse(resultText(first)) as {
      completed: boolean;
      summary: { operations: number };
    };
    expect(firstBody.completed).toBe(true);
    expect(firstBody.summary.operations).toBeGreaterThan(0);
    const writesAfterFirst = api.writes;

    const second = await mcp.callTool({
      name: "apply_blueprint",
      arguments: {
        guild_id: api.guildId,
        blueprint: EXAMPLE_BLUEPRINT,
        mode: "reconcile",
      },
    });
    const secondBody = JSON.parse(resultText(second)) as {
      completed: boolean;
      summary: { operations: number };
    };
    expect(secondBody.completed).toBe(true);
    expect(secondBody.summary.operations).toBe(0);
    expect(api.writes).toBe(writesAfterFirst);
  });

  it("apply_blueprint dry_run returns the plan without touching the API", async () => {
    const { mcp, api } = await setup();
    const res = await mcp.callTool({
      name: "apply_blueprint",
      arguments: {
        guild_id: api.guildId,
        blueprint: EXAMPLE_BLUEPRINT,
        mode: "reconcile",
        dry_run: true,
      },
    });
    const body = JSON.parse(resultText(res)) as {
      dry_run: boolean;
      plan: { operations: Array<{ kind: string }> };
    };
    expect(body.dry_run).toBe(true);
    expect(body.plan.operations.length).toBeGreaterThan(0);
    expect(api.writes).toBe(0);
  });

  it("rejects a blueprint with a bad role reference before any write", async () => {
    const { mcp, api } = await setup();
    const res = await mcp.callTool({
      name: "apply_blueprint",
      arguments: {
        guild_id: api.guildId,
        blueprint: {
          name: "Broken",
          roles: [{ name: "Admin" }],
          categories: [
            { name: "STAFF", private_to: ["Moderator"], channels: [] },
          ],
        },
        mode: "reconcile",
      },
    });
    expect(isError(res)).toBe(true);
    expect(resultText(res)).toContain("Moderator");
    expect(api.writes).toBe(0);
  });

  it("serves blueprint templates, the design guide resource, and the design prompt", async () => {
    const { mcp } = await setup();

    const list = await mcp.callTool({
      name: "get_blueprint_template",
      arguments: {},
    });
    const listBody = JSON.parse(resultText(list)) as {
      templates: Array<{ kind: string }>;
    };
    expect(listBody.templates.map((t) => t.kind)).toContain("gaming");

    const one = await mcp.callTool({
      name: "get_blueprint_template",
      arguments: { kind: "gaming" },
    });
    const oneBody = JSON.parse(resultText(one)) as {
      blueprint: { name: string; categories: Array<{ name: string }> };
    };
    expect(oneBody.blueprint.categories[0]?.name).toBe("INFORMATION");

    const bad = await mcp.callTool({
      name: "get_blueprint_template",
      arguments: { kind: "nightclub" },
    });
    expect(isError(bad)).toBe(true);
    expect(resultText(bad)).toContain("gaming");

    const resource = await mcp.readResource({ uri: "discord://design-guide" });
    const guideText = (resource.contents[0] as { text?: string }).text ?? "";
    expect(guideText).toContain("Role ladder");

    const prompt = await mcp.getPrompt({
      name: "design_server",
      arguments: { community_type: "dev", requirements: "small OSS project" },
    });
    const promptText =
      (prompt.messages[0]?.content as { text?: string }).text ?? "";
    expect(promptText).toContain("design guide");
    expect(promptText).toContain("Dev Project"); // embedded template
    expect(promptText).toContain("small OSS project");
  });

  it("create_guild builds the full one-request payload from a blueprint", async () => {
    const { mcp, api } = await setup();
    const res = await mcp.callTool({
      name: "create_guild",
      arguments: { name: "Fresh Server", blueprint: EXAMPLE_BLUEPRINT },
    });
    expect(isError(res)).toBe(false);
    expect(api.createdGuildPayloads).toHaveLength(1);
    const payload = api.createdGuildPayloads[0];
    expect(payload?.name).toBe("Fresh Server"); // name param wins
    expect(payload?.roles?.[0]?.id).toBe(0); // @everyone placeholder
    expect((payload?.channels ?? []).length).toBe(5); // 2 categories + 3 channels
  });
});
