import { CONVERSATION_OUTCOMES } from "../conversations/conversations.ts";

interface Choice { readonly name: string; readonly value: string }
interface Option {
  readonly type: number;
  readonly name: string;
  readonly description: string;
  readonly required?: boolean;
  readonly autocomplete?: boolean;
  readonly choices?: readonly Choice[];
  readonly options?: readonly Option[];
  readonly min_value?: number;
  readonly max_value?: number;
  readonly max_length?: number;
}
const choices = (values: readonly string[]): readonly Choice[] => values.map(value => ({ name: value.replaceAll("_", " "), value }));
const record = (name: string, description: string): Option => ({ type: 3, name, description, required: true, autocomplete: true });
const user: Option = { type: 6, name: "user", description: "Discord user", required: true };
const channel: Option = { type: 7, name: "channel", description: "Discord channel or category", required: true };
const reason: Option = { type: 3, name: "reason", description: "Reason for this change", required: true, max_length: 600 };
const state = (values: readonly string[]): Option => ({ type: 3, name: "state", description: "State filter", choices: choices(values) });
const sub = (name: string, description: string, options: readonly Option[] = []): Option => ({ type: 1, name, description, options });
const group = (name: string, description: string, options: readonly Option[]): Option => ({ type: 2, name, description, options });
const topic = record("topic", "Select a retained conversation topic");
const lane = record("lane", "Select a recorded lane");
const block = record("entry", "Select a stored block");
const policy: Option = { type: 3, name: "policy", description: "Response policy", required: true, choices: choices(["normal", "trusted", "ignored"]) };

const catalog = [
    sub("status", "Helio overview and dependency status", [
      { type: 3, name: "dependency", description: "Inspect a dependency", choices: choices(["github"]) },
    ]),
    group("conversations", "Inspect and manage retained conversations", [
      sub("list", "Browse conversation topics", [
        state(["active", "all", "waiting_on_helio", "waiting_on_requester", "on_hold", "resolved", "archived"]),
        { ...channel, required: false }, { ...user, required: false },
      ]),
      sub("show", "Inspect a conversation topic", [topic]),
      sub("hold", "Suspend requester timers", [topic, reason]),
      sub("resume", "Resume conversation timers", [topic]),
      sub("close", "Preview closure and transcript removal", [topic,
        { type: 3, name: "outcome", description: "Conversation outcome", required: true, choices: choices(CONVERSATION_OUTCOMES) }]),
      sub("reopen", "Reopen a retained resolved topic", [topic]),
    ]),
    group("lanes", "Inspect and manage work lanes", [
      sub("list", "Browse recorded lanes", [state(["active", "all", "working", "paused", "hibernated", "done-claimed", "not-done", "closed"])]),
      sub("show", "Inspect a work lane", [lane]),
      sub("pause", "Pause authorized work", [lane, reason]),
      sub("resume", "Resume existing unfinished work", [lane]),
      sub("close", "Verify completion and close a lane", [lane]),
      sub("abandon", "Owner only: preview abandonment", [lane, reason]),
    ]),
    group("blocks", "Inspect and manage blocked users", [
      sub("list", "Browse stored blocks", [
        { type: 3, name: "source", description: "Block source", choices: choices(["manual", "auto"]) },
        { ...user, required: false },
      ]),
      sub("show", "Inspect a stored block", [block]),
      sub("add", "Block a user and settle unaccepted work", [user, reason]),
      sub("remove", "Remove a stored block", [block]),
    ]),
    group("trusted", "Inspect trusted contributors", [
      sub("list", "Browse trusted users"),
      sub("add", "Owner only: preview a privilege grant", [user]),
      sub("remove", "Owner only: preview trust revocation", [record("entry", "Select a currently trusted user")]),
    ]),
    group("channels", "Inspect channel response policies", [
      sub("list", "Browse channel policies", [{ ...policy, required: false }]),
      sub("show", "Inspect effective channel policy", [channel]),
      sub("set", "Owner only: preview channel policy", [channel, policy]),
    ]),
    group("timeouts", "Inspect timing and capacity settings", [
      sub("show", "Browse timing and capacity settings"),
      sub("set", "Owner only: set a bounded value", [
        record("setting", "Select a setting; autocomplete shows its unit"),
        { type: 4, name: "value", description: "Integer in the setting's displayed unit", required: true, min_value: 0, max_value: 99999 },
      ]),
    ]),
    group("settings", "Inspect safe configuration and application status", [
      sub("show", "Configuration and dependency details", [
        { type: 3, name: "section", description: "Settings section", choices: choices(["configuration", "github"]) },
      ]),
    ]),
    group("audit", "Inspect authorized administration history", [
      sub("list", "Browse administration changes", [{ ...user, name: "actor", required: false },
        { type: 3, name: "action", description: "Action filter", max_length: 60 }]),
    ]),
];

export const commands = catalog.map(option => ({ ...option, type: 1, default_member_permissions: null }));

function dmOption(option: Option): Option {
  if (option.type === 7) return { ...option, type: 3, autocomplete: true, max_length: 30,
    description: "Channel or category ID in Helio's configured server" };
  return option.options ? { ...option, options: option.options.map(dmOption) } : option;
}

export function dmCommands(installationTypes: readonly number[]) {
  return commands.map(command => ({ ...command, contexts: [1], integration_types: installationTypes,
    options: command.options?.map(dmOption) }));
}
