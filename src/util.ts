import { createHash } from "node:crypto";

export function log(scope: string, ...args: unknown[]): void {
  const t = new Date().toTimeString().slice(0, 8);
  console.log(t, `[${scope}]`, ...args);
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));

export const hash = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 16);

export const pad2 = (n: number) => String(n).padStart(2, "0");

export function hhmm(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** Normalise a filesystem path for case-insensitive prefix comparison on Windows. */
export function normPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
