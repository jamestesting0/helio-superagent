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
  readonly inConversation?: (channelId: string, userId: string) => boolean;
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
  channel_id: string;
  guild_id?: string;
  author: { id: string; username: string; global_name?: string | null; bot?: boolean };
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
  readonly attention: "direct" | "review";
  /** A top-level mention; attention also includes DMs and unresolved replies, so it cannot identify pings. */
  readonly pinged?: true;
  /** Mentions the owner, not Helio: Helio may answer for the owner; it never authorizes Helio actions. */
  readonly for_owner?: true;
}

export async function classify(
  msg: IncomingMessage,
  cfg: FilterConfig,
  parentOf: ParentLookup,
  onIneligible?: () => void,
): Promise<Inbound | null> {
  if (msg.author.id === cfg.botId || msg.webhook_id !== undefined) return null;
  if (msg.guild_id !== undefined && cfg.blockedChannels?.size &&
      await insideAllowed(msg.channel_id, cfg.blockedChannels, parentOf)) return null;

  const isBugReport = msg.author.bot === true &&
    msg.author.id === cfg.bugReportSource?.authorId &&
    msg.channel_id === cfg.bugReportSource.channelId &&
    msg.guild_id !== undefined && cfg.allowed.has(msg.channel_id);
  if (msg.author.id === cfg.bugReportSource?.authorId && !isBugReport) return null;
  if (msg.author.bot && !isBugReport) return null;

  const isOwner = msg.author.id === cfg.ownerId;
  const isTrusted = cfg.trustedIds?.has(msg.author.id) ?? false;


  if (msg.guild_id === undefined) {
    if (!isOwner && !isTrusted) return null;
  } else {
    // Channel IDs are globally unique, so the allowlist alone pins the server.
    if (!(await insideAllowed(msg.channel_id, cfg.allowed, parentOf))) return null;
  }

  const channelPolicy: ChannelPolicy = msg.guild_id === undefined ? "trusted" :
    await insideAllowed(msg.channel_id, cfg.trustedChannels ?? new Set(), parentOf) ? "trusted" : "normal";
  const mentioned = cfg.botId !== undefined && (
    msg.mentions?.some((user) => user.id === cfg.botId) ||
    msg.content.includes(`<@${cfg.botId}>`) || msg.content.includes(`<@!${cfg.botId}>`)
  );
  const additionTo = isBugReport ? undefined : cfg.workingAnchor?.(msg.channel_id, msg.author.id, msg.id);
  const conversationFollowup = channelPolicy === "normal" && !isBugReport && !mentioned &&
    (additionTo !== undefined || cfg.inConversation?.(msg.channel_id, msg.author.id) === true);
  const forOwner = msg.guild_id !== undefined && !isOwner && !isBugReport && forTheOwner(msg, cfg, mentioned === true);
  // Open conversations and working windows admit only their owner's follow-ups in this exact channel.
  if (channelPolicy === "normal" && !isBugReport && !mentioned && !conversationFollowup && !forOwner) {
    onIneligible?.();
    return null;
  }

  const canReport = msg.guild_id !== undefined && cfg.issueReportChannels !== undefined && await insideAllowed(msg.channel_id, cfg.issueReportChannels, parentOf);
  const replyTo = msg.message_reference?.type === 1 ? undefined : msg.message_reference?.message_id;
  // Unresolved replies and unknown bot identity must not silently lose a direct request.
  const direct = msg.guild_id === undefined || cfg.botId === undefined ||
    msg.mentions?.some((user) => user.id === cfg.botId) ||
    msg.content.includes(`<@${cfg.botId}>`) || msg.content.includes(`<@!${cfg.botId}>`) ||
    (replyTo !== undefined && (msg.referenced_message == null || msg.referenced_message.author.id === cfg.botId));

  return {
    channel_policy: channelPolicy,
    role: isBugReport ? "BOT_BUG_REPORT" : isOwner ? "OWNER_REQUEST" : isTrusted ? "TRUSTED_REQUEST" : "STAFF_QUESTION",
    scope: isBugReport ? "evidence-only" : isOwner ? "may-request-work" :
      isTrusted ? "trusted-pr-merge-restart" : canReport ? "may-report-issue" : "answer-only",
    message_id: msg.id,
    channel_id: msg.channel_id,
    author_id: msg.author.id,
    author: msg.author.global_name ?? msg.author.username,
    content: msg.content,
    sent_at: msg.timestamp,
    reply_to: replyTo,
    ...(additionTo !== undefined ? { addition_to: additionTo } : {}),
    attachments: (msg.attachments ?? []).map((a) => a.url),
    attention: isBugReport || conversationFollowup || forOwner ? "review" : direct ? "direct" : "review",
    ...(mentioned && !isBugReport ? { pinged: true as const } : {}),
    ...(forOwner ? { for_owner: true as const } : {}),
  };
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
