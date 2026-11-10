import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { dirname, join } from "node:path";
import { filterConfig } from "../intake/authorization.ts";
import { DiscordRestError, type Rest } from "../discord/rest.ts";
import { idAt, normal, stage, T0, withStores } from "../fixtures/working.ts";
import { terminalNotification } from "./terminal-notification.ts";
import { followupStatus } from "./followup-status.ts";

async function ingestTerminalEcho(state: string, packet: Record<string, unknown>) {
  const script = `
    import {Listener} from ${JSON.stringify(new URL("../fixtures/discord-client.ts", import.meta.url).pathname)};
    const packet=${JSON.stringify(packet)}, original=globalThis.fetch;
    Date.now=()=>${T0 + 120_000};
    Listener.prototype.start=async function(){
      this.emit("connected",{user:{id:"88",username:"Helio"},sessionId:"terminal-echo"});
      this.message(packet);
    };
    globalThis.fetch=Object.assign(async(input,init)=>{
      const path=new URL(String(input)).pathname;
      if(path==="/api/v10/channels/"+packet.channel_id)
        return Response.json({id:packet.channel_id,type:0,guild_id:"300",parent_id:null});
      if(path==="/api/v10/guilds/300/channels")
        return Response.json([{id:packet.channel_id,type:0,guild_id:"300",parent_id:null}]);
      if(path==="/api/v10/channels/"+packet.channel_id+"/messages")return Response.json([]);
      if(path.includes("/reactions/"))return new Response(null,{status:204});
      return original(input,init);
    },{preconnect:original.preconnect});
    process.argv=[process.execPath,"inbound.ts"];
    await import(${JSON.stringify(new URL("../inbound.ts", import.meta.url).pathname)});
  `;
  const child = Bun.spawn([process.execPath, "--preload", new URL("../fixtures/discord.ts", import.meta.url).pathname,
    "--eval", script], {
    env: { ...process.env, HOME: state, DORI_POLICY_DIR: "", DORI_STATE_DIR: state,
      DORI_DISCORD_TOKEN: "offline", DORI_DISCORD_OWNER_ID: "99", DORI_DISCORD_ALLOWED: normal,
      DORI_DISCORD_NORMAL_CHANNELS: normal, DORI_DISCORD_TRUSTED_CHANNELS: "", DORI_DISCORD_TRUSTED_IDS: "",
      DORI_DISCORD_REPORT_CHANNELS: "", DORI_DISCORD_IGNORED_CHANNELS: "", DORI_DISCORD_SCOPE_CATEGORY: "",
      DORI_DISCORD_BUG_REPORT_SOURCE: undefined },
    stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 15000,
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect(code, stderr).toBe(0);
  expect(stdout).toContain("INBOUND_READY");
}

test.each([
  { resolvedOriginal: false, beforeResponse: false }, { resolvedOriginal: false, beforeResponse: true },
  { resolvedOriginal: true, beforeResponse: false }, { resolvedOriginal: true, beforeResponse: true },
])("terminal gateway echo preserves active questions and claims: %j", async ({ resolvedOriginal, beforeResponse }) => {
  await withStores(async (delivery, store, path) => {
    const state = dirname(path), target = idAt(T0), newer = idAt(T0 + 60_000);
    store.open(normal, "66", target, "Original report", T0);
    if (resolvedOriginal) {
      store.close(normal, "66", "issue", T0 + 1, "https://github.com/o/r/issues/2");
      store.open(normal, "66", newer, "Different question", T0 + 60_000);
    }
    const anchor = resolvedOriginal ? newer : target;
    store.setState(normal, "66", { request: "A report awaiting clarification" }, anchor);
    store.applyReply(store.get(normal, "66", anchor)!, { disposition: "question", waiting_on: "Which server?" },
      T0 + 60_001, "question");
    store.openWorking(normal, "66", anchor, T0 + 60_000);
    store.claimWorking(normal, "66", anchor, T0 + 60_000);
    store.setReacted(anchor, true);
    stage(delivery, anchor);
    const before = { conversations: store.list(), working: store.openWorkingRows(),
      pending: delivery.pending("inbound").map(row => row.id) };
    const db = new Database(path);
    db.run(`INSERT INTO followups(repo,issue,anchor_message_id,kind,created_at,status,announcement)
      VALUES('o/r',2,?,'bug',0,'announced',?)`, [target, JSON.stringify({ event: "FOLLOWUP_DONE", issue: 2 })]);
    let packet: Record<string, unknown> = {};
    const rest: Rest = async <T>(route: string, init?: Parameters<Rest>[1]) => {
      if (route === `/channels/${normal}`) return { id: normal, type: 0, guild_id: "300" } as T;
      if (route === `/channels/${normal}/messages/${target}`) return { id: target, channel_id: normal, author: { id: "66" } } as T;
      if (route === `/channels/${normal}/messages` && init?.method === "POST") {
        const body = init.body as { nonce?: string; content: string; message_reference: unknown };
        packet = { id: "9902", type: 19, channel_id: normal, guild_id: "300", author: { id: "88", bot: true },
          content: body.content, message_reference: body.message_reference, timestamp: new Date(T0 + 120_000).toISOString(),
          ...(beforeResponse && body.nonce ? { nonce: body.nonce } : {}) };
        if (beforeResponse) await ingestTerminalEcho(state, packet);
        return { id: "9902" } as T;
      }
      throw new Error(`Unexpected terminal echo route ${route}`);
    };
    try {
      const outcomes = await terminalNotification({ state, repo: "o/r", issue: 2, topic: target, text: "Issue #2 was resolved.",
        rest, config: () => filterConfig({ DORI_DISCORD_OWNER_ID: "99", DORI_DISCORD_ALLOWED: normal,
          DORI_DISCORD_NORMAL_CHANNELS: normal }), now: () => T0 + 120_000 });
      expect(outcomes).toEqual([{ channel_id: normal, disposition: "sent", reply_id: "9902" }]);
      if (!beforeResponse) await ingestTerminalEcho(state, packet);
      expect({ conversations: store.list(), working: store.openWorkingRows(),
        pending: delivery.pending("inbound").map(row => row.id) }).toEqual(before);
      expect(store.transcriptOf(store.get(normal, "66", anchor)!)).toEqual([]);
      expect(delivery.status("inbound", anchor).disposition).toBe("pending");
    } finally { db.close(); }
  });
});

test("participants hear the outcome once per channel, with the rest mentioned, and a retry posts nothing", async () => {
  await withStores(async (_delivery, store, path) => {
    const state = dirname(path), other = `${normal.slice(0, -3)}777`;
    const anchor = idAt(T0), second = idAt(T0 + 1000), elsewhere = idAt(T0 + 2000);
    store.open(normal, "66", anchor, "Queue stuck", T0);
    store.join(anchor, "77", "answered", normal, second, T0 + 1000);
    store.join(anchor, "55", "answered", other, elsewhere, T0 + 2000);
    store.close(normal, "66", "issue", T0 + 3000, "https://github.com/o/r/issues/2");
    const db = new Database(path);
    db.run(`INSERT INTO followups(repo,issue,anchor_message_id,kind,created_at,status,announcement)
      VALUES('o/r',2,?,'bug',0,'announced',?)`, [anchor, JSON.stringify({ event: "FOLLOWUP_LIVE", issue: 2 })]);
    const authors: Record<string, string> = { [second]: "77", [elsewhere]: "55" };
    const posts: { channel: string; body: { content: string; message_reference: { message_id: string };
      allowed_mentions: { replied_user: boolean; users: string[] } } }[] = [];
    const rest: Rest = async <T>(route: string, init?: Parameters<Rest>[1]) => {
      const channel = /^\/channels\/(\d+)/.exec(route)?.[1] ?? "";
      if (route === `/channels/${channel}`) return { id: channel, type: 0, guild_id: "300" } as T;
      const read = /\/messages\/(\d+)$/.exec(route)?.[1];
      if (read && authors[read]) return { id: read, channel_id: channel, author: { id: authors[read] } } as T;
      if (route === `/channels/${channel}/messages` && init?.method === "POST") {
        posts.push({ channel, body: init.body as never });
        return { id: String(9900 + posts.length) } as T;
      }
      throw new Error(`Unexpected notification request ${route}`);
    };
    const notify = () => terminalNotification({ state, repo: "o/r", issue: 2, topic: anchor, text: "Issue #2: the fix is live.",
      rest, config: () => filterConfig({ DORI_DISCORD_OWNER_ID: "99", DORI_DISCORD_ALLOWED: `${normal},${other}`,
        DORI_DISCORD_NORMAL_CHANNELS: `${normal},${other}` }), now: () => T0 + 120_000 });
    try {
      expect(await notify()).toEqual([
        { channel_id: normal, disposition: "sent" as const, reply_id: "9901" }, { channel_id: other, disposition: "sent" as const, reply_id: "9902" },
      ].sort((a, b) => a.channel_id.localeCompare(b.channel_id)));
      const here = posts.find(post => post.channel === normal)!, there = posts.find(post => post.channel === other)!;
      // The newest message in each channel is the target; everyone else there is mentioned.
      expect([here.body.message_reference.message_id, here.body.content, here.body.allowed_mentions])
        .toEqual([second, "<@66> Issue #2: the fix is live.", expect.objectContaining({ replied_user: true, users: ["66"] })]);
      expect([there.body.message_reference.message_id, there.body.content]).toEqual([elsewhere, "Issue #2: the fix is live."]);
      expect(db.query("SELECT status FROM followups").get()).toEqual({ status: "done" });
      await notify();
      expect(posts).toHaveLength(2);
      expect(followupStatus(path, anchor, T0 + 120_000)[0]?.deliveries.map(group => group.disposition)).toEqual(["sent", "sent"]);
    } finally { db.close(); }
  });
});

test("a deleted newest message falls back to the group's earlier one, and a muted person is not pinged", async () => {
  await withStores(async (_delivery, store, path) => {
    const anchor = idAt(T0), gone = idAt(T0 + 1000), muted = idAt(T0 + 500);
    store.open(normal, "66", anchor, "Queue stuck", T0);
    store.join(anchor, "77", "answered", normal, gone, T0 + 1000);
    store.join(anchor, "78", "answered", normal, muted, T0 + 500);
    store.leave(anchor, "78");
    const db = new Database(path);
    db.run(`INSERT INTO followups(repo,issue,anchor_message_id,kind,created_at,status,announcement)
      VALUES('o/r',2,?,'bug',0,'announced',?)`, [anchor, JSON.stringify({ event: "FOLLOWUP_DONE", issue: 2 })]);
    const posts: { message_reference: { message_id: string }; allowed_mentions: { users: string[]; replied_user: boolean } }[] = [];
    const rest: Rest = async <T>(route: string, init?: Parameters<Rest>[1]) => {
      if (route === `/channels/${normal}`) return { id: normal, type: 0, guild_id: "300" } as T;
      if (route.endsWith(`/messages/${gone}`)) throw new DiscordRestError(404, "GET", route, '{"code":10008}');
      if (route.endsWith(`/messages/${anchor}`)) return { id: anchor, channel_id: normal, author: { id: "66" } } as T;
      if (route.endsWith(`/messages/${muted}`)) return { id: muted, channel_id: normal, author: { id: "78" } } as T;
      if (init?.method === "POST") { posts.push(init.body as never); return { id: "9902" } as T; }
      throw new Error(`Unexpected ${route}`);
    };
    try {
      const outcomes = await terminalNotification({ state: dirname(path), repo: "o/r", issue: 2, topic: anchor, text: "Issue #2 was resolved.",
        rest, config: () => filterConfig({ DORI_DISCORD_OWNER_ID: "99", DORI_DISCORD_ALLOWED: normal, DORI_DISCORD_NORMAL_CHANNELS: normal }),
        now: () => T0 + 120_000 });
      expect(outcomes).toEqual([{ channel_id: normal, disposition: "sent", reply_id: "9902" }]);
      // 78's message is newer than the anchor but 78 left, so the reply goes to the anchor and pings 77, never 78.
      expect(posts.map(post => [post.message_reference.message_id, post.allowed_mentions.users, post.allowed_mentions.replied_user]))
        .toEqual([[anchor, ["77"], true]]);
    } finally { db.close(); }
  });
});
