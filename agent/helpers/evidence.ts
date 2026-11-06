// Deliver test results (text plus screenshots) to wherever the request came from.
// Usage: bun evidence.ts CHANNEL_ID MESSAGE_ID --text-file PATH [--owner-only] FILE...
import { lstat } from "node:fs/promises";
import { extname, basename, join } from "node:path";

export type Place = { readonly kind: "dm" | "trusted" | "normal" };
export type Route =
  | { readonly send: "in-place" }
  | { readonly send: "owner-dm"; readonly forwardTo?: string; readonly noteInPlace: boolean };

/** The destination is decided from where the request lives, never from the agent's judgement. */
export function route(place: Place, opts: { ownerOnly: boolean; requester: string; owner: string; trusted: ReadonlySet<string> }): Route {
  const inOwnerDm = place.kind === "dm" && opts.requester === opts.owner;
  if (opts.ownerOnly) return { send: "owner-dm", noteInPlace: !inOwnerDm };
  if (place.kind !== "normal") return { send: "in-place" };
  const forwardTo = opts.requester !== opts.owner && opts.trusted.has(opts.requester) ? opts.requester : undefined;
  return { send: "owner-dm", ...(forwardTo ? { forwardTo } : {}), noteInPlace: true };
}

const IMAGE_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };
export async function checkFiles(paths: readonly string[]): Promise<string | undefined> {
  if (paths.length > 10) return "at most 10 screenshots per message";
  for (const path of paths) {
    if (!IMAGE_TYPES[extname(path).toLowerCase()]) return `${basename(path)}: only PNG, JPEG or WebP screenshots`;
    const info = await lstat(path).catch(() => undefined);
    if (!info?.isFile()) return `${basename(path)}: not a regular file`;
    if (info.size > 8 * 1024 * 1024) return `${basename(path)}: larger than 8 MB`;
  }
  return undefined;
}

export function parseArgs(argv: readonly string[]) {
  const [channel, message, ...rest] = argv;
  let textFile: string | undefined, event: string | undefined = "completion", ownerOnly = false;
  let disposition: "final" | "progress" | "question" | undefined;
  let waiting_on: string | undefined, job: string | undefined, issue: string | undefined;
  const files: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--text-file") textFile = rest[++i];
    else if (rest[i] === "--event") {
      event = rest[++i];
      if (!event || !/^[a-zA-Z0-9:_.-]{1,160}$/.test(event)) return undefined;
    }
    else if (rest[i] === "--disposition") {
      const value = rest[++i];
      if (value !== "final" && value !== "progress" && value !== "question") return undefined;
      disposition = value;
    }
    else if (rest[i] === "--waiting-on") {
      waiting_on = rest[++i];
      if (!waiting_on?.trim() || waiting_on.length > 300) return undefined;
    }
    else if (rest[i] === "--job") {
      job = rest[++i];
      if (!job || !/^[a-z0-9][a-z0-9._-]{1,60}$/.test(job) || job.includes("..")) return undefined;
    }
    else if (rest[i] === "--issue") {
      issue = rest[++i];
      if (!issue || !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/[1-9]\d*$/.test(issue)) return undefined;
    }
    else if (rest[i] === "--owner-only") ownerOnly = true;
    else files.push(rest[i]!);
  }
  if (!channel || !message || !/^\d+$/.test(channel) || !/^\d+$/.test(message) || !textFile) return undefined;
  if ((disposition === "question" && !waiting_on) || (waiting_on && disposition !== "question") ||
      ((job || issue) && !disposition)) return undefined;
  return { channel, message, textFile, ownerOnly, files, ...(event ? { event } : {}),
    ...(disposition ? { meaning: { disposition, ...(waiting_on ? { waiting_on } : {}), ...(job ? { job } : {}), ...(issue ? { issue } : {}) } } : {}) };
}

async function api<T>(token: string, method: string, path: string, body?: unknown, form?: FormData): Promise<T> {
  const { discordRest } = await import("../discord-inbound/discord/rest.ts");
  return discordRest(token)<T>(path, { method, body: form ?? body });
}

type Event = { readonly key: string; readonly state: string };
type Delivery = {
  readonly channel: string; readonly source: string; readonly text: string;
  readonly reference?: string; readonly event?: Event; readonly send: () => Promise<string>;
};

