import type { Conversations } from "../conversations/conversations.ts";
import { finishWorking } from "../conversations/working.ts";
import { DiscordRestError, type Rest } from "../discord/rest.ts";
import { cleanupAttachments } from "../messages/images.ts";
import type { BlockResult, Delivery } from "./delivery.ts";
import type { StrikeEvidence } from "./moderation.ts";

export const NO_ENTRY = "%F0%9F%9A%AB";
export const HOURGLASS = "%E2%8F%B3";

export async function react(rest: Rest, channel: string, message: string, emoji: string,
  warn: (message: string) => void): Promise<boolean> {
  try {
    await rest(`/channels/${channel}/messages/${message}/reactions/${emoji}/@me`, { method: "PUT", retryRateLimit: false });
    return true;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    // A deleted message or a channel without reaction permission can never take the marker.
    if (error instanceof DiscordRestError && (error.status === 403 || error.status === 404)) return true;
    warn(`reaction deferred channel=${channel} message_id=${message}: ${error.message}`);
    return false;
  }
}

export async function reactPendingBlocks(delivery: Delivery, rest: Rest, warn: (message: string) => void): Promise<void> {
  for (const row of delivery.moderation.pendingReactions()) {
    if (await react(rest, row.channel_id, row.message_id, NO_ENTRY, warn)) delivery.moderation.reacted(row.user_id);
  }
}

/** An automatic block's strikes as message links for the owner's review; a channel that cannot be looked up keeps its IDs. */
export async function strikeLinks(evidence: readonly StrikeEvidence[], guildOf: (channelId: string) => Promise<string | undefined>):
  Promise<{ readonly link: string; readonly reason: string }[]> {
  return Promise.all(evidence.map(async (strike) => {
    let guild: string | undefined;
    try { guild = await guildOf(strike.channel_id); }
    catch (error) { if (!(error instanceof Error)) throw error; }
    return { link: guild ? `https://discord.com/channels/${guild}/${strike.channel_id}/${strike.message_id}` : `channel ${strike.channel_id} message ${strike.message_id}`, reason: strike.reason };
  }));
}

/** Finishes everything Helio still held for a newly blocked user; network calls run after the block committed. */
export async function settleBlock(o: {
  readonly delivery: Delivery; readonly conversations: Conversations; readonly rest?: Rest;
  readonly stateDir: string; readonly warn: (message: string) => void;
}, userId: string, result: BlockResult): Promise<void> {
  const now = Date.now();
  for (const id of result.dismissed) await cleanupAttachments(id, `${o.stateDir}/attachments/inbound`);
  for (const row of o.conversations.list().filter((conversation) => conversation.user_id === userId)) {
    o.conversations.close(row.channel_id, row.user_id, "irrelevant", now, undefined, row.anchor_message_id);
  }
  const claims = o.conversations.openWorkingRows().filter((row) => row.user_id === userId && row.closed_at === null);
  await finishWorking({ store: o.conversations, rest: o.rest, now, warn: o.warn },
    [...result.dismissed, ...claims.map((row) => row.message_id)]);
  if (o.rest) await reactPendingBlocks(o.delivery, o.rest, o.warn);
}

/** A block is the durable target state; replaying settlement repairs a crash between the two databases. */
export async function reconcileBlocks(o: Parameters<typeof settleBlock>[0]): Promise<void> {
  for (const row of o.delivery.moderation.list()) {
    await settleBlock(o, row.user_id, { dismissed: [] });
  }
}
