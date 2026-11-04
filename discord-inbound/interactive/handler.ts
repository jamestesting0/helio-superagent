import { PromptStore, QuestionStore, DRAFT_TTL_MS, type Draft, type Prompt, type Question } from "./store.ts";
import {
  CLOSE_SUFFIX, NOTICE, escapeMarkdown, resultLine, reviewButtons, textModal,
} from "./text.ts";
import { monitorLine } from "../delivery/monitor-summary.ts";

const API = "https://discord.com/api/v10";
const CUSTOM_ID = /^h1:(c|p|q|d|qm|pm):([0-9a-f]{20}):([a-z]+)$/;
const VERBS: Record<string, readonly string[]> = {
  c: ["confirm", "cancel"], p: ["approve", "suggest"], q: ["pick", "other"], d: ["submit", "cancel"], qm: ["other"], pm: ["suggest"],
};
const SNOWFLAKE = /^[0-9]{1,30}$/;
const RETRY_FAILED_EDIT_MS = 10 * 60_000;
const MESSAGE = 4, UPDATE = 7, MODAL = 9, EPHEMERAL = 64;
const QUESTION_CANCELLED = "❌ Cancelled";

export class CallError extends Error {
  /** `status` is undefined when Discord's answer is unknown (timeout or network failure). */
  constructor(readonly status: number | undefined, message: string) { super(message); this.name = "CallError"; }
}
export type Call = (method: string, path: string, body?: unknown) => Promise<unknown>;

