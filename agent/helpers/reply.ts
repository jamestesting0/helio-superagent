import { Discord, discordText } from "./vendor/dori-mode/scripts/src/messenger/discord.ts";
import { fetchHttp } from "./vendor/dori-mode/scripts/src/messenger/http.ts";
import { realClock } from "./vendor/dori-mode/scripts/src/run.ts";

/** `mentionUsers` may be pinged by name in `text`; every other mention stays silent. */
export async function sendReply(
  discord: Discord,
  target: { readonly channel_id: string; readonly message_id: string },
  text: string,
  mentionUsers: readonly string[] = [],
): Promise<string> {
  if (!/^[0-9]+$/.test(target.channel_id) || !/^[0-9]+$/.test(target.message_id) ||
      mentionUsers.some((id) => !/^[0-9]+$/.test(id))) {
    throw new TypeError("Expected inbound Discord channel_id and message_id snowflakes");
  }
  const users = [...new Set(mentionUsers)].slice(0, 100);
  return (await discord.call<{ id: string }>("POST", `/channels/${target.channel_id}/messages`, {
    content: discordText(text),
    message_reference: {
      type: 0,
      channel_id: target.channel_id,
      message_id: target.message_id,
      fail_if_not_exists: true,
    },
    allowed_mentions: { parse: [], replied_user: true, ...(users.length ? { users } : {}) },
  })).id;
}

const USAGE = "Usage: bun reply.ts CHANNEL_ID MESSAGE_ID (--text-file PATH | TEXT) [--covers ID,...] [--seen ID,...]; requires DORI_DISCORD_TOKEN (and DORI_STATE_DIR for the newer-message check)";

// --text-file keeps reply text away from any shell: inside a shell command string, `code` and $(...) are executed and vanish.
export function parseArgs(argv: readonly string[]):
  { channel_id: string; message_id: string; text: string; text_file?: string; covers: string[]; seen: string[] } | undefined {
  const positional: string[] = [];
  let textFile: string | undefined;
  const lists: Record<"--covers" | "--seen", string[]> = { "--covers": [], "--seen": [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (positional.length === 2 && textFile === undefined && arg === "--text-file") {
      textFile = argv[++i];
      if (!textFile) return undefined;
    } else if ((positional.length === 3 || textFile !== undefined) && (arg === "--covers" || arg === "--seen")) {
      const ids = (argv[++i] ?? "").split(",").map((id) => id.trim()).filter(Boolean);
      if (!ids.length || ids.some((id) => !/^[0-9]{1,30}$/.test(id))) return undefined;
      lists[arg].push(...ids);
    } else if (textFile === undefined && positional.length < 3) positional.push(arg);
    else return undefined;
  }
  const [channel_id, message_id, text] = positional;
  if (channel_id === undefined || message_id === undefined || (text === undefined && textFile === undefined)) return undefined;
  return { channel_id, message_id, text: text ?? "", ...(textFile !== undefined ? { text_file: textFile } : {}),
    covers: lists["--covers"], seen: lists["--seen"] };
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  const token = process.env.DORI_DISCORD_TOKEN;
  const state = process.env.DORI_STATE_DIR;
  if (args?.text_file !== undefined) args.text = (await Bun.file(args.text_file).text()).replace(/\s+$/, "");
  if (!args || !token || !args.text.trim()) {
    console.error(USAGE);
    process.exitCode = 2;
  } else {
    const discord = new Discord(fetchHttp, realClock, token);
    const send = (mentions: readonly string[]) =>
      sendReply(discord, { channel_id: args.channel_id, message_id: args.message_id }, args.text, mentions);
    if (!state) {
      console.log("REPLY_WARN DORI_STATE_DIR is not set; sending without the newer-message check");
      console.log(`SENT ${await send([])}`);
    } else {
      // Loaded only here, so sendReply stays usable without the intake package's dependencies.
      const [{ Delivery }, { Conversations }, { discordRest }, { cleanupAttachments }, { guardedReply }, { sendOnce, findSentReply }] = await Promise.all([
        import("../discord-inbound/delivery/delivery.ts"), import("../discord-inbound/conversations/conversations.ts"),
        import("../discord-inbound/discord/rest.ts"), import("../discord-inbound/messages/images.ts"), import("../discord-inbound/conversations/reply-guard.ts"),
        import("../discord-inbound/conversations/reply-once.ts"),
      ]);
      const delivery = new Delivery(`${state}/discord-delivery.sqlite`);
      const store = new Conversations(`${state}/discord-conversations.sqlite`);
      try {
        const rest = discordRest(token);
        const bot = store.list().some((row) => row.channel_id === args.channel_id) ?
          await rest<{ id: string }>("/users/@me") : undefined;
        const content = discordText(args.text);
        const once = async (mentions: readonly string[]) => {
          const sent = await sendOnce({
            path: `${state}/reply-sends.sqlite`, target: args.message_id, text: content, now: () => Date.now(),
            sleep: (ms) => Bun.sleep(ms), send: () => send(mentions),
            findSent: () => findSentReply(rest, args, content),
          });
          if (sent.duplicate) console.log(`REPLY_DUPLICATE ${sent.id} this reply was already sent; nothing was sent again`);
          return sent.id;
        };
        const result = await guardedReply({
          delivery, store, rest, channel: args.channel_id, target: args.message_id,
          covers: args.covers, seen: args.seen, send: once,
          cleanup: (id) => cleanupAttachments(id, `${state}/attachments/inbound`),
          now: () => Date.now(), warn: (message) => console.log(`REPLY_WARN ${message}`),
          owner: process.env.DORI_DISCORD_OWNER_ID,
          ...(bot ? { replyEntry: {
            author_id: bot.id, author: "Helio", bot: true, content: discordText(args.text), attachment_count: 0,
          } } : {}),
        });
        for (const line of result.lines) console.log(line);
        process.exitCode = result.code;
      } finally {
        delivery.close();
        store.dispose();
      }
    }
  }
}
