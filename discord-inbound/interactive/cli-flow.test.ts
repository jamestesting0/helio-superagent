import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./cli.ts";
import { PromptStore } from "./store.ts";

const SHA = "9f45e57" + "a".repeat(33);
let dir: string, posts: { path: string; body: any }[], realFetch: typeof fetch, saved: Record<string, string | undefined>;
let failPost: number | undefined;

async function checker(code: number): Promise<string> {
  const path = join(dir, `check-${code}.py`);
  await Bun.write(path, `import sys\nprint('RELEASE_ALREADY_MERGED' if ${code}==4 else 'PREFLIGHT_OK')\nsys.exit(${code})\n`);
  return path;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "helio-confirm-"));
  posts = []; failPost = undefined; realFetch = globalThis.fetch;
  const env = { DORI_STATE_DIR: dir, DORI_DISCORD_TOKEN: "t", DORI_DISCORD_OWNER_ID: "99", DORI_DISCORD_TRUSTED_IDS: "77",
    DORI_DISCORD_ALLOWED: "400", HELIO_GITHUB_REPO: "o/r", HELIO_RELEASE_CHECK: await checker(0) };
  saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const path = new URL(String(input)).pathname.replace("/api/v10", "");
    if (path === "/channels/100") return Response.json({ id: "100", type: 0, parent_id: "400" });
    if (path === "/channels/400") return Response.json({ id: "400", type: 4 });
    if (path === "/channels/200") return Response.json({ id: "200", type: 0 });
    if (path === "/channels/300") return Response.json({ id: "300", type: 1, recipients: [{ id: "77" }] });
    if (init?.method === "POST") {
      posts.push({ path, body: JSON.parse(String(init.body)) });
      if (failPost) return new Response("boom", { status: failPost });
      return Response.json({ id: String(500 + posts.length) });
    }
    if (path === "/users/@me") return Response.json({ id: "88" });
    if (path.endsWith("/messages")) return Response.json([{ id: "555", author: { id: "88" }, components: [{ components: [{ custom_id: `h1:c:${posts[0]?.body.nonce}:confirm` }] }] }]);
    return new Response("unexpected", { status: 500 });
  }, { preconnect: realFetch.preconnect });
});
afterEach(async () => {
  globalThis.fetch = realFetch;
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(dir, { recursive: true, force: true });
});
const store = () => new PromptStore(join(dir, "discord-prompts.sqlite"));

test("ask posts one prompt with buttons and a nonce, and asking again reuses it", async () => {
  const argv = ["ask", "--action", "merge", "--target", "o/r#6", "--revision", SHA, "--channel", "100", "--reply-to", "42"];
  expect(await main(argv)).toBe(0);
  expect(await main(argv)).toBe(0);
  expect(posts).toHaveLength(1);
  const body = posts[0]!.body;
  expect(body).toMatchObject({ content: "Merge [PR #6](<https://github.com/o/r/pull/6>) · `9f45e57`?", enforce_nonce: true, allowed_mentions: { parse: [] },
    message_reference: { message_id: "42", fail_if_not_exists: false } });
  expect(body.components[0].components.map((b: { label: string; custom_id: string }) => b.label)).toEqual(["Merge", "Cancel"]);
  const s = store();
  try { expect(s.get(body.nonce)).toMatchObject({ status: "open", message_id: "501", action: "merge" }); } finally { s.close(); }
});

test("disallowed places, bad targets and merged PRs never post a prompt", async () => {
  expect(main(["ask", "--action", "merge", "--target", "o/r#6", "--revision", SHA, "--channel", "200"])).rejects.toThrow("not an allowed channel");
  expect(main(["ask", "--action", "merge", "--target", "x/y#6", "--revision", SHA, "--channel", "100"])).rejects.toThrow("target must be");
  process.env.HELIO_RELEASE_CHECK = await checker(4);
  expect(await main(["ask", "--action", "merge", "--target", "o/r#6", "--revision", SHA, "--channel", "100"])).toBe(4);
  expect(posts).toEqual([]);
});

test("trusted DMs are allowed and PR prompts skip the release preflight", async () => {
  process.env.HELIO_RELEASE_CHECK = await checker(2);
  expect(await main(["ask", "--action", "pr", "--target", "o/r#4", "--revision", SHA, "--channel", "300"])).toBe(0);
  expect(posts[0]?.body.content).toBe("Open PR for [Issue #4](<https://github.com/o/r/issues/4>) · `9f45e57`?");
});

test("a note adds one line that pings only the users it names, and PR prompts stay open for 72 hours", async () => {
  const note = "<@99> <@77> <https://github.com/o/r/issues/4>";
  expect(await main(["ask", "--action", "pr", "--target", "o/r#4", "--revision", SHA, "--channel", "100", "--note", note])).toBe(0);
  expect(posts[0]?.body).toMatchObject({ content: "Open PR for [Issue #4](<https://github.com/o/r/issues/4>) · `9f45e57`?\n<@99> <@77> [Issue #4](<https://github.com/o/r/issues/4>)", allowed_mentions: { parse: [], users: ["99", "77"] } });
  const s = store();
  try { const row = s.get(posts[0]!.body.nonce)!; expect(row.expires_at - row.created_at).toBe(72 * 3_600_000); } finally { s.close(); }
  for (const bad of ["❌ Cancelled", "a\nb", "x".repeat(301)]) {
    expect(main(["ask", "--action", "pr", "--target", "o/r#5", "--revision", SHA, "--channel", "100", "--note", bad])).rejects.toThrow("--note");
  }
  expect(posts).toHaveLength(1);
});

