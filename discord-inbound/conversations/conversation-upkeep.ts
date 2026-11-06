import type { Conversation, Conversations } from "./conversations.ts";
import { CONVERSATION_MAX_IDLE_MS, DAY_MS } from "./conversations.ts";
import { monitorLine } from "../delivery/monitor-summary.ts";
import { DiscordRestError, IgnoredChannelError, type Rest } from "../discord/rest.ts";
import type { NoticeIntent } from "./notice-store.ts";

/** Missing history or nonce means unknown delivery, never permission for a second POST. */
async function findNotice(rest: Rest, intent: NoticeIntent): Promise<string | undefined> {
  const me = await rest<{ id: string }>("/users/@me");
  let after = intent.target_id;
  for (let page = 0; page < 10; page++) {
    const messages = await rest<{ id: string; nonce?: string | number; author: { id: string } }[]>(
      `/channels/${intent.channel_id}/messages?after=${after}&limit=100`);
    const found = messages.find(message => message.author.id === me.id && String(message.nonce) === intent.nonce);
    if (found) return found.id;
    if (messages.length < 100) return undefined;
    after = messages.map(message => message.id).reduce((a, b) => BigInt(a) > BigInt(b) ? a : b);
  }
  return undefined;
}

/** Courtesy messages are sent outside SQLite transactions and never count as conversation activity. */
export async function sweepConversations(options: {
  readonly store: Conversations;
  readonly rest: Rest;
  readonly now: number;
  readonly emit: (line: string) => void;
  readonly canContact: (row: Conversation, guild: string | undefined) => Promise<boolean>;
  readonly hasNewInput?: (row: Conversation) => boolean;
}): Promise<void> {
  const { store, rest, now, emit } = options;
  for (const row of store.list()) {
    if (store.state(row) !== "waiting_on_requester" || row.question_started_at === null || options.hasNewInput?.(row)) continue;
    const idle = now - row.question_started_at;
    const closing = idle >= CONVERSATION_MAX_IDLE_MS;
    if (!closing && (idle < DAY_MS || row.nudged_at !== null)) continue;
    let intent: NoticeIntent | undefined;
    try {
      const channel = await rest<{ guild_id?: string }>(`/channels/${row.channel_id}`);
      if (!await options.canContact(row, channel.guild_id)) continue;
      await rest(`/channels/${row.channel_id}/messages/${row.anchor_message_id}`);
      if (channel.guild_id) await rest(`/guilds/${channel.guild_id}/members/${row.user_id}`);
      const last = store.transcriptOf(row).findLast((entry) => entry.author_id === row.user_id);
      const target = last?.message_id ?? row.anchor_message_id;
      // A deleted last requester message follows the same silent resolution path as a deleted anchor.
      if (target !== row.anchor_message_id) await rest(`/channels/${row.channel_id}/messages/${target}`);
      const claim = store.notices.claim(row, closing ? "timeout" : "nudge", target, now);
      if (!claim) continue;
      intent = claim.intent;
      if (intent.state === "cancelled" || intent.settled) continue;
      if (!claim.mine) {
        const existing = intent.message_id ?? await findNotice(rest, intent);
        if (!existing) continue;
        intent = store.notices.complete(intent, existing, now);
      } else {
      if (!await options.canContact(row, channel.guild_id) || !store.notices.current(intent) || options.hasNewInput?.(row)) {
        store.notices.cancel(intent);
        continue;
      }
      const reply = await rest<{ id: string }>(`/channels/${row.channel_id}/messages`, {
        method: "POST", body: {
          content: closing ? "I'll drop this request for now as I haven't heard back. Ping me when you're ready to pick it up again." :
            "Do you still need help with this request? Send the details when you're ready.",
          message_reference: { message_id: target, channel_id: row.channel_id, fail_if_not_exists: true },
          allowed_mentions: { parse: [], replied_user: true },
          nonce: intent.nonce, enforce_nonce: true,
        },
      });
      intent = store.notices.complete(intent, reply.id, now);
      }
      const latest = store.get(row.channel_id, row.user_id, row.anchor_message_id);
      if (latest && await options.canContact(latest, channel.guild_id) && !options.hasNewInput?.(latest)) {
        store.settleNotice(intent, now);
      }
      emit(monitorLine(`${closing ? "INBOUND_CONVERSATION_TIMEOUT" : "INBOUND_CONVERSATION_NUDGE"} ${JSON.stringify({
        channel_id: row.channel_id, user_id: row.user_id, anchor_message_id: row.anchor_message_id,
        topic: row.topic, opened_at: row.opened_at, sent: intent.message_id,
        read: `helio conversation show ${row.channel_id} ${row.user_id} --topic ${row.anchor_message_id}`,
      })}`));
    } catch (error) {
      if (intent) store.notices.uncertain(intent);
      if (error instanceof IgnoredChannelError) continue;
      if (error instanceof DiscordRestError && error.status === 404) {
        store.resolveIfCurrent(row, "other", now);
        continue;
      }
      if (!(error instanceof Error)) throw error;
      emit(monitorLine(`INBOUND_WARN conversation upkeep channel=${row.channel_id} user=${row.user_id}: ${error.message}`));
    }
  }
  for (const row of store.dailyWaiting(now)) {
    emit(monitorLine(`INBOUND_CONVERSATION_WAITING ${JSON.stringify({
      channel_id: row.channel_id, user_id: row.user_id, topic: row.topic,
      state: "waiting_on_helio", idle_ms: now - row.last_activity,
      read: `helio conversation show ${row.channel_id} ${row.user_id} --topic ${row.anchor_message_id}`,
    })}`));
  }
  store.retain(now);
}
