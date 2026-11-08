import type { Conversation } from "../conversations/conversations.ts";
import { readLanes } from "./lane-records.ts";
import { laneEvidence } from "./lane-evidence.ts";
import { laneObservation } from "./lane-session.ts";
import { PolicyRecords } from "./policy-records.ts";
import { AdminError, type AdminRecord, type Section } from "./protocol.ts";
import { escapeMarkdown, sourceUrl, stamp, stateName } from "./record-format.ts";
import type { RuntimeState } from "./runtime-state.ts";
import { syncWarning } from "./github-status.ts";
import { readRecords } from "./record-reads.ts";

const topicId = (row: Conversation) => `${row.channel_id}:${row.user_id}:${row.anchor_message_id}:${row.opened_at}`;

export class RuntimeRecords {
  readonly policy: PolicyRecords;
  constructor(private readonly runtime: RuntimeState) { this.policy = new PolicyRecords(runtime); }

  private topic(row: Conversation, detail: boolean): AdminRecord {
    const { conversations, published, proof } = this.runtime;
    const state = conversations.state(row);
    const timeoutHours = Number(published.values.HELIO_CONVERSATION_TIMEOUT_HOURS);
    const nudgeHours = Number(published.values.HELIO_CONVERSATION_NUDGE_HOURS);
    const due = row.question_started_at === null ? undefined :
      row.question_started_at + (row.nudged_at === null ? nudgeHours : timeoutHours) * 3_600_000;
    const fields = [
      { name: "State", value: stateName(state) }, { name: "Requester and channel", value: `<@${row.user_id}> | <#${row.channel_id}>` },
      ...(["request", "decided", "waiting_on", "result"] as const).flatMap(name =>
        row[name] ? [{ name: ({ request: "Request", decided: "Decision", waiting_on: "Waiting on", result: "Result" })[name], value: row[name] }] : []),
      ...(row.hold_reason ? [{ name: "Hold reason", value: row.hold_reason }] : []),
      ...(state === "waiting_on_requester" && due ? [{ name: "Next timer", value: `<t:${Math.floor(due / 1000)}:F> (<t:${Math.floor(due / 1000)}:R>)` }] : []),
      ...(row.outcome ? [{ name: "Outcome", value: row.outcome }] : []),
      ...(row.issue ? [{ name: "Issue", value: row.issue }] : []),
    ];
    return { id: topicId(row), title: row.topic, state, user: row.user_id, channel: row.channel_id,
      revision: String(row.revision), summary: `<@${row.user_id}> | <#${row.channel_id}>\n${stateName(state)}${state === "waiting_on_requester" && due ? ` | Due <t:${Math.floor(due / 1000)}:R>` : ""}`,
      url: sourceUrl(proof.guild, row.channel_id, row.anchor_message_id),
      ...(detail ? { fields, activity: conversations.transcriptOf(row).map(entry => ({
        title: entry.author_id === row.user_id ? "Requester" : "Helio", text: entry.content ?? "",
      })) } : {}),
    };
  }

  private async topics(target?: string): Promise<AdminRecord[]> {
    const rows = this.runtime.conversationDb.query<Conversation, []>(
      "SELECT * FROM conversations ORDER BY last_activity DESC,opened_at DESC,channel_id,user_id,anchor_message_id").all();
    return readRecords(rows, async row => {
      if (target !== undefined && topicId(row) !== target) return undefined;
      return await this.runtime.access.canRead(row.channel_id, row.user_id) ? this.topic(row, target !== undefined) : undefined;
    });
  }

  private async lanes(target?: string, suggest = false): Promise<AdminRecord[]> {
    const { state, proof, published, access } = this.runtime;
    return readRecords(readLanes(state, proof.guild), async ({ lane, record }) => {
      if (target !== undefined && target !== record.id) return undefined;
      const visible = record.channel ? await access.canRead(record.channel) : proof.actor === published.values.DORI_DISCORD_OWNER_ID;
      if (!visible) return undefined;
      if (target !== undefined) return laneEvidence(this.runtime, lane, record);
      if (suggest) return record;
      let execution = lane.pane ? "unknown" : "no linked process";
      if (lane.pane) {
        try {
          const observation = await laneObservation(lane.pane);
          execution = `${observation.status}${observation.reason ? `: ${observation.reason}` : ""}`;
        } catch (error) { if (!(error instanceof AdminError)) throw error; }
      }
      return { ...record, summary: `${record.summary}\nSession execution: ${execution}` };
    });
  }

  private async audit(): Promise<AdminRecord[]> {
    const rows = this.runtime.admin.query<{ id: string; actor: string; action: string; target: string; channel: string | null; user: string | null; created_at: number; status: string }, []>(
      "SELECT id,actor,action,target,channel,user,created_at,status FROM operations ORDER BY created_at DESC,id DESC").all();
    return readRecords(rows, async row => {
      if (row.channel && !await this.runtime.access.canRead(row.channel, row.user ?? undefined)) return undefined;
      return { id: row.id, title: row.action, user: row.actor, revision: row.status, state: row.status,
        summary: `<@${row.actor}> | ${row.target}\n${row.status} | <t:${Math.floor(row.created_at / 1000)}:R>` };
    });
  }

  async read(section: Section, target?: string, suggest = false): Promise<AdminRecord[]> {
    const { delivery, access, published } = this.runtime;
    switch (section) {
      case "conversations": return this.topics(target);
      case "lanes": return this.lanes(target, suggest);
      case "blocks": return Promise.all(delivery.moderation.list().map(async row => ({
        id: row.user_id, title: await access.userLabel(row.user_id), user: row.user_id,
        source: row.source === "auto" ? "auto" : "manual", revision: stamp(JSON.stringify(row)),
        summary: `<@${row.user_id}> | ${row.source === "auto" ? "Automatic" : "Manual"}\n${escapeMarkdown(row.reason.slice(0, 160))}`,
        fields: [{ name: "Reason", value: row.reason }, { name: "Source", value: row.source === "auto" ? "Automatic" : "Manual" },
          { name: "Recorded actor", value: `<@${row.created_by}>` }, { name: "Blocked", value: `<t:${Math.floor(row.created_at / 1000)}:F>` }],
      })));
      case "channels": return this.policy.channels(target);
      case "audit": return this.audit();
      case "trusted": case "timeouts": case "settings": return this.policy.configuration(section);
      case "overview": {
        const [topics, lanes] = await Promise.all([this.topics(), this.lanes()]);
        const pending = this.policy.applicationStatus().consumers.filter(consumer => !consumer.applied).map(consumer => consumer.name);
        const deployed = this.policy.deployment();
        return [{ id: "overview", title: "Helio", revision: published.revision,
          summary: [syncWarning(this.runtime.state, published.values.HELIO_GITHUB_REPO),
            `${topics.filter(row => row.state !== "resolved" && row.state !== "archived").length} open conversations | ${lanes.filter(row => row.state !== "closed").length} lanes`,
            pending.length ? `Configuration application pending: ${pending.join(", ")}.` : undefined,
            deployed.state === "pending" ? deployed.summary : undefined].filter(Boolean).join("\n"),
        }];
      }
      default: { const unreachable: never = section; return unreachable; }
    }
  }
}