test("an uncertain send is recorded and recovered from the channel without posting twice", async () => {
  failPost = 502;
  expect(await main(["ask", "--action", "restart", "--target", "elobot", "--revision", SHA, "--channel", "100"])).toBe(1);
  const id = posts[0]!.body.nonce;
  const s = store();
  try { expect(s.get(id)?.status).toBe("delivery_unknown"); } finally { s.close(); }
  expect(await main(["recover", id])).toBe(0);
  const after = store();
  try { expect(after.get(id)).toMatchObject({ status: "open", message_id: "555" }); } finally { after.close(); }
  expect(posts).toHaveLength(1);
});

test("a new plan revision replaces the previous plan prompt", async () => {
  const file = join(dir, "announce.txt");
  await Bun.write(file, "📋 Plan for #12 (r1): first");
  expect(await main(["plan", "--issue", "12", "--revision", "1", "--text-file", file, "--channel", "100"])).toBe(0);
  await Bun.write(file, "📋 Plan for #12 (r2): second");
  expect(await main(["plan", "--issue", "12", "--revision", "2", "--text-file", file, "--channel", "100"])).toBe(0);
  const [first, second] = posts.map((post) => post.body.nonce);
  const s = store();
  try { expect([s.get(first)?.status, s.get(second)?.status]).toEqual(["superseded", "open"]); } finally { s.close(); }
  expect(main(["plan", "--issue", "12", "--revision", "3", "--text-file", file, "--channel", "100"])).rejects.toThrow("does not match");
});

test("use consumes a confirmation once; cancel only stops an undecided prompt", async () => {
  expect(await main(["ask", "--action", "merge", "--target", "o/r#6", "--revision", SHA, "--channel", "100"])).toBe(0);
  const id = posts[0]!.body.nonce;
  expect(main(["use", id])).rejects.toThrow("is open");
  const s = store();
  try { s.begin(id, "99", Date.now(), { app: "88", token: "tok", accept: true, expected: "shown" }); s.finish(id, "99", "confirmed", Date.now(), "700", true); } finally { s.close(); }
  expect(main(["cancel", id])).rejects.toThrow("cannot be cancelled");
  expect(await main(["use", id])).toBe(0);
  expect(main(["use", id])).rejects.toThrow("is used");
});

test.each(["merge", "restart"])("a clicked %s approval is usable once at eleven hours and lapses at twelve", async (action) => {
  const decided = Date.now(), early = "1".repeat(20), late = "2".repeat(20);
  const confirm = (id: string, at: number) => {
    const s = store();
    try {
      s.create({ id, kind: "confirm", action, target: action === "merge" ? "o/r#6" : "elobot", revision: SHA,
        content: "approval", channel_id: "100", now: at });
      s.sent(id, "500", at);
      s.begin(id, "99", at, { app: "88", token: "tok", accept: true, expected: "shown" });
      expect(s.finish(id, "99", "confirmed", at, "700", true)).toBe(true);
    } finally { s.close(); }
  };
  confirm(early, decided);
  const used = decided + 11 * 3_600_000;
  const clock = spyOn(Date, "now").mockReturnValue(used);
  try {
    expect(await main(["use", early])).toBe(0);
    await expect(main(["use", early])).rejects.toThrow("is used");
    confirm(late, used);  // a later, separate approval for the same subject: the earlier use does not cover it
    const remaining = store();
    try {
      expect(remaining.nextDeadline()).toBe(used + 12 * 3_600_000);
      expect(remaining.expireDue(used + 11 * 3_600_000)).toEqual([]);
      expect(remaining.use(late, used + 12 * 3_600_000)).toBe(false);
      remaining.expireDue(used + 12 * 3_600_000);
      expect(remaining.get(late)?.status).toBe("lapsed");
    } finally { remaining.close(); }
  } finally { clock.mockRestore(); }
});

