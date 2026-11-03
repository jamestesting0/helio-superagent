import { expect, test } from "bun:test";
import { Discord } from "./vendor/dori-mode/scripts/src/messenger/discord.ts";
import { type Http, type HttpRequest, MessengerError, UnsafeMessageError } from "./vendor/dori-mode/scripts/src/messenger/http.ts";
import { parseArgs, sendReply } from "./reply.ts";

const target = { channel_id: "123456789012345678", message_id: "234567890123456789" };
const clock = { now: () => 0, sleep: async () => {} };

test("replies reference the exact inbound message and ping only its author", async () => {
  const requests: HttpRequest[] = [];
  const http: Http = async (request) => {
    requests.push(request);
    return { status: 200, headers: {}, body: '{"id":"345678901234567890"}' };
  };
  const text = "quotes \"' ; `literal`\n--to other {thread} \\ @everyone <@999>";

  expect(await sendReply(new Discord(http, clock, "fake-token"), target, text)).toBe("345678901234567890");

  expect(requests).toHaveLength(1);
  expect(requests[0]?.url).toBe(`https://discord.com/api/v10/channels/${target.channel_id}/messages`);
  expect(requests[0]?.method).toBe("POST");
  expect(JSON.parse(String(requests[0]?.body))).toEqual({
    content: text,
    message_reference: { type: 0, channel_id: target.channel_id, message_id: target.message_id, fail_if_not_exists: true },
    allowed_mentions: { parse: [], replied_user: true },
  });
});

test.each([403, 404])("a rejected reply (%s) fails without sending an unreferenced fallback", async (status) => {
  const requests: HttpRequest[] = [];
  const http: Http = async (request) => {
    requests.push(request);
    return { status, headers: {}, body: '{"message":"unavailable"}' };
  };

  await expect(sendReply(new Discord(http, clock, "fake-token"), target, "reply")).rejects.toBeInstanceOf(MessengerError);
  expect(requests).toHaveLength(1);
});

test.each([
  { channel_id: "discord:123", message_id: target.message_id },
  { channel_id: target.channel_id, message_id: "234/other" },
  { channel_id: target.channel_id, message_id: "234\n" },
])("invalid inbound IDs never reach Discord: %j", async (invalid) => {
  const http = async (): Promise<never> => { throw new Error("Unexpected HTTP request"); };

  await expect(sendReply(new Discord(http, clock, "fake-token"), invalid, "reply")).rejects.toBeInstanceOf(TypeError);
});

test("reply text retains the messenger substitution guard before HTTP", async () => {
  const http = async (): Promise<never> => { throw new Error("Unexpected HTTP request"); };

  await expect(sendReply(new Discord(http, clock, "fake-token"), target, "$(literal)")).rejects.toBeInstanceOf(UnsafeMessageError);
});

test("replies suppress issue and pull request previews without altering existing brackets", async () => {
  const requests: HttpRequest[] = [];
  const http: Http = async (request) => { requests.push(request); return { status: 200, headers: {}, body: '{"id":"3"}' }; };
  await sendReply(new Discord(http, clock, "fake"), target, "Issue https://github.com/jamestesting0/elo-bot/issues/12 and <https://github.com/jamestesting0/elo-bot/pull/9>.");
  expect(JSON.parse(String(requests[0]?.body)).content).toBe("Issue <https://github.com/jamestesting0/elo-bot/issues/12> and <https://github.com/jamestesting0/elo-bot/pull/9>.");
});

test("the covered and reviewed ID lists are parsed beside the three positional arguments", () => {
  expect(parseArgs([target.channel_id, target.message_id, "answer", "--covers", "111, 222", "--seen", "333"])).toEqual({
    channel_id: target.channel_id, message_id: target.message_id, text: "answer", covers: ["111", "222"], seen: ["333"],
  });
  expect(parseArgs([target.channel_id, target.message_id, "answer"])).toEqual({
    channel_id: target.channel_id, message_id: target.message_id, text: "answer", covers: [], seen: [],
  });
  expect(parseArgs([target.channel_id, target.message_id, "t", "--covers", "111", "--covers", "222"])?.covers).toEqual(["111", "222"]);
});

test("a reply whose own text looks like a flag is still sent as text", () => {
  expect(parseArgs([target.channel_id, target.message_id, "--covers"])?.text).toBe("--covers");
});

test.each([
  { case: "no reply text", tail: [] },
  { case: "a stray positional", tail: ["t", "extra"] },
  { case: "a list with no IDs", tail: ["t", "--covers"] },
  { case: "an empty list", tail: ["t", "--covers", ""] },
  { case: "a non-numeric ID", tail: ["t", "--covers", "11,bad"] },
  { case: "a positional after a list", tail: ["t", "--seen", "11", "extra"] },
])("reply arguments with $case are rejected instead of guessed", ({ tail }) => {
  expect(parseArgs([target.channel_id, target.message_id, ...tail])).toBeUndefined();
});
