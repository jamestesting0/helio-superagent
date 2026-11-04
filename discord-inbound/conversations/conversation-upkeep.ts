import type { Conversation, Conversations } from "./conversations.ts";
import { CONVERSATION_MAX_IDLE_MS, DAY_MS } from "./conversations.ts";
import { monitorLine } from "../delivery/monitor-summary.ts";
import { DiscordRestError, type Rest } from "../discord/rest.ts";

/** Courtesy messages are sent outside SQLite transactions and never count as conversation activity. */
export async function sweepConversations(options: {
  readonly store: Conversations;
  readonly rest: Rest;
  readonly now: number;
  readonly emit: (line: string) => void;
  readonly canContact: (row: Conversation, guild: string | undefined) => Promise<boolean>;
}): Promise<void> {
  const { store, rest, now, emit } = options;
  for (const row of store.list()) {
    try {
      const channel = await rest<{ guild_id?: string }>(`/channels/${row.channel_id}`);
      if (!await options.canContact(row, channel.guild_id)) continue;
      await rest(`/channels/${row.channel_id}/messages/${row.anchor_message_id}`);
      if (channel.guild_id) await rest(`/guilds/${channel.guild_id}/members/${row.user_id}`);
      if (store.state(row) !== "waiting_on_requester") continue;
      const idle = now - row.last_activity;
      const closing = idle >= CONVERSATION_MAX_IDLE_MS;
      if (!closing && (idle < DAY_MS || row.nudged_at !== null)) continue;
      const latest = store.get(row.channel_id, row.user_id);
      if (!latest || latest.opened_at !== row.opened_at || latest.last_activity !== row.last_activity ||
          store.state(latest) !== "waiting_on_requester") continue;
      const last = store.transcript(row.channel_id, row.user_id).findLast((entry) => entry.author_id === row.user_id);
      const target = last?.message_id ?? row.anchor_message_id;
      // A deleted last requester message follows the same silent resolution path as a deleted anchor.
      if (target !== row.anchor_message_id) await rest(`/channels/${row.channel_id}/messages/${target}`);
      const reply = await rest<{ id: string }>(`/channels/${row.channel_id}/messages`, {
        method: "POST", body: {
          content: closing ? "I'll drop this request for now as I haven't heard back. Ping me when you're ready to pick it up again." :
            "Do you still need help with this request? Send the details when you're ready.",
          message_reference: { message_id: target, channel_id: row.channel_id, fail_if_not_exists: true },
          allowed_mentions: { parse: [], replied_user: true },
        },
      });
      store.recordNotice(reply.id, now);
      if (closing) store.resolveIfCurrent(row, "timed_out", now);
      else store.markNudged(row, now);
      emit(monitorLine(`${closing ? "INBOUND_CONVERSATION_TIMEOUT" : "INBOUND_CONVERSATION_NUDGE"} ${JSON.stringify({
        channel_id: row.channel_id, user_id: row.user_id, anchor_message_id: row.anchor_message_id,
        topic: row.topic, opened_at: row.opened_at, sent: reply.id,
        read: `helio conversation show ${row.channel_id} ${row.user_id}`,
      })}`));
    } catch (error) {
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
      read: `helio conversation show ${row.channel_id} ${row.user_id}`,
    })}`));
  }
  store.retain(now);
}
