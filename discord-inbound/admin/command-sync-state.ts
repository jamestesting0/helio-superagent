import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { AdminError, object, text } from "./protocol.ts";
import type { CommandChanges } from "./registration.ts";

export type ScopeSync = {
  readonly state: "verified" | "denied" | "invalid" | "retrying" | "pending";
  readonly target: string;
  readonly checkedAt: number;
  readonly verifiedAt?: number;
  readonly changes?: CommandChanges;
  readonly reason?: string;
  readonly problem?: "credentials" | "permission" | "definitions" | "unavailable" | "rate_limit";
  readonly retryAt?: number;
};
export type CommandSyncReceipt = {
  readonly version: 1;
  readonly pid: number;
  readonly processStart: string;
  readonly loadedVersion: string;
  readonly credentialVersion: string;
  readonly application?: string;
  readonly supportsSync: true;
  readonly checkedAt: number;
  readonly dm: ScopeSync;
  readonly guild: ScopeSync;
  readonly globalRetryAt?: number;
};

export function processStart(): string {
  return text(readFileSync("/proc/self/stat", "utf8").split(") ").at(-1)?.split(" ")[19], 40);
}

function finiteNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new AdminError("invalid", "Invalid command synchronization observation number");
  }
  return value;
}

export function readCommandSync(path: string): CommandSyncReceipt | undefined {
  let raw: string;
  try { raw = readFileSync(path, "utf8"); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
  const row = object(JSON.parse(raw));
  if (row.version !== 1 || row.supportsSync !== true) throw new AdminError("invalid", "Unsupported command synchronization receipt");
  const scope = (value: unknown): ScopeSync => {
    const item = object(value);
    const state = text(item.state, 20);
    if (state !== "verified" && state !== "denied" && state !== "invalid" && state !== "retrying" && state !== "pending") {
      throw new AdminError("invalid", "Invalid saved command synchronization state");
    }
    const changes = item.changes === undefined ? undefined : object(item.changes);
    const problem = item.problem;
    if (problem !== undefined && problem !== "credentials" && problem !== "permission" && problem !== "definitions" &&
      problem !== "unavailable" && problem !== "rate_limit") throw new AdminError("invalid", "Invalid synchronization problem");
    return { state, target: text(item.target, 100), checkedAt: finiteNumber(item.checkedAt),
      ...(changes === undefined ? {} : { changes: { created: finiteNumber(changes.created), updated: finiteNumber(changes.updated),
        removed: finiteNumber(changes.removed), unchanged: finiteNumber(changes.unchanged) } }),
      ...(item.verifiedAt === undefined ? {} : { verifiedAt: finiteNumber(item.verifiedAt) }),
      ...(item.retryAt === undefined ? {} : { retryAt: finiteNumber(item.retryAt) }),
      ...(problem === undefined ? {} : { problem }),
      ...(item.reason === undefined ? {} : { reason: text(item.reason, 400) }) };
  };
  return { version: 1, pid: finiteNumber(row.pid), processStart: text(row.processStart, 40),
    loadedVersion: text(row.loadedVersion, 100), supportsSync: true, checkedAt: finiteNumber(row.checkedAt),
    credentialVersion: row.credentialVersion === undefined ? "" : text(row.credentialVersion, 100),
    ...(row.application === undefined ? {} : { application: text(row.application, 30) }),
    dm: scope(row.dm), guild: scope(row.guild),
    ...(row.globalRetryAt === undefined ? {} : { globalRetryAt: finiteNumber(row.globalRetryAt) }) };
}

export function saveCommandSync(path: string, receipt: CommandSyncReceipt): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(receipt) + "\n", { mode: 0o600 });
  renameSync(temporary, path);
}
