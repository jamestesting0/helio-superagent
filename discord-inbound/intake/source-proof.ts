import { guildChannelAllowed, requestMessage, type FilterConfig } from "./filter.ts";
import type { ApiChannel, Rest } from "../discord/rest.ts";
import { object } from "../delivery/monitor-summary.ts";

/** Historical identity evidence only: this does not grant work, merge or restart authority. */
export async function inspectJobSource(source: string, job: string, cfg: FilterConfig, rest: Rest, policy: string) {
  const match = /^discord:([0-9]{1,30}):([0-9]{1,30})$/.exec(source);
  if (!match?.[1] || !match[2] || !/^issue-[1-9]\d*$/.test(job)) throw new TypeError("Expected exact historical Discord source and issue-N");
  const [, channelId, messageId] = match;
  if (cfg.ignoredChannels?.has(channelId)) throw new RangeError("Historical source channel is ignored");
  const channel = await rest<ApiChannel>(`/channels/${channelId}`);
  const lookup = (id: string) => id === channelId ? Promise.resolve(channel) : rest<ApiChannel>(`/channels/${id}`);
  if (channel.guild_id && !await guildChannelAllowed(channelId, cfg, lookup)) throw new RangeError("Historical source channel is outside current policy");
  const sourceMessage = object(await rest(`/channels/${channelId}/messages/${messageId}`));
  const author = object(sourceMessage.author);
  if (sourceMessage.id !== messageId || sourceMessage.channel_id !== channelId || author.bot === true || sourceMessage.webhook_id ||
      typeof sourceMessage.type !== "number" || !requestMessage({ type: sourceMessage.type }) ||
      typeof sourceMessage.content !== "string" || typeof author.id !== "string") throw new TypeError("Historical source identity is unavailable");
  const role = author.id === cfg.ownerId ? "OWNER_REQUEST" : cfg.trustedIds?.has(author.id) ? "TRUSTED_REQUEST" : undefined;
  if (!role) throw new RangeError("Historical source author is not currently owner or trusted");
  let parent: Record<string, unknown> | undefined;
  if (sourceMessage.message_reference !== undefined) {
    const reference = object(sourceMessage.message_reference);
    if (reference.type === 1 || (reference.channel_id !== undefined && reference.channel_id !== channelId)) {
      throw new RangeError("Forwarded or cross-channel evidence cannot identify a task request");
    }
    if (typeof reference.message_id !== "string" || !/^\d{1,30}$/.test(reference.message_id)) throw new TypeError("Invalid source reply identity");
    parent = object(await rest(`/channels/${channelId}/messages/${reference.message_id}`));
    const me = await rest<{ id: string }>("/users/@me");
    if (parent.id !== reference.message_id || parent.channel_id !== channelId || object(parent.author).id !== me.id) {
      throw new RangeError("Historical source does not reply to this bot in the same channel");
    }
  }
  const sourceDigest = new Bun.CryptoHasher("sha256").update(JSON.stringify({ sourceMessage, parent, policy })).digest("hex");
  return { version: 1, purpose: "historical-job-identity", job, source_ref: source,
    author_id: author.id, role, source_digest: sourceDigest };
}
