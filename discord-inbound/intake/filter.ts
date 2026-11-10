// Decides which Discord messages reach Dori, and with what authority.
// Everything not explicitly allowed is dropped before the model sees it.

import type { MessageBody } from "../messages/forwarded.ts";

export type Role = "OWNER_REQUEST" | "TRUSTED_REQUEST" | "STAFF_QUESTION" | "BOT_BUG_REPORT";
export type ChannelPolicy = "normal" | "trusted";

export interface FilterConfig {
  ownerId: string;
  botId?: string;
  allowed: ReadonlySet<string>;
  trustedIds?: ReadonlySet<string>;
  readonly trustedChannels?: ReadonlySet<string>;
  readonly normalChannels?: ReadonlySet<string>;
  blockedChannels?: ReadonlySet<string>;
  issueReportChannels?: ReadonlySet<string>;
  readonly bugReportSource?: { readonly authorId: string; readonly channelId: string };
  readonly scopeCategory?: string;
  readonly ignoredChannels?: ReadonlySet<string>;
  /** Helio's open question in this channel is waiting on this person. */
  readonly awaitingAnswer?: (channelId: string, userId: string) => boolean;
  readonly workingAnchor?: (channelId: string, userId: string, messageId: string) => string | undefined;
  /** Admit server messages that mention the owner (not Helio), so Helio can answer for the owner. */
  readonly answerForOwner?: boolean;
  /** Owner mentions are left alone while the owner posted in that channel this recently. */
  readonly ownerPresentMs?: number;
  readonly lastOwnerPost?: (channelId: string) => number | undefined;
}

export type ChannelLookup = (id: string) => Promise<{ readonly type?: number; readonly parent_id?: string | null } | undefined>;
const THREAD_CHANNEL_TYPES = new Set([10, 11, 12]);

/** A channel directly in `category`, or a thread of one. Never reads the category or anything above it. */
export async function insideCategory(channelId: string, category: string, lookup: ChannelLookup): Promise<boolean> {
  const channel = await lookup(channelId);
  if (channel?.parent_id === category) return true;
  if (!channel?.parent_id || channel.type === undefined || !THREAD_CHANNEL_TYPES.has(channel.type)) return false;
  return (await lookup(channel.parent_id))?.parent_id === category;
}

export interface IncomingMessage extends MessageBody {
  readonly type: number;
  channel_id: string;
  guild_id?: string;
  author: { id: string; username: string; global_name?: string | null; bot?: boolean };
  readonly member?: { readonly nick?: string | null };
  timestamp: string;
  readonly mentions?: readonly { readonly id: string }[];
  readonly referenced_message?: { readonly author: { readonly id: string } } | null;
  readonly webhook_id?: string;
}

export type ParentLookup = (channelId: string) => Promise<string | undefined>;

export interface Inbound {
  readonly channel_policy: ChannelPolicy;
  role: Role;
  scope: "answer-only" | "may-request-work" | "trusted-pr-merge-restart" | "may-report-issue" | "evidence-only";
  message_id: string;
  channel_id: string;
  author_id: string;
  author: string;
  content: string;
  sent_at: string;
  reply_to?: string;
  /** Sent by the same person while Helio was preparing its reply to this message. */
  readonly addition_to?: string;
  attachments: string[];
  /** Direct for DMs and explicit pings only; everything else, replies to Helio included, is reviewed. */
  readonly attention: "direct" | "review";
  /** An explicit `<@Helio>` in the text. A Discord reply-ping is not a ping. */
  readonly pinged?: true;
  readonly replied_to_helio?: true;
  /** Mentions the owner, not Helio: Helio may answer for the owner; it never authorizes Helio actions. */
  readonly for_owner?: true;
}

export function requestMessage(message: Pick<MessageBody, "type">, botReport = false): boolean {
  if (message.type === undefined) throw new TypeError("Discord message type is unavailable");
  return message.type === 0 || message.type === 19 || (botReport && (message.type === 20 || message.type === 23));
}

