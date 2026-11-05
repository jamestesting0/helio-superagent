import { Database } from "bun:sqlite";
import type { Rest } from "../discord/rest.ts";

const FRESH_MS = 15 * 60_000;
// A direct command at the start of a line: "block 501", "<@helio> unblock <@501> please".
const COMMAND = {
  add: /^(?:<@!?\d+>[\s,:]*)?(?:please\s+)?(?:black ?list|block|ban)\s+(?:<@!?(\d+)>|(\d+))(?!\d)/gim,
  remove: /^(?:<@!?\d+>[\s,:]*)?(?:please\s+)?(?:un-?black ?list|unblock|unban)\s+(?:<@!?(\d+)>|(\d+))(?!\d)/gim,
};
// Hedged, negated or hypothetical wording is never an instruction, wherever it appears.
const DOUBT = /\b(?:not|never|no|don'?t|do\s+not|doesn'?t|won'?t|shouldn'?t|wouldn'?t|if|whether|maybe|might)\b|[?]/i;

export interface ProofContext {
  readonly ownerId: string;
  readonly rest?: Rest;
  readonly questionsPath: string;
  readonly now: number;
}

/** Same rule as approvals: quoted lines, code and quoted phrases never carry the owner's instruction. */
function instructionText(content: string): string {
  const withoutCode = content.replace(/(`{3,}|~{3,})[\s\S]*?(?:\1|$)/g, " ").split(/^[ \t]*>>>/m)[0] ?? "";
  return withoutCode.split("\n").filter((line) => !line.trimStart().startsWith(">")).join("\n")
    .replace(/`[^`]*`/g, " ").replace(/"[^"]*"|“[^”]*”/g, " ");
}

function commands(text: string, action: "add" | "remove", userId: string): boolean {
  if (DOUBT.test(text)) return false;
  return [...text.matchAll(COMMAND[action])].some((match) => (match[1] ?? match[2]) === userId);
}

function names(text: string, userId: string): boolean {
  return text.includes(`<@${userId}>`) || text.includes(`<@!${userId}>`) || new RegExp(`\\b${userId}\\b`).test(text);
}

export async function ownerApproved(o: ProofContext, userId: string, action: "add" | "remove",
  proof: { readonly message?: string; readonly channel?: string; readonly question?: string }): Promise<string> {
  if (proof.question) {
    const db = new Database(o.questionsPath, { readonly: true });
    try {
      const row = db.query<{ question: string | null; status: string; answer_author: string | null; answer_text: string | null },
        [string]>("SELECT question, status, answer_author, answer_text FROM questions WHERE id = ?").get(proof.question);
      if (!row) throw new RangeError(`Unknown question ${proof.question}`);
      const expected = action === "add" ? "Block" : "Undo";
      if (!["answered", "done"].includes(row.status) || row.answer_author !== o.ownerId || row.answer_text !== expected ||
          !names(row.question ?? "", userId)) {
        throw new RangeError(`Question ${proof.question} is not an owner ${expected} answer about ${userId}`);
      }
      return `question ${proof.question}`;
    } finally { db.close(); }
  }
  if (!proof.message || !proof.channel) throw new RangeError("Proof needs --message M --channel C or --question ID");
  if (!o.rest) throw new TypeError("Requires DORI_DISCORD_TOKEN to verify the owner's message");
  const message = await o.rest<{ author?: { id?: string }; content?: string; timestamp?: string; edited_timestamp?: string | null }>(
    `/channels/${proof.channel}/messages/${proof.message}`);
  if (message.author?.id !== o.ownerId) throw new RangeError(`Message ${proof.message} is not the owner's`);
  const sent = Date.parse(message.timestamp ?? "");
  if (!Number.isFinite(sent) || o.now - sent > FRESH_MS) throw new RangeError(`Message ${proof.message} is older than 15 minutes`);
  if (message.edited_timestamp) throw new RangeError(`Message ${proof.message} was edited; ask the owner to send a new message`);
  if (!commands(instructionText(message.content ?? ""), action, userId)) throw new RangeError(`Message ${proof.message} does not ask to ${action === "add" ? "blacklist" : "unblock"} ${userId}`);
  return `message ${proof.message}`;
}
