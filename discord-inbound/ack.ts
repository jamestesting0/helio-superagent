import { Delivery } from "./delivery.ts";
import { cleanupAttachments } from "./images.ts";
import { filterConfig, reauthorize, validateChannelPolicy } from "./authorization.ts";
import { discordRest } from "./rest.ts";
import { sweepExpired } from "./expiry.ts";
import { contextReplayAllowed } from "./context-replay.ts";
import { Conversations } from "./conversations.ts";

const [action, stream, id, reason, ...extra] = process.argv.slice(2);
const state = process.env.DORI_STATE_DIR;
if (!state || (stream !== "inbound" && stream !== "context") ||
    (action !== "pending" && action !== "done" && action !== "irrelevant" && action !== "status" &&
      action !== "accept" && action !== "check") ||
    ((action === "accept" || action === "check") && stream !== "inbound") ||
    (action !== "pending" && (!id || !/^[0-9]{1,30}$/.test(id))) ||
    (action === "pending" && id !== undefined) || extra.length ||
    (action === "irrelevant" ? stream !== "inbound" || !reason?.trim() || reason.length > 500 : reason !== undefined)) {
  console.error("Usage: ack pending inbound|context OR ack done|status inbound|context <message_id> OR ack accept|check inbound <message_id> OR ack irrelevant inbound <message_id> <reason>; requires DORI_STATE_DIR");
  process.exit(2);
}
const delivery = new Delivery(`${state}/discord-delivery.sqlite`);
const conversations = new Conversations(`${state}/discord-conversations.sqlite`);
const stateDir = state;
const warn = (message: string) => console.error(`ACK_WARN ${message}`);
async function authorized(item: { readonly id: string; readonly payload: string }): Promise<string> {
  const token = process.env.DORI_DISCORD_TOKEN;
  if (!token) throw new TypeError("Requires DORI_DISCORD_TOKEN for current authorization");
  const rest = discordRest(token);
  const cfg = filterConfig(process.env, (channel, user) => conversations.isOpen(channel, user));
  cfg.botId = (await rest<{ id: string }>("/users/@me")).id;
  await validateChannelPolicy(cfg, rest, warn);
  const current = await reauthorize(item.payload, cfg, rest);
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
          allowed = await contextReplayAllowed(item.payload, process.env,
            process.env.DORI_DISCORD_TOKEN ? discordRest(process.env.DORI_DISCORD_TOKEN) : undefined);
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
    console.log(`ACK_IRRELEVANT stream=${stream} message_id=${id}`);
  } else if (action === "done" && id) {
    delivery.acknowledge(stream, id);
    await cleanupAttachments(id, `${state}/attachments/${stream}`);
    console.log(`ACK_DONE stream=${stream} message_id=${id}`);
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
