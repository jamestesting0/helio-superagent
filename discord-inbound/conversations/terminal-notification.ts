import { Database } from "bun:sqlite";
import { join } from "node:path";
import { DiscordRestError, type Rest } from "../discord/rest.ts";
import { requireReplyChannel } from "../intake/authorization.ts";
import type { FilterConfig } from "../intake/filter.ts";
import { conversationDatabase } from "./conversation-db.ts";
import { findSentReply, sendOnce } from "./reply-once.ts";

interface Subscription {
  readonly status: "open" | "announced" | "done";
  readonly announcement: string | null;
}
interface Group {
  readonly channel_id: string;
  readonly target: string;
  readonly users: string;
  readonly reply_id: string | null;
  readonly disposition: string | null;
}
export interface GroupOutcome { readonly channel_id: string; readonly disposition: "sent" | "undeliverable"; readonly reply_id?: string }

export class NotificationUndeliverable extends Error {}

export function terminalEvent(repo: string, issue: number, topic: string, channel: string): string {
  return "followup:" + new Bun.CryptoHasher("sha256").update(JSON.stringify([repo, issue, topic, channel])).digest("hex");
}

/**
 * Tells everyone in a topic about its issue's terminal outcome: one message per channel where participants last
 * spoke, replying to the newest of their messages there and mentioning the rest. The first computation of each
 * channel group is stored, so a retry reuses its target and recipients and never posts a second message.
 */
export async function terminalNotification(o: {
  readonly state: string; readonly repo: string; readonly issue: number; readonly topic: string;
  readonly text: string; readonly rest: Rest; readonly config: () => FilterConfig; readonly now: () => number;
}): Promise<GroupOutcome[]> {
  if (!o.text.trim() || o.text.length > 1800) throw new RangeError("Terminal notification must contain 1-1800 characters");
  const path = join(o.state, "discord-conversations.sqlite");
  conversationDatabase(path, o.now(), 1000).close();
  const db = new Database(path);
  try {
    db.exec("PRAGMA busy_timeout=1000");
    const key = [o.repo, o.issue, o.topic] as const;
    const row = db.query<Subscription, [string, number, string]>(
      "SELECT status,announcement FROM followups WHERE repo=? AND issue=? AND anchor_message_id=?").get(...key);
    if (!row) throw new RangeError("Unknown topic subscription");
    const event = row.announcement ? JSON.parse(row.announcement) as { event?: string } : undefined;
    if (row.status !== "done" && (row.status !== "announced" ||
        !["FOLLOWUP_LIVE", "FOLLOWUP_DONE", "FOLLOWUP_DECLINED"].includes(event?.event ?? ""))) {
      throw new RangeError("Subscription has no terminal observation");
    }
    const blocked = (user: string) => {
      const delivery = new Database(join(o.state, "discord-delivery.sqlite"), { readonly: true, create: false });
      try { return delivery.query("SELECT 1 FROM blocked_users WHERE user_id=?").get(user) !== null; }
      finally { delivery.close(); }
    };
    if (row.status !== "done") {
      const people = db.query<{ user_id: string; last_channel_id: string; last_message_id: string }, [string]>(
        "SELECT user_id,last_channel_id,last_message_id FROM topic_participants WHERE anchor_message_id=? AND notify=1 ORDER BY user_id")
        .all(o.topic).filter(person => !blocked(person.user_id));
      const byChannel = Map.groupBy(people, person => person.last_channel_id);
      for (const [channel, members] of byChannel) {
        const target = members.map(member => member.last_message_id).reduce((a, b) => BigInt(a) > BigInt(b) ? a : b);
        db.run("INSERT OR IGNORE INTO followup_groups (repo,issue,anchor_message_id,channel_id,target,users) VALUES (?,?,?,?,?,?)",
          [...key, channel, target, JSON.stringify(members.map(member => member.user_id))]);
      }
    }
    const groups = db.query<Group, [string, number, string]>(
      "SELECT channel_id,target,users,reply_id,disposition FROM followup_groups WHERE repo=? AND issue=? AND anchor_message_id=? ORDER BY channel_id")
      .all(...key);
    const outcomes: GroupOutcome[] = [];
    for (const group of groups) {
      if (group.disposition) {
        outcomes.push({ channel_id: group.channel_id, disposition: group.disposition as GroupOutcome["disposition"],
          ...(group.reply_id ? { reply_id: group.reply_id } : {}) });
        continue;
      }
      const settle = (disposition: GroupOutcome["disposition"], replyId?: string) => {
        db.run(`UPDATE followup_groups SET disposition=?,reply_id=? WHERE repo=? AND issue=? AND anchor_message_id=? AND channel_id=?`,
          [disposition, replyId ?? null, ...key, group.channel_id]);
        outcomes.push({ channel_id: group.channel_id, disposition, ...(replyId ? { reply_id: replyId } : {}) });
      };
      const users: string[] = JSON.parse(group.users).filter((user: string) => !blocked(user));
      await requireReplyChannel(group.channel_id, o.config(), o.rest);
      const source = await o.rest<{ id: string; channel_id: string; author: { id: string } }>(
        `/channels/${group.channel_id}/messages/${group.target}`).catch(error => {
          if (error instanceof DiscordRestError && error.status === 404) return undefined;
          throw error;
        });
      if (!source || !users.length) { settle("undeliverable"); continue; }
      const mentioned = users.filter(user => user !== source.author.id);
      const content = [...mentioned.map(user => `<@${user}>`), o.text].join(" ");
      const identity = terminalEvent(o.repo, o.issue, o.topic, group.channel_id);
      const sent = await sendOnce({
        path: join(o.state, "reply-sends.sqlite"), target: group.target, text: content, event: identity, now: o.now,
        notification: { channel: group.channel_id, nonce: identity.slice(-25) },
        sleep: async () => { throw new Error("Terminal delivery cannot wait for another sender"); },
        waitForOther: false, retryUncertain: false,
        definitiveFailure: error => error instanceof RangeError ||
          error instanceof DiscordRestError && [400, 403, 404, 429].includes(error.status),
        findSent: (text, otherReplyIds) => findSentReply(o.rest,
          { channel_id: group.channel_id, message_id: group.target, otherReplyIds }, text),
        send: async () => {
          await requireReplyChannel(group.channel_id, o.config(), o.rest);
          const reply = await o.rest<{ id: string }>(`/channels/${group.channel_id}/messages`, {
            method: "POST", body: {
              content, nonce: identity.slice(-25), enforce_nonce: true,
              message_reference: { type: 0, channel_id: group.channel_id, message_id: group.target, fail_if_not_exists: true },
              allowed_mentions: { parse: [], replied_user: users.includes(source.author.id), users: mentioned.slice(0, 100) },
            },
          });
          if (!/^\d+$/.test(reply.id)) throw new TypeError("Terminal send returned no verified reply ID");
          return reply.id;
        },
      });
      settle("sent", sent.id);
    }
    if (groups.length && outcomes.length === groups.length) {
      db.run("UPDATE followups SET status='done' WHERE repo=? AND issue=? AND anchor_message_id=?", [...key]);
    }
    if (!groups.length) {
      db.run("UPDATE followups SET status='done' WHERE repo=? AND issue=? AND anchor_message_id=?", [...key]);
      throw new NotificationUndeliverable("The topic has no participant left to notify");
    }
    return outcomes;
  } finally { db.close(); }
}
