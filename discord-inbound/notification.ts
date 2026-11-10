import { terminalNotification, NotificationUndeliverable } from "./conversations/terminal-notification.ts";
import { discordRest, DiscordRestError, type Rest } from "./discord/rest.ts";
import { filterConfig } from "./intake/authorization.ts";

const [issue, user, textFile] = process.argv.slice(2);
const state = process.env.DORI_STATE_DIR, token = process.env.DORI_DISCORD_TOKEN;
if (!issue || !/^[1-9]\d*$/.test(issue) || !user || !/^\d+$/.test(user) || !textFile || !state || !token) {
  console.error("Usage: bun notification.ts ISSUE USER TEXT_FILE; requires DORI_STATE_DIR and DORI_DISCORD_TOKEN");
  process.exitCode = 1;
} else {
  const signal = AbortSignal.timeout(45_000), base = discordRest(token);
  const rest: Rest = (path, init) => base(path, { ...init, signal });
  try {
    const id = await terminalNotification({ state, repo: process.env.HELIO_GITHUB_REPO ?? "jamestesting0/elo-bot",
      issue: Number(issue), user, text: (await Bun.file(textFile).text()).trim(),
      config: () => filterConfig(process.env), rest, now: () => Date.now() });
    console.log(id ? `NOTIFICATION_SENT ${id}` : "NOTIFICATION_CLOSED");
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    if (error instanceof NotificationUndeliverable) {
      console.log(`REPLY_FOLLOWUP_CLOSED issue=${issue} user=${user}: ${error.message}`);
    } else {
      process.exitCode = error instanceof RangeError || error instanceof TypeError ? 1 : 2;
      const outcome = error instanceof DiscordRestError && error.status === 403 ? "PERMISSION_DENIED" :
        process.exitCode === 1 ? "REFUSED" : "PENDING";
      console.log(`NOTIFICATION_${outcome} ${error.message}`.replaceAll("\n", " "));
    }
  }
}
