import { onTestFinished } from "bun:test";
import { createServer, type Server } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Controller } from "../controller.ts";
import { Panels } from "../panels.ts";
import { object, type AdminPolicy, type AdminRecord } from "../protocol.ts";

export async function fixture(dm = false) {
  const original = process.env.HELIO_ADMIN_SOCKET;
  const home = mkdtempSync(join(tmpdir(), "helio-admin-panel-"));
  const path = join(home, "admin.sock");
  process.env.HELIO_ADMIN_SOCKET = path;
  let trusted = "11111";
  let records: AdminRecord[] = Array.from({ length: 19 }, (_, index) => ({
    id: `topic-${index}`, title: `Topic ${index}`, summary: "Waiting on Helio", state: "waiting_on_helio",
    revision: "1", fields: [{ name: "Request", value: `Request ${index}` }],
  }));
  const policy: AdminPolicy = { version: 1, revision: "a".repeat(64),
    values: { DORI_DISCORD_OWNER_ID: "22222", HELIO_TRUSTED_USERS: trusted, HELIO_ADMIN_GUILD: "99999" }, timing: [] };
  let mutations = 0;
  let configurationChanges = 0;
  let readFailure = false;
  let uncertain = false;
  let settled: "done" | "refused" | undefined;
  let refusal = false;
  let malformed = false;
  const submissions: Record<string, unknown>[] = [];
  const requests: Record<string, unknown>[] = [];
  let probes = 0;
  let unavailable: "policy" | "runtime" | "list" | "conversations" | undefined;
  let readDelay = 0;
  const server: Server = createServer(socket => {
    let input = Buffer.alloc(0);
    socket.on("data", chunk => {
      input = Buffer.concat([input, typeof chunk === "string" ? Buffer.from(chunk) : chunk]);
      if (input.length < 4 || input.length < input.readUInt32BE(0) + 4) return;
      const request = object(JSON.parse(input.subarray(4).toString()));
      requests.push(request);
      let response: unknown = { ...policy, values: { ...policy.values, HELIO_TRUSTED_USERS: trusted } };
      if (request.kind === "runtime") {
        const query = object(request.query);
        if (query.kind === "mutate") { mutations += 1; submissions.push(request); response = malformed ? { records: null } : { records: [], notice: "Changed" }; }
        else if (query.kind === "probe") {
          probes += 1;
          response = { records: [{ id: "github", title: "GitHub", summary: "Timestamped observation", revision: String(probes),
            fields: Array.from({ length: 9 }, (_, index) => ({ name: `Evidence ${index}`, value: `Observation ${probes}:${index}` })) }] };
        } else if (query.section === "settings") {
          response = { records: [{ id: "github", title: "GitHub", summary: "Check access", revision: "1",
            fields: [{ name: "Access", value: "Use Check GitHub for a fresh probe" }] }] };
        } else if (query.section === "channels") {
          response = { records: [{ id: "55555", channel: "55555", title: "Server room", state: "normal",
            summary: "Configured channel", revision: "1" }] };
        }
        else response = { records: query.target ? records.filter(row => row.id === query.target) : records, revision: policy.revision };
      }
      if (request.kind === "configure") {
        configurationChanges += 1;
        response = { application: "Saved; consumer application pending" };
      }
      if (request.kind === "operation") response = settled ?
        { status: settled, result: settled === "done" ? { records: [], notice: "Change committed", operation: request.operation } :
          { error: "Target changed before commit" } } :
        { status: "uncertain", result: null };
      const failed = request.kind === "policy" ? unavailable === "policy" :
        request.kind === "runtime" && object(request.query).kind === "read" && (unavailable === "runtime" || unavailable === "list" && object(request.query).target === undefined || unavailable === "conversations" && object(request.query).section === "conversations" || readFailure && mutations > 0);
      const lost = uncertain && request.kind === "runtime" && object(request.query).kind === "mutate";
      const refused = refusal && request.kind === "runtime" && object(request.query).kind === "mutate";
      const output = Buffer.from(JSON.stringify(lost ? { ok: false, code: "uncertain", error: "Response lost" } :
        refused ? { ok: false, code: "changed", error: "Target changed before commit" } :
        failed ? { ok: false, code: "unavailable", error: "Runtime inspection unavailable" } :
        { ok: true, result: response }));
      const header = Buffer.alloc(4); header.writeUInt32BE(output.length);
      const send = () => socket.end(Buffer.concat([header, output]));
      if (request.kind === "runtime" && object(request.query).kind === "read" && readDelay) {
        const timer = setTimeout(send, readDelay);
        socket.once("close", () => clearTimeout(timer));
      } else send();
    });
  });
  await new Promise<void>(resolve => server.listen(path, resolve));
  const panels = new Panels(join(home, "panels.sqlite"));
  onTestFinished(async () => {
    panels[Symbol.dispose]();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    rmSync(home, { recursive: true, force: true });
    if (original === undefined) delete process.env.HELIO_ADMIN_SOCKET; else process.env.HELIO_ADMIN_SOCKET = original;
  });
  const messages: Record<string, unknown>[] = [], callbacks: Record<string, unknown>[] = [];
  const controller = new Controller(panels, async (method, path, body) => {
    if (method === "PATCH") { messages.push(object(body)); return { id: "77777" }; }
    if (path.endsWith("/callback")) callbacks.push(object(body));
    return undefined;
  });
  let sequence = 10000;
  const event = (data: unknown, actor = "11111", type = 3) => ({
    id: String(sequence++), application_id: "88888",
    ...(dm ? { user: { id: actor }, channel: { id: "44444", type: 1 } } :
      { guild_id: "99999", channel_id: "44444", member: { user: { id: actor } } }),
    token: "offline-token", type, message: { id: "77777" }, data,
  });
  const invoke = (name = "list", options: readonly unknown[] = []) => controller.handle(event({
    name: "conversations", options: [{ type: 1, name, options }],
  }, "11111", 2));
  const last = () => {
    const message = messages.at(-1);
    if (!message) throw new Error("No panel rendered");
    return message;
  };
  const custom = (verb: string): string => {
    const rows = last().components;
    if (!Array.isArray(rows)) throw new Error("Missing panel rows");
    for (const row of rows) {
      const children = object(row).components;
      if (!Array.isArray(children)) continue;
      for (const child of children) {
        const id = object(child).custom_id;
        if (typeof id === "string" && id.endsWith(`:${verb}`)) return id;
      }
    }
    throw new Error(`Missing ${verb} control`);
  };
  const click = (verb: string, values: readonly string[] = [], actor = "11111") =>
    controller.handle(event({ custom_id: custom(verb), component_type: 3, values }, actor));
  return { controller, panels, event, invoke, click, custom, last, messages, callbacks,
    path: join(home, "panels.sqlite"), failReadsAfterMutation: () => { readFailure = true; },
    setRecords: (value: AdminRecord[]) => { records = value; },
    records: () => records, revoke: () => { trusted = ""; }, mutations: () => mutations,
    configurationChanges: () => configurationChanges,
    loseMutationResponse: (value = true) => { uncertain = value; },
    settleOperation: (status: "done" | "refused" = "done") => { settled = status; }, probes: () => probes,
    refuseMutation: (value: boolean) => { refusal = value; }, submissions: () => submissions,
    corruptMutationResponse: () => { malformed = true; },
    requests: () => requests,
    delayReads: (ms: number) => { readDelay = ms; },
    setUnavailable: (source: "policy" | "runtime" | "list" | "conversations" | undefined) => { unavailable = source; } };
}
