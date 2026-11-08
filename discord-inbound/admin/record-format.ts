export const sourceUrl = (guild: string, channel: string, message?: string) =>
  `https://discord.com/channels/${guild}/${channel}${message ? `/${message}` : ""}`;
export const stamp = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex");
export const stateName = (state: string) => ({
  waiting_on_helio: "Waiting on Helio", waiting_on_requester: "Waiting on requester", on_hold: "On hold",
  resolved: "Resolved", archived: "Archived", working: "Working", paused: "Paused", hibernated: "Hibernated",
  "done-claimed": "Completion claimed", "not-done": "Not complete", closed: "Closed",
  "cleanup-pending": "Cleanup pending", "verified-done": "Completion verified",
  idle: "Idle", blocked: "Blocked", missing: "Missing",
  normal: "Normal", trusted: "Trusted", ignored: "Ignored", hard_excluded: "Privacy excluded", outside_scope: "Outside scope",
}[state] ?? state);
export const escapeMarkdown = escapeText;
export const clipText = (value: string, size: number) => value.length <= size ? value :
  `${value.slice(0, Math.max(0, size - 3)).replace(/[\uD800-\uDBFF]$/, "")}...`;
import { escapeText } from "../messages/references.ts";
