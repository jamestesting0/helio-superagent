#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { loadConfig } from "./config.ts";
import { deadPaneTick, newDeadPaneState } from "./dead-panes.ts";
import { abandonLane, acknowledgeClaim, claimDone, closeLane, type FlowDeps, objectDone, watchTick } from "./done-flow.ts";
import { every, monitorLine } from "./monitor.ts";
import { freshnessTick } from "./freshness.ts";
import { acquireSlot, pidAlive, releaseSlot } from "./heavy-slot.ts";
import { guardTick, sampleHost } from "./host-guard.ts";
import { adoptLane, launchLane, LaunchError, wakeLane } from "./launch.ts";
import { lifecycleTick } from "./lifecycle.ts";
import { reapWorktrees, staleLanes } from "./reap.ts";
import { pauseLane, resumeLane } from "./pause.ts";
import { Registry, requestJob, statusOf } from "./registry.ts";
import { realClock, run } from "./run.ts";
import { syncRegistry } from "./sync.ts";
import { CompletionError, recordCompletion } from "./completion.ts";
import { parseSignal, splitDone } from "./signals.ts";
import { applyLanes, previewLanes } from "./reconcile.ts";
import { canLaunch } from "./routing.ts";
import { fetchHttp, MessengerError, UnsafeMessageError } from "./messenger/http.ts";
import { Slack } from "./messenger/slack.ts";
import { pollSlackInbound } from "./messenger/slack-inbound.ts";
import { ThreadLedger } from "./messenger/thread-ledger.ts";
import { slackPresence } from "./messenger/slack-presence.ts";
import { Telegram } from "./messenger/telegram.ts";
import { Discord, discordPresence } from "./messenger/discord.ts";
import { realTimers } from "./messenger/typing.ts";
import { reclaimLane } from "./reclaim.ts";
import { transcribe, TranscriptionError } from "./messenger/voice.ts";

const USAGE = `dori <command> [options]

  launch <key> --job J --title T --brief FILE --done "merged o/r#N; closed o/r#M" [--source REF] [--priority owner|normal] [--thread REF] [--model M] [--cwd DIR]
                                       one open lane per job (LANE_EXISTS); resumes the job's hibernated or closed lane;
                                       over the worker cap or host limits it prints LAUNCH_QUEUED and the watcher starts it later
  adopt  <key> --job J --pane ID --title T --brief FILE --done "..." [--source REF] [--thread REF]
  job-id --repository owner/repo --channel ID --source ORIGINAL_MESSAGE_ID
  sync   [--write]                     registry vs live panes; read-only unless --write
  claim-done [<key>] --evidence TEXT  key defaults to the lane registered for $HERDR_PANE_ID
  show <key>                          full lane evidence, claim, history and receipt (read-only)
  claim-ack <key>                     acknowledge receipt and start the 5-minute close window
  object-done <key> --reason TEXT [--reason TEXT ...]
  abandon <key> --reason TEXT [--stop] [--with-unpushed]   owner only: checkpoint/stop a quiescent agent and retire unfinished work; worktree kept
  close  <key> [--verify] [--note TEXT] close after live checks; --verify first records independent checks for a bound receipt
  completion <key>                    record independent passing checks and this attempt's Git revision under durable state
  reconcile preview --manifest FILE --job issue-N --repository OWNER/REPO [--failed KEY] [--replacement KEY]
  reconcile apply --manifest FILE     recheck exact records/resources; no public messages
  pause  <key> [--note TEXT]           the owner said wait: goal paused (read back), running turn stopped, no nudges; exit 3 if unconfirmed
  resume <key> [--note TEXT] [--brief FILE]   undo pause; or wake a hibernated or closed lane in its recorded session
  stale [--hours N] [--json]           lanes paused, not done, failed or awaiting cleanup for N hours (default 24)
  reap-worktrees [--apply] [--json]    remove worktrees of closed lanes whose PR settled 3+ days ago and that hold no unpushed work
  reclaim <key>                       checkpoint an owned idle session and release its slot; retain unfinished work and all files
  watch                                long-running: emits LANE_* lines every 30 s; hibernates idle lanes and starts queued launches
  freshness [--loop MIN]               nudge silent lanes, post their last report via hooks.threadReply
  dead-panes [--loop MIN]              print DEAD_PANE <id> for stopped agent panes
  guard [--loop MIN]                   host load, memory, disk and pane-count alerts
  heavy <label> -- <command ...>       run a heavy command when a slot is free and load is low
  can-launch                           exit 0 if the host has room for a new lane, else print why and exit 4
  send <slack|telegram|discord> --to TARGET (--text TEXT | --text-file PATH) [--thread ID] [--edit ID] [--ping ID,...]   (discord: TARGET user:ID or the owner ID sends a DM; --ping is for new Discord messages)
                                       post or edit a message (tokens from DORI_SLACK_TOKEN, DORI_TELEGRAM_TOKEN, DORI_DISCORD_TOKEN)
  presence <slack|discord>             keep the account shown as online until stopped
  transcribe <audio-file>              run hooks.transcribe and print the text
  inbound slack [--loop MIN]           print INBOUND lines: unread thread replies (threads view), replies in threads
                                       the Dori posted in (any helper), DMs and channels with unread mentions`;

