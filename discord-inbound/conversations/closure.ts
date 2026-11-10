import { join } from "node:path";
import { DiscordRestError, type Rest } from "../discord/rest.ts";
import { requireReplyChannel } from "../intake/authorization.ts";
import type { FilterConfig } from "../intake/filter.ts";
import type { Conversation } from "./conversations.ts";
import { findSentReply, sendOnce } from "./reply-once.ts";

/** Only the title, the outcome and the issue link cross audiences; nothing else from the topic is repeated. */
export function closureText(row: Pick<Conversation, "topic" | "outcome" | "issue">): string {
  const title = `**${row.topic.replace(/[*_`~|]/g, "")}**`;
  const number = row.issue ? /\/issues\/(\d+)$/.exec(row.issue)?.[1] : undefined;
  const link = row.issue && number ? `[Issue #${number}](<${row.issue}>)` : undefined;
  switch (row.outcome) {
    case "issue": return link ? `${title} is now tracked in ${link}. I'll ping you when it's live.` : `${title} is now tracked as an issue.`;
    case "declined": case "not-a-bug": case "duplicate": case "irrelevant": case "timed_out":
      return `${title} was closed as ${row.outcome.replace(/[-_]/g, " ")}.${link ? ` ${link}` : ""}`;
    default: return `${title} is resolved.${link ? ` ${link}` : ""}`;
  }
}

export async function closureNotes(o: {
  readonly state: string; readonly rest: Rest; readonly row: Conversation; readonly config: () => FilterConfig;
  readonly groups: readonly { readonly channel: string; readonly target: string; readonly users: readonly string[] }[];
  readonly now: () => number;
}): Promise<string[]> {
  const lines: string[] = [];
  const text = closureText(o.row);
  for (const group of o.groups) {
    await requireReplyChannel(group.channel, o.config(), o.rest);
    const source = await o.rest<{ author: { id: string } }>(`/channels/${group.channel}/messages/${group.target}`).catch(error => {
      if (error instanceof DiscordRestError && error.status === 404) return undefined;
      throw error;
    });
    if (!source) {
      lines.push(`REPLY_CLOSURE_UNDELIVERABLE topic=${o.row.anchor_message_id} channel=${group.channel}: their last message is gone`);
      continue;
    }
    const mentioned = group.users.filter(user => user !== source.author.id).slice(0, 100);
    const content = [...mentioned.map(user => `<@${user}>`), text].join(" ");
    const event = `closure:${o.row.anchor_message_id}:${group.channel}`;
    const sent = await sendOnce({
      path: join(o.state, "reply-sends.sqlite"), target: group.target, text: content, event, now: o.now,
      sleep: (ms) => Bun.sleep(ms), retryUncertain: false,
      findSent: (original, otherReplyIds) => findSentReply(o.rest, { channel_id: group.channel, message_id: group.target, otherReplyIds }, original),
      send: async () => (await o.rest<{ id: string }>(`/channels/${group.channel}/messages`, {
        method: "POST", body: {
          content, message_reference: { type: 0, channel_id: group.channel, message_id: group.target, fail_if_not_exists: true },
          allowed_mentions: { parse: [], replied_user: group.users.includes(source.author.id), users: mentioned },
        },
      })).id,
    });
    lines.push(`REPLY_CLOSURE_SENT topic=${o.row.anchor_message_id} channel=${group.channel} message=${sent.id}`);
  }
  return lines;
}
