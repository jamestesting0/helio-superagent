import { createHash } from "node:crypto";

import { classify, insideAllowed, insideCategory, type FilterConfig, type IncomingMessage } from "./filter.ts";
import { type ApiChannel, type Rest, THREAD_PARENT_TYPES } from "./rest.ts";

/** Channel trust never grants sender authority or adds a channel to the allowlist. */
export function filterConfig(
  values: Readonly<Record<string, string | undefined>>, inConversation?: FilterConfig["inConversation"],
): FilterConfig {
  const required = (name: string) => {
    const value = values[name]?.trim();
    if (!value) throw new TypeError(`Missing ${name}`);
    return value;
  };
  const csv = (name: string) => {
    const ids = (values[name] ?? "").split(",").map((id) => id.trim()).filter(Boolean);
    if (ids.some((id) => !/^\d+$/.test(id))) throw new TypeError(`Invalid ${name}`);
    return new Set(ids);
  };
  const trustedChannels = csv("DORI_DISCORD_TRUSTED_CHANNELS");
  const normalChannels = csv("DORI_DISCORD_NORMAL_CHANNELS");
  const trustEntries = values.DORI_DISCORD_TRUSTED_CHANNELS?.trim();
  if (trustEntries && trustEntries.split(",").map((id) => id.trim()).length !== trustedChannels.size) {
    throw new TypeError("Invalid or overlapping DORI_DISCORD_TRUSTED_CHANNELS");
  }
  if ([...normalChannels].some((id) => trustedChannels.has(id))) {
    throw new TypeError("Overlapping DORI_DISCORD_NORMAL_CHANNELS and DORI_DISCORD_TRUSTED_CHANNELS");
  }
  let bugReportSource: FilterConfig["bugReportSource"];
  if (values.DORI_DISCORD_BUG_REPORT_SOURCE !== undefined) {
    const [authorId, channelId, ...extra] = values.DORI_DISCORD_BUG_REPORT_SOURCE.split(":");
    if (!authorId || !channelId || extra.length || !/^\d+$/.test(authorId) || !/^\d+$/.test(channelId)) {
      throw new TypeError("Invalid DORI_DISCORD_BUG_REPORT_SOURCE");
    }
    bugReportSource = { authorId, channelId };
  }
  required("DORI_DISCORD_ALLOWED");
  const scopeCategory = values.DORI_DISCORD_SCOPE_CATEGORY?.trim();
  if (scopeCategory && !/^\d+$/.test(scopeCategory)) throw new TypeError("Invalid DORI_DISCORD_SCOPE_CATEGORY");
  return {
    ownerId: required("DORI_DISCORD_OWNER_ID"),
    allowed: csv("DORI_DISCORD_ALLOWED"),
    trustedIds: csv("DORI_DISCORD_TRUSTED_IDS"),
    trustedChannels,
    normalChannels,
    issueReportChannels: csv("DORI_DISCORD_REPORT_CHANNELS"),
    bugReportSource,
    ...(inConversation ? { inConversation } : {}),
    ...(scopeCategory ? { scopeCategory } : {}),
    ignoredChannels: csv("DORI_DISCORD_IGNORED_CHANNELS"),
  };
}

const THREAD_TYPES = new Set([10, 11, 12]);

export async function validateChannelPolicy(
  cfg: FilterConfig, rest: Rest, warn: (message: string) => void,
): Promise<void> {
  const blocked = new Set<string>();
  const channels = new Map<string, ApiChannel | undefined>();
  cfg.blockedChannels = blocked;
  const channelOf = async (id: string) => {
    if (channels.has(id)) return channels.get(id);
    try {
      const channel = await rest<ApiChannel>(`/channels/${id}`);
      channels.set(id, channel);
      return channel;
    }
    catch (error) {
      if (!(error instanceof Error)) throw error;
      blocked.add(id);
      channels.set(id, undefined);
      warn(`channel policy unavailable channel=${id}; blocked until revalidation: ${error.message}`);
      return undefined;
    }
  };
  if (cfg.scopeCategory) {
    const configured = [...cfg.allowed, ...(cfg.trustedChannels ?? []), ...(cfg.normalChannels ?? []), ...(cfg.issueReportChannels ?? [])];
    for (const id of new Set(configured)) {
      if (id === cfg.scopeCategory || blocked.has(id) || await insideCategory(id, cfg.scopeCategory, channelOf)) continue;
      blocked.add(id);
      warn(`channel ${id} is outside DORI_DISCORD_SCOPE_CATEGORY ${cfg.scopeCategory}; ignored`);
    }
  }
  if (!cfg.trustedChannels?.size && !cfg.normalChannels?.size) return;
  const parentOf = async (id: string) => (await rest<ApiChannel>(`/channels/${id}`)).parent_id ?? undefined;
  for (const id of new Set([...(cfg.trustedChannels ?? []), ...(cfg.normalChannels ?? [])])) {
    const channel = await channelOf(id);
    if (!channel) continue;
    let allowed: boolean;
    try { allowed = await insideAllowed(id, cfg.allowed, parentOf); }
    catch (error) {
      if (!(error instanceof Error)) throw error;
      blocked.add(id);
      warn(`channel policy ancestry unavailable channel=${id}; blocked until revalidation: ${error.message}`);
      continue;
    }
    if ((!THREAD_PARENT_TYPES.has(channel.type) && !THREAD_TYPES.has(channel.type)) || !allowed) {
      throw new TypeError(`Invalid DORI_DISCORD_TRUSTED_CHANNELS/DORI_DISCORD_NORMAL_CHANNELS channel ${id}: must be an allowed channel or thread, not a category`);
    }
    if (THREAD_TYPES.has(channel.type) && channel.parent_id &&
        cfg.normalChannels?.has(channel.parent_id) && cfg.trustedChannels?.has(id)) {
      throw new TypeError(`Ambiguous DORI_DISCORD_TRUSTED_CHANNELS: trusted thread ${id} overlaps normal parent ${channel.parent_id}`);
    }
  }
  for (const id of cfg.allowed) {
    const channel = await channelOf(id);
    if (!channel) continue;
    if (THREAD_TYPES.has(channel.type) && channel.parent_id &&
        cfg.trustedChannels?.has(channel.parent_id) && !cfg.trustedChannels.has(id)) {
      throw new TypeError(`Ambiguous DORI_DISCORD_TRUSTED_CHANNELS: normal thread ${id} overlaps trusted parent ${channel.parent_id}`);
    }
  }
}

