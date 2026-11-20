import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import type { ChannelCfg, Config } from "../config";
import type { PlayoutItem, PlayoutService } from "../schedule/playout";

interface Programme {
  start: number;
  end: number;
  title: string;
  subtitle?: string;
}

/**
 * Public "watch in the browser" pages: /watch (channel grid) and /watch/<number> (player).
 * No sign-in, like the playlist and streams. The read-only API below exposes only what a
 * TV guide shows (names, numbers, logos, programme titles and times), never file paths
 * or anything from the dashboard.
 */
export function watchRoutes(
  app: FastifyInstance,
  cfg: Config,
  playout: PlayoutService,
  guideFor: (ch: ChannelCfg, items: PlayoutItem[]) => Programme[],
  web: string,
): void {
  const require = createRequire(import.meta.url);
  const playerJs = require.resolve("mpegts.js/dist/mpegts.js");

  const disabled = () => !cfg.server.publicWatch;
  const HOUR = 3_600_000;

  const programmes = (ch: ChannelCfg, hours: number) => {
    const now = Date.now();
    return guideFor(ch, playout.items(ch, now - 3 * HOUR, now + hours * HOUR)).filter((p) => p.end > now);
  };
  const pub = (p?: Programme) => (p ? { title: p.title, subtitle: p.subtitle, start: p.start, end: p.end } : null);
  const channelInfo = (ch: ChannelCfg) => {
    const [now, next] = programmes(ch, 6);
    return { number: ch.number, name: ch.name, logo: ch.logo ?? null, group: ch.group ?? null, accent: ch.accent, now: pub(now), next: pub(next) };
  };
  const byNumber = (n: string) => cfg.channels.find((c) => String(c.number) === n);

  app.get("/watch-api/channels", async (_req, reply) => {
    if (disabled()) return reply.code(404).send({ error: "Public watching is turned off." });
    return [...cfg.channels].sort((a, b) => a.number - b.number).map(channelInfo);
  });

  app.get<{ Params: { n: string } }>("/watch-api/channels/:n", async (req, reply) => {
    if (disabled()) return reply.code(404).send({ error: "Public watching is turned off." });
    const ch = byNumber(req.params.n);
    if (!ch) return reply.code(404).send({ error: "No such channel." });
    return { ...channelInfo(ch), guide: programmes(ch, 12).slice(0, 30).map(pub) };
  });

  const page = async (_req: unknown, reply: import("fastify").FastifyReply) => {
    if (disabled()) return reply.code(404).type("text/html; charset=utf-8").send("<!doctype html><title>Not available</title><p style='font:16px system-ui;padding:2rem'>Watching in the browser is turned off on this server.</p>");
    return reply.type("text/html; charset=utf-8").header("Cache-Control", "no-cache").send(readFileSync(join(web, "watch.html"), "utf8"));
  };
  app.get("/watch", page);
  app.get("/watch/:n", page);

  // The in-browser MPEG-TS player, served locally so it works without internet access.
  app.get("/assets/mpegts.js", async (_req, reply) => {
    reply.type("text/javascript; charset=utf-8").header("Cache-Control", "public, max-age=86400").send(readFileSync(playerJs, "utf8"));
  });
}