export function discordCall(token: string, timeoutMs = 2800): Call {
  return async (method, path, body) => {
    const safePath = path.replace(/(\/(?:interactions|webhooks)\/[^/]+\/)[^/?]+/, "$1[redacted]");
    let res: Response;
    let text: string;
    try {
      res = await fetch(`${API}${path}`, {
        method, signal: AbortSignal.timeout(timeoutMs),
        headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      text = await res.text();
    } catch {
      // Response headers alone cannot prove whether Discord accepted a callback.
      throw new CallError(undefined, `${method} ${safePath}: response unavailable`);
    }
    if (!res.ok) throw new CallError(res.status, `${method} ${safePath} -> ${res.status}`);
    try { return text ? JSON.parse(text) : undefined; }
    catch { throw new CallError(undefined, `${method} ${safePath}: invalid response`); }
  };
}

export interface Click {
  readonly id: string; readonly token: string; readonly appId: string; readonly type: 3 | 5;
  readonly kind: string; readonly ref: string; readonly verb: string; readonly values: readonly string[];
  readonly text: string | undefined; readonly channelId: string; readonly messageId: string | undefined;
  readonly userId: string;
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const id = (value: unknown): string | undefined => typeof value === "string" && SNOWFLAKE.test(value) ? value : undefined;

function modalText(components: unknown): string | undefined {
  const stack: unknown[] = Array.isArray(components) ? [...components] : [];
  while (stack.length) {
    const item = record(stack.pop());
    if (!item) continue;
    if (item.type === 4 && item.custom_id === "text" && typeof item.value === "string") return item.value;
    if (item.component) stack.push(item.component);
    if (Array.isArray(item.components)) stack.push(...item.components);
  }
  return undefined;
}

export function parseInteraction(raw: unknown): Click | undefined {
  const event = record(raw), data = record(event?.data);
  if (!event || !data) return undefined;
  // agent-messenger overwrites the payload's numeric type with "INTERACTION_CREATE"; the data shape tells them apart.
  const type = typeof event.type === "number" ? event.type : typeof data.component_type === "number" ? 3 :
    Array.isArray(data.components) ? 5 : undefined;
  if (type !== 3 && type !== 5) return undefined;
  const user = record(record(event.member)?.user) ?? record(event.user);
  const [interactionId, appId, channelId, userId] = [id(event.id), id(event.application_id), id(event.channel_id), id(user?.id)];
  const match = typeof data.custom_id === "string" ? CUSTOM_ID.exec(data.custom_id) : null;
  if (!interactionId || !appId || !channelId || !userId || typeof event.token !== "string" || !event.token || !match) return undefined;
  if (!VERBS[match[1]!]?.includes(match[3]!) || (type === 5) !== (match[1] === "qm" || match[1] === "pm")) return undefined;
  const values = Array.isArray(data.values) ? data.values.filter((value): value is string => typeof value === "string") : [];
  return {
    id: interactionId, token: event.token, appId, type, kind: match[1]!, ref: match[2]!, verb: match[3]!,
    values, text: type === 5 ? modalText(data.components) : undefined, channelId,
    messageId: id(record(event.message)?.id), userId,
  };
}

export interface Deps {
  readonly prompts: PromptStore;
  readonly questions: () => QuestionStore | undefined;
  readonly ownerId: string;
  readonly trusted: () => ReadonlySet<string>;
  readonly call: Call;
  readonly now: () => number;
  readonly emit: (line: string) => void;
  readonly warn: (text: string) => void;
}

const callback = (deps: Deps, click: Click, type: number, data?: unknown) =>
  deps.call("POST", `/interactions/${click.id}/${click.token}/callback?with_response=true`, { type, ...(data ? { data } : {}) });
const notice = (deps: Deps, click: Click, content: string) =>
  callback(deps, click, MESSAGE, { content, flags: EPHEMERAL, allowed_mentions: { parse: [] } });
const replace = (deps: Deps, click: Click, content: string) =>
  callback(deps, click, UPDATE, { content, components: [], allowed_mentions: { parse: [] } });

/**
 * After an ambiguous callback, Discord's stored original response settles what users actually saw:
 * a message, null when Discord says there is none, or undefined when that is still unknown.
 */
async function original(deps: Deps, appId: string, token: string): Promise<Record<string, unknown> | null | undefined> {
  try { return record(await deps.call("GET", `/webhooks/${appId}/${token}/messages/@original`)) ?? null; }
  catch (error) {
    if (!(error instanceof CallError)) throw error;
    return error.status === 404 ? null : undefined;
  }
}

const TOKEN_LIFE_MS = 14 * 60_000;
type Reply = Pick<Click, "appId" | "token" | "userId">;

function busy(error: unknown): boolean {
  return error instanceof Error && "code" in error && String(error.code).startsWith("SQLITE_BUSY");
}

/** After Discord has shown a decision, recording it must not fail on a briefly locked database. */
async function settle<T>(write: () => T): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try { return write(); }
    catch (error) {
      if (!busy(error) || attempt === 20) throw error;
      await Bun.sleep(100);
    }
  }
}

const approver = (deps: Deps, user: string) => user === deps.ownerId || deps.trusted().has(user);

function explainPrompt(row: Prompt | undefined): string {
  if (!row) return NOTICE.inactive;
  if (row.status === "pending") return NOTICE.pending;
  if (row.status === "confirmed" || row.status === "used" || row.status === "cancelled") return NOTICE.answered(row.decided_by);
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
  const result = resultLine(row.kind, row.action, row.target, row.revision, click.userId);
  const cancelled = `${row.content}\n❌ Cancelled by <@${click.userId}>`;
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
  if (!approver(deps, click.userId)) { await notice(deps, click, NOTICE.forUser(deps.ownerId)); return; }
  if (click.kind === "pm") { await onSuggestion(deps, click, row); return; }
  if (click.verb === "suggest") {
    if (row.status !== "open" || row.expires_at <= deps.now()) { await notice(deps, click, explainPrompt(row)); return; }
    await callback(deps, click, MODAL, textModal(`h1:pm:${row.id}:suggest`, "Suggested changes", "Changes"));
    return;
  }
  await decide(deps, click, row);
}

async function onSuggestion(deps: Deps, click: Click, row: Prompt): Promise<void> {
  const text = click.text?.trim();
  if (!text || text.length > 1000) { await notice(deps, click, NOTICE.inactive); return; }
  if (row.status !== "open" || row.expires_at <= deps.now()) { await notice(deps, click, explainPrompt(row)); return; }
  const response = await callback(deps, click, MESSAGE, { content: `<@${click.userId}> suggested: ${text}`, allowed_mentions: { parse: [] } });
  const messageId = id(record(record(record(response)?.resource)?.message)?.id) ?? null;
  const feedback = deps.prompts.addFeedback(row.id, click.userId, text, messageId, deps.now());
  deps.emit(monitorLine(`INBOUND_PLAN_FEEDBACK ${JSON.stringify({
    id: row.id, target: row.target, revision: row.revision, feedback, by: click.userId, preview: text.slice(0, 200),
    read: `helio confirm feedback ${row.id}`,
  })}`));
}

function mayAnswer(deps: Deps, question: Question, user: string): boolean {
  if (user === deps.ownerId) return true;
  if (question.audience === "staff") return deps.trusted().has(user);
  return question.audience === "thread" && user === question.recipient;
}

function explainQuestion(question: Question | undefined): string {
  if (!question) return NOTICE.inactive;
  if (question.status === "answering") return NOTICE.pending;
  if (question.status === "answered" || question.status === "done") return NOTICE.answered(question.answer_author);
  return NOTICE.inactive;
}

function questionOptions(question: Question): string[] | undefined {
  try {
    const parsed: unknown = JSON.parse(question.options ?? "null");
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : undefined;
  } catch { return undefined; }
}

async function onQuestion(deps: Deps, click: Click, store: QuestionStore): Promise<void> {
  const question = store.get(click.ref);
  const options = question && questionOptions(question);
  if (!question || !options || question.channel_id !== click.channelId || (click.messageId && question.message_id !== click.messageId)) {
    await notice(deps, click, NOTICE.inactive); return;
  }
  if (!mayAnswer(deps, question, click.userId)) {
    await notice(deps, click, NOTICE.forUser(question.audience === "thread" ? question.recipient : deps.ownerId)); return;
  }
  if (question.status !== "awaiting_answer") { await notice(deps, click, explainQuestion(question)); return; }
  if (click.kind === "qm") {
    const text = click.text?.trim();
    if (!text || text.length > 1000) { await notice(deps, click, NOTICE.inactive); return; }
    // The form's own Submit is the confirmation: typed text is recorded without a second review.
    const draft = deps.prompts.draft(deps.prompts.putDraft(question.id, click.userId, null, text, deps.now()));
    if (!draft) { await notice(deps, click, NOTICE.inactive); return; }
    await submit(deps, click, store, question.id, draft,
      () => callback(deps, click, MESSAGE, { content: "Sent ✓", flags: EPHEMERAL, allowed_mentions: { parse: [] } }));
    return;
  }
  if (click.verb === "other") {
    await callback(deps, click, MODAL, textModal(`h1:qm:${question.id}:other`, "Your answer", "Answer"));
    return;
  }
  const index = Number(click.values[0]);
  const label = Number.isInteger(index) ? options[index] : undefined;
  if (click.verb !== "pick" || label === undefined) { await notice(deps, click, NOTICE.inactive); return; }
  const draft = deps.prompts.putDraft(question.id, click.userId, index, label, deps.now());
  try {
    // Re-sending the unchanged menu resets it, so the same option can be picked again after Cancel.
    await callback(deps, click, UPDATE, { components: JSON.parse(question.components ?? "[]") });
  } catch (error) { deps.prompts.deleteDraft(draft); throw error; }
  await deps.call("POST", `/webhooks/${click.appId}/${click.token}`, {
    content: `**${escapeMarkdown(label)}**`, flags: EPHEMERAL, components: reviewButtons(draft), allowed_mentions: { parse: [] },
  });
}

function answerRole(deps: Deps, user: string): { role: string; scope: string } {
  if (user === deps.ownerId) return { role: "OWNER_REQUEST", scope: "may-request-work" };
  if (deps.trusted().has(user)) return { role: "TRUSTED_REQUEST", scope: "trusted-pr-merge-restart" };
  return { role: "STAFF_QUESTION", scope: "answer-only" };
}

async function onDraft(deps: Deps, click: Click, store: QuestionStore | undefined): Promise<void> {
  const draft = deps.prompts.draft(click.ref);
  if (!draft || draft.user_id !== click.userId || !store) { await replace(deps, click, NOTICE.inactive); return; }
  // While a submit is unsettled its draft is the only way to read Discord's record: no later click may change it.
  if (draft.token) { await notice(deps, click, NOTICE.pending); return; }
  if (deps.now() - draft.created_at >= DRAFT_TTL_MS) { deps.prompts.deleteDraft(draft.id); await replace(deps, click, NOTICE.expired); return; }
  if (click.verb === "cancel") { deps.prompts.deleteDraft(draft.id); await replace(deps, click, "Cancelled."); return; }
  const question = store.get(draft.question_id);
  const options = question && questionOptions(question);
  const unchanged = draft.option_index === null || options?.[draft.option_index] === draft.label;
  if (!question || !options || !unchanged || !mayAnswer(deps, question, click.userId)) {
    deps.prompts.deleteDraft(draft.id); await replace(deps, click, NOTICE.inactive); return;
  }
  await submit(deps, click, store, question.id, draft, () => replace(deps, click, "Sent ✓"));
}

/** Claims the question, shows "Sent ✓" through `respond`, then records the answer; an unclear reply is settled later. */
async function submit(deps: Deps, click: Click, store: QuestionStore, questionId: string, draft: Draft,
  respond: () => Promise<unknown>): Promise<void> {
  const blocked = store.begin(questionId, click.userId, deps.now());
  // A separate notice: editing the review message would overwrite the reply the winning click is settled by.
  if (blocked) { await notice(deps, click, explainQuestion(blocked)); return; }
  // Only the click that won the claim records how to read Discord's reply; a repeat click never replaces it.
  deps.prompts.claimDraft(draft.id, click.appId, click.token);
  try { await respond(); }
  catch (error) {
    const revert = async () => { await settle(() => store.revert(questionId, click.userId, deps.now())); deps.prompts.releaseDraft(draft.id); };
    if (!(error instanceof CallError)) { await revert(); throw error; }
    const seen = error.status === undefined || error.status >= 500 ? await original(deps, click.appId, click.token) : null;
    if (seen === undefined) { deps.warn(`question ${questionId}: Discord's reply is unknown; it is settled from Discord's record`); return; }
    if (seen?.content !== "Sent ✓") { await revert(); deps.warn(`question ${questionId} answer not recorded: ${error.message}`); return; }
  }
  await recordAnswer(deps, click, store, questionId, draft);
}

async function recordAnswer(deps: Deps, reply: Reply, store: QuestionStore, questionId: string, draft: Draft): Promise<void> {
  const answer = { id: draft.id, author: reply.userId, ...answerRole(deps, reply.userId), text: draft.label };
  if (!await settle(() => store.finish(questionId, reply.userId, answer, deps.now()))) {
    deps.warn(`question ${questionId} changed while its answer was being shown`);
    await deps.call("POST", `/webhooks/${reply.appId}/${reply.token}`, {
      content: NOTICE.notSaved, flags: EPHEMERAL, allowed_mentions: { parse: [] },
    }).catch((error: unknown) => deps.warn(`could not tell the answerer it was not saved: ${String(error)}`));
    return;
  }
  deps.prompts.deleteDraft(draft.id);
  const answered = store.get(questionId);
  if (answered) await announceQuestion(deps, store, answered);
}

/** Same rule as prompts: a submit Discord confirmed (or that was clicked but never readable) is recorded; one Discord denies is released. */
async function settleAnswers(deps: Deps, store: QuestionStore): Promise<void> {
  for (const question of store.stalePending(deps.now())) {
    const user = question.pending_by ?? "";
    const draft = deps.prompts.draftFor(question.id, user);
    const revert = async () => { await settle(() => store.revert(question.id, user, deps.now())); if (draft) deps.prompts.releaseDraft(draft.id); };
    if (!draft?.app_id || !draft.token) { await revert(); continue; }
    const reply = { appId: draft.app_id, token: draft.token, userId: user };
    const seen = await original(deps, draft.app_id, draft.token);
    if (seen?.content === "Sent ✓" || (seen === undefined && deps.now() - (question.pending_at ?? 0) >= TOKEN_LIFE_MS)) {
      await recordAnswer(deps, reply, store, question.id, draft);
    } else if (seen !== undefined) await revert();
  }
}

/** Handles one click. Errors are reported, never thrown: a bad click must not stop intake. */
export async function handleInteraction(raw: unknown, deps: Deps): Promise<void> {
  const click = parseInteraction(raw);
  if (!click) return;
  let store: QuestionStore | undefined;
  try {
    if (click.kind === "c" || click.kind === "p" || click.kind === "pm") await onPrompt(deps, click);
    else {
      store = deps.questions();
      if (click.kind === "d") await onDraft(deps, click, store);
      else if (store) await onQuestion(deps, click, store);
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

const retryAfter = new Map<string, number>();
const warned = new Set<string>();

async function edit(deps: Deps, key: string, run: () => Promise<unknown>, done: () => void): Promise<void> {
  if ((retryAfter.get(key) ?? 0) > deps.now()) return;
  try { await run(); done(); retryAfter.delete(key); }
  catch (error) {
    if (!(error instanceof CallError)) throw error;
    if (error.status === 404) { done(); retryAfter.delete(key); return; }
    if (!retryAfter.has(key)) deps.warn(`could not update Discord message (${key}); retrying: ${error.message}`);
    retryAfter.set(key, deps.now() + RETRY_FAILED_EDIT_MS);
  }
}

/**
 * Posts a reply once. Discord deduplicates a nonce only for a few minutes, so every attempt first looks
 * for an earlier copy after the referenced message; a lost response therefore never yields a second post.
 */
async function postOnce(deps: Deps, channelId: string, referenceId: string, content: string, nonce: string): Promise<void> {
  let after = referenceId;
  for (let page = 0; ; page++) {
    if (page === 50) throw new CallError(undefined, `could not finish checking ${channelId} for an earlier copy`);
    const recent = await deps.call("GET", `/channels/${channelId}/messages?after=${after}&limit=100`);
    const items = Array.isArray(recent) ? recent.map(record).filter((item) => item !== undefined) : [];
    if (items.some((message) => record(message.author)?.bot === true && message.content === content &&
        record(message.message_reference)?.message_id === referenceId)) return;
    if (items.length < 100) break;
    after = items.map((message) => id(message.id) ?? "0").reduce((a, b) => BigInt(a) > BigInt(b) ? a : b);
  }
  await deps.call("POST", `/channels/${channelId}/messages`, {
    content, allowed_mentions: { parse: [] }, nonce, enforce_nonce: true,
    message_reference: { message_id: referenceId, fail_if_not_exists: false },
  });
}

async function closePrompt(deps: Deps, row: Prompt): Promise<void> {
  const suffix = CLOSE_SUFFIX[row.status];
  await edit(deps, `prompt:${row.id}`, () => deps.call("PATCH", `/channels/${row.channel_id}/messages/${row.message_id}`, {
    ...(suffix ? { content: `${row.content}\n${suffix}`, allowed_mentions: { parse: [] } } : {}), components: [],
  }), () => deps.prompts.cleared(row.id, deps.now()));
}

async function announceQuestion(deps: Deps, store: QuestionStore, question: Question): Promise<void> {
  const channel = question.channel_id, message = question.message_id;
  if (!channel || !message) return;
  if (question.answer_source === "component" && question.announced_at === null) {
    if (!question.answer_text || !question.answer_author) {
      if (!warned.has(question.id)) deps.warn(`question ${question.id} has no answer text to post; inspect it`);
      warned.add(question.id);
    } else {
      await edit(deps, `answer:${question.id}`, () => postOnce(deps, channel, message, `<@${question.answer_author}>: ${question.answer_text}`,
        `a${question.id}`), () => store.announced(question.id, deps.now()));
    }
  }
  if (!question.components || question.cleared_at !== null || !["answered", "done", "cancelled"].includes(question.status)) return;
  await edit(deps, `question:${question.id}`, async () => {
    if (question.status !== "cancelled") {
      await deps.call("PATCH", `/channels/${channel}/messages/${message}`, { components: [] });
      return;
    }
    const current = String(record(await deps.call("GET", `/channels/${channel}/messages/${message}`))?.content ?? "");
    await deps.call("PATCH", `/channels/${channel}/messages/${message}`, {
      content: current.endsWith(QUESTION_CANCELLED) ? current : `${current}\n${QUESTION_CANCELLED}`, components: [], allowed_mentions: { parse: [] },
    });
  }, () => store.cleared(question.id, deps.now()));
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

export async function sweep(deps: Deps): Promise<void> {
  await settlePrompts(deps);
  const now = deps.now();
  expireNow(deps);
  const store = deps.questions();
  try {
    deps.prompts.expireDrafts(now, new Set(store?.answering() ?? []));
    for (const row of deps.prompts.needingNotice()) {
      const reference = row.result_message_id ?? row.message_id;
      if (!reference) continue;
      await edit(deps, `lapse:${row.id}`, () => postOnce(deps, row.channel_id, reference, NOTICE.lapsed, `l${row.id}`),
        () => deps.prompts.noticed(row.id, deps.now()));
    }
    for (const row of deps.prompts.toClose()) await closePrompt(deps, row);
    if (!store) return;
    await settleAnswers(deps, store);
    for (const question of store.toAnnounce()) await announceQuestion(deps, store, question);
    for (const question of store.toClear()) await announceQuestion(deps, store, question);
  } finally { store?.close(); }
}
