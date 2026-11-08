import type { Access, Interaction } from "./interaction.ts";
import { Panels, position, type Panel } from "./panels.ts";
import { AdminError, object, text, type AdminPolicy, type AdminRecord } from "./protocol.ts";
import { render, terminal } from "./render.ts";
import { loadPanel } from "./panel-read.ts";
import { CallError, type Call } from "./transport.ts";

export class PanelOutput {
  constructor(private readonly panels: Panels, private readonly access: Access, private readonly call: Call) {}

  async show(panel: Panel, event: Interaction, records: readonly AdminRecord[], policy: AdminPolicy): Promise<void> {
    const selected = records.find(record => record.id === position(panel).selected);
    delete panel.form;
    if (selected) panel.selectedRevision = selected.revision;
    else delete panel.selectedRevision;
    this.panels.save(panel);
    const response = object(await this.call("PATCH", `/webhooks/${event.application}/${event.token}/messages/@original`, render(panel, records, policy)));
    if (!panel.message) { panel.message = text(response.id, 30); this.panels.save(panel, false); }
    if (panel.screen === "closed") this.panels.remove(panel.id);
  }

  async reloadMutation(panel: Panel, event: Interaction): Promise<readonly AdminRecord[]> {
    this.panels.save(panel);
    try { return await loadPanel(this.access, panel, event, true); }
    catch (error) {
      if (!(error instanceof Error)) throw error;
      panel.notice = `${panel.notice ?? "The operation returned."} Current details are unavailable; refresh to inspect them.`;
      panel.screen = panel.proposal ? "unavailable" : "detail";
      return [];
    }
  }

  async failure(event: Interaction, error: unknown, panel?: Panel): Promise<void> {
    if (!(error instanceof Error)) throw error;
    if (!panel && error instanceof CallError && error.status !== undefined) throw error;
    const message = error instanceof AdminError ? error.message : "Administration is unavailable. Refresh or run /status.";
    if (!panel || error instanceof AdminError && error.code === "denied") {
      if (panel) { delete panel.proposal; this.panels.save(panel); }
      await this.call("PATCH", `/webhooks/${event.application}/${event.token}/messages/@original`, terminal(message));
      return;
    }
    panel.notice = panel.pending ? `${message} Operation ${panel.pending.operation} remains unresolved; Refresh checks its receipt.` :
      panel.proposal ? `Not applied. ${message} Refresh to review the saved values against the current target.` : message;
    if (!panel.pending) panel.screen = "unavailable";
    panel.token = event.token;
    panel.expires = Date.now() + 600_000;
    this.panels.save(panel);
    const response = object(await this.call("PATCH", `/webhooks/${event.application}/${event.token}/messages/@original`, terminal(panel.notice, panel)));
    if (!panel.message) { panel.message = text(response.id, 30); this.panels.save(panel, false); }
  }
}
