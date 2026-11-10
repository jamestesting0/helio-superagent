import { existsSync } from "node:fs";
import { Conversations, CONVERSATION_OUTCOMES, type Conversation } from "./conversations/conversations.ts";
import { audienceOf, conversationEntry } from "./conversations/conversation-context.ts";
import { detailPage } from "./delivery/context-render.ts";
import { followupStatus } from "./conversations/followup-status.ts";
import { Delivery } from "./delivery/delivery.ts";
import { object } from "./delivery/monitor-summary.ts";

const USAGE = "Usage: conversation list [--channel C] [--user U] [--offset N] | show TOPIC [--offset N] | open ANCHOR TITLE | " +
  "set TOPIC [--request T] [--decided T] [--waiting-on T] [--result T] [--job J] [--issue URL] (\"-\" clears) | " +
  "note TOPIC --text-file PATH | join TOPIC USER [--message ID] | leave TOPIC USER | merge FROM INTO | " +
  "hold TOPIC REASON | resume TOPIC | close TOPIC OUTCOME [--issue URL] | reopen TOPIC | migrate";
const COMMANDS = ["list", "show", "open", "set", "note", "join", "leave", "merge", "hold", "resume", "close", "reopen", "migrate"] as const;
const FLAGS: Record<typeof COMMANDS[number], readonly string[]> = {
  list: ["--channel", "--user", "--offset"], show: ["--offset"], open: [], note: ["--text-file"], join: ["--message"],
  set: ["--request", "--decided", "--waiting-on", "--result", "--job", "--issue"], leave: [], merge: [], hold: [],
  resume: [], close: ["--issue"], reopen: [], migrate: [],
};
const SET_FLAGS = new Map([["--request", "request"], ["--decided", "decided"], ["--waiting-on", "waiting_on"], ["--result", "result"]] as const);
const snowflake = (value: string | undefined): value is string => value !== undefined && /^\d{1,30}$/.test(value);
const ISSUE = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/[1-9]\d*$/;

