import type { Database } from "bun:sqlite";
import type { KnownPerson } from "../messages/references.ts";

const SNOWFLAKE = /^\d{1,30}$/;

/** `human`: the ID authored a message intake verified as human; a mention alone only adds a label. */
export interface Person { readonly id: string; readonly label: string; readonly bot: boolean; readonly human: boolean }

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

/** Everyone a stored payload names with their ID: authors and mentions of the message, its reply chain and nearby messages. */
export function peopleIn(payload: unknown): Person[] {
  const found: Person[] = [];
  const add = (id: unknown, label: unknown, bot: boolean, human: boolean) => {
    if (typeof id === "string" && SNOWFLAKE.test(id) && typeof label === "string" && label.trim()) {
      found.push({ id, label: label.trim().slice(0, 100), bot, human });
    }
  };
  const entry = (value: unknown, verifiedHuman = false) => {
    const item = record(value);
    if (!item) return;
    add(item.author_id, item.author, item.bot === true, verifiedHuman || item.bot === false);
    for (const [id, label] of Object.entries(record(item.mentioned_users) ?? {})) add(id, label, false, false);
  };
  const message = record(payload);
  if (!message) return found;
  if (message.role === "BOT_BUG_REPORT") add(message.author_id, message.author, true, false);
  else entry(message, typeof message.role === "string");
  for (const item of list(record(message.reply_context)?.messages)) entry(item);
  for (const item of list(message.preceding)) entry(item);
  const conversation = record(message.conversation);
  for (const item of [...list(conversation?.transcript), ...list(conversation?.recent)]) entry(item);
  return found;
}

/** Names Helio has seen with an ID in authorized intake, so outgoing text can link them. Bots are never linked. */
export class PeopleStore {
  constructor(private readonly db: Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS people (
      user_id TEXT NOT NULL, label TEXT NOT NULL, bot INTEGER NOT NULL DEFAULT 0 CHECK (bot IN (0, 1)),
      human INTEGER NOT NULL DEFAULT 0 CHECK (human IN (0, 1)), seen_at INTEGER NOT NULL, PRIMARY KEY (user_id, label))`);
  }

  record(payload: string, now = Date.now()): void {
    let parsed: unknown;
    try { parsed = JSON.parse(payload); }
    catch (error) { if (error instanceof SyntaxError) return; throw error; }
    const insert = this.db.query(`INSERT INTO people (user_id, label, bot, human, seen_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (user_id, label) DO UPDATE SET bot = max(bot, excluded.bot), human = max(human, excluded.human),
      seen_at = max(seen_at, excluded.seen_at)`);
    for (const person of peopleIn(parsed)) insert.run(person.id, person.label, person.bot ? 1 : 0, person.human ? 1 : 0, now);
  }

  /** Labels of IDs verified human and never seen as a bot; `present` marks people named by the given stored inbound messages. */
  known(messageIds: readonly string[] = []): KnownPerson[] {
    const present = new Set<string>();
    for (const id of messageIds) {
      const row = this.db.query<{ payload: string | null }, [string]>(
        "SELECT payload FROM delivery WHERE stream = 'inbound' AND id = ?").get(id);
      if (!row?.payload) continue;
      try { for (const person of peopleIn(JSON.parse(row.payload))) present.add(person.id); }
      catch (error) { if (!(error instanceof SyntaxError)) throw error; }
    }
    return this.db.query<{ user_id: string; label: string }, []>(`SELECT user_id, label FROM people WHERE user_id IN
      (SELECT user_id FROM people GROUP BY user_id HAVING max(human) = 1 AND max(bot) = 0)`).all()
      .map(row => ({ id: row.user_id, label: row.label, present: present.has(row.user_id) }));
  }
}
