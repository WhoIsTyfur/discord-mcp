import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runTool, SNOWFLAKE, type ToolContext } from "./shared.js";

export function registerRenameChannel(server: McpServer, ctx: ToolContext): void {
  server.registerTool("rename_channel", {
    title: "Rename a channel or category",
    description: "Rename an existing channel or category by ID, preserving its messages, order, parent and permissions.",
    inputSchema: {
      channel_id: z.string().regex(SNOWFLAKE),
      name: z.string().trim().min(1).max(100),
      dry_run: z.boolean().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, async ({ channel_id, name, dry_run }) => runTool("rename_channel", async () => {
    if (ctx.dryRun || dry_run) return { dry_run: true, channel_id, name };
    const channel = await ctx.api.modifyChannel(channel_id, { name }, "discord-provisioner-mcp: rename channel");
    return { channel_id: channel.id, name: channel.name };
  }));
}
