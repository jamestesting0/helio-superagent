import type { AdminRecord } from "./protocol.ts";

export async function readRecords<T>(rows: readonly T[],
  read: (row: T) => Promise<AdminRecord | undefined>): Promise<AdminRecord[]> {
  const records: AdminRecord[] = [];
  for (let offset = 0; offset < rows.length; offset += 8) {
    const batch = await Promise.all(rows.slice(offset, offset + 8).map(read));
    for (const record of batch) if (record) records.push(record);
  }
  return records;
}
