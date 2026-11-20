import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";

export const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

const HM = z.string().regex(/^([01]\d|2[0-4]):[0-5]\d$/, "use HH:MM (24h)");

const CollectionContent = z.object({
  type: z.literal("collection"),
  collection: z.string(),
  order: z.enum(["sequential", "shuffle"]).default("sequential"),
});

const RestreamContent = z.object({
  type: z.literal("restream"),
  /** A direct stream URL, or an M3U playlist URL/file when `channel` is set. */
  source: z.string(),
  /** Pick this entry from the M3U playlist (matches tvg-id, tvg-name or display name). */
  channel: z.string().optional(),
  /** Guide title for the restream block. */
  title: z.string().optional(),
});

const Content = z.discriminatedUnion("type", [CollectionContent, RestreamContent]);

const Rule = z.object({
  name: z.string().optional(),
  /** Days of the week this block runs. Omit for every day. */
  days: z.array(z.enum(DAYS)).optional(),
  /** A specific date (YYYY-MM-DD), for one-off special events. */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  start: HM,
  /** End time. If it's earlier than start, the block runs past midnight. */
  end: HM,
  /** Higher wins when blocks overlap. Defaults: dated events 100, weekly blocks 10. */
  priority: z.number().optional(),
  content: Content,
});

const Watermark = z.object({
  image: z.string(),
  position: z.enum(["top-left", "top-right", "bottom-left", "bottom-right"]).default("bottom-right"),
  opacity: z.number().min(0).max(1).default(0.85),
  /** Width of the watermark as a fraction of the video width. */
  scale: z.number().min(0.01).max(1).default(0.12),
  margin: z.number().int().min(0).default(24),
  /** none, fade (in at the start of each programme, out at its end), pulse (gentle breathing), slide (in from the edge). Animated GIFs play as-is. */
  animation: z.enum(["none", "fade", "pulse", "slide"]).default("none"),
  /** Hide the logo during breaks, filler and slates. */
  showDuring: z.enum(["always", "programmes"]).default("always"),
});

const Corner = z.enum(["top-left", "top-right", "bottom-left", "bottom-right"]);
const ShowDuring = z.enum(["always", "programmes"]).default("programmes");

/** On-screen graphics, all drawn live by the encoder. */
const Graphic = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("upnext"),
    enabled: z.boolean().default(true),
    /** Appear this many seconds before the programme ends. */
    secondsBeforeEnd: z.number().min(5).max(3600).default(120),
    /** Stay on screen this long. */
    duration: z.number().min(3).max(120).default(12),
  }),
  z.object({
    type: z.literal("nowplaying"),
    enabled: z.boolean().default(true),
    /** Seconds after the programme starts. */
    delay: z.number().min(0).max(600).default(5),
    duration: z.number().min(3).max(120).default(8),
  }),
  z.object({
    type: z.literal("countdown"),
    enabled: z.boolean().default(true),
    /** next-event: the channel's next special event. at: a fixed date and time. */
    target: z.enum(["next-event", "at"]).default("next-event"),
    at: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/).optional(),
    title: z.string().optional(),
    /** Only show within this many hours of the start. */
    showHoursBefore: z.number().min(0.05).max(24 * 30).default(24),
    position: Corner.default("top-right"),
    showDuring: ShowDuring,
  }),
  z.object({
    type: z.literal("ticker"),
    enabled: z.boolean().default(true),
    text: z.string().min(1),
    label: z.string().optional(),
    /** Pixels per second. */
    speed: z.number().min(20).max(600).default(120),
    showDuring: ShowDuring,
  }),
  z.object({
    type: z.literal("clock"),
    enabled: z.boolean().default(true),
    format: z.enum(["24h", "12h"]).default("24h"),
    position: Corner.default("top-left"),
    showDuring: ShowDuring,
  }),
]);

