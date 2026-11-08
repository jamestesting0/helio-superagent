import type { Panel, Proposal } from "./panels.ts";
import { position } from "./panels.ts";
import { SECTIONS, type AdminPolicy, type AdminRecord, type Section } from "./protocol.ts";
import { clipText as short, escapeMarkdown } from "./record-format.ts";
import { readCommandSync } from "./command-sync-state.ts";
import { join } from "node:path";

interface Field { readonly name: string; readonly value: string }
interface Component {
  readonly type: number;
  readonly custom_id?: string;
  readonly label?: string;
  readonly emoji?: { readonly name: string };
  readonly style?: number;
  readonly disabled?: boolean;
  readonly url?: string;
  readonly placeholder?: string;
  readonly options?: readonly { readonly label: string; readonly value: string; readonly default?: boolean }[];
  readonly components?: readonly Component[];
  readonly min_values?: number;
  readonly max_values?: number;
  readonly default_values?: readonly { readonly id: string; readonly type: "user" | "channel" }[];
}
export interface Message {
  readonly content: string;
  readonly allowed_mentions: { readonly parse: readonly string[] };
  readonly embeds: readonly {
    readonly title: string; readonly description?: string; readonly fields: readonly Field[];
    readonly footer: { readonly text: string };
  }[];
  readonly components: readonly Component[];
}
export const labels: Readonly<Record<Section, string>> = {
  overview: "Overview", conversations: "Conversations", lanes: "Lanes", blocks: "Blocked users",
  trusted: "Trusted users", channels: "Channels", timeouts: "Timeouts", settings: "Settings", audit: "Audit",
};
const row = (...components: readonly Component[]): Component => ({ type: 1, components });
const id = (panel: Panel, verb: string) => `ha1:${panel.id}:${panel.revision}:${verb}`;
const button = (panel: Panel, verb: string, label: string | { readonly name: string }, disabled = false, style = 2): Component =>
  ({ type: 2, custom_id: id(panel, verb), ...(typeof label === "string" ? { label } : { emoji: label }), style, disabled });
const previous = { name: "\u25C0\uFE0F" };
const next = { name: "\u25B6\uFE0F" };
const select = (panel: Panel, verb: string, placeholder: string, options: readonly { readonly label: string; readonly value: string; readonly default?: boolean }[]): Component =>
  ({ type: 3, custom_id: id(panel, verb), placeholder, options });
const sectionRow = (panel: Panel) => row(select(panel, "section", labels[panel.section],
  SECTIONS.map(value => ({ label: labels[value], value, default: value === panel.section }))));

export function actions(section: Section, record: AdminRecord, owner: boolean): readonly { readonly label: string; readonly value: string }[] {
  let entries: readonly string[] = [];
  switch (section) {
    case "conversations":
      entries = record.state === "resolved" ? ["reopen"] : record.state === "archived" ? [] :
        record.state === "on_hold" ? ["resume", "close"] : ["hold", "close"]; break;
    case "lanes":
      entries = record.state === "closed" ? [] : record.state === "paused" || record.state === "hibernated" ?
        ["resume", "close", ...(owner ? ["abandon"] : [])] : [
          ...(["working", "not-done"].includes(record.state ?? "working") ? ["pause"] : []),
          "close", ...(owner ? ["abandon"] : []),
        ]; break;
    case "blocks": entries = ["remove"]; break;
    case "trusted": entries = owner ? ["remove"] : []; break;
    case "channels": entries = owner && record.state !== "hard_excluded" ? ["normal", "trusted", "ignored"] : []; break;
    case "timeouts": entries = owner ? ["set"] : []; break;
    case "settings": entries = record.id === "github" ? ["check"] : []; break;
    case "overview": case "audit": break;
  }
  return entries.filter(value => !record.blockedActions?.[value]).map(value => ({ label: ({
    hold: "Hold", resume: "Resume", close: section === "lanes" ? "Verify and close" : "Close",
    reopen: "Reopen", pause: "Pause", abandon: "Stop and abandon", remove: section === "trusted" ? "Remove trust" : "Unblock",
    normal: "Normal", trusted: "Trusted", ignored: "Ignored", set: "Set value", check: "Check access",
  })[value] ?? value, value }));
}

