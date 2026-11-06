import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Delivery } from "../delivery/delivery.ts";
import { Conversations } from "../conversations/conversations.ts";
import { ReplySettlements } from "../conversations/reply-settlement.ts";
import { sendOnce } from "../conversations/reply-once.ts";

const now = Date.parse("2026-11-06T12:00:00Z");
const payload = JSON.stringify({ message_id: "10", channel_id: "100", author_id: "99",
  content: "title", sent_at: new Date(now).toISOString(), discord_origin: { message_type: 4 } });
const env = { ...process.env, DORI_DISCORD_TOKEN: undefined, DORI_DISCORD_OWNER_ID: "99",
  DORI_DISCORD_ALLOWED: "100", DORI_DISCORD_IGNORED_CHANNELS: "100", DORI_DISCORD_TRUSTED_CHANNELS: "",
  DORI_DISCORD_NORMAL_CHANNELS: "", DORI_DISCORD_TRUSTED_IDS: "", DORI_DISCORD_REPORT_CHANNELS: "",
  DORI_DISCORD_BUG_REPORT_SOURCE: undefined, DORI_DISCORD_SCOPE_CATEGORY: "" };

async function invoke(state: string, ...args: string[]) {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../recovery.ts"), ...args], {
    env: { ...env, DORI_STATE_DIR: state }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  return { stdout, stderr, code };
}

test("preview writes only its manifest; apply settles exact ignored input once and preserves accepted changes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "helio-reconcile-input-"));
  const path = join(dir, "discord-delivery.sqlite"), manifest = join(dir, "manifest.json");
  const queue = new Delivery(path);
  try {
    queue.stage("inbound", "10", payload);
    queue.stage("inbound", "11", payload);
    await chmod(path, 0o640);
    const before = queue.pending("inbound");
    const preview = await invoke(dir, "preview", manifest, "--messages", "10,11");
    expect(preview.code, preview.stdout + preview.stderr).toBe(0);
    expect(queue.pending("inbound")).toEqual(before);
    expect((await stat(path)).mode & 0o777).toBe(0o640);
    const plan = await Bun.file(manifest).json();
    expect(plan.messages.map((row: { id: string; action: string }) => [row.id, row.action]))
      .toEqual([["10", "ignore"], ["11", "ignore"]]);
    queue.accept("11", now);
    const applied = await invoke(dir, "apply", manifest);
    expect(applied.stdout).toContain("message_id=10 outcome=ignored");
    expect(applied.stdout).toContain("message_id=11 outcome=changed");
    expect(queue.status("inbound", "10").disposition).toBe("ignored");
    expect(queue.status("inbound", "11").disposition).toBe("accepted");
    const again = await invoke(dir, "apply", manifest);
    expect(again.stdout).toContain("message_id=10 outcome=already-applied");
    expect(queue.pending("inbound").map(row => row.id)).toEqual(["11"]);
  } finally { queue.close(); await rm(dir, { recursive: true }); }
});

