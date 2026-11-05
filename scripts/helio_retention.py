"""One retention rule per state table. Housekeeping applies them; a table without a rule is reported, never touched."""
from __future__ import annotations

import datetime
import sqlite3
from contextlib import closing
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

DAY_S = 86_400
DAY_MS = DAY_S * 1000
# Discord snowflakes carry their creation time; delivery receipts have no other timestamp.
SNOWFLAKE_MS = "((CAST(id AS INTEGER) >> 22) + 1420070400000)"
RAW_DAYS, DERIVED_DAYS, RECEIPT_DAYS = 30, 180, 180


@dataclass(frozen=True)
class Rule:
    db: str
    table: str
    kind: Literal["raw_chat", "derived", "receipt", "owned", "policy", "singleton"]
    why: str
    sql: tuple[str, ...] = ()


def _settled_delivery(alias: str) -> str:
    return f"NOT EXISTS (SELECT 1 FROM delivery d WHERE d.stream={alias}.stream AND d.id={alias}.id AND d.payload IS NOT NULL)"


RULES: tuple[Rule, ...] = (
    Rule("discord-delivery.sqlite", "delivery", "receipt",
         "Pending inbound work is never touched; unlearned context text is erased after 30 days; settled IDs stay 180 days for deduplication.",
         ("INSERT OR IGNORE INTO handling(stream,id,disposition,reason) SELECT stream,id,'done','Erased by retention: unlearned after 30 days' "
          f"FROM delivery WHERE stream='context' AND payload IS NOT NULL AND {SNOWFLAKE_MS} < :now_ms - {RAW_DAYS * DAY_MS}",
          "UPDATE delivery SET payload=NULL WHERE stream='context' AND payload IS NOT NULL AND EXISTS (SELECT 1 FROM handling h "
          "WHERE h.stream='context' AND h.id=delivery.id AND h.reason='Erased by retention: unlearned after 30 days')",
          f"DELETE FROM delivery WHERE payload IS NULL AND {SNOWFLAKE_MS} < :now_ms - {RECEIPT_DAYS * DAY_MS}")),
    *(Rule("discord-delivery.sqlite", table, "receipt", "Deduplication receipt kept 180 days, longer than every replay window.",
           (f"DELETE FROM {table} WHERE {SNOWFLAKE_MS} < :now_ms - {RECEIPT_DAYS * DAY_MS} AND {_settled_delivery(table)}",))
      for table in ("handling", "acceptance", "expiry")),
    Rule("discord-delivery.sqlite", "inbound_recovery", "derived",
         "Reviewed recovery evidence loses its reason and evidence text at 30 days; the outcome is kept 180 days.",
         tuple(f"{statement} AND reviewed_at IS NOT NULL AND NOT EXISTS "
               "(SELECT 1 FROM delivery d WHERE d.stream='inbound' AND d.id=inbound_recovery.id AND d.payload IS NOT NULL)"
               for statement in ("UPDATE inbound_recovery SET reason=NULL,evidence=NULL WHERE reviewed_at < :raw_iso "
                                 "AND (reason IS NOT NULL OR evidence IS NOT NULL)",
                                 "DELETE FROM inbound_recovery WHERE reviewed_at < :derived_iso"))),
    Rule("discord-delivery.sqlite", "recovery_reports", "derived", "Recovery scan reports are kept 30 days.",
         ("DELETE FROM recovery_reports WHERE created_at < :raw_iso",)),
    Rule("discord-delivery.sqlite", "inbound_gaps", "derived", "Acknowledged intake gaps are kept 180 days; open ones stay.",
         (f"DELETE FROM inbound_gaps WHERE acknowledged_at IS NOT NULL AND acknowledged_at < datetime(:now_s, 'unixepoch', '-{DERIVED_DAYS} days')",)),
    Rule("discord-delivery.sqlite", "blocked_users", "policy", "The blacklist lasts until the owner lifts it."),
    Rule("discord-delivery.sqlite", "moderation_proofs", "receipt",
         "A spent owner proof is kept so an old answer is never reused; one row per owner block or unblock."),
    Rule("discord-delivery.sqlite", "strikes", "derived", "Strikes matter for 12 hours; kept 24.",
         (f"DELETE FROM strikes WHERE at < :now_ms - {DAY_MS}",)),
    Rule("discord-delivery.sqlite", "ping_log", "derived", "The ping budget is per hour; kept 2 hours.",
         (f"DELETE FROM ping_log WHERE at < :now_ms - {2 * 3_600_000}",)),
    Rule("discord-delivery.sqlite", "ping_notices", "derived", "One hourglass notice per hour; kept 2 hours.",
         (f"DELETE FROM ping_notices WHERE noticed_at < :now_ms - {2 * 3_600_000}",)),
    *(Rule("discord-delivery.sqlite", table, "raw_chat", "Legacy quarantined payloads are erased after 30 days.",
           ("DELETE FROM {t} WHERE quarantined_at < datetime(:now_s, 'unixepoch', '-30 days')".format(t=table),))
      for table in ("context_quarantine", "inbound_quarantine")),
    Rule("discord-conversations.sqlite", "conversations", "owned", "Conversation upkeep archives resolved rows at 7 days and deletes them 30 days after resolving."),
    Rule("discord-conversations.sqlite", "transcript", "owned", "Deleted when its conversation resolves; open conversations are unresolved work."),
    Rule("discord-conversations.sqlite", "working", "owned", "Claims are pruned 72 hours after they close."),
    Rule("discord-conversations.sqlite", "conversation_notices", "owned", "Notice IDs are pruned after 37 days."),
    Rule("discord-conversations.sqlite", "conversation_migrations", "owned", "Removed with their conversation."),
    Rule("discord-conversations.sqlite", "conversation_upkeep", "singleton", "One marker row."),
    Rule("discord-conversations.sqlite", "oracle_observations", "singleton", "The latest observation only."),
    Rule("discord-conversations.sqlite", "oracle_events", "derived", "Delivered Oracle transitions are kept 180 days.",
         (f"DELETE FROM oracle_events WHERE handled=1 AND coalesce(json_extract(data,'$.at'),0) < :now_s - {DERIVED_DAYS * DAY_S}",)),
    Rule("discord-conversations.sqlite", "followups", "derived", "Delivered follow-ups are kept 180 days.",
         (f"DELETE FROM followups WHERE status='done' AND created_at < :now_s - {DERIVED_DAYS * DAY_S}",)),
    Rule("discord-prompts.sqlite", "prompts", "raw_chat", "Settled prompts are deleted after 30 days; open, pending and unused confirmations stay.",
         ("DELETE FROM prompts WHERE status NOT IN ('sending','delivery_unknown','open','pending') "
          f"AND NOT (status='confirmed' AND used_at IS NULL) AND created_at < :now_ms - {RAW_DAYS * DAY_MS}",)),
    Rule("discord-prompts.sqlite", "feedback", "raw_chat", "Plan feedback text is deleted after 30 days.",
         (f"DELETE FROM feedback WHERE created_at < :now_ms - {RAW_DAYS * DAY_MS}",)),
    Rule("discord-prompts.sqlite", "drafts", "raw_chat", "Retired draft flow; nothing reads it.", ("DELETE FROM drafts",)),
    Rule("discord-questions.sqlite", "questions", "raw_chat", "Settled questions are deleted after 30 days; unanswered and unacknowledged ones stay.",
         (f"DELETE FROM questions WHERE status IN ('done','cancelled','expired','withdrawn') AND updated < :now_ms - {RAW_DAYS * DAY_MS}",)),
    Rule("issue-sync.sqlite", "reviews", "derived", "Issue review timestamps are kept 180 days after last activity.",
         (f"DELETE FROM reviews WHERE max(coalesce(discussed_at,0),coalesce(reviewed_at,0),coalesce(notified_at,0)) < :now_s - {DERIVED_DAYS * DAY_S}",)),
    Rule("issue-sync.sqlite", "tracked", "derived", "Issues not checked for 180 days are dropped.",
         (f"DELETE FROM tracked WHERE checked_at < :now_s - {DERIVED_DAYS * DAY_S}",)),
    Rule("issue-updates.sqlite", "operations", "derived",
         "A finished update loses its private preimage at once, its published body and change at 30 days, and its record at 180.",
         ("UPDATE operations SET before_body='' WHERE completed IN (1,2) AND before_body != ''",
          f"UPDATE operations SET after_body='',change='' WHERE completed IN (1,2) AND change != '' AND completed_at < :now_s - {RAW_DAYS * DAY_S}",
          f"DELETE FROM operations WHERE completed IN (1,2) AND completed_at < :now_s - {DERIVED_DAYS * DAY_S}")),
    Rule("issue-updates.sqlite", "milestones", "receipt", "Milestone keys only; they prevent duplicate progress comments."),
    Rule("issue-updates.sqlite", "meta", "singleton", "The milestone baseline."),
    Rule("decisions.sqlite", "decisions", "derived", "Ended guidance is kept 180 days; active guidance stays.",
         (f"DELETE FROM decisions WHERE status != 'active' AND coalesce(invalid_at, created_at) < :now_s - {DERIVED_DAYS * DAY_S}",)),
    Rule("decisions.sqlite", "decision_events", "derived", "Events of deleted decisions go with them.",
         ("DELETE FROM decision_events WHERE decision_id NOT IN (SELECT id FROM decisions)",)),
    Rule("decisions.sqlite", "decision_digest", "derived", "Acknowledged weekly digests are kept 180 days.",
         (f"DELETE FROM decision_digest WHERE handled=1 AND created_at < :now_s - {DERIVED_DAYS * DAY_S}",)),
    Rule("reply-sends.sqlite", "reply_sends", "receipt", "Target and text-hash receipts are kept 180 days.",
         (f"DELETE FROM reply_sends WHERE started_at < :now_ms - {RECEIPT_DAYS * DAY_MS}",)),
    Rule("work-authorizations.sqlite", "authorizations", "receipt", "Unfinished work is retained; used authorizations are kept 180 days.",
         ("DELETE FROM authorizations WHERE used=1 AND recorded_at < :receipt_iso",)),
)


def params(now: float) -> dict[str, object]:
    iso = lambda days: datetime.datetime.fromtimestamp(now - days * DAY_S, datetime.timezone.utc).isoformat()
    return {"now_s": int(now), "now_ms": int(now * 1000), "raw_iso": iso(RAW_DAYS), "derived_iso": iso(DERIVED_DAYS), "receipt_iso": iso(RECEIPT_DAYS)}


def tables(path: Path) -> set[str]:
    with closing(sqlite3.connect(f"file:{path}?mode=ro", uri=True)) as db:
        return {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")}


def uncovered(state: Path) -> list[str]:
    covered = {(rule.db, rule.table) for rule in RULES}
    return [f"{path.name}:{table}" for path in sorted(state.glob("*.sqlite")) for table in sorted(tables(path))
            if (path.name, table) not in covered]
