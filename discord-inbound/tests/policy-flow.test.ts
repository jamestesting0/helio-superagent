import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Delivery } from "../delivery/delivery.ts";
import { deliveryOutput } from "../fixtures/delivery-output.ts";
import { authorizationMetadata } from "../intake/authorization.ts";

async function invoke(dir: string, script: string, settings: {
  readonly args?: readonly string[];
  readonly allowed?: string;
  readonly trustedChannels?: string;
  readonly trustedIds?: string;
  readonly trustedDms?: boolean;
  readonly archived?: boolean;
  readonly bugReportSource?: string;
  readonly bugReports?: boolean;
  readonly unknownBot?: boolean;
} = {}) {
  const child = Bun.spawn([
    process.execPath, "--preload", join(import.meta.dir, "../fixtures/discord.ts"),
    join(import.meta.dir, "..", script), ...(settings.args ?? []),
  ], {
    env: {
      ...process.env, DORI_STATE_DIR: dir, DORI_DISCORD_TOKEN: "test",
      DORI_DISCORD_OWNER_ID: "99", DORI_DISCORD_ALLOWED: settings.allowed ?? "100",
      DORI_DISCORD_TRUSTED_CHANNELS: settings.trustedChannels ?? "",
      DORI_DISCORD_NORMAL_CHANNELS: "",
      DORI_TEST_PING_REPLY: "", DORI_TEST_TRACE_READS: "", DORI_TEST_LIVE_REPLY: "",
      DORI_DISCORD_TRUSTED_IDS: settings.trustedIds ?? "",
      DORI_DISCORD_REPORT_CHANNELS: "",
      DORI_DISCORD_BUG_REPORT_SOURCE: settings.bugReportSource,
      DORI_TEST_TRUSTED_DMS: settings.trustedDms ? "1" : "",
      DORI_TEST_ARCHIVED: settings.archived ? "1" : "",
      DORI_TEST_BUG_REPORTS: settings.bugReports ? "1" : "",
      DORI_TEST_UNKNOWN_BOT: settings.unknownBot ? "1" : "",
      DORI_TEST_FORWARDS: "", DORI_TEST_REFRESH: "", DORI_TEST_NULL_PARENT: "", DORI_TEST_REPLIES: "",
    },
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  return { stdout: stdout.includes("INBOUND ") ? deliveryOutput(dir, stdout) : stdout, stderr, exitCode };
}

const inbound = (stdout: string): Record<string, unknown>[] => stdout.split("\n")
  .filter((line) => line.startsWith("INBOUND ")).map((line) => JSON.parse(line.slice(8)));

test.each([
  { allowed: "100", trustedChannels: "400" },
  { allowed: "100", trustedChannels: "600" },
  { allowed: "100,103", trustedChannels: "100" },
])("invalid or ambiguous channel trust stops before queue creation: %j", async (settings) => {
  const dir = await mkdtemp(join(tmpdir(), "dori-policy-config-"));
  try {
    const result = await invoke(dir, "inbound.ts", settings);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("DORI_DISCORD_TRUSTED_CHANNELS");
    expect(await Bun.file(join(dir, "discord-delivery.sqlite")).exists()).toBe(false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("current channel and sender configuration replaces stale queued labels on watcher and ack replay", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dori-replay-policy-"));
  try {
    const first = await invoke(dir, "inbound.ts", { trustedChannels: "100" });
    expect(first.exitCode).toBe(0);
    const original = inbound(first.stdout).find((message) => message.message_id === "10");
    expect(original?.channel_policy).toBe("trusted");
    if (!Array.isArray(original?.attachments) || typeof original.attachments[0]?.path !== "string") {
      throw new Error("Missing prepared fixture attachment");
    }
    const photo = original.attachments[0].path;
    const queue = new Delivery(join(dir, "discord-delivery.sqlite"));
    try {
      const previous = queue.pending("inbound").find((item) => item.id === "10");
      if (!previous) throw new Error("Missing staged fixture");
      queue.refresh("10", previous.payload, JSON.stringify({
        ...JSON.parse(previous.payload), author_id: "77", role: "TRUSTED_REQUEST",
        scope: "trusted-pr-merge-restart", channel_policy: "trusted",
      }));
    } finally { queue.close(); }

    const replay = await invoke(dir, "inbound.ts");
    expect({ exitCode: replay.exitCode, stderr: replay.stderr }).toEqual({ exitCode: 0, stderr: "" });
    expect(inbound(replay.stdout).map((message) => [message.message_id, message.channel_policy, message.author_id, message.role, message.scope]))
      .toEqual([
        ["10", "normal", "99", "OWNER_REQUEST", "may-request-work"],
      ]);
    const pending = await invoke(dir, "ack.ts", { args: ["pending", "inbound"], trustedChannels: "100" });
    expect({ exitCode: pending.exitCode, stderr: pending.stderr }).toEqual({ exitCode: 0, stderr: "" });
    expect(inbound(pending.stdout).map((message) => [message.channel_policy, message.role, message.author_id]))
      .toEqual([["trusted", "OWNER_REQUEST", "99"]]);
    const retired = await invoke(dir, "ack.ts", { args: ["irrelevant", "inbound", "10", "Unrelated normal-channel ping"] });
    expect({ exitCode: retired.exitCode, stderr: retired.stderr }).toEqual({ exitCode: 0, stderr: "" });
    expect(retired.stdout).toBe("ACK_IRRELEVANT stream=inbound message_id=10\n");
    expect(await Bun.file(photo).exists()).toBe(false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("allowlist and trusted DM revocations withhold old queued requests without deleting them", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dori-revoked-pending-"));
  try {
    const first = await invoke(dir, "inbound.ts", { trustedIds: "77", trustedDms: true, trustedChannels: "100" });
    expect(first.exitCode).toBe(0);
    expect(inbound(first.stdout).filter((message) => message.author_id === "77").map((message) => message.message_id)).toEqual(["31", "33"]);
    const replay = await invoke(dir, "inbound.ts", { allowed: "600" });
    expect(replay.exitCode).toBe(0);
    expect(inbound(replay.stdout).map((message) => message.message_id)).toEqual(["30", "12"]);
    const pending = await invoke(dir, "ack.ts", { args: ["pending", "inbound"], allowed: "600" });
    expect(pending.exitCode).toBe(0);
    expect(inbound(pending.stdout).map((message) => message.message_id)).toEqual(["12", "30"]);
    const queue = new Delivery(join(dir, "discord-delivery.sqlite"));
    try {
      expect(queue.pending("inbound").map((item) => item.id)).toEqual(["10", "12", "30", "31", "33"]);
      expect(queue.status("inbound", "31").disposition).toBe("pending");
    } finally { queue.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test.each(["show", "working"] as const)("%s withholds cached evidence when the final authorization read revokes policy", async action => {
  for (const shared of [false, true]) {
    const dir = await mkdtemp(join(tmpdir(), "helio-cached-revocation-"));
    const queuePath = join(dir, "discord-delivery.sqlite"), policyPath = join(dir, "policy.json");
    const values = { DORI_DISCORD_OWNER_ID: "99", DORI_DISCORD_ALLOWED: "100",
      DORI_DISCORD_TRUSTED_CHANNELS: "", DORI_DISCORD_NORMAL_CHANNELS: "", DORI_DISCORD_IGNORED_CHANNELS: "" };
    await Bun.write(policyPath, JSON.stringify({ version: 1, revision: "a".repeat(64), values }));
    let queue = new Delivery(queuePath);
    try {
      for (const id of ["500", "501"]) {
        const root = { id, type: 0, channel_id: "100", guild_id: "300", author: { id: "99", username: "Owner" },
          content: "<@88> explain this", mentions: [{ id: "88" }], timestamp: new Date().toISOString() };
        queue.stage("inbound", id, JSON.stringify({
          message_id: id, channel_id: "100", author_id: "99", author: "Owner", content: root.content,
          sent_at: root.timestamp, attention: "direct", pinged: true, role: "OWNER_REQUEST",
          scope: "may-request-work", channel_policy: "normal", preparation_complete: true,
          discord_origin: authorizationMetadata(root), conversation: { context_status: "cached",
            recent: [{ message_id: "400", author_id: "66", author: "Bystander", content: "PRIVATE_CACHED_EVIDENCE" }] },
        }));
      }
      if (shared) queue.snapshots.capture(["500", "501"]);
      const before = queue.pending("inbound");
      queue.close();
      const script = `
        import {writeFileSync} from "node:fs";
        globalThis.fetch=Object.assign(async input=>{
          const path=new URL(String(input)).pathname;
          if(path.endsWith("/users/@me"))return Response.json({id:"88"});
          if(path.endsWith("/channels/100")){
            writeFileSync(${JSON.stringify(policyPath)},JSON.stringify({
              version:1,revision:"b".repeat(64),values:{...${JSON.stringify(values)},DORI_DISCORD_ALLOWED:"999"}}));
            return Response.json({id:"100",type:0,guild_id:"300",parent_id:null});
          }
          throw new Error("Unexpected cached-context request "+path);
        },{preconnect:()=>undefined});
        process.argv=[process.execPath,"ack.ts",${JSON.stringify(action)},"inbound","500"];
        await import(${JSON.stringify(join(import.meta.dir, "../ack.ts"))});
      `;
      const child = Bun.spawn([process.execPath, "--eval", script], {
        env: { ...process.env, ...values, HOME: dir, DORI_STATE_DIR: dir, DORI_POLICY_DIR: dir,
          DORI_DISCORD_TOKEN: "offline", DORI_DISCORD_TRUSTED_IDS: "", DORI_DISCORD_REPORT_CHANNELS: "" },
        stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 15000,
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      expect(stdout).not.toContain("PRIVATE_CACHED_EVIDENCE");
      expect(stdout).not.toContain("ACK_TURN");
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
      expect(stdout.toLowerCase()).toContain("ack_withheld 500: privacy policy changed");
      queue = new Delivery(queuePath);
      expect(queue.pending("inbound")).toEqual(before);
      expect(queue.status("inbound", "500").disposition).toBe("pending");
    } finally { queue.close(); await rm(dir, { recursive: true, force: true }); }
  }
});

test.each([false, true])("show rechecks author blocks after a later root is authorized (sender blocked: %s)", async blockSender => {
  const dir = await mkdtemp(join(tmpdir(), "helio-output-author-block-"));
  const queuePath = join(dir, "discord-delivery.sqlite");
  let queue = new Delivery(queuePath);
  try {
    const roots = ["500", "501"].map((id, index) => ({
      id, type: 0, channel_id: "100", guild_id: "300",
      author: { id: index ? "99" : "200", username: "Reporter" },
      content: index ? "<@88> second request" : "<@88> PRIVATE_ROOT", mentions: [{ id: "88" }],
      timestamp: new Date().toISOString(),
    }));
    for (const [index, root] of roots.entries()) queue.stage("inbound", root.id, JSON.stringify({
      message_id: root.id, channel_id: "100", author_id: root.author.id, author: "Reporter", content: root.content,
      sent_at: root.timestamp, preparation_complete: true, pinged: true, role: index ? "OWNER_REQUEST" : "TRUSTED_REQUEST",
      scope: "may-request-work", attention: "direct", channel_policy: "normal",
      discord_origin: { ...authorizationMetadata(root), ...(index ? { message_type: undefined } : {}) },
      ...(index ? {} : { reply_context: { status: "parent_only",
        messages: [{ message_id: "400", author_id: "66", author: "Bystander", content: "PRIVATE_QUOTED_EVIDENCE" }] } }),
    }));
    const before = queue.pending("inbound");
    queue.close();
    const script = `
      import {Database} from "bun:sqlite";
      const root=${JSON.stringify(roots[1])};
      globalThis.fetch=Object.assign(async input=>{
        const path=new URL(String(input)).pathname;
        if(path.endsWith("/users/@me"))return Response.json({id:"88"});
        if(path.endsWith("/channels/100"))return Response.json({id:"100",type:0,guild_id:"300",parent_id:null});
        if(path.endsWith("/messages/501")){
          const db=new Database(${JSON.stringify(queuePath)});
          for(const user of ${JSON.stringify(blockSender ? ["66", "200"] : ["66"])})
            db.run("INSERT OR IGNORE INTO blocked_users(user_id,source,reason,created_by,created_at) VALUES(?,'owner','Fixture','99',0)",[user]);
          db.close();return Response.json(root);
        }
        throw new Error("Unexpected author-block request "+path);
      },{preconnect:()=>undefined});
      process.argv=[process.execPath,"ack.ts","show","inbound","500,501"];
      await import(${JSON.stringify(join(import.meta.dir, "../ack.ts"))});
    `;
    const child = Bun.spawn([process.execPath, "--eval", script], {
      env: { ...process.env, HOME: dir, DORI_POLICY_DIR: "", DORI_STATE_DIR: dir, DORI_DISCORD_TOKEN: "offline",
        DORI_DISCORD_OWNER_ID: "99", DORI_DISCORD_ALLOWED: "100", DORI_DISCORD_TRUSTED_IDS: "200",
        DORI_DISCORD_TRUSTED_CHANNELS: "", DORI_DISCORD_NORMAL_CHANNELS: "" },
      stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 15000,
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    expect(stdout).not.toContain("PRIVATE_QUOTED_EVIDENCE");
    const frames = stdout.split("\n").filter(line => line.startsWith("ACK_TURN "));
    expect(frames).toHaveLength(1);
    const frame = JSON.parse(frames.join("").slice(9));
    expect(frame.message_ids).toEqual(blockSender ? ["501"] : ["500", "501"]);
    if (blockSender) expect(stdout).not.toContain("PRIVATE_ROOT");
    queue = new Delivery(queuePath);
    expect(queue.pending("inbound")).toEqual(before);
  } finally { queue.close(); await rm(dir, { recursive: true, force: true }); }
});

test("revoking the exact bot source withholds its queued evidence and never permits irrelevance", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dori-revoked-report-"));
  try {
    const source = "1212767017917218876:100";
    expect((await invoke(dir, "inbound.ts", { bugReportSource: source, bugReports: true })).exitCode).toBe(0);
    const irrelevant = await invoke(dir, "ack.ts", {
      args: ["irrelevant", "inbound", "50", "Unrelated"], bugReportSource: source,
    });
    expect(irrelevant.exitCode).toBe(1);
    const replay = await invoke(dir, "inbound.ts");
    expect(inbound(replay.stdout).map((message) => message.message_id)).toEqual(["10"]);
    const queue = new Delivery(join(dir, "discord-delivery.sqlite"));
    try { expect(queue.status("inbound", "50").disposition).toBe("pending"); }
    finally { queue.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("watcher and ack refuse old pending work, clean its files, and preserve accepted old work", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dori-expiry-flow-"));
  const queue = new Delivery(join(dir, "discord-delivery.sqlite"));
  try {
    const old = JSON.stringify({
      message_id: "10", channel_id: "100", author_id: "99", content: "<@88> old request",
      sent_at: "2026-10-30T11:59:59Z", attention: "direct",
      role: "OWNER_REQUEST", scope: "may-request-work", channel_policy: "normal",
    });
    queue.stage("inbound", "10", old);
    queue.stage("inbound", "11", JSON.stringify({
      ...JSON.parse(old), message_id: "11", preparation_complete: true,
      discord_origin: authorizationMetadata({
        id: "11", type: 0, channel_id: "100", guild_id: "300", author: { id: "99", username: "owner" },
        content: "<@88> old request", timestamp: "2026-10-30T11:59:59Z",
      }),
    }));
    queue.accept("11", Date.parse("2026-10-30T12:00:00Z"));
    const attachment = join(dir, "attachments/inbound/pending/10/file.txt");
    await Bun.write(attachment, "expired evidence");
    const guard = await invoke(dir, "ack.ts", { args: ["check", "inbound", "10"] });
    expect(guard.exitCode).toBe(1);
    expect(guard.stdout).toBe("");
    expect(queue.status("inbound", "10").disposition).toBe("expired");
    expect(await Bun.file(attachment).exists()).toBe(false);
    const replay = await invoke(dir, "inbound.ts", { trustedChannels: "100" });
    expect(replay.exitCode).toBe(0);
    expect(inbound(replay.stdout).map((message) => message.message_id)).toEqual(["11"]);
    const retained = queue.pending("inbound").find((row) => row.id === "11");
    if (!retained) throw new Error("Missing accepted request");
    queue.recovery.review("11", retained.payload, {
      outcome: "resume", reason: "Accepted fixture work is still unfinished", evidence: "{}",
    });
    const accepted = await invoke(dir, "ack.ts", { args: ["check", "inbound", "11"], trustedChannels: "100" });
    expect({ exitCode: accepted.exitCode, stderr: accepted.stderr }).toEqual({ exitCode: 0, stderr: "" });
    expect(accepted.stdout).toBe("ACK_CHECK stream=inbound message_id=11\n");
  } finally {
    queue.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("first-run and newly added channels backfill active and archived threads with deduplication and endpoint warnings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dori-archived-flow-"));
  try {
    const first = await invoke(dir, "inbound.ts", { archived: true, trustedChannels: "100" });
    expect({ exitCode: first.exitCode, stderr: first.stderr }).toEqual({ exitCode: 0, stderr: "" });
    expect(inbound(first.stdout).map((message) => [message.message_id, message.channel_id, message.backlog]))
      .toEqual([["10", "100", true], ["20", "103", true]]);
    const warnings = first.stdout.split("\n").filter((line) => line.startsWith("INBOUND_WARN "));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("parent=100 path=/channels/100/users/@me/threads/archived/private");
    const added = await invoke(dir, "inbound.ts", { allowed: "100,600", archived: true, trustedChannels: "100" });
    expect(added.exitCode).toBe(0);
    expect(inbound(added.stdout).filter((message) => message.channel_id === "104").map((message) => message.message_id)).toEqual(["12"]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
