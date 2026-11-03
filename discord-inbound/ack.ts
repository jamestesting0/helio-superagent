import { Delivery } from "./delivery.ts";
import { cleanupAttachments } from "./images.ts";
import { filterConfig, reauthorize, validateChannelPolicy } from "./authorization.ts";
import { cachedReads, discordRest } from "./rest.ts";
import { sweepExpired } from "./expiry.ts";
import { contextReplayAllowed } from "./context-replay.ts";
import { Conversations } from "./conversations.ts";
import { addEyes, finishWorking } from "./working.ts";

const [action, stream, id, reason, ...extra] = process.argv.slice(2);
const state = process.env.DORI_STATE_DIR;
if (!state || (stream !== "inbound" && stream !== "context") ||
    (action !== "pending" && action !== "done" && action !== "irrelevant" && action !== "status" &&
      action !== "accept" && action !== "check" && action !== "working") ||
    ((action === "accept" || action === "check" || action === "working") && stream !== "inbound") ||
    (action !== "pending" && (!id || !/^[0-9]{1,30}$/.test(id))) ||
    (action === "pending" && id !== undefined) || extra.length ||
    (action === "irrelevant" ? stream !== "inbound" || !reason?.trim() || reason.length > 500 : reason !== undefined)) {
  console.error("Usage: ack pending inbound|context OR ack done|status inbound|context <message_id> OR ack accept|check|working inbound <message_id> OR ack irrelevant inbound <message_id> <reason>; requires DORI_STATE_DIR");
  process.exit(2);
}
const delivery = new Delivery(`${state}/discord-delivery.sqlite`);
const conversations = new Conversations(`${state}/discord-conversations.sqlite`);
const stateDir = state;
const warn = (message: string) => console.error(`ACK_WARN ${message}`);
// One command run checks the bot identity and channel policy once and reuses channel reads;
// each item is still reauthorized against them. Per-item setup made a backlog take minutes.
const rest = process.env.DORI_DISCORD_TOKEN ? cachedReads(discordRest(process.env.DORI_DISCORD_TOKEN)) : undefined;
let policy: Promise<ReturnType<typeof filterConfig>> | undefined;
function currentPolicy() {
  return policy ??= (async () => {
    if (!rest) throw new TypeError("Requires DORI_DISCORD_TOKEN for current authorization");
    const cfg = filterConfig(process.env, (channel, user) => conversations.isOpen(channel, user),
      (channel, user, messageId) => conversations.workingAnchor(channel, user, messageId));
    cfg.botId = (await rest<{ id: string }>("/users/@me")).id;
    await validateChannelPolicy(cfg, rest, warn);
    return cfg;
  })();
}
async function authorized(item: { readonly id: string; readonly payload: string }): Promise<string> {
  const cfg = await currentPolicy();
  const current = await reauthorize(item.payload, cfg, rest!);
  if (!current) throw new RangeError(`Delivery ${item.id} is no longer authorized; keep it pending`);
  await sweepExpired(delivery, stateDir, warn);
  delivery.check(item.id);
  const payload = JSON.stringify(current);
  if (!delivery.refresh(item.id, item.payload, payload)) throw new RangeError(`Delivery ${item.id} changed during authorization`);
  return payload;
}
try {
  if (stream === "inbound") await sweepExpired(delivery, state, warn);
  if (action === "pending") {
    for (const item of delivery.pending(stream)) {
      if (stream === "context") {
        let allowed: boolean;
        try {
          allowed = await contextReplayAllowed(item.payload, process.env, rest);
        }
        catch (error) {
          if (!(error instanceof Error)) throw error;
          warn(`message_id=${item.id} context replay withheld: ${error.message}`);
          continue;
        }
        if (!allowed) {
          warn(`message_id=${item.id} context replay withheld by current privacy policy`);
          continue;
        }
        console.log(`CONTEXT ${item.payload}`);
      }
      else {
        let payload: string;
        try { payload = await authorized(item); }
        catch (error) {
          if (!(error instanceof Error)) throw error;
          warn(`message_id=${item.id} replay withheld: ${error.message}`);
          continue;
        }
        console.log(`INBOUND ${payload}`);
      }
    }
  } else if (action === "status" && id) {
    console.log(JSON.stringify({ stream, message_id: id, ...delivery.status(stream, id) }));
  } else if (action === "irrelevant" && id && reason) {
    const item = delivery.pending("inbound").find((item) => item.id === id);
    if (item) await authorized(item);
    delivery.irrelevant(id, reason);
    await cleanupAttachments(id, `${state}/attachments/${stream}`);
    await finishWorking(conversations, rest, [id], Date.now(), warn);
    console.log(`ACK_IRRELEVANT stream=${stream} message_id=${id}`);
  } else if (action === "done" && id) {
    delivery.acknowledge(stream, id);
    await cleanupAttachments(id, `${state}/attachments/${stream}`);
    if (stream === "inbound") await finishWorking(conversations, rest, [id], Date.now(), warn);
    console.log(`ACK_DONE stream=${stream} message_id=${id}`);
  } else if (action === "working" && id) {
    const item = delivery.pending("inbound").find((item) => item.id === id);
    if (!item) throw new RangeError(`Unknown inbound delivery ${id}`);
    const payload = JSON.parse(await authorized(item)) as { channel_id: string; author_id: string; role: string; scope: string };
    const row = conversations.ensureWorking(payload.channel_id, payload.author_id, id);
    let reaction: string;
    if (payload.role === "BOT_BUG_REPORT" || payload.scope === "evidence-only") reaction = "skipped";
    else if (row.closed_at !== null) reaction = "skipped-already-replied";
    else if (row.reacted) reaction = "already";
    else {
      // Recorded first: a crash right after adding the reaction must still leave it to be cleaned up.
      conversations.setReacted(id, true);
      try { await addEyes(rest!, payload.channel_id, id); reaction = "added"; }
      catch (error) {
        conversations.setReacted(id, false);
        warn(`could not add 👀 to message_id=${id}; continuing without it: ${String(error)}`);
        reaction = "failed";
      }
    }
    console.log(`ACK_WORKING stream=inbound message_id=${id} reaction=${reaction}`);
  } else if ((action === "accept" || action === "check") && id) {
    delivery.check(id);
    const item = delivery.pending("inbound").find((item) => item.id === id);
    if (!item) throw new RangeError(`Unknown inbound delivery ${id}`);
    await authorized(item);
    if (action === "accept") delivery.accept(id);
    else delivery.check(id);
    console.log(`ACK_${action.toUpperCase()} stream=inbound message_id=${id}`);
  }
} finally {
  try {
    if (stream === "inbound") await sweepExpired(delivery, state, warn);
  } finally {
    delivery.close();
    conversations.dispose();
  }
}