const [requested, ...args] = process.argv.slice(2);
const action = COMMANDS.find(value => value === requested);
let store: Conversations | undefined;
try {
  const state = process.env.DORI_STATE_DIR;
  if (!state?.trim()) throw new TypeError("Requires DORI_STATE_DIR");
  if (!action) throw new TypeError(USAGE);
  const flagsAt = args.findIndex(arg => arg.startsWith("--"));
  const positional = flagsAt < 0 ? args : args.slice(0, flagsAt);
  const flags = flagsAt < 0 ? [] : args.slice(flagsAt);
  const options = new Map<string, string>();
  for (let i = 0; i < flags.length; i += 2) {
    const flag = flags[i]!, value = flags[i + 1];
    if (!value || options.has(flag) || !FLAGS[action].includes(flag)) throw new TypeError(`Invalid option ${flag}; ${USAGE}`);
    options.set(flag, value);
  }
  const offset = Number(options.get("--offset") ?? "0");
  if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError("Offset must be a nonnegative integer");
  for (const name of ["--channel", "--user", "--message"]) {
    if (options.has(name) && !snowflake(options.get(name))) throw new TypeError(`${name} takes a Discord ID`);
  }
  const issue = options.get("--issue");
  if (issue !== undefined && (!ISSUE.test(issue) || (process.env.HELIO_GITHUB_REPO &&
      !issue.startsWith(`https://github.com/${process.env.HELIO_GITHUB_REPO}/issues/`)))) {
    throw new TypeError("Issue must be a canonical GitHub issue URL in the configured repository");
  }
  const [topicId, second, ...rest] = positional;
  const counts: Record<typeof COMMANDS[number], (n: number) => boolean> = {
    list: n => n === 0, migrate: n => n === 0, show: n => n === 1, set: n => n === 1, note: n => n === 1, resume: n => n === 1,
    reopen: n => n === 1, open: n => n >= 2, hold: n => n >= 2, join: n => n === 2, leave: n => n === 2, merge: n => n === 2,
    close: n => n === 2,
  };
  if (!counts[action](positional.length)) throw new TypeError(USAGE);
  if (positional.length && !snowflake(topicId)) throw new TypeError("Topics are named by their anchor message ID");
  store = new Conversations(`${state}/discord-conversations.sqlite`);
  const now = Date.now();
  const active = (id: string): Conversation => {
    const row = store!.get("", "", id);
    if (!row) throw new RangeError(`No active topic ${id}`);
    return row;
  };
  switch (action) {
    case "migrate": console.log("CONVERSATION_MIGRATED"); break;
    case "list": {
      const channel = options.get("--channel"), user = options.get("--user");
      const rows = store.list().filter(row => (!channel || row.channel_id === channel ||
        store!.participants(row.anchor_message_id).some(person => person.last_channel_id === channel)) &&
        (!user || store!.isParticipant(row.anchor_message_id, user)));
      let bytes = 0, printed = 0;
      for (const row of rows.slice(offset, offset + 25)) {
        const line = `CONVERSATION ${JSON.stringify({
          topic_id: row.anchor_message_id, title: row.topic, state: store.state(row), channel_id: row.channel_id,
          opened_by: row.user_id, participants: store.participants(row.anchor_message_id).map(person => person.user_id),
          issue: row.issue, job: row.job, waiting_on: row.waiting_on, waiting_on_user: row.waiting_on_user,
          age_ms: Math.max(0, now - row.opened_at), idle_ms: Math.max(0, now - row.last_activity), summary: row.summary || row.topic,
        })}`;
        const size = Buffer.byteLength(line + "\n");
        if (bytes + size > 40_000 && printed) break;
        console.log(line);
        bytes += size;
        printed++;
      }
      if (offset + printed < rows.length) {
        console.log(`CONVERSATION_PAGE next="helio conversation list${channel ? ` --channel ${channel}` : ""}${user ? ` --user ${user}` : ""} --offset ${offset + printed}"`);
      }
      break;
    }
    case "show": {
      const row = store.topic(topicId!);
      if (!row) throw new RangeError(`No retained topic ${topicId}`);
      console.log(`CONVERSATION_SHOW ${detailPage({
        topic_id: row.anchor_message_id, ...row, state: store.state(row), idle_ms: Math.max(0, now - row.last_activity),
        participants: store.participants(row.anchor_message_id),
        subscriptions: followupStatus(`${state}/discord-conversations.sqlite`, row.anchor_message_id, now),
        transcript: store.transcriptOf(row),
      }, `helio conversation show ${row.anchor_message_id}`, offset)}`);
      break;
    }
    case "open": {
      const anchor = topicId!, title = [second, ...rest].join(" ");
      if (!title.trim() || title.length > 200) throw new TypeError("Open requires a title of 1-200 characters");
      const claim = store.working(anchor);
      let payload: Record<string, unknown> | undefined;
      if (existsSync(`${state}/discord-delivery.sqlite`)) {
        const delivery = new Delivery(`${state}/discord-delivery.sqlite`);
        try {
          const item = delivery.pending("inbound").find(entry => entry.id === anchor);
          if (item) payload = object(JSON.parse(item.payload));
        } finally { delivery.close(); }
      }
      const channel = typeof payload?.channel_id === "string" ? payload.channel_id : claim?.channel_id;
      const user = typeof payload?.author_id === "string" ? payload.author_id : claim?.user_id;
      if (!channel || !user) throw new RangeError("The anchor must be an inbound message Helio received");
      const row = store.open(channel, user, anchor, title, now);
      // A claim can precede opening the topic; record the claimed anchor now.
      if (payload && claim?.claimed_at != null && claim.closed_at === null) {
        store.append(channel, user, conversationEntry(payload), claim.claimed_at, { channel, audience: audienceOf(payload) });
      }
      console.log(`CONVERSATION_OPEN ${JSON.stringify({ topic_id: row.anchor_message_id, ...row })}`);
      break;
    }
    case "set": {
      const row = active(topicId!);
      const fields = Object.fromEntries([...SET_FLAGS].flatMap(([flag, name]) => options.has(flag) ?
        [[name, options.get(flag) === "-" ? "" : options.get(flag)]] : []));
      const job = options.get("--job");
      const result = store.setState(row.channel_id, row.user_id, { ...fields, ...(job ? { job } : {}), ...(issue ? { issue } : {}) },
        row.anchor_message_id, now);
      console.log(`CONVERSATION_SET topic=${row.anchor_message_id} fields=${[...Object.keys(fields), ...(job ? ["job"] : []), ...(issue ? ["issue"] : [])].join(",")}` +
        (result.anchor_message_id !== row.anchor_message_id ? ` merged_into=${result.anchor_message_id}` : ""));
      break;
    }
    case "note": {
      const row = active(topicId!), path = options.get("--text-file");
      if (!path) throw new TypeError("Note requires --text-file PATH");
      store.note(row.channel_id, row.user_id, (await Bun.file(path).text()).trim(), row.anchor_message_id);
      console.log(`CONVERSATION_NOTED topic=${row.anchor_message_id}`);
      break;
    }
    case "join": {
      const row = active(topicId!), user = second!, message = options.get("--message");
      if (!snowflake(user)) throw new TypeError("join takes a Discord user ID");
      let channel = row.channel_id, at = row.anchor_message_id;
      if (message) {
        const claim = store.working(message);
        if (!claim || claim.user_id !== user) throw new RangeError("--message must be that person's inbound message");
        channel = claim.channel_id;
        at = message;
      }
      store.join(row.anchor_message_id, user, "lead", channel, at, now);
      console.log(`CONVERSATION_JOINED topic=${row.anchor_message_id} user=${user}`);
      break;
    }
    case "leave": {
      store.leave(topicId!, second!);
      console.log(`CONVERSATION_LEFT topic=${topicId} user=${second}`);
      break;
    }
    case "merge": {
      if (!snowflake(second)) throw new TypeError("merge takes two topic anchor IDs");
      const row = store.merge(topicId!, second, now);
      console.log(`CONVERSATION_MERGED from=${topicId} into=${row.anchor_message_id}`);
      break;
    }
    case "hold": {
      const row = active(topicId!);
      store.hold(row.channel_id, row.user_id, [second, ...rest].join(" "), row.anchor_message_id);
      console.log(`CONVERSATION_HELD topic=${row.anchor_message_id}`);
      break;
    }
    case "resume": {
      const row = active(topicId!);
      store.resume(row.channel_id, row.user_id, row.anchor_message_id);
      console.log(`CONVERSATION_RESUMED topic=${row.anchor_message_id}`);
      break;
    }
    case "close": {
      const outcome = CONVERSATION_OUTCOMES.find(value => value === second);
      if (!outcome) throw new TypeError("Invalid conversation outcome");
      const row = active(topicId!);
      console.log(`CONVERSATION_CLOSED ${JSON.stringify(store.close(row.channel_id, row.user_id, outcome, now, issue, row.anchor_message_id))}`);
      break;
    }
    case "reopen": {
      const row = store.topic(topicId!);
      if (!row) throw new RangeError(`No retained topic ${topicId}`);
      console.log(`CONVERSATION_REOPENED ${JSON.stringify(store.reopen(row.channel_id, row.user_id, now, row.anchor_message_id))}`);
      break;
    }
    default: action satisfies never;
  }
} catch (error) {
  if (!(error instanceof Error)) throw error;
  console.log(`CONVERSATION_REFUSED ${error.message}`);
  process.exitCode = 2;
} finally { store?.dispose(); }
