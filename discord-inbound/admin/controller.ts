import { randomBytes } from "node:crypto";
import { CallError, type Call } from "./transport.ts";
import { Editor } from "./editor.ts";
import { Access, autocomplete, interaction, type Interaction } from "./interaction.ts";
import { Panels, position, type Panel } from "./panels.ts";
import { AdminError, isAdminInteraction, object, section, text, type AdminPolicy, type AdminRecord } from "./protocol.ts";
import { actions, render, terminal } from "./render.ts";
import { listFilters, loadPanel } from "./panel-read.ts";

export class Controller {
  private readonly access = new Access();
  constructor(private readonly panels: Panels, private readonly call: Call) {}

  async handle(raw: unknown): Promise<void> {
    if (!isAdminInteraction(raw)) return;
    const event = interaction(raw);
    if (event.type === 4) {
      await this.call("POST", `/interactions/${event.id}/${event.token}/callback`, {
        type: 8, data: { choices: await autocomplete(event, this.access, this.panels.preferred(event.actor, event.section, Date.now())) },
      });
      return;
    }
    if (event.type === 3) {
      const match = /^ha1:([a-f0-9]{24}):(\d+):([a-z-]+)$/.exec(event.custom ?? "");
      if (!match?.[1] || !match[2] || !match[3]) return;
      const [, id, revision, verb] = match;
      try {
        const panel = this.panels.get(id, Date.now());
        this.binding(panel, event);
      } catch (error) {
        if (!(error instanceof AdminError)) throw error;
        await this.call("POST", `/interactions/${event.id}/${event.token}/callback`, {
          type: 4, data: { ...terminal(error.message), flags: 64 },
        });
        return;
      }
      await this.call("POST", `/interactions/${event.id}/${event.token}/callback`, { type: 6 });
      await this.panels.serialize(id, () => this.component(event, id, Number(revision), verb));
      return;
    }
    await this.call("POST", `/interactions/${event.id}/${event.token}/callback`, { type: 5, data: { flags: 64 } });
    let panel: Panel | undefined;
    try {
      const filters = listFilters(event);
      panel = {
        id: randomBytes(12).toString("hex"), actor: event.actor, channel: event.channel,
        ...(event.guild === undefined ? {} : { guild: event.guild }),
        application: event.application, message: "", token: event.token, expires: Date.now() + 600_000,
        revision: 0, section: event.section, positions: {}, screen: "list", contentPage: 0, snapshot: Date.now(),
      };
      panel.positions[panel.section] = { ids: [], page: 0, filters };
      const policy = await this.access.authorize(event);
      const saved = position(panel);
      const target = event.options.topic ?? event.options.lane ?? event.options.entry ??
        (event.command === "set" || event.command === "show" ? event.options.channel ?? event.options.setting ?? event.options.section : undefined);
      if (target) { saved.selected = target; panel.screen = "detail"; }
      let records: readonly AdminRecord[] = await loadPanel(this.access, panel, event, true);
      if (!["list", "show", "status"].includes(event.command)) {
        const action = event.section === "timeouts" ? "timeout.set" : `${event.section}.${event.command}`;
        const selected = records.find(row => row.id === target);
        await new Editor(event, this.access, panel => this.panels.save(panel, false)).prepare(panel, selected, {
          action, target: target ?? event.options.user ?? "", values: event.options, policy,
        });
        if (panel.screen !== "confirm" && !panel.pending) records = await this.reloadMutation(panel, event);
      }
      if (event.options.dependency === "github" || event.section === "settings" && event.options.section === "github") {
        panel.section = "settings";
        panel.positions.settings = { ids: ["github"], selected: "github", page: 0, filters: {} };
        panel.screen = "detail";
        records = (await this.access.runtime(event, { kind: "probe", dependency: "github" })).records;
        panel.github = records.find(record => record.id === "github");
      }
      await this.show(panel, event, records, await this.access.authorize(event));
    } catch (error) { await this.failure(event, error, panel); }
  }

