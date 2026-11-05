/** A bounded set of recently handled message IDs; the durable record of delivery is SQLite. */
export class RecentIds {
  private readonly ids = new Set<string>();
  constructor(private readonly limit = 20_000) {}

  has(id: string): boolean { return this.ids.has(id); }

  add(id: string): void {
    this.ids.delete(id);
    this.ids.add(id);
    if (this.ids.size > this.limit) this.ids.delete(this.ids.values().next().value as string);
  }

  get size(): number { return this.ids.size; }
}
