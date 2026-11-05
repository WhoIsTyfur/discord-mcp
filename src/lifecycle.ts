/**
 * Lifecycle: exit when the parent session ends.
 *
 * An MCP client starts this server once per agent session and expects it to go
 * away when the session does. Without this the server outlives every session
 * that started it, and a long-lived host accumulates orphaned node processes.
 *
 * The shutdown is idempotent and covers four ways a session can end:
 *   - the client closes the stdin pipe (end or close),
 *   - the host sends SIGHUP, SIGTERM or SIGINT,
 *   - the parent process disappears (checked every PARENT_WATCH_INTERVAL_MS).
 *
 * Every seam (stdin, signals, exit, parent liveness, log sink, timers) is
 * injectable so the tests can drive the logic without sending real signals or
 * waiting on a real parent. Nothing here reads or logs configuration values:
 * the only thing written is the shutdown reason.
 */

import { log as structuredLog } from "./logging.js";

/** How often the parent watchdog checks that the process that started us lives. */
export const PARENT_WATCH_INTERVAL_MS = 15000;

/** Grace period between closing the server and exiting, so stderr can flush. */
export const EXIT_DELAY_MS = 200;

export type CloseFn = () => unknown;

export interface Closable {
  close?: CloseFn;
}

export interface InputSource {
  on(event: "end" | "close", listener: () => void): unknown;
}

export interface SignalSource {
  once(event: "SIGHUP" | "SIGTERM" | "SIGINT", listener: () => void): unknown;
}

export type LifecycleLog = (
  message: string,
  fields?: Record<string, unknown>,
) => void;

export interface LifecycleOptions {
  /** MCP server to close on shutdown. */
  server?: Closable | null;
  /** Transport to close on shutdown. */
  transport?: Closable | null;
  /** Process that started this server. 0 and 1 are treated as "no parent". */
  parentPid?: number;
  /** Stream whose end or close means the session is over. */
  input?: InputSource;
  /** Source of termination signals. */
  signals?: SignalSource;
  exit?: (code: number) => void;
  log?: LifecycleLog;
  parentAlive?: (pid: number) => boolean;
  intervalMs?: number;
  exitDelayMs?: number;
}

/**
 * True while the process that started this server is still alive.
 *
 * Signal 0 performs the permission and existence check without delivering
 * anything. A pid of 0 or 1 is never a real parent, so it reports false rather
 * than risking a signal to a process group or to init.
 */
export function isParentProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but is owned by someone else.
    const code = (err as NodeJS.ErrnoException | null)?.code;
    return code === "EPERM";
  }
}

/**
 * Close a server or transport without letting a failure block the exit. The
 * SDK close methods return promises, so a rejection has to be swallowed too.
 */
function closeQuietly(target: Closable | null | undefined): void {
  try {
    const result = target?.close?.();
    if (result && typeof (result as PromiseLike<unknown>).then === "function") {
      void Promise.resolve(result).catch(() => {});
    }
  } catch {
    // An already closed server or transport is fine.
  }
}

/**
 * Wire the exit paths. Returns the shutdown function so a caller (or a test)
 * can trigger the same path deliberately.
 */
export function createLifecycle(
  options: LifecycleOptions = {},
): (reason: string) => void {
  const {
    server = null,
    transport = null,
    parentPid = process.ppid,
    input = process.stdin,
    signals = process,
    exit = (code: number) => process.exit(code),
    log: writeLog = structuredLog.info,
    parentAlive = isParentProcessAlive,
    intervalMs = PARENT_WATCH_INTERVAL_MS,
    exitDelayMs = EXIT_DELAY_MS,
  } = options;

  let stopping = false;
  let watchdog: NodeJS.Timeout | null = null;

  const shutdown = (reason: string): void => {
    if (stopping) return;
    stopping = true;
    if (watchdog !== null) {
      clearInterval(watchdog);
      watchdog = null;
    }
    try {
      writeLog("exiting", { reason });
    } catch {
      // A broken log sink must never block the exit.
    }
    closeQuietly(transport);
    closeQuietly(server);
    setTimeout(() => exit(0), exitDelayMs);
  };

  input.on("end", () => shutdown("stdin ended"));
  input.on("close", () => shutdown("stdin closed"));
  signals.once("SIGHUP", () => shutdown("SIGHUP"));
  signals.once("SIGTERM", () => shutdown("SIGTERM"));
  signals.once("SIGINT", () => shutdown("SIGINT"));

  if (parentAlive(parentPid)) {
    watchdog = setInterval(() => {
      if (!parentAlive(parentPid)) shutdown("parent process is gone");
    }, intervalMs);
    watchdog.unref();
  } else {
    // Started without a live parent, so no session can ever own this process.
    shutdown("parent process is gone");
  }

  return shutdown;
}
