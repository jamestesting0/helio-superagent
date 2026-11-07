import { executeProof } from "./backend.ts";
import { AdminError } from "./protocol.ts";

try {
  const nonce = process.argv[2];
  if (!nonce || process.argv.length !== 3) throw new AdminError("invalid", "One host-issued proof is required");
  console.log(JSON.stringify({ ok: true, result: await executeProof(nonce) }));
} catch (error) {
  if (!(error instanceof Error)) throw error;
  console.log(JSON.stringify({ ok: false,
    code: error instanceof AdminError ? error.code : error instanceof RangeError ? "changed" : "unavailable",
    error: error.message.slice(0, 800) }));
}
