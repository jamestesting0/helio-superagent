import { existsSync } from "node:fs";
import { Conversations, CONVERSATION_OUTCOMES } from "./conversations/conversations.ts";
import { conversationEntry } from "./conversations/conversation-context.ts";
import { detailPage } from "./delivery/context-render.ts";
import { Delivery } from "./delivery/delivery.ts";
import { object } from "./delivery/monitor-summary.ts";

const [requestedAction, ...args] = process.argv.slice(2);
const COMMANDS = ["list", "show", "open", "close", "note", "hold", "resume", "reopen"] as const;
const action = COMMANDS.find((value) => value === requestedAction);
let store: Conversations | undefined;
try {
  const state = process.env.DORI_STATE_DIR;
  if (!state?.trim()) throw new TypeError("Requires DORI_STATE_DIR");
  if (!action) {
    throw new TypeError("Usage: conversation open|close|list|show|note|hold|resume|reopen; note <channel> <user> --text-file PATH");
  }
  const flagsAt = args.findIndex((arg) => arg.startsWith("--"));
  const positional = flagsAt < 0 ? args : args.slice(0, flagsAt);
  const flags = flagsAt < 0 ? [] : args.slice(flagsAt);
  const options = new Map<string, string>();
  for (let i = 0; i < flags.length; i += 2) {
    const flag = flags[i], value = flags[i + 1];
    if (!flag || !value || options.has(flag) ||
        !(flag === "--offset" && (action === "list" || action === "show") ||
          flag === "--text-file" && action === "note" || flag === "--issue" && action === "close")) {
      throw new TypeError("Invalid conversation options");
    }
    options.set(flag, value);
  }
  const offset = Number(options.get("--offset") ?? "0");
  if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError("Offset must be a nonnegative integer");
  const [channel, user, argument, ...words] = positional;
  if (action === "list" ? positional.length !== 0 :
    !channel || !user || !/^\d{1,30}$/.test(channel) || !/^\d{1,30}$/.test(user)) {
    throw new TypeError("Channel and user IDs must be digits; list takes no positional arguments");
  }
  const topic = words.join(" ");
  const outcome = CONVERSATION_OUTCOMES.find((value) => value === argument);
  if (action === "open" && (!argument || !/^\d{1,30}$/.test(argument) || !topic.trim() || topic.length > 200)) {
    throw new TypeError("Open requires a digit anchor message ID and a topic of 1-200 characters");
  }
  if (action === "close" && (!outcome || words.length)) throw new TypeError("Invalid conversation outcome");
  if (["show", "note", "resume", "reopen"].includes(action ?? "") && positional.length !== 2) {
    throw new TypeError("This command takes only channel and user IDs");
  }
  if (action === "hold" && !argument) throw new TypeError("Hold requires a reason");
  const issue = options.get("--issue");
  if (issue && (issue.length > 500 || !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/[1-9]\d*$/.test(issue))) {
    throw new TypeError("Issue must be a canonical GitHub issue URL");
  }
  store = new Conversations(`${state}/discord-conversations.sqlite`);
  const now = Date.now();
  if (action === "list") {
    const rows = store.list();
    let bytes = 0, printed = 0;
    for (const row of rows.slice(offset, offset + 25)) {
      const line = `CONVERSATION ${JSON.stringify({
        ...row, state: store.state(row), age_ms: Math.max(0, now - row.opened_at), idle_ms: Math.max(0, now - row.last_activity),
        summary: row.summary || row.topic,
      })}`;
      const size = Buffer.byteLength(line + "\n");
      if (bytes + size > 40_000 && printed) break;
      console.log(line);
      bytes += size;
      printed++;
    }
    if (offset + printed < rows.length) console.log(`CONVERSATION_PAGE next="helio conversation list --offset ${offset + printed}"`);
  } else if (channel && user) {
    switch (action) {
      case "show": {
        const row = store.get(channel, user) ?? store.latest(channel, user);
        if (!row) throw new RangeError("No conversation in this channel");
        console.log(`CONVERSATION_SHOW ${detailPage({
          ...row, state: store.state(row), idle_ms: Math.max(0, now - row.last_activity),
          transcript: store.transcript(channel, user),
        }, `helio conversation show ${channel} ${user}`, offset)}`);
        break;
      }
      case "note": {
        const path = options.get("--text-file");
        if (!path) throw new TypeError("Note requires --text-file PATH");
        store.note(channel, user, (await Bun.file(path).text()).trim());
        console.log(`CONVERSATION_NOTED channel=${channel} user=${user}`);
        break;
      }
      case "hold":
        store.hold(channel, user, [argument, ...words].join(" "));
        console.log(`CONVERSATION_HELD channel=${channel} user=${user}`);
        break;
      case "resume":
        store.resume(channel, user);
        console.log(`CONVERSATION_RESUMED channel=${channel} user=${user}`);
        break;
      case "close":
        if (outcome) console.log(`CONVERSATION_CLOSED ${JSON.stringify(store.close(channel, user, outcome, now, issue))}`);
        break;
      case "open": case "reopen": {
        const previous = store.recentlyResolved(channel, user, now);
        const row = action === "open" && argument ? store.open(channel, user, argument, topic, now) : store.reopen(channel, user, now);
        // A claim can precede the first clarification or the decision to reopen.
        if (existsSync(`${state}/discord-delivery.sqlite`)) {
          const delivery = new Delivery(`${state}/discord-delivery.sqlite`);
          try {
            for (const item of delivery.pending("inbound")) {
              const claim = store.working(item.id);
              if (claim?.channel_id !== channel || claim.user_id !== user || claim.claimed_at === null ||
                  claim.closed_at !== null || (action === "open" ? item.id !== argument :
                    claim.claimed_at < (previous?.resolved_at ?? now))) continue;
              store.append(channel, user, conversationEntry(object(JSON.parse(item.payload))), claim.claimed_at);
            }
          } finally { delivery.close(); }
        }
        console.log(`${action === "open" ? "CONVERSATION_OPEN" : "CONVERSATION_REOPENED"} ${JSON.stringify(row)}`);
        break;
      }
      default: action satisfies never;
    }
  }
} catch (error) {
  if (!(error instanceof Error)) throw error;
  console.log(`CONVERSATION_REFUSED ${error.message}`);
  process.exitCode = 2;
} finally { store?.dispose(); }
