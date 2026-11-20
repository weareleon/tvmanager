import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Catalog, MediaItem } from "../catalog/catalog";
import type { BreakStyleCfg, ChannelBreaksCfg, ChannelCfg, Config } from "../config";
import { hash, log, pad2, shuffle } from "../util";
import { resolveSegment } from "./resolve";

/**
 * media: a programme (or one part of it, when split by mid-roll breaks)
 * break: a clip inside a commercial break (ad, promo, bumper…)
 * card:  a generated "Up next" card, optionally drawn over a background clip
 * filler/slate: gap filling before a hard block start
 */
export type ItemKind = "media" | "filler" | "slate" | "live" | "break" | "card";

export interface PlayoutItem {
  start: number;
  end: number;
  kind: ItemKind;
  title: string;
  subtitle?: string;
  mediaId?: string;
  path?: string;
  hasAudio?: boolean;
  live?: { source: string; channel?: string };
  block: string;
  /** Collection that had no media when this slate was planned; re-planned once it has some. */
  emptyFor?: string;
  /** Seconds into the file where this item starts (programme parts after a mid-roll break). */
  inPoint?: number;
  /** Which part of a split programme this is (0-based), and how many parts there are. */
  part?: number;
  parts?: number;
  /** Break slot label, e.g. "Ads" or "Into break". */
  slot?: string;
}

type Cursor = { type: "seq"; last?: string } | { type: "shuffle"; bag: string[]; last?: string };

interface PlayoutState {
  version: 1;
  channelId: string;
  configHash: string;
  items: PlayoutItem[];
  cursors: Record<string, Cursor>;
  catalogGen?: number;
}

const HOUR = 3_600_000;
const MAX_SLATE = 4 * HOUR;
/** Short, so a channel waiting for its first scan picks up new media within minutes. */
const EMPTY_SLATE = 5 * 60_000;
const MAX_LIVE = 24 * HOUR;
const MIN_GAP = 1000;
const KEEP_PAST = 6 * HOUR;

const ms = (m: MediaItem) => Math.round(m.duration * 1000);

/**
 * Where to split a programme for mid-roll breaks (seconds into the file).
 * Aims for every `everyMinutes`, snapping to a nearby chapter marker when there is one,
 * and never cutting in the first/last couple of minutes.
 */
export function cutPoints(m: MediaItem, mr: ChannelBreaksCfg["midroll"]): number[] {
  const D = m.duration;
  if (!mr.enabled || D < mr.minLengthMinutes * 60) return [];
  const every = mr.everyMinutes * 60;
  const edge = Math.min(120, D * 0.1);
  const targets: number[] = [];
  for (let x = every; x < D - edge; x += every) targets.push(x);
  const chapters = mr.useChapters ? (m.chapters ?? []).filter((c) => c > edge && c < D - edge) : [];
  const snapped = targets.map((x) => {
    if (!chapters.length) return x;
    const near = chapters.reduce((a, b) => (Math.abs(b - x) < Math.abs(a - x) ? b : a));
    return Math.abs(near - x) <= every / 2 ? near : x;
  });
  const minSpacing = Math.min(60, every / 2);
  const out: number[] = [];
  for (const c of [...new Set(snapped)].sort((a, b) => a - b)) {
    if (c - (out.at(-1) ?? 0) >= minSpacing && D - c >= minSpacing) out.push(c);
  }
  return out;
}

function mediaItem(m: MediaItem, start: number, kind: "media" | "filler" | "break", block: string): PlayoutItem {
  const ep = m.season != null && m.episode != null ? `S${pad2(m.season)}E${pad2(m.episode)}` : undefined;
  return {
    start,
    end: start + ms(m),
    kind,
    title: m.show ?? m.title,
    // Skip placeholder titles like "S1E12" or "Episode 4" that just repeat the episode number.
    subtitle: m.show ? [ep, /^(S\d+\s*E\d+|Episode \d+)$/i.test(m.title) ? "" : m.title].filter(Boolean).join(" · ") : undefined,
    mediaId: m.id,
    path: m.input ?? m.path,
    hasAudio: m.hasAudio,
    block,
  };
}

/**
 * Keeps a persisted, wall-clock timeline per channel a couple of days ahead.
 * This is the channel's "memory": it advances whether or not anyone watches,
 * so tuning in just means starting at the right offset into the current item.
 */
