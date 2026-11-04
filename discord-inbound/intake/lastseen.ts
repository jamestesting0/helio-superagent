export const newerId = (a: string, b: string): boolean => BigInt(a) > BigInt(b);

export class LastSeen {
  private constructor(
    private readonly path: string,
    private readonly ids: Record<string, string>,
    readonly firstRun: boolean,
  ) {}

  static async load(path: string): Promise<LastSeen> {
    const file = Bun.file(path);
    if (!(await file.exists())) return new LastSeen(path, {}, true);
    return new LastSeen(path, (await file.json()) as Record<string, string>, false);
  }

  get(channelId: string): string | undefined {
    return this.ids[channelId];
  }

  async advance(channelId: string, messageId: string): Promise<void> {
    const current = this.ids[channelId];
    if (current !== undefined && !newerId(messageId, current)) return;
    this.ids[channelId] = messageId;
    await this.save();
  }

  /** Forget read positions for channels outside `channelIds`; returns how many were dropped. */
  async retain(channelIds: ReadonlySet<string>): Promise<number> {
    const stale = Object.keys(this.ids).filter((id) => !channelIds.has(id));
    for (const id of stale) delete this.ids[id];
    if (stale.length) await this.save();
    return stale.length;
  }

  async save(): Promise<void> {
    const temporary = `${this.path}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.ids, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.path);
  }
}
import { rename, writeFile } from "node:fs/promises";

