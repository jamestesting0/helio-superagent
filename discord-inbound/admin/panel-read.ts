import type { Access, Interaction } from "./interaction.ts";
import { position, type Panel } from "./panels.ts";
import type { AdminRecord } from "./protocol.ts";

export async function loadPanel(access: Access, panel: Panel, event: Interaction, refresh: boolean): Promise<AdminRecord[]> {
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
