import type { Access, Interaction } from "./interaction.ts";
import { position, type Panel } from "./panels.ts";
import { AdminError, object, text, type AdminRecord, type Fields } from "./protocol.ts";

export function listFilters(event: Interaction): Fields {
  const filters: Record<string, string> = {};
  if (event.command !== "list") return filters;
  for (const name of ["state", "user", "channel", "source"]) if (event.options[name]) filters[name] = event.options[name];
  if (event.options.policy) filters.state = event.options.policy;
  if (event.options.actor) filters.user = event.options.actor;
  if (event.options.action) filters.action = event.options.action;
  if (event.section === "conversations" && !filters.state) filters.state = "active";
  return filters;
}

export async function loadPanel(access: Access, panel: Panel, event: Interaction, refresh: boolean): Promise<AdminRecord[]> {
  if (panel.section === "overview") {
    let host: Record<string, unknown>;
    try {
      host = object(await access.workspace(event, { action: "status" }));
    } catch (error) {
      if (!(error instanceof AdminError) || error.code === "denied") throw error;
      host = { state: "unavailable", detail: error.message };
    }
    const states: Readonly<Record<string, string>> = {
      stopped: "Workspace closed", idle: "Workspace open · lead stopped", running: "Workspace open · lead running",
      starting: "Starting", stopping: "Stopping", unavailable: "Workspace status unavailable",
    };
    const state = text(host.state, 30);
    const detail = typeof host.detail === "string" ? host.detail : "";
    let runtime: AdminRecord | undefined;
    if (state === "running") {
      try {
        runtime = (await access.runtime(event, { kind: "read", section: "overview", filters: {} }, event.id, 1800)).records[0];
      } catch (error) {
        if (!(error instanceof AdminError) || error.code === "denied") throw error;
      }
    }
    panel.snapshot = Date.now();
    const last: Readonly<Record<string, string>> = {
      running: "Lead verified", stopped: "Shutdown verified",
      "start-failed": "Startup ended before the lead was verified",
      "desktop-unavailable": "Desktop launch failed or expired",
    };
    const latest = typeof host.last === "string" && last[host.last];
    return [{ id: "workspace", title: "Helio workspace", revision: typeof host.revision === "string" ? host.revision : "",
      summary: [states[state] ?? states.unavailable, detail, latest ? `Last operation · ${latest}` : "", runtime?.summary].filter(Boolean).join("\n"),
      fields: runtime?.fields ?? [] }];
  }
  const saved = position(panel);
  if (saved.selected && !["list", "filters", "guidance"].includes(panel.screen)) {
    const current = panel.section === "settings" && saved.selected === "github" && panel.github ? panel.github :
      (await access.runtime(event, { kind: "read", section: panel.section, target: saved.selected, filters: {} })).records[0];
    panel.snapshot = Date.now();
    return current ? [current] : [];
  }
  const response = await access.runtime(event, { kind: "read", section: panel.section, filters: saved.filters });
  const byId = new Map(response.records.map(record => [record.id, record]));
  if (panel.section === "settings" && panel.github) byId.set("github", panel.github);
  if (refresh || saved.ids.length === 0) {
    const first = saved.ids[saved.page * 8];
    saved.ids = response.records.map(record => record.id);
    const index = first === undefined ? -1 : saved.ids.indexOf(first);
    if (index >= 0) saved.page = Math.floor(index / 8);
    panel.snapshot = Date.now();
  } else saved.ids = saved.ids.filter(id => byId.has(id));
  saved.page = Math.min(saved.page, Math.max(0, Math.ceil(saved.ids.length / 8) - 1));
  return saved.ids.flatMap(id => { const record = byId.get(id); return record ? [record] : []; });
}
