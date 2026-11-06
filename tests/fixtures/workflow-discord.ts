import { Database } from "bun:sqlite";

// Wire fixture for installed helpers. It accepts only synthetic local traffic.
const db = new Database(":memory:");
db.exec("CREATE TABLE messages(id INTEGER PRIMARY KEY AUTOINCREMENT, channel TEXT, payload TEXT)");
db.exec("INSERT INTO messages(id,channel,payload) VALUES (9000,'0','{}')");
let failChannel: string | undefined;
const server = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/fixture/fail-next") {
      failChannel = url.searchParams.get("channel") ?? undefined;
      return Response.json({});
    }
    if (url.pathname === "/fixture/messages") {
      return Response.json(db.query<{ payload: string }, []>("SELECT payload FROM messages WHERE channel != '0' ORDER BY id")
        .all().map((row) => JSON.parse(row.payload)));
    }
    if (url.pathname === "/api/v10/users/@me") return Response.json({ id: "88" });
    if (url.pathname === "/api/v10/users/@me/channels") {
      const body = await request.json();
      return Response.json({ id: String(1000 + Number(body.recipient_id)) });
    }
    const route = /^\/api\/v10\/channels\/(\d+)(?:\/messages(?:\/(\d+))?)?$/.exec(url.pathname);
    if (!route) return new Response("Unexpected fixture route", { status: 404 });
    const channel = route[1] ?? "";
    if (!url.pathname.includes("/messages")) return Response.json({ id: channel, type: channel === "400" ? 1 : 0 });
    if (request.method === "POST") {
      const multipart = request.headers.get("content-type")?.includes("multipart/form-data");
      const form = multipart ? await request.formData() : undefined;
      const body = form ? JSON.parse(String(form.get("payload_json"))) : await request.json();
      const row = db.run("INSERT INTO messages(channel,payload) VALUES (?,?)", [channel, "{}"]);
      const message = { ...body, content: body.content ?? "", id: String(row.lastInsertRowid), channel_id: channel,
        author: { id: "88" }, wire_files: form ? [...form.keys()].filter((key) => key.startsWith("files[")).length : 0 };
      db.run("UPDATE messages SET payload=? WHERE id=?", [JSON.stringify(message), row.lastInsertRowid]);
      if (channel === failChannel) {
        failChannel = undefined;
        return new Response("Accepted, response lost", { status: 503 });
      }
      return Response.json(message);
    }
    if (route[2]) return Response.json({ id: route[2], channel_id: channel, guild_id: "900", content: "Please change the fact.", author: { id: "77" } });
    const after = Number(url.searchParams.get("after") ?? "0");
    const messages = db.query<{ payload: string }, [string, number]>("SELECT payload FROM messages WHERE channel=? AND id>? ORDER BY id")
      .all(channel, after).map((row) => JSON.parse(row.payload));
    return Response.json(messages);
  },
});
console.log(`READY ${server.url}`);
