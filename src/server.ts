import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyRequest } from "fastify";
import { authRoutes } from "./api/auth";
import type { AuthStore } from "./auth";
import { breakRoutes } from "./api/breaks";
import { channelRoutes } from "./api/channels";
import { collectionRoutes } from "./api/collections";
import { hdhomerunRoutes } from "./api/hdhomerun";
import { sourceRoutes } from "./api/sources";
import type { Catalog } from "./catalog/catalog";
import type { ChannelCfg, Config, ConfigStore } from "./config";
import type { PlayoutItem, PlayoutService } from "./schedule/playout";
import type { StreamManager } from "./stream/manager";
import { hhmm, log, pad2 } from "./util";

interface Ctx {
  auth: AuthStore;
  store: ConfigStore;
  cfg: Config;
  catalog: Catalog;
  playout: PlayoutService;
  streams: StreamManager;
}

const esc = (s: string) => s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!);

function xmltvTime(ms: number): string {
  const d = new Date(ms);
  const off = -d.getTimezoneOffset();
  const a = Math.abs(off);
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())} ${off >= 0 ? "+" : "-"}${pad2(Math.floor(a / 60))}${pad2(a % 60)}`;
}

interface Programme {
  start: number;
  end: number;
  title: string;
  subtitle?: string;
}

/** Collapse a playout into guide entries: filler and slates fold into the programme before them. */
function guideFor(ch: ChannelCfg, items: PlayoutItem[]): Programme[] {
  const out: Programme[] = [];
  for (const i of items) {
    const prev = out.at(-1);
    const interstitial = i.kind === "filler" || i.kind === "slate" || i.kind === "break" || i.kind === "card";
    // Breaks, cards and the later parts of a split programme all belong to the programme before them.
    if ((interstitial || (i.kind === "media" && i.part)) && prev && prev.end === i.start) {
      prev.end = i.end;
    } else if (interstitial) {
      out.push({ start: i.start, end: i.end, title: ch.name });
    } else {
      out.push({ start: i.start, end: i.end, title: i.title, subtitle: i.subtitle });
    }
  }
  return out;
}

export function createServer(ctx: Ctx) {
  const { cfg, playout, streams } = ctx;
  const app = Fastify();
  // First, so its guard runs in front of every route registered below.
  authRoutes(app, ctx.auth);

  const baseUrl = (req: FastifyRequest) => cfg.server.publicUrl?.replace(/\/$/, "") ?? `http://${req.headers.host}`;
  hdhomerunRoutes(app, cfg, baseUrl);

  const nowNext = (ch: ChannelCfg) => {
    const now = Date.now();
    const current = playout.itemAt(ch, now);
    const next = current ? playout.nextProgramme(ch, current.end) : undefined;
    return { current, next };
  };

  app.get("/iptv/channels.m3u", async (req, reply) => {
    const base = baseUrl(req);
    const lines = [`#EXTM3U url-tvg="${base}/iptv/xmltv.xml" x-tvg-url="${base}/iptv/xmltv.xml"`];
    for (const ch of [...cfg.channels].sort((a, b) => a.number - b.number)) {
      const attrs = [`tvg-id="${ch.id}"`, `tvg-chno="${ch.number}"`, `tvg-name="${esc(ch.name)}"`];
      if (ch.logo) attrs.push(`tvg-logo="${esc(ch.logo)}"`);
      if (ch.group) attrs.push(`group-title="${esc(ch.group)}"`);
      lines.push(`#EXTINF:-1 ${attrs.join(" ")},${ch.name}`, `${base}/stream/${ch.number}.ts`);
    }
    reply.type("audio/x-mpegurl; charset=utf-8").send(lines.join("\n") + "\n");
  });

  app.get("/iptv/xmltv.xml", async (_req, reply) => {
    const now = Date.now();
    const from = now - 2 * 3_600_000;
    const to = now + cfg.playoutHours * 3_600_000;
    const out = ['<?xml version="1.0" encoding="UTF-8"?>', '<tv generator-info-name="tvmanager">'];
    for (const ch of cfg.channels) {
      out.push(`  <channel id="${esc(ch.id)}"><display-name>${esc(ch.name)}</display-name><display-name>${ch.number}</display-name>${ch.logo ? `<icon src="${esc(ch.logo)}"/>` : ""}</channel>`);
    }
    for (const ch of cfg.channels) {
      for (const p of guideFor(ch, playout.items(ch, from, to))) {
        out.push(
          `  <programme channel="${esc(ch.id)}" start="${xmltvTime(p.start)}" stop="${xmltvTime(p.end)}"><title>${esc(p.title)}</title>${p.subtitle ? `<sub-title>${esc(p.subtitle)}</sub-title>` : ""}</programme>`,
        );
      }
    }
    out.push("</tv>");
    reply.type("application/xml; charset=utf-8").send(out.join("\n"));
  });

  app.get<{ Params: { channel: string } }>("/stream/:channel", (req, reply) => {
    const ch = playout.channel(req.params.channel);
    if (!ch) return reply.code(404).send("No such channel");
    reply.hijack();
    streams.attach(ch, req.raw, reply.raw);
  });

  app.get("/api/channels", async () =>
    [...cfg.channels]
      .sort((a, b) => a.number - b.number)
      .map((ch) => ({
        id: ch.id,
        number: ch.number,
        name: ch.name,
        group: ch.group,
        logo: ch.logo,
        blocks: ch.schedule.length,
        hasWatermark: !!ch.watermark,
        viewers: streams.viewers(ch.id),
        ...nowNext(ch),
      })),
  );

  app.get<{ Params: { channel: string }; Querystring: { hours?: string } }>("/api/channels/:channel/playout", async (req, reply) => {
    const ch = playout.channel(req.params.channel);
    if (!ch) return reply.code(404).send({ error: "No such channel" });
    const hours = Math.min(Number(req.query.hours ?? 12) || 12, cfg.playoutHours);
    const now = Date.now();
    return playout.items(ch, now, now + hours * 3_600_000).map((i) => ({ ...i, startLocal: hhmm(i.start), endLocal: hhmm(i.end) }));
  });

  app.post("/api/scan", async () => {
    await ctx.catalog.scan();
    playout.ensureAll();
    return { ok: true };
  });

  sourceRoutes(app, ctx.store, ctx.catalog);
  collectionRoutes(app, ctx.store, ctx.catalog, cfg.dataDir);
  channelRoutes(app, ctx.store, streams);
  breakRoutes(app, ctx.store, ctx.catalog);

  // Dashboard: read per request so edits show up on refresh during development.
  const web = join(dirname(fileURLToPath(import.meta.url)), "web");
  const ASSETS: Record<string, string> = { "app.js": "text/javascript", "app.css": "text/css" };
  app.get("/", async (_req, reply) => {
    reply.type("text/html; charset=utf-8").header("Cache-Control", "no-cache").send(readFileSync(join(web, "index.html"), "utf8"));
  });
  app.get<{ Params: { file: string } }>("/assets/:file", async (req, reply) => {
    const type = ASSETS[req.params.file];
    if (!type) return reply.code(404).send();
    reply.type(`${type}; charset=utf-8`).header("Cache-Control", "no-cache").send(readFileSync(join(web, req.params.file), "utf8"));
  });

  app.setErrorHandler((err, _req, reply) => {
    const message = err instanceof Error ? err.message : String(err);
    log("http", message);
    reply.code(500).send({ error: message });
  });

  return app;
}