export class PlayoutService {
  private states = new Map<string, PlayoutState>();
  private dir: string;

  constructor(
    private cfg: Config,
    private catalog: Catalog,
  ) {
    this.dir = join(cfg.dataDir, "playouts");
    mkdirSync(this.dir, { recursive: true });
  }

  channel(idOrNumber: string): ChannelCfg | undefined {
    const key = idOrNumber.replace(/\.ts$/i, "");
    return this.cfg.channels.find((c) => c.id === key || String(c.number) === key);
  }

  ensureAll(): void {
    for (const ch of this.cfg.channels) {
      try {
        this.ensure(ch);
      } catch (e) {
        log("playout", `channel ${ch.id}: ${(e as Error).message}`);
      }
    }
  }

  itemAt(ch: ChannelCfg, t: number): PlayoutItem | undefined {
    const st = this.ensure(ch, t + HOUR);
    return st.items.find((i) => i.start <= t && t < i.end);
  }

  /** The item that starts exactly at t (i.e. the one following an item that ends at t). */
  itemStartingAt(ch: ChannelCfg, t: number): PlayoutItem | undefined {
    const st = this.ensure(ch, t + HOUR);
    return st.items.find((i) => Math.abs(i.start - t) < 5 && i.end > i.start);
  }

  /**
   * The next real programme starting at or after t. Continuations after a mid-roll break
   * are skipped unless `includeParts` (an "Up next" card in a mid-roll break wants "back to …").
   */
  nextProgramme(ch: ChannelCfg, t: number, includeParts = false): PlayoutItem | undefined {
    const st = this.ensure(ch, t + 6 * HOUR);
    return st.items.find((i) => i.start >= t && (i.kind === "media" || i.kind === "live") && (includeParts || !i.part));
  }

  items(ch: ChannelCfg, from: number, to: number): PlayoutItem[] {
    const st = this.ensure(ch, to);
    return st.items.filter((i) => i.end > from && i.start < to);
  }

  private configHash(ch: ChannelCfg): string {
    const used = new Set<string>([ch.filler ?? ""]);
    for (const c of [...ch.schedule.map((r) => r.content), ch.default]) if (c?.type === "collection") used.add(c.collection);
    const style = this.breakStyle(ch);
    for (const s of style?.slots ?? []) used.add(s.type === "clips" ? s.collection : (s.background ?? ""));
    const cols = this.cfg.collections.filter((c) => used.has(c.id));
    // Look-only settings don't change what plays, so editing them mustn't re-plan the timeline.
    const { graphics: _g, accent: _a, watermark: _w, logo: _l, group: _gr, ...plan } = ch;
    return hash(JSON.stringify({ plan, cols, style }));
  }

  private breakStyle(ch: ChannelCfg): BreakStyleCfg | undefined {
    return ch.breaks ? this.cfg.breaks.find((b) => b.id === ch.breaks!.style) : undefined;
  }

  private state(ch: ChannelCfg): PlayoutState {
    let st = this.states.get(ch.id);
    if (st) return st;
    const file = join(this.dir, `${ch.id}.json`);
    if (existsSync(file)) {
      try {
        st = JSON.parse(readFileSync(file, "utf8")) as PlayoutState;
      } catch {
        log("playout", `corrupt playout for ${ch.id}, starting fresh`);
      }
    }
    st ??= { version: 1, channelId: ch.id, configHash: "", items: [], cursors: {} };
    this.states.set(ch.id, st);
    return st;
  }

  private save(st: PlayoutState): void {
    writeFileSync(join(this.dir, `${st.channelId}.json`), JSON.stringify(st));
  }

