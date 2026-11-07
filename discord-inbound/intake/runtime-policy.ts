import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface RuntimePolicy {
  readonly version: 1;
  readonly revision: string;
  readonly values: Readonly<Record<string, string>>;
}

const cache = new Map<string, { readonly stamp: string; readonly policy: RuntimePolicy }>();

function strings(value: unknown): value is Record<string, string> {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    Object.values(value).every(item => typeof item === "string");
}

export function runtimePolicy(env: Readonly<Record<string, string | undefined>> = process.env): RuntimePolicy | undefined {
  const directory = env.DORI_POLICY_DIR ?? (env.HOME ? join(env.HOME, ".dori/elobot/policy") : undefined);
  if (!directory) return undefined;
  const path = join(directory, "policy.json");
  if (!env.DORI_POLICY_DIR && !existsSync(path)) return undefined;
  const info = statSync(path);
  const stamp = `${info.ino}:${info.mtimeMs}:${info.size}`;
  const known = cache.get(path);
  if (known?.stamp === stamp) return known.policy;
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof value !== "object" || value === null || !("version" in value) || value.version !== 1 ||
      !("revision" in value) || typeof value.revision !== "string" || !/^[a-f0-9]{64}$/.test(value.revision) ||
      !("values" in value) || !strings(value.values) ||
      "DORI_DISCORD_TOKEN" in value.values || "BOT_BETA_TOKEN" in value.values) {
    throw new TypeError("Invalid runtime policy; privileged actions are withheld");
  }
  const policy: RuntimePolicy = { version: 1, revision: value.revision, values: value.values };
  cache.set(path, { stamp, policy });
  return policy;
}

export function policyValues(env: Readonly<Record<string, string | undefined>> = process.env): Readonly<Record<string, string | undefined>> {
  const policy = runtimePolicy(env);
  if (!policy) return env;
  return {
    ...env,
    ...policy.values,
    DORI_DISCORD_TRUSTED_IDS: policy.values.HELIO_TRUSTED_USERS,
    DORI_DISCORD_REPORT_CHANNELS: policy.values.HELIO_REPORT_CHANNELS,
  };
}

export function acknowledgePolicy(consumer: "intake" | "learning", expected?: string): boolean {
  const policy = runtimePolicy();
  if (!policy) return expected === undefined;
  if (expected !== undefined && expected !== policy.revision) return false;
  const directory = process.env.DORI_STATE_DIR;
  if (!directory) throw new TypeError("DORI_STATE_DIR is required for policy application receipts");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `policy-applied-${consumer}.json`);
  const temporary = `${path}.${process.pid}.tmp`;
  const stat = readFileSync("/proc/self/stat", "utf8").split(") ").at(-1);
  if (!stat) throw new TypeError("Process identity is unavailable");
  writeFileSync(temporary, JSON.stringify({ consumer, revision: policy.revision, pid: process.pid,
    start_ticks: stat.split(" ")[19], at_ms: Date.now() }), { mode: 0o600 });
  renameSync(temporary, path);
  return true;
}
