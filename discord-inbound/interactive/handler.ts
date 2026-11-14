import { QuestionStore, type Prompt } from "./store.ts";
import { CLOSE_SUFFIX, NOTICE, lapseNotice, resultLine } from "./text.ts";
import { monitorLine } from "../delivery/monitor-summary.ts";
import type { Answer } from "../conversations/question-answer.ts";
import { announceQuestion, onQuestion } from "./questions.ts";
import { CallError, TOKEN_LIFE_MS, busy, callback, edit, id, notice, original, parseInteraction, postOnce, record, settle,
  type Click, type Deps, type Reply } from "./transport.ts";
import { userReference } from "./transport.ts";
import { githubReferences, referenceLink } from "../messages/references.ts";
export { CallError, discordCall, parseInteraction, type Deps, type Call, type Click } from "./transport.ts";

const MESSAGE = 4, UPDATE = 7;

const approver = (deps: Deps, user: string) => user === deps.ownerId || deps.trusted().has(user);

function explainPrompt(row: Prompt | undefined): string {
  if (!row) return NOTICE.inactive;
  if (row.status === "pending") return NOTICE.pending;
  if (row.status === "confirmed" || row.status === "used" || row.status === "cancelled") return NOTICE.answered(row.decided_by ?
    referenceLink({ kind: "user", id: row.decided_by, label: "Previous responder" }) : null);
  if (row.status === "expired" || row.status === "lapsed" || (row.status === "open")) return NOTICE.expired;
  return NOTICE.inactive;
}

function emitPrompt(deps: Deps, row: Prompt, outcome: string, by: string | null, extra: Record<string, unknown> = {}): void {
  deps.emit(monitorLine(`INBOUND_CONFIRM ${JSON.stringify({
    id: row.id, kind: row.kind, action: row.action, target: row.target, revision: row.revision, outcome, by,
    channel_id: row.channel_id, ...extra, read: `helio confirm show ${row.id}`,
  })}`));
}

async function decide(deps: Deps, click: Click, row: Prompt): Promise<void> {
  const accept = click.verb === "confirm" || click.verb === "approve";
  const actor = await userReference(deps, click.userId, click.userName || "Unavailable user");
  const result = resultLine(row.kind, row.action, row.target, row.revision, actor);
  const cancelled = `${githubReferences(row.content)}\n❌ Cancelled by ${actor}`;
  const expected = accept ? result : cancelled;
  const blocked = deps.prompts.begin(row.id, click.userId, deps.now(), { app: click.appId, token: click.token, accept, expected });
  if (blocked) { await notice(deps, click, explainPrompt(blocked)); return; }
  let response: unknown;
  try {
    response = accept ? await callback(deps, click, MESSAGE, { content: result, allowed_mentions: { parse: [] } }) :
      await callback(deps, click, UPDATE, { content: cancelled, components: [], allowed_mentions: { parse: [] } });
  } catch (error) {
    const revert = () => settle(() => deps.prompts.revert(row.id, click.userId));
    if (!(error instanceof CallError)) { await revert(); throw error; }
    const seen = error.status === undefined || error.status >= 500 ? await original(deps, click.appId, click.token) : null;
    if (seen === undefined) { deps.warn(`prompt ${row.id}: Discord's reply is unknown; it is settled from Discord's record`); return; }
    if (!seen || seen.content !== expected) { await revert(); deps.warn(`prompt ${row.id} decision not recorded: ${error.message}`); return; }
    response = { resource: { message: seen } };
  }
  let resultId: string | undefined;
  if (accept) {
    resultId = id(record(record(record(response)?.resource)?.message)?.id);
    if (!resultId) {
      const seen = await original(deps, click.appId, click.token);
      resultId = seen ? id(seen.id) : undefined;
    }
    if (!resultId) deps.warn(`prompt ${row.id} confirmed but its result message ID is unknown; ask again before acting`);
  }
  await recordDecision(deps, click, row, accept, resultId, !accept);
}

async function recordDecision(deps: Deps, reply: Reply, row: Prompt, accept: boolean, resultId: string | undefined, cleared: boolean): Promise<void> {
  if (!await settle(() => deps.prompts.finish(row.id, reply.userId, accept ? "confirmed" : "cancelled", deps.now(), resultId ?? null, cleared))) {
    deps.warn(`prompt ${row.id} changed while its decision was being shown`);
    return;
  }
  emitPrompt(deps, row, accept ? (row.kind === "plan" ? "approved" : "confirmed") : "cancelled", reply.userId,
    resultId ? { result_message_id: resultId } : {});
  if (accept) await closePrompt(deps, { ...row, status: "confirmed" });
}

/**
 * A claim older than its handler can run is settled from Discord's record of the reply, never released blindly.
 * If that record stays unreadable for the token's life, a confirmation closes as expired; a cancel stands.
 */
async function settlePrompts(deps: Deps): Promise<void> {
  for (const row of deps.prompts.stalePending(deps.now())) {
    const user = row.pending_by ?? "";
    // Older claims lack the record needed to prove whether Discord accepted the decision.
    if (!row.pending_app || !row.pending_token || row.pending_accept === null || !row.pending_expected) {
      if (await settle(() => deps.prompts.abandon(row.id, user))) {
        deps.warn(`prompt ${row.id}: legacy decision cannot be reconciled; closed as expired`);
        emitPrompt(deps, { ...row, status: "expired" }, "expired", user);
      }
      continue;
    }
    const accept = row.pending_accept === 1;
    const reply = { appId: row.pending_app, token: row.pending_token, userId: user };
    const seen = await original(deps, reply.appId, reply.token);
    if (seen && seen.content === row.pending_expected) await recordDecision(deps, reply, row, accept, accept ? id(seen.id) : undefined, !accept);
    else if (seen !== undefined) await settle(() => deps.prompts.revert(row.id, user));
    else if (deps.now() - (row.pending_at ?? 0) >= TOKEN_LIFE_MS) {
      if (!accept) await recordDecision(deps, reply, row, false, undefined, false);
      else if (await settle(() => deps.prompts.abandon(row.id, user))) {
        deps.warn(`prompt ${row.id}: Discord never confirmed the click; closed as expired`);
        emitPrompt(deps, { ...row, status: "expired" }, "expired", user);
      }
    }
  }
}

