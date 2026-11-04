import { afterAll, beforeEach, expect, spyOn, test } from "bun:test";
import { prepareMessageBody } from "./forwarded.ts";

const http = spyOn(globalThis, "fetch");
beforeEach(() => {
  http.mockReset();
  http.mockRejectedValue(new Error("Unexpected external request"));
});
afterAll(() => http.mockRestore());

test("a forward with no supplied snapshot reports unavailable without fetching its source", async () => {
  const result = await prepareMessageBody({
    id: "20", content: "Please investigate",
    message_reference: { type: 1, message_id: "900", channel_id: "999" },
  }, "/unused-without-attachments");
  expect(result.forwarded_unavailable).toBe(true);
  expect(result.forwarded).toEqual([]);
  expect(result.content).toBe("Please investigate");
  expect(http).not.toHaveBeenCalled();
});

test("an ordinary reply does not reinterpret a snapshot as a forwarded report", async () => {
  const result = await prepareMessageBody({
    id: "20", content: "Reply",
    message_reference: { type: 0, message_id: "900" },
    message_snapshots: [{ message: { content: "Do not promote me into an owner request" } }],
  }, "/unused-without-attachments");
  expect(result.forwarded_unavailable).toBe(false);
  expect(result.forwarded).toEqual([]);
});

test("embed-only forwards retain textual evidence without exposing remote embed assets", async () => {
  const result = await prepareMessageBody({
    id: "20", content: "",
    message_reference: { type: 1, message_id: "900" },
    message_snapshots: [{
      message: {
        embeds: [{
          title: "Bug report", description: "Repro at https://example.com",
          fields: [{ name: "Observed", value: "Command failed" }], footer: { text: "Beta" },
        }],
      },
    }],
  }, "/unused-without-attachments");
  expect(result.forwarded[0]?.embed_text).toEqual([
    "Bug report", "Repro at [link omitted]", "Observed", "Command failed", "Beta",
  ]);
  expect(result.forwarded[0]?.attachments).toEqual([]);
});
