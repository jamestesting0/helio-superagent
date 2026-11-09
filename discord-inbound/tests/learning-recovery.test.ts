import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Delivery } from "../delivery/delivery.ts";
import { deliveryOutput } from "../fixtures/delivery-output.ts";

async function recover(mode: "recover" | "outage" | "permission" | "policy" | "policy-read" | "policy-ancestry" | "policy-pending" | "unknown") {
  const directory = await mkdtemp(join(tmpdir(), "helio-learning-recovery-"));
  try {
    const policyDirectory = join(directory, "policy");
    await mkdir(policyDirectory);
    const policyPath = join(policyDirectory, "policy.json");
    const values = { DORI_DISCORD_CONTEXT: "100", DORI_DISCORD_CONTEXT_EXCLUDED: "",
      DORI_DISCORD_IGNORED_CHANNELS: mode === "policy-ancestry" ? "999" : "" };
    if (mode.startsWith("policy")) {
      await Bun.write(policyPath, JSON.stringify({ version: 1, revision: "a".repeat(64), values }));
    }
    await Bun.write(join(directory, "discord-context.json"), '{"100":"1"}');
    const queue = new Delivery(join(directory, "discord-delivery.sqlite"));
    queue.stage("context", "5", JSON.stringify({
      message_id: "5", message_type: 0, channel_id: "100", human_verified: true,
      bot: false, author_id: "9", content: "Pending fixture",
    }));
    queue.close();
    const script = `
      import {writeFileSync} from "node:fs";
      const mode = ${JSON.stringify(mode)};
      let now = Date.parse("2026-11-09T12:00:00Z");
      Date.now = () => now;
      let round = 0, requests = 0, history = 0, metadata = 0;
      const waits = [];
      const exclude = () => writeFileSync(${JSON.stringify(policyPath)},
        JSON.stringify({version:1,revision:"b".repeat(64),values:{
          ...${JSON.stringify(values)},DORI_DISCORD_CONTEXT_EXCLUDED:"100"}}));
      process.on("exit", () => console.log("RECOVERY_PROBE " + JSON.stringify({waits, requests, history})));
      const schedule = milliseconds => {
        waits.push(milliseconds);
        now += milliseconds;
        const limit = mode === "recover" ? 3 : mode === "outage" ? 7 : mode === "policy" ? 2 : 1;
        if (waits.length >= limit) process.exit(0);
        round++;
        if (mode === "policy") exclude();
      };
      Bun.sleep = async milliseconds => {
        if (milliseconds < 30000) {
          now += milliseconds;
          if (mode === "policy-read" || mode === "policy-pending") exclude();
          return;
        }
        schedule(milliseconds);
      };
      const timer = globalThis.setTimeout;
      globalThis.setTimeout = (callback, milliseconds, ...args) => {
        if (milliseconds >= 30000) return timer(() => { schedule(milliseconds); callback(...args); }, 0);
        return timer(callback, milliseconds, ...args);
      };
      globalThis.fetch = Object.assign(async input => {
        requests++;
        if (mode === "unknown") throw new TypeError("Application defect fixture");
        if (mode === "permission") return new Response("Missing access", {status:403});
        if (mode === "outage" || (round === 0 && !mode.startsWith("policy-"))) {
          throw Object.assign(new TypeError("Temporary DNS failure"), {code:"EAI_AGAIN"});
        }
        const url = new URL(String(input));
        if (url.pathname.endsWith("/messages")) {
          history++;
          if ((mode === "policy-read" || mode === "policy-ancestry") && history === 1) {
            throw Object.assign(new TypeError("Temporary history DNS failure"), {code:"EAI_AGAIN"});
          }
          return Response.json([{
            id:"20",type:0,channel_id:"100",guild_id:"300",timestamp:"2026-11-09T12:00:00Z",
            author:{id:"9",username:"staff",bot:false},content:"Fresh fixture",attachments:[],
          }]);
        }
        metadata++;
        if (mode === "policy-pending" && metadata === 2) {
          throw Object.assign(new TypeError("Temporary replay DNS failure"), {code:"EAI_AGAIN"});
        }
        if (mode === "policy-ancestry" && history > 0) exclude();
        return Response.json({id:"100",type:0,name:"Learning",guild_id:"300",parent_id:null});
      }, {preconnect:()=>undefined});
      process.argv.push("--loop");
      await import(${JSON.stringify(join(import.meta.dir, "../context.ts"))});
    `;
    const child = Bun.spawn([process.execPath, "--eval", script], {
      env: {
        ...process.env, HOME: directory,
        DORI_POLICY_DIR: mode.startsWith("policy") ? policyDirectory : undefined,
        DORI_STATE_DIR: directory, DORI_DISCORD_TOKEN: "fixture-only", DORI_DISCORD_CONTEXT: "100",
        DORI_DISCORD_CONTEXT_EXCLUDED: "", DORI_DISCORD_ALLOWED: "", DORI_DISCORD_NORMAL_CHANNELS: "",
        DORI_DISCORD_TRUSTED_CHANNELS: "", DORI_DISCORD_IGNORED_CHANNELS: "",
      },
      stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 15_000,
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    const report = stdout.split("\n").find(line => line.startsWith("RECOVERY_PROBE "));
    if (!report) throw new Error(`Missing probe result: ${stderr}`);
    const stats: { waits: number[]; requests: number; history: number } = JSON.parse(report.slice(15));
    const checkpoint: Record<string, string> = await Bun.file(join(directory, "discord-context.json")).json();
    const reopened = new Delivery(join(directory, "discord-delivery.sqlite"));
    const pending = reopened.pending("context").map(item => item.id).sort();
    reopened.close();
    return { stdout: deliveryOutput(directory, stdout), stderr, exitCode, stats, checkpoint, pending };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test("an incomplete scan recovers promptly, learns once and resumes normal cadence", async () => {
  const result = await recover("recover");
  expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({ exitCode: 0, stderr: "" });
  expect(result.stats.waits).toEqual([30_000, 1_800_000, 1_800_000]);
  expect(result.checkpoint).toEqual({ "100": "20" });
  expect(result.pending).toEqual(["20", "5"]);
  const messages: { message_id: string }[] = result.stdout.split("\n")
    .filter(line => line.startsWith("CONTEXT ")).map(line => JSON.parse(line.slice(8)));
  expect(messages.map(message => message.message_id)).toEqual(["5", "20"]);
  expect(result.stdout.split("\n").filter(line => line.startsWith("CONTEXT_RECOVERED "))).toHaveLength(1);
});

test("a sustained DNS outage caps backoff, preserves work and suppresses repeated warnings", async () => {
  const result = await recover("outage");
  expect(result.exitCode).toBe(0);
  expect(result.stats.waits).toEqual([30_000, 60_000, 120_000, 240_000, 300_000, 300_000, 300_000]);
  expect(result.checkpoint).toEqual({ "100": "1" });
  expect(result.pending).toEqual(["5"]);
  expect(result.stdout.split("\n").filter(line => line.startsWith("CONTEXT_WARN "))).toHaveLength(1);
  expect(result.stdout.split("\n").filter(line => line.startsWith("CONTEXT_DONE "))).toHaveLength(1);
});

test("a permission refusal retains work without fast retries", async () => {
  const result = await recover("permission");
  expect(result.exitCode).toBe(0);
  expect(result.stats.waits).toEqual([1_800_000]);
  expect(result.stats.requests).toBe(1);
  expect(result.pending).toEqual(["5"]);
  expect(result.checkpoint).toEqual({ "100": "1" });
});

test("a policy change during recovery withholds newly excluded content", async () => {
  const result = await recover("policy");
  expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({ exitCode: 0, stderr: "" });
  expect(result.stats.waits).toEqual([30_000, 1_800_000]);
  expect(result.stats.history).toBe(0);
  expect(result.pending).toEqual(["5"]);
  expect(result.stdout.split("\n").filter(line => line.startsWith("CONTEXT "))).toEqual([]);
});

test.each(["policy-read", "policy-ancestry"] as const)(
  "a policy revocation during a history retry prevents another content request: %s", async mode => {
  const result = await recover(mode);
  expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({ exitCode: 0, stderr: "" });
  expect(result.stats.history).toBe(1);
  expect(result.pending).toEqual(["5"]);
});

test("policy cancellation during pending replay rescans without stopping the learning loop", async () => {
  const result = await recover("policy-pending");
  expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({ exitCode: 0, stderr: "" });
  expect(result.stats.history).toBe(0);
  expect(result.pending).toEqual(["5"]);
  expect(result.stats.waits).toEqual([1_800_000]);
});

test("an unclassified application failure remains visible instead of becoming partial coverage", async () => {
  const result = await recover("unknown");
  expect(result.exitCode).toBe(1);
  expect(result.stats.waits).toEqual([]);
  expect(result.stderr).toContain("Application defect fixture");
  expect(result.pending).toEqual(["5"]);
});