test("a click reaches the running intake watcher and is answered outside the message queue", async () => {
  const s = store();
  const id = "0".repeat(19) + "1";
  try {
    s.create({ id, kind: "confirm", action: "merge", target: "o/r#6", revision: SHA, content: "Merge #6 · `9f45e57`?", channel_id: "100",
      now: Date.parse("2026-11-02T12:00:00Z") });
    s.sent(id, "500", Date.parse("2026-11-02T12:00:00Z"));
  } finally { s.close(); }
  const child = Bun.spawn([process.execPath, "--preload", join(import.meta.dir, "../fixtures/discord.ts"), join(import.meta.dir, "../inbound.ts")], {
    env: { ...process.env, DORI_TEST_INTERACTION: `h1:c:${id}:confirm`, DORI_DISCORD_ALLOWED: "100", DORI_DISCORD_TRUSTED_CHANNELS: "",
      DORI_DISCORD_NORMAL_CHANNELS: "", DORI_DISCORD_TRUSTED_IDS: "", DORI_DISCORD_REPORT_CHANNELS: "", DORI_DISCORD_BUG_REPORT_SOURCE: undefined },
    stdout: "pipe", stderr: "pipe", stdin: "ignore",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  expect(stdout).toContain(`TEST_CALLBACK {"type":4,"data":{"content":"✅ **[Unavailable user](<https://discord.com/users/99>)** confirmed merge [PR #6](<https://github.com/o/r/pull/6>) · \`9f45e57\`","allowed_mentions":{"parse":[]}}}`);
  expect(stdout).toContain(`TEST_PATCH /api/v10/channels/100/messages/500 {"components":[]}`);
  const confirm = stdout.split("\n").find((line) => line.startsWith("INBOUND_CONFIRM "));
  expect(JSON.parse(confirm!.slice("INBOUND_CONFIRM ".length))).toMatchObject({ id, outcome: "confirmed", by: "99", result_message_id: "701" });
  const after = store();
  try { expect(after.get(id)?.status).toBe("confirmed"); } finally { after.close(); }
});

test("an authorized reply reaches plan feedback through the running intake watcher", async () => {
  const s = store(), id = "0".repeat(19) + "2", now = Date.parse("2026-11-02T12:00:00Z");
  try {
    s.create({ id, kind: "plan", action: "plan", target: "o/r#6", revision: "2",
      content: "📋 Plan for #6 (r2): first", channel_id: "100", now });
    s.sent(id, "89", now);
  } finally { s.close(); }
  const child = Bun.spawn([process.execPath, "--preload", join(import.meta.dir, "../fixtures/discord.ts"), join(import.meta.dir, "../inbound.ts")], {
    env: { ...process.env, DORI_TEST_REPLIES: "1", DORI_TEST_REPLY_PARENT: "1", DORI_DISCORD_ALLOWED: "100", DORI_DISCORD_TRUSTED_CHANNELS: "100",
      DORI_DISCORD_NORMAL_CHANNELS: "", DORI_DISCORD_REPORT_CHANNELS: "", DORI_DISCORD_BUG_REPORT_SOURCE: undefined },
    stdout: "pipe", stderr: "pipe", stdin: "ignore",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  const feedbackLines = stdout.split("\n").filter((line) => line.startsWith("INBOUND_PLAN_FEEDBACK "));
  expect(feedbackLines).toHaveLength(1);
  const after = store();
  try {
    const feedback = after.feedback(id);
    expect(feedback).toHaveLength(1);
    expect(feedback[0]).toMatchObject({ message_id: "90", user_id: "99", text: "try again now" });
    expect(JSON.parse(feedbackLines[0]!.slice("INBOUND_PLAN_FEEDBACK ".length))).toMatchObject({
      id, target: "o/r#6", revision: "2", feedback: feedback[0]?.id, by: "99",
    });
  } finally { after.close(); }
});

test("a merge train posts one prompt for every PR, and its approval is bound once with the release lock", async () => {
  const file = join(dir, "train.md"), train = "a".repeat(20), other = "b".repeat(20);
  await Bun.write(file, "Merge 2 PRs and restart Elo Bot?\n[PR #18](<https://github.com/o/r/pull/18>) · `2532d55` A\n[PR #20](<https://github.com/o/r/pull/20>) · `bc113f3` B");
  const argv = ["train", "--train", train, "--target", "o/r#18,20", "--revision", SHA, "--text-file", file, "--channel", "100", "--restart"];
  expect(await main(argv)).toBe(0);
  expect(await main(argv)).toBe(0);
  expect(posts).toHaveLength(1);
  expect(posts[0]!.body.components[0].components.map((b: { label: string }) => b.label)).toEqual(["Merge and restart", "Cancel"]);
  expect(posts[0]!.body.content.match(/pull\/18/g)).toHaveLength(1);
  const s = store();
  try {
    s.begin(train, "99", Date.now(), { app: "88", token: "tok", accept: true, expected: "shown" });
    s.finish(train, "99", "confirmed", Date.now(), "700", true);
    s.db.run("INSERT INTO release_locks VALUES ('o/r',?,1)", [other]);
  } finally { s.close(); }
  const log = spyOn(console, "log");
  try {
    expect(await main(["bind", "--prompt", train, "--train", train])).toBe(3);
    const waiting = store();
    try { expect(waiting.get(train)?.status).toBe("confirmed"); waiting.unlock("o/r", other); } finally { waiting.close(); }
    expect(await main(["bind", "--prompt", train, "--train", train])).toBe(0);
    expect(await main(["bind", "--prompt", train, "--train", train])).toBe(0);
    expect(await main(["bind", "--prompt", train, "--train", other])).toBe(2);
  } finally { log.mockRestore(); }
  const bound = store();
  try {
    expect(bound.get(train)?.status).toBe("used");
    expect(bound.binding(train)).toMatchObject({ approval: `prompt:${train}`, approver: "99" });
  } finally { bound.close(); }
});