const die = (message: string, code = 1): never => {
  console.error(message);
  process.exit(code);
};

const config = await loadConfig();
const deps: FlowDeps = { run, clock: realClock, registry: new Registry(config.stateDir), config };
const [command = "", ...rest] = process.argv.slice(2);

const flags = parseArgs({
  args: rest,
  allowPositionals: true,
  strict: false,
  options: {
    title: { type: "string" }, brief: { type: "string" }, done: { type: "string" }, thread: { type: "string" },
    model: { type: "string" }, cwd: { type: "string" }, pane: { type: "string" }, evidence: { type: "string" },
    reason: { type: "string", multiple: true }, note: { type: "string" }, write: { type: "boolean" }, "with-unpushed": { type: "boolean" }, loop: { type: "string" },
    job: { type: "string" }, priority: { type: "string" }, hours: { type: "string" }, json: { type: "boolean" }, apply: { type: "boolean" }, verify: { type: "boolean" }, stop: { type: "boolean" },
    source: { type: "string" }, repository: { type: "string" }, channel: { type: "string" },
    manifest: { type: "string" }, failed: { type: "string" }, replacement: { type: "string" },
    to: { type: "string" }, text: { type: "string" }, "text-file": { type: "string" }, edit: { type: "string" }, ping: { type: "string" },
  },
});
const opt = (name: string): string | undefined => {
  const v = flags.values[name];
  return typeof v === "string" ? v.trim() : undefined;
};
const need = (name: string): string => opt(name) || die(`--${name} is required`);
const key = flags.positionals[0];
const loopMin = Number(opt("loop") ?? 0);

const lane = async (k: string | undefined) => {
  const found = k ? await deps.registry.read(k) : await deps.registry.byPane(process.env.HERDR_PANE_ID ?? "");
  if (!found) return die(k ? `no registered lane "${k}"` : "no open lane is registered for this pane");
  if (statusOf(found) === "closed") return die(`lane ${found.key} is already closed`);
  return found;
};