  private binding(panel: Panel, event: Interaction): void {
    if (panel.actor !== event.actor || panel.guild !== event.guild || panel.channel !== event.channel ||
        panel.application !== event.application || panel.message !== event.message) {
      throw new AdminError("denied", "This panel belongs to another invocation");
    }
  }

  private async component(event: Interaction, id: string, revision: number, verb: string): Promise<void> {
    let panel: Panel | undefined;
    try {
      panel = this.panels.get(id, Date.now());
      this.binding(panel, event);
      if (verb === "close") {
        await this.call("PATCH", `/webhooks/${event.application}/${event.token}/messages/@original`, terminal("Panel closed."));
        this.panels.remove(panel.id);
        return;
      }
      const policy = await this.access.authorize(event);
      const stale = panel.revision !== revision;
      const editor = new Editor(event, this.access, panel => this.panels.save(panel, false));
      if (panel.pending) {
        await editor.reconcile(panel);
        const records = panel.pending ? [] : await this.reloadMutation(panel, event);
        panel.token = event.token;
        panel.expires = Date.now() + 600_000;
        await this.show(panel, event, records, await this.access.authorize(event));
        return;
      }
      const saved = position(panel);
      delete panel.notice;
      const chosenTarget = verb === "item" ? saved.ids[Number(event.values[0])] : undefined;
      if (!stale) {
        if (verb === "section") {
          panel.section = section(event.values[0]);
          panel.positions[panel.section] ??= { ids: [], filters: panel.section === "conversations" ? { state: "active" } : {}, page: 0 };
          panel.screen = "list"; panel.contentPage = 0; delete panel.proposal;
        } else if (verb === "item") {
          const index = Number(event.values[0]);
          if (!Number.isSafeInteger(index) || index < saved.page * 8 || index >= (saved.page + 1) * 8 || !chosenTarget) {
            throw new AdminError("changed", "The selected list item changed");
          }
          saved.selected = chosenTarget; panel.screen = "detail"; panel.contentPage = 0;
        } else if (verb === "back" || verb === "cancel") {
          panel.screen = panel.screen === "confirm" && saved.selected ? "detail" : "list";
          delete panel.proposal; delete panel.draft;
        } else if (verb === "apply-filters" || verb === "clear-filters") {
          saved.filters = verb === "clear-filters" ? {} : panel.draft ?? {};
          saved.page = 0; panel.screen = "list"; delete panel.draft;
        } else if (verb === "entity-channel") {
          saved.selected = text(event.values[0], 30); panel.screen = "detail"; delete panel.draft;
        }
      }
      let records: readonly AdminRecord[] = await loadPanel(this.access, panel, event,
        ["refresh", "apply-filters", "clear-filters"].includes(verb));
      const selectedId = position(panel).selected;
      const selected = records.find(row => row.id === selectedId);
      if (stale) {
        panel.screen = panel.proposal ? "unavailable" : selected ? "detail" : "list";
        panel.notice = "The panel changed. Review its current state.";
      } else switch (verb) {
        case "section": break;
        case "item":
          if (!selected) throw new AdminError("changed", "The selected item is no longer available");
          break;
        case "prev": saved.page = Math.max(0, saved.page - 1); break;
        case "next": saved.page = Math.min(Math.max(0, Math.ceil(saved.ids.length / 8) - 1), saved.page + 1); break;
        case "content-prev": panel.contentPage = Math.max(0, panel.contentPage - 1); break;
        case "content-next": panel.contentPage += 1; break;
        case "view":
          if (event.values[0] !== "detail" && event.values[0] !== "activity") throw new AdminError("invalid", "Unknown detail view");
          panel.screen = event.values[0]; panel.contentPage = 0; break;
        case "filters": panel.screen = "filters"; panel.draft = { ...saved.filters }; break;
        case "filter-state": case "filter-source": case "filter-user": case "filter-channel":
          panel.draft = { ...panel.draft, [verb.slice(7)]: event.values[0] ?? "" }; break;
        case "apply-filters": case "clear-filters": break;
        case "back": case "cancel":
          if (panel.screen === "detail" && !selected) {
            panel.screen = "list"; records = await loadPanel(this.access, panel, event, false);
          }
          break;
        case "refresh":
          if (panel.screen === "unavailable") {
            if (panel.proposal) await editor.review(panel, panel.proposal, policy, selected);
            else panel.screen = saved.selected ? "detail" : "list";
          }
          break;
        case "action": {
          const action = event.values[0];
          if (!selected || !actions(panel.section, selected, event.actor === policy.values.DORI_DISCORD_OWNER_ID).some(item => item.value === action)) {
            throw new AdminError("denied", "This action is unavailable for the current record");
          }
          if (action === "check") {
            records = (await this.access.runtime(event, { kind: "probe", dependency: "github" })).records;
            panel.github = records.find(record => record.id === "github");
            panel.contentPage = 0;
          }
          else if (["hold", "close", "set"].includes(action ?? "") && panel.section !== "lanes") {
            editor.guidance(panel, action ?? "", selected);
          } else {
            const values: Record<string, string> = {};
            if (panel.section === "channels") values.value = action ?? "";
            if (panel.section === "lanes") values.reason = "Requested through the Discord lane panel.";
            await editor.prepare(panel, selected, {
              action: panel.section === "channels" ? "channels.set" : `${panel.section}.${action}`,
              target: selected.id, values, policy,
            });
            if (panel.screen !== "confirm" && !panel.pending) records = await this.reloadMutation(panel, event);
          }
          break;
        }
        case "commit": await editor.commit(panel, policy, selected); records = panel.pending ? [] : await this.reloadMutation(panel, event); break;
        case "add": case "choose-channel":
          panel.screen = "guidance"; panel.draft = { entity: verb === "add" ? "user" : "channel" };
          panel.notice = ""; break;
        case "entity-user": {
          const target = text(event.values[0], 30);
          if (panel.section === "trusted") await editor.prepare(panel, undefined, { action: "trusted.add", target, values: {}, policy });
          else panel.notice = `Use \`/blocks add user:${target} reason:<reason>\`.`;
          delete panel.draft; break;
        }
        case "entity-channel": break;
        default: throw new AdminError("invalid", "Unknown panel control");
      }
      panel.token = event.token;
      panel.expires = Date.now() + 600_000;
      await this.show(panel, event, records, await this.access.authorize(event));
    } catch (error) { await this.failure(event, error, panel); }
  }

