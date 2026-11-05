/**
 * Lifecycle tests: the server must exit when its parent session ends, so a
 * finished session does not leave a node process behind.
 *
 * The unit tests drive the injected seams of createLifecycle, so no real
 * signal is sent and no real parent is touched. The last test spawns the real
 * entry point with piped stdio, closes stdin, and asserts a clean exit 0.
 */

import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  PARENT_WATCH_INTERVAL_MS,
  createLifecycle,
  isParentProcessAlive,
  type LifecycleOptions,
} from "../src/lifecycle.js";

const EXIT_TIMEOUT_MS = 2000;

function fakes(): {
  calls: { server: number; transport: number };
  server: { close: () => void };
  transport: { close: () => void };
  exits: number[];
  reasons: string[];
} {
  const calls = { server: 0, transport: 0 };
  const exits: number[] = [];
  const reasons: string[] = [];
  return {
    calls,
    exits,
    reasons,
    server: {
      close: () => {
        calls.server += 1;
      },
    },
    transport: {
      close: () => {
        calls.transport += 1;
      },
    },
  };
}

function start(
  overrides: Partial<LifecycleOptions> & {
    input?: EventEmitter;
    signals?: EventEmitter;
  } = {},
): { input: EventEmitter; signals: EventEmitter } & ReturnType<typeof fakes> {
  const f = fakes();
  const input = overrides.input ?? new EventEmitter();
  const signals = overrides.signals ?? new EventEmitter();
  createLifecycle({
    server: f.server,
    transport: f.transport,
    parentPid: process.pid,
    input,
    signals,
    exit: (code) => f.exits.push(code),
    log: (message, fields) => {
      f.reasons.push(`${message}: ${String(fields?.["reason"])}`);
    },
    parentAlive: () => true,
    exitDelayMs: 0,
    ...overrides,
  });
  return { ...f, input, signals };
}

/** Poll until predicate is true, or fail the test. */
async function waitFor(
  predicate: () => boolean,
  label: string,
  timeoutMs = EXIT_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe("isParentProcessAlive", () => {
  it("reports a live pid and a dead pid", () => {
    expect(isParentProcessAlive(process.pid)).toBe(true);
    expect(isParentProcessAlive(999999)).toBe(false);
  });

  it("never treats pid 0, pid 1 or a non-integer as a parent", () => {
    expect(isParentProcessAlive(0)).toBe(false);
    expect(isParentProcessAlive(1)).toBe(false);
    expect(isParentProcessAlive(-1)).toBe(false);
    expect(isParentProcessAlive(1.5)).toBe(false);
  });

  it("checks the parent every 15 seconds", () => {
    expect(PARENT_WATCH_INTERVAL_MS).toBe(15000);
  });
});

describe("createLifecycle", () => {
  it("exits 0 once when stdin ends, closing the transport and server once", async () => {
    const h = start();
    h.input.emit("end");
    h.input.emit("close"); // a second signal must not repeat the shutdown
    await waitFor(() => h.exits.length > 0, "exit");

    expect(h.exits).toEqual([0]);
    expect(h.calls.transport).toBe(1);
    expect(h.calls.server).toBe(1);
    expect(h.reasons).toEqual(["exiting: stdin ended"]);
  });

  it("exits 0 when stdin closes", async () => {
    const h = start();
    h.input.emit("close");
    await waitFor(() => h.exits.length > 0, "exit");

    expect(h.exits).toEqual([0]);
    expect(h.reasons).toEqual(["exiting: stdin closed"]);
  });

  it("exits 0 on SIGHUP, SIGTERM and SIGINT", async () => {
    for (const signal of ["SIGHUP", "SIGTERM", "SIGINT"] as const) {
      const h = start();
      h.signals.emit(signal);
      await waitFor(() => h.exits.length > 0, signal);

      expect(h.exits).toEqual([0]);
      expect(h.reasons).toEqual([`exiting: ${signal}`]);
      expect(h.calls.server).toBe(1);
    }
  });

  it("exits 0 when the parent disappears while running", async () => {
    let checks = 0;
    const h = start({
      parentAlive: () => {
        checks += 1;
        return checks < 2; // alive at start, gone on the first watchdog tick
      },
      intervalMs: 5,
    });

    await waitFor(() => h.exits.length > 0, "watchdog exit");
    expect(h.exits).toEqual([0]);
    expect(h.reasons).toEqual(["exiting: parent process is gone"]);
  });

  it("exits 0 right away when there is no parent at start", async () => {
    let checks = 0;
    const h = start({
      parentPid: 0,
      parentAlive: () => {
        checks += 1;
        return false;
      },
      intervalMs: 5,
    });

    await waitFor(() => h.exits.length > 0, "immediate exit");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(h.exits).toEqual([0]);
    expect(checks).toBe(1); // no watchdog was armed
  });

  it("keeps running while the parent is alive", async () => {
    const h = start({ intervalMs: 5 });
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(h.exits).toEqual([]);
    expect(h.calls.server).toBe(0);
    expect(h.calls.transport).toBe(0);

    h.input.emit("end"); // stop the watchdog for this fake
    await waitFor(() => h.exits.length > 0, "cleanup exit");
  });

  it("shuts down even when the log sink throws", async () => {
    const h = start({
      log: () => {
        throw new Error("sink is broken");
      },
    });
    h.input.emit("end");
    await waitFor(() => h.exits.length > 0, "exit");

    expect(h.exits).toEqual([0]);
    expect(h.calls.server).toBe(1);
  });

  it("exits 0 when close rejects asynchronously", async () => {
    const h = start({
      transport: { close: () => Promise.reject(new Error("transport gone")) },
      server: { close: () => Promise.reject(new Error("server gone")) },
    });
    h.input.emit("end");
    await waitFor(() => h.exits.length > 0, "exit");

    expect(h.exits).toEqual([0]);
  });
});

describe("stdio process lifecycle", () => {
  it("exits 0 within 5 seconds of stdin closing", async () => {
    const tsxCli = fileURLToPath(
      new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url),
    );
    const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));

    const child = spawn(process.execPath, [tsxCli, entry], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        // A fake value: this test never reaches Discord.
        DISCORD_BOT_TOKEN: "offline-lifecycle-test",
        DRY_RUN: "true",
        LOG_LEVEL: "info",
      },
    });

    let stderr = "";
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`server never started: ${stderr}`)),
        15000,
      );
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
        if (stderr.includes("listening on stdio")) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`server exited early with ${String(code)}: ${stderr}`));
      });
    });

    try {
      await ready;
      const startedAt = Date.now();
      child.stdin.end();
      const code = await new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error(`server did not exit within 5s: ${stderr}`));
        }, 5000);
        child.on("exit", (exitCode) => {
          clearTimeout(timer);
          resolve(exitCode);
        });
      });

      expect(code).toBe(0);
      expect(Date.now() - startedAt).toBeLessThan(5000);
      expect(stderr).toContain("exiting");
      expect(stderr).toContain("stdin ended");
      expect(stderr).not.toContain("offline-lifecycle-test");
    } finally {
      if (child.exitCode === null && !child.killed) child.kill();
    }
  }, 30000);
});