/** Persist only verified top-level routing facts, never forwarded authors or embedded mentions. */
export function authorizationMetadata(msg: IncomingMessage) {
  return {
    version: 1,
    message_id: msg.id,
    channel_id: msg.channel_id,
    guild_id: msg.guild_id ?? null,
    author_id: msg.author.id,
    bot: msg.author.bot === true,
    webhook_id: msg.webhook_id ?? null,
    mention_ids: [...new Set([
      ...(msg.mentions ?? []).map((user) => user.id),
      ...[...msg.content.matchAll(/<@!?([0-9]+)>/g)].flatMap((match) => match[1] ? [match[1]] : []),
    ])],
    reply_to: msg.message_reference?.type === 1 ? null : msg.message_reference?.message_id ?? null,
    reply_author_id: msg.referenced_message?.author.id ?? null,
    // The payload's text has links rewritten; release checks compare this against the live message instead.
    content_sha256: createHash("sha256").update(msg.content).digest("hex"),
  };
}

/** Recompute authority from original routing facts and current config, without message GETs. */
export async function reauthorize(payload: string, cfg: FilterConfig, rest: Rest) {
  const saved: unknown = JSON.parse(payload);
  if (typeof saved !== "object" || saved === null ||
      !("message_id" in saved) || typeof saved.message_id !== "string" || !/^\d+$/.test(saved.message_id) ||
      !("channel_id" in saved) || typeof saved.channel_id !== "string" || !/^\d+$/.test(saved.channel_id) ||
      !("content" in saved) || typeof saved.content !== "string") {
    throw new TypeError("Pending delivery lacks replay identity");
  }
  if (!("preparation_complete" in saved) || saved.preparation_complete !== true) {
    throw new TypeError("Pending evidence preparation is incomplete or legacy; retained pending");
  }
  const origin = "discord_origin" in saved ? saved.discord_origin : undefined;
  if (typeof origin !== "object" || origin === null ||
      !("version" in origin) || origin.version !== 1 ||
      !("message_id" in origin) || origin.message_id !== saved.message_id ||
      !("channel_id" in origin) || origin.channel_id !== saved.channel_id ||
      !("author_id" in origin) || typeof origin.author_id !== "string" || !/^\d+$/.test(origin.author_id) ||
      !("guild_id" in origin) || (origin.guild_id !== null && typeof origin.guild_id !== "string") ||
      !("bot" in origin) || typeof origin.bot !== "boolean" ||
      !("webhook_id" in origin) || (origin.webhook_id !== null && typeof origin.webhook_id !== "string") ||
      !("mention_ids" in origin) || !Array.isArray(origin.mention_ids) ||
      !origin.mention_ids.every((id): id is string => typeof id === "string" && /^\d+$/.test(id)) ||
      !("reply_to" in origin) || (origin.reply_to !== null && typeof origin.reply_to !== "string") ||
      !("reply_author_id" in origin) || (origin.reply_author_id !== null && typeof origin.reply_author_id !== "string")) {
    throw new TypeError("Legacy or ambiguous pending delivery lacks verified top-level Discord metadata; retained pending");
  }
  const channel = await rest<ApiChannel>(`/channels/${saved.channel_id}`);
  if ((channel.guild_id ?? null) !== origin.guild_id) throw new TypeError("Pending channel location changed; retained pending");
  const current = await classify({
    id: saved.message_id, channel_id: saved.channel_id, guild_id: channel.guild_id,
    author: { id: origin.author_id, bot: origin.bot, username: "author" in saved && typeof saved.author === "string" ? saved.author : origin.author_id },
    webhook_id: origin.webhook_id ?? undefined,
    content: "", timestamp: "sent_at" in saved && typeof saved.sent_at === "string" ? saved.sent_at : "",
    mentions: origin.mention_ids.map((id) => ({ id })),
    message_reference: origin.reply_to === null ? undefined : { message_id: origin.reply_to },
    referenced_message: origin.reply_author_id === null ? null : { author: { id: origin.reply_author_id } },
  }, cfg,
    async (id) => (await rest<ApiChannel>(`/channels/${id}`)).parent_id ?? undefined);
  if (!current) return null;
  const result = {
    ...saved, ...current, content: saved.content,
    attachments: "attachments" in saved ? saved.attachments : [],
    // Expiry is tied to the originally queued sent_at, not a later REST response.
    sent_at: "sent_at" in saved ? saved.sent_at : undefined,
  };
  // A queued trusted reply may become normal after configuration changes; normal chats keep only the replied-to message.
  if (current.channel_policy === "normal" && "reply_context" in result) {
    const chain = result.reply_context as { messages?: unknown[] } | undefined;
    const parent = Array.isArray(chain?.messages) ? chain.messages.at(-1) : undefined;
    if (parent) result.reply_context = { status: "parent_only", messages: [parent] };
    else delete result.reply_context;
  }
  return result;
}
