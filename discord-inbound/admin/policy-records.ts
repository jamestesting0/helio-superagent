import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AdminError, object, type AdminRecord, type RuntimeResult, type Section } from "./protocol.ts";
import { sourceUrl, stateName } from "./record-format.ts";
import { readRecords } from "./record-reads.ts";
import type { RuntimeState } from "./runtime-state.ts";

export class PolicyRecords {
  constructor(private readonly runtime: RuntimeState) {}

  async configuration(section: Section): Promise<AdminRecord[]> {
    const { published, access } = this.runtime;
    const { values, revision } = published;
    switch (section) {
      case "trusted":
        return Promise.all(values.HELIO_TRUSTED_USERS.split(",").filter(Boolean).map(async id => ({
          id, title: await access.userLabel(id), user: id, revision, summary: "Contributor access",
          fields: [{ name: "User", value: { kind: "user", id, label: await access.userLabel(id) } },
            { name: "Scope", value: "Trusted contributor; owner-only settings remain protected" }],
        })));
      case "timeouts":
        return published.timing.map(setting => ({
          id: setting.key, title: setting.label, revision, summary: `${values[setting.key]} ${setting.unit}`,
          fields: [{ name: "Value", value: `${values[setting.key]} ${setting.unit}` },
            { name: "Allowed range", value: `${setting.minimum}-${setting.maximum}` },
            { name: "Application", value: this.application() }],
        }));
      case "settings":
        return [
          { id: "configuration", title: "Configuration", revision, summary: `Published policy ${revision.slice(0, 8)}`,
            fields: [{ name: "Revision", value: revision }, { name: "Source", value: "Owner configuration" },
              { name: "Application", value: this.application() }] },
          { id: "github", title: "GitHub", revision, summary: "Inspect timestamped access and synchronization results",
            fields: [{ name: "Access", value: "Use Check GitHub for a fresh read-only probe" }] },
          this.deployment(),
        ];
      default: return [];
    }
  }

  application(): string {
    return this.applicationStatus().consumers.map(consumer => `${consumer.name}: ${consumer.applied ? "active" : "pending"}`).join("\n");
  }

  deployment(): AdminRecord {
    const path = join(this.runtime.home, ".dori/elobot/deploy-state.json");
    const saved = existsSync(path) ? object(JSON.parse(readFileSync(path, "utf8"))) : {};
    // Same rule as helio_deploy_plan.restart_state: the host deploy records a pending restart and since when;
    // start receipts under state/ satisfy it.
    const receipt = (kind: string) => {
      const file = join(this.runtime.home, `.dori/elobot/state/${kind}-start.json`);
      return existsSync(file) ? object(JSON.parse(readFileSync(file, "utf8"))) : {};
    };
    const lead = receipt("lead"), full = receipt("full");
    const outstanding = (kind: string, started: Record<string, unknown>) => {
      const since = saved[`${kind}_restart_since`] ?? saved.deployed_at;
      const at = typeof started.at === "string" ? started.at : "";
      return saved[`${kind}_restart_pending`] === true && (typeof since === "string" && since ? at < since : !at);
    };
    const deployed = typeof saved.version === "string" ? saved.version.slice(0, 100) : "Unrecorded";
    const leadVersion = typeof lead.version === "string" ? lead.version : saved.lead_version;
    const running = typeof leadVersion === "string" ? leadVersion.slice(0, 100) : "Unrecorded";
    const pending = outstanding("full", full) ? "Full workspace restart pending" :
      outstanding("lead", lead) ? "Lead restart pending" : deployed !== running ? "Running and deployed versions differ" : "";
    return { id: "deployment", title: "Deployment", revision: this.runtime.published.revision,
      summary: pending || (deployed === "Unrecorded" ? "Version not recorded" : "Up to date"),
      state: pending ? "pending" : "current",
      fields: [{ name: "Deployed version", value: deployed }, { name: "Lead version", value: running },
        { name: "Application", value: pending || "No restart recorded as pending" }] };
  }

  applicationStatus(): NonNullable<RuntimeResult["application"]> {
    const { state, published } = this.runtime;
    const consumers = [["intake", "policy-applied-intake.json"], ["learning", "policy-applied-learning.json"], ["lanes", "config-applied.json"]]
      .map(([name, filename]) => {
        const path = join(state, filename);
        if (!existsSync(path)) return { name, applied: false };
        const receipt = object(JSON.parse(readFileSync(path, "utf8")));
        if (receipt.revision !== published.revision || typeof receipt.pid !== "number" ||
            !Number.isSafeInteger(receipt.pid) || receipt.pid < 1 || typeof receipt.start_ticks !== "string") {
          return { name, applied: false };
        }
        const identity = `/proc/${receipt.pid}/stat`;
        const applied = existsSync(identity) &&
          readFileSync(identity, "utf8").split(") ").at(-1)?.split(" ")[19] === receipt.start_ticks;
        return { name, applied };
      });
    return { revision: published.revision, consumers };
  }

  async channels(target?: string): Promise<AdminRecord[]> {
    const { published, access, proof } = this.runtime;
    const values = published.values;
    const allowed = new Set(values.DORI_DISCORD_ALLOWED.split(",").filter(Boolean));
    const trusted = new Set(values.DORI_DISCORD_TRUSTED_CHANNELS.split(",").filter(Boolean));
    const ignored = new Set(values.DORI_DISCORD_IGNORED_CHANNELS.split(",").filter(Boolean));
    const ids = new Set([...allowed, ...ignored]);
    if (target !== undefined) {
      if (!/^\d{5,30}$/.test(target)) throw new AdminError("invalid", "Choose a valid channel");
      ids.clear(); ids.add(target);
    }
    return readRecords([...ids], async id => {
      if (!await access.canViewChannel(id)) return undefined;
      const metadata = await access.channel(id);
      if (metadata.guild_id !== proof.guild) return undefined;
      const chain = [id];
      if (metadata.parent_id) {
        chain.push(metadata.parent_id);
        if ([10, 11, 12].includes(metadata.type)) {
          const parent = await access.channel(metadata.parent_id);
          if (parent.parent_id) chain.push(parent.parent_id);
        }
      }
      const hard = new Set([...(values.DORI_DISCORD_CONTEXT_EXCLUDED ?? "").split(","), values.HELIO_NEVER_LEARN_CATEGORY].filter(Boolean));
      const blocked = chain.find(value => hard.has(value)) ??
        (values.DORI_DISCORD_SCOPE_CATEGORY && !chain.includes(values.DORI_DISCORD_SCOPE_CATEGORY) ? values.DORI_DISCORD_SCOPE_CATEGORY : undefined);
      const inherited = chain.find(value => ignored.has(value)) ?? chain.find(value => allowed.has(value));
      const rule = blocked ? "hard_excluded" : inherited === undefined ? "outside_scope" :
        ignored.has(inherited) ? "ignored" : trusted.has(inherited) ? "trusted" : "normal";
      return { id, title: metadata.name ?? `Channel ${id}`, channel: id, state: rule, revision: published.revision,
        summary: stateName(rule),
        fields: [{ name: "Channel", value: `<#${id}>` }, { name: "Policy", value: stateName(rule) },
          { name: "Source", value: blocked ? `Hard privacy exclusion <#${blocked}>; immutable here` :
            inherited === id ? "Explicit owner configuration" : inherited ? `Inherited from <#${inherited}>` : "Outside the configured response scope" }],
        url: sourceUrl(proof.guild, id) };
    });
  }
}