try {
  switch (command) {
    case "launch": {
      const priority = opt("priority") ?? "normal";
      if (priority !== "owner" && priority !== "normal") die("--priority must be owner or normal");
      const r = await launchLane(deps, { key: key ?? "", title: need("title"), brief: need("brief"), done: need("done"), thread: opt("thread"), model: opt("model"), cwd: opt("cwd"), job: need("job"), source: opt("source"), priority: priority as "owner" | "normal" });
      if (r.lane) console.log(`LAUNCHED ${r.lane.key} pane=${r.lane.pane} tab=${r.lane.tab ?? "?"}`);
      console.log(r.startup);
      process.exit(/^(STARTUP_OK|LAUNCH_QUEUED|LANE_WOKEN)/.test(r.startup) ? 0 : 3);
    }
    case "adopt": {
      const l = await adoptLane(deps, { key: key ?? "", job: need("job"), source: opt("source"),
        title: need("title"), brief: need("brief"), done: need("done"), thread: opt("thread"), pane: need("pane") });
      console.log(`ADOPTED ${l.key} pane=${l.pane} thread=${l.thread}`);
      break;
    }
    case "job-id": {
      const repo = need("repository");
      if (process.env.HELIO_GITHUB_REPO && repo !== process.env.HELIO_GITHUB_REPO) die("Repository differs from HELIO_GITHUB_REPO");
      console.log(`JOB_ID ${requestJob(repo, need("channel"), need("source"))}`);
      break;
    }
    case "sync": {
      const r = await syncRegistry(deps, Boolean(flags.values.write));
      console.log("key | thread | pane | session | recorded work | execution");
      for (const row of [...r.rows, ...r.unregistered]) console.log([row.key, row.thread, row.pane, row.session, row.status,
        `${row.execution?.status ?? "unknown"}: ${row.execution?.reason ?? "No engine observation"}`].join(" | "));
      console.log(r.drift.length ? `DRIFT (${r.drift.length}):\n${r.drift.map((d) => `- ${d}`).join("\n")}` : "DRIFT none");
      console.log(flags.values.write ? "WROTE session ids" : "READ_ONLY");
      break;
    }
    case "claim-done":
      console.log(await claimDone(deps, await lane(key), need("evidence")));
      break;
    case "completion":
      console.log(`COMPLETION_RECORDED ${await recordCompletion(deps, await lane(key))}`);
      break;
    case "reconcile": {
      const allowed = key === "preview" ? ["manifest", "failed", "replacement", "job", "repository"] :
        key === "apply" ? ["manifest"] : [];
      if (!allowed.length || flags.positionals.length !== 1 || Object.keys(flags.values).some(name => !allowed.includes(name))) {
        die("Usage: dori reconcile preview|apply --manifest FILE; preview requires --job issue-N --repository OWNER/REPO and exact --failed/--replacement keys");
      }
      const path = need("manifest");
      if (key === "preview") {
        await previewLanes(deps, path, { failed: opt("failed"), replacement: opt("replacement"), job: need("job"), repository: need("repository") });
        console.log(`RECONCILE_PREVIEW manifest=${path}`);
      } else {
        const results = await applyLanes(deps, path);
        for (const result of results) console.log(`RECONCILE_LANE key=${result.key} outcome=${result.outcome}`);
        if (results.some(result => result.outcome === "changed")) process.exitCode = 3;
      }
      break;
    }
    case "show": {
      const found = await deps.registry.read(key ?? die("show needs a lane key"));
      if (!found) die(`no registered lane "${key}"`);
      console.log(JSON.stringify(found, null, 2));
      break;
    }
    case "claim-ack":
      console.log(await acknowledgeClaim(deps, await lane(key ?? die("claim-ack needs a lane key"))));
      break;
    case "object-done": {
      const reasons = (flags.values.reason as string[] | undefined)?.map((r) => r.trim()).filter(Boolean) ?? [];
      if (!reasons.length) die("--reason is required");
      console.log(await objectDone(deps, await lane(key ?? die("object-done needs a lane key")), reasons));
      break;
    }
    case "abandon": {
      const reason = ((flags.values.reason as string[] | undefined) ?? []).join("; ");
      const r = await abandonLane(deps, await lane(key ?? die("abandon needs a lane key")), reason || die("--reason is required"), Boolean(flags.values["with-unpushed"]), Boolean(flags.values.stop));
      for (const line of r.lines) console.log(line);
      process.exit(r.closed ? 0 : 2);
    }
    case "reclaim": {
      const result = await reclaimLane(deps, key ?? die("reclaim needs a lane key"));
      for (const line of result.lines) console.log(line);
      process.exitCode = result.released ? 0 : 2;
      break;
    }
    case "close": {
      const current = await lane(key ?? die("close needs a lane key"));
      if (flags.values.verify && current.launchState !== "failed" &&
          splitDone(current.done).some(signal => parseSignal(signal).kind === "file")) {
        await recordCompletion(deps, current);
      }
      const r = await closeLane(deps, current, opt("note") ?? "closed by the lead");
      for (const line of r.lines) console.log(line);
      process.exit(r.closed ? 0 : 2);
    }
    case "resume": {
      const found = await deps.registry.read(key ?? die("resume needs a lane key"));
      if (!found) die(`no registered lane "${key}"`);
      if (found && ["hibernated", "closed"].includes(statusOf(found))) {
        const brief = opt("brief");
        const r = await wakeLane(deps, found, { ...(brief ? { briefText: await Bun.file(brief).text() } : {}), note: opt("note") ?? "woken by the lead" });
        console.log(r.startup);
        break;
      }
      const r = await resumeLane(deps, await lane(key), opt("note") ?? "resumed by the lead");
      for (const line of r.lines) console.log(line);
      process.exit(r.code);
    }
    case "stale": {
      const rows = await staleLanes(deps, Number(opt("hours") ?? 24));
      if (flags.values.json) console.log(JSON.stringify(rows));
      else for (const r of rows) console.log(`STALE_LANE ${r.key} job=${r.job} status=${r.status} age_hours=${r.age_hours} unpushed=${r.has_unpushed}`);
      break;
    }
    case "reap-worktrees": {
      const rows = await reapWorktrees(deps, Boolean(flags.values.apply));
      if (flags.values.json) console.log(JSON.stringify(rows));
      else for (const r of rows) console.log(`WORKTREE ${r.action} ${r.key} ${JSON.stringify(r.reason)}`);
      break;
    }
    case "pause": {
      const r = await pauseLane(deps, await lane(key ?? die("pause needs a lane key")), opt("note") ?? "paused by the lead");
      for (const line of r.lines) console.log(line);
      process.exit(r.code);
    }
    case "watch":
      console.log("LANE_WATCH_READY");
      for (;;) {
        const current = { ...deps, config: await loadConfig() };
        for (const line of await watchTick(current).catch((e: unknown) => [monitorLine(`LANE_WATCH_ERROR ${String(e)}`)])) console.log(line);
        for (const line of await lifecycleTick(current).catch((e: unknown) => [monitorLine(`LANE_LIFECYCLE_ERROR ${String(e)}`)])) console.log(line);
        if (current.config.runtimeRevision) {
          mkdirSync(current.config.stateDir, { recursive: true, mode: 0o700 });
          const path = join(current.config.stateDir, "config-applied.json");
          const temporary = `${path}.${process.pid}.tmp`;
          const identity = process.platform === "linux" ? readFileSync("/proc/self/stat", "utf8").split(") ").at(-1)?.split(" ")[19] : null;
          writeFileSync(temporary, JSON.stringify({ revision: current.config.runtimeRevision, pid: process.pid,
            start_ticks: identity, at_ms: Date.now() }), { mode: 0o600 });
          renameSync(temporary, path);
        }
        await Bun.sleep(30_000);
      }
    case "freshness":
      await every(loopMin, async () => {
        for (const a of await freshnessTick(deps, process.env.HOME ?? "")) console.log(monitorLine(`${a.kind.toUpperCase()} ${a.lane} ${a.detail}`));
      }, "FRESHNESS_ERROR");
      break;
    case "dead-panes": {
      const seen = new Set<string>();
      const paneState = newDeadPaneState();
      await every(loopMin, async () => {
        const lanePanes = new Set((await deps.registry.list()).filter((lane) => statusOf(lane) !== "closed" && lane.pane).map((lane) => lane.pane!));
        for (const line of await deadPaneTick(run, config, seen, new Date().toISOString().slice(0, 13), paneState, lanePanes)) console.log(monitorLine(line));
      }, "DEAD_PANES_ERROR");
      break;
    }
    case "guard": {
      const state = { alerting: false };
      console.log("HOST_GUARD_READY");
      await every(loopMin, async () => {
        for (const line of guardTick(await sampleHost(run), config.guard, state)) console.log(monitorLine(line));
      }, "GUARD_ERROR");
      break;
    }
    case "heavy": {
      const sep = rest.indexOf("--");
      const label = rest[0];
      const cmd = sep >= 0 ? rest.slice(sep + 1) : [];
      if (!label || label === "--" || !cmd.length) die("usage: dori heavy <label> -- <command ...>");
      const load = async () => (await sampleHost(run)).load1;
      const slot = await acquireSlot({ dir: `${config.stateDir}/heavy`, slots: config.heavySlots, maxLoad: config.heavyMaxLoad, clock: realClock, load, alive: pidAlive, pid: process.pid }, label ?? "");
      try {
        const child = Bun.spawn(cmd, { stdout: "inherit", stderr: "inherit", stdin: "inherit" });
        process.exitCode = await child.exited;
      } finally {
        releaseSlot(slot);
      }
      break;
    }
    case "can-launch": {
      const v = canLaunch(await sampleHost(run), config.guard);
      console.log(v.ok ? "CAN_LAUNCH" : `HOLD ${v.reasons.join(" | ")}`);
      process.exit(v.ok ? 0 : 4);
    }
    case "send": {
      const platform = key ?? die("send needs slack, telegram or discord");
      const to = need("to");
      // --text-file keeps message text away from any shell, where `code` and $(...) would be executed and lost.
      const textFile = opt("text-file");
      const text = textFile ? (await Bun.file(textFile).text()).replace(/\s+$/, "") || die("--text-file is empty") : need("text");
      const thread = opt("thread");
      const edit = opt("edit"); if (opt("ping") && (platform !== "discord" || edit)) die("--ping is for new Discord messages");
      const token = (name: string) => process.env[name] ?? die(`${name} is not set`);
      if (platform === "slack") {
        const slack = new Slack(fetchHttp, realClock, { token: token("DORI_SLACK_TOKEN"), cookie: process.env.DORI_SLACK_COOKIE }, undefined, new ThreadLedger(`${config.stateDir}/slack-threads.json`));
        if (edit) await slack.edit(to, edit, text);
        else console.log(`SENT ${(await slack.post(to, text, thread)).ts}`);
      } else if (platform === "telegram") {
        const tg = new Telegram(fetchHttp, realClock, token("DORI_TELEGRAM_TOKEN"));
        const target = { chatId: to, ...(thread ? { threadId: Number(thread) } : {}) };
        if (edit) await tg.edit(target, Number(edit), text);
        else console.log(`SENT ${await tg.send(target, text)}`);
      } else if (platform === "discord") {
        const dc = new Discord(fetchHttp, realClock, token("DORI_DISCORD_TOKEN"));
        const user = to.startsWith("user:") ? to.slice(5) : to === process.env.DORI_DISCORD_OWNER_ID ? to : undefined;
        const channel = user ? await dc.openDm(user) : to;
        if (edit) await dc.edit(channel, edit, text);
        else console.log(`SENT ${await dc.send(thread ?? channel, text, (opt("ping") ?? "").split(",").map(id => id.trim()).filter(Boolean))}`);
      } else die(`unknown platform ${platform}`);
      break;
    }
    case "presence": {
      if (key === "slack") {
        const auth = { token: process.env.DORI_SLACK_TOKEN ?? die("DORI_SLACK_TOKEN is not set"), cookie: process.env.DORI_SLACK_COOKIE ?? die("DORI_SLACK_COOKIE is not set (user-token presence needs the d cookie)") };
        const p = slackPresence(new Slack(fetchHttp, realClock, auth), (url, headers) => {
          const options: Bun.WebSocketOptions = { headers: { ...headers } };
          const ws = new WebSocket(url, options);
          return { isOpen: () => ws.readyState === WebSocket.OPEN, send: (f) => ws.send(f), close: () => ws.close() };
        }, auth);
        console.log("PRESENCE_READY slack");
        await every(1, async () => console.log(`PRESENCE slack ${await p.hold()}`));
      } else if (key === "discord") {
        const token = process.env.DORI_DISCORD_TOKEN ?? die("DORI_DISCORD_TOKEN is not set");
        discordPresence(() => {
          const ws = new WebSocket("wss://gateway.discord.gg/?v=10&encoding=json");
          let handler: (d: string) => void = () => {};
          ws.addEventListener("message", (e) => handler(String(e.data)));
          return { send: (d) => ws.send(d), close: () => ws.close(), onMessage: (cb) => { handler = cb; } };
        }, token, realTimers);
        console.log("PRESENCE_READY discord");
        await new Promise(() => {});
      } else die("presence needs slack or discord");
      break;
    }
    case "inbound": {
      if (key !== "slack") die("inbound supports slack");
      const auth = { token: process.env.DORI_SLACK_TOKEN ?? die("DORI_SLACK_TOKEN is not set"), cookie: process.env.DORI_SLACK_COOKIE };
      const ledger = new ThreadLedger(`${config.stateDir}/slack-threads.json`);
      const slack = new Slack(fetchHttp, realClock, auth, undefined, ledger);
      const me = String((await slack.call("auth.test", {})).user_id ?? die("auth.test returned no user_id"));
      console.log("INBOUND_READY slack");
      await every(loopMin, async () => {
        for (const i of await pollSlackInbound(slack, ledger, { selfUserId: me })) console.log(`INBOUND ${i.source} ${i.channel} ${i.threadTs ?? "-"} ${i.ts || "-"} ${i.user ?? "-"} ${JSON.stringify((i.text ?? "").slice(0, 200))}`);
      });
      break;
    }
    case "transcribe":
      console.log(await transcribe(run, config.hooks.transcribe, key ?? die("transcribe needs an audio file path")));
      break;
    default:
      console.log(USAGE);
      process.exit(command ? 1 : 0);
  }
} catch (e) {
  if (e instanceof CompletionError) die(e.message, 2);
  if (e instanceof LaunchError || e instanceof UnsafeMessageError || e instanceof MessengerError || e instanceof TranscriptionError) die(e.message);
  throw e;
}