export function filterOptions(section: Section): readonly string[] {
  switch (section) {
    case "conversations": return ["active", "all", "waiting_on_helio", "waiting_on_requester", "on_hold", "resolved", "archived"];
    case "lanes": return ["active", "all", "working", "paused", "hibernated", "done-claimed", "not-done", "closed"];
    case "blocks": return ["all", "manual", "auto"];
    case "channels": return ["all", "normal", "trusted", "ignored"];
    case "audit": return ["all", "done", "refused", "uncertain", "running"];
    case "overview": case "trusted": case "timeouts": case "settings": return [];
  }
}

function contentFields(source: readonly Field[]): Field[] {
  return source.flatMap(field => {
    const value = escapeMarkdown(field.value || "(empty)");
    const chunks: Field[] = [];
    for (let offset = 0; offset < value.length;) {
      let end = Math.min(offset + 780, value.length);
      if (end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1] ?? "")) end -= 1;
      chunks.push({ name: short(escapeMarkdown(field.name) + (offset ? " (continued)" : ""), 100), value: value.slice(offset, end) });
      offset = end;
    }
    return chunks;
  });
}

function proposalFields(proposed: Proposal | undefined): Field[] {
  if (!proposed) return [];
  return contentFields([{ name: "Target", value: proposed.target },
    ...Object.entries(proposed.input).filter(([name, value]) =>
      !["topic", "lane", "entry", "channel", "setting", "user"].includes(name) || value !== proposed.target)
      .map(([name, value]) => ({ name, value }))]);
}

