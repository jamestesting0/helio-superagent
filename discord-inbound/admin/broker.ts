import { createConnection } from "node:net";
import { AdminError, object, type BrokerRequest } from "./protocol.ts";

export class BrokerRefusal extends AdminError {
  constructor(code: AdminError["code"], message: string) {
    super(code, message);
    this.name = "BrokerRefusal";
  }
}

export async function broker(request: BrokerRequest, timeout = 90_000): Promise<unknown> {
  const path = process.env.HELIO_ADMIN_SOCKET ?? "/run/helio-admin-service/admin.sock";
  const data = Buffer.from(JSON.stringify(request));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(data.length);
  return new Promise((resolve, reject) => {
    let received = Buffer.alloc(0);
    let sent = false;
    const socket = createConnection({ path });
    const fail = (error: Error) => { socket.destroy(); reject(error); };
    socket.setTimeout(timeout, () => fail(new AdminError("uncertain", "Administration request timed out; its result must be checked")));
    socket.once("error", () => reject(sent ?
      new AdminError("uncertain", "The administration connection failed after submission; check its result") :
      new BrokerRefusal("unavailable", "The administration service is unavailable; the request was not submitted")));
    socket.once("connect", () => { sent = true; socket.write(Buffer.concat([header, data])); });
    socket.on("data", chunk => {
      received = Buffer.concat([received, typeof chunk === "string" ? Buffer.from(chunk) : chunk]);
      if (received.length > 2_000_004) { fail(new AdminError("invalid", "Administration response is too large")); return; }
      if (received.length < 4 || received.length < 4 + received.readUInt32BE(0)) return;
      try {
        const response = object(JSON.parse(received.subarray(4, 4 + received.readUInt32BE(0)).toString()));
        socket.end();
        if (response.ok === true) { resolve(response.result); return; }
        const code = response.code;
        if (code !== "denied" && code !== "changed" && code !== "unavailable" && code !== "uncertain" && code !== "invalid") {
          throw new AdminError("invalid", "Invalid administration error response");
        }
        reject(new BrokerRefusal(code, typeof response.error === "string" ? response.error : "Administration request failed"));
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        fail(error);
      }
    });
    socket.once("end", () => {
      if (received.length < 4 || received.length < 4 + received.readUInt32BE(0)) {
        reject(new AdminError("uncertain", "Administration response was interrupted; check the operation before trying again"));
      }
    });
  });
}
