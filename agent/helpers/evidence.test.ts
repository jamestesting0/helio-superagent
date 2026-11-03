import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkFiles, parseArgs, route } from "./evidence.ts";

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
  expect(parseArgs(["1", "2", "--text-file", "t", "--owner-only", "a.png"])).toEqual({ channel: "1", message: "2", textFile: "t", ownerOnly: true, files: ["a.png"] });
  expect(parseArgs(["1", "2", "a.png"])).toBeUndefined();
});
