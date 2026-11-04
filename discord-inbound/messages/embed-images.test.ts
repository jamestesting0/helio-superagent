import { afterAll, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { prepareMessageBody } from "./forwarded.ts";

const boundary: { fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response> } = globalThis;
const http = spyOn(boundary, "fetch");
const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: "#00ff00" } }).png().toBuffer();
beforeEach(() => http.mockReset());
afterAll(() => http.mockRestore());

test("Discord-hosted embed images are downloaded like attachments; other image hosts are never contacted", async () => {
  const root = await mkdtemp(join(tmpdir(), "dori-embed-images-"));
  const requested: string[] = [];
  http.mockImplementation(async (input) => {
    requested.push(String(input));
    return new Response(png, { headers: { "content-type": "image/png", "content-length": String(png.length) } });
  });
  try {
    const embeds = [{ type: "rich", title: "Base", image: { url: "https://cdn.discordapp.com/attachments/11/22/base.png?ex=1" },
      thumbnail: { url: "https://api-assets.clashofclans.com/badges/x.png" } }];
    const body = await prepareMessageBody({
      id: "500", content: "", embeds,
      message_reference: { type: 1, message_id: "1" }, message_snapshots: [{ message: { content: "", embeds } }],
    }, root);
    expect(requested.every((url) => url.startsWith("https://cdn.discordapp.com/attachments/11/22/base.png"))).toBe(true);
    expect(requested.length).toBe(2);
    expect(body.attachments.map((file) => [file.name, file.kind])).toEqual([["base.png", "image"]]);
    expect(body.blocked_attachments).toEqual([]);
    expect(body.forwarded[0]?.attachments.map((file) => file.name)).toEqual(["base.png"]);
    expect(body.forwarded[0]?.embed_text).toEqual(["Base", "[embed image]"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
