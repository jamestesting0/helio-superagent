import { randomBytes } from "node:crypto";
import { CallError, type Call } from "./transport.ts";
import { Editor } from "./editor.ts";
import { Access, autocomplete, interaction, type Interaction } from "./interaction.ts";
import { Panels, position, type Panel } from "./panels.ts";
import { AdminError, isAdminInteraction, object, section, text, type AdminPolicy, type AdminRecord } from "./protocol.ts";
import { actions, terminal } from "./render.ts";
import { listFilters, loadPanel } from "./panel-read.ts";
import { PanelOutput } from "./panel-output.ts";
import { ActionForm } from "./forms.ts";

type WorkspaceControl = "start" | "review-stop" | "stop" | "cancel";
interface WorkspaceWatch {
  readonly event: Interaction;
  readonly revision: number;
  readonly state: string;
  readonly until: number;
}

const lifecycleReply: Readonly<Record<string, string>> = {
  "busy-start": "Helio is starting. Wait for it to finish before issuing another command.",
  "busy-stop": "Helio is stopping. Wait for it to finish before issuing another command.",
  "busy": "Helio is handling another lifecycle command. Check /status.",
  "already-running": "Helio is already running.",
  "already-stopped": "Helio is already stopped.",
  "running": "Helio is running.",
  "stopped": "Helio stopped.",
  "start-failed": "The launch ended before the lead was verified. Check /status.",
  "desktop-unavailable": "The foreground desktop did not start Helio. Sign in on the host and check the Helio Foreground Start task.",
  "changed": "The workspace changed. Review the current workspace before stopping it.",
};

export class Controller {
  private readonly access = new Access();
  private readonly output: PanelOutput;
  private readonly workspaceWatches = new Map<string, WorkspaceWatch>();
  constructor(private readonly panels: Panels, private readonly call: Call,
    private readonly lifecycleId: (event: Interaction) => string | undefined = () => undefined) {
    this.output = new PanelOutput(panels, this.access, call);
  }