async function deliver(token: string, message: Delivery): Promise<string> {
  if (!message.event) return message.send();
  const [{ sendOnce, findSentReply }, { discordRest }] = await Promise.all([
    import("../discord-inbound/conversations/reply-once.ts"), import("../discord-inbound/discord/rest.ts"),
  ]);
  const result = await sendOnce({
    path: join(message.event.state, "reply-sends.sqlite"), target: message.source,
    text: message.text, event: `${message.channel}:${message.event.key}`, now: () => Date.now(), sleep: (ms) => Bun.sleep(ms), send: message.send,
    findSent: (original, otherReplyIds) => findSentReply(discordRest(token), {
      channel_id: message.channel, message_id: message.reference ?? message.source, referenced: !!message.reference, otherReplyIds,
    }, original),
  });
  if (result.duplicate) console.log(`EVIDENCE_DUPLICATE message=${result.id}; delivery already completed`);
  return result.id;
}

async function post(token: string, message: Omit<Delivery, "send" | "text" | "reference"> & {
  readonly content: string; readonly files: readonly string[]; readonly replyTo?: string;
}): Promise<string> {
  const { channel, content, files, replyTo } = message;
  const payload = {
    content, allowed_mentions: { parse: [], replied_user: true },
    ...(replyTo ? { message_reference: { type: 0, channel_id: channel, message_id: replyTo, fail_if_not_exists: true } } : {}),
    attachments: files.map((path, id) => ({ id, filename: basename(path) })),
  };
  const form = new FormData();
  form.append("payload_json", JSON.stringify(payload));
  files.forEach((path, i) => { form.append(`files[${i}]`, Bun.file(path, { type: IMAGE_TYPES[extname(path).toLowerCase()] }), basename(path)); });
  return deliver(token, { ...message, text: content, ...(replyTo ? { reference: replyTo } : {}),
    send: async () => (await api<{ id: string }>(token, "POST", `/channels/${channel}/messages`, undefined, form)).id });
}

async function placeOf(token: string, channelId: string, trustedChannels: ReadonlySet<string>): Promise<Place> {
  type Channel = { id: string; type: number; parent_id?: string };
  let channel: Channel | undefined = await api<Channel>(token, "GET", `/channels/${channelId}`);
  if (channel.type === 1 || channel.type === 3) return { kind: "dm" };
  for (let depth = 0; depth < 3 && channel; depth++) {
    if (trustedChannels.has(channel.id)) return { kind: "trusted" };
    channel = channel.parent_id ? await api<Channel>(token, "GET", `/channels/${channel.parent_id}`) : undefined;
  }
  return { kind: "normal" };
}

