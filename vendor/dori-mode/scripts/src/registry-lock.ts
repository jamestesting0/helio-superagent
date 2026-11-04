import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";

class RegistryLockError extends Error {
  constructor(readonly lock: string, message: string) {
    super(message);
  }
}

const isCode = (error: unknown, ...codes: readonly string[]): boolean =>
  error instanceof Error && "code" in error && typeof error.code === "string" && codes.includes(error.code);

export const lockRegistry = (lock: string): (() => void) => {
  const candidate = `${lock}.${process.pid}.${crypto.randomUUID()}.pending`;
  mkdirSync(candidate);
  try {
    writeFileSync(`${candidate}/owner`, String(process.pid));
    for (;;) {
      try {
        renameSync(candidate, lock);
        return () => rmSync(lock, { recursive: true });
      } catch (error) {
        if (!isCode(error, "EEXIST", "ENOTEMPTY")) throw error;
      }
      let owner: number;
      let inode: ReturnType<typeof statSync>;
      try {
        inode = statSync(lock);
        owner = Number(readFileSync(`${lock}/owner`, "utf8").trim());
      } catch (error) {
        if (isCode(error, "ENOENT")) throw new RegistryLockError(lock, `lane registry locked without a readable owner: ${lock}`);
        throw error;
      }
      if (!Number.isInteger(owner) || owner <= 0) throw new RegistryLockError(lock, `lane registry locked with invalid owner: ${lock}`);
      try {
        process.kill(owner, 0);
        throw new RegistryLockError(lock, `lane registry locked by live PID ${owner}`);
      } catch (error) {
        if (!isCode(error, "ESRCH")) throw error;
      }
      try {
        // Keep a nonempty tombstone per inode: a racing reaper cannot move a new live lock over it.
        renameSync(lock, `${lock}.dead-${inode.dev}-${inode.ino}`);
      } catch (error) {
        if (!isCode(error, "ENOENT", "EEXIST", "ENOTEMPTY")) throw error;
      }
    }
  } finally {
    rmSync(candidate, { recursive: true, force: true });
  }
};
