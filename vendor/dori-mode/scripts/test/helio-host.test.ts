import { expect, test } from "bun:test";
import { homedir } from "node:os";

import { sampleHost } from "../src/host-guard.ts";
import { Discord } from "../src/messenger/discord.ts";
import type { HttpRequest } from "../src/messenger/http.ts";
import type { Ran } from "../src/run.ts";
import { fakeClock } from "./fakes.ts";

test("disk free is measured where lanes live, not at a sandbox's in-memory root", async () => {
  const calls: string[][] = [];
  const run = async (argv: readonly string[]): Promise<Ran> => {
    calls.push([...argv]);
    if (argv[0] === "df") return { code: 0, out: "Filesystem 1K-blocks Used Available\n/dev/sdd 100 50 52428800", err: "" };
    return { code: 1, out: "", err: "" };
  };
  const sample = await sampleHost(run);
  expect(calls.find((argv) => argv[0] === "df")).toEqual(["df", "-k", homedir()]);
  expect(sample.diskFreeGb).toBe(50);
});

test("a Discord DM to a user opens the DM channel first, then posts there without pings", async () => {
  const seen: HttpRequest[] = [];
  const http = async (req: HttpRequest) => {
    seen.push(req);
    return { status: 200, headers: {}, body: JSON.stringify({ id: req.url.endsWith("/users/@me/channels") ? "dm-1" : "msg-1" }) };
  };
  const dc = new Discord(http, fakeClock(0), "token");
  const channel = await dc.openDm("653894110884921366");
  expect(await dc.send(channel, "hello")).toBe("msg-1");
  expect(seen.map((req) => [req.method, req.url.replace("https://discord.com/api/v10", "")])).toEqual([
    ["POST", "/users/@me/channels"],
    ["POST", "/channels/dm-1/messages"],
  ]);
  expect(JSON.parse(String(seen[0]!.body))).toEqual({ recipient_id: "653894110884921366" });
  expect(JSON.parse(String(seen[1]!.body)).allowed_mentions).toEqual({ parse: [] });
});
