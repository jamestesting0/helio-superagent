import { createHash } from "node:crypto";

import { addressingFacts, classify, guildChannelAllowed, insideAllowed, insideCategory, type AddressingFacts, type FilterConfig, type IncomingMessage } from "./filter.ts";
import { type ApiChannel, type Rest, THREAD_PARENT_TYPES } from "../discord/rest.ts";
import { policyValues } from "./runtime-policy.ts";

/** Channel trust never grants sender authority or adds a channel to the allowlist. */
export type IntakeCallbacks = Pick<FilterConfig, "awaitingAnswer" | "workingAnchor" | "lastOwnerPost" | "topicMessage">;

export function filterConfig(
  values: Readonly<Record<string, string | undefined>>, callbacks: IntakeCallbacks = {},
): FilterConfig {
  const current = policyValues(values);
  const required = (name: string) => {
    const value = current[name]?.trim();
    if (!value) throw new TypeError(`Missing ${name}`);
    return value;
  };
  const csv = (name: string) => {
    const ids = (current[name] ?? "").split(",").map((id) => id.trim()).filter(Boolean);
    if (ids.some((id) => !/^\d+$/.test(id))) throw new TypeError(`Invalid ${name}`);
    return new Set(ids);
  };
  const trustedChannels = csv("DORI_DISCORD_TRUSTED_CHANNELS");
  const normalChannels = csv("DORI_DISCORD_NORMAL_CHANNELS");
  const trustEntries = current.DORI_DISCORD_TRUSTED_CHANNELS?.trim();
  if (trustEntries && trustEntries.split(",").map((id) => id.trim()).length !== trustedChannels.size) {
    throw new TypeError("Invalid or overlapping DORI_DISCORD_TRUSTED_CHANNELS");
  }
  if ([...normalChannels].some((id) => trustedChannels.has(id))) {
    throw new TypeError("Overlapping DORI_DISCORD_NORMAL_CHANNELS and DORI_DISCORD_TRUSTED_CHANNELS");
  }
  let bugReportSource: FilterConfig["bugReportSource"];
  if (current.DORI_DISCORD_BUG_REPORT_SOURCE !== undefined) {
    const [authorId, channelId, ...extra] = current.DORI_DISCORD_BUG_REPORT_SOURCE.split(":");
    if (!authorId || !channelId || extra.length || !/^\d+$/.test(authorId) || !/^\d+$/.test(channelId)) {
      throw new TypeError("Invalid DORI_DISCORD_BUG_REPORT_SOURCE");
    }
    bugReportSource = { authorId, channelId };
  }
  required("DORI_DISCORD_ALLOWED");
  const answerForOwner = current.HELIO_ANSWER_FOR_OWNER?.trim() || "on";
  const presentMinutes = current.HELIO_OWNER_PRESENT_MINUTES?.trim() || "10";
  if (answerForOwner !== "on" && answerForOwner !== "off") throw new TypeError("Invalid HELIO_ANSWER_FOR_OWNER");
  if (!/^[1-9][0-9]{0,4}$/.test(presentMinutes)) throw new TypeError("Invalid HELIO_OWNER_PRESENT_MINUTES");
  const scopeCategory = current.DORI_DISCORD_SCOPE_CATEGORY?.trim();
  if (scopeCategory && !/^\d+$/.test(scopeCategory)) throw new TypeError("Invalid DORI_DISCORD_SCOPE_CATEGORY");
  return {
    ownerId: required("DORI_DISCORD_OWNER_ID"),
    allowed: csv("DORI_DISCORD_ALLOWED"),
    trustedIds: csv("DORI_DISCORD_TRUSTED_IDS"),
    trustedChannels,
    normalChannels,
    issueReportChannels: csv("DORI_DISCORD_REPORT_CHANNELS"),
    bugReportSource,
    ...callbacks,
    answerForOwner: answerForOwner === "on",
    ownerPresentMs: Number(presentMinutes) * 60_000,
    ...(scopeCategory ? { scopeCategory } : {}),
    ignoredChannels: csv("DORI_DISCORD_IGNORED_CHANNELS"),
  };
}

const THREAD_TYPES = new Set([10, 11, 12]);

/** Source reads and replies use current intake scope, including stateless helper invocations. */
export async function requireReplyChannel(channelId: string, cfg: FilterConfig, rest: Rest): Promise<void> {
  if (cfg.ignoredChannels?.has(channelId) || cfg.blockedChannels?.has(channelId)) {
    throw new RangeError("Reply channel is excluded by current policy; retained pending");
  }
  const channel = await rest<ApiChannel>(`/channels/${channelId}`);
  if (channel.id !== channelId) throw new TypeError("Reply channel identity changed");
  if (channel.type === 1 || channel.type === 3) return;
  if (!await guildChannelAllowed(channelId, cfg, async id =>
    id === channelId ? channel : await rest<ApiChannel>(`/channels/${id}`))) {
    throw new RangeError("Reply channel is outside current scope; retained pending");
  }
}

export async function validateChannelPolicy(
  cfg: FilterConfig, rest: Rest, warn: (message: string) => void,
): Promise<void> {
  const blocked = new Set<string>();
  const channels = new Map<string, ApiChannel | undefined>();
  cfg.blockedChannels = blocked;
  const channelOf = async (id: string) => {
    if (cfg.ignoredChannels?.has(id)) return undefined;
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
    message_type: msg.type,
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
    addressing: addressingFacts(msg),
    // The payload's text has links rewritten; release checks compare this against the live message instead.
    content_sha256: createHash("sha256").update(msg.content).digest("hex"),
  };
}

