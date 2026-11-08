import type { DiscordReference } from "../messages/references.ts";

export const SECTIONS = ["overview", "conversations", "lanes", "blocks", "trusted", "channels", "timeouts", "settings", "audit"] as const;
export type Section = typeof SECTIONS[number];
export type Fields = Readonly<Record<string, string>>;

export interface AdminPolicy {
  readonly version: 1;
  readonly revision: string;
  readonly values: Fields;
  readonly timing: readonly TimingSetting[];
}

export interface TimingSetting {
  readonly key: string;
  readonly label: string;
  readonly unit: string;
  readonly minimum: number;
  readonly maximum: number;
}
export interface AdminRecord {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly revision: string;
  readonly state?: string;
  readonly user?: string;
  readonly channel?: string;
  readonly source?: string;
  readonly url?: string;
  readonly blockedActions?: Fields;
  readonly fields?: readonly DisplayField[];
  readonly activity?: readonly { readonly title: string; readonly text: string; readonly fields?: readonly DisplayField[] }[];
}

export interface DisplayField { readonly name: string; readonly value: string | DiscordReference }

export type RuntimeQuery =
  | { readonly kind: "read"; readonly section: Section; readonly target?: string; readonly filters: Fields; readonly suggest?: boolean }
  | { readonly kind: "mutate"; readonly action: string; readonly target: string; readonly expected: string; readonly input: Fields }
  | { readonly kind: "receipt"; readonly action: string; readonly target: string; readonly expected: string; readonly input: Fields }
  | { readonly kind: "probe"; readonly dependency: "github" };

export interface RuntimeProof {
  readonly id: string;
  readonly operation: string;
  readonly actor: string;
  readonly guild: string;
  readonly expires_at: number;
  readonly policy_revision: string;
  readonly query: RuntimeQuery;
}

export interface RuntimeResult {
  readonly records: readonly AdminRecord[];
  readonly notice?: string;
  readonly operation?: string;
  readonly revision?: string;
  readonly application?: {
    readonly revision: string;
    readonly consumers: readonly { readonly name: string; readonly applied: boolean }[];
  };
  readonly receipt?: {
    readonly status: "done" | "refused" | "running" | "uncertain";
    readonly outcome?: RuntimeResult;
    readonly error?: string;
  };
}

export type BrokerRequest =
  | { readonly kind: "policy" }
  | { readonly kind: "runtime"; readonly actor: string; readonly guild: string; readonly operation: string; readonly query: RuntimeQuery }
  | { readonly kind: "configure"; readonly actor: string; readonly operation: string; readonly expected: string;
      readonly action: string; readonly target: string; readonly value: string }
  | { readonly kind: "operation"; readonly actor: string; readonly operation: string };

