#!/usr/bin/env node
/**
 * Entrypoint: transport selection and arg parsing.
 *
 * --stdio (default): stdout carries the MCP protocol; ALL logging goes to
 *   stderr via logging.ts. Nothing in this codebase calls console.log.
 * --http --port 3000: Streamable HTTP transport with per-session transports
 *   and mandatory bearer auth (MCP_AUTH_TOKEN).
 */

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { DiscordClient } from "./discord/client.js";
import { DiscordEndpoints } from "./discord/endpoints.js";
import { createLifecycle } from "./lifecycle.js";
import { configureLogging, log } from "./logging.js";
import { buildServer, SERVER_NAME, SERVER_VERSION } from "./server.js";

interface CliArgs {
  transport: "stdio" | "http";
  port: number;
  host: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { transport: "stdio", port: 3000, host: "127.0.0.1" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--stdio":
        args.transport = "stdio";
        break;
      case "--http":
        args.transport = "http";
        break;
      case "--port": {
        const value = argv[++i];
        const port = value !== undefined ? Number(value) : NaN;
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          fail(`--port requires an integer between 1 and 65535, got "${value}"`);
        }
        args.port = port;
        break;
      }
      case "--host": {
        const value = argv[++i];
        if (!value) fail("--host requires a value");
        args.host = value;
        break;
      }
      case "--help":
      case "-h":
        process.stderr.write(
          `${SERVER_NAME} ${SERVER_VERSION}\n\n` +
            `Usage:\n` +
            `  discord-provisioner-mcp [--stdio]                 stdio transport (default)\n` +
            `  discord-provisioner-mcp --http [--port 3000] [--host 127.0.0.1]\n\n` +
            `Environment:\n` +
            `  DISCORD_BOT_TOKEN    required\n` +
            `  DISCORD_API_VERSION  default v10\n` +
            `  DRY_RUN              default false\n` +
            `  LOG_LEVEL            default info (debug|info|warn|error|silent)\n` +
            `  WRITE_DELAY_MS       default 250\n` +
            `  MCP_AUTH_TOKEN       required in --http mode (bearer token)\n`,
        );
        process.exit(0);
        break;
      default:
        fail(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function fail(message: string): never {
  process.stderr.write(`${SERVER_NAME}: ${message}\n`);
  process.exit(1);
}

function envFlag(name: string): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  return value === "true" || value === "1" || value === "yes";
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const token = process.env["DISCORD_BOT_TOKEN"];
  if (!token) {
    fail(
      "DISCORD_BOT_TOKEN is required. Create a bot at " +
        "https://discord.com/developers/applications and set the token in the environment.",
    );
  }
  const authToken = process.env["MCP_AUTH_TOKEN"];
  if (args.transport === "http" && !authToken) {
    fail(
      "MCP_AUTH_TOKEN is required in --http mode. Every HTTP request must " +
        "send 'Authorization: Bearer <MCP_AUTH_TOKEN>'.",
    );
  }

  const dryRun = envFlag("DRY_RUN");
  const writeDelayRaw = process.env["WRITE_DELAY_MS"];
  const writeDelayMs =
    writeDelayRaw !== undefined && Number.isFinite(Number(writeDelayRaw))
      ? Math.max(0, Number(writeDelayRaw))
      : 250;

  configureLogging({
    level: process.env["LOG_LEVEL"] ?? "info",
    redact: [token, authToken],
  });

  const client = new DiscordClient({
    token,
    apiVersion: process.env["DISCORD_API_VERSION"] ?? "v10",
    dryRun,
    writeDelayMs,
  });
  const api = new DiscordEndpoints(client);

  if (dryRun) {
    log.info("DRY_RUN active: no write request will reach Discord");
  }

  if (args.transport === "stdio") {
    const server = buildServer({ api, dryRun });
    const transport = new StdioServerTransport();
    await server.connect(transport);
    log.info("listening on stdio", { server: SERVER_NAME, version: SERVER_VERSION });
    // The client owns this process for the length of one session. Exit when
    // that session ends instead of outliving it.
    createLifecycle({ server, transport });
    return;
  }

  await runHttp(args, authToken as string, () => buildServer({ api, dryRun }));
}

/** Constant-time bearer token comparison (hash first to equalise lengths). */
function bearerMatches(header: string | undefined, expected: string): boolean {
  if (!header) return false;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match || match[1] === undefined) return false;
  const a = createHash("sha256").update(match[1]).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

async function runHttp(
  args: CliArgs,
  authToken: string,
  makeServer: () => ReturnType<typeof buildServer>,
): Promise<void> {
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const readBody = (req: IncomingMessage): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 4 * 1024 * 1024) {
          reject(new Error("request body too large"));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        if (chunks.length === 0) {
          resolve(undefined);
          return;
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
      req.on("error", reject);
    });

  const jsonError = (
    res: ServerResponse,
    status: number,
    code: number,
    message: string,
  ): void => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code, message },
        id: null,
      }),
    );
  };

  const httpServer = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

      if (req.method === "GET" && url.pathname === "/healthz") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, server: SERVER_NAME }));
        return;
      }

      if (url.pathname !== "/mcp") {
        jsonError(res, 404, -32001, "Not found; MCP endpoint is /mcp");
        return;
      }

      if (!bearerMatches(req.headers.authorization, authToken)) {
        log.warn("rejected unauthorized request", {
          method: req.method,
          ip: req.socket.remoteAddress,
        });
        jsonError(
          res,
          401,
          -32000,
          "Unauthorized: send 'Authorization: Bearer <MCP_AUTH_TOKEN>'",
        );
        return;
      }

      const sessionId = req.headers["mcp-session-id"];
      const sid = Array.isArray(sessionId) ? sessionId[0] : sessionId;

      if (req.method === "POST") {
        const existing = sid !== undefined ? transports.get(sid) : undefined;
        if (existing) {
          await existing.handleRequest(req, res);
          return;
        }
        const body = await readBody(req);
        if (sid === undefined && isInitializeRequest(body)) {
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (id) => {
              transports.set(id, transport);
              log.info("mcp session initialized", { session: id });
            },
          });
          transport.onclose = () => {
            if (transport.sessionId) {
              transports.delete(transport.sessionId);
              log.info("mcp session closed", { session: transport.sessionId });
            }
          };
          const server = makeServer();
          await server.connect(transport);
          await transport.handleRequest(req, res, body);
          return;
        }
        jsonError(
          res,
          400,
          -32000,
          "Bad request: missing or unknown mcp-session-id (send initialize first)",
        );
        return;
      }

      if (req.method === "GET" || req.method === "DELETE") {
        const existing = sid !== undefined ? transports.get(sid) : undefined;
        if (!existing) {
          jsonError(res, 400, -32000, "Bad request: missing or unknown mcp-session-id");
          return;
        }
        await existing.handleRequest(req, res);
        return;
      }

      jsonError(res, 405, -32000, "Method not allowed");
    } catch (err) {
      log.error("http request failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      if (!res.headersSent) {
        jsonError(res, 500, -32603, "Internal server error");
      } else {
        res.end();
      }
    }
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(args.port, args.host, resolve);
  });
  log.info("listening on http", {
    host: args.host,
    port: args.port,
    endpoint: "/mcp",
  });

  const shutdown = (): void => {
    log.info("shutting down");
    for (const transport of transports.values()) {
      void transport.close();
    }
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGHUP", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  log.error("fatal error", {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
