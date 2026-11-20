import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import type { FastifyInstance } from "fastify";
import type { Catalog, MediaItem } from "../catalog/catalog";
import type { CollectionCfg, ConfigStore } from "../config";

const ID_RE = /^[a-z0-9][a-z0-9_-]*$/i;

interface CollectionBody {
  source?: string;
  folder?: string;
  match?: string;
  library?: string;
  shows?: string[];
  genres?: string[];
  kind?: string;
}

/** Keep only known, non-empty filter fields. */
function cleanCollection(id: string, b: CollectionBody): Record<string, unknown> {
  const out: Record<string, unknown> = { id, source: b.source };
  const str = (v?: string) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const list = (v?: string[]) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : []);
  if (str(b.folder)) out.folder = str(b.folder);
  if (str(b.match)) out.match = str(b.match);
  if (str(b.library)) out.library = str(b.library);
  if (list(b.shows).length) out.shows = list(b.shows);
  if (list(b.genres).length) out.genres = list(b.genres);
  if (b.kind === "movie" || b.kind === "episode" || b.kind === "other") out.kind = b.kind;
  return out;
}

const fmtDur = (s: number) => {
  if (s < 60) return `${Math.round(s)}s`;
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
};

function summary(items: MediaItem[]) {
  const total = items.reduce((a, i) => a + i.duration, 0);
  return {
    items: items.length,
    totalDuration: total,
    totalLabel: fmtDur(total),
    sample: items.slice(0, 12).map((i) => ({
      title: i.show ?? i.title,
      subtitle: i.show ? `S${String(i.season ?? 0).padStart(2, "0")}E${String(i.episode ?? 0).padStart(2, "0")} · ${i.title}` : undefined,
      duration: fmtDur(i.duration),
    })),
  };
}

/** Which channels reference a collection, and how. */
function usage(store: ConfigStore, id: string): string[] {
  const out: string[] = [];
  for (const ch of store.cfg.channels) {
    const uses =
      ch.filler === id ||
      (ch.default?.type === "collection" && ch.default.collection === id) ||
      ch.schedule.some((r) => r.content.type === "collection" && r.content.collection === id);
    if (uses) out.push(ch.name);
  }
  for (const b of store.cfg.breaks) {
    if (b.slots.some((s) => (s.type === "clips" ? s.collection : s.background) === id)) out.push(`break style ${b.name ?? b.id}`);
  }
  return out;
}

export function collectionRoutes(app: FastifyInstance, store: ConfigStore, catalog: Catalog, dataDir: string): void {
  const cfg = store.cfg;

  app.get("/api/collections", async () =>
    cfg.collections.map((c) => ({ ...c, ...summary(catalog.collectionItems(c.id)), sample: undefined, usedBy: usage(store, c.id) })),
  );

  app.get<{ Params: { id: string } }>("/api/sources/:id/facets", async (req, reply) => {
    if (!cfg.sources.some((s) => s.id === req.params.id)) return reply.code(404).send({ error: "No such source." });
    return catalog.facets(req.params.id);
  });

  /** What a (possibly unsaved) collection definition would contain. */
  app.post<{ Body: CollectionBody }>("/api/collections/preview", async (req) => {
    const col = cleanCollection("preview", req.body ?? {}) as unknown as CollectionCfg;
    return summary(catalog.itemsFor(col));
  });

  app.put<{ Params: { id: string }; Querystring: { create?: string }; Body: CollectionBody }>("/api/collections/:id", async (req, reply) => {
    const id = req.params.id;
    if (!ID_RE.test(id)) return reply.code(400).send({ error: "Name may only contain letters, numbers, - and _." });
    const exists = cfg.collections.some((c) => c.id === id);
    if (req.query.create === "1" && exists) return reply.code(409).send({ error: `A collection called "${id}" already exists.` });
    if (req.query.create !== "1" && !exists) return reply.code(404).send({ error: "No such collection." });
    if (!cfg.sources.some((s) => s.id === req.body?.source)) return reply.code(400).send({ error: "Pick a media source." });
    try {
      store.update((raw) => {
        raw.collections ??= [];
        const next = cleanCollection(id, req.body);
        const i = raw.collections.findIndex((c: { id: string }) => c.id === id);
        if (i >= 0) raw.collections[i] = next;
        else raw.collections.push(next);
      });
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
    return { ok: true, ...summary(catalog.collectionItems(id)) };
  });

  app.delete<{ Params: { id: string } }>("/api/collections/:id", async (req, reply) => {
    const used = usage(store, req.params.id);
    if (used.length) return reply.code(409).send({ error: `Used by ${used.join(", ")}. Change ${used.length > 1 ? "those" : "that"} first.` });
    try {
      store.update((raw) => {
        raw.collections = (raw.collections ?? []).filter((c: { id: string }) => c.id !== req.params.id);
      });
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
    return { ok: true };
  });

  // ---- image uploads (watermarks, logos) ----
  const uploads = join(dataDir, "uploads");
  mkdirSync(uploads, { recursive: true });
  const TYPES: Record<string, string> = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif" };
  const MIME: Record<string, string> = Object.fromEntries(Object.entries(TYPES).map(([m, e]) => [e, m]));

  app.addContentTypeParser(Object.keys(TYPES), { parseAs: "buffer", bodyLimit: 8 * 1024 * 1024 }, (_req, body, done) => done(null, body));

  app.post("/api/uploads", async (req, reply) => {
    const ext = TYPES[(req.headers["content-type"] ?? "").split(";")[0]];
    if (!ext || !Buffer.isBuffer(req.body)) return reply.code(400).send({ error: "Upload a PNG, JPEG, WebP or GIF image." });
    const name = createHash("sha1").update(req.body).digest("hex").slice(0, 16) + ext;
    const file = join(uploads, name);
    if (!existsSync(file)) writeFileSync(file, req.body);
    return { path: file.replace(/\\/g, "/"), url: `/uploads/${name}` };
  });

  app.get<{ Params: { name: string } }>("/uploads/:name", async (req, reply) => {
    const { name } = req.params;
    if (!/^[a-f0-9]{16}\.(png|jpg|webp|gif)$/.test(name) || !existsSync(join(uploads, name))) return reply.code(404).send();
    reply.type(MIME[extname(name)]).header("Cache-Control", "public, max-age=31536000, immutable").send(readFileSync(join(uploads, name)));
  });

  /** A channel's configured watermark image, wherever it lives (only images the config points at). */
  app.get<{ Params: { channel: string } }>("/api/channels/:channel/watermark", async (req, reply) => {
    const ch = cfg.channels.find((c) => c.id === req.params.channel);
    const img = ch?.watermark?.image;
    const mime = img ? MIME[extname(img).toLowerCase().replace(".jpeg", ".jpg")] : undefined;
    if (!img || !mime || !existsSync(img)) return reply.code(404).send();
    reply.type(mime).header("Cache-Control", "no-cache").send(readFileSync(img));
  });
}