  async handle(raw: unknown): Promise<void> {
    if (!isAdminInteraction(raw)) return;
    const event = interaction(raw);
    if (event.type === 4) {
      await this.call("POST", `/interactions/${event.id}/${event.token}/callback`, {
        type: 8, data: { choices: await autocomplete(event, this.access, this.panels.preferred(event.actor, event.section, Date.now())) },
      });
      return;
    }
    if (event.type === 3 || event.type === 5) {
      const match = /^ha1:([a-f0-9]{24}):(\d+):([a-z0-9-]+)$/.exec(event.custom ?? "");
      if (!match?.[1] || !match[2] || !match[3]) return;
      const [, id, revision, verb] = match;
      try {
        const panel = this.panels.get(id, Date.now());
        this.binding(panel, event);
        if (event.type === 5 && !/^submit-\d+$/.test(verb)) throw new AdminError("invalid", "Unknown form");
        const modal = await new ActionForm(event, this.access, this.panels).open(panel, Number(revision));
        if (modal) {
          await this.call("POST", `/interactions/${event.id}/${event.token}/callback`, modal);
          return;
        }
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
    let panel: Panel | undefined;
    try {
      await this.call("POST", `/interactions/${event.id}/${event.token}/callback`, { type: 5, data: { flags: 64 } });
      const filters = listFilters(event);
      panel = {
        id: randomBytes(12).toString("hex"), actor: event.actor, channel: event.channel,
        ...(event.guild === undefined ? {} : { guild: event.guild }),
        application: event.application, message: "", token: event.token, expires: Date.now() + 600_000,
        revision: 0, section: event.section, positions: {}, screen: "list", contentPage: 0, snapshot: Date.now(),
      };
      panel.positions[panel.section] = { ids: [], page: 0, filters };
      if (event.command === "start" || event.command === "stop") {
        await this.workspaceCommand(event, panel);
        return;
      }
      const policy = await this.access.authorize(event);
      const saved = position(panel);
      const target = event.options.topic ?? event.options.lane ?? event.options.entry ??
        (event.command === "set" || event.command === "show" ? event.options.channel ?? event.options.setting ?? event.options.section : undefined);
      if (target) { saved.selected = target; panel.screen = "detail"; }
      let records: readonly AdminRecord[] = event.options.dependency === "github" ? [] : await loadPanel(this.access, panel, event, true);
      if (!["list", "show", "status"].includes(event.command)) {
        const action = event.section === "timeouts" ? "timeout.set" : `${event.section}.${event.command}`;
        const selected = records.find(row => row.id === target);
        await new Editor(event, this.access, panel => this.panels.save(panel, false)).prepare(panel, selected, {
          action, target: target ?? event.options.user ?? "", values: event.options, policy,
        });
        if (panel.screen !== "confirm" && !panel.pending) records = await this.output.reloadMutation(panel, event);
      }
      if (event.options.dependency === "github" || event.section === "settings" && event.options.section === "github") {
        panel.section = "settings";
        panel.positions.settings = { ids: ["github"], selected: "github", page: 0, filters: {} };
        panel.screen = "detail";
        records = (await this.access.runtime(event, { kind: "probe", dependency: "github" })).records;
        panel.github = records.find(record => record.id === "github");
      }
      await this.show(panel, event, records, await this.access.authorize(event));
    } catch (error) { await this.output.failure(event, error, panel); }
  }

  private async workspaceCommand(event: Interaction, panel: Panel): Promise<void> {
    if (!event.commandId || this.lifecycleId(event) !== event.commandId) {
      throw new AdminError("denied", "This lifecycle command has not been verified for this installation.");
    }
    await this.workspaceControl(panel, event, event.command === "start" ? "start" : "review-stop");
  }

  private async workspaceControl(panel: Panel, event: Interaction, control: WorkspaceControl): Promise<void> {
    const expected = panel.stopRevision;
    delete panel.notice;
    delete panel.stopRevision;
    panel.token = event.token;
    panel.expires = Date.now() + 600_000;
    if (control === "start" || control === "stop") {
      const request = control === "start" ? { action: "start", operation: event.id } as const :
        { action: "stop", operation: event.id, expected: text(expected, 64) } as const;
      try {
        const result = text(await this.access.workspace(event, request), 40);
        if (result !== "start-pending" && result !== "stop-pending") {
          panel.notice = lifecycleReply[result] ?? "The workspace change could not be verified.";
        }
      } catch (error) {
        if (!(error instanceof AdminError) || error.code !== "uncertain") throw error;
        panel.notice = "Checking the workspace after losing the operation response.";
      }
    }
    const records = await loadPanel(this.access, panel, event, true);
    if (control === "review-stop") {
      const current = records[0];
      if (current?.revision && (current.state === "running" || current.state === "idle")) {
        panel.stopRevision = current.revision;
      }
    }
    await this.show(panel, event, records, await this.access.authorize(event));
  }

  private async show(panel: Panel, event: Interaction, records: readonly AdminRecord[], policy: AdminPolicy,
    until = Date.now() + 75_000): Promise<void> {
    await this.output.show(panel, event, records, policy);
    const state = records[0]?.state;
    if (panel.section === "overview" && panel.screen === "list" && !panel.stopRevision &&
        (state === "starting" || state === "stopping")) {
      this.workspaceWatches.set(panel.id, { event, revision: panel.revision, state, until });
    } else {
      this.workspaceWatches.delete(panel.id);
    }
  }

  async refreshWorkspaces(): Promise<void> {
    await Promise.all([...this.workspaceWatches].map(async ([id, watch]) => {
      try {
        const panel = this.panels.get(id, Date.now());
        if (panel.revision !== watch.revision) {
          this.workspaceWatches.delete(id);
          return;
        }
        const records = await loadPanel(this.access, panel, watch.event, true);
        const waiting = records[0]?.state === watch.state;
        const expired = Date.now() >= watch.until;
        if (waiting && !expired) return;
        const policy = await this.access.authorize(watch.event, false, 1700);
        await this.panels.serialize(id, async () => {
          if (this.workspaceWatches.get(id) !== watch || this.panels.get(id, Date.now()).revision !== watch.revision) return;
          delete panel.notice;
          if (waiting) panel.notice = "Still waiting for the host. Use Refresh to check again.";
          await this.show(panel, watch.event, records, policy, watch.until);
          if (expired) this.workspaceWatches.delete(id);
        });
      } catch (error) {
        if (this.workspaceWatches.get(id) === watch) this.workspaceWatches.delete(id);
        if (!(error instanceof AdminError) && !(error instanceof CallError)) throw error;
      }
    }));
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
        this.workspaceWatches.delete(panel.id);
        return;
      }
      if (verb.startsWith("workspace-")) {
        if (panel.revision !== revision) return;
        if (panel.section !== "overview" || panel.screen !== "list") {
          throw new AdminError("changed", "This control expired. Refresh the status panel.");
        }
        if (panel.stopRevision && (verb === "workspace-stop" || verb === "workspace-cancel")) {
          await this.workspaceControl(panel, event, verb === "workspace-stop" ? "stop" : "cancel");
        } else if (!panel.stopRevision && (verb === "workspace-start" || verb === "workspace-review-stop")) {
          await this.workspaceControl(panel, event, verb === "workspace-start" ? "start" : "review-stop");
        } else {
          throw new AdminError("changed", "This control is no longer available. Refresh the status panel.");
        }
        return;
      }
      if (panel.stopRevision) throw new AdminError("invalid", "Unknown shutdown confirmation control");
      const policy = await this.access.authorize(event);
      const stale = panel.revision !== revision;
      const editor = new Editor(event, this.access, panel => this.panels.save(panel, false));
      if (panel.pending) {
        await editor.reconcile(panel);
        const records = panel.pending ? [] : await this.output.reloadMutation(panel, event);
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
      if (event.type === 5) {
        await new ActionForm(event, this.access, this.panels).submit(panel, records, policy);
        if (panel.screen !== "confirm" && panel.screen !== "filters" && !panel.pending) records = await this.output.reloadMutation(panel, event);
      } else if (stale) {
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
          else {
            const values: Record<string, string> = {};
            if (panel.section === "channels") values.value = action ?? "";
            if (panel.section === "lanes") values.reason = "Requested through the Discord lane panel.";
            await editor.prepare(panel, selected, {
              action: panel.section === "channels" ? "channels.set" : `${panel.section}.${action}`,
              target: selected.id, values, policy,
            });
            if (panel.screen !== "confirm" && !panel.pending) records = await this.output.reloadMutation(panel, event);
          }
          break;
        }
        case "commit": await editor.commit(panel, policy, selected); records = panel.pending ? [] : await this.output.reloadMutation(panel, event); break;
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
    } catch (error) {
      if (panel && verb.startsWith("workspace-")) delete panel.stopRevision;
      await this.output.failure(event, error, panel);
    }
  }

  async expire(): Promise<void> {
    for (const panel of this.panels.expired(Date.now())) {
      await this.panels.serialize(panel.id, async () => {
        if (!this.panels.expired(Date.now()).some(current => current.id === panel.id)) return;
        try {
          await this.call("DELETE", `/webhooks/${panel.application}/${panel.token}/messages/@original`);
          this.panels.remove(panel.id);
        } catch (error) {
          if (!(error instanceof CallError)) throw error;
          if (error.status === 404 || error.status === 401) this.panels.remove(panel.id);
        }
      });
    }
  }
}
