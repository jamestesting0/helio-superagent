import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Conversations } from "../conversations/conversations.ts";
import { Delivery } from "../delivery/delivery.ts";
import { discordRest, type Rest } from "../discord/rest.ts";
import { AdminError, policy, type AdminPolicy, type RuntimeProof } from "./protocol.ts";
import { RuntimeAccess } from "./runtime-access.ts";

export class RuntimeState {
  readonly home: string;
  readonly state: string;
  readonly published: AdminPolicy;
  readonly conversations: Conversations;
  readonly conversationDb: Database;
  readonly delivery: Delivery;
  readonly admin: Database;
  readonly rest: Rest;
  readonly access: RuntimeAccess;

  constructor(readonly proof: RuntimeProof) {
    this.home = process.env.HOME ?? "";
    this.state = process.env.DORI_STATE_DIR ?? join(this.home, ".dori/elobot/state");
    const directory = process.env.DORI_POLICY_DIR ?? join(this.home, ".dori/elobot/policy");
    this.published = policy(JSON.parse(readFileSync(join(directory, "policy.json"), "utf8")));
    const token = process.env.DORI_DISCORD_TOKEN;
    if (!token) throw new AdminError("unavailable", "The isolated Discord credential is unavailable");
    this.rest = discordRest(token, { allowIgnoredMetadata: true, metadataActor: proof.actor });
    this.access = new RuntimeAccess(proof, this.rest);
    this.access.authorize();
    mkdirSync(this.state, { recursive: true, mode: 0o700 });
    this.conversations = new Conversations(join(this.state, "discord-conversations.sqlite"));
    this.conversationDb = new Database(join(this.state, "discord-conversations.sqlite"), { readonly: true });
    this.delivery = new Delivery(join(this.state, "discord-delivery.sqlite"));
    const path = join(this.state, "discord-admin.sqlite");
    this.admin = new Database(path, { create: true });
    chmodSync(path, 0o600);
    this.admin.exec(`PRAGMA busy_timeout=1000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS operations (
        id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL,
        target TEXT NOT NULL, channel TEXT, user TEXT, created_at INTEGER NOT NULL,
        status TEXT NOT NULL, result TEXT
      )`);
  }

  [Symbol.dispose](): void {
    this.admin.close();
    this.delivery.close();
    this.conversationDb.close();
    this.conversations.dispose();
  }
}
