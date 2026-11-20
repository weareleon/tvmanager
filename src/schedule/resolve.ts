import { DAYS, type ChannelCfg, type ContentCfg, type RuleCfg } from "../config";
import { pad2 } from "../util";

const DAY_MS = 86_400_000;

interface Window {
  idx: number;
  rule: RuleCfg;
  start: number;
  end: number;
  priority: number;
}

export interface Segment {
  start: number;
  /** When the active block changes next. */
  end: number;
  content: ContentCfg | null;
  label: string;
}

const ymd = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

function hm(s: string): [number, number] {
  const [h, m] = s.split(":").map(Number);
  return [h, m];
}

/** Every occurrence of every rule from yesterday through ~8 days ahead of t (local time). */
function windowsAround(ch: ChannelCfg, t: number): Window[] {
  const base = new Date(t);
  const out: Window[] = [];
  for (let off = -1; off <= 8; off++) {
    const y = base.getFullYear();
    const mo = base.getMonth();
    const d = base.getDate() + off;
    const day = new Date(y, mo, d);
    ch.schedule.forEach((rule, idx) => {
      if (rule.date && rule.date !== ymd(day)) return;
      if (rule.days && !rule.days.includes(DAYS[day.getDay()])) return;
      const [sh, sm] = hm(rule.start);
      const [eh, em] = hm(rule.end);
      const start = new Date(y, mo, d, sh, sm).getTime();
      let end = new Date(y, mo, d, eh, em).getTime();
      if (end <= start) end = new Date(y, mo, d + 1, eh, em).getTime();
      out.push({ idx, rule, start, end, priority: rule.priority ?? (rule.date ? 100 : 10) });
    });
  }
  return out;
}

function winnerAt(ws: Window[], t: number): Window | null {
  let best: Window | null = null;
  for (const w of ws) {
    if (w.start > t || t >= w.end) continue;
    if (!best || w.priority > best.priority || (w.priority === best.priority && (w.start > best.start || (w.start === best.start && w.idx < best.idx)))) {
      best = w;
    }
  }
  return best;
}

// Back-to-back occurrences of the same rule (e.g. an all-day block) count as one continuous block.
const key = (w: Window | null) => (w ? `rule${w.idx}` : "default");

/** The channel's next (or current) dated special event, for countdowns. */
export function nextEvent(ch: ChannelCfg, t: number): { title: string; start: number; end: number } | undefined {
  let best: { title: string; start: number; end: number } | undefined;
  for (const r of ch.schedule) {
    if (!r.date) continue;
    const [y, mo, d] = r.date.split("-").map(Number);
    const [sh, sm] = hm(r.start);
    const [eh, em] = hm(r.end);
    const start = new Date(y, mo - 1, d, sh, sm).getTime();
    let end = new Date(y, mo - 1, d, eh, em).getTime();
    if (end <= start) end = new Date(y, mo - 1, d + 1, eh, em).getTime();
    if (end <= t) continue;
    const title = r.name ?? (r.content.type === "restream" ? r.content.title : undefined) ?? "Special event";
    if (!best || start < best.start) best = { title, start, end };
  }
  return best;
}

/**
 * What the channel's schedule says should be on at time t, and until when.
 * Priorities decide overlaps: dated special events beat weekly blocks, which beat the default.
 */
export function resolveSegment(ch: ChannelCfg, t: number): Segment {
  const ws = windowsAround(ch, t);
  const winner = winnerAt(ws, t);
  const k = key(winner);
  const bounds = [...new Set(ws.flatMap((w) => [w.start, w.end]))].filter((b) => b > t).sort((a, b) => a - b);
  let end = t + 6 * DAY_MS;
  for (const b of bounds) {
    if (b >= end) break;
    if (key(winnerAt(ws, b)) !== k) {
      end = b;
      break;
    }
  }
  return {
    start: t,
    end,
    content: winner ? winner.rule.content : (ch.default ?? null),
    label: winner ? (winner.rule.name ?? `Block ${winner.idx + 1}`) : "Default",
  };
}