  ensure(ch: ChannelCfg, until = Date.now() + this.cfg.playoutHours * HOUR): PlayoutState {
    const st = this.state(ch);
    const now = Date.now();
    let changed = false;

    const h = this.configHash(ch);
    if (st.configHash !== h) {
      // Schedule changed: keep what's on now, rebuild everything after it.
      if (st.configHash) log("playout", `${ch.id}: schedule changed, rebuilding after the current programme`);
      // Keep what's on now, plus the rest of a programme that's split by mid-roll breaks,
      // so a viewer doesn't lose the second half of an episode because a setting changed.
      let keep = st.items.findIndex((i) => i.start > now);
      if (keep < 0) keep = st.items.length;
      for (let j = keep; j < st.items.length; j++) {
        const it = st.items[j];
        if (it.kind === "media" && it.part) keep = j + 1;
        else if (it.kind !== "break" && it.kind !== "card") break;
      }
      st.items = st.items.slice(0, keep);
      // If what we kept ends with a programme, give it its between-programme break back.
      const tail = st.items.at(-1);
      const style = this.breakStyle(ch);
      if (tail?.kind === "media" && tail.end > now && (!tail.parts || tail.part === tail.parts - 1) && style && ch.breaks?.between) {
        st.items.push(...this.buildBreak(st, style, tail.end, tail.block, resolveSegment(ch, tail.end).end));
      }
      st.configHash = h;
      changed = true;
    }

    if (st.catalogGen !== this.catalog.generation) {
      // Media changed: re-plan any upcoming slots that were empty for lack of media.
      const firstEmpty = st.items.findIndex((i) => i.emptyFor && i.start > now && this.catalog.collectionItems(i.emptyFor).length > 0);
      if (firstEmpty >= 0) {
        st.items = st.items.slice(0, firstEmpty);
        log("playout", `${ch.id}: new media available, re-planning from ${new Date(st.items.at(-1)?.end ?? now).toTimeString().slice(0, 5)}`);
      }
      st.catalogGen = this.catalog.generation;
      changed = true;
    }

    const before = st.items.length;
    st.items = st.items.filter((i) => i.end > now - KEEP_PAST);
    if (st.items.length !== before) changed = true;

    // If the timeline ran out long ago (server was off), restart from now instead of replaying days.
    let t = st.items.at(-1)?.end ?? Math.floor(now / 1000) * 1000;
    if (t < now - KEEP_PAST) t = Math.floor(now / 1000) * 1000;

    let guard = 0;
    while (t < until && guard++ < 50_000) {
      t = this.step(ch, st, t);
      changed = true;
    }
    if (changed) this.save(st);
    return st;
  }

  /** Append the next item(s) at time t and return the new end of the timeline. */
  private step(ch: ChannelCfg, st: PlayoutState, t: number): number {
    const seg = resolveSegment(ch, t);
    const c = seg.content;

    if (!c) return this.fillGap(ch, st, t, Math.min(seg.end, t + MAX_SLATE), seg.label);

    if (c.type === "restream") {
      const end = Math.min(seg.end, t + MAX_LIVE);
      st.items.push({ start: t, end, kind: "live", title: c.title ?? seg.label, live: { source: c.source, channel: c.channel }, block: seg.label });
      return end;
    }

    const all = this.catalog.collectionItems(c.collection);
    if (!all.length) return this.fillGap(ch, st, t, Math.min(seg.end, t + EMPTY_SLATE), seg.label, c.collection);

    const cursorKey = `${c.collection}:${c.order}`;
    const pick = this.pick(st, cursorKey, c.order, all, seg.end - t);
    if (!pick) return this.fillGap(ch, st, t, seg.end, seg.label);

    return this.placeProgramme(ch, st, pick, t, seg.end, seg.label);
  }

  /** Place a programme, split by mid-roll breaks if configured, then a between-programme break if it fits. */
  private placeProgramme(ch: ChannelCfg, st: PlayoutState, m: MediaItem, t: number, limit: number, block: string): number {
    const style = this.breakStyle(ch);
    const cfg = ch.breaks;
    let out: PlayoutItem[] = [];
    let time = t;

    const cuts = style && cfg ? cutPoints(m, cfg.midroll) : [];
    const bounds = [0, ...cuts, m.duration];
    for (let p = 0; p < bounds.length - 1; p++) {
      const it = mediaItem(m, time, "media", block);
      it.end = time + Math.round((bounds[p + 1] - bounds[p]) * 1000);
      if (cuts.length) Object.assign(it, { part: p, parts: bounds.length - 1, inPoint: bounds[p] });
      out.push(it);
      time = it.end;
      if (p < bounds.length - 2) {
        const brk = this.buildBreak(st, style!, time, block, Infinity);
        out.push(...brk);
        time = brk.at(-1)?.end ?? time;
      }
    }
    if (time > limit) {
      // Mid-roll breaks would overrun the next block's start: play it straight through instead.
      out = [mediaItem(m, t, "media", block)];
      time = out[0].end;
    }

    if (style && cfg?.between) {
      const brk = this.buildBreak(st, style, time, block, limit);
      out.push(...brk);
      time = brk.at(-1)?.end ?? time;
    }
    st.items.push(...out);
    return time;
  }