export class AdminError extends Error {
  constructor(readonly code: "denied" | "changed" | "unavailable" | "uncertain" | "invalid", message: string) {
    super(message);
    this.name = "AdminError";
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function object(value: unknown): Record<string, unknown> {
  if (!isObject(value)) throw new AdminError("invalid", "Invalid administration payload");
  return value;
}

export function text(value: unknown, maximum = 600): string {
  if (typeof value !== "string" || value.length > maximum) throw new AdminError("invalid", "Invalid administration text");
  return value;
}

export function fields(value: unknown): Fields {
  const result: Record<string, string> = {};
  for (const [name, entry] of Object.entries(object(value))) result[name] = text(entry, 4000);
  return result;
}

function displayFields(value: unknown): DisplayField[] {
  if (!Array.isArray(value)) throw new AdminError("invalid", "Invalid display fields");
  return value.map(entry => {
    const item = object(entry), name = text(item.name, 256);
    if (typeof item.value === "string") return { name, value: text(item.value, 12000) };
    const link = object(item.value), id = text(link.id, 30), label = text(link.label, 100);
    if (!/^\d+$/.test(id)) throw new AdminError("invalid", "Invalid reference ID");
    if (link.kind === "user") return { name, value: { kind: "user", id, label } };
    const channel = text(link.channel, 30), guild = text(link.guild, 30);
    if (link.kind !== "message" || !/^\d+$/.test(channel) || !/^(?:@me|\d+)$/.test(guild)) {
      throw new AdminError("invalid", "Invalid message reference");
    }
    return { name, value: { kind: "message", id, label, channel, guild } };
  });
}

export function policy(value: unknown): AdminPolicy {
  const row = object(value);
  const revision = text(row.revision, 64);
  if (row.version !== 1 || !/^[a-f0-9]{64}$/.test(revision)) throw new AdminError("invalid", "Invalid administration policy");
  if (!Array.isArray(row.timing)) throw new AdminError("invalid", "Timing policy metadata is missing");
  const timing = row.timing.map(entry => {
    const item = object(entry);
    if (typeof item.minimum !== "number" || typeof item.maximum !== "number" ||
        !Number.isSafeInteger(item.minimum) || !Number.isSafeInteger(item.maximum) || item.maximum < item.minimum) {
      throw new AdminError("invalid", "Invalid timing policy bounds");
    }
    return { key: text(item.key, 100), label: text(item.label, 100), unit: text(item.unit, 100),
      minimum: item.minimum, maximum: item.maximum };
  });
  return { version: 1, revision, values: fields(row.values), timing };
}

export function record(value: unknown): AdminRecord {
  const row = object(value);
  const details = row.fields;
  const activity = row.activity;
  if ((details !== undefined && !Array.isArray(details)) || (activity !== undefined && !Array.isArray(activity))) {
    throw new AdminError("invalid", "Invalid administration record");
  }
  return {
    id: text(row.id, 120), title: text(row.title, 600), summary: text(row.summary, 2000), revision: text(row.revision, 100),
    ...(row.state === undefined ? {} : { state: text(row.state, 100) }),
    ...(row.user === undefined ? {} : { user: text(row.user, 30) }),
    ...(row.channel === undefined ? {} : { channel: text(row.channel, 30) }),
    ...(row.source === undefined ? {} : { source: text(row.source, 100) }),
    ...(row.url === undefined ? {} : { url: text(row.url, 500) }),
    ...(row.blockedActions === undefined ? {} : { blockedActions: fields(row.blockedActions) }),
    ...(Array.isArray(details) ? { fields: displayFields(details) } : {}),
    ...(Array.isArray(activity) ? { activity: activity.map(entry => {
      const item = object(entry); return { title: text(item.title, 256), text: text(item.text, 12000),
        ...(item.fields === undefined ? {} : { fields: displayFields(item.fields) }) };
    }) } : {}),
  };
}

export function result(value: unknown): RuntimeResult {
  const row = object(value);
  if (!Array.isArray(row.records)) throw new AdminError("invalid", "Invalid administration result");
  let application: RuntimeResult["application"];
  let receipt: RuntimeResult["receipt"];
  if (row.application !== undefined) {
    const status = object(row.application);
    if (!Array.isArray(status.consumers)) throw new AdminError("invalid", "Invalid policy application receipt");
    application = { revision: text(status.revision, 64), consumers: status.consumers.map(entry => {
      const consumer = object(entry);
      if (typeof consumer.applied !== "boolean") throw new AdminError("invalid", "Invalid consumer application receipt");
      return { name: text(consumer.name, 30), applied: consumer.applied };
    }) };
  }
  if (row.receipt !== undefined) {
    const saved = object(row.receipt);
    const status = saved.status;
    if (status !== "done" && status !== "refused" && status !== "running" && status !== "uncertain") {
      throw new AdminError("invalid", "Invalid operation receipt");
    }
    receipt = { status, ...(saved.outcome === undefined ? {} : { outcome: result(saved.outcome) }),
      ...(saved.error === undefined ? {} : { error: text(saved.error, 1000) }) };
  }
  return { records: row.records.map(record),
    ...(row.notice === undefined ? {} : { notice: text(row.notice, 1000) }),
    ...(row.operation === undefined ? {} : { operation: text(row.operation, 100) }),
    ...(row.revision === undefined ? {} : { revision: text(row.revision, 100) }),
    ...(application ? { application } : {}),
    ...(receipt ? { receipt } : {}),
  };
}

export function section(value: unknown): Section {
  const found = SECTIONS.find(item => item === value);
  if (!found) throw new AdminError("invalid", "Unknown administration section");
  return found;
}

export function query(value: unknown): RuntimeQuery {
  const row = object(value);
  switch (row.kind) {
    case "read":
      if (row.suggest !== undefined && typeof row.suggest !== "boolean") throw new AdminError("invalid", "Invalid suggestion mode");
      return { kind: "read", section: section(row.section), filters: fields(row.filters),
        ...(row.suggest === undefined ? {} : { suggest: row.suggest }),
        ...(row.target === undefined ? {} : { target: text(row.target, 120) }) };
    case "mutate": case "receipt":
      return { kind: row.kind, action: text(row.action, 60), target: text(row.target, 120),
        expected: text(row.expected, 100), input: fields(row.input) };
    case "probe":
      if (row.dependency !== "github") throw new AdminError("invalid", "Unknown dependency");
      return { kind: "probe", dependency: "github" };
    default:
      throw new AdminError("invalid", "Unknown administration operation");
  }
}

export function isAdminInteraction(value: unknown): boolean {
  if (!isObject(value) || !isObject(value.data)) return false;
  const data = value.data;
  return SECTIONS.some(section => data.name === (section === "overview" ? "status" : section)) ||
    (typeof data.custom_id === "string" && data.custom_id.startsWith("ha1:"));
}
