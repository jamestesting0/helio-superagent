import { expect, test } from "bun:test";
import { RecoveryRequiredError } from "../delivery/recovery-store.ts";
import { withStores, stage, fakeRest, reply, T0, idAt } from "../fixtures/working.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Delivery } from "../delivery/delivery.ts";
import { authorizationMetadata } from "../intake/authorization.ts";

test("recovery CLI retains unavailable work, records review and resets it on the next startup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "helio-recovery-cli-"));
  const queue = new Delivery(join(dir, "discord-delivery.sqlite"));
  const invoke = async (...args: string[]) => {
    const child = Bun.spawn([process.execPath, "--preload", join(import.meta.dir, "../fixtures/discord.ts"),
      join(import.meta.dir, "../recovery.ts"), ...args], {
      env: { ...process.env, PATH: "/nonexistent", DORI_STATE_DIR: dir, DORI_DISCORD_TOKEN: "test",
        DORI_DISCORD_OWNER_ID: "99", DORI_DISCORD_ALLOWED: "100", DORI_DISCORD_TRUSTED_CHANNELS: "100",
        DORI_DISCORD_NORMAL_CHANNELS: "", DORI_DISCORD_TRUSTED_IDS: "", DORI_DISCORD_REPORT_CHANNELS: "",
        DORI_DISCORD_CONTEXT: "", DORI_DISCORD_CONTEXT_EXCLUDED: "", DORI_DISCORD_BUG_REPORT_SOURCE: undefined },
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    return stdout;
  };
  try {
    const payload = JSON.stringify({
      message_id: "11", channel_id: "100", author_id: "99", content: "help", preparation_complete: true,
      sent_at: "2026-11-02T12:00:00Z", role: "OWNER_REQUEST", scope: "may-request-work",
      attention: "direct", channel_policy: "trusted",
      discord_origin: authorizationMetadata({ id: "11", channel_id: "100", guild_id: "300",
        author: { id: "99", username: "owner" }, content: "help", timestamp: "2026-11-02T12:00:00Z" }),
    });
    queue.stage("inbound", "11", payload);
    queue.accept("11");
    expect(await invoke("begin")).toContain("count=1");
    expect(await invoke("scan")).toContain("github=unavailable");
    expect(queue.status("inbound", "11").disposition).toBe("accepted");
    expect(() => queue.recovery.requireReviewed("11", payload)).toThrow(RecoveryRequiredError);
    const reason = join(dir, "reason.txt");
    await Bun.write(reason, "Accepted work remains unfinished; dependency unavailable, no action authorized");
    await invoke("review", "11", "--outcome", "resume", "--reason-file", reason);
    expect(() => queue.recovery.requireReviewed("11", payload)).not.toThrow();
    await invoke("begin");
    expect(() => queue.recovery.requireReviewed("11", payload)).toThrow(RecoveryRequiredError);
    await Bun.write(reason, "Historical clarification only; no outstanding request");
    await invoke("review", "11", "--outcome", "informational", "--reason-file", reason);
    expect(queue.status("inbound", "11").disposition).toBe("done");
    expect(queue.recovery.status("11")?.reason).toContain("Historical clarification");
  } finally { queue.close(); await rm(dir, { recursive: true, force: true }); }
});

test("restart requires review before a recovered reply, while new messages remain eligible", async () => {
  await withStores(async (queue, store) => {
    const old = idAt(T0), fresh = idAt(T0 + 1_000);
    stage(queue, old);
    expect(queue.recovery.begin()).toBe(1);
    stage(queue, fresh);
    const { rest } = fakeRest({ [old]: "help", [fresh]: "help" });
    const blocked = reply(queue, store, rest, old, T0);
    expect((await blocked.result).code).toBe(3);
    expect(blocked.sent).toEqual([]);
    expect(queue.status("inbound", old).disposition).toBe("pending");
    expect((await reply(queue, store, rest, fresh, T0).result).code).toBe(0);
  });
});

test("reviewed unfinished work resumes without consuming the pending request", async () => {
  await withStores(async (queue, store) => {
    const id = idAt(T0);
    stage(queue, id);
    queue.accept(id, T0);
    queue.recovery.begin();
    const payload = queue.pending("inbound")[0]?.payload;
    if (!payload) throw new Error("Missing fixture delivery");
    queue.recovery.review(id, payload, { outcome: "resume", reason: "Lane still working; no completed PR", evidence: "{}" });
    const { rest } = fakeRest({ [id]: "help" });
    expect((await reply(queue, store, rest, id, T0).result).code).toBe(0);
    expect(queue.status("inbound", id).disposition).toBe("accepted");
  });
});

test("a send receipt recovered after a crash prevents another initial answer", async () => {
  await withStores(async (queue, store) => {
    const id = idAt(T0);
    stage(queue, id);
    queue.recovery.begin();
    const payload = queue.pending("inbound")[0]?.payload;
    if (!payload) throw new Error("Missing fixture delivery");
    queue.recovery.review(id, payload, { outcome: "resume", reason: "Reply sent before acknowledgement; work state is separate",
      evidence: JSON.stringify({ prior_replies: ["900"] }) });
    const { rest } = fakeRest({ [id]: "help" });
    const repeated = reply(queue, store, rest, id, T0);
    expect((await repeated.result).code).toBe(4);
    expect(repeated.sent).toEqual([]);
    expect(queue.status("inbound", id).disposition).toBe("pending");
  });
});

test("an edited source invalidates a prior recovery review", async () => {
  await withStores(async (queue) => {
    const id = idAt(T0);
    stage(queue, id);
    queue.recovery.begin();
    const before = queue.pending("inbound")[0]?.payload;
    if (!before) throw new Error("Missing fixture delivery");
    queue.recovery.review(id, before, { outcome: "resume", reason: "Reviewed current work", evidence: "{}" });
    const edited = JSON.stringify({ ...JSON.parse(before), content: "Changed request" });
    queue.refresh(id, before, edited);
    queue.recovery.flag(id, edited);
    expect(() => queue.recovery.requireReviewed(id, edited)).toThrow(RecoveryRequiredError);
  });
});

test("unavailable source verification never sends a guessed answer", async () => {
  await withStores(async (queue, store) => {
    const id = idAt(T0);
    stage(queue, id);
    const unavailable = async <T>(): Promise<T> => { throw new Error("Discord unavailable"); };
    const attempt = reply(queue, store, unavailable, id, T0);
    expect((await attempt.result).code).toBe(3);
    expect(attempt.sent).toEqual([]);
    expect(queue.status("inbound", id).disposition).toBe("pending");
  });
});
