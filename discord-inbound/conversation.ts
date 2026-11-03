import { Conversations, CONVERSATION_OUTCOMES } from "./conversations.ts";

const [action, channel, user, argument, ...words] = process.argv.slice(2);
let store: Conversations | undefined;
try {
  const state = process.env.DORI_STATE_DIR;
  if (!state?.trim()) throw new TypeError("Requires DORI_STATE_DIR");
  if (action !== "list" && action !== "open" && action !== "close") {
    throw new TypeError("Usage: conversation open <channel_id> <user_id> <anchor_message_id> <topic...> | close <channel_id> <user_id> <outcome> | list");
  }
  if (action === "list" ? channel !== undefined :
    !channel || !user || !/^\d+$/.test(channel) || !/^\d+$/.test(user)) {
    throw new TypeError("Channel and user IDs must be digits; list takes no arguments");
  }
  const topic = words.join(" ");
  if (action === "open" && (!argument || !/^\d+$/.test(argument) || !topic.trim() || topic.length > 200)) {
    throw new TypeError("Open requires a digit anchor message ID and a topic of 1-200 characters");
  }
  const outcome = CONVERSATION_OUTCOMES.find((value) => value === argument);
  if (action === "close" && (!outcome || words.length)) throw new TypeError("Invalid conversation outcome");
  store = new Conversations(`${state}/discord-conversations.sqlite`);
  if (action === "list") {
    for (const row of store.list()) console.log(`CONVERSATION ${JSON.stringify(row)}`);
  } else if (action === "open" && channel && user && argument) {
    console.log(`CONVERSATION_OPEN ${JSON.stringify(store.open(channel, user, argument, topic, Date.now()))}`);
  } else if (action === "close" && channel && user && outcome) {
    console.log(`CONVERSATION_CLOSED ${JSON.stringify(store.close(channel, user, outcome, Date.now()))}`);
  }
} catch (error) {
  if (!(error instanceof Error)) throw error;
  console.log(`CONVERSATION_REFUSED ${error.message}`);
  process.exitCode = 2;
} finally { store?.dispose(); }
