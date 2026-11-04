import { homedir } from "node:os";

import type { GuardThresholds } from "./config.ts";
import type { Runner } from "./run.ts";

export type HostSample = {
  readonly load1: number;
  readonly memFreePct: number | null;
  readonly diskFreeGb: number;
  readonly swapFreeGb: number | null;
  readonly panes: number;
};

const num = (s: string | undefined, fallback: number): number => {
  const n = Number(s);
  return Number.isFinite(n) ? n : fallback;
};

export const sampleHost = async (run: Runner, dataPath = homedir()): Promise<HostSample> => {
  const load = await run(["sysctl", "-n", "vm.loadavg"]);
  const loadLinux = load.code === 0 ? null : await run(["cat", "/proc/loadavg"]);
  const load1 = num((load.code === 0 ? load.out.replace(/[{}]/g, "").trim() : loadLinux?.out ?? "").split(/\s+/)[0], 0);
  let memFreePct: number | null = null;
  let swapFreeGb: number | null = null;
  if (process.platform === "linux") {
    const info = await run(["cat", "/proc/meminfo"]);
    if (info.code === 0) {
      const total = /^MemTotal:\s+(\d+) kB$/m.exec(info.out)?.[1];
      const available = /^MemAvailable:\s+(\d+) kB$/m.exec(info.out)?.[1];
      const swap = /^SwapFree:\s+(\d+) kB$/m.exec(info.out)?.[1];
      if (total && available && Number(total) > 0) memFreePct = Number(available) / Number(total) * 100;
      if (swap) swapFreeGb = Number(swap) / 1_048_576;
    }
  } else {
    const mp = await run(["memory_pressure", "-Q"]);
    const free = /free percentage: (\d+)%/.exec(mp.out)?.[1];
    if (mp.code === 0 && free) memFreePct = Number(free);
    const swap = await run(["sysctl", "-n", "vm.swapusage"]);
    const freeSwap = /free = ([\d.]+)M/.exec(swap.out)?.[1];
    if (swap.code === 0 && freeSwap) swapFreeGb = Number(freeSwap) / 1024;
  }
  const df = await run(["df", "-k", dataPath]);
  const diskFreeGb = num(df.out.split("\n").at(-1)?.trim().split(/\s+/)[3], 0) / 1_048_576;
  const pl = await run(["herdr", "pane", "list"]);
  const panes = pl.code === 0 ? (JSON.parse(pl.out) as { result: { panes: unknown[] } }).result.panes.length : -1;
  return { load1, memFreePct, diskFreeGb, swapFreeGb, panes };
};

export const alertReasons = (s: HostSample, t: GuardThresholds): string[] => {
  const r: string[] = [];
  if (s.load1 > t.loadAlert) r.push(`load ${s.load1.toFixed(0)} > ${t.loadAlert}`);
  if (s.memFreePct === null) r.push("memory free unknown");
  else if (s.memFreePct < t.memFreeMinPct) r.push(`memory free ${s.memFreePct}% < ${t.memFreeMinPct}%`);
  if (s.swapFreeGb === null) r.push("swap free unknown");
  if (s.diskFreeGb < t.diskFreeMinGb) r.push(`disk free ${s.diskFreeGb.toFixed(0)} GB < ${t.diskFreeMinGb} GB`);
  if (t.panesMax > 0 && s.panes > t.panesMax) r.push(`panes ${s.panes} > ${t.panesMax}`);
  return r;
};

export type GuardState = { alerting: boolean; computeReady?: boolean };

export const guardTick = (s: HostSample, t: GuardThresholds, state: GuardState): string[] => {
  const out: string[] = [];
  const reasons = alertReasons(s, t);
  const alerting = reasons.length > 0;
  if (alerting !== state.alerting) {
    out.push(alerting
      ? `HOST_GUARD ALERT ${reasons.join(" | ")}`
      : `HOST_GUARD CLEAR load ${s.load1.toFixed(0)}, memory free ${s.memFreePct}%, disk free ${s.diskFreeGb.toFixed(0)} GB, swap free ${s.swapFreeGb?.toFixed(1) ?? "unknown"} GB`);
    state.alerting = alerting;
  }
  const ready = s.load1 < t.loadOk;
  if (ready !== state.computeReady) {
    out.push(ready ? `HOST_GUARD COMPUTE_READY load ${s.load1.toFixed(0)} < ${t.loadOk}` : `HOST_GUARD COMPUTE_BUSY load ${s.load1.toFixed(0)}`);
    state.computeReady = ready;
  }
  return out;
};
