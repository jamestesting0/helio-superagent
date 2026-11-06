import { Database } from "bun:sqlite";
import { existsSync, realpathSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Delivery } from "./delivery.ts";
import { cleanupIgnored } from "./ignored-cleanup.ts";
import { neutralReason } from "./ignored-store.ts";
import { object } from "./monitor-summary.ts";
import { filterConfig, reauthorize, type OriginalMetadata } from "../intake/authorization.ts";
import { cachedReads, discordRest, type Rest } from "../discord/rest.ts";
import { Conversations } from "../conversations/conversations.ts";
import { inspectTopic, type TopicInspection } from "../conversations/reconcile-topic.ts";
import { finalAlreadyApplied, finalReceipt } from "../conversations/reconcile-final.ts";
import { ReplySettlements } from "../conversations/reply-settlement.ts";
import { parseRecoveryManifest, recoveryPolicyHash, type MessagePlan, type RecoveryManifest } from "./reconcile-manifest.ts";

const hash = (value: unknown) => new Bun.CryptoHasher("sha256").update(JSON.stringify(value)).digest("hex");
const sourceHash = (payload: string) => new Bun.CryptoHasher("sha256").update(payload).digest("hex");
const id = (value: unknown): value is string => typeof value === "string" && /^\d{1,30}$/.test(value);
const table = (db: Database, name: string) => db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) !== null;

function readDelivery(db: Database, messageId: string) {
  const row = db.query<{ payload: string | null }, [string]>(
    "SELECT payload FROM delivery WHERE stream='inbound' AND id=?").get(messageId);
  const accepted = table(db, "acceptance") ? db.query("SELECT * FROM acceptance WHERE stream='inbound' AND id=?").get(messageId) : null;
  const handled = table(db, "handling") ? db.query<{ disposition: string }, [string]>(
    "SELECT * FROM handling WHERE stream='inbound' AND id=?").get(messageId) : null;
  const expiry = table(db, "expiry") ? db.query("SELECT * FROM expiry WHERE stream='inbound' AND id=?").get(messageId) : null;
  const ignored = table(db, "ignored") ? db.query<{ source_digest: string; reason: string }, [string]>(
    "SELECT * FROM ignored WHERE stream='inbound' AND id=?").get(messageId) : null;
  const disposition = !row ? "absent" : ignored ? "ignored" : expiry ? "expired" :
    row.payload !== null ? accepted ? "accepted" : "pending" : handled?.disposition ?? "legacy-done";
  return { payload: row?.payload ?? null, digest: hash({ row, accepted, handled, expiry, ignored }), disposition, ignored };
}

function pendingDigest(db: Database | undefined, topic: TopicInspection, planned: readonly MessagePlan[] = []): string {
  if (!db) return hash([]);
  const rows = db.query<{ id: string; payload: string }, [string, string]>(`SELECT id,payload FROM delivery
    WHERE stream='inbound' AND payload IS NOT NULL AND json_valid(payload)
      AND json_extract(payload,'$.channel_id')=? AND json_extract(payload,'$.author_id')=?
    ORDER BY length(id),id`).all(topic.channel, topic.user);
  return hash(rows.filter(row => !planned.some(expected => expected.id === row.id && expected.action === "ignore" &&
    readDelivery(db, row.id).digest === expected.digest)));
}

function ids(value: string | undefined, maximum: number): string[] {
  const values = value ? value.split(",") : [];
  if (values.length > maximum || values.some(value => !id(value)) || new Set(values).size !== values.length) {
    throw new TypeError(`Expected at most ${maximum} unique message IDs`);
  }
  return values;
}