const ClipsSlot = z.object({
  type: z.literal("clips"),
  /** Shown in the dashboard only, e.g. "Into break", "Ads", "Promo". */
  label: z.string().optional(),
  collection: z.string(),
  /** How many clips to play... */
  count: z.number().int().min(1).max(50).optional(),
  /** ...or keep adding clips up to this many seconds (at least one clip). */
  seconds: z.number().min(1).max(3600).optional(),
});

const UpNextSlot = z.object({
  type: z.literal("upnext"),
  label: z.string().optional(),
  /** How long the card stays on screen. */
  seconds: z.number().min(2).max(60).default(6),
  /** Optional collection of background clips to draw the card over. */
  background: z.string().optional(),
});

const BreakSlot = z.discriminatedUnion("type", [ClipsSlot, UpNextSlot]);

const BreakStyle = z.object({
  id: z.string().regex(/^[a-z0-9_-]+$/i, "letters, numbers, - and _ only"),
  name: z.string().optional(),
  slots: z.array(BreakSlot).min(1, "a break needs at least one slot"),
});

const ChannelBreaks = z.object({
  /** Which break style to use. */
  style: z.string(),
  /** Insert a break after every programme. */
  between: z.boolean().default(true),
  /** Split long programmes and insert breaks inside them. */
  midroll: z
    .object({
      enabled: z.boolean().default(false),
      /** Roughly how often (minutes of programme between breaks). */
      everyMinutes: z.number().min(0.1).max(120).default(12),
      /** Only split programmes at least this long (minutes). */
      minLengthMinutes: z.number().min(0).max(600).default(20),
      /** Cut at chapter markers near the ideal times when the file has them. */
      useChapters: z.boolean().default(true),
    })
    .default({}),
});

