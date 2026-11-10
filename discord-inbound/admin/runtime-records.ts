import type { Conversation } from "../conversations/conversations.ts";
import { readLanes } from "./lane-records.ts";
import { laneEvidence } from "./lane-evidence.ts";
import { laneObservation } from "./lane-session.ts";
import { PolicyRecords } from "./policy-records.ts";
import { AdminError, type AdminRecord, type DisplayField, type Section } from "./protocol.ts";
import { escapeMarkdown, stamp, stateName } from "./record-format.ts";
import type { RuntimeState } from "./runtime-state.ts";
import { syncWarning } from "./github-status.ts";
import { readRecords } from "./record-reads.ts";
import { messageUrl, referenceLink, type DiscordReference } from "../messages/references.ts";

const topicId = (row: Conversation) => `${row.channel_id}:${row.user_id}:${row.anchor_message_id}:${row.opened_at}`;

export class RuntimeRecords {
  readonly policy: PolicyRecords;
  constructor(private readonly runtime: RuntimeState) { this.policy = new PolicyRecords(runtime); }

  private async topic(row: Conversation, detail: boolean, suggest: boolean): Promise<AdminRecord> {
    const { conversations, published, access } = this.runtime;
    // Each message is shown only to someone who can read the channel it was said in; a DM is checked against its person.
    const placed = detail ? conversations.placedTranscriptOf(row) : [];
    const dmPerson = new Map(placed.filter(item => !item.entry.bot).map(item => [item.channel, item.entry.author_id]));
    const visible = detail ? (await Promise.all(placed.map(async item =>
      await access.canRead(item.channel, item.entry.bot ? dmPerson.get(item.channel) ?? row.user_id : item.entry.author_id) ? item : undefined)))
      .filter((item): item is typeof placed[number] => item !== undefined) : [];
    const transcript = visible.map(item => item.entry);
    const guilds = new Map(await Promise.all([...new Set(visible.map(item => item.channel))]
      .map(async id => [id, (await access.channel(id)).guild_id || "@me"] as const)));
    const knownName = detail ? transcript.findLast(entry => entry.author_id === row.user_id)?.author :
      suggest ? undefined : this.runtime.conversationDb.query<{ author: string | null }, [string, string, number, string]>(
        "SELECT json_extract(entry,'$.author') AS author FROM transcript WHERE channel_id=? AND user_id=? AND opened_at=? AND author_id=? ORDER BY rowid DESC LIMIT 1")
        .get(row.channel_id, row.user_id, row.opened_at, row.user_id)?.author ?? undefined;
    const user: DiscordReference = { kind: "user", id: row.user_id,
      label: suggest ? knownName || "Requester" : await access.userLabel(row.user_id, knownName) };
    const channel = await access.channel(row.channel_id);
    const source: DiscordReference = { kind: "message", id: row.anchor_message_id, channel: row.channel_id,
      guild: channel.guild_id || "@me", label: "Original message" };
    const state = conversations.state(row);
    const timeoutHours = Number(published.values.HELIO_CONVERSATION_TIMEOUT_HOURS);
    const nudgeHours = Number(published.values.HELIO_CONVERSATION_NUDGE_HOURS);
    const due = row.question_started_at === null ? undefined :
      row.question_started_at + (row.nudged_at === null ? nudgeHours : timeoutHours) * 3_600_000;
    const fields: DisplayField[] = [
      { name: "State", value: stateName(state) }, { name: "User", value: user },
      ...(detail ? [{ name: "Participants", value: conversations.participants(row.anchor_message_id)
        .map(person => `<@${person.user_id}>${person.notify ? "" : " (muted)"}`).join(" ") || "None" }] : []),
      { name: "Channel", value: `<#${row.channel_id}>` }, { name: "Original message", value: source },
      ...(["request", "decided", "waiting_on", "result"] as const).flatMap(name =>
        row[name] ? [{ name: ({ request: "Request", decided: "Decision", waiting_on: "Waiting on", result: "Result" })[name], value: row[name] }] : []),
      ...(row.hold_reason ? [{ name: "Hold reason", value: row.hold_reason }] : []),
      ...(state === "waiting_on_requester" && due ? [{ name: "Next timer", value: `<t:${Math.floor(due / 1000)}:F> (<t:${Math.floor(due / 1000)}:R>)` }] : []),
      ...(row.outcome ? [{ name: "Outcome", value: row.outcome }] : []),
      ...(row.issue ? [{ name: "Issue", value: row.issue }] : []),
    ];
    return { id: topicId(row), title: row.topic, state, user: row.user_id, channel: row.channel_id,
      revision: String(row.revision), summary: `${referenceLink(user)} | <#${row.channel_id}>\n${stateName(state)}${state === "waiting_on_requester" && due ? ` | Due <t:${Math.floor(due / 1000)}:R>` : ""}`,
      url: messageUrl(source.guild, row.channel_id, row.anchor_message_id),
      ...(detail ? { fields, activity: visible.map(({ entry, channel: where }) => ({
        title: entry.author || (entry.bot ? "Helio" : "Requester"), text: entry.content ?? "",
        fields: [{ name: "Author", value: { kind: "user", id: entry.author_id, label: entry.author || "Unavailable user" } },
          { name: "Message", value: { kind: "message", id: entry.message_id, channel: where, guild: guilds.get(where) ?? "@me", label: "View message" } }],
      })) } : {}),
    };
  }

