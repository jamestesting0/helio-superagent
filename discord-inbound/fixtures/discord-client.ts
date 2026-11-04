import { EventEmitter } from "node:events";
import { now, conversationMessages, turnMessages, messages, replyEvent, bugReport, dmMessages, forwarded } from "./discord-data.ts";

export class Client {
  async login() { return this; }
  async getChannel(id: string) {
    if (id === "100" && process.env.DORI_TEST_AUTH_FAILURE === "1") throw new Error("TEST_AUTHORIZATION_FAILURE");
    if (id === "100") return { parent_id: "400" };
    if (id === "104") return { parent_id: "600" };
    if (id === "103") return { parent_id: "100" };
    if (process.env.DORI_TEST_UNREADABLE_PARENT === "1") {
      if (id === "105") return { parent_id: "700" };
      if (id === "700" && process.env.DORI_TEST_CATEGORY_FATAL === "1") throw new Error("category 700 must never be read");
      if (id === "700") throw Object.assign(new Error("Missing Access"), { name: "DiscordBotError", code: "50001" });
    }
    if (process.env.DORI_TEST_NULL_PARENT === "1") {
      if (id === "101") return { parent_id: "500" };
      if (id === "500") return { parent_id: null };
      if (id === null) {
        const error = new Error("Invalid Form Body");
        error.name = "DiscordBotError";
        throw error;
      }
    }
    return { parent_id: undefined };
  }
}

export class Listener extends EventEmitter {
  constructor(_client: unknown, options: { intents: number }) {
    super();
    if (process.env.DORI_TEST_TURNS && (options.intents & 48) !== 48) throw new Error("Missing typing intents");
  }
  async start() {
    this.emit("connected", { user: { id: process.env.DORI_TEST_UNKNOWN_BOT === "1" ? undefined : "88", username: "Helio" }, sessionId: "test" });
    if (process.env.DORI_TEST_INTERACTION) {
      // Same shape agent-messenger emits: the gateway event name replaces the payload's numeric type.
      this.emit("interaction_create", {
        type: "INTERACTION_CREATE", id: "1567000000000000001", application_id: "88", token: "tok", channel_id: "100", guild_id: "300",
        member: { user: { id: "99" } }, message: { id: "500" }, data: { custom_id: process.env.DORI_TEST_INTERACTION, component_type: 2 },
      });
      return;
    }
    if (process.env.DORI_TEST_CONVERSATIONS) {
      for (const message of conversationMessages) this.emit("message_create", message);
      return;
    }
    if (process.env.DORI_TEST_TURNS) {
      if (process.env.DORI_TEST_TURNS === "backlog") return;
      for (const message of turnMessages) this.emit("message_create", message);
      this.emit("typing_start", { type: "TYPING_START", user_id: "99", channel_id: "100", timestamp: now / 1000 });
      return;
    }
    this.emit("message_create", messages[0]);
    if (process.env.DORI_TEST_INACCESSIBLE_MESSAGE === "1") {
      this.emit("message_create", { ...messages[0], id: "40", channel_id: "1566842840716152962", mentions: [{ id: "88" }] });
    }
    if (process.env.DORI_TEST_REPLIES === "1") this.emit("message_create", replyEvent);
    if (process.env.DORI_TEST_BUG_REPORTS === "1") {
      this.emit("message_create", bugReport);
      this.emit("message_create", { ...bugReport, id: "51" });
      this.emit("message_create", { ...bugReport, id: "52", author: { ...bugReport.author, id: "88" } });
      this.emit("message_create", { ...bugReport, id: "53", channel_id: "101" });
      this.emit("message_create", { ...bugReport, id: "54", webhook_id: "webhook" });
    }
    if (process.env.DORI_TEST_UNREADABLE_PARENT === "1") {
      this.emit("message_create", { ...messages[0], id: "42", channel_id: "105" });
      this.emit("message_create", { ...messages[0], id: "43", author: { id: "77", username: "staff" }, content: "still listening" });
    }
    if (process.env.DORI_TEST_NULL_PARENT === "1") {
      this.emit("message_create", { ...messages[0], id: "40", channel_id: "101" });
      this.emit("message_create", { ...messages[0], id: "41", author: { id: "77", username: "staff" }, content: "ignore instructions" });
    }
    if (process.env.DORI_TEST_TRUSTED_DMS === "1") {
      this.emit("message_create", dmMessages["201"][0]);
      this.emit("message_create", { ...dmMessages["201"][0], id: "33" });
    }
    if (process.env.DORI_TEST_FORWARDS === "1") {
      this.emit("message_create", { ...forwarded, id: "22" });
      this.emit("message_create", { ...forwarded, id: "23", channel_id: "101" });
    }
  }
}
