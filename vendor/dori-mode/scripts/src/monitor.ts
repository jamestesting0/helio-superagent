export const monitorLine = (text: string): string => text.replace(/[\r\n]+/g, " ").slice(0, 1000);

export const every = async (minutes: number, tick: () => Promise<void>, errorPrefix = "WARN"): Promise<void> => {
  for (;;) {
    await tick().catch((error: unknown) => console.log(monitorLine(`${errorPrefix} ${error instanceof Error ? error.message : String(error)}`)));
    if (minutes <= 0) return;
    await Bun.sleep(minutes * 60_000);
  }
};
