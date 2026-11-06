import { Delivery } from "./delivery/delivery.ts";
import { redactBlocked } from "./delivery/moderation.ts";
import { cleanupAttachments } from "./messages/images.ts";
import { filterConfig, reauthorize, validateChannelPolicy, type OriginalMetadata } from "./intake/authorization.ts";
import { cachedReads, discordRest } from "./discord/rest.ts";
import { sweepExpired } from "./delivery/expiry.ts";
import { cleanupIgnored } from "./delivery/ignored-cleanup.ts";
import { contextReplayAllowed } from "./learning/context-replay.ts";
import { Conversations } from "./conversations/conversations.ts";
import { conversationEntry, conversationSnapshot } from "./conversations/conversation-context.ts";
import { finishWorking, showWorking } from "./conversations/working.ts";
import { contextSummary, inboundSummary, object } from "./delivery/monitor-summary.ts";
import { contextSections, detailPage, renderTurn, SECTION_NAMES } from "./delivery/context-render.ts";
import { TurnAssembler } from "./intake/turns.ts";
import { settleBlock, strikeLinks } from "./delivery/moderation-effects.ts";

const args = process.argv.slice(2);
const [action, stream, id] = args;
const state = process.env.DORI_STATE_DIR;
if (state && (action === "gaps" || action === "gap")) {
  const gapId = Number(stream);
  if ((action === "gaps" && args.length !== 1) || (action === "gap" && (args.length !== 2 || !Number.isSafeInteger(gapId)))) {
    console.error("Usage: ack gaps OR ack gap <id>");
    process.exit(2);
  }
  const store = new Delivery(`${state}/discord-delivery.sqlite`);
  try {
    if (action === "gaps") {
      for (const gap of store.gaps()) console.log(`GAP ${JSON.stringify(gap)}`);
      console.log(`GAP_COUNT ${store.gaps().length}`);
    } else if (store.acknowledgeGap(gapId)) console.log(`GAP_ACKNOWLEDGED ${gapId}`);
    else { console.error(`No open gap ${gapId}`); process.exitCode = 1; }
  } finally { store.close(); }
  process.exit();
}
const flagsAt = args.findIndex((arg) => arg.startsWith("--"));
const positional = flagsAt < 0 ? args : args.slice(0, flagsAt);
const flags = flagsAt < 0 ? [] : args.slice(flagsAt);
const options = new Map<string, string>();
let validFlags = flags.length % 2 === 0;
for (let i = 0; i < flags.length; i += 2) {
  const name = flags[i], value = flags[i + 1];
  if (!name || value === undefined || options.has(name)) validFlags = false;
  else options.set(name, value);
}
const after = options.get("--after");
const offset = Number(options.get("--offset") ?? "0");
const sectionName = SECTION_NAMES.find((name) => name === options.get("--section"));
const show = action === "show" || action === "working";
const ids = id?.split(",") ?? [];
const reason = positional[3];
if (!state || (stream !== "inbound" && stream !== "context") ||
    !["pending", "done", "irrelevant", "status", "accept", "check", "working", "show"].includes(action ?? "") ||
    (["accept", "check", "working", "irrelevant"].includes(action ?? "") && stream !== "inbound") ||
    !validFlags || !Number.isSafeInteger(offset) || offset < 0 ||
    [...options.keys()].some((name) => !(
      (name === "--after" && action === "pending" && /^\d{1,30}$/.test(after ?? "")) ||
      (name === "--offset" && action === "show") ||
      (name === "--section" && action === "show" && stream === "inbound" && sectionName))) ||
    (action === "pending" ? positional.length !== 2 :
      ids.length === 0 || ids.length > 10 || ids.some((value) => !/^\d{1,30}$/.test(value)) ||
      ((!show || stream === "context") && ids.length !== 1) ||
      positional.length !== (action === "irrelevant" ? 4 : 3)) ||
    (action === "irrelevant" && (!reason?.trim() || reason.length > 500))) {
  console.error("Usage: ack pending inbound|context [--after ID] OR ack show inbound <ids> [--section NAME --offset N] OR ack show context <id> [--offset N] OR ack done|status inbound|context <id> OR ack accept|check|working inbound <id> OR ack irrelevant inbound <id> <reason>; requires DORI_STATE_DIR");
  process.exit(2);
}

