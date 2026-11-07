import { Database } from "bun:sqlite";
import { join } from "node:path";
import { AdminError, object, result, type RuntimeQuery, type RuntimeResult } from "./protocol.ts";
import { conversationAction, conversationNotice, topicKey } from "./runtime-mutations.ts";
import { readLanes } from "./lane-records.ts";
import { laneSession } from "./lane-session.ts";
import type { RuntimeState } from "./runtime-state.ts";

export async function recover(runtime: RuntimeState, request: Extract<RuntimeQuery, { readonly kind: "receipt" }>): Promise<RuntimeResult> {
  const mutation = { kind: "mutate" as const, action: request.action, target: request.target, expected: request.expected, input: request.input };
  const { proof, admin, access } = runtime;
  if (request.action.startsWith("conversations.")) {
    const [channel, user] = topicKey(request.target);
    if (!await access.canRead(channel, user)) throw new AdminError("denied", "This operation target is no longer visible to you");
  } else if (request.action.startsWith("lanes.")) {
    const selected = readLanes(runtime.state, proof.guild).find(item => item.record.id === request.target)?.record;
    if (!selected || !(selected.channel ? await access.canRead(selected.channel) :
      proof.actor === runtime.published.values.DORI_DISCORD_OWNER_ID)) {
      throw new AdminError("denied", "This operation target is no longer visible to you");
    }
  }
  const fingerprint = JSON.stringify([proof.actor, mutation]);
  const prior = admin.query<{
    fingerprint: string; status: string; result: string | null; channel: string | null; user: string | null;
  }, [string]>("SELECT fingerprint,status,result,channel,user FROM operations WHERE id=?").get(proof.operation);
  if (!prior) return { records: [], receipt: { status: "uncertain" } };
  if (prior.fingerprint !== fingerprint) throw new AdminError("denied", "This operation ID was already used");
  if (prior.channel && !await access.canRead(prior.channel, prior.user ?? undefined)) {
    throw new AdminError("denied", "This operation is no longer visible to you");
  }
  if (prior.status === "done" && prior.result) {
    return { records: [], receipt: { status: "done", outcome: result(JSON.parse(prior.result)) } };
  }
  if (prior.status === "refused") {
    const saved = prior.result ? object(JSON.parse(prior.result)) : {};
    return { records: [], receipt: { status: "refused", error: typeof saved.error === "string" ? saved.error : "Operation refused" } };
  }
  let notice: string | undefined;
  if (request.action.startsWith("conversations.")) {
    const domain = runtime.conversationDb.query<{ fingerprint: string }, [string]>(
      "SELECT fingerprint FROM conversation_admin_operations WHERE id=?").get(proof.operation);
    if (domain) {
      const [channel, user, anchor, opened] = topicKey(request.target);
      const action = conversationAction(request);
      const expected = JSON.stringify([proof.actor, channel, user, opened, anchor, Number(request.expected), action]);
      if (domain.fingerprint !== expected) throw new AdminError("denied", "The domain receipt belongs to a different operation");
      notice = conversationNotice(action);
    }
  } else if (request.action === "blocks.add" || request.action === "blocks.remove") {
    using delivery = new Database(join(runtime.state, "discord-delivery.sqlite"), { readonly: true });
    const domain = delivery.query<{ user_id: string; action: string }, [string]>(
      "SELECT user_id,action FROM moderation_proofs WHERE proof=?").get(`admin:${proof.operation}`);
    if (domain && domain.user_id === request.target && domain.action === request.action.slice("blocks.".length)) {
      notice = request.action === "blocks.add" ? "User block committed; cleanup may still be pending." : "User unblock committed; inspect current state.";
    }
  } else if (request.action.startsWith("lanes.")) {
    const lane = readLanes(runtime.state, proof.guild).find(item => item.lane.key === request.target)?.lane;
    const witness = lane?.history?.find(entry => entry.note.includes(`[admin:${proof.operation}]`));
    if (witness) {
      switch (request.action) {
        case "lanes.pause":
          if (witness.status === "paused") notice = "Lane pause was recorded; inspect current execution.";
          break;
        case "lanes.resume":
          if (lane?.pane && await laneSession(lane.pane) === "working") notice = "Lane resume was recorded; session is running.";
          break;
        case "lanes.close":
          if (witness.status === "closed" || witness.status === "cleanup-pending") notice = "Lane completion was recorded; inspect current cleanup state.";
          break;
        case "lanes.abandon":
          if (witness.status === "closed") notice = "Lane abandonment was recorded; worktree retained.";
          break;
      }
    }
  }
  access.authorize(request.action === "lanes.abandon");
  if (!notice) return { records: [], receipt: { status: prior.status === "running" ? "running" : "uncertain" } };
  const outcome: RuntimeResult = { records: [], notice, operation: proof.operation };
  admin.query("UPDATE operations SET status='done',result=? WHERE id=? AND fingerprint=? AND status IN ('running','uncertain')")
    .run(JSON.stringify(outcome), proof.operation, fingerprint);
  return { records: [], receipt: { status: "done", outcome } };
}