  /** Build one commercial break from a style's slots, starting at t and not running past `limit`. */
  private buildBreak(st: PlayoutState, style: BreakStyleCfg, t: number, block: string, limit: number): PlayoutItem[] {
    const out: PlayoutItem[] = [];
    let time = t;
    for (const slot of style.slots) {
      if (slot.type === "clips") {
        const all = this.catalog.collectionItems(slot.collection);
        if (!all.length) continue;
        const max = slot.count ?? (slot.seconds ? 50 : 1);
        let used = 0;
        for (let n = 0; n < max; n++) {
          const room = limit - time;
          if (room < MIN_GAP) break;
          // With a time budget, the first clip may run over it; later ones must fit inside it.
          const budget = slot.seconds && n > 0 ? slot.seconds * 1000 - used : Infinity;
          if (budget < MIN_GAP) break;
          const clip = this.pick(st, `break:${slot.collection}`, "shuffle", all, Math.min(room, budget));
          if (!clip) break;
          const it = mediaItem(clip, time, "break", block);
          if (slot.label) it.slot = slot.label;
          out.push(it);
          time = it.end;
          used += ms(clip);
        }
      } else {
        const d = slot.seconds * 1000;
        if (limit - time < d) continue;
        const bgs = slot.background ? this.catalog.collectionItems(slot.background) : [];
        const bg = bgs.length ? this.pick(st, `card:${slot.background}`, "shuffle", bgs, Infinity) : null;
        out.push({
          start: time,
          end: time + d,
          kind: "card",
          title: "Up next",
          block,
          ...(slot.label ? { slot: slot.label } : {}),
          ...(bg ? { path: bg.input ?? bg.path, hasAudio: bg.hasAudio, mediaId: bg.id } : {}),
        });
        time += d;
      }
    }
    return out;
  }

  /** Choose the next item from a collection that fits in `room` ms, advancing that collection's cursor. */
  private pick(st: PlayoutState, key: string, order: "sequential" | "shuffle", all: MediaItem[], room: number): MediaItem | null {
    if (order === "sequential") {
      const cur = (st.cursors[key] ??= { type: "seq" }) as Extract<Cursor, { type: "seq" }>;
      const idx = cur.last ? all.findIndex((m) => m.id === cur.last) : -1;
      const next = all[(idx + 1) % all.length];
      if (ms(next) > room) return null;
      cur.last = next.id;
      return next;
    }

    let cur = st.cursors[key] as Extract<Cursor, { type: "shuffle" }> | undefined;
    if (!cur || cur.type !== "shuffle") cur = st.cursors[key] = { type: "shuffle", bag: [] };
    const ids = new Set(all.map((m) => m.id));
    cur.bag = cur.bag.filter((id) => ids.has(id));
    if (!cur.bag.length) {
      cur.bag = shuffle(all.map((m) => m.id));
      if (cur.bag.length > 1 && cur.bag[0] === cur.last) cur.bag.push(cur.bag.shift()!);
    }
    const byId = new Map(all.map((m) => [m.id, m]));
    const i = cur.bag.findIndex((id) => ms(byId.get(id)!) <= room);
    if (i < 0) return null;
    const [id] = cur.bag.splice(i, 1);
    cur.last = id;
    return byId.get(id)!;
  }

  /** Fill [t, end) with filler clips that fit, then a slate for whatever is left. */
  private fillGap(ch: ChannelCfg, st: PlayoutState, t: number, end: number, block: string, emptyFor?: string): number {
    // Waiting for media: show a plain slate rather than looping bumpers for minutes.
    const fillers = ch.filler && !emptyFor ? this.catalog.collectionItems(ch.filler) : [];
    while (end - t >= MIN_GAP) {
      const fit = fillers.filter((f) => ms(f) <= end - t);
      if (!fit.length) break;
      const f = fit[Math.floor(Math.random() * fit.length)];
      const item = mediaItem(f, t, "filler", block);
      st.items.push(item);
      t = item.end;
    }
    if (end - t >= MIN_GAP) {
      st.items.push({ start: t, end, kind: "slate", title: ch.name, block, ...(emptyFor ? { emptyFor } : {}) });
    } else if (end > t && st.items.length) {
      st.items[st.items.length - 1].end = end; // absorb a sub-second gap
    }
    return end;
  }
}
