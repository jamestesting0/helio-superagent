import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkFiles, parseArgs, route } from "./evidence.ts";

test("redirected results link names intake knows only while the owner copy and its request footer fit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "evidence-people-"));
  const channel = "123456789012345678", requests = ["234567890123456781", "234567890123456782"];
  try {
    const { Delivery } = await import(new URL("../discord-inbound/delivery/delivery.ts", import.meta.url).href);
    const delivery = new Delivery(join(dir, "discord-delivery.sqlite"));
    for (const id of requests) delivery.stage("inbound", id, JSON.stringify({ message_id: id, channel_id: channel,
      author_id: "66", author: "James", role: "NORMAL_REQUEST", content: "test it", sent_at: new Date().toISOString() }));
    delivery.close();
    const preload = join(dir, "offline.ts");
    await writeFile(preload, `globalThis.fetch=async(input,init)=>{
      const url=String(input),method=init?.method??"GET";
      if(method==="POST"&&url.endsWith("/users/@me/channels"))return Response.json({id:"345678901234567899"});
      if(method==="POST"&&url.endsWith("/messages")){
        console.log((url.includes("345678901234567899")?"OWNER_BODY ":"NOTE_BODY ")+(init.body instanceof FormData?init.body.get("payload_json"):init.body));
        return Response.json({id:"345678901234567890"});
      }
      if(url.endsWith("/channels/${channel}"))return Response.json({id:"${channel}",type:0,guild_id:"99999"});
      const id=url.split("/").at(-1);
      if(${JSON.stringify(requests)}.includes(id))return Response.json({id,channel_id:"${channel}",guild_id:"99999",author:{id:"66"},content:"test it"});
      throw new Error("Unexpected offline request: "+method+" "+url);
    };`);
    const deliver = async (request: string, text: string) => {
      const file = join(dir, `${request}.txt`);
      await writeFile(file, text);
      const child = Bun.spawn([process.execPath, "--preload", preload, new URL("./evidence.ts", import.meta.url).pathname,
        channel, request, "--text-file", file], {
        env: { ...process.env, HOME: dir, DORI_DISCORD_TOKEN: "offline", DORI_DISCORD_OWNER_ID: "99", DORI_STATE_DIR: dir,
          DORI_POLICY_DIR: "", DORI_DISCORD_ALLOWED: channel, DORI_DISCORD_TRUSTED_IDS: "", DORI_DISCORD_TRUSTED_CHANNELS: "",
          DORI_DISCORD_NORMAL_CHANNELS: channel, DORI_DISCORD_IGNORED_CHANNELS: "", DORI_DISCORD_SCOPE_CATEGORY: "",
          DORI_DISCORD_REPORT_CHANNELS: "" },
        stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 15000,
      });
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
      return JSON.parse(stdout.split("\n").find(line => line.startsWith("OWNER_BODY "))?.slice("OWNER_BODY ".length) ?? "null").content as string;
    };
    const footer = (request: string) => `\n\nRequest: <https://discord.com/channels/99999/${channel}/${request}>`;
    expect(await deliver(requests[0]!, "Tested for James."))
      .toBe(`Tested for **[James](<https://discord.com/users/66?tab=wishlist>)**.${footer(requests[0]!)}`);
    const crowded = `For James: ${"x".repeat(1880)}`;
    expect(await deliver(requests[1]!, crowded)).toBe(`${crowded}${footer(requests[1]!)}`);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

const opts = (requester: string, ownerOnly = false) => ({ ownerOnly, requester, owner: "99", trusted: new Set(["77"]) });

test("results go back where the request came from, except normal chats and owner-only content", () => {
  expect(route({ kind: "trusted" }, opts("77"))).toEqual({ send: "in-place" });
  expect(route({ kind: "dm" }, opts("77"))).toEqual({ send: "in-place" });
  expect(route({ kind: "dm" }, opts("99"))).toEqual({ send: "in-place" });
  expect(route({ kind: "normal" }, opts("77"))).toEqual({ send: "owner-dm", forwardTo: "77", noteInPlace: true });
  expect(route({ kind: "normal" }, opts("99"))).toEqual({ send: "owner-dm", noteInPlace: true });
  expect(route({ kind: "normal" }, opts("66"))).toEqual({ send: "owner-dm", noteInPlace: true });
  expect(route({ kind: "trusted" }, opts("77", true))).toEqual({ send: "owner-dm", noteInPlace: true });
  expect(route({ kind: "dm" }, opts("99", true))).toEqual({ send: "owner-dm", noteInPlace: false });
});

test("only real screenshot files are sent, and text must come from a file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "evidence-"));
  try {
    const png = join(dir, "a.png"), txt = join(dir, "a.txt");
    await writeFile(png, "x"); await writeFile(txt, "x");
    expect(await checkFiles([png])).toBeUndefined();
    expect(await checkFiles([txt])).toContain("only PNG");
    expect(await checkFiles([join(dir, "missing.png")])).toContain("not a regular file");
    expect(await checkFiles(Array(11).fill(png))).toContain("at most 10");
  } finally { await rm(dir, { recursive: true, force: true }); }
  expect(parseArgs(["1", "2", "--text-file", "t", "--owner-only", "a.png"])).toEqual({ channel: "1", message: "2", textFile: "t", ownerOnly: true, files: ["a.png"], event: "completion" });
  expect(parseArgs(["1", "2", "a.png"])).toBeUndefined();
});
