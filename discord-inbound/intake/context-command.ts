import { Delivery } from "../delivery/delivery.ts";
import { redactBlocked } from "../delivery/moderation.ts";
import { contextExcerpt } from "../delivery/context-excerpt.ts";
import { object } from "../delivery/monitor-summary.ts";
import { Conversations } from "../conversations/conversations.ts";
import { cachedReads, discordRest, DiscordRestError, IgnoredChannelError, type Rest } from "../discord/rest.ts";
import { filterConfig, reauthorize, validateChannelPolicy } from "./authorization.ts";
import { runtimePolicy } from "./runtime-policy.ts";
import { omitLinks } from "../messages/images.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";

interface EvidenceMessage {
  readonly message_id: string;
  readonly author_id: string;
  readonly author: string;
  readonly sent_at: string;
  readonly reply_to?: string;
  readonly content: string;
  readonly bot: boolean;
}

const id = (value: unknown): value is string => typeof value === "string" && /^\d{1,30}$/.test(value);

function componentEvidence(value: unknown, depth = 0): string[] {
  if (!Array.isArray(value) || depth >= 4) return [];
  return value.slice(0, 25).flatMap(value => {
    const item = object(value);
    return [
      ...[item.content, item.label, item.placeholder].filter((text): text is string => typeof text === "string"),
      ...componentEvidence(item.components, depth + 1),
      ...componentEvidence(item.accessory ? [item.accessory] : [], depth + 1),
    ];
  });
}

function evidence(value: unknown, channel: string): EvidenceMessage {
  const item = object(value), author = object(item.author);
  const reference = item.message_reference == null ? {} : object(item.message_reference);
  if (!id(item.id) || item.channel_id !== channel || !id(author.id) ||
      typeof item.content !== "string" || typeof item.timestamp !== "string" ||
      !Number.isFinite(Date.parse(item.timestamp))) throw new TypeError("Context message identity is invalid");
  const member = item.member == null ? {} : object(item.member);
  const name = member.nick ?? author.global_name ?? author.username;
  const embeds = Array.isArray(item.embeds) ? item.embeds : [];
  const details = embeds.flatMap(value => {
    const embed = object(value);
    if (embed.type !== undefined && embed.type !== "rich") return [];
    const fields = Array.isArray(embed.fields) ? embed.fields.flatMap(value => {
      const field = object(value); return [field.name, field.value];
    }) : [];
    return [embed.title, embed.description, ...fields].filter((text): text is string => typeof text === "string");
  });
  return {
    message_id: item.id, author_id: author.id, author: typeof name === "string" ? name.slice(0, 80) : author.id,
    sent_at: item.timestamp, bot: author.bot === true,
    ...(reference.type !== 1 && id(reference.message_id) ? { reply_to: reference.message_id } : {}),
    content: omitLinks([item.content, ...details, ...componentEvidence(item.components)].join("\n")),
  };
}