  private async topics(target?: string, suggest = false): Promise<AdminRecord[]> {
    const rows = this.runtime.conversationDb.query<Conversation, []>(
      "SELECT * FROM conversations ORDER BY last_activity DESC,opened_at DESC,channel_id,user_id,anchor_message_id").all();
    return readRecords(rows, async row => {
      if (target !== undefined && topicId(row) !== target) return undefined;
      return await this.runtime.access.canRead(row.channel_id, row.user_id) ? this.topic(row, target !== undefined, suggest) : undefined;
    });
  }

  private async lanes(target?: string, suggest = false): Promise<AdminRecord[]> {
    const { state, proof, published, access } = this.runtime;
    return readRecords(readLanes(state, proof.guild, published.values.HELIO_GITHUB_REPO), async ({ lane, record }) => {
      if (target !== undefined && target !== record.id) return undefined;
      const visible = record.channel ? await access.canRead(record.channel) : proof.actor === published.values.DORI_DISCORD_OWNER_ID;
      if (!visible) return undefined;
      if (target !== undefined) {
        const detail = await laneEvidence(this.runtime, lane, record);
        const source = /^discord:\d+:(\d+)$/.exec(lane.source ?? "");
        if (!record.channel || !source?.[1]) return detail;
        const channel = await access.channel(record.channel);
        const message: DiscordReference = { kind: "message", guild: channel.guild_id || "@me",
          channel: record.channel, id: source[1], label: "Original message" };
        const issue = /^issue-(\d+)$/.exec(lane.job ?? "")?.[1];
        return { ...detail, url: messageUrl(message.guild, message.channel, message.id),
          fields: [{ name: "Original message", value: message },
            ...(issue && published.values.HELIO_GITHUB_REPO ? [{ name: "Issue",
              value: `https://github.com/${published.values.HELIO_GITHUB_REPO}/issues/${issue}` }] : []),
            ...(detail.fields ?? [])] };
      }
      if (suggest) return record;
      let execution = lane.pane ? "unavailable" : "not linked";
      let executionStatus = lane.pane ? "unknown" : "missing";
      if (lane.pane) {
        try {
          const observation = await laneObservation(lane.pane);
          executionStatus = observation.status;
          execution = observation.status;
        } catch (error) { if (!(error instanceof AdminError)) throw error; }
      }
      const expectedMissing = (record.state === "hibernated" || record.state === "closed") && executionStatus === "missing";
      return expectedMissing || executionStatus === record.state ? record :
        { ...record, summary: `${record.summary} | Session ${escapeMarkdown(execution)}` };
    });
  }

  private async audit(): Promise<AdminRecord[]> {
    const rows = this.runtime.admin.query<{ id: string; actor: string; action: string; target: string; channel: string | null; user: string | null; created_at: number; status: string }, []>(
      "SELECT id,actor,action,target,channel,user,created_at,status FROM operations ORDER BY created_at DESC,id DESC").all();
    return readRecords(rows, async row => {
      if (row.channel && !await this.runtime.access.canRead(row.channel, row.user ?? undefined)) return undefined;
      const actor: DiscordReference = { kind: "user", id: row.actor, label: await this.runtime.access.userLabel(row.actor) };
      let target = escapeMarkdown(row.target);
      const fields: DisplayField[] = [{ name: "Actor", value: actor }];
      if (row.user) {
        const user: DiscordReference = { kind: "user", id: row.user, label: await this.runtime.access.userLabel(row.user) };
        target = referenceLink(user);
        fields.push({ name: "User", value: user });
      }
      const topic = /^(\d+):(\d+):(\d+):\d+$/.exec(row.target);
      if (topic?.[3] && row.channel === topic[1]) {
        const channel = await this.runtime.access.channel(row.channel);
        const source: DiscordReference = { kind: "message", guild: channel.guild_id || "@me",
          channel: row.channel, id: topic[3], label: "Original message" };
        target = referenceLink(source);
        fields.push({ name: "Original message", value: source });
      }
      return { id: row.id, title: row.action, user: row.actor, revision: row.status, state: row.status,
        fields, summary: `${referenceLink(actor)} | ${target}\n${row.status} | <t:${Math.floor(row.created_at / 1000)}:R>` };
    });
  }

  async read(section: Section, target?: string, suggest = false): Promise<AdminRecord[]> {
    const { delivery, access, published } = this.runtime;
    switch (section) {
      case "conversations": return this.topics(target, suggest);
      case "lanes": return this.lanes(target, suggest);
      case "blocks": return Promise.all(delivery.moderation.list().map(async row => ({
        id: row.user_id, title: suggest ? "Blocked user" : await access.userLabel(row.user_id), user: row.user_id,
        source: row.source === "auto" ? "auto" : "manual", revision: stamp(JSON.stringify(row)),
        summary: `${row.source === "auto" ? "Automatic" : "Manual"} | ${escapeMarkdown(row.reason.slice(0, 160))}`,
          ...(suggest ? {} : { fields: [{ name: "User", value: { kind: "user", id: row.user_id, label: await access.userLabel(row.user_id) } }, { name: "Reason", value: row.reason },
          { name: "Source", value: row.source === "auto" ? "Automatic" : "Manual" },
            { name: "Blocked by", value: row.created_by === "helio" ? "Helio" :
              { kind: "user", id: row.created_by, label: await access.userLabel(row.created_by) } },
            { name: "Blocked", value: `<t:${Math.floor(row.created_at / 1000)}:F>` }] }),
      })));
      case "channels": return this.policy.channels(target);
      case "audit": return this.audit();
      case "trusted": case "timeouts": case "settings": return this.policy.configuration(section);
      case "overview": {
        const [topics, lanes] = await Promise.all([this.topics(undefined, true), this.lanes()]);
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
