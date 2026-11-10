import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { dirname, join } from "node:path";
import { filterConfig } from "../intake/authorization.ts";
import type { Rest } from "../discord/rest.ts";
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
    db.exec(await Bun.file(new URL("./followups.sql", import.meta.url)).text());
    db.run(`INSERT INTO followups(repo,issue,user_id,channel_id,reply_to,kind,created_at,delivery_version,status,announcement)
      VALUES('o/r',2,'66',?,?,'bug',0,1,'announced',?)`,
      [normal, target, JSON.stringify({ event: "FOLLOWUP_DONE", issue: 2 })]);
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
      const id = await terminalNotification({ state, repo: "o/r", issue: 2, user: "66", text: "Issue #2 was resolved.",
        rest, config: () => filterConfig({ DORI_DISCORD_OWNER_ID: "99", DORI_DISCORD_ALLOWED: normal,
          DORI_DISCORD_NORMAL_CHANNELS: normal }), now: () => T0 + 120_000 });
      expect(id).toBe("9902");
      if (!beforeResponse) await ingestTerminalEcho(state, packet);
      expect({ conversations: store.list(), working: store.openWorkingRows(),
        pending: delivery.pending("inbound").map(row => row.id) }).toEqual(before);
      expect(store.transcriptOf(store.get(normal, "66", anchor)!)).toEqual([]);
      expect(delivery.status("inbound", anchor).disposition).toBe("pending");
    } finally { db.close(); }
  });
});

test("a terminal notification leaves a resolved report and a different active question untouched", async () => {
  await withStores(async (delivery, store, path) => {
    const state = dirname(path), target = idAt(T0), newer = idAt(T0 + 60_000);
    store.open(normal, "66", target, "Original report", T0);
    store.close(normal, "66", "issue", T0 + 1, "https://github.com/o/r/issues/2");
    const active = store.open(normal, "66", newer, "Different question", T0 + 60_000);
    store.applyReply(active, { disposition: "question", waiting_on: "Which match?" }, T0 + 60_001, "question");
    store.openWorking(normal, "66", newer, T0 + 60_000);
    store.claimWorking(normal, "66", newer, T0 + 60_000);
    stage(delivery, newer);
    const db = new Database(path);
    db.exec(await Bun.file(new URL("./followups.sql", import.meta.url)).text());
    db.run(`INSERT INTO followups(repo,issue,user_id,channel_id,reply_to,kind,created_at,delivery_version)
      VALUES('o/r',2,'66',?,?,'bug',0,1)`, [normal, target]);
    db.run("UPDATE followups SET status='announced',announcement=?", [JSON.stringify({ event: "FOLLOWUP_DONE", issue: 2 })]);
    const before = {
      conversations: store.list(), working: store.openWorkingRows(), pending: delivery.pending("inbound"),
    };
    const calls: string[] = [];
    const rest: Rest = async <T>(route: string, init?: Parameters<Rest>[1]) => {
      calls.push(`${init?.method ?? "GET"} ${route}`);
      if (route === `/channels/${normal}`) return { id: normal, type: 0, guild_id: "1" } as T;
      if (route === `/channels/${normal}/messages/${target}`) return { id: target, channel_id: normal, author: { id: "66" } } as T;
      if (route === `/channels/${normal}/messages` && init?.method === "POST") {
        expect(init.body).toMatchObject({ message_reference: { message_id: target, fail_if_not_exists: true },
          allowed_mentions: { parse: [], replied_user: true, users: ["66"] } });
        return { id: "9902" } as T;
      }
      throw new Error(`Unexpected notification request ${route}`);
    };
    const config = () => filterConfig({ DORI_DISCORD_OWNER_ID: "100", DORI_DISCORD_ALLOWED: normal,
      DORI_DISCORD_NORMAL_CHANNELS: normal });
    try {
      expect(await terminalNotification({ state, repo: "o/r", issue: 2, user: "66",
        text: "Issue #2 was resolved.", rest, config, now: () => T0 + 120_000 })).toBe("9902");
      expect({ conversations: store.list(), working: store.openWorkingRows(), pending: delivery.pending("inbound") })
        .toEqual(before);
      expect(calls.filter(call => call.startsWith("POST "))).toHaveLength(1);
      expect(db.query("SELECT status,delivered_reply_id FROM followups").get())
        .toEqual({ status: "done", delivered_reply_id: "9902" });
      expect(followupStatus(path, normal, "66", T0 + 120_000)).toEqual([{
        issue: "https://github.com/o/r/issues/2", subscription_state: "done",
        source_target: target, delivered_reply_id: "9902", observed_event: "FOLLOWUP_DONE",
        observation_age_seconds: null, read: "helio followups show 2",
      }]);
    } finally { db.close(); }
    expect(Bun.file(join(state, "reply-sends.sqlite")).size).toBeGreaterThan(0);
  });
});
