import { Database } from "bun:sqlite";
import { join } from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { Delivery } from "./delivery/delivery.ts";
import { Conversations } from "./conversations/conversations.ts";
import { filterConfig, reauthorize, validateChannelPolicy } from "./intake/authorization.ts";
import { cachedReads, discordRest } from "./discord/rest.ts";
import { object } from "./delivery/monitor-summary.ts";
import { detailPage } from "./delivery/context-render.ts";
import { cleanupAttachments } from "./messages/images.ts";
import { finishWorking } from "./conversations/working.ts";
import { sweepExpired } from "./delivery/expiry.ts";
import { PromptStore } from "./interactive/store.ts";

const state = process.env.DORI_STATE_DIR;
const repo = process.env.HELIO_GITHUB_REPO ?? "jamestesting0/elo-bot";
const [action, id, ...flags] = process.argv.slice(2);
const options = new Map<string, string>();
for (let i = 0; i < flags.length; i += 2) {
  const key = flags[i], value = flags[i + 1];
  if (!key || value === undefined || options.has(key)) throw new TypeError("Expected unique option/value pairs");
  options.set(key, value);
}

async function github(args: readonly string[]): Promise<unknown> {
  const child = Bun.spawn(["gh", ...args, "--repo", repo], {
    env: process.env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 20_000,
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  if (code !== 0) throw new Error(`GitHub inspection unavailable: ${stderr.trim().slice(-300)}`);
  return JSON.parse(stdout);
}

function priorReplies(statePath: string, messageId: string): readonly string[] {
  const path = join(statePath, "reply-sends.sqlite");
  if (!Bun.file(path).size) return [];
  const db = new Database(path, { readonly: true });
  try {
    if (!db.query("SELECT 1 FROM sqlite_master WHERE name='reply_sends'").get()) return [];
    return db.query<{ reply_id: string }, [string]>(
      "SELECT DISTINCT reply_id FROM reply_sends WHERE target=? AND state='sent' AND reply_id IS NOT NULL").all(messageId).map((row) => row.reply_id);
  } finally { db.close(); }
}

async function laneSources(statePath: string): Promise<readonly { readonly key: string; readonly state: string; readonly brief: string }[]> {
  const directory = join(statePath, "lanes");
  let names: string[];
  try { names = await readdir(directory); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  const rows = [];
  for (const name of names.filter((value) => value.endsWith(".json"))) {
    const lane = object(JSON.parse(await readFile(join(directory, name), "utf8")));
    rows.push({ key: String(lane.key), state: lane.closedAt ? "closed" : String(lane.status ?? "working"),
      brief: typeof lane.brief === "string" ? lane.brief : "" });
  }
  return rows;
}

async function main(): Promise<void> {
  if (!state || !["begin", "scan", "show", "review"].includes(action ?? "")) {
    throw new TypeError("Usage: helio recovery begin|scan|show REPORT [--offset N]|review MESSAGE --outcome resume|settled|informational|needs-review --reason-file FILE [--pr N] [--issue N]");
  }
  const allowed = action === "show" ? ["--offset"] : action === "review" ? ["--outcome", "--reason-file", "--pr", "--issue"] : [];
  if ([...options.keys()].some((key) => !allowed.includes(key)) || (["begin", "scan"].includes(action ?? "") && id !== undefined)) {
    throw new TypeError("Unexpected recovery arguments");
  }
  const queue = new Delivery(join(state, "discord-delivery.sqlite"));
  const store = new Conversations(join(state, "discord-conversations.sqlite"));
  const warn = (message: string) => console.error(`RECOVERY_WARN ${message.slice(0, 900)}`);
  try {
    if (action === "begin") {
      console.log(`RECOVERY_BEGIN count=${queue.recovery.begin()}; old deliveries require review, not a new conversation`);
      return;
    }
    if (action === "show") {
      const offset = Number(options.get("--offset") ?? 0);
      if (!id || !Number.isSafeInteger(offset) || offset < 0) throw new TypeError("Expected report ID and nonnegative offset");
      const report = queue.recovery.report(id);
      if (!report) throw new RangeError("Unknown recovery report; run helio recovery scan");
      console.log(`RECOVERY_PAGE ${detailPage(JSON.parse(report), `helio recovery show ${id}`, offset)}`);
      return;
    }
    const token = process.env.DORI_DISCORD_TOKEN;
    if (!token) throw new TypeError("Current authorization requires DORI_DISCORD_TOKEN");
    const rest = cachedReads(discordRest(token));
    const cfg = filterConfig(process.env, (channel, user) => store.isOpen(channel, user),
      (channel, user, messageId) => store.workingAnchor(channel, user, messageId), undefined,
        (channel, user) => store.talkedRecently(channel, user, Date.now()));
    cfg.botId = (await rest<{ id: string }>("/users/@me")).id;
    await validateChannelPolicy(cfg, rest, warn);
    await sweepExpired(queue, state, warn);
    const pending = queue.pending("inbound");
    if (action === "scan") {
      const items = [];
      let withheld = 0;
      const lanes = await laneSources(state);
      for (const item of pending) {
        queue.recovery.flag(item.id, item.payload);
        const current = await reauthorize(item.payload, cfg, rest);
        if (!current) {
          withheld++;
          items.push({ message_id: item.id, state: "withheld", read: "Current policy forbids replay; retain pending" });
          continue;
        }
        const status = queue.status("inbound", item.id);
        items.push({ message_id: item.id, sent_at: current.sent_at, role_at_scan: current.role,
          disposition: status.disposition, prior_reply_ids: priorReplies(state, item.id),
          review: queue.recovery.status(item.id)?.outcome, read: `ack show inbound ${item.id}` });
      }
      let pulls: unknown = [];
      let githubError: string | undefined;
      if (items.length) {
        try {
          pulls = await github(["pr", "list", "--state", "all", "--limit", "50",
            "--json", "number,title,state,url,mergedAt,updatedAt,closingIssuesReferences"]);
        } catch (error) {
          if (!(error instanceof Error)) throw error;
          githubError = error.message;
        }
      }
      const promptStore = new PromptStore(join(state, "discord-prompts.sqlite"));
      const prompts = promptStore.list(false).map((row) => ({ id: row.id, kind: row.kind, action: row.action, target: row.target,
        status: row.status, decided_by: row.decided_by, read: `helio confirm show ${row.id}` }));
      promptStore.close();
      const report = { observed_at: new Date().toISOString(), repo, pending: items.length, withheld,
        items, lanes, prompts, recent_pull_requests: pulls, github_error: githubError,
        github_limited: Array.isArray(pulls) && pulls.length === 50,
        instructions: "Read original messages; reconcile current outcomes before review. Prior reply is not proof of task completion. No review grants action authority. A confirmed button prompt is never acted on automatically after a restart: re-check current state, then use it inside its window or ask again." };
      const reportId = queue.recovery.saveReport(JSON.stringify(report));
      console.log(`RECOVERY_REPORT id=${reportId} pending=${items.length} withheld=${withheld} github=${githubError ? "unavailable" : "observed"} read="helio recovery show ${reportId}"`);
      console.log(`RECOVERY_PAGE ${detailPage(report, `helio recovery show ${reportId}`)}`);
      return;
    }
    if (!id || !/^\d{1,30}$/.test(id)) throw new TypeError("Expected source message ID");
    const item = pending.find((row) => row.id === id);
    if (!item) {
      console.log(`RECOVERY_HANDLED message_id=${id}; inspect recorded outcome, do not restart its conversation`);
      return;
    }
    const current = await reauthorize(item.payload, cfg, rest);
    if (!current) throw new RangeError("Source no longer authorized; retain pending");
    const outcome = options.get("--outcome");
    if (outcome !== "resume" && outcome !== "settled" && outcome !== "informational" && outcome !== "needs-review") {
      throw new TypeError("Choose resume, settled, informational or needs-review");
    }
    const reasonPath = options.get("--reason-file");
    if (!reasonPath) throw new TypeError("Review requires a reason file");
    const evidence: Record<string, unknown> = { observed_at: new Date().toISOString(), prior_replies: priorReplies(state, id) };
    for (const kind of ["pr", "issue"] as const) {
      const target = options.get(`--${kind}`);
      if (target) {
        if (!/^[1-9]\d*$/.test(target)) throw new TypeError("Expected numeric GitHub target");
        evidence[kind] = await github([kind, "view", target, "--json",
          kind === "pr" ? "number,state,url,mergedAt,headRefOid,closingIssuesReferences" : "number,state,stateReason,url"]);
      }
    }
    queue.recovery.review(id, item.payload, {
      outcome, reason: (await Bun.file(reasonPath).text()).trim(), evidence: JSON.stringify(evidence),
    });
    if (outcome === "settled" || outcome === "informational") {
      queue.acknowledge("inbound", id);
      await cleanupAttachments(id, join(state, "attachments/inbound"));
      await finishWorking({ store, rest, now: Date.now(), warn }, [id]);
    }
    console.log(`RECOVERY_REVIEWED message_id=${id} outcome=${outcome}; no external action or reply performed`);
  } finally { queue.close(); store.dispose(); }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    if (!(error instanceof Error)) throw error;
    console.error(`RECOVERY_WITHHELD ${error.message.replace(/[\r\n]/g, " ").slice(0, 1000)}`);
    process.exitCode = 2;
  });
}
