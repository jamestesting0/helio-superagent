import { CONVERSATION_OUTCOMES } from "../conversations/conversations.ts";
import { Editor } from "./editor.ts";
import type { Access, Interaction } from "./interaction.ts";
import { position, type Panel, type Panels } from "./panels.ts";
import { AdminError, type AdminPolicy, type AdminRecord, type Fields } from "./protocol.ts";
import { actions } from "./render.ts";
import type { APILabelComponent, APIModalInteractionResponse, APIStringSelectComponent, APITextInputComponent } from "discord-api-types/v10";

export class ActionForm {
  constructor(private readonly event: Interaction, private readonly access: Access,
    private readonly panels: Panels) {}

  async open(panel: Panel, revision: number): Promise<APIModalInteractionResponse | undefined> {
    if (this.event.type !== 3) return;
    const filtering = this.event.custom?.endsWith(":filter-ids") && panel.guild === undefined &&
      (panel.section === "conversations" || panel.section === "audit");
    if (!filtering && !this.event.custom?.endsWith(":action")) return;
    const verb = this.event.values[0];
    const action = filtering ? "filters" : panel.section === "conversations" && (verb === "hold" || verb === "close") ? `conversations.${verb}` :
      panel.section === "timeouts" && verb === "set" ? "timeout.set" : undefined;
    if (!action) return;
    if (revision !== panel.revision || (filtering ? panel.screen !== "filters" : !["detail", "activity"].includes(panel.screen)) ||
        panel.pending || panel.proposal) {
      throw new AdminError("changed", "The panel changed. Refresh before choosing this action.");
    }
    const target = filtering ? panel.section : position(panel).selected;
    if (!target) throw new AdminError("changed", "The selected item is no longer available");
    const policy = await this.access.authorize(this.event, action === "timeout.set", 400);
    const expected = action === "timeout.set" ? policy.revision : filtering ? String(revision) : panel.selectedRevision;
    if (expected === undefined) throw new AdminError("changed", "Refresh the selected item before choosing this action");
    let title: string;
    let components: APIModalInteractionResponse["data"]["components"];
    if (filtering) {
      title = panel.section === "audit" ? "Audit actor filter" : "Conversation filters";
      const draft = panel.draft ?? position(panel).filters;
      components = (panel.section === "audit" ? ["user"] : ["user", "channel"]).map((name): APILabelComponent => ({
        type: 18, label: name === "channel" ? "Channel ID" : panel.section === "audit" ? "Actor ID" : "Requester ID",
        description: "Discord ID; leave empty to include everyone or every channel.",
        component: { type: 4, custom_id: name, style: 1, max_length: 30, required: false, value: draft[name] ?? "" },
      }));
    } else {
      let label: string, description: string;
      let component: APIStringSelectComponent | APITextInputComponent;
      if (action === "conversations.close") {
        title = "Close conversation"; label = "Outcome";
        description = "Choose the outcome. You will review closure before anything is removed.";
        component = { type: 3, custom_id: "outcome", placeholder: "Choose an outcome", min_values: 1, max_values: 1,
          required: true, options: CONVERSATION_OUTCOMES.map(value => ({ label: value.replaceAll("_", " "), value })) };
      } else if (action === "conversations.hold") {
        title = "Hold conversation"; label = "Reason"; description = "Explain why requester timers should be suspended.";
        component = { type: 4, custom_id: "reason", style: 2, min_length: 1, max_length: 600, required: true };
      } else {
        const setting = policy.timing.find(setting => setting.key === target);
        if (!setting) throw new AdminError("invalid", "This timing setting is unavailable");
        title = "Set timing value"; label = `Value (${setting.unit})`.slice(0, 45);
        description = `${setting.label}: ${setting.minimum}-${setting.maximum} ${setting.unit}`.slice(0, 100);
        component = { type: 4, custom_id: "value", style: 1, min_length: 1, max_length: 5, required: true,
          value: policy.values[target] ?? "" };
      }
      components = [{ type: 18, label, description, component }];
    }
    const latest = this.panels.get(panel.id, Date.now());
    if (latest.revision !== revision || latest.pending || latest.proposal ||
        (filtering ? latest.section !== target : position(latest).selected !== target)) {
      throw new AdminError("changed", "The panel changed. Refresh before choosing this action.");
    }
    latest.form = { action, target, expected,
      operation: this.event.id, input: {}, label: title };
    this.panels.save(latest, false);
    return { type: 9, data: { custom_id: `ha1:${panel.id}:${panel.revision}:submit-${this.event.id}`, title,
      components } };
  }

  async submit(panel: Panel, records: readonly AdminRecord[], policy: AdminPolicy): Promise<void> {
    const form = panel.form;
    if (!form || this.event.custom !== `ha1:${panel.id}:${panel.revision}:submit-${form.operation}` ||
        panel.pending || panel.proposal || (form.action === "filters" ?
          panel.guild !== undefined || panel.screen !== "filters" || panel.section !== form.target :
          position(panel).selected !== form.target)) {
      throw new AdminError("changed", "This form is no longer current. Refresh and choose the action again.");
    }
    delete panel.form;
    this.panels.save(panel, false);
    const values: Fields = this.event.options;
    if (form.action === "filters") {
      const keys = panel.section === "audit" ? ["user"] : ["user", "channel"];
      if (Object.keys(values).some(key => !keys.includes(key))) throw new AdminError("invalid", "Unknown filter input");
      const draft: Record<string, string> = { ...(panel.draft ?? position(panel).filters) };
      for (const key of keys) {
        const value = (values[key] ?? "").trim();
        if (value && !/^[0-9]{5,30}$/.test(value)) throw new AdminError("invalid", "Enter a valid Discord ID or leave the field empty");
        if (value) draft[key] = value;
        else delete draft[key];
      }
      panel.draft = draft;
      return;
    }
    const current = records.find(record => record.id === form.target);
    const owner = this.event.actor === policy.values.DORI_DISCORD_OWNER_ID;
    if (!current || (form.action === "timeout.set" ? policy.revision !== form.expected : current.revision !== form.expected) ||
        !actions(panel.section, current, owner).some(action => action.value === form.action.split(".").at(-1))) {
      throw new AdminError("changed", "The target changed. Nothing was applied. Refresh and choose the action again.");
    }
    if (form.action === "conversations.close") {
      if (Object.keys(values).length !== 1 || !CONVERSATION_OUTCOMES.some(outcome => outcome === values.outcome)) {
        throw new AdminError("invalid", "Choose a valid conversation outcome");
      }
    } else if (form.action === "conversations.hold") {
      if (Object.keys(values).length !== 1 || !values.reason?.trim() || values.reason.length > 600) {
        throw new AdminError("invalid", "A hold reason of 1-600 characters is required");
      }
    } else {
      await this.access.authorize(this.event, true);
      const setting = policy.timing.find(setting => setting.key === form.target), value = values.value ?? "";
      if (Object.keys(values).length !== 1 || !setting || !/^[0-9]{1,5}$/.test(value) ||
          Number(value) < setting.minimum || Number(value) > setting.maximum) {
        throw new AdminError("invalid", "Enter an integer within the setting's displayed range");
      }
    }
    await new Editor(this.event, this.access, panel => this.panels.save(panel, false)).prepare(panel, current, {
      action: form.action, target: form.target, values, policy,
    });
  }
}