export async function reconcileRecovery(action: "preview" | "apply", path: string, options: ReadonlyMap<string, string>, state: string): Promise<void> {
  const allowed = action === "preview" ? ["--messages", "--topics", "--notices", "--answered"] : [];
  if ([...options.keys()].some(key => !allowed.includes(key))) throw new TypeError("Unexpected reconciliation options");
  const stateHash = hash(realpathSync(state)), policy = recoveryPolicyHash();
  const queuePath = join(state, "discord-delivery.sqlite"), topicPath = join(state, "discord-conversations.sqlite");
  const queueRead = existsSync(queuePath) ? new Database(queuePath, { readonly: true }) : undefined;
  const topicRead = existsSync(topicPath) ? new Database(topicPath, { readonly: true }) : undefined;
  const cfg = filterConfig(process.env);
  const rest: Rest = process.env.DORI_DISCORD_TOKEN ? cachedReads(discordRest(process.env.DORI_DISCORD_TOKEN)) :
    async () => { throw new TypeError("Current metadata requires DORI_DISCORD_TOKEN"); };
  const channelOf = (channel: string) => rest<{ parent_id?: string }>(`/channels/${channel}`);
  const evaluate = async (payload: string) => {
    let original: OriginalMetadata | undefined;
    let reason = await neutralReason("inbound", payload, cfg.ignoredChannels, channelOf);
    if (!reason) {
      const saved = object(JSON.parse(payload)), origin = object(saved.discord_origin ?? {});
      if (origin.message_type === undefined) {
        await reauthorize(payload, cfg, rest, value => { original = value; });
        reason = await neutralReason("inbound", payload, cfg.ignoredChannels, channelOf, original);
      }
    }
    return { reason, original };
  };
  let queue: Delivery | undefined, store: Conversations | undefined;
  try {
    if (action === "preview") {
      const selected = ids(options.get("--messages"), 25), notices = ids(options.get("--notices"), 25);
      const selectedTopics = options.get("--topics")?.split(",") ?? [];
      if (selectedTopics.length > 10 || (!selected.length && !selectedTopics.length)) throw new TypeError("Select 1-25 messages or 1-10 exact topics");
      const manifest: RecoveryManifest = { version: 1, kind: "helio-lifecycle", manifest_id: crypto.randomUUID(),
        state: stateHash, policy, observed_at: new Date().toISOString(), messages: [], topics: [], notices };
      for (const messageId of selected) {
        if (!queueRead) throw new RangeError("Delivery database is absent");
        const current = readDelivery(queueRead, messageId);
        let reason: string = `Retain ${current.disposition} input`, action: MessagePlan["action"] = "preserve";
        if (current.disposition === "pending" && current.payload !== null) {
          try {
            const result = await evaluate(current.payload);
            if (result.reason) { reason = result.reason; action = "ignore"; }
          } catch (error) {
            if (!(error instanceof Error)) throw error;
            reason = `Internal review: ${error.message.slice(0, 300)}`;
          }
        }
        manifest.messages.push({ id: messageId, digest: current.digest, source_digest:
          current.payload === null ? null : sourceHash(current.payload), disposition: current.disposition, action, reason });
      }
      for (const selector of selectedTopics) {
        const [channel, user, anchor, ...extra] = selector.split(":");
        if (!id(channel) || !id(user) || !id(anchor) || extra.length || !topicRead) throw new TypeError("Topic must be channel:user:anchor in an existing database");
        const topic = inspectTopic(topicRead, { channel, user, anchor }, notices);
        manifest.topics.push({ ...topic, pending_digest: pendingDigest(queueRead, topic, manifest.messages) });
      }
      if (options.has("--answered")) {
        const [source, reply, ...extra] = options.get("--answered")!.split(":");
        if (!id(source) || !id(reply) || extra.length) throw new TypeError("--answered requires SOURCE:REPLY");
        const sendPath = join(state, "reply-sends.sqlite");
        let found = false;
        if (existsSync(sendPath)) {
          const sends = new Database(sendPath, { readonly: true });
          try {
            found = table(sends, "reply_sends") && sends.query(
              "SELECT 1 FROM reply_sends WHERE target=? AND reply_id=? AND state='sent'").get(source, reply) !== null;
            if (found && topicRead) manifest.topics = manifest.topics.map(topic => {
              const key = topic.action === "preserve" ? finalReceipt(sends, topicRead, topic, manifest.topics, { source, reply }) : undefined;
              return key ? { ...topic, final_receipt: key } : topic;
            });
          }
          finally { sends.close(); }
        }
        manifest.answered = { source, reply, prior_reply_found: found,
          note: manifest.topics.some(topic => topic.final_receipt) ? "Resume the recorded final disposition without sending again." :
            "A historical reply alone does not prove a mixed topic fulfilled; preserve internal review." };
      }
      await writeFile(path, JSON.stringify(manifest, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      console.log(`RECONCILE_PREVIEW manifest=${path} messages=${manifest.messages.length} topics=${manifest.topics.length}`);
      return;
    }
    if (Bun.file(path).size > 1_048_576) throw new RangeError("Manifest exceeds 1 MiB");
    const manifest = parseRecoveryManifest(await Bun.file(path).json());
    if (manifest.state !== stateHash || manifest.policy !== policy) throw new RangeError("State location or current policy changed; preview again");
    let changed = false;
    for (const expected of manifest.messages) {
      if (!queueRead) throw new RangeError("Delivery database is absent");
      const current = readDelivery(queueRead, expected.id);
      let outcome: string;
      if (expected.action === "ignore" && current.ignored?.source_digest === expected.source_digest) outcome = "already-applied";
      else if (current.digest !== expected.digest) outcome = "changed";
      else if (expected.action === "preserve") outcome = "preserved";
      else if (current.payload === null || current.disposition !== "pending") outcome = "changed";
      else {
        const result = await evaluate(current.payload);
        if (result.reason !== expected.reason) outcome = "changed";
        else {
          queue ??= new Delivery(queuePath);
          outcome = await queue.ignored.settle("inbound", expected.id, current.payload,
            cfg.ignoredChannels, channelOf, result.original) ? "ignored" : "changed";
        }
      }
      if (outcome === "changed") changed = true;
      console.log(`RECONCILE_MESSAGE message_id=${expected.id} outcome=${outcome}`);
    }
    for (const expected of manifest.topics) {
      if (!topicRead) throw new RangeError("Conversation database is absent");
      const key = `${manifest.manifest_id}:${expected.channel}:${expected.user}:${expected.anchor}`;
      const repaired = table(topicRead, "conversation_repairs") && topicRead.query(
        "SELECT 1 FROM conversation_repairs WHERE repair_key=?").get(key) !== null;
      let outcome: string;
      if (repaired || (expected.final_receipt && finalAlreadyApplied(topicRead, expected, expected.final_receipt))) outcome = "already-applied";
      else if (pendingDigest(queueRead, expected, manifest.messages) !== expected.pending_digest) outcome = "changed";
      else {
        const current = inspectTopic(topicRead, expected, manifest.notices);
        if (current.digest !== expected.digest) outcome = "changed";
        else if (expected.final_receipt && manifest.answered) {
          const sendPath = join(state, "reply-sends.sqlite"), sends = new Database(sendPath, { readonly: true });
          let valid: string | undefined;
          try { valid = finalReceipt(sends, topicRead, expected, manifest.topics, manifest.answered); }
          finally { sends.close(); }
          if (valid !== expected.final_receipt) outcome = "changed";
          else {
            store ??= new Conversations(topicPath);
            const receipts = new ReplySettlements(sendPath);
            try { receipts.recover(valid, store, Date.now()); }
            finally { receipts.close(); }
            outcome = finalAlreadyApplied(topicRead, expected, valid) ? "final-settled" : "preserved";
          }
        } else if (current.action === "preserve") outcome = "preserved";
        else {
          store ??= new Conversations(topicPath);
          outcome = store.reconciliation.apply(key, expected, manifest.notices);
        }
      }
      if (outcome === "changed") changed = true;
      console.log(`RECONCILE_TOPIC channel=${expected.channel} user=${expected.user} anchor=${expected.anchor} outcome=${outcome}`);
    }
    if (queue) {
      if (!store && existsSync(topicPath)) store = new Conversations(topicPath);
      await cleanupIgnored(queue, state, store);
    }
    if (changed) process.exitCode = 3;
  } finally { queue?.close(); store?.dispose(); queueRead?.close(); topicRead?.close(); }
}
