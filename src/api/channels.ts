import type { FastifyInstance } from "fastify";
import type { ConfigStore } from "../config";
import type { StreamManager } from "../stream/manager";

const ID_RE = /^[a-z0-9][a-z0-9_-]*$/i;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const num = (v: unknown) => (v === "" || v == null || Number.isNaN(Number(v)) ? undefined : Number(v));

function cleanContent(c: Any): Any {
  if (!c || typeof c !== "object") return undefined;
  if (c.type === "collection") {
    if (!str(c.collection)) throw new Error("Pick a collection for every block.");
    return { type: "collection", collection: str(c.collection), order: c.order === "shuffle" ? "shuffle" : "sequential" };
  }
  if (c.type === "restream") {
    if (!str(c.source)) throw new Error("A restream needs a stream or playlist URL.");
    const out: Any = { type: "restream", source: str(c.source) };
    if (str(c.channel)) out.channel = str(c.channel);
    if (str(c.title)) out.title = str(c.title);
    return out;
  }
  return undefined;
}

const GRAPHIC_FIELDS: Record<string, { nums?: string[]; strs?: string[]; enums?: Record<string, string[]> }> = {
  upnext: { nums: ["secondsBeforeEnd", "duration"] },
  nowplaying: { nums: ["delay", "duration"] },
  countdown: { nums: ["showHoursBefore"], strs: ["at", "title"], enums: { target: ["next-event", "at"], position: ["top-left", "top-right", "bottom-left", "bottom-right"], showDuring: ["always", "programmes"] } },
  ticker: { nums: ["speed"], strs: ["text", "label"], enums: { showDuring: ["always", "programmes"] } },
  clock: { enums: { format: ["24h", "12h"], position: ["top-left", "top-right", "bottom-left", "bottom-right"], showDuring: ["always", "programmes"] } },
};

function cleanGraphic(g: Any, i: number): Any {
  const spec = GRAPHIC_FIELDS[g?.type];
  if (!spec) throw new Error(`Graphic ${i + 1} has an unknown type.`);
  const out: Any = { type: g.type, enabled: g.enabled !== false };
  for (const k of spec.nums ?? []) if (num(g[k]) !== undefined) out[k] = num(g[k]);
  for (const k of spec.strs ?? []) if (str(g[k])) out[k] = str(g[k]);
  for (const [k, allowed] of Object.entries(spec.enums ?? {})) if (allowed.includes(g[k])) out[k] = g[k];
  if (g.type === "ticker" && !out.text) throw new Error("The ticker needs some text.");
  if (g.type === "countdown" && out.target === "at" && !out.at) throw new Error("Pick the countdown's date and time.");
  return out;
}

