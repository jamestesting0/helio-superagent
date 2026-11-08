import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AdminError, object, query, text, type RuntimeProof, type RuntimeQuery, type RuntimeResult } from "./protocol.ts";
import { applyMutation } from "./runtime-mutations.ts";
import { RuntimeRecords } from "./runtime-records.ts";
import { RuntimeState } from "./runtime-state.ts";
import { probeGithub } from "./github-status.ts";
import { recover } from "./runtime-recovery.ts";

function proofValue(value: unknown, expectedId: string): RuntimeProof {
  const row = object(value);
  if (row.id !== expectedId || typeof row.expires_at !== "number" || !Number.isSafeInteger(row.expires_at) ||
      row.expires_at <= Date.now() || row.expires_at > Date.now() + 80_000) {
    throw new AdminError("denied", "This administration proof is invalid or expired");
  }
  const actor = text(row.actor, 30), guild = text(row.guild, 30), operation = text(row.operation, 100);
  if (!/^\d{5,30}$/.test(actor) || !/^\d{5,30}$/.test(guild) || !/^[A-Za-z0-9_-]{1,100}$/.test(operation)) {
    throw new AdminError("invalid", "Invalid administration identity");
  }
  return { id: expectedId, actor, guild, operation, expires_at: row.expires_at,
    policy_revision: text(row.policy_revision, 64), query: query(row.query) };
}

export class RuntimeAdmin {
  private readonly state: RuntimeState;
  private readonly records: RuntimeRecords;
  constructor(proof: RuntimeProof) {
    this.state = new RuntimeState(proof);
    this.records = new RuntimeRecords(this.state);
  }

  [Symbol.dispose](): void { this.state[Symbol.dispose](); }

  async execute(request: RuntimeQuery): Promise<RuntimeResult> {
    const { access, published } = this.state;
    access.authorize((request.kind === "mutate" || request.kind === "receipt") && request.action === "lanes.abandon");
    switch (request.kind) {
      case "read": {
        let records = await this.records.read(request.section, request.target, request.suggest);
        if (request.target !== undefined) records = records.filter(record => record.id === request.target);
        for (const [name, value] of Object.entries(request.filters)) {
          if (!value || value === "all") continue;
          if (name === "state" && value === "active") records = records.filter(row => row.state !== "resolved" && row.state !== "archived" && row.state !== "closed");
          else if (name === "state" || name === "user" || name === "channel" || name === "source") records = records.filter(row => row[name] === value);
          else if (name === "search") records = records.filter(row => `${row.title} ${row.summary} ${row.id}`.toLowerCase().includes(value.toLowerCase()));
          else if (name === "action" && request.section === "audit") records = records.filter(row => row.title === value);
          else throw new AdminError("invalid", "Unsupported list filter");
        }
        access.authorize();
        return { records, revision: published.revision,
          ...(request.section === "settings" || request.section === "overview" ? { application: this.records.policy.applicationStatus() } : {}) };
      }
      case "probe": {
        const result = await probeGithub(this.state.home);
        access.authorize();
        return result;
      }
      case "mutate": return this.mutate(request);
      case "receipt": return recover(this.state, request);
      default: { const unreachable: never = request; return unreachable; }
    }
  }

  private async mutate(request: Extract<RuntimeQuery, { readonly kind: "mutate" }>): Promise<RuntimeResult> {
    const section = request.action.split(".")[0];
    if (section !== "conversations" && section !== "lanes" && section !== "blocks") throw new AdminError("invalid", "Unsupported mutation");
    const { proof, admin, access } = this.state;
    const fingerprint = JSON.stringify([proof.actor, request]);
    const prior = admin.query<{ fingerprint: string; status: string; result: string | null }, [string]>(
      "SELECT fingerprint,status,result FROM operations WHERE id=?").get(proof.operation);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new AdminError("denied", "This operation was already used");
      if (prior.status === "done" && prior.result) return JSON.parse(prior.result);
      throw new AdminError("uncertain", "This operation has an unresolved receipt; inspect it before repeating the action");
    }
    const current = (await this.records.read(section)).find(row => row.id === request.target);
    if (request.action !== "blocks.add" && (!current || current.revision !== request.expected)) {
      throw new AdminError("changed", "The selected record changed; refresh its preview");
    }
    admin.query("INSERT INTO operations VALUES (?,?,?,?,?,?,?,?,'running',NULL)").run(
      proof.operation, fingerprint, proof.actor, request.action, request.target,
      current?.channel ?? null, current?.user ?? null, Date.now());
    try {
      access.authorize(request.action === "lanes.abandon");
      const notice = await applyMutation(this.state, request, current);
      const result: RuntimeResult = { records: [], notice, operation: proof.operation };
      admin.query("UPDATE operations SET status='done',result=? WHERE id=?").run(JSON.stringify(result), proof.operation);
      return result;
    } catch (error) {
      if (error instanceof AdminError || error instanceof RangeError || error instanceof TypeError) {
        admin.query("UPDATE operations SET status=?,result=? WHERE id=? AND status IN ('running','uncertain')")
          .run(error instanceof AdminError && error.code === "uncertain" ? "uncertain" : "refused",
            JSON.stringify({ error: error.message }), proof.operation);
        throw error;
      }
      if (!(error instanceof Error)) throw error;
      admin.query("UPDATE operations SET status='uncertain',result=? WHERE id=? AND status IN ('running','uncertain')")
        .run(JSON.stringify({ error: error.message.slice(0, 800) }), proof.operation);
      throw new AdminError("uncertain", "The operation result is uncertain; inspect its saved receipt before repeating it");
    }
  }
}

export async function executeProof(nonce: string): Promise<RuntimeResult> {
  if (!/^[a-f0-9]{32}$/.test(nonce)) throw new AdminError("invalid", "Invalid administration proof identifier");
  const directory = process.env.DORI_POLICY_DIR ?? join(process.env.HOME ?? "", ".dori/elobot/policy");
  const proof = proofValue(JSON.parse(readFileSync(join(directory, "requests", `${nonce}.json`), "utf8")), nonce);
  using runtime = new RuntimeAdmin(proof);
  return await runtime.execute(proof.query);
}
