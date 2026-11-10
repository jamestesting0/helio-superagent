import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DiscordRestError, type Rest } from "../discord/rest.ts";
import { requireReplyChannel } from "../intake/authorization.ts";
import type { FilterConfig } from "../intake/filter.ts";
import { findSentReply, sendOnce } from "./reply-once.ts";

interface Subscription {
  readonly channel_id: string;
  readonly reply_to: string;
  readonly status: "open" | "announced" | "done";
  readonly announcement: string | null;
  readonly delivery_version: number;
  readonly delivered_reply_id: string | null;
}

export class NotificationUndeliverable extends Error {}

export function terminalEvent(repo: string, issue: number, user: string, channel: string, target: string): string {
  return "followup:" + new Bun.CryptoHasher("sha256").update(JSON.stringify([repo, issue, user, channel, target])).digest("hex");
}

/** This boundary owns only subscription/send receipts; conversation settlement is deliberately absent. */
export async function terminalNotification(o: {
  readonly state: string; readonly repo: string; readonly issue: number; readonly user: string;
  readonly text: string; readonly rest: Rest; readonly config: () => FilterConfig; readonly now: () => number;
}): Promise<string> {
  const db = new Database(join(o.state, "discord-conversations.sqlite"), { create: false });
  try {
    db.exec("PRAGMA busy_timeout=1000");
    const subscription = () => db.query<Subscription, [string, number, string]>(
      "SELECT * FROM followups WHERE repo=? AND issue=? AND user_id=?").get(o.repo, o.issue, o.user);
    const row = subscription();
    if (!row) throw new RangeError("Unknown terminal subscription");
    if (row.status === "done") return row.delivered_reply_id ?? "";
    const event = row.announcement ? JSON.parse(row.announcement) as { event?: string } : undefined;
    if (row.status !== "announced" || !["FOLLOWUP_LIVE", "FOLLOWUP_DONE", "FOLLOWUP_DECLINED"].includes(event?.event ?? "")) {
      throw new RangeError("Subscription has no terminal observation");
    }
    if (!o.text.trim() || o.text.length > 2000) throw new RangeError("Terminal notification must contain 1-2000 characters");
    const identity = terminalEvent(o.repo, o.issue, o.user, row.channel_id, row.reply_to);
    const nonce = identity.slice(-25);
    const sendsPath = join(o.state, "reply-sends.sqlite");
    if (row.delivery_version !== 1) {
      let known = false;
      if (existsSync(sendsPath)) {
        const sends = new Database(sendsPath, { readonly: true });
        try {
          if (sends.query("SELECT 1 FROM sqlite_master WHERE name='reply_sends'").get()) {
            known = sends.query("SELECT 1 FROM reply_sends WHERE target=? AND text_hash=?")
              .get(row.reply_to, `event:${identity}`) !== null;
          }
        } finally { sends.close(); }
      }
      if (!known) throw new Error("Legacy terminal delivery is unproved; retained uncertain without a new send identity");
    }
    const verify = async () => {
      await requireReplyChannel(row.channel_id, o.config(), o.rest);
      const source = await o.rest<{ id: string; channel_id: string; author: { id: string; bot?: boolean } }>(
        `/channels/${row.channel_id}/messages/${row.reply_to}`).catch(error => {
          if (!(error instanceof DiscordRestError) || error.status !== 404) throw error;
          db.run("UPDATE followups SET status='done',delivery_disposition='undeliverable' WHERE repo=? AND issue=? AND user_id=?",
            [o.repo, o.issue, o.user]);
          throw new NotificationUndeliverable("The original target was deleted; tell the owner once");
        });
      if (source.id !== row.reply_to || source.channel_id !== row.channel_id ||
          source.author.id !== o.user || source.author.bot) throw new RangeError("Terminal target identity does not match its subscriber");
      const delivery = new Database(join(o.state, "discord-delivery.sqlite"), { readonly: true });
      try {
        if (delivery.query("SELECT 1 FROM blocked_users WHERE user_id=?").get(o.user)) {
          throw new RangeError("Subscriber is blocked by current policy");
        }
      } finally { delivery.close(); }
      await requireReplyChannel(row.channel_id, o.config(), o.rest);
      const current = subscription();
      if (!current || current.status !== row.status || current.channel_id !== row.channel_id ||
          current.reply_to !== row.reply_to || current.announcement !== row.announcement) {
        throw new RangeError("Terminal subscription changed during verification");
      }
    };
    await verify();
    const sent = await sendOnce({
      path: sendsPath, target: row.reply_to, text: o.text, event: identity, now: o.now,
      notification: { channel: row.channel_id, nonce },
      sleep: async () => { throw new Error("Terminal delivery cannot wait for another sender"); },
      waitForOther: false, retryUncertain: false,
      definitiveFailure: error => error instanceof RangeError || error instanceof NotificationUndeliverable ||
        error instanceof DiscordRestError && [400, 403, 404, 429].includes(error.status),
      findSent: (text, otherReplyIds) => findSentReply(o.rest,
        { channel_id: row.channel_id, message_id: row.reply_to, otherReplyIds }, text),
      send: async () => {
        await verify();
        const reply = await o.rest<{ id: string }>(`/channels/${row.channel_id}/messages`, {
          method: "POST", body: {
            content: o.text, nonce, enforce_nonce: true, message_reference: { type: 0, channel_id: row.channel_id,
              message_id: row.reply_to, fail_if_not_exists: true },
            allowed_mentions: { parse: [], replied_user: true, users: [o.user] },
          },
        });
        if (!/^\d+$/.test(reply.id)) throw new TypeError("Terminal send returned no verified reply ID");
        return reply.id;
      },
    });
    if (!/^\d+$/.test(sent.id)) throw new TypeError("Terminal receipt has no verified reply ID");
    db.run("UPDATE followups SET status='done',delivered_reply_id=?,delivery_disposition='sent' WHERE repo=? AND issue=? AND user_id=?",
      [sent.id, o.repo, o.issue, o.user]);
    return sent.id;
  } finally { db.close(); }
}