/** Turn the editor's payload into the exact shape config.json uses (validation happens in ConfigStore). */
function cleanChannel(id: string, b: Any): Any {
  const out: Any = { id, number: num(b.number), name: str(b.name) ?? "" };
  if (str(b.group)) out.group = str(b.group);
  if (str(b.logo)) out.logo = str(b.logo);
  if (str(b.filler)) out.filler = str(b.filler);
  const def = cleanContent(b.default);
  if (def) out.default = def;
  if (b.breaks && str(b.breaks.style)) {
    const m = b.breaks.midroll ?? {};
    out.breaks = { style: str(b.breaks.style), between: b.breaks.between !== false };
    if (m.enabled) {
      out.breaks.midroll = { enabled: true, useChapters: m.useChapters !== false };
      if (num(m.everyMinutes) !== undefined) out.breaks.midroll.everyMinutes = num(m.everyMinutes);
      if (num(m.minLengthMinutes) !== undefined) out.breaks.midroll.minLengthMinutes = num(m.minLengthMinutes);
    }
  }
  if (b.watermark && str(b.watermark.image)) {
    const w = b.watermark;
    out.watermark = { image: str(w.image), position: w.position ?? "bottom-right" };
    for (const k of ["opacity", "scale", "margin"]) if (num(w[k]) !== undefined) out.watermark[k] = num(w[k]);
    if (w.animation && w.animation !== "none") out.watermark.animation = w.animation;
    if (w.showDuring === "programmes") out.watermark.showDuring = "programmes";
  }
  if (/^#[0-9a-f]{6}$/i.test(b.accent ?? "") && b.accent.toLowerCase() !== "#6aa5ff") out.accent = b.accent;
  if (Array.isArray(b.graphics) && b.graphics.length) out.graphics = b.graphics.map(cleanGraphic);
  out.schedule = (Array.isArray(b.schedule) ? b.schedule : []).map((r: Any, i: number) => {
    const rule: Any = { start: str(r.start), end: str(r.end) };
    if (str(r.name)) rule.name = str(r.name);
    if (str(r.date)) rule.date = str(r.date);
    else if (Array.isArray(r.days) && r.days.length && r.days.length < 7) rule.days = r.days;
    if (num(r.priority) !== undefined) rule.priority = num(r.priority);
    const content = cleanContent(r.content);
    if (!content) throw new Error(`Block ${i + 1}${rule.name ? ` ("${rule.name}")` : ""} needs something to play.`);
    rule.content = content;
    return rule;
  });
  return out;
}

/** Turn "channels.2.schedule.0.start: use HH:MM" into something a person can act on. */
function friendly(msg: string, store: ConfigStore, raw: Any): string {
  return msg
    .replace(/^Config errors:\n\s*/, "")
    .replace(/channel "[^"]+" uses unknown (break style|collection|filler collection) "([^"]+)"/g, '"$2" is not an existing $1')
    .split("\n")
    .map((line) => {
      const m = line.match(/^channels\.(\d+)\.(.*?):\s*(.*)$/);
      if (!m) return line;
      const ch = raw.channels?.[Number(m[1])];
      const field = m[2].replace(/^schedule\.(\d+)\./, (_s, i) => `block ${Number(i) + 1} `).replace(/\./g, " ");
      return `${ch?.name || "Channel"}: ${field} — ${m[3]}`;
    })
    .join("\n");
}

export function channelRoutes(app: FastifyInstance, store: ConfigStore, streams: StreamManager): void {
  const cfg = store.cfg;

  app.get<{ Params: { channel: string } }>("/api/channels/:channel/config", async (req, reply) => {
    const raw = store.snapshot();
    const ch = (raw.channels ?? []).find((c: Any) => c.id === req.params.channel);
    if (!ch) return reply.code(404).send({ error: "No such channel." });
    return ch;
  });

  app.put<{ Params: { channel: string }; Querystring: { create?: string }; Body: Any }>("/api/channels/:channel", async (req, reply) => {
    const id = req.params.channel;
    if (!ID_RE.test(id)) return reply.code(400).send({ error: "The channel ID may only contain letters, numbers, - and _." });
    const exists = cfg.channels.some((c) => c.id === id);
    if (req.query.create === "1" && exists) return reply.code(409).send({ error: `A channel with ID "${id}" already exists.` });
    if (req.query.create !== "1" && !exists) return reply.code(404).send({ error: "No such channel." });

    let next: Any;
    try {
      next = cleanChannel(id, req.body ?? {});
      if (!next.name) throw new Error("Give the channel a name.");
      if (!next.number || next.number < 1) throw new Error("Give the channel a number.");
      const clash = cfg.channels.find((c) => c.number === next.number && c.id !== id);
      if (clash) throw new Error(`Channel number ${next.number} is already used by ${clash.name}.`);
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }

    let snapshot: Any;
    try {
      store.update((raw) => {
        snapshot = raw;
        raw.channels ??= [];
        const i = raw.channels.findIndex((c: Any) => c.id === id);
        if (i >= 0) raw.channels[i] = next;
        else raw.channels.push(next);
      });
    } catch (e) {
      return reply.code(400).send({ error: friendly((e as Error).message, store, snapshot ?? {}) });
    }
    return { ok: true };
  });

  app.delete<{ Params: { channel: string } }>("/api/channels/:channel", async (req, reply) => {
    if (!cfg.channels.some((c) => c.id === req.params.channel)) return reply.code(404).send({ error: "No such channel." });
    try {
      store.update((raw) => {
        raw.channels = (raw.channels ?? []).filter((c: Any) => c.id !== req.params.channel);
      });
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
    streams.stop(req.params.channel);
    return { ok: true };
  });
}
