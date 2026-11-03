import { Discord, discordText } from "./vendor/dori-mode/scripts/src/messenger/discord.ts";
import { fetchHttp } from "./vendor/dori-mode/scripts/src/messenger/http.ts";
import { realClock } from "./vendor/dori-mode/scripts/src/run.ts";

export async function sendReply(
  discord: Discord,
  target: { readonly channel_id: string; readonly message_id: string },
  text: string,
): Promise<string> {
  if (!/^[0-9]+$/.test(target.channel_id) || !/^[0-9]+$/.test(target.message_id)) {
    throw new TypeError("Expected inbound Discord channel_id and message_id snowflakes");
  }
  return (await discord.call<{ id: string }>("POST", `/channels/${target.channel_id}/messages`, {
    content: discordText(text),
    message_reference: {
      type: 0,
      channel_id: target.channel_id,
      message_id: target.message_id,
      fail_if_not_exists: true,
    },
    allowed_mentions: { parse: [], replied_user: true },
  })).id;
}

if (import.meta.main) {
  const [channel_id, message_id, text, ...extra] = process.argv.slice(2);
  const token = process.env.DORI_DISCORD_TOKEN;
  if (channel_id === undefined || message_id === undefined || text === undefined || extra.length || !token) {
    console.error("Usage: bun reply.ts CHANNEL_ID MESSAGE_ID TEXT; requires DORI_DISCORD_TOKEN");
    process.exitCode = 2;
  } else {
    const discord = new Discord(fetchHttp, realClock, token);
    console.log(`SENT ${await sendReply(discord, { channel_id, message_id }, text)}`);
  }
}