const Channel = z.object({
  id: z.string().regex(/^[a-z0-9_-]+$/i, "letters, numbers, - and _ only"),
  number: z.number().int().positive(),
  name: z.string(),
  logo: z.string().url().optional(),
  group: z.string().optional(),
  watermark: Watermark.optional(),
  /** Collection of short clips used to fill gaps before the next block starts. */
  filler: z.string().optional(),
  /** What plays when no schedule block is active. */
  default: Content.optional(),
  /** Commercial breaks: which style, and where they go. */
  breaks: ChannelBreaks.optional(),
  /** On-screen graphics: up next banners, now playing, countdowns, ticker, clock. */
  graphics: z.array(Graphic).default([]),
  /** Accent colour for graphics, e.g. #6aa5ff. */
  accent: z.string().regex(/^#[0-9a-f]{6}$/i).default("#6aa5ff"),
  schedule: z.array(Rule).default([]),
});

const LocalSource = z.object({
  type: z.literal("local"),
  id: z.string(),
  paths: z.array(z.string()).min(1),
});

const mediaServer = <T extends "jellyfin" | "emby">(type: T) =>
  z.object({
    type: z.literal(type),
    id: z.string(),
    /** e.g. http://localhost:8096 */
    url: z.string().url(),
    apiKey: z.string().min(1),
    /** Which user's view of the library to use. Defaults to the first administrator. */
    userId: z.string().optional(),
    /** Library names to import. Defaults to all video libraries. */
    libraries: z.array(z.string()).optional(),
    /**
     * auto: read the file directly if this PC can see it, otherwise stream from the server.
     * file: always read files directly. stream: always stream from the server.
     */
    playback: z.enum(["auto", "file", "stream"]).default("auto"),
    /** Rewrite server paths to paths this PC can read, e.g. {"from": "/media", "to": "//nas/media"}. */
    pathReplacements: z.array(z.object({ from: z.string(), to: z.string() })).default([]),
  });

const JellyfinSource = mediaServer("jellyfin");
const EmbySource = mediaServer("emby");

const Source = z.discriminatedUnion("type", [LocalSource, JellyfinSource, EmbySource]);

const Collection = z.object({
  id: z.string(),
  source: z.string(),
  /** Only include files under this folder (absolute, or relative to a local source's paths). */
  folder: z.string().optional(),
  /** Only include files whose path contains this text (case-insensitive). */
  match: z.string().optional(),
  /** Media server sources: only this library (by name). */
  library: z.string().optional(),
  /** Only episodes of these shows (by name, case-insensitive). */
  shows: z.array(z.string()).optional(),
  /** Only items with at least one of these genres. */
  genres: z.array(z.string()).optional(),
  /** Only movies, episodes or other videos. */
  kind: z.enum(["movie", "episode", "other"]).optional(),
});

const Ffmpeg = z
  .object({
    ffmpeg: z.string().default("ffmpeg"),
    ffprobe: z.string().default("ffprobe"),
    /** libx264, h264_nvenc, h264_qsv or h264_amf */
    videoEncoder: z.string().default("libx264"),
    preset: z.string().optional(),
    width: z.number().int().default(1280),
    height: z.number().int().default(720),
    fps: z.number().int().default(30),
    videoBitrate: z.string().default("3500k"),
    audioBitrate: z.string().default("160k"),
    font: z.string().default("C:/Windows/Fonts/arial.ttf"),
    fontBold: z.string().default("C:/Windows/Fonts/arialbd.ttf"),
    /** Monospaced, so countdown and clock digits don't jitter. */
    fontMono: z.string().default("C:/Windows/Fonts/consolab.ttf"),
  })
  .default({});

const Server = z
  .object({
    port: z.number().int().default(8420),
    host: z.string().default("0.0.0.0"),
    /** Base URL used in the M3U, e.g. http://192.168.1.10:8409. Defaults to the request's Host. */
    publicUrl: z.string().url().optional(),
    /** Seconds to keep a channel's encoder running after the last viewer leaves. */
    idleSeconds: z.number().int().min(0).default(20),
    /** How many simultaneous streams the emulated HDHomeRun tuner advertises to Plex. */
    tuners: z.number().int().min(1).max(32).default(4),
    /** Name Plex shows for the tuner. */
    tunerName: z.string().default("tvmanager"),
  })
  .default({});

const ConfigSchema = z.object({
  server: Server,
  dataDir: z.string().default("./data"),
  scanIntervalMinutes: z.number().int().positive().default(360),
  playoutHours: z.number().int().min(6).default(48),
  ffmpeg: Ffmpeg,
  sources: z.array(Source).default([]),
  collections: z.array(Collection).default([]),
  breaks: z.array(BreakStyle).default([]),
  channels: z.array(Channel).default([]),
});

export type Config = z.infer<typeof ConfigSchema>;
export type ChannelCfg = z.infer<typeof Channel>;
export type RuleCfg = z.infer<typeof Rule>;
export type ContentCfg = z.infer<typeof Content>;
export type CollectionCfg = z.infer<typeof Collection>;
export type SourceCfg = z.infer<typeof Source>;
export type MediaServerSourceCfg = z.infer<typeof JellyfinSource> | z.infer<typeof EmbySource>;
export type FfmpegCfg = z.infer<typeof Ffmpeg>;
export type WatermarkCfg = z.infer<typeof Watermark>;
export type GraphicCfg = z.infer<typeof Graphic>;
export type BreakStyleCfg = z.infer<typeof BreakStyle>;
export type BreakSlotCfg = z.infer<typeof BreakSlot>;
export type ChannelBreaksCfg = z.infer<typeof ChannelBreaks>;

export function parseConfig(raw: unknown, baseDir: string): Config {
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(issues);
  }
  const cfg = parsed.data;
  cfg.dataDir = resolve(baseDir, cfg.dataDir);
  validateRefs(cfg);
  return cfg;
}

