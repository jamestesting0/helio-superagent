import { QUESTION_TTL_MS, type Question, type QuestionStore } from "./store.ts";
import { NOTICE } from "./text.ts";
import { edit, notice, postOnce, record, type Click, type Deps } from "./transport.ts";

function mayAnswer(deps: Deps, question: Question, user: string): boolean {
  if (user === deps.ownerId) return true;
  if (question.audience === "staff") return deps.trusted().has(user);
  return question.audience === "thread" && user === question.recipient;
}

function explainQuestion(question: Question | undefined): string {
  if (question?.status === "expired") return "This question expired without an answer.";
  if (question?.status === "answered" || question?.status === "done") return NOTICE.answered(question.answer_author);
  return NOTICE.inactive;
}

function questionOptions(question: Question): string[] | undefined {
  try {
    const parsed: unknown = JSON.parse(question.options ?? "null");
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : undefined;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return undefined;
  }
}

export async function onQuestion(deps: Deps, click: Click, store: QuestionStore): Promise<void> {
  const question = store.get(click.ref);
  if (!question || question.channel_id !== click.channelId || question.message_id !== click.messageId) {
    await notice(deps, click, NOTICE.inactive); return;
  }
  if (!mayAnswer(deps, question, click.userId)) {
    await notice(deps, click, NOTICE.forUser(question.audience === "thread" ? question.recipient : deps.ownerId)); return;
  }
  if (question.status === "expired" || (question.status === "awaiting_answer" && question.updated + QUESTION_TTL_MS <= deps.now())) {
    await notice(deps, click, "This question expired without an answer."); return;
  }
  const label = questionOptions(question)?.[Number(click.verb.slice(1))];
  if (label === undefined) { await notice(deps, click, NOTICE.inactive); return; }
  const role = click.userId === deps.ownerId ? { role: "OWNER_REQUEST", scope: "may-request-work" } :
    deps.trusted().has(click.userId) ? { role: "TRUSTED_REQUEST", scope: "trusted-pr-merge-restart" } :
      { role: "STAFF_QUESTION", scope: "answer-only" };
  if (!store.answer(question.id, { id: click.id, author: click.userId, ...role, text: label }, deps.now())) {
    await notice(deps, click, explainQuestion(store.get(question.id))); return;
  }
  // A lost callback cannot undo a tap. The durable answer is announced and cleared by upkeep.
  await notice(deps, click, "Sent ✓");
  await announceQuestion(deps, store, { ...question, status: "answered", answer_text: label,
    answer_author: click.userId, answer_source: "component", announced_at: null });
}

const warned = new Set<string>();

export async function announceQuestion(deps: Deps, store: QuestionStore, question: Question): Promise<void> {
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
  if ((!question.components && question.status !== "expired") || question.cleared_at !== null ||
      !["answered", "done", "cancelled", "expired"].includes(question.status)) return;
  await edit(deps, `question:${question.id}`, async () => {
    const suffix = question.status === "cancelled" ? "❌ Cancelled" :
      question.status === "expired" ? "Expired without an answer." :
      question.answer_source === "reply" ? `Answered by <@${question.answer_author}> (typed reply)` : undefined;
    if (!suffix) {
      await deps.call("PATCH", `/channels/${channel}/messages/${message}`, { components: [] });
      return;
    }
    const current = String(record(await deps.call("GET", `/channels/${channel}/messages/${message}`))?.content ?? "");
    await deps.call("PATCH", `/channels/${channel}/messages/${message}`, {
      content: current.endsWith(suffix) ? current : `${current}\n${suffix}`, components: [], allowed_mentions: { parse: [] },
    });
  }, () => store.cleared(question.id, deps.now()));
}