/** Live intake and replay share the same current channel boundary. */
export async function guildChannelAllowed(channelId: string, cfg: FilterConfig, lookup: ChannelLookup): Promise<boolean> {
  if (cfg.ignoredChannels?.has(channelId) || cfg.blockedChannels?.has(channelId)) return false;
  if (cfg.scopeCategory && !await insideCategory(channelId, cfg.scopeCategory, lookup)) return false;
  const parentOf = async (id: string) => {
    const channel = await lookup(id);
    if (!channel && (cfg.ignoredChannels?.size || cfg.blockedChannels?.size)) {
      throw new TypeError("Current channel ancestry is unavailable; retained pending");
    }
    return channel?.parent_id ?? undefined;
  };
  if (cfg.ignoredChannels?.size && await insideAllowed(channelId, cfg.ignoredChannels, parentOf)) return false;
  if (cfg.blockedChannels?.size && await insideAllowed(channelId, cfg.blockedChannels, parentOf)) return false;
  return insideAllowed(channelId, cfg.allowed, parentOf);
}

export async function classify(
  msg: IncomingMessage,
  cfg: FilterConfig,
  lookup: ChannelLookup,
  onIneligible?: () => void,
): Promise<Inbound | null> {
  if (msg.author.id === cfg.botId || msg.webhook_id !== undefined) return null;

  const isBugReport = bugReport(msg, cfg);
  if (msg.author.id === cfg.bugReportSource?.authorId && !isBugReport) return null;
  if (msg.author.bot && !isBugReport) return null;
  if (!requestMessage(msg, isBugReport)) return null;
  if (msg.guild_id !== undefined && !await guildChannelAllowed(msg.channel_id, cfg, lookup)) return null;
  const parentOf = async (id: string) => (await lookup(id))?.parent_id ?? undefined;

  const isOwner = msg.author.id === cfg.ownerId;
  const isTrusted = cfg.trustedIds?.has(msg.author.id) ?? false;


  if (msg.guild_id === undefined) {
    if (!isOwner && !isTrusted) return null;
  }

  const channelPolicy: ChannelPolicy = msg.guild_id === undefined ? "trusted" :
    await insideAllowed(msg.channel_id, cfg.trustedChannels ?? new Set(), parentOf) ? "trusted" : "normal";
  const { mentioned, additionTo, repliesToHelio, followUp, forOwner } = addressing(msg, cfg, channelPolicy, isBugReport);
  // Unpinged normal-chat input needs a reply to Helio, the person's own working window, or Helio's open question.
  if (channelPolicy === "normal" && !isBugReport && !mentioned && !followUp && !forOwner) {
    onIneligible?.();
    return null;
  }

  const canReport = msg.guild_id !== undefined && cfg.issueReportChannels !== undefined && await insideAllowed(msg.channel_id, cfg.issueReportChannels, parentOf);
  const replyTo = msg.message_reference?.type === 1 ? undefined : msg.message_reference?.message_id;
  // Unknown bot identity must not silently lose a direct request.
  const direct = msg.guild_id === undefined || cfg.botId === undefined || mentioned;

  return {
    channel_policy: channelPolicy,
    role: isBugReport ? "BOT_BUG_REPORT" : isOwner ? "OWNER_REQUEST" : isTrusted ? "TRUSTED_REQUEST" : "STAFF_QUESTION",
    scope: isBugReport ? "evidence-only" : isOwner ? "may-request-work" :
      isTrusted ? "trusted-pr-merge-restart" : canReport ? "may-report-issue" : "answer-only",
    message_id: msg.id,
    channel_id: msg.channel_id,
    author_id: msg.author.id,
    author: msg.member?.nick || msg.author.global_name || msg.author.username,
    content: msg.content,
    sent_at: msg.timestamp,
    reply_to: replyTo,
    ...(additionTo !== undefined ? { addition_to: additionTo } : {}),
    attachments: (msg.attachments ?? []).map((a) => a.url),
    attention: isBugReport || forOwner ? "review" : direct ? "direct" : "review",
    ...(mentioned && !isBugReport ? { pinged: true as const } : {}),
    ...(repliesToHelio && !isBugReport ? { replied_to_helio: true as const } : {}),
    ...(forOwner ? { for_owner: true as const } : {}),
  };
}

