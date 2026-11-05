import { Conversations } from "./conversations/conversations.ts";
import { Delivery } from "./delivery/delivery.ts";
import { settleBlock } from "./delivery/moderation-effects.ts";
import { ownerApproved } from "./delivery/owner-proof.ts";
import { discordRest } from "./discord/rest.ts";

const USAGE = "Usage: blacklist list | add USER_ID --reason TEXT (--message M --channel C | --question ID) | " +
  "remove USER_ID (--message M --channel C | --question ID) | asked USER_ID --question ID";
const [action, user, ...flags] = process.argv.slice(2);
const options = new Map<string, string>();
for (let i = 0; i < flags.length; i += 2) {
  const name = flags[i], value = flags[i + 1];
  if (!name?.startsWith("--") || value === undefined || options.has(name)) {
    console.error(USAGE);
    process.exit(2);
  }
  options.set(name, value);
}
const state = process.env.DORI_STATE_DIR;
const ownerId = process.env.DORI_DISCORD_OWNER_ID ?? "";
const ID = /^\d{1,30}$/;
if (!state || !ownerId || !["list", "add", "remove", "asked"].includes(action ?? "") ||
    (action === "list" ? user !== undefined : !ID.test(user ?? "")) ||
    (action === "add" && !options.get("--reason")?.trim()) || (action === "asked" && !options.get("--question"))) {
  console.error(USAGE + "; requires DORI_STATE_DIR and DORI_DISCORD_OWNER_ID");
  process.exit(2);
}

const delivery = new Delivery(`${state}/discord-delivery.sqlite`);
const conversations = new Conversations(`${state}/discord-conversations.sqlite`);
const warn = (message: string) => console.error(`BLACKLIST_WARN ${message.slice(0, 900)}`);
const rest = process.env.DORI_DISCORD_TOKEN ? discordRest(process.env.DORI_DISCORD_TOKEN) : undefined;
// The installed trusted-users file is the current list (the same file the ack and inbound wrappers load).
const trustedFile = Bun.file(`${process.env.HOME ?? ""}/.dori/elobot/trusted-users`);
const trusted = [process.env.DORI_DISCORD_TRUSTED_IDS ?? "", await trustedFile.exists() ? await trustedFile.text() : ""].join(",");
const protectedIds = new Set([ownerId, ...trusted.split(/[,\s]+/).map((id) => id.trim()).filter(Boolean)]);
try {
  if (action === "list") {
    for (const row of delivery.moderation.list()) console.log(`BLACKLISTED ${JSON.stringify(row)}`);
    console.log(`BLACKLIST_COUNT ${delivery.moderation.list().length}`);
  } else if (action === "asked") {
    if (!delivery.moderation.reviewing(user as string, options.get("--question") as string)) {
      throw new RangeError(`User ${user} has no automatic blacklist entry`);
    }
    console.log(`BLACKLIST_ASKED user=${user} question=${options.get("--question")}`);
  } else {
    const approval = await ownerApproved({ ownerId, rest, questionsPath: `${state}/discord-questions.sqlite`, now: Date.now() },
      user as string, action as "add" | "remove",
      { message: options.get("--message"), channel: options.get("--channel"), question: options.get("--question") });
    if (action === "add") {
      if (protectedIds.has(user as string)) throw new RangeError(`User ${user} is the owner or trusted and cannot be blacklisted`);
      const result = delivery.moderation.withProof(approval, user as string, "add", Date.now(), () =>
        delivery.block(user as string, { source: "owner", reason: options.get("--reason") as string, by: ownerId }, protectedIds));
      if (result === "repeat") {
        await settleBlock({ delivery, conversations, rest, stateDir: state, warn }, user as string, { dismissed: [] });
        console.log(`BLACKLIST_UNCHANGED user=${user} already blacklisted with proof="${approval}"`);
      }
      else {
        await settleBlock({ delivery, conversations, rest, stateDir: state, warn }, user as string, result);
        console.log(`BLACKLIST_ADDED user=${user} source=owner proof="${approval}" dismissed=${result.dismissed.length}`);
      }
    } else {
      const result = delivery.moderation.withProof(approval, user as string, "remove", Date.now(), () => {
        if (!delivery.moderation.unblock(user as string)) throw new RangeError(`User ${user} is not blacklisted`);
      });
      console.log(result === "repeat" ? `BLACKLIST_UNCHANGED user=${user} not blacklisted` : `BLACKLIST_REMOVED user=${user} proof="${approval}"`);
    }
  }
} catch (error) {
  if (!(error instanceof RangeError)) throw error;
  console.log(`BLACKLIST_REFUSED ${error.message}`);
  process.exitCode = 1;
} finally {
  delivery.close();
  conversations.dispose();
}