async function onPrompt(deps: Deps, click: Click): Promise<void> {
  const row = deps.prompts.get(click.ref);
  if (!row || row.kind !== (click.kind === "c" ? "confirm" : "plan") || row.channel_id !== click.channelId || (click.messageId && row.message_id !== click.messageId)) {
    await notice(deps, click, NOTICE.inactive); return;
  }
  if (!approver(deps, click.userId)) { await notice(deps, click, NOTICE.forUser(referenceLink({ kind: "user", id: deps.ownerId, label: "Owner" }))); return; }
  await decide(deps, click, row);
}

/** Called only after inbound has authorized the human reply and its channel. */
export function handlePlanReply(reply: Answer, deps: Deps): void {
  if (!reply.reply_to || reply.role === "BOT_BUG_REPORT" || !approver(deps, reply.author_id)) return;
  const text = reply.content.trim();
  if (!text) return;
  const row = deps.prompts.openPlan(reply.channel_id, reply.reply_to, deps.now());
  if (!row) return;
  const feedback = deps.prompts.addFeedback({ promptId: row.id, user: reply.author_id, text, messageId: reply.message_id, now: deps.now() });
  if (!feedback) return;
  deps.emit(monitorLine(`INBOUND_PLAN_FEEDBACK ${JSON.stringify({
    id: row.id, target: row.target, revision: row.revision, feedback, by: reply.author_id, preview: text.slice(0, 200),
    read: `helio confirm feedback ${row.id}`,
  })}`));
}

/** Handles one click. Errors are reported, never thrown: a bad click must not stop intake. */
export async function handleInteraction(raw: unknown, base: Deps): Promise<void> {
  const deps: Deps = { ...base, userNames: new Map() };
  const click = parseInteraction(raw);
  if (!click) return;
  let store: QuestionStore | undefined;
  try {
    if (click.kind === "d" || click.kind === "qm" || (click.kind === "q" && ["other", "pick"].includes(click.verb))) {
      await notice(deps, click, "Reply to the question message to answer.");
    } else if (click.kind === "pm" || (click.kind === "p" && click.verb === "suggest")) {
      await notice(deps, click, "Reply to the plan message to suggest changes.");
    } else if (click.kind === "c" || click.kind === "p") await onPrompt(deps, click);
    else {
      store = deps.questions();
      if (store) await onQuestion(deps, click, store);
      else await notice(deps, click, NOTICE.inactive);
    }
  } catch (error) {
    if (busy(error)) {
      await notice(deps, click, NOTICE.busy).catch(() => undefined);
      return;
    }
    deps.warn(`interaction ${click.kind}:${click.verb} failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally { store?.close(); }
}

async function closePrompt(deps: Deps, row: Prompt): Promise<void> {
  const suffix = CLOSE_SUFFIX[row.status];
  await edit(deps, `prompt:${row.id}`, () => deps.call("PATCH", `/channels/${row.channel_id}/messages/${row.message_id}`, {
    ...(suffix ? { content: `${githubReferences(row.content)}\n${suffix}`, allowed_mentions: { parse: [] } } : {}), components: [],
  }), () => deps.prompts.cleared(row.id, deps.now()));
}

/** Expiry and lapse need no network: the exact timer runs this even while a sweep waits on Discord. */
export function expireNow(deps: Deps): Prompt[] {
  const due = deps.prompts.expireDue(deps.now());
  for (const row of due) emitPrompt(deps, row, row.status === "open" ? "expired" : "lapsed", null);
  return due;
}

export async function closeExpired(deps: Deps): Promise<void> {
  for (const row of deps.prompts.toClose().filter((row) => row.status === "expired")) await closePrompt(deps, row);
}

export async function sweep(base: Deps): Promise<void> {
  const deps: Deps = { ...base, userNames: new Map() };
  await settlePrompts(deps);
  expireNow(deps);
  const store = deps.questions();
  try {
    for (const row of deps.prompts.needingNotice()) {
      const reference = row.result_message_id ?? row.message_id;
      if (!reference) continue;
      if (await (deps.carriedOut ?? (async () => false))(row).catch(() => false)) {
        deps.prompts.noticed(row.id, deps.now());  // done another way (for example merged on GitHub): nothing to report
        continue;
      }
      await edit(deps, `lapse:${row.id}`, () => postOnce(deps, row.channel_id, reference, lapseNotice(row.action, row.target, row.revision), `l${row.id}`),
        () => deps.prompts.noticed(row.id, deps.now()));
    }
    for (const row of deps.prompts.toClose()) await closePrompt(deps, row);
    if (!store) return;
    for (const question of store.expireDue(deps.now())) {
      deps.emit(`QUESTION_EXPIRED ${JSON.stringify({
        id: question.id, lane: question.lane, audience: question.audience, status: "expired",
        read: `helio question show ${question.id}`,
      })}`);
    }
    for (const question of store.toAnnounce()) await announceQuestion(deps, store, question);
    for (const question of store.toClear()) await announceQuestion(deps, store, question);
  } finally { store?.close(); }
}