const ids = (value: string | undefined) => new Set((value ?? "").split(",").map((x) => x.trim()).filter((x) => /^\d+$/.test(x)));

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { DORI_DISCORD_TOKEN: token, DORI_DISCORD_OWNER_ID: owner, DORI_STATE_DIR: state, HOME: home } = process.env;
  if (!args || !token || !owner || !home || (args.event && !state)) {
    console.error("Usage: bun evidence.ts CHANNEL_ID MESSAGE_ID --text-file PATH [--event KEY] [--owner-only] FILE...; events require DORI_STATE_DIR");
    process.exit(2);
  }
  const problem = await checkFiles(args.files);
  const text = (await Bun.file(args.textFile).text()).trimEnd();
  if (problem || !text) { console.error(`EVIDENCE_REFUSED ${problem ?? "the text file is empty"}`); process.exit(2); }
  const [{ filterConfig, requireReplyChannel }, { discordRest }] = await Promise.all([
    import("../discord-inbound/intake/authorization.ts"), import("../discord-inbound/discord/rest.ts"),
  ]);
  await requireReplyChannel(args.channel, filterConfig(process.env), discordRest(token));
  const [{ Conversations }, { ReplySettlements }] = await Promise.all([
    import("../discord-inbound/conversations/conversations.ts"), import("../discord-inbound/conversations/reply-settlement.ts"),
  ]);
  const store = args.meaning && state ? new Conversations(join(state, "discord-conversations.sqlite")) : undefined;
  const settlements = store && state ? new ReplySettlements(join(state, "reply-sends.sqlite")) : undefined;
  const settlementKey = `${args.channel}:${args.message}:${args.event}${args.ownerOnly ? ":owner-only" : ""}`;
  try {
  if (settlements && store) {
    const recovered = settlements.recover(settlementKey, store, Date.now());
    if (recovered) { console.log(`EVIDENCE_SETTLED ${recovered.join(",")}; existing delivery retained`); return; }
  }
  const trustedIds = ids(await Bun.file(join(home, ".dori/elobot/trusted-users")).text().catch(() => ""));
  const request = await api<{ author: { id: string }; guild_id?: string }>(token, "GET", `/channels/${args.channel}/messages/${args.message}`);
  const place = await placeOf(token, args.channel, ids(process.env.DORI_DISCORD_TRUSTED_CHANNELS));
  const plan = route(place, { ownerOnly: args.ownerOnly, requester: request.author.id, owner, trusted: trustedIds });
  if (args.meaning?.disposition === "question" && plan.send !== "in-place" &&
      !(place.kind === "dm" && request.author.id === owner)) {
    throw new RangeError("Requester questions require an in-place route; use reply.ts in the request channel");
  }
  const event = args.event && state ? { key: args.event, state } : undefined;
  const identity = { source: args.message, ...(event ? { event } : {}) };
  // Resolve every destination before taking the topic snapshot or posting any part of the report.
  const ownerDm = plan.send === "owner-dm" ?
    (await api<{ id: string }>(token, "POST", "/users/@me/channels", { recipient_id: owner })).id : undefined;
  const forwardDm = plan.send === "owner-dm" && plan.forwardTo ?
    (await api<{ id: string }>(token, "POST", "/users/@me/channels", { recipient_id: plan.forwardTo })).id : undefined;
  if (settlements && store && args.meaning && event) {
    const topic = store.forReply(args.channel, request.author.id, args.message);
    const destinations = plan.send === "in-place" ? [{ channel: args.channel, key: event.key }] : [
      { channel: ownerDm!, key: args.ownerOnly ? `${event.key}:owner-only` : event.key },
      ...(forwardDm ? [{ channel: forwardDm, key: event.key }] : []),
      ...(plan.noteInPlace ? [{ channel: args.channel, key: event.key }] : []),
    ];
    settlements.prepare(settlementKey, topic ? [{ ...topic, covered: [args.message] }] : [], args.meaning,
      destinations.map(destination => ({ target: args.message, event: `${destination.channel}:${destination.key}` })));
  }
  if (plan.send === "in-place") {
    console.log(`EVIDENCE_SENT in-place message=${await post(token, { ...identity, channel: args.channel, content: text, files: args.files, replyTo: args.message })}`);
  } else {
    if (!ownerDm) throw new TypeError("Owner delivery destination unavailable");
    const link = `https://discord.com/channels/${request.guild_id ?? "@me"}/${args.channel}/${args.message}`;
    const sent = await post(token, { ...identity, channel: ownerDm,
      ...(args.ownerOnly && event ? { event: { ...event, key: `${event.key}:owner-only` } } : {}),
      content: place.kind === "dm" && request.author.id === owner ? text : `${text}\n\nRequest: <${link}>`,
      files: args.files, ...(ownerDm === args.channel ? { replyTo: args.message } : {}) });
    console.log(`EVIDENCE_SENT owner-dm message=${sent}`);
    if (plan.forwardTo) {
      if (!forwardDm) throw new TypeError("Forward delivery destination unavailable");
      const dm = forwardDm;
      const forwarded = await deliver(token, { ...identity, channel: dm, text: "", reference: sent,
        send: async () => (await api<{ id: string }>(token, "POST", `/channels/${dm}/messages`,
          { message_reference: { type: 1, channel_id: ownerDm, message_id: sent } })).id });
      console.log(`EVIDENCE_FORWARDED to=${plan.forwardTo} message=${forwarded}`);
    }
    if (plan.noteInPlace) {
      const note = args.ownerOnly ? "Some of these results are owner-only, so I sent them to the owner." :
        `Results sent to the owner${plan.forwardTo ? " and forwarded to you by DM" : ""}.`;
      console.log(`EVIDENCE_NOTE message=${await post(token, { ...identity, channel: args.channel, content: note, files: [], replyTo: args.message })}`);
    }
  }
  if (settlements && store) {
    settlements.delivered(settlementKey);
    console.log(`EVIDENCE_SETTLED ${settlements.settle(settlementKey, store, Date.now()).join(",")}`);
  }
  } finally { settlements?.close(); store?.dispose(); }
}

if (import.meta.main) await main();
