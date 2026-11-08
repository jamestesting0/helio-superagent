import { DiscordRestError, IgnoredChannelError, type ApiChannel, type Rest } from "../discord/rest.ts";
import { filterConfig } from "../intake/authorization.ts";
import { guildChannelAllowed } from "../intake/filter.ts";
import { policyValues, runtimePolicy } from "../intake/runtime-policy.ts";
import { AdminError, type RuntimeProof } from "./protocol.ts";

export interface Channel extends ApiChannel {
  readonly permission_overwrites?: readonly { readonly id: string; readonly type: number; readonly allow: string; readonly deny: string }[];
  readonly recipients?: readonly { readonly id: string }[];
}
interface Member { readonly roles: readonly string[] }
interface Role { readonly id: string; readonly permissions: string }

export class RuntimeAccess {
  private readonly channels = new Map<string, Promise<Channel>>();
  private readonly visibility = new Map<string, Promise<boolean>>();
  private readonly users = new Map<string, Promise<string>>();
  private memberInfo: Promise<{ readonly member: Member; readonly roles: readonly Role[]; readonly owner: string }> | undefined;

  constructor(private readonly proof: RuntimeProof, private readonly rest: Rest) {}

  authorize(ownerOnly = false): void {
    if (this.proof.expires_at <= Date.now()) throw new AdminError("denied", "The administration proof expired; refresh this panel");
    const current = policyValues();
    if (this.proof.guild !== current.HELIO_ADMIN_GUILD) throw new AdminError("denied", "This panel belongs to a different server");
    if (this.proof.actor !== current.DORI_DISCORD_OWNER_ID &&
        (ownerOnly || !(current.HELIO_TRUSTED_USERS ?? "").split(",").includes(this.proof.actor))) {
      throw new AdminError("denied", ownerOnly ? "Only the owner can perform this action" : "You no longer have administration access");
    }
    if (runtimePolicy()?.revision !== this.proof.policy_revision) throw new AdminError("changed", "Policy changed; refresh this panel");
  }

  channel(id: string): Promise<Channel> {
    let current = this.channels.get(id);
    if (!current) { current = this.rest<Channel>(`/channels/${id}`); this.channels.set(id, current); }
    return current;
  }

  canRead(channelId: string, user?: string): Promise<boolean> {
    const key = `${channelId}:${user ?? ""}`;
    let current = this.visibility.get(key);
    if (!current) { current = this.checkRead(channelId, user); this.visibility.set(key, current); }
    return current;
  }

  canViewChannel(channelId: string): Promise<boolean> {
    const key = `metadata:${channelId}`;
    let current = this.visibility.get(key);
    if (!current) { current = this.checkRead(channelId, undefined, false); this.visibility.set(key, current); }
    return current;
  }

  userLabel(id: string, knownName?: string): Promise<string> {
    if (knownName?.trim()) {
      const known = Promise.resolve(knownName);
      this.users.set(id, known);
      return known;
    }
    let current = this.users.get(id);
    if (!current) {
      current = this.rest<{ readonly username: string; readonly global_name?: string | null }>(`/users/${id}`)
        .then(user => user.global_name || user.username)
        .catch(error => {
          if (error instanceof DiscordRestError && error.status === 404) return "Unavailable user";
          throw error;
        });
      this.users.set(id, current);
    }
    return current;
  }

  private async checkRead(channelId: string, user?: string, content = true): Promise<boolean> {
    try {
      const channel = await this.channel(channelId);
      if (channel.type === 1 || channel.type === 3) return user === undefined ?
        (channel.recipients ?? []).some(recipient => recipient.id === this.proof.actor) : user === this.proof.actor;
      if (channel.guild_id !== this.proof.guild ||
          (content && !await guildChannelAllowed(channelId, filterConfig(process.env), async id => this.channel(id)))) return false;
      this.memberInfo ??= Promise.all([
        this.rest<Member>(`/guilds/${this.proof.guild}/members/${this.proof.actor}`),
        this.rest<Role[]>(`/guilds/${this.proof.guild}/roles`),
        this.rest<{ readonly owner_id: string }>(`/guilds/${this.proof.guild}`),
      ]).then(([member, roles, guild]) => ({ member, roles, owner: guild.owner_id }));
      const { member, roles, owner } = await this.memberInfo;
      if (owner === this.proof.actor) return true;
      const ids = new Set([this.proof.guild, ...member.roles]);
      let permissions = roles.filter(role => ids.has(role.id)).reduce((value, role) => value | BigInt(role.permissions), 0n);
      if ((permissions & 8n) !== 0n) return true;
      const parent = [10, 11, 12].includes(channel.type) && channel.parent_id ? await this.channel(channel.parent_id) : channel;
      const overwrites = parent.permission_overwrites ?? [];
      const everyone = overwrites.find(item => item.id === this.proof.guild);
      if (everyone) permissions = (permissions & ~BigInt(everyone.deny)) | BigInt(everyone.allow);
      const roleRules = overwrites.filter(item => item.type === 0 && member.roles.includes(item.id));
      const denied = roleRules.reduce((value, item) => value | BigInt(item.deny), 0n);
      const allowed = roleRules.reduce((value, item) => value | BigInt(item.allow), 0n);
      permissions = (permissions & ~denied) | allowed;
      const own = overwrites.find(item => item.type === 1 && item.id === this.proof.actor);
      if (own) permissions = (permissions & ~BigInt(own.deny)) | BigInt(own.allow);
      const required = content ? 1024n | 65536n : 1024n;
      if ((permissions & required) !== required) return false;
      if (channel.type === 12 && (permissions & (1n << 34n)) === 0n) {
        await this.rest(`/channels/${channelId}/thread-members/${this.proof.actor}`);
      }
      return true;
    } catch (error) {
      if (error instanceof IgnoredChannelError || (error instanceof DiscordRestError && error.status === 404)) return false;
      throw error;
    }
  }
}