const bugReport = (msg: IncomingMessage, cfg: FilterConfig): boolean => msg.author.bot === true &&
  msg.author.id === cfg.bugReportSource?.authorId && msg.channel_id === cfg.bugReportSource.channelId &&
  msg.guild_id !== undefined && cfg.allowed.has(msg.channel_id);

/**
 * How a message is addressed. A ping is an explicit `<@Helio>` mention: Discord also lists a replied-to Helio in
 * `mentions`, so a reply to Helio without the mention text is never a ping. Unpinged follow-ups are replies to Helio, the person's own
 * working window, or an answer Helio's open question is waiting for.
 */
function addressing(msg: IncomingMessage, cfg: FilterConfig, channelPolicy: ChannelPolicy, isBugReport: boolean) {
  const repliesToHelio = cfg.botId !== undefined && msg.message_reference?.type !== 1 && msg.referenced_message?.author.id === cfg.botId;
  const mentioned = cfg.botId !== undefined &&
    (msg.content.includes(`<@${cfg.botId}>`) || msg.content.includes(`<@!${cfg.botId}>`) ||
      (!repliesToHelio && msg.mentions?.some((user) => user.id === cfg.botId) === true));
  const additionTo = isBugReport ? undefined : cfg.workingAnchor?.(msg.channel_id, msg.author.id, msg.id);
  const followUp = channelPolicy === "normal" && !isBugReport && !mentioned &&
    (additionTo !== undefined || repliesToHelio || cfg.awaitingAnswer?.(msg.channel_id, msg.author.id) === true);
  const forOwner = msg.guild_id !== undefined && msg.author.id !== cfg.ownerId && !isBugReport && forTheOwner(msg, cfg, mentioned);
  return { mentioned, additionTo, repliesToHelio, followUp, forOwner };
}

/**
 * Whether catch-up counts a message against its per-channel cap: what classify would admit, judged without
 * channel lookups (the caller knows the channel's policy). Chatter that classify drops never pushes a request out of reach.
 */
export function countsTowardCatchUp(msg: IncomingMessage, cfg: FilterConfig, channelPolicy: ChannelPolicy): boolean {
  if (msg.author.id === cfg.botId || msg.webhook_id !== undefined) return false;
  const isBugReport = bugReport(msg, cfg);
  if (msg.author.bot && !isBugReport) return false;
  if (!requestMessage(msg, isBugReport)) return false;
  if (channelPolicy === "trusted" || isBugReport || cfg.botId === undefined) return true;
  const { mentioned, followUp, forOwner } = addressing(msg, cfg, channelPolicy, false);
  return mentioned || followUp || forOwner;
}

// User mentions only: role and @everyone mentions are not in `mentions`. A message that also pings or
// replies to Helio is addressed to Helio instead.
function forTheOwner(msg: IncomingMessage, cfg: FilterConfig, pingsHelio: boolean): boolean {
  if (cfg.answerForOwner !== true || pingsHelio) return false;
  if (msg.referenced_message?.author.id !== undefined && msg.referenced_message.author.id === cfg.botId) return false;
  const owner = cfg.ownerId;
  if (!msg.mentions?.some((user) => user.id === owner) && !msg.content.includes(`<@${owner}>`) &&
      !msg.content.includes(`<@!${owner}>`)) return false;
  const last = cfg.lastOwnerPost?.(msg.channel_id);
  const at = Date.parse(msg.timestamp);
  return last === undefined || !Number.isFinite(at) || at - last < 0 || at - last >= (cfg.ownerPresentMs ?? 0);
}

const THREAD_CHANNEL_CATEGORY_DEPTH = 3;

export async function insideAllowed(
  channelId: string,
  allowed: ReadonlySet<string>,
  parentOf: ParentLookup,
): Promise<boolean> {
  let current: string | undefined = channelId;
  for (let depth = 0; current !== undefined && depth < THREAD_CHANNEL_CATEGORY_DEPTH; depth++) {
    if (allowed.has(current)) return true;
    current = await parentOf(current);
  }
  return false;
}
