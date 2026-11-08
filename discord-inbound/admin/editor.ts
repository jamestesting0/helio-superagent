import { broker, BrokerRefusal } from "./broker.ts";
import { Access, type Interaction } from "./interaction.ts";
import { position, type Panel, type Proposal } from "./panels.ts";
import { AdminError, object, text, type AdminPolicy, type AdminRecord, type Fields } from "./protocol.ts";
import { actions } from "./render.ts";

const confirmationLabels: Readonly<Record<string, string>> = {
  "conversations.close": "Close conversation", "lanes.abandon": "Stop and abandon",
  "trusted.add": "Grant trust", "trusted.remove": "Remove trust", "channels.set": "Save policy",
};
const ownerAction = (action: string) => action.startsWith("trusted.") || action.startsWith("channels.") ||
  action === "timeout.set" || action === "lanes.abandon";

export class Editor {
  constructor(private readonly event: Interaction, private readonly access: Access,
    private readonly persist: (panel: Panel) => void) {}

  async prepare(panel: Panel, current: AdminRecord | undefined, input: {
    readonly action: string; readonly target: string; readonly values: Fields; readonly policy: AdminPolicy; readonly confirmation?: boolean;
  }): Promise<void> {
    const { action, target, values, policy } = input;
    if (ownerAction(action)) await this.access.authorize(this.event, true);
    const blocked = current?.blockedActions?.[action.split(".").at(-1) ?? ""];
    if (blocked) throw new AdminError("invalid", blocked);
    if (action === "channels.set" && current?.state === "hard_excluded") {
      throw new AdminError("denied", "This channel is protected by a hard privacy boundary");
    }
    const label = current ? actions(panel.section, current, this.event.actor === policy.values.DORI_DISCORD_OWNER_ID)
      .find(item => item.value === action.split(".").at(-1))?.label : undefined;
    const proposal: Proposal = {
      action, target, input: action === "channels.set" ? { value: values.value ?? values.policy ?? "" } : values,
      expected: ownerAction(action) && action !== "lanes.abandon" ? policy.revision : current?.revision ?? "",
      operation: this.event.id, label: confirmationLabels[action] ?? label ?? (action === "blocks.add" ? "Block user" : "Apply"),
      ...(this.event.users?.[target] ? { targetLabel: this.event.users[target] } : {}),
    };
    if (confirmationLabels[action] || input.confirmation) {
      panel.proposal = proposal;
      panel.screen = "confirm";
      return;
    }
    await this.apply(panel, proposal);
  }

  async commit(panel: Panel, policy: AdminPolicy, current: AdminRecord | undefined): Promise<void> {
    const proposed = panel.proposal;
    if (!proposed) throw new AdminError("invalid", "This panel has no pending change");
    const configuration = ownerAction(proposed.action) && proposed.action !== "lanes.abandon";
    const creation = proposed.action === "blocks.add" && !current && proposed.expected === "";
    if (configuration ? policy.revision !== proposed.expected :
        !creation && (!current || current.id !== proposed.target || current.revision !== proposed.expected)) {
      panel.screen = "unavailable";
      panel.notice = "The target changed. Nothing was applied. Refresh to review the current state and saved proposed values.";
      return;
    }
    await this.apply(panel, proposed);
  }

  async review(panel: Panel, proposed: Proposal, policy: AdminPolicy, current: AdminRecord | undefined): Promise<void> {
    const configuration = ownerAction(proposed.action) && proposed.action !== "lanes.abandon";
    const creation = proposed.action === "blocks.add" && !current;
    if (!configuration && !creation && (!current || !actions(panel.section, current,
      this.event.actor === policy.values.DORI_DISCORD_OWNER_ID).some(item => item.value === proposed.action.split(".").at(-1)))) {
      panel.notice = "Nothing was applied. This action is unavailable for the current target; the proposed values are retained.";
      return;
    }
    await this.prepare(panel, current, { action: proposed.action, target: proposed.target,
      values: proposed.input, policy, confirmation: true });
    panel.contentPage = 0;
    panel.notice = "Nothing was applied. Review the current target and saved proposed values before choosing again.";
  }

  private async apply(panel: Panel, proposed: Proposal): Promise<void> {
    panel.proposal = proposed;
    await this.access.authorize(this.event, ownerAction(proposed.action));
    delete panel.proposal;
    panel.pending = proposed;
    panel.screen = "pending";
    this.persist(panel);
    try {
      if (proposed.action.startsWith("trusted.") || proposed.action === "channels.set" || proposed.action === "timeout.set") {
        const receipt = object(await broker({ kind: "configure", actor: this.event.actor,
          operation: proposed.operation, expected: proposed.expected, action: proposed.action,
          target: proposed.target, value: proposed.input.value ?? "" }));
        this.finished(panel, proposed, receipt);
      } else {
        const receipt = await this.access.runtime(this.event, {
          kind: "mutate", action: proposed.action, target: proposed.target,
          expected: proposed.expected, input: proposed.input,
        }, proposed.operation);
        this.finished(panel, proposed, object(receipt));
      }
    } catch (error) {
      if (!(error instanceof AdminError)) throw error;
      if (error instanceof BrokerRefusal && error.code !== "uncertain") {
        delete panel.pending;
        if (error.code !== "denied") panel.proposal = proposed;
        this.persist(panel);
        throw error;
      }
      await this.reconcile(panel);
    }
  }

  async reconcile(panel: Panel): Promise<void> {
    const proposed = panel.pending;
    if (!proposed) throw new AdminError("invalid", "No submitted operation awaits inspection");
    await this.access.authorize(this.event, ownerAction(proposed.action));
    try {
      const saved = object(await broker({ kind: "operation", actor: this.event.actor, operation: proposed.operation }));
      if (saved.status === "done") {
        this.finished(panel, proposed, object(saved.result));
        return;
      }
      if (saved.status === "refused") {
        const reason = text(object(saved.result).error, 800);
        delete panel.pending;
        panel.proposal = proposed;
        panel.screen = "unavailable";
        panel.notice = `Not applied. ${reason}`;
      } else {
        panel.screen = "pending";
        panel.notice = `Checking whether the change applied. Operation ${proposed.operation}. Refresh checks its receipt; it does not submit another change.`;
      }
    } catch (error) {
      if (!(error instanceof AdminError) || error.code === "denied") throw error;
      panel.screen = "pending";
      panel.notice = `Receipt inspection is unavailable. Operation ${proposed.operation} remains unresolved; check again or inspect it in Audit.`;
    }
    this.persist(panel);
  }

  private finished(panel: Panel, proposed: Proposal, outcome: Record<string, unknown>): void {
    panel.notice = proposed.action.startsWith("trusted.") || proposed.action === "channels.set" || proposed.action === "timeout.set" ?
      `${proposed.action === "trusted.add" ? "Trust granted." : proposed.action === "trusted.remove" ? "Trust removed." :
        proposed.action === "channels.set" ? `Channel policy set to ${proposed.input.value}.` : "Setting saved."} ${text(outcome.application, 200)}` :
      text(outcome.notice, 1000);
    delete panel.pending;
    position(panel).ids = [];
    position(panel).selected = proposed.target;
    panel.screen = "detail";
    panel.contentPage = 0;
    this.persist(panel);
  }
}
