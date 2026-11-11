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
    Rule("discord-delivery.sqlite", "ignored", "receipt", "Neutral deduplication receipts stay until local cleanup completes, then 180 days.",
         (f"DELETE FROM ignored WHERE attachments_cleaned=1 AND ignored_at < datetime(:now_s, 'unixepoch', '-{RECEIPT_DAYS} days') AND {_settled_delivery('ignored')}",)),
    Rule("discord-delivery.sqlite", "inbound_gaps", "derived", "Acknowledged intake gaps are kept 180 days; open ones stay.",
         (f"DELETE FROM inbound_gaps WHERE acknowledged_at IS NOT NULL AND acknowledged_at < datetime(:now_s, 'unixepoch', '-{DERIVED_DAYS} days')",)),
    Rule("discord-delivery.sqlite", "blocked_users", "policy", "The blacklist lasts until the owner lifts it."),
    Rule("discord-delivery.sqlite", "plan_requests", "receipt",
         "Active planning sources survive intake cleanup; settled identity receipts stay 180 days.",
         (f"DELETE FROM plan_requests WHERE settled_at IS NOT NULL AND settled_at < datetime(:now_s, 'unixepoch', '-{RECEIPT_DAYS} days')",)),
    Rule("discord-delivery.sqlite", "turn_context_snapshots", "raw_chat",
         "One cached snapshot per grouped turn; unresolved references stay, settled snapshots expire at 30 days.",
         (f"DELETE FROM turn_context_snapshots WHERE created_at < :now_s - {RAW_DAYS * DAY_S} AND NOT EXISTS "
          "(SELECT 1 FROM delivery WHERE stream='inbound' AND payload IS NOT NULL "
          "AND json_extract(payload,'$.conversation.context_snapshot')=turn_context_snapshots.id)",)),
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
    Rule("discord-conversations.sqlite", "transcript", "owned", "Text is erased when its topic resolves and message IDs when it archives; open topics are unresolved work."),
    Rule("discord-conversations.sqlite", "working", "owned", "Claims are pruned 72 hours after they close."),
    Rule("discord-conversations.sqlite", "conversation_notices", "owned", "Notice IDs are pruned after 37 days."),
    Rule("discord-conversations.sqlite", "conversation_notice_intents", "receipt", "Durable notice identities prevent duplicate sends; uncertain outcomes remain recoverable."),
    Rule("discord-conversations.sqlite", "conversation_repairs", "receipt", "Repair identities prevent reapplying a historical manifest."),
    Rule("discord-conversations.sqlite", "conversation_admin_operations", "receipt",
         "Administration identities prevent reapplying a conversation transition after a restart."),
    Rule("discord-admin.sqlite", "operations", "receipt",
         "Administration outcomes prevent duplicate changes; unresolved operations remain inspectable."),
    Rule("discord-conversations.sqlite", "conversation_migrations", "owned", "Removed with their conversation."),
    Rule("discord-conversations.sqlite", "conversation_upkeep", "singleton", "One marker row."),
    Rule("discord-conversations.sqlite", "oracle_observations", "singleton", "The latest observation only."),
    Rule("discord-conversations.sqlite", "oracle_events", "derived", "Delivered Oracle transitions are kept 180 days.",
         (f"DELETE FROM oracle_events WHERE handled=1 AND coalesce(json_extract(data,'$.at'),0) < :now_s - {DERIVED_DAYS * DAY_S}",)),
    Rule("discord-conversations.sqlite", "followups", "derived", "Delivered follow-ups are kept 180 days.",
         (f"DELETE FROM followups WHERE status='done' AND created_at < :now_s - {DERIVED_DAYS * DAY_S}",)),
    Rule("discord-conversations.sqlite", "followup_groups", "receipt", "Per-channel deliveries stay with their subscription.",
         ("DELETE FROM followup_groups WHERE NOT EXISTS (SELECT 1 FROM followups f WHERE f.repo=followup_groups.repo "
          "AND f.issue=followup_groups.issue AND f.anchor_message_id=followup_groups.anchor_message_id)",)),
    Rule("discord-conversations.sqlite", "followups_legacy", "derived", "Delivered person-keyed history is kept 180 days.",
         (f"DELETE FROM followups_legacy WHERE status='done' AND created_at < :now_s - {DERIVED_DAYS * DAY_S}",)),
    Rule("discord-conversations.sqlite", "topic_participants", "owned", "Removed with their topic."),
    Rule("discord-conversations.sqlite", "closure_notes", "owned", "Closing-note targets are removed with their topic."),
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
    Rule("issue-updates.sqlite", "plan_publications", "derived",
         "Unresolved plan effects stay; confirmed bodies are erased at 30 days and receipts at 180 days.",
         (f"UPDATE plan_publications SET before_body='',after_body='' WHERE state IN ('confirmed','cancelled') AND completed_at < :now_s - {RAW_DAYS * DAY_S}",
          f"DELETE FROM plan_publications WHERE state IN ('confirmed','cancelled') AND completed_at < :now_s - {RECEIPT_DAYS * DAY_S}")),
    Rule("issue-updates.sqlite", "followup_creations", "receipt",
         "Creation identities prevent duplicate follow-up issues; confirmed and uncertain outcomes stay recoverable."),
    Rule("issue-updates.sqlite", "pr_waits", "receipt",
         "Active custody and unacknowledged events stay; terminal acknowledged records expire after 180 days.",
         (f"""DELETE FROM pr_waits WHERE updated_at < :now_s - {RECEIPT_DAYS * DAY_S}
             AND CASE WHEN json_valid(data) THEN json_extract(data,'$.terminal')=1
             AND json_type(data,'$.notices')='array'
             AND NOT EXISTS (SELECT 1 FROM json_each(data,'$.notices')
                             WHERE json_extract(value,'$.acknowledged') IS NOT 1) ELSE 0 END""",)),
    Rule("issue-updates.sqlite", "pr_verifications", "receipt",
         "Published proof stays with custody; unfinished publication and uncertain effects never expire.",
         (f"""DELETE FROM pr_verifications WHERE status='published' AND published_at < :now_s - {RECEIPT_DAYS * DAY_S}
             AND NOT EXISTS (SELECT 1 FROM pr_waits w WHERE w.repo=pr_verifications.repo AND w.issue=pr_verifications.issue)
             AND NOT EXISTS (SELECT 1 FROM operations o WHERE o.completed=0 AND
                 CASE WHEN json_valid(o.change) THEN json_extract(o.change,'$.verification')=pr_verifications.id ELSE 1 END)""",)),
    Rule("issue-updates.sqlite", "meta", "singleton", "The milestone baseline."),
    Rule("decisions.sqlite", "decisions", "derived", "Ended guidance is kept 180 days; active guidance stays.",
         (f"DELETE FROM decisions WHERE status != 'active' AND coalesce(invalid_at, created_at) < :now_s - {DERIVED_DAYS * DAY_S}",)),
    Rule("decisions.sqlite", "decision_events", "derived", "Events of deleted decisions go with them.",
         ("DELETE FROM decision_events WHERE decision_id NOT IN (SELECT id FROM decisions)",)),
    Rule("decisions.sqlite", "decision_digest", "derived", "Acknowledged weekly digests are kept 180 days.",
         (f"DELETE FROM decision_digest WHERE handled=1 AND created_at < :now_s - {DERIVED_DAYS * DAY_S}",)),
    Rule("reply-sends.sqlite", "reply_sends", "receipt", "Settled delivery identities are kept 180 days; uncertain sends remain recoverable.",
         (f"DELETE FROM reply_sends WHERE state='sent' AND started_at < :now_ms - {RECEIPT_DAYS * DAY_MS}",)),
    Rule("reply-sends.sqlite", "reply_settlements", "receipt", "Final settlement identities prevent duplicate local fulfillment after restart."),
    Rule("work-authorizations.sqlite", "authorizations", "receipt", "Unfinished work is retained; used authorizations are kept 180 days.",
         ("DELETE FROM authorizations WHERE used=1 AND recorded_at < :receipt_iso",)),
    Rule("work-authorizations.sqlite", "bugfixes", "receipt",
         "Bug-fix routing records prevent duplicate fix lanes; kept 180 days after their last change.",
         ("DELETE FROM bugfixes WHERE updated_at < :receipt_iso",)),
    Rule("work-authorizations.sqlite", "work_events", "derived", "Backstop notice state is kept 30 days.",
         ("DELETE FROM work_events WHERE emitted_at < :raw_iso",)),
    Rule("work-authorizations.sqlite", "meta", "singleton", "The bug-fix backstop cutoff."),
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
