import { terminalNotification, NotificationUndeliverable } from "./conversations/terminal-notification.ts";
import { discordRest, DiscordRestError, type Rest } from "./discord/rest.ts";
import { filterConfig } from "./intake/authorization.ts";

const [issue, topic, textFile] = process.argv.slice(2);
const state = process.env.DORI_STATE_DIR, token = process.env.DORI_DISCORD_TOKEN;
if (!issue || !/^[1-9]\d*$/.test(issue) || !topic || !/^\d+$/.test(topic) || !textFile || !state || !token) {
  console.error("Usage: bun notification.ts ISSUE TOPIC TEXT_FILE; requires DORI_STATE_DIR and DORI_DISCORD_TOKEN");
  process.exitCode = 1;
} else {
  const signal = AbortSignal.timeout(80_000), base = discordRest(token);
  const rest: Rest = (path, init) => base(path, { ...init, signal });
  try {
    const outcomes = await terminalNotification({ state, repo: process.env.HELIO_GITHUB_REPO ?? "jamestesting0/elo-bot",
      issue: Number(issue), topic, text: (await Bun.file(textFile).text()).trim(),
      config: () => filterConfig(process.env), rest, now: () => Date.now() });
    for (const outcome of outcomes) {
      console.log(outcome.disposition === "sent" ? `NOTIFICATION_SENT channel=${outcome.channel_id} message=${outcome.reply_id}` :
        `NOTIFICATION_UNDELIVERABLE channel=${outcome.channel_id}: no message from its participants remains; tell the owner once`);
    }
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    if (error instanceof NotificationUndeliverable) {
      console.log(`NOTIFICATION_UNDELIVERABLE issue=${issue} topic=${topic}: ${error.message}`);
    } else {
      process.exitCode = error instanceof RangeError || error instanceof TypeError ? 1 : 2;
      const outcome = error instanceof DiscordRestError && error.status === 403 ? "PERMISSION_DENIED" :
        process.exitCode === 1 ? "REFUSED" : "PENDING";
      console.log(`NOTIFICATION_${outcome} ${error.message}`.replaceAll("\n", " "));
    }
  }
}
