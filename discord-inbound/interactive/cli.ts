import { join } from "node:path";
import { DiscordRestError, discordRest, type Rest } from "../discord/rest.ts";
import { PromptStore, newId, type Prompt } from "./store.ts";
import { confirmButtons, planButtons, promptLine, type ConfirmAction } from "./text.ts";
import { githubReferences } from "../messages/references.ts";

const USAGE = `Usage: helio confirm ask --action merge|restart|pr --target T --revision SHA --channel ID [--reply-to ID] [--note TEXT]
       helio confirm plan --issue N --revision R --text-file PATH --channel ID [--reply-to ID]
       helio confirm train --train ID --target REPO#N,N --revision SHA --text-file PATH --channel ID [--reply-to ID] [--restart]
       helio confirm bind (--prompt ID | --message ID --approver USER --at MS) --train ID
       helio confirm binding TRAIN | unlock TRAIN
       helio confirm list [--all] | show ID | use ID | cancel ID | recover ID | feedback ID`;
const SNOWFLAKE = /^[0-9]{1,30}$/, SHA = /^[0-9a-f]{40}$/, PROMPT_ID = /^[0-9a-f]{20}$/;

class Refused extends Error {}

function options(args: readonly string[], allowed: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!;
    if ((key === "--all" || key === "--restart") && allowed.includes(key)) { out.set(key, ""); continue; }
    const value = args[i + 1];
    if (!allowed.includes(key) || value === undefined || out.has(key)) throw new Refused(USAGE);
    out.set(key, value);
    i++;
  }
  return out;
}

const list = (name: string) => new Set((process.env[name] ?? "").split(",").map((x) => x.trim()).filter(Boolean));

async function permitted(rest: Rest, channelId: string): Promise<boolean> {
  const owner = process.env.DORI_DISCORD_OWNER_ID ?? "", trusted = list("DORI_DISCORD_TRUSTED_IDS"), allowed = list("DORI_DISCORD_ALLOWED");
  type Channel = { id: string; type: number; parent_id?: string | null; recipients?: { id: string }[] };
  let current = await rest<Channel>(`/channels/${channelId}`);
  if (current.type === 1) return (current.recipients ?? []).some((user) => user.id === owner || trusted.has(user.id));
  for (let depth = 0; depth < 4; depth++) {
    if (allowed.has(current.id)) return true;
    if (!current.parent_id) return false;
    current = await rest<Channel>(`/channels/${current.parent_id}`);
  }
  return false;
}

