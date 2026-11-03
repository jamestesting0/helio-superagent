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
  let textFile: string | undefined, ownerOnly = false;
  const files: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--text-file") textFile = rest[++i];
    else if (rest[i] === "--owner-only") ownerOnly = true;
    else files.push(rest[i]!);
  }
  if (!channel || !message || !/^\d+$/.test(channel) || !/^\d+$/.test(message) || !textFile) return undefined;
  return { channel, message, textFile, ownerOnly, files };
}

async function api(token: string, method: string, path: string, body?: unknown, form?: FormData): Promise<any> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(`https://discord.com/api/v10${path}`, {
      method, body: form ?? (body === undefined ? undefined : JSON.stringify(body)),
      headers: { Authorization: `Bot ${token}`, ...(form ? {} : { "Content-Type": "application/json" }), "User-Agent": "DiscordBot (https://discord.com, 1.0)" },
    });
    if (res.status === 429) { await Bun.sleep(Math.ceil(((await res.json()) as { retry_after: number }).retry_after * 1000)); continue; }
    if (!res.ok) throw new Error(`Discord ${method} ${path} -> ${res.status} ${(await res.text()).slice(0, 200)}`);
    return res.status === 204 ? undefined : res.json();
  }
  throw new Error(`Discord ${method} ${path} kept rate limiting`);
}

async function post(token: string, channel: string, content: string, files: readonly string[], replyTo?: string): Promise<string> {
  const payload = {
    content, allowed_mentions: { parse: [], replied_user: true },
    ...(replyTo ? { message_reference: { type: 0, channel_id: channel, message_id: replyTo, fail_if_not_exists: true } } : {}),
    attachments: files.map((path, id) => ({ id, filename: basename(path) })),
  };
  const form = new FormData();
  form.append("payload_json", JSON.stringify(payload));
  files.forEach((path, i) => form.append(`files[${i}]`, Bun.file(path, { type: IMAGE_TYPES[extname(path).toLowerCase()] }), basename(path)));
  return (await api(token, "POST", `/channels/${channel}/messages`, undefined, form)).id;
}

async function placeOf(token: string, channelId: string, trustedChannels: ReadonlySet<string>): Promise<Place> {
  let channel = await api(token, "GET", `/channels/${channelId}`);
  if (channel.type === 1 || channel.type === 3) return { kind: "dm" };
  for (let depth = 0; depth < 3 && channel; depth++) {
    if (trustedChannels.has(channel.id)) return { kind: "trusted" };
    channel = channel.parent_id ? await api(token, "GET", `/channels/${channel.parent_id}`) : undefined;
  }
  return { kind: "normal" };
}

const ids = (value: string | undefined) => new Set((value ?? "").split(",").map((x) => x.trim()).filter((x) => /^\d+$/.test(x)));

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  const { DORI_DISCORD_TOKEN: token, DORI_DISCORD_OWNER_ID: owner, HOME: home } = process.env;
  if (!args || !token || !owner || !home) {
    console.error("Usage: bun evidence.ts CHANNEL_ID MESSAGE_ID --text-file PATH [--owner-only] FILE...; requires DORI_DISCORD_TOKEN and DORI_DISCORD_OWNER_ID");
    process.exit(2);
  }
  const problem = await checkFiles(args.files);
  const text = (await Bun.file(args.textFile).text()).trimEnd();
  if (problem || !text) { console.error(`EVIDENCE_REFUSED ${problem ?? "the text file is empty"}`); process.exit(2); }
  const trustedIds = ids(await Bun.file(join(home, ".dori/elobot/trusted-users")).text().catch(() => ""));
  const request = await api(token, "GET", `/channels/${args.channel}/messages/${args.message}`);
  const place = await placeOf(token, args.channel, ids(process.env.DORI_DISCORD_TRUSTED_CHANNELS));
  const plan = route(place, { ownerOnly: args.ownerOnly, requester: request.author.id, owner, trusted: trustedIds });
  if (plan.send === "in-place") {
    console.log(`EVIDENCE_SENT in-place message=${await post(token, args.channel, text, args.files, args.message)}`);
  } else {
    const ownerDm = (await api(token, "POST", "/users/@me/channels", { recipient_id: owner })).id;
    const link = `https://discord.com/channels/${request.guild_id ?? "@me"}/${args.channel}/${args.message}`;
    const sent = await post(token, ownerDm, place.kind === "dm" && request.author.id === owner ? text : `${text}\n\nRequest: <${link}>`, args.files);
    console.log(`EVIDENCE_SENT owner-dm message=${sent}`);
    if (plan.forwardTo) {
      const dm = (await api(token, "POST", "/users/@me/channels", { recipient_id: plan.forwardTo })).id;
      const fwd = await api(token, "POST", `/channels/${dm}/messages`, { message_reference: { type: 1, channel_id: ownerDm, message_id: sent } });
      console.log(`EVIDENCE_FORWARDED to=${plan.forwardTo} message=${fwd.id}`);
    }
    if (plan.noteInPlace) {
      const note = args.ownerOnly ? "Some of these results are owner-only, so I sent them to the owner." :
        `Results sent to the owner${plan.forwardTo ? " and forwarded to you by DM" : ""}.`;
      console.log(`EVIDENCE_NOTE message=${await post(token, args.channel, note, [], args.message)}`);
    }
  }
}
