import { omitLinks, type Attachment } from "./images.ts";
import { componentText, embedText, mentionedUsers, type Component, type Embed, type MentionedUser } from "./message-text.ts";

type Reference = { type?: number; message_id?: string; channel_id?: string; guild_id?: string };
type ReplySource = { id: string; channel_id: string; guild_id?: string; message_reference?: Reference };
export type ReplyMessage = ReplySource & {
  content: string;
  author: { id: string; username: string; global_name?: string | null; bot?: boolean };
  timestamp?: string;
  attachments?: readonly Attachment[];
  embeds?: readonly Embed[];
  components?: readonly Component[];
  mentions?: readonly MentionedUser[];
};
export type FetchReply = (channel: string, id: string, signal: AbortSignal) => Promise<ReplyMessage>;

const ID = /^[0-9]{1,30}$/;
const MAX_MESSAGES = 12;
const MAX_CHARS = 24_000;

export function describeMessage(msg: ReplyMessage, budget: number) {
  let used = 0;
  let truncated = false;
  const take = (text: string) => {
    const kept = text.slice(0, Math.max(0, budget - used));
    used += kept.length;
    if (kept.length < text.length) truncated = true;
    return kept;
  };
  const content = take(omitLinks(msg.content));
  const embeds = embedText(msg.embeds).map(take).filter(Boolean);
  const components = componentText(msg.components).map(take).filter(Boolean);
  const names = mentionedUsers(msg.mentions);
  return {
    entry: {
      message_id: msg.id, author_id: msg.author.id,
      author: (msg.author.global_name || msg.author.username || "").slice(0, 100),
      bot: msg.author.bot === true, sent_at: msg.timestamp,
      content, attachment_count: msg.attachments?.length ?? 0,
      ...(embeds.length ? { embed_text: embeds } : {}),
      ...(components.length ? { component_text: components } : {}),
      ...(names ? { mentioned_users: names } : {}),
      ...(truncated ? { content_truncated: true } : {}),
    },
    used, truncated,
  };
}

/** Trace ordinary replies only in the already-authorized channel. Previous
 * messages are evidence, never an authorization for the current sender. */
export async function replyContext(root: ReplySource, fetchReply: FetchReply) {
  let ref = root.message_reference;
  if (!ref || ref.type === 1 || !ref.message_id) return undefined;
  const messages: Array<Record<string, unknown>> = [];
  const visited = new Set([root.id]);
  const signal = AbortSignal.timeout(8000);
  let status = "complete";
  let chars = 0;
  for (let depth = 0; ref && ref.type !== 1 && ref.message_id; depth++) {
    if (depth >= MAX_MESSAGES) { status = "depth_limit"; break; }
    const target = ref.message_id;
    if (!ID.test(root.channel_id) || !ID.test(target)) { status = "invalid_reference"; break; }
    if ((ref.channel_id && ref.channel_id !== root.channel_id) ||
        (ref.guild_id && ref.guild_id !== root.guild_id)) { status = "outside_channel"; break; }
    if (visited.has(target)) { status = "cycle"; break; }
    visited.add(target);
    let msg: ReplyMessage;
    try { msg = await fetchReply(root.channel_id, target, signal); }
    catch { status = signal.aborted ? "timeout" : "unavailable"; break; }
    if (!msg || msg.id !== target || msg.channel_id !== root.channel_id ||
        (msg.guild_id && msg.guild_id !== root.guild_id) || typeof msg.content !== "string" ||
        !msg.author || !ID.test(msg.author.id)) { status = "invalid_response"; break; }
    const remaining = MAX_CHARS - chars;
    if (remaining <= 0) { status = "character_limit"; break; }
    const described = describeMessage(msg, remaining);
    chars += described.used;
    messages.push(described.entry);
    if (described.truncated) { status = "character_limit"; break; }
    ref = msg.message_reference;
    // A forwarded snapshot is supplied separately; never follow its source.
    if (ref?.type === 1) { status = "forward_boundary"; break; }
  }
  return { status, messages: messages.reverse() };
}