async function preflight(action: string, target: string, revision: string): Promise<number | undefined> {
  const checker = process.env.HELIO_RELEASE_CHECK;
  if (!checker) throw new Refused("HELIO_RELEASE_CHECK is not set; run through the helio command");
  const child = Bun.spawn(["python3", checker, "--preflight", "--action", action, "--target", target, "--revision", revision], {
    env: process.env, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code === 4) { process.stdout.write(out); return 4; }
  if (code !== 0) throw new Refused((err || out).trim() || `release preflight exited ${code}`);
  return undefined;
}

const summary = (row: Prompt) => ({
  id: row.id, kind: row.kind, action: row.action, target: row.target, revision: row.revision, status: row.status,
  channel_id: row.channel_id, message_id: row.message_id, decided_by: row.decided_by,
  result_message_id: row.result_message_id, expires_at: new Date(row.expires_at).toISOString(), error: row.error,
});

async function post(store: PromptStore, rest: Rest, row: Parameters<PromptStore["create"]>[0], components: unknown,
  mentions: readonly string[] = []): Promise<Prompt> {
  store.create(row);
  try {
    const sent = await rest<{ id: string }>(`/channels/${row.channel_id}/messages`, {
      method: "POST", body: {
        content: row.content, components, allowed_mentions: { parse: [], ...(mentions.length ? { users: mentions } : {}) },
        nonce: row.id, enforce_nonce: true,
        ...(row.reply_to ? { message_reference: { message_id: row.reply_to, fail_if_not_exists: false } } : {}),
      },
    });
    if (!SNOWFLAKE.test(sent.id)) throw new Refused("Discord returned an invalid message ID");
    store.sent(row.id, sent.id, Date.now());
  } catch (error) {
    const definite = error instanceof DiscordRestError && error.status < 500;
    store.failed(row.id, definite ? "send_failed" : "delivery_unknown", error instanceof Error ? error.message : String(error));
  }
  return store.get(row.id)!;
}

function existing(store: PromptStore, kind: string, action: string, target: string, revision: string, channel: string) {
  return store.list(false).find((row) => row.kind === kind && row.action === action && row.target === target &&
    row.revision === revision && row.channel_id === channel && (row.status === "open" || row.status === "pending"));
}

function report(row: Prompt): number {
  const line = JSON.stringify(summary(row));
  if (row.status === "open" || row.status === "pending") { console.log(`CONFIRM_ASKED ${line}`); return 0; }
  console.log(`CONFIRM_DELIVERY_${row.status === "send_failed" ? "FAILED" : "UNKNOWN"} ${line}` +
    (row.status === "delivery_unknown" ? ` next="helio confirm recover ${row.id}"` : ""));
  return 1;
}

export async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  const state = process.env.DORI_STATE_DIR, token = process.env.DORI_DISCORD_TOKEN;
  if (!state || !token) throw new Refused("DORI_STATE_DIR and DORI_DISCORD_TOKEN are required");
  const repo = process.env.HELIO_GITHUB_REPO ?? "jamestesting0/elo-bot";
  const api = discordRest(token);
  const store = new PromptStore(join(state, "discord-prompts.sqlite"));
  try {
    if (command === "ask") {
      const o = options(rest, ["--action", "--target", "--revision", "--channel", "--reply-to", "--note"]);
      const action = o.get("--action") as ConfirmAction, target = o.get("--target") ?? "", revision = o.get("--revision") ?? "";
      const channel = o.get("--channel") ?? "", replyTo = o.get("--reply-to"), note = o.get("--note")?.trim();
      // The click proof pins only the first line; a note must not look like a closing line or span several lines.
      if (note !== undefined && (!note || note.length > 300 || /[\r\n]/.test(note) || /^(❌|⌛|Replaced)/.test(note))) {
        throw new Refused("--note must be one line of 1-300 characters that does not start with ❌, ⌛ or Replaced");
      }
      if (!["merge", "restart", "pr"].includes(action) || !SHA.test(revision) || !SNOWFLAKE.test(channel) ||
          (replyTo !== undefined && !SNOWFLAKE.test(replyTo))) throw new Refused(USAGE);
      const pattern = action === "restart" ? /^elobot$/ : new RegExp(`^${repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}#[1-9][0-9]*$`);
      if (!pattern.test(target)) throw new Refused(action === "restart" ? "restart target must be elobot" : `target must be ${repo}#<number>`);
      const known = existing(store, "confirm", action, target, revision, channel);
      if (known) return report(known);
      if (!await permitted(api, channel)) throw new Refused("channel is not an allowed channel or an owner/trusted DM");
      const merged = action === "pr" ? undefined : await preflight(action, target, revision);
      if (merged !== undefined) return merged;
      const id = newId();
      const row = await post(store, api, {
        id, kind: "confirm", action, target, revision, content: promptLine(action, target, revision) + (note ? `\n${githubReferences(note)}` : ""),
        channel_id: channel, ...(replyTo ? { reply_to: replyTo } : {}), now: Date.now(),
      }, confirmButtons(id, action), [...new Set([...(note ?? "").matchAll(/<@(\d{1,30})>/g)].map((m) => m[1]!))].slice(0, 100));
      if (row.status === "open") store.supersede(row);
      return report(row);
    }
    if (command === "plan") {
      const o = options(rest, ["--issue", "--revision", "--text-file", "--channel", "--reply-to"]);
      const issue = o.get("--issue") ?? "", revision = o.get("--revision") ?? "", channel = o.get("--channel") ?? "";
      const replyTo = o.get("--reply-to");
      if (!/^[1-9][0-9]*$/.test(issue) || !/^[1-9][0-9]*$/.test(revision) || !SNOWFLAKE.test(channel) ||
          (replyTo !== undefined && !SNOWFLAKE.test(replyTo)) || !o.get("--text-file")) throw new Refused(USAGE);
      let content = githubReferences((await Bun.file(o.get("--text-file")!).text()).trim());
      const previous = `📋 Plan for #${issue} (r${revision})`;
      const header = `📋 Plan for [Issue #${issue}](<https://github.com/${repo}/issues/${issue}>) (r${revision})`;
      if (content.startsWith(previous)) content = header + content.slice(previous.length);
      if (!content.startsWith(header)) throw new Refused("announcement does not match this issue and revision");
      if (content.length > 1900) throw new Refused("announcement is longer than 1900 characters");
      const target = `${repo}#${issue}`;
      const known = existing(store, "plan", "plan", target, revision, channel);
      if (known) return report(known);
      if (!await permitted(api, channel)) throw new Refused("channel is not an allowed channel or an owner/trusted DM");
      const id = newId();
      const row = await post(store, api, {
        id, kind: "plan", action: "plan", target, revision, content, channel_id: channel,
        ...(replyTo ? { reply_to: replyTo } : {}), now: Date.now(),
      }, planButtons(id));
      if (row.status === "open") store.supersede(row);
      return report(row);
    }
    if (command === "train") {
      const o = options(rest, ["--train", "--target", "--revision", "--text-file", "--channel", "--reply-to", "--restart"]);
      const train = o.get("--train") ?? "", target = o.get("--target") ?? "", revision = o.get("--revision") ?? "";
      const channel = o.get("--channel") ?? "", replyTo = o.get("--reply-to");
      const prefix = `${repo}#`, numbers = target.startsWith(prefix) ? target.slice(prefix.length) : "";
      if (!PROMPT_ID.test(train) || !/^[1-9][0-9]*(,[1-9][0-9]*){0,19}$/.test(numbers) || !SHA.test(revision) ||
          !SNOWFLAKE.test(channel) || (replyTo !== undefined && !SNOWFLAKE.test(replyTo)) || !o.get("--text-file")) throw new Refused(USAGE);
      const content = (await Bun.file(o.get("--text-file")!).text()).trim();
      if (!content.startsWith("Merge ") || content.length > 1900) throw new Refused("train prompt must start with Merge and fit 1900 characters");
      const action: ConfirmAction = o.has("--restart") ? "train-restart" : "train";
      const known = existing(store, "confirm", action, target, revision, channel);
      if (known) return report(known);
      if (!await permitted(api, channel)) throw new Refused("channel is not an allowed channel or an owner/trusted DM");
      const row = await post(store, api, { id: train, kind: "confirm", action, target, revision, content, channel_id: channel,
        ...(replyTo ? { reply_to: replyTo } : {}), now: Date.now() }, confirmButtons(train, action));
      if (row.status === "open") store.supersede(row);
      return report(row);
    }
    if (command === "bind") {
      const o = options(rest, ["--prompt", "--message", "--approver", "--at", "--train"]);
      const train = o.get("--train") ?? "", promptId = o.get("--prompt"), message = o.get("--message");
      if (!PROMPT_ID.test(train) || (promptId === undefined) === (message === undefined) ||
          (promptId !== undefined && !PROMPT_ID.test(promptId)) || (message !== undefined && !SNOWFLAKE.test(message))) throw new Refused(USAGE);
      const at = o.get("--at") === undefined ? undefined : Number(o.get("--at"));
      const outcome = store.bind({ ...(promptId ? { prompt: promptId } : { message: message! }), train, repo,
        ...(o.get("--approver") ? { approver: o.get("--approver")! } : {}), ...(at !== undefined ? { approvedAt: at } : {}), now: Date.now() });
      console.log(`CONFIRM_BIND ${JSON.stringify({ train, outcome, ...(store.binding(train) ?? {}) })}`);
      return outcome === "bound" || outcome === "already" ? 0 : outcome === "locked" ? 3 : 2;
    }
    if (command === "binding" || command === "unlock") {
      const train = rest[0];
      if (!train || rest.length !== 1 || !PROMPT_ID.test(train)) throw new Refused(USAGE);
      if (command === "unlock") { console.log(`CONFIRM_UNLOCKED train=${train} changed=${store.unlock(repo, train)}`); return 0; }
      const bound = store.binding(train);
      console.log(`CONFIRM_BINDING ${JSON.stringify(bound ?? null)}`);
      return bound ? 0 : 1;
    }
    if (command === "list") {
      const o = options(rest, ["--all"]);
      for (const row of store.list(o.has("--all"))) console.log(`CONFIRM_ITEM ${JSON.stringify(summary(row))}`);
      return 0;
    }
    const id = rest[0];
    if (!id || rest.length !== 1 || !PROMPT_ID.test(id)) throw new Refused(USAGE);
    const row = store.get(id);
    if (!row) throw new Refused(`unknown prompt ${id}`);
    if (command === "show") { console.log(JSON.stringify({ ...summary(row), content: row.content, feedback: store.feedback(id).length })); return 0; }
    if (command === "feedback") { console.log(JSON.stringify(store.feedback(id))); return 0; }
    if (command === "use") {
      if (!store.use(id, Date.now())) throw new Refused(`prompt ${id} is ${row.status}${row.status === "confirmed" ? " but its use window passed" : ""}; ask again`);
      console.log(`CONFIRM_USED id=${id}`);
      return 0;
    }
    if (command === "cancel") {
      if (!store.cancel(id)) throw new Refused(`prompt ${id} is ${row.status} and cannot be cancelled`);
      console.log(`CONFIRM_CANCELLED id=${id}; its buttons are removed shortly`);
      return 0;
    }
    if (command === "recover") {
      if (row.status !== "delivery_unknown" && row.status !== "sending") throw new Refused(`prompt ${id} is ${row.status}`);
      const me = await api<{ id: string }>("/users/@me");
      const recent = await api<{ id: string; author?: { id?: string }; components?: { components?: { custom_id?: string }[] }[] }[]>(
        `/channels/${row.channel_id}/messages?limit=100`);
      const found = recent.filter((message) => message.author?.id === me.id &&
        (message.components ?? []).some((group) => (group.components ?? []).some((c) => c.custom_id?.includes(`:${id}:`))));
      if (found.length === 1) {
        store.sent(id, found[0]!.id, Date.now());
        store.supersede(row);
      }
      else store.failed(id, "delivery_unknown", found.length ? "several matching messages; inspect manually" : "no matching recent message");
      return report(store.get(id)!);
    }
    throw new Refused(USAGE);
  } finally { store.close(); }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error: unknown) => {
    if (!(error instanceof Refused || error instanceof DiscordRestError)) throw error;
    console.error(`CONFIRM_REFUSED ${error.message}`.replace(/[\r\n]+/g, " ").slice(0, 1000));
    process.exitCode = 2;
  });
}
