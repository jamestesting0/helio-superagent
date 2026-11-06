import type { Database } from "bun:sqlite";
import { insideAllowed, type ChannelLookup } from "../intake/filter.ts";
import type { Stream } from "./delivery.ts";
import { object } from "./monitor-summary.ts";
import type { OriginalMetadata } from "../intake/authorization.ts";

export type IgnoredReason = "system-event" | "ignored-channel" | "unsupported-format";
const digest = (payload: string) => new Bun.CryptoHasher("sha256").update(payload).digest("hex");

/** Conservative: every failed part must be unsupported and no supported part may remain. */
function unsupportedOnly(payload: Record<string, unknown>): boolean {
  if (payload.preparation_complete !== true && payload.attachments_prepared !== true) return false;
  const parts = [payload, ...(Array.isArray(payload.forwarded) ? payload.forwarded.map(object) : [])];
  let unsupported = false;
  for (const part of parts) {
    if (typeof part.content === "string" && part.content.trim()) return false;
    for (const key of ["embed_text", "component_text", "attachments"]) {
      const value = part[key];
      if (typeof value === "string" ? value.trim().length > 0 : Array.isArray(value) && value.length > 0) return false;
    }
    if (!Array.isArray(part.blocked_attachments)) continue;
    for (const failure of part.blocked_attachments) {
      if (object(failure).category !== "unsupported-format") return false;
      unsupported = true;
    }
  }
  return unsupported && payload.forwarded_unavailable !== true;
}

export async function neutralReason(stream: Stream, previous: string, ignoredChannels: ReadonlySet<string> = new Set(),
  channelOf?: ChannelLookup, original?: OriginalMetadata): Promise<IgnoredReason | undefined> {
  let payload: Record<string, unknown>;
  let origin: Record<string, unknown>;
  try {
    payload = object(JSON.parse(previous));
    origin = object(payload.discord_origin ?? {});
  } catch (error) {
    if (!(error instanceof SyntaxError || error instanceof TypeError)) throw error;
    return undefined;
  }
  let type = stream === "context" ? payload.message_type : origin.message_type;
  if (type === undefined && original && origin.version === 1 &&
      origin.message_id === original.id && payload.message_id === original.id &&
      origin.channel_id === original.channel_id && payload.channel_id === original.channel_id &&
      origin.author_id === original.author.id && payload.author_id === original.author.id) type = original.type;
  const channel = payload.channel_id;
  if (typeof channel === "string" && ignoredChannels.has(channel)) return "ignored-channel";
  if (typeof type === "number" && ![0, 19, ...(payload.role === "BOT_BUG_REPORT" ? [20, 23] : [])].includes(type)) {
    return "system-event";
  }
  if (typeof channel === "string" && ignoredChannels.size && channelOf &&
      await insideAllowed(channel, ignoredChannels, async id => (await channelOf(id))?.parent_id ?? undefined)) return "ignored-channel";
  try { if (unsupportedOnly(payload)) return "unsupported-format"; }
  catch (error) { if (!(error instanceof TypeError)) throw error; }
  return undefined;
}

export class IgnoredStore {
  constructor(private readonly db: Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS ignored (
      stream TEXT NOT NULL, id TEXT NOT NULL, source_digest TEXT NOT NULL,
      ignored_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      reason TEXT NOT NULL CHECK(reason IN ('system-event','ignored-channel','unsupported-format')),
      attachments_cleaned INTEGER NOT NULL DEFAULT 0 CHECK(attachments_cleaned IN (0,1)),
      PRIMARY KEY(stream,id))`);
  }

  /** Policy reads precede the transaction; the exact source is compared again at commit. */
  async settle(stream: Stream, id: string, previous: string,
    ignoredChannels: ReadonlySet<string> = new Set(), channelOf?: ChannelLookup,
    original?: OriginalMetadata): Promise<IgnoredReason | undefined> {
    const reason = await neutralReason(stream, previous, ignoredChannels, channelOf, original);
    if (!reason) return undefined;
    return this.db.transaction(() => {
      const row = this.db.query<{ payload: string }, [string, string]>(`SELECT d.payload FROM delivery d
        LEFT JOIN acceptance a ON a.stream=d.stream AND a.id=d.id
        LEFT JOIN handling h ON h.stream=d.stream AND h.id=d.id
        LEFT JOIN expiry e ON e.stream=d.stream AND e.id=d.id
        LEFT JOIN ignored i ON i.stream=d.stream AND i.id=d.id
        WHERE d.stream=? AND d.id=? AND a.id IS NULL AND h.id IS NULL AND e.id IS NULL AND i.id IS NULL`).get(stream, id);
      if (row?.payload !== previous) return undefined;
      this.db.run("INSERT INTO ignored(stream,id,source_digest,reason) VALUES(?,?,?,?)", [stream, id, digest(previous), reason]);
      this.db.run("UPDATE delivery SET payload=NULL WHERE stream=? AND id=?", [stream, id]);
      if (stream === "inbound") this.db.run(`UPDATE inbound_recovery SET reviewed_at=CURRENT_TIMESTAMP,
        outcome='informational',reason=?,evidence=? WHERE id=?`,
      [reason, JSON.stringify({ ignored: true, source_digest: digest(previous) }), id]);
      return reason;
    }).immediate();
  }

  pendingCleanup(): { stream: Stream; id: string }[] {
    return this.db.query<{ stream: Stream; id: string }, []>(
      "SELECT stream,id FROM ignored WHERE attachments_cleaned=0 ORDER BY stream,id").all();
  }

  cleaned(stream: Stream, id: string): void {
    this.db.run("UPDATE ignored SET attachments_cleaned=1 WHERE stream=? AND id=?", [stream, id]);
  }
}
