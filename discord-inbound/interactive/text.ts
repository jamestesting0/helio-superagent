// The exact prompt and result wording is also checked by scripts/helio_approval.py: change both together.
export type ConfirmAction = "merge" | "restart" | "pr";

const number = (target: string): string => target.slice(target.lastIndexOf("#") + 1);
const short = (revision: string): string => `\`${revision.slice(0, 7)}\``;

export function promptLine(action: ConfirmAction, target: string, revision: string): string {
  if (action === "merge") return `Merge #${number(target)} · ${short(revision)}?`;
  if (action === "restart") return `Restart Elo Bot on ${short(revision)}?`;
  return `Open PR for #${number(target)} · ${short(revision)}?`;
}

export function resultLine(kind: "confirm" | "plan", action: string, target: string, revision: string, user: string): string {
  if (kind === "plan") return `✅ <@${user}> approved the plan for #${number(target)} (r${revision})`;
  if (action === "merge") return `✅ <@${user}> confirmed merge #${number(target)} · ${short(revision)}`;
  if (action === "restart") return `✅ <@${user}> confirmed restart on ${short(revision)}`;
  return `✅ <@${user}> confirmed PR for #${number(target)} · ${short(revision)}`;
}

export const BUTTON_LABEL: Record<ConfirmAction, string> = { merge: "Merge", restart: "Restart", pr: "Open PR" };

export const CLOSE_SUFFIX: Partial<Record<string, string>> = {
  expired: "⌛ Expired", superseded: "Replaced by a newer plan", cancelled: "❌ Cancelled",
};

export const NOTICE = {
  inactive: "This is no longer active.",
  expired: "This has expired.",
  busy: "Busy, try again.",
  pending: "Someone is answering this.",
  lapsed: "⌛ Not done in time. Ask again.",
  forUser: (user: string) => `This one's for <@${user}>.`,
  answered: (user: string | null) => user ? `Already answered by <@${user}>.` : "Already answered.",
} as const;

const button = (style: number, label: string, custom_id: string) => ({ type: 2, style, label, custom_id });

export function confirmButtons(id: string, action: ConfirmAction) {
  return [{ type: 1, components: [button(3, BUTTON_LABEL[action], `h1:c:${id}:confirm`), button(2, "Cancel", `h1:c:${id}:cancel`)] }];
}
export function planButtons(id: string) {
  return [{ type: 1, components: [button(3, "Approve", `h1:p:${id}:approve`), button(2, "Cancel", `h1:p:${id}:cancel`)] }];
}
