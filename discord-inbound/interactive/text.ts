// Approval checks normalize generated links before comparing the canonical wording.
import { githubReferences } from "../messages/references.ts";

export type ConfirmAction = "merge" | "restart" | "pr" | "train" | "train-restart";

/** "#18, #20 and #22" from a train target "owner/repo#18,20,22". */
export function trainMembers(target: string): string {
  const numbers = target.slice(target.lastIndexOf("#") + 1).split(",").map((n) => `#${n}`);
  return numbers.length === 1 ? numbers[0]! : `${numbers.slice(0, -1).join(", ")} and ${numbers.at(-1)}`;
}

const number = (target: string): string => target.slice(target.lastIndexOf("#") + 1);
const short = (revision: string): string => `\`${revision.slice(0, 7)}\``;
const targetLink = (target: string, pull: boolean) =>
  githubReferences(`https://github.com/${target.slice(0, target.lastIndexOf("#"))}/${pull ? "pull" : "issues"}/${number(target)}`);

export function promptLine(action: ConfirmAction, target: string, revision: string): string {
  if (action === "merge") return `Merge ${targetLink(target, true)} · ${short(revision)}?`;
  if (action === "restart") return `Restart Elo Bot on ${short(revision)}?`;
  return `Open PR for ${targetLink(target, false)} · ${short(revision)}?`;
}

export function resultLine(kind: "confirm" | "plan", action: string, target: string, revision: string, user: string): string {
  if (kind === "plan") return `✅ ${user} approved the plan for ${targetLink(target, false)} (r${revision})`;
  if (action === "merge") return `✅ ${user} confirmed merge ${targetLink(target, true)} · ${short(revision)}`;
  if (action === "restart") return `✅ ${user} confirmed restart on ${short(revision)}`;
  if (action === "train" || action === "train-restart") {
    return `✅ ${user} approved merging ${trainMembers(target)}${action === "train-restart" ? " and restarting Elo Bot" : ""}`;
  }
  return `✅ ${user} confirmed PR for ${targetLink(target, false)} · ${short(revision)}`;
}

export const BUTTON_LABEL: Record<ConfirmAction, string> = { merge: "Merge", restart: "Restart", pr: "Open PR", train: "Merge",
  "train-restart": "Merge and restart" };

export const CLOSE_SUFFIX: Partial<Record<string, string>> = {
  expired: "⌛ Expired", superseded: "Replaced by a newer plan", cancelled: "❌ Cancelled",
};

export const NOTICE = {
  inactive: "This is no longer active.",
  expired: "This has expired.",
  busy: "Busy, try again.",
  pending: "Someone is answering this.",
  lapsed: "⌛ Not done in time. Ask again.",
  forUser: (user: string) => `This one's for ${user}.`,
  answered: (user: string | null) => user ? `Already answered by ${user}.` : "Already answered.",
} as const;

const button = (style: number, label: string, custom_id: string) => ({ type: 2, style, label, custom_id });

export function confirmButtons(id: string, action: ConfirmAction) {
  return [{ type: 1, components: [button(3, BUTTON_LABEL[action], `h1:c:${id}:confirm`), button(2, "Cancel", `h1:c:${id}:cancel`)] }];
}
export function planButtons(id: string) {
  return [{ type: 1, components: [button(3, "Approve", `h1:p:${id}:approve`), button(2, "Cancel", `h1:p:${id}:cancel`)] }];
}