const warn = (message: string) => console.error(`ACK_WARN ${message.slice(0, 900)}`);
function withheldReason(error: unknown): string {
  if (error instanceof SyntaxError) return "Stored record is malformed; retained pending";
  if (!(error instanceof Error)) throw error;
  return error.message.replace(/[\r\n]/g, " ").slice(0, 800);
}
const withheld = (id: string, error: unknown) => {
  console.log(`ACK_WITHHELD ${id}: ${withheldReason(error)}`);
};
let delivery: Delivery | undefined;
let conversations: Conversations | undefined;
try {
  const stateDir = state;
  delivery = new Delivery(`${state}/discord-delivery.sqlite`);
  conversations = new Conversations(`${state}/discord-conversations.sqlite`);
  const queue = delivery, store = conversations;
  const sourceStream = stream;
  const rest = process.env.DORI_DISCORD_TOKEN ? cachedReads(discordRest(process.env.DORI_DISCORD_TOKEN)) : undefined;
  let policy: Promise<ReturnType<typeof filterConfig>> | undefined;
  function currentPolicy() {
    if (!policy) policy = (async () => {
      if (!rest) throw new TypeError("Requires DORI_DISCORD_TOKEN for current authorization");
      const cfg = filterConfig(process.env, (channel, user) => store.isOpen(channel, user),
        (channel, user, messageId) => store.workingAnchor(channel, user, messageId), undefined,
        (channel, user) => store.talkedRecently(channel, user, Date.now()));
      cfg.botId = (await rest<{ id: string }>("/users/@me")).id;
      const warnings: string[] = [];
      await validateChannelPolicy(cfg, rest, (message) => warnings.push(message));
      if (warnings.length) warn(`channel policy warnings=${warnings.length}: ${warnings[0]}`);
      return cfg;
    })();
    return policy;
  }
  async function quietIgnored(item: { readonly id: string; readonly payload: string }): Promise<boolean> {
    const ignored = stream === "inbound" ? filterConfig(process.env).ignoredChannels :
      new Set((process.env.DORI_DISCORD_IGNORED_CHANNELS ?? "").split(",").map(value => value.trim()).filter(Boolean));
    const lookup = rest ? async (channel: string) => rest<{ parent_id?: string }>(`/channels/${channel}`) : undefined;
    let settled = await queue.ignored.settle(sourceStream, item.id, item.payload, ignored, lookup);
    if (!settled && sourceStream === "inbound" && rest) {
      const saved = object(JSON.parse(item.payload)), origin = object(saved.discord_origin ?? {});
      if (origin.message_type === undefined && saved.preparation_complete === true) {
        let original: OriginalMetadata | undefined;
        await reauthorize(item.payload, await currentPolicy(), rest, value => { original = value; });
        if (original) settled = await queue.ignored.settle(sourceStream, item.id, item.payload, ignored, lookup, original);
      }
    }
    if (!settled) return false;
    await cleanupIgnored(queue, stateDir, store);
    console.log(`ACK_IGNORED stream=${stream} message_id=${item.id}`);
    return true;
  }
  async function authorized(item: { readonly id: string; readonly payload: string }): Promise<string> {
    if (stream === "context") {
      const author = object(JSON.parse(item.payload)).author_id;
      if (typeof author === "string" && queue.moderation.isBlocked(author)) throw new RangeError("Sender is blacklisted; context withheld");
      if (!await contextReplayAllowed(item.payload, process.env, rest)) {
        throw new RangeError("Context withheld by current privacy policy");
      }
      return item.payload;
    }
    const cfg = await currentPolicy();
    if (!rest) throw new TypeError("Requires DORI_DISCORD_TOKEN for current authorization");
    const authorizedNow = await reauthorize(item.payload, cfg, rest);
    if (!authorizedNow) throw new RangeError(`Delivery ${item.id} is no longer authorized; keep it pending`);
    if (queue.moderation.isBlocked(authorizedNow.author_id)) throw new RangeError("Sender is blacklisted; withheld, record kept");
    const current = redactBlocked(authorizedNow, (id) => queue.moderation.isBlocked(id)) as typeof authorizedNow;
    const review = queue.recovery.status(item.id);
    const payload = JSON.stringify({ ...current, ...(review ? {
      backlog: true, recovered: true,
      recovery: { outcome: review.outcome, reviewed_at: review.reviewed_at,
        read: "helio recovery scan", requires_review: review.outcome !== "resume" },
    } : {}) });
    if (action !== "show") {
      await sweepExpired(queue, stateDir, warn);
      queue.check(item.id);
      if (!queue.refresh(item.id, item.payload, payload)) throw new RangeError("Delivery changed during authorization");
    }
    return payload;
  }
  if (stream === "inbound" && action !== "show") await sweepExpired(queue, state, warn);
  if (show) {
    const messages: Record<string, unknown>[] = [];
    for (const messageId of ids) {
      try {
        const status = queue.status(stream, messageId);
        if (status.disposition !== "pending" && status.disposition !== "accepted") {
          console.log(`ACK_HANDLED ${JSON.stringify({ stream, message_id: messageId, ...status })}`);
          continue;
        }
        const item = queue.pending(stream).find((item) => item.id === messageId);
        if (!item) throw new RangeError("Delivery changed while reading");
        if (await quietIgnored(item)) continue;
        const message = object(JSON.parse(await authorized(item)));
        if (messages.length && messages[0]?.channel_id !== message.channel_id) {
          throw new RangeError("Turn messages must share a channel");
        }
        messages.push(message);
      } catch (error) { withheld(messageId, error); }
    }
    if (messages.length) {
      const last = messages.at(-1);
      if (stream === "inbound" && last && typeof last.channel_id === "string" && typeof last.author_id === "string" && typeof last.message_id === "string") {
        const lastId = last.message_id;
        const routing = { ...(typeof last.reply_to === "string" ? { reply_to: last.reply_to } : {}), pinged: last.pinged === true };
        const conversation = conversationSnapshot(store, last.channel_id, last.author_id, Date.now(), routing);
        if (conversation || store.latest(last.channel_id, last.author_id)) {
          const saved = last.conversation ? object(last.conversation) : {};
          last.conversation = {
            ...conversation, recent: saved.recent,
            transcript: (conversation?.transcript ?? [])
              .filter((entry) => BigInt(entry.message_id) < BigInt(lastId)),
          };
        }
      }
      if (stream === "context") console.log(`ACK_CONTEXT ${detailPage(messages[0], `ack show context ${id}`, offset)}`);
      else {
        console.log(sectionName ?
          `ACK_SECTION ${detailPage(contextSections(messages)[sectionName], `ack show inbound ${id} --section ${sectionName}`, offset)}` :
          renderTurn(messages));
        if (action === "working") {
          for (const message of messages) {
            if (typeof message.message_id === "string") {
              const item = queue.pending("inbound").find((row) => row.id === message.message_id);
              if (item) queue.recovery.requireReviewed(item.id, item.payload);
            }
          }
          for (const message of messages) {
            if (typeof message.channel_id === "string" && typeof message.author_id === "string" &&
                message.role !== "BOT_BUG_REPORT" && message.scope !== "evidence-only") {
              store.claim(message.channel_id, message.author_id, conversationEntry(message), Date.now());
            }
          }
          for (const message of messages) {
            if (typeof message.message_id !== "string" || typeof message.channel_id !== "string" ||
                typeof message.author_id !== "string" || typeof message.role !== "string" || typeof message.scope !== "string" || !rest) {
              throw new TypeError("Authorized working message lacks identity");
            }
            const reaction = await showWorking({ store, rest, now: Date.now(), warn }, {
              message_id: message.message_id, channel_id: message.channel_id, author_id: message.author_id,
              role: message.role, scope: message.scope,
            });
            console.log(`ACK_WORKING stream=inbound message_id=${message.message_id} reaction=${reaction}`);
          }
        }
      }
    }
  } else if (action === "pending") {
    let printed = 0, held = 0, bytes = 0, last: string | undefined;
    const pending = queue.pending(stream).filter((item) => !after || BigInt(item.id) > BigInt(after));
    let processed = 0;
    for (const item of pending) {
      if (processed >= 25 || bytes >= 35_000) break;
      let line: string;
      try {
        if (await quietIgnored(item)) { processed++; last = item.id; continue; }
        const payload = await authorized(item);
        if (stream === "context") line = contextSummary(item.id, payload);
        else {
          const lines: string[] = [];
          new TurnAssembler((turn) => lines.push(inboundSummary(turn))).replay([JSON.parse(payload)]);
          line = lines.join("\n");
        }
        printed++;
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        line = `ACK_WITHHELD ${item.id}: ${withheldReason(error)}`;
        const warning = `message_id=${item.id} replay withheld: ${withheldReason(error)}`;
        warn(warning);
        bytes += Buffer.byteLength(`ACK_WARN ${warning.slice(0, 900)}\n`);
        held++;
      }
      bytes += Buffer.byteLength(line + "\n");
      console.log(line);
      processed++;
      last = item.id;
    }
    console.log(`ACK_PENDING stream=${stream} printed=${printed} withheld=${held}` +
      (processed < pending.length ? ` next="ack pending ${stream} --after ${last}"` : ""));
  } else if (action === "status" && id) {
    console.log(JSON.stringify({ stream, message_id: id, ...queue.status(stream, id) }));
  } else if (action === "irrelevant" && id && reason) {
    const item = queue.pending("inbound").find((item) => item.id === id);
    if (item) await authorized(item);
    const result = queue.irrelevant(id, reason);
    await cleanupAttachments(id, `${state}/attachments/${stream}`);
    await finishWorking({ store, rest, now: Date.now(), warn }, [id]);
    console.log(`ACK_IRRELEVANT stream=${stream} message_id=${id}`);
    if (result.blocked) {
      const blocked = result.blocked;
      await settleBlock({ delivery: queue, conversations: store, rest, stateDir, warn }, blocked.user_id, result);
      console.log(`AUTO_BLACKLISTED ${JSON.stringify({
        user_id: blocked.user_id, reason: blocked.reason, evidence_message_id: blocked.evidence_message_id,
        evidence_channel_id: blocked.evidence_channel_id, dismissed: result.dismissed.length,
        strikes: await strikeLinks(queue.moderation.strikeEvidence(blocked.user_id),
          async (channel) => rest ? (await rest<{ guild_id?: string }>(`/channels/${channel}`)).guild_id : undefined),
        next: "ask the owner with helio question ask --audience owner --option Undo --option Keep, then helio blacklist asked USER_ID --question ID",
      })}`);
    }
  } else if (action === "done" && id) {
    queue.acknowledge(stream, id);
    await cleanupAttachments(id, `${state}/attachments/${stream}`);
    if (stream === "inbound") await finishWorking({ store, rest, now: Date.now(), warn }, [id]);
    console.log(`ACK_DONE stream=${stream} message_id=${id}`);
  } else if ((action === "accept" || action === "check") && id) {
    queue.check(id);
    const item = queue.pending("inbound").find((item) => item.id === id);
    if (item) queue.recovery.requireReviewed(item.id, item.payload);
    if (!item) throw new RangeError(`Unknown inbound delivery ${id}`);
    await authorized(item);
    if (action === "accept") queue.accept(id);
    else queue.check(id);
    console.log(`ACK_${action.toUpperCase()} stream=inbound message_id=${id}`);
  }
} catch (error) {
  if (!show) throw error;
  for (const messageId of ids) withheld(messageId, error);
} finally {
  delivery?.close();
  conversations?.dispose();
}