export function loadConfig(path: string): Config {
  try {
    return parseConfig(JSON.parse(readFileSync(path, "utf8")), dirname(path));
  } catch (e) {
    throw new Error(`Invalid config in ${path}:\n${(e as Error).message}`);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RawConfig = Record<string, any>;

/**
 * Owns config.json while the server runs. Edits from the dashboard are applied to the raw JSON
 * (so the file stays as hand-written, without filled-in defaults), validated as a whole,
 * written atomically, and then hot-applied to the live config object everyone shares.
 * Sources, collections and channels apply immediately; server/ffmpeg settings need a restart.
 */
export class ConfigStore {
  readonly cfg: Config;
  private raw: RawConfig;
  private listeners: (() => void)[] = [];

  constructor(readonly path: string) {
    this.raw = JSON.parse(readFileSync(path, "utf8"));
    this.cfg = loadConfig(path);
  }

  /** A copy of the raw (as-written) config. */
  snapshot(): RawConfig {
    return structuredClone(this.raw);
  }

  onChange(fn: () => void): void {
    this.listeners.push(fn);
  }

  /** Apply an edit. Throws (and changes nothing) if the result is invalid. */
  update(edit: (raw: RawConfig) => void): void {
    const next = structuredClone(this.raw);
    edit(next);
    const parsed = parseConfig(next, dirname(this.path));
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n");
    renameSync(tmp, this.path);
    this.raw = next;
    this.cfg.sources = parsed.sources;
    this.cfg.collections = parsed.collections;
    this.cfg.breaks = parsed.breaks;
    this.cfg.channels = parsed.channels;
    for (const fn of this.listeners) fn();
  }
}

function validateRefs(cfg: Config): void {
  const errors: string[] = [];
  const sources = new Set(cfg.sources.map((s) => s.id));
  const cols = new Set(cfg.collections.map((c) => c.id));
  for (const c of cfg.collections) {
    if (!sources.has(c.source)) errors.push(`collection "${c.id}" uses unknown source "${c.source}"`);
  }
  const styles = new Set<string>();
  for (const b of cfg.breaks) {
    if (styles.has(b.id)) errors.push(`break style "${b.id}" is defined twice`);
    styles.add(b.id);
    b.slots.forEach((s, i) => {
      const col = s.type === "clips" ? s.collection : s.background;
      if (col && !cols.has(col)) errors.push(`break style "${b.id}" slot ${i + 1} uses unknown collection "${col}"`);
      if (s.type === "clips" && s.count && s.seconds) errors.push(`break style "${b.id}" slot ${i + 1}: use either a count or seconds, not both`);
    });
  }
  const numbers = new Set<number>();
  const ids = new Set<string>();
  for (const ch of cfg.channels) {
    if (numbers.has(ch.number)) errors.push(`channel number ${ch.number} is used twice`);
    if (ids.has(ch.id)) errors.push(`channel id "${ch.id}" is used twice`);
    numbers.add(ch.number);
    ids.add(ch.id);
    const contents = [...ch.schedule.map((r) => r.content), ...(ch.default ? [ch.default] : [])];
    for (const c of contents) {
      if (c.type === "collection" && !cols.has(c.collection)) {
        errors.push(`channel "${ch.id}" uses unknown collection "${c.collection}"`);
      }
    }
    if (ch.filler && !cols.has(ch.filler)) errors.push(`channel "${ch.id}" uses unknown filler collection "${ch.filler}"`);
    if (ch.breaks && !styles.has(ch.breaks.style)) errors.push(`channel "${ch.id}" uses unknown break style "${ch.breaks.style}"`);
    for (const g of ch.graphics) {
      if (g.type === "countdown" && g.target === "at" && !g.at) errors.push(`channel "${ch.id}": countdown needs a date and time`);
    }
    for (const r of ch.schedule) {
      if (r.date && r.days) errors.push(`channel "${ch.id}" block "${r.name ?? r.start}" has both "date" and "days"`);
    }
  }
  if (errors.length) throw new Error(`Config errors:\n  ${errors.join("\n  ")}`);
}
