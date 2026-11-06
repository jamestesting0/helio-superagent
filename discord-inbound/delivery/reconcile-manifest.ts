import { object } from "./monitor-summary.ts";
import type { TopicInspection } from "../conversations/reconcile-topic.ts";
export type MessagePlan = { id: string; digest: string; source_digest: string | null; action: "ignore" | "preserve"; reason: string; disposition: string };
export type TopicPlan = TopicInspection & { readonly pending_digest: string; readonly final_receipt?: string };
export interface RecoveryManifest {
  version: 1; kind: "helio-lifecycle"; manifest_id: string; state: string; policy: string; observed_at: string;
  messages: MessagePlan[]; topics: TopicPlan[]; notices: string[];
  answered?: { source: string; reply: string; prior_reply_found: boolean; note: string };
}
const id = (value: unknown): value is string => typeof value === "string" && /^\d{1,30}$/.test(value);
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

export function recoveryPolicyHash(): string {
  return new Bun.CryptoHasher("sha256").update(JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    (name.startsWith("DORI_DISCORD_") && !name.includes("TOKEN")) ||
    ["HELIO_GITHUB_REPO", "HELIO_ANSWER_FOR_OWNER", "HELIO_OWNER_PRESENT_MINUTES"].includes(name)).sort(([a], [b]) => a.localeCompare(b))))).digest("hex");
}

export function parseRecoveryManifest(value: unknown): RecoveryManifest {
  const data = object(value);
  if (data.version !== 1 || data.kind !== "helio-lifecycle" || typeof data.manifest_id !== "string" ||
      !digest(data.state) || !digest(data.policy) || typeof data.observed_at !== "string" ||
      !Array.isArray(data.messages) || data.messages.length > 25 || !Array.isArray(data.topics) || data.topics.length > 10 ||
      !Array.isArray(data.notices) || data.notices.length > 25 || !data.notices.every(id)) throw new TypeError("Invalid reconciliation manifest");
  const messages = data.messages.map((value): MessagePlan => {
    const row = object(value);
    if (!id(row.id) || !digest(row.digest) || (row.source_digest !== null && !digest(row.source_digest)) ||
        (row.action !== "ignore" && row.action !== "preserve") || typeof row.reason !== "string" ||
        typeof row.disposition !== "string") throw new TypeError("Invalid message precondition");
    return { id: row.id, digest: row.digest, source_digest: row.source_digest, action: row.action,
      reason: row.reason, disposition: row.disposition };
  });
  const topics = data.topics.map((value): TopicPlan => {
    const row = object(value);
    if (!id(row.channel) || !id(row.user) || !id(row.anchor) || !digest(row.digest) || !digest(row.pending_digest) ||
        !Array.isArray(row.notices) || !row.notices.every(id) || typeof row.reason !== "string" ||
        (row.action !== "remove-notices" && row.action !== "preserve") ||
        (row.meaningful_activity !== null && (typeof row.meaningful_activity !== "number" || !Number.isFinite(row.meaningful_activity))) ||
        (row.final_receipt !== undefined && (typeof row.final_receipt !== "string" || row.final_receipt.length > 500))) {
      throw new TypeError("Invalid topic precondition");
    }
    return { channel: row.channel, user: row.user, anchor: row.anchor, digest: row.digest, pending_digest: row.pending_digest,
      notices: row.notices, reason: row.reason, action: row.action,
      meaningful_activity: row.meaningful_activity,
      ...(typeof row.final_receipt === "string" ? { final_receipt: row.final_receipt } : {}) };
  });
  let answered: RecoveryManifest["answered"];
  if (data.answered !== undefined) {
    const row = object(data.answered);
    if (!id(row.source) || !id(row.reply) || typeof row.prior_reply_found !== "boolean" || typeof row.note !== "string") {
      throw new TypeError("Invalid answer receipt selection");
    }
    answered = { source: row.source, reply: row.reply, prior_reply_found: row.prior_reply_found, note: row.note };
  }
  return { version: 1, kind: "helio-lifecycle", manifest_id: data.manifest_id, state: data.state, policy: data.policy,
    observed_at: data.observed_at, messages, topics, notices: data.notices, ...(answered ? { answered } : {}) };
}
