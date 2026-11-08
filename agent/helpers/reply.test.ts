import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("explicit mentions ping only allowlisted users while profile references stay silent", async () => {
  const requests: HttpRequest[] = [];
  const http: Http = async request => {
    requests.push(request);
    return { status: 200, headers: {}, body: '{"id":"345678901234567890"}' };
  };
  const text = "<@111> please review. **[James](<https://discord.com/users/222>)** reported it. <@333> @everyone";

  await sendReply(new Discord(http, clock, "fake-token"), target, text, ["111", "111"]);

  expect(JSON.parse(String(requests[0]?.body))).toMatchObject({
    content: text, allowed_mentions: { parse: [], replied_user: true, users: ["111"] },
  });
});

test("intentional ping IDs are parsed separately from references and covered messages", () => {
  expect(parseArgs([target.channel_id, target.message_id, "Review <@111>", "--ping", "111,222", "--covers", "333"])?.ping)
    .toEqual(["111", "222"]);
  expect(parseArgs([target.channel_id, target.message_id, "Review", "--ping", "everyone"])).toBeUndefined();
  expect(parseArgs([target.channel_id, target.message_id, "Review", "--ping"])).toBeUndefined();
});

test("the installed reply command carries explicit ping intent to Discord without changing references", async () => {
  const directory = mkdtempSync(join(tmpdir(), "helio-reply-ping-"));
  try {
    const preload = join(directory, "offline.ts");
    writeFileSync(preload, `globalThis.fetch=async(input,init)=>{
      const url=String(input);
      if(init?.method==="POST"&&url.endsWith("/messages")){
        console.log("OFFLINE_BODY "+init.body);return Response.json({id:"345678901234567890"});
      }
      if(url.endsWith("/channels/${target.channel_id}"))return Response.json({id:"${target.channel_id}",type:0,guild_id:"99999"});
      throw new Error("Unexpected offline request: "+url);
    };`);
    const child = Bun.spawn([process.execPath, "--preload", preload, new URL("./reply.ts", import.meta.url).pathname,
      target.channel_id, target.message_id, "<@111> review; **[James](<https://discord.com/users/222>)** <@333>", "--ping", "111"], {
      env: { ...process.env, DORI_DISCORD_TOKEN: "offline", DORI_STATE_DIR: "", DORI_POLICY_DIR: "",
        DORI_DISCORD_OWNER_ID: "222", DORI_DISCORD_ALLOWED: target.channel_id, DORI_DISCORD_TRUSTED_IDS: "",
        DORI_DISCORD_TRUSTED_CHANNELS: "", DORI_DISCORD_NORMAL_CHANNELS: target.channel_id,
        DORI_DISCORD_IGNORED_CHANNELS: "", DORI_DISCORD_SCOPE_CATEGORY: "", DORI_DISCORD_REPORT_CHANNELS: "" },
      stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 15000,
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    const body = JSON.parse(stdout.split("\n").find(line => line.startsWith("OFFLINE_BODY "))?.slice("OFFLINE_BODY ".length) ?? "null");
    expect(body.allowed_mentions).toEqual({ parse: [], replied_user: true, users: ["111"] });
    expect(body.content).toBe("<@111> review; **[James](<https://discord.com/users/222>)** <@333>");
  } finally { rmSync(directory, { recursive: true, force: true }); }
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
  expect(JSON.parse(String(requests[0]?.body)).content).toBe("Issue [Issue #12](<https://github.com/jamestesting0/elo-bot/issues/12>) and [PR #9](<https://github.com/jamestesting0/elo-bot/pull/9>).");
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

test("reply text can come from a file, so no shell ever sees its backticks", () => {
  expect(parseArgs([target.channel_id, target.message_id, "--text-file", "/tmp/r.txt", "--covers", "111"])).toEqual({
    channel_id: target.channel_id, message_id: target.message_id, text: "", text_file: "/tmp/r.txt", covers: ["111"], seen: [],
  });
  expect(parseArgs([target.channel_id, target.message_id, "--text-file"])).toBeUndefined();
  expect(parseArgs([target.channel_id, target.message_id, "--text-file", "/tmp/r.txt", "also text"])).toBeUndefined();
});
