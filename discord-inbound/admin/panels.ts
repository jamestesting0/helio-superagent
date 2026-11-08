import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { AdminError, fields, object, record, section, text, type AdminRecord, type Fields, type Section } from "./protocol.ts";

export interface Position {
  ids: string[];
  filters: Fields;
  page: number;
  selected?: string;
}
export interface Proposal {
  readonly action: string;
  readonly target: string;
  readonly expected: string;
  readonly input: Fields;
  readonly operation: string;
  readonly label: string;
  readonly targetLabel?: string;
}
export interface Panel {
  readonly id: string;
  readonly actor: string;
  readonly guild?: string;
  readonly channel: string;
  readonly application: string;
  message: string;
  token: string;
  expires: number;
  revision: number;
  section: Section;
  positions: Partial<Record<Section, Position>>;
  screen: "list" | "detail" | "activity" | "filters" | "confirm" | "guidance" | "pending" | "unavailable" | "closed";
  contentPage: number;
  snapshot: number;
  notice?: string;
  draft?: Fields;
  proposal?: Proposal;
  pending?: Proposal;
  github?: AdminRecord;
  selectedRevision?: string;
  form?: Proposal;
}

function proposal(value: unknown): Proposal {
  const saved = object(value);
  return { action: text(saved.action, 60), target: text(saved.target, 120), expected: text(saved.expected, 100),
    input: fields(saved.input), operation: text(saved.operation, 100), label: text(saved.label, 100),
    ...(saved.targetLabel === undefined ? {} : { targetLabel: text(saved.targetLabel, 100) }) };
}

function decode(value: unknown): Panel {
  const row = object(value);
  const positions: Partial<Record<Section, Position>> = {};
  for (const [name, value] of Object.entries(object(row.positions))) {
    const saved = object(value);
    if (!Array.isArray(saved.ids) || typeof saved.page !== "number") throw new AdminError("invalid", "Invalid saved panel position");
    positions[section(name)] = { ids: saved.ids.map(id => text(id, 120)), filters: fields(saved.filters), page: saved.page,
      ...(saved.selected === undefined ? {} : { selected: text(saved.selected, 120) }) };
  }
  const screen = row.screen;
  if (screen !== "list" && screen !== "detail" && screen !== "activity" && screen !== "filters" &&
      screen !== "confirm" && screen !== "guidance" && screen !== "pending" && screen !== "unavailable" && screen !== "closed") throw new AdminError("invalid", "Invalid saved panel screen");
  if (typeof row.expires !== "number" || typeof row.revision !== "number" ||
      typeof row.contentPage !== "number" || typeof row.snapshot !== "number") throw new AdminError("invalid", "Invalid saved panel lifetime");
  return {
    id: text(row.id, 32), actor: text(row.actor, 30), channel: text(row.channel, 30),
    ...(row.guild === undefined ? {} : { guild: text(row.guild, 30) }),
    application: text(row.application, 30), message: text(row.message, 30), token: text(row.token, 500),
    expires: row.expires, revision: row.revision, section: section(row.section), positions, screen,
    contentPage: row.contentPage, snapshot: row.snapshot,
    ...(row.notice === undefined ? {} : { notice: text(row.notice, 1000) }),
    ...(row.draft === undefined ? {} : { draft: fields(row.draft) }),
    ...(row.proposal === undefined ? {} : { proposal: proposal(row.proposal) }),
    ...(row.pending === undefined ? {} : { pending: proposal(row.pending) }),
    ...(row.github === undefined ? {} : { github: record(row.github) }),
    ...(row.selectedRevision === undefined ? {} : { selectedRevision: text(row.selectedRevision, 100) }),
    ...(row.form === undefined ? {} : { form: proposal(row.form) }),
  };
}

export class Panels {
  private readonly db: Database;
  private readonly queues = new Map<string, Promise<void>>();

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path, { create: true });
    chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=1000;
      CREATE TABLE IF NOT EXISTS panels(id TEXT PRIMARY KEY,expires INTEGER NOT NULL,data TEXT NOT NULL)`);
    // Submitted writes keep only receipt inspection; unsubmitted confirmations expire.
    this.db.query("UPDATE panels SET expires=0 WHERE json_extract(data,'$.pending') IS NULL").run();
  }

  [Symbol.dispose](): void { this.db.close(); }

  save(panel: Panel, advance = true): void {
    if (advance) panel.revision += 1;
    this.db.query("INSERT INTO panels VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET expires=excluded.expires,data=excluded.data")
      .run(panel.id, panel.expires, JSON.stringify(panel));
  }

  get(id: string, now: number): Panel {
    const row = this.db.query<{ data: string; expires: number }, [string]>("SELECT data,expires FROM panels WHERE id=?").get(id);
    if (!row || row.expires <= now) throw new AdminError("denied", "Panel expired. Run /status.");
    return decode(JSON.parse(row.data));
  }

  expired(now: number): Panel[] {
    return this.db.query<{ data: string }, [number]>("SELECT data FROM panels WHERE expires<=?").all(now)
      .map(row => decode(JSON.parse(row.data)));
  }

  remove(id: string): void { this.db.query("DELETE FROM panels WHERE id=?").run(id); }

  preferred(actor: string, section: Section, now: number): string | undefined {
    const rows = this.db.query<{ data: string }, [string, number]>(
      "SELECT data FROM panels WHERE json_extract(data,'$.actor')=? AND expires>? ORDER BY expires DESC LIMIT 20").all(actor, now);
    for (const row of rows) {
      const selected = decode(JSON.parse(row.data)).positions[section]?.selected;
      if (selected) return selected;
    }
    return undefined;
  }

  async serialize(id: string, work: () => Promise<void>): Promise<void> {
    const previous = this.queues.get(id) ?? Promise.resolve();
    const current = previous.then(work, work);
    this.queues.set(id, current);
    try { await current; }
    finally { if (this.queues.get(id) === current) this.queues.delete(id); }
  }
}

export function position(panel: Panel): Position {
  const current = panel.positions[panel.section];
  if (!current) throw new AdminError("invalid", "This section has no list snapshot");
  return current;
}