test.each([
  { known: true, question: false }, { known: false, question: false }, { known: true, question: true },
])("notice repair preserves current meaning, history and holds (%j)", async ({ known, question }) => {
  const dir = await mkdtemp(join(tmpdir(), "helio-reconcile-topic-"));
  const store = new Conversations(join(dir, "discord-conversations.sqlite"));
  const queue = new Delivery(join(dir, "discord-delivery.sqlite"));
  const manifest = join(dir, "manifest.json");
  try {
    store.open("100", "99", "20", "mixed history", now);
    for (const id of ["30", "31"]) store.append("100", "99", {
      message_id: id, author_id: "88", author: "Helio", bot: id === "31" || known, content: "old bot entry",
      attachment_count: 0, reply_to: "20", sent_at: new Date(now + (id === "31" ? 2 : 1)).toISOString(),
    }, now + (id === "31" ? 2 : 1));
    // Historical contamination predates ingress exclusion.
    store.recordNotice("31", now + 2);
    if (question) store.applyReply(store.get("100", "99")!, {
      disposition: "question", waiting_on: "Which server?",
    }, now + 3, "question-current");
    const preview = await invoke(dir, "preview", manifest, "--topics", "100:99:20", "--notices", "30,31");
    expect(preview.code, preview.stdout + preview.stderr).toBe(0);
    expect(store.transcript("100", "99").map(row => row.message_id)).toEqual(["30", "31"]);
    const applied = await invoke(dir, "apply", manifest);
    expect(applied.code, applied.stdout + applied.stderr).toBe(0);
    expect(store.transcript("100", "99").map(row => row.message_id)).toEqual(["30"]);
    expect(store.get("100", "99")?.status).toBe("open");
    expect(store.get("100", "99")?.question_started_at).toBe(question ? now + 3 : null);
    expect(store.get("100", "99")?.reply_disposition).toBe(question ? "question" : null);
    expect(store.get("100", "99")?.last_activity).toBe(now + (known ? 1 : 2));
    expect((await invoke(dir, "apply", manifest)).stdout).toContain("outcome=already-applied");
    const next = join(dir, "next.json");
    expect((await invoke(dir, "preview", next, "--topics", "100:99:20", "--notices", "30")).code).toBe(0);
    store.hold("100", "99", "Owner decision", "20");
    expect((await invoke(dir, "apply", next)).stdout).toContain("outcome=changed");
    expect(store.get("100", "99")?.hold_reason).toBe("Owner decision");
    const db = new Database(join(dir, "discord-conversations.sqlite"), { readonly: true });
    try { expect(db.query("SELECT * FROM conversation_notices WHERE message_id='31'").get()).not.toBeNull(); }
    finally { db.close(); }
  } finally { queue.close(); store.dispose(); await rm(dir, { recursive: true }); }
});

test("a proven delivered final resumes local fulfillment without another send; a legacy reply alone does not close a topic", async () => {
  const dir = await mkdtemp(join(tmpdir(), "helio-reconcile-final-"));
  const store = new Conversations(join(dir, "discord-conversations.sqlite"));
  const queue = new Delivery(join(dir, "discord-delivery.sqlite"));
  const path = join(dir, "reply-sends.sqlite"), receipts = new ReplySettlements(path);
  let posts = 0;
  try {
    const row = store.open("100", "99", "10", "request", now);
    receipts.prepare("100:10:completion", [{ ...row, covered: ["10"] }], { disposition: "final" },
      [{ target: "10", event: "100:completion" }]);
    await sendOnce({ path, target: "10", event: "100:completion", text: "Done", now: () => now,
      sleep: async () => {}, send: async () => { posts++; return "900"; }, findSent: async () => undefined });
    const manifest = join(dir, "final.json");
    expect((await invoke(dir, "preview", manifest, "--topics", "100:99:10", "--answered", "10:900")).code).toBe(0);
    expect(store.get("100", "99")?.status).toBe("open");
    const applied = await invoke(dir, "apply", manifest);
    expect(applied.code, applied.stdout + applied.stderr).toBe(0);
    expect(applied.stdout).toContain("outcome=final-settled");
    expect(store.byAnchor("100", "99", "10")?.status).toBe("resolved");
    expect((await invoke(dir, "apply", manifest)).stdout).toContain("outcome=already-applied");
    expect(posts).toBe(1);
    store.open("100", "99", "20", "mixed legacy topic", now + 1);
    await sendOnce({ path, target: "20", event: "100:completion", text: "Old reply", now: () => now,
      sleep: async () => {}, send: async () => { posts++; return "901"; }, findSent: async () => undefined });
    const legacy = join(dir, "legacy.json");
    expect((await invoke(dir, "preview", legacy, "--topics", "100:99:20", "--answered", "20:901")).code).toBe(0);
    expect((await invoke(dir, "apply", legacy)).stdout).toContain("outcome=preserved");
    expect(store.get("100", "99", "20")?.status).toBe("open");
    expect(posts).toBe(2);
  } finally { receipts.close(); queue.close(); store.dispose(); await rm(dir, { recursive: true }); }
});