export function render(panel: Panel, records: readonly AdminRecord[], policy: AdminPolicy): Message {
  if (panel.screen === "closed") return terminal("Panel closed.");
  if (panel.screen === "unavailable") return terminal(panel.notice ?? "This source is unavailable. Refresh to check again.", panel);
  const owner = panel.actor === policy.values.DORI_DISCORD_OWNER_ID;
  const saved = position(panel);
  const selected = records.find(record => record.id === saved.selected);
  const controls: Component[] = panel.screen === "pending" ? [] : [sectionRow(panel)];
  const fields: Field[] = [];
  let title = labels[panel.section], description = panel.notice ?? "", footer = "";
  if (panel.screen === "pending") {
    title = "Checking change";
    fields.push({ name: "Operation", value: panel.pending?.operation ?? "" });
    controls.push(row(button(panel, "refresh", "Refresh")));
  } else if (panel.screen === "filters") {
    title += " filters";
    const draft = panel.draft ?? saved.filters;
    const key = panel.section === "blocks" ? "source" : "state";
    const values = filterOptions(panel.section);
    if (values.length) controls.push(row(select(panel, `filter-${key}`, key === "source" ? "Source" : "State",
      values.map(value => ({ label: value.replaceAll("_", " "), value, default: value === (draft[key] ?? "all") })))));
    if (panel.guild !== undefined && (panel.section === "conversations" || panel.section === "audit")) controls.push(row({
      type: 5, custom_id: id(panel, "filter-user"), placeholder: panel.section === "audit" ? "Actor" : "Requester",
      min_values: 0, max_values: 1, ...(draft.user ? { default_values: [{ id: draft.user, type: "user" }] } : {}),
    }));
    if (panel.guild !== undefined && panel.section === "conversations") controls.push(row({
      type: 8, custom_id: id(panel, "filter-channel"), placeholder: "Channel", min_values: 0, max_values: 1,
      ...(draft.channel ? { default_values: [{ id: draft.channel, type: "channel" }] } : {}),
    }));
    if (panel.guild === undefined) description = [description, panel.section === "conversations" ?
      "Set user/channel filters with `/conversations list user:<user> channel:<channel ID>`. Channel autocomplete searches the configured server." :
      panel.section === "audit" ? "Set the actor filter with `/audit list actor:<user>`." : ""].filter(Boolean).join("\n\n");
    controls.push(row(button(panel, "apply-filters", "Apply", false, 1),
      button(panel, "clear-filters", "Clear"), button(panel, "back", "Back")));
  } else if (panel.screen === "confirm") {
    title = panel.proposal?.label ?? "Review change";
    description = [description, selected ? `**${escapeMarkdown(selected.title)}**\n${selected.summary}` : panel.proposal?.target,
      panel.proposal?.action === "conversations.close" ? "Closing removes the retained transcript." :
      panel.proposal?.action === "lanes.abandon" ? "Stops a safely paused or idle agent after verifying its checkpoint, then records abandonment. The worktree and checkpoint are retained." :
      panel.proposal?.action === "trusted.add" ? "This grants contributor administration access." :
      panel.proposal?.action === "trusted.remove" ? "This revokes contributor administration access." :
      panel.proposal?.action === "channels.set" ? `${selected?.state ?? "Current policy"} -> ${panel.proposal.input.value}` : "",
    ].filter(Boolean).join("\n\n");
    const proposed = proposalFields(panel.proposal);
    const pages = Math.max(1, Math.ceil(proposed.length / 5)), page = Math.min(panel.contentPage, pages - 1);
    fields.push(...proposed.slice(page * 5, page * 5 + 5));
    controls.push(row(button(panel, "commit", panel.proposal?.label ?? "Save", false,
      ["conversations.close", "lanes.abandon", "trusted.remove"].includes(panel.proposal?.action ?? "") ? 4 : 1),
      button(panel, "cancel", "Cancel")));
    if (pages > 1) controls.push(row(button(panel, "content-prev", previous, page === 0),
      button(panel, "content-next", next, page + 1 >= pages)));
  } else if (panel.screen === "guidance") {
    title = "Choose command inputs";
    if (panel.guild === undefined && panel.draft?.entity) {
      description = panel.draft.entity === "channel" ?
        "Use `/channels show channel:<channel ID>`; autocomplete lists visible configured channels." :
        panel.section === "trusted" ? "Use `/trusted add user:<user>` to preview a grant." :
        "Use `/blocks add user:<user> reason:<reason>`.";
    }
    if (panel.guild !== undefined && panel.draft?.entity === "user") controls.push(row({
      type: 5, custom_id: id(panel, "entity-user"), placeholder: "Choose user", min_values: 1, max_values: 1,
    }));
    if (panel.guild !== undefined && panel.draft?.entity === "channel") controls.push(row({
      type: 8, custom_id: id(panel, "entity-channel"), placeholder: "Choose channel", min_values: 1, max_values: 1,
    }));
    controls.push(row(button(panel, "back", "Back")));
  } else if (panel.screen === "detail" || panel.screen === "activity") {
    if (!selected) {
      description = [description, `This ${panel.section === "conversations" ? "conversation" : "item"} is no longer available.`].filter(Boolean).join("\n");
    } else {
      title = short(escapeMarkdown(selected.title), 200);
      const activity = panel.screen === "activity";
      const raw = activity ? selected.activity?.map(entry => ({ name: entry.title, value: entry.text })) : selected.fields;
      const source = contentFields(raw?.length ? raw : [{ name: activity ? "Activity" : "Summary",
        value: activity ? "Transcript unavailable under retention rules." : selected.summary }]);
      const pages = Math.ceil(source.length / 5);
      const page = Math.min(panel.contentPage, Math.max(0, pages - 1));
      fields.push(...source.slice(page * 5, page * 5 + 5));
      footer = `${activity ? "Activity" : "Details"} | Page ${page + 1} of ${Math.max(1, pages)}`;
      if (selected.activity !== undefined) controls.push(row(select(panel, "view", activity ? "Activity" : "Summary",
        [{ label: "Summary", value: "detail", default: !activity }, { label: "Activity", value: "activity", default: activity }])));
      const available = actions(panel.section, selected, owner);
      if (available.length) controls.push(row(select(panel, "action", "Actions", available)));
      if (pages > 1) controls.push(row(button(panel, "content-prev", previous, page === 0),
        button(panel, "content-next", next, page + 1 >= pages)));
    }
    controls.push(row(button(panel, "back", "Back"),
      ...(selected?.url ? [{ type: 2, style: 5, label: "Source", url: selected.url }] : []),
      button(panel, "refresh", "Refresh")));
  } else if (panel.section === "overview") {
    const overview = records[0];
    description = [description, overview?.summary].filter(Boolean).join("\n");
    const observation = readCommandSync(join(process.env.HELIO_ADMIN_STATE_DIR ??
      join(process.env.HOME ?? "", ".local/state/helio-admin"), "commands.json"));
    fields.push({ name: "Command registration", value: observation ? short([
      observation.pid === process.pid ? "" : "Previous controller observation; recheck pending.",
      ...[{ name: "DM", value: observation.dm }, { name: "Guild", value: observation.guild }].map(({ name, value }) =>
        `${name}: ${value.state}${value.changes ? ` (${value.changes.created} created, ${value.changes.updated} updated, ${value.changes.unchanged} unchanged)` : ""}` +
        (value.reason ? `: ${short(escapeMarkdown(value.reason), 140)}` : "") +
        (value.retryAt ? `; retry <t:${Math.floor(value.retryAt / 1000)}:R>` : "")),
      `Checked <t:${Math.floor(observation.checkedAt / 1000)}:R>. Runtime readiness is reported separately.`,
    ].filter(Boolean).join("\n"), 900) : "No registration observation yet." });
    fields.push(...(overview?.fields ?? []).map(field => ({ name: field.name, value: short(field.value, 900) })));
    controls.push(row(button(panel, "refresh", "Refresh")));
  } else {
    const byId = new Map(records.map(record => [record.id, record]));
    const listed = saved.ids.flatMap(id => { const record = byId.get(id); return record ? [record] : []; });
    const page = Math.min(saved.page, Math.max(0, Math.ceil(listed.length / 8) - 1));
    const visible = listed.slice(page * 8, page * 8 + 8);
    const applied = Object.entries(saved.filters).filter(([, value]) => value && value !== "all");
    if (applied.length) description = [description, applied.map(([key, value]) => `${key}: ${escapeMarkdown(value)}`).join(" | ")].filter(Boolean).join("\n");
    fields.push(...visible.map(record => ({ name: short(escapeMarkdown(record.title), 100), value: short(record.summary, 350) || "(empty)" })));
    if (!visible.length) description = [description, applied.length ? `No ${labels[panel.section].toLowerCase()} match these filters.` :
      `No ${labels[panel.section].toLowerCase()}.`].filter(Boolean).join("\n");
    if (visible.length) controls.push(row(select(panel, "item", "Open item",
      visible.map((record, index) => ({ label: short(record.title, 100), value: String(page * 8 + index) })))));
    controls.push(row(button(panel, "prev", previous, page === 0), button(panel, "next", next, (page + 1) * 8 >= listed.length),
      ...(filterOptions(panel.section).length ? [button(panel, "filters", "Filters")] : []),
      button(panel, "refresh", "Refresh")));
    footer = `Page ${page + 1} of ${Math.max(1, Math.ceil(listed.length / 8))} | As of ${new Date(panel.snapshot).toISOString().slice(11, 16)} UTC`;
  }
  const footerText = footer || "Helio administration";
  const descriptionBudget = Math.min(1400, 5000 - title.length - footerText.length -
    fields.reduce((sum, field) => sum + field.name.length + field.value.length, 0));
  return { content: "", allowed_mentions: { parse: [] },
    embeds: [{ title, ...(description ? { description: short(description, descriptionBudget) } : {}), fields: fields.slice(0, 10), footer: { text: footerText } }],
    components: controls };
}

export function terminal(description: string, panel?: Panel): Message {
  const fields = proposalFields(panel?.proposal).slice(0, 5);
  const budget = Math.min(1400, 5000 - fields.reduce((sum, field) => sum + field.name.length + field.value.length, 0));
  return { content: "", allowed_mentions: { parse: [] },
    embeds: [{ title: panel?.proposal?.label ?? "Helio", description: short(description, budget), fields, footer: { text: "Helio administration" } }],
    components: panel ? [row(button(panel, "refresh", "Refresh"),
      ...(!panel.pending ? [button(panel, "back", "Back")] : []))] : [] };
}
