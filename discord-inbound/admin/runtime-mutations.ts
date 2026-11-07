import { join } from "node:path";
import { CONVERSATION_OUTCOMES, type Conversation, type ConversationAdminAction } from "../conversations/conversations.ts";
import { settleBlock } from "../delivery/moderation-effects.ts";
import { readLanes } from "./lane-records.ts";
import { laneSession } from "./lane-session.ts";
import { AdminError, type AdminRecord, type RuntimeQuery } from "./protocol.ts";
import type { RuntimeState } from "./runtime-state.ts";

type Mutation = Extract<RuntimeQuery, { readonly kind: "mutate" }>;

export function topicKey(id: string): [string, string, string, number] {
  const [channel, user, anchor, opened, ...extra] = id.split(":");
  if (extra.length || !channel || !user || !anchor || !opened || ![channel, user, anchor, opened].every(value => /^\d+$/.test(value))) {
    throw new AdminError("invalid", "Invalid topic identifier");
  }
  return [channel, user, anchor, Number(opened)];
}

export function conversationAction(request: Pick<Mutation, "action" | "input">): ConversationAdminAction {
  switch (request.action) {
    case "conversations.hold": return { kind: "hold", reason: request.input.reason ?? "" };
    case "conversations.resume": return { kind: "resume" };
    case "conversations.close": {
      const outcome = CONVERSATION_OUTCOMES.find(value => value === request.input.outcome);
      if (!outcome) throw new AdminError("invalid", "Choose a conversation outcome");
      return { kind: "close", outcome };
    }
    case "conversations.reopen": return { kind: "reopen" };
    default: throw new AdminError("invalid", "Unsupported conversation action");
  }
}

export function conversationNotice(action: ConversationAdminAction): string {
  return action.kind === "close" ? "Conversation closed; its transcript was removed." :
    `Conversation ${action.kind === "hold" ? "put on hold" : action.kind === "resume" ? "resumed" : "reopened"}.`;
}

function conversation(runtime: RuntimeState, request: Mutation): string {
  const row = runtime.conversationDb.query<Conversation, [string, string, string, number]>(
    "SELECT * FROM conversations WHERE channel_id=? AND user_id=? AND anchor_message_id=? AND opened_at=?")
    .get(...topicKey(request.target));
  if (!row) throw new AdminError("changed", "The selected conversation is unavailable");
  const action = conversationAction(request);
  runtime.conversations.administer(runtime.proof.operation, runtime.proof.actor,
    { ...row, revision: Number(request.expected) }, action, Date.now());
  return conversationNotice(action);
}

async function block(runtime: RuntimeState, request: Mutation): Promise<string> {
  const { delivery, conversations, rest, state, proof, published } = runtime;
  if (!/^\d{5,30}$/.test(request.target)) throw new AdminError("invalid", "Choose a valid user");
  switch (request.action) {
    case "blocks.add": {
      const trusted = new Set([published.values.DORI_DISCORD_OWNER_ID, ...published.values.HELIO_TRUSTED_USERS.split(",")]);
      const reason = request.input.reason?.trim();
      if (!reason || reason.length > 600) throw new AdminError("invalid", "A block reason of 1-600 characters is required");
      const outcome = delivery.moderation.withProof(`admin:${proof.operation}`, request.target, "add", Date.now(),
        () => delivery.block(request.target, { source: "owner", reason, by: proof.actor }, trusted));
      await settleBlock({ delivery, conversations, rest, stateDir: state,
        warn: message => console.error(`ADMIN_WARN ${message.slice(0, 500)}`) },
      request.target, outcome === "repeat" ? { dismissed: [] } : outcome);
      return `User blocked.${outcome === "repeat" ? "" : ` ${outcome.dismissed.length} unaccepted requests dismissed.`}`;
    }
    case "blocks.remove":
      delivery.moderation.withProof(`admin:${proof.operation}`, request.target, "remove", Date.now(),
        () => delivery.moderation.unblock(request.target));
      return "User unblocked.";
    default: throw new AdminError("invalid", "Unsupported block action");
  }
}

async function lane(runtime: RuntimeState, request: Mutation, current?: AdminRecord): Promise<string> {
  const command = request.action.slice("lanes.".length);
  if (!["pause", "resume", "close", "abandon"].includes(command)) throw new AdminError("invalid", "Unsupported lane action");
  if (command === "resume" && current?.state !== "paused" && current?.state !== "hibernated") {
    throw new AdminError("denied", "Only paused or hibernated unfinished lanes can be resumed");
  }
  const reason = request.input.reason?.trim() ?? "";
  if ((command === "pause" || command === "abandon") && !reason) throw new AdminError("invalid", "A reason is required");
  const note = `[admin:${runtime.proof.operation}] ${reason || "Discord administration"}`;
  const child = Bun.spawn(["dori", command, request.target,
    ...(command === "abandon" ? [`--reason=${note}`] : [`--note=${note}`])], {
    env: { ...process.env, HERDR_SESSION: "elobot", DORI_CONFIG: join(runtime.home, ".dori/elobot/config.json"), DORI_STATE_DIR: runtime.state },
    stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 65_000,
  });
  const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new AdminError("uncertain", (error || output).slice(-500) || "Lane transition was not verified");
  if (command === "resume") {
    const lane = readLanes(runtime.state, runtime.proof.guild).find(item => item.lane.key === request.target)?.lane;
    const execution = lane?.pane ? await laneSession(lane.pane) : "missing";
    if (execution !== "working") throw new AdminError("uncertain",
      `Goal resume was acknowledged; session execution is ${execution}. Inspect the lane before issuing another resume.`);
  }
  if (command === "close" && readLanes(runtime.state, runtime.proof.guild).find(item => item.lane.key === request.target)?.record.state === "cleanup-pending") {
    return "Completion verified; terminal cleanup is pending.";
  }
  return command === "close" ? "Lane completion verified and closed." : command === "abandon" ? "Lane abandoned; worktree retained." :
    command === "pause" ? "Lane pause verified." : "Lane resumed; session is running.";
}

export async function applyMutation(runtime: RuntimeState, request: Mutation, current?: AdminRecord): Promise<string> {
  switch (request.action.split(".")[0]) {
    case "conversations": return conversation(runtime, request);
    case "blocks": return block(runtime, request);
    case "lanes": return lane(runtime, request, current);
    default: throw new AdminError("invalid", "Unsupported administration mutation");
  }
}