/** A separate CLI read keeps optional history and its deadline out of intake preparation. */
export async function contextCommand(args: readonly string[]): Promise<number> {
  const state = process.env.DORI_STATE_DIR, token = process.env.DORI_DISCORD_TOKEN;
  const rootId = args[2];
  if (args.length !== 3 || args[0] !== "context" || args[1] !== "inbound" || !id(rootId) || !state) {
    console.error("Usage: ack context inbound ID; requires DORI_STATE_DIR");
    return 2;
  }
  if (!token || !existsSync(join(state, "discord-delivery.sqlite"))) {
    console.error("ACK_EVIDENCE_REFUSED source state or Discord credentials unavailable");
    return 1;
  }
  const queue = new Delivery(join(state, "discord-delivery.sqlite"));
  const store = new Conversations(join(state, "discord-conversations.sqlite"));
  const signal = AbortSignal.timeout(10_000);
  const revision = runtimePolicy()?.revision;
  const raw = cachedReads(discordRest(token));
  const rest: Rest = (path, init) => raw(path, { ...init, signal });
  const messages = new Map<string, EvidenceMessage>();
  let status = "complete";
  let source_status = "unchanged";
  let withheld = false;
  const output = () => {
    const entries: Record<string, unknown>[] = [];
    let text = 0;
    for (const entry of messages.values()) {
      const rendered = contextExcerpt({ ...entry }, Math.min(900, 10_000 - JSON.stringify(entries).length));
      if (!rendered || typeof rendered.content !== "string" || text + rendered.content.length > 8000) {
        if (status === "complete") status = "character_limit";
        break;
      }
      text += rendered.content.length;
      entries.push(rendered);
    }
    console.log(`ACK_EVIDENCE ${JSON.stringify({ context_evidence: {
      root_id: rootId, provenance: "live_refetch", observed_at: new Date().toISOString(),
      policy_revision: revision, status, source_status, messages: entries, omitted_count: messages.size - entries.length,
    } })}`);
  };
  try {
    queue.check(rootId);
    const source = queue.pending("inbound").find(item => item.id === rootId);
    if (!source) throw new RangeError("Source is not pending or accepted");
    const saved = object(JSON.parse(source.payload)), origin = object(saved.discord_origin);
    const cfg = filterConfig(process.env, (channel, user) => store.isOpen(channel, user),
      (channel, user, messageId) => store.workingAnchor(channel, user, messageId), undefined,
      (channel, user) => store.talkedRecently(channel, user, Date.now()));
    cfg.botId = (await rest<{ id: string }>("/users/@me")).id;
    await validateChannelPolicy(cfg, rest, () => undefined);
    signal.throwIfAborted();
    const authorized = await reauthorize(source.payload, cfg, rest);
    if (!authorized || queue.moderation.isBlocked(authorized.author_id)) throw new RangeError("Source is outside current policy");
    const channel = authorized.channel_id;
    const live = await rest<unknown>(`/channels/${channel}/messages/${rootId}`);
    const root = evidence(live, channel);
    if (root.message_id !== rootId || root.author_id !== authorized.author_id) throw new TypeError("Source identity changed");
    if (typeof origin.content_sha256 === "string" && typeof object(live).content === "string") {
      source_status = new Bun.CryptoHasher("sha256").update(String(object(live).content)).digest("hex") === origin.content_sha256 ?
        "unchanged" : "edited";
    }
    const ancestors: EvidenceMessage[] = [];
    const visited = new Set([rootId]);
    let target = root.reply_to;
    while (target && ancestors.length < 4) {
      if (visited.has(target)) { status = "cycle"; break; }
      visited.add(target);
      let body: unknown;
      try { body = await rest<unknown>(`/channels/${channel}/messages/${target}`); }
      catch (error) {
        if (!(error instanceof DiscordRestError) || error.status !== 404) throw error;
        status = "reply_unavailable"; break;
      }
      const value = evidence(body, channel);
      if (value.message_id !== target) throw new TypeError("Reply target identity changed");
      ancestors.push(value);
      target = value.reply_to;
    }
    if (target && ancestors.length === 4) status = "depth_limit";
    for (const value of ancestors.reverse()) messages.set(value.message_id, value);
    const page = await rest<unknown>(`/channels/${channel}/messages?before=${rootId}&limit=20`);
    if (!Array.isArray(page) || page.length > 20) throw new TypeError("Context history page is invalid");
    const recent = page.map(value => evidence(value, channel))
      .sort((a, b) => BigInt(a.message_id) > BigInt(b.message_id) ? -1 : 1);
    for (const entry of recent) {
      const age = Date.parse(root.sent_at) - Date.parse(entry.sent_at);
      if (BigInt(entry.message_id) >= BigInt(rootId) || age < 0 || age > 300_000) continue;
      if (!messages.has(entry.message_id)) messages.set(entry.message_id, entry);
    }
    if (page.length === 20 && status === "complete") status = "page_limit";
    signal.throwIfAborted();
    if (runtimePolicy()?.revision !== revision) throw new IgnoredChannelError(channel);
    queue.check(rootId);
    if (queue.moderation.isBlocked(authorized.author_id)) throw new RangeError("Source author is now blocked");
    if (queue.pending("inbound").find(item => item.id === rootId)?.payload !== source.payload) {
      throw new RangeError("Source changed while context was read");
    }
    for (const [key, value] of messages) {
      const redacted = object(redactBlocked(value, user => queue.moderation.isBlocked(user)));
      messages.set(key, { ...value, content: typeof redacted.content === "string" ? redacted.content : "" });
    }
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    if (error instanceof IgnoredChannelError || runtimePolicy()?.revision !== revision) {
      messages.clear(); withheld = true; status = "policy_changed";
    } else if (signal.aborted) {
      messages.clear(); status = "timeout";
    } else if (error instanceof DiscordRestError) {
      messages.clear(); status = error.status === 404 ? "deleted_or_unavailable" : "unavailable";
    } else if (error instanceof RangeError || error instanceof TypeError) {
      messages.clear(); withheld = true; status = error.message;
    } else {
      messages.clear(); withheld = true; status = error.message;
    }
  } finally {
    queue.close(); store.dispose();
  }
  output();
  return withheld ? 1 : 0;
}