  private async show(panel: Panel, event: Interaction, records: readonly AdminRecord[], policy: AdminPolicy): Promise<void> {
    this.panels.save(panel);
    const response = object(await this.call("PATCH", `/webhooks/${event.application}/${event.token}/messages/@original`, render(panel, records, policy)));
    if (!panel.message) { panel.message = text(response.id, 30); this.panels.save(panel, false); }
    if (panel.screen === "closed") this.panels.remove(panel.id);
  }

  private async reloadMutation(panel: Panel, event: Interaction): Promise<readonly AdminRecord[]> {
    this.panels.save(panel);
    try { return await loadPanel(this.access, panel, event, true); }
    catch (error) {
      if (!(error instanceof Error)) throw error;
      panel.notice = `${panel.notice ?? "The operation returned."} Current details are unavailable; refresh to inspect them.`;
      panel.screen = panel.proposal ? "unavailable" : "detail";
      return [];
    }
  }

  private async failure(event: Interaction, error: unknown, panel?: Panel): Promise<void> {
    if (!(error instanceof Error)) throw error;
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

  async expire(): Promise<void> {
    for (const panel of this.panels.expired(Date.now())) {
      await this.panels.serialize(panel.id, async () => {
        if (!this.panels.expired(Date.now()).some(current => current.id === panel.id)) return;
        try {
          await this.call("PATCH", `/webhooks/${panel.application}/${panel.token}/messages/@original`, terminal("Panel expired. Run /status."));
          this.panels.remove(panel.id);
        } catch (error) {
          if (!(error instanceof CallError)) throw error;
          if (error.status === 404 || error.status === 401) this.panels.remove(panel.id);
        }
      });
    }
  }
}