function withoutLinkedFiles(record: Record<string, unknown>): void {
  const strip = (holder: Record<string, unknown>) => {
    for (const key of ["attachments", "blocked_attachments"]) {
      const list = holder[key];
      if (Array.isArray(list)) holder[key] = list.filter((item) => (item as { source?: unknown })?.source !== "link");
    }
  };
  strip(record);
  if (Array.isArray(record.forwarded)) {
    record.forwarded = record.forwarded.map((item) => {
      if (typeof item !== "object" || item === null) return item;
      const copy = { ...item } as Record<string, unknown>;
      withoutLinkedFiles(copy);
      return copy;
    });
  }
  const reply = record.reply_context;
  if (typeof reply === "object" && reply !== null && "messages" in reply && Array.isArray(reply.messages)) {
    record.reply_context = { ...reply, messages: reply.messages.map((item) => {
      if (typeof item !== "object" || item === null) return item;
      const copy = Object.fromEntries(Object.entries(item));
      withoutLinkedFiles(copy);
      return copy;
    }) };
  }
}

function validFacts(value: unknown): value is AddressingFacts {
  if (typeof value !== "object" || value === null) return false;
  const facts = value as Record<string, unknown>;
  const ids = (list: unknown) => Array.isArray(list) && list.every(id => typeof id === "string" && /^\d+$/.test(id));
  return ids(facts.text_mention_ids) && (facts.quoted_mention_ids === undefined || ids(facts.quoted_mention_ids)) &&
    ids(facts.parent_mention_ids) && typeof facts.names_helio === "boolean" &&
    (facts.leading_mention_id === null || (typeof facts.leading_mention_id === "string" && /^\d+$/.test(facts.leading_mention_id)));
}

export interface OriginalMetadata {
  readonly id: string; readonly channel_id: string; readonly author: { readonly id: string }; readonly type: number;
}

/** Recompute authority; only legacy records require an original-message read after policy allows it. */
export async function reauthorize(payload: string, cfg: FilterConfig, rest: Rest,
  onOriginal?: (original: OriginalMetadata) => void) {
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
  if (cfg.ignoredChannels?.has(saved.channel_id)) return null;
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
  const lookup = async (id: string) => id === channel.id ? channel : await rest<ApiChannel>(`/channels/${id}`);
  if (channel.guild_id && !await guildChannelAllowed(channel.id, cfg, lookup)) return null;
  let type = "message_type" in origin ? origin.message_type : undefined;
  if (type === undefined) {
    const original = await rest<OriginalMetadata>(
      `/channels/${saved.channel_id}/messages/${saved.message_id}`);
    if (original.id !== saved.message_id || original.channel_id !== saved.channel_id || original.author.id !== origin.author_id) {
      throw new TypeError("Legacy source identity changed; retained pending");
    }
    type = original.type;
    if (typeof type !== "number" || !Number.isInteger(type)) throw new TypeError("Pending message type is unavailable; retained pending");
    onOriginal?.(original);
  }
  if (typeof type !== "number" || !Number.isInteger(type)) throw new TypeError("Pending message type is unavailable; retained pending");
  const current = await classify({
    id: saved.message_id, type, channel_id: saved.channel_id, guild_id: channel.guild_id,
    author: { id: origin.author_id, bot: origin.bot, username: "author" in saved && typeof saved.author === "string" ? saved.author : origin.author_id },
    webhook_id: origin.webhook_id ?? undefined,
    content: "", timestamp: "sent_at" in saved && typeof saved.sent_at === "string" ? saved.sent_at : "",
    mentions: origin.mention_ids.map((id) => ({ id })),
    message_reference: origin.reply_to === null ? undefined : { message_id: origin.reply_to },
    referenced_message: origin.reply_author_id === null ? null : { author: { id: origin.reply_author_id } },
    // Derive legacy quote exclusions before classification discards the retained text.
    addressing: "addressing" in origin && validFacts(origin.addressing) ?
      { ...origin.addressing, quoted_mention_ids: origin.addressing.quoted_mention_ids ??
        addressingFacts({ content: saved.content }).quoted_mention_ids } :
      addressingFacts({ content: saved.content, message_reference: origin.reply_to === null ? undefined : { message_id: origin.reply_to } }),
  }, cfg, lookup);
  if (!current) return null;
  const result = {
    ...saved, ...current, content: saved.content,
    discord_origin: { ...origin, message_type: type },
    attachments: "attachments" in saved ? saved.attachments : [],
    // Expiry is tied to the originally queued sent_at, not a later REST response.
    sent_at: "sent_at" in saved ? saved.sent_at : undefined,
  };
  // A queued trusted message may become normal after configuration changes: normal chats keep no linked files
  // and only the replied-to message.
  if (current.channel_policy === "normal") withoutLinkedFiles(result);
  if (current.channel_policy === "normal" && "reply_context" in result) {
    const chain = result.reply_context as { messages?: unknown[] } | undefined;
    const parent = Array.isArray(chain?.messages) ? chain.messages.at(-1) : undefined;
    if (parent) result.reply_context = { status: "parent_only", messages: [parent] };
    else delete result.reply_context;
  }
  return result;
}
