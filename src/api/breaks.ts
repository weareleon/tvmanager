import type { FastifyInstance } from "fastify";
import type { Catalog } from "../catalog/catalog";
import type { ConfigStore } from "../config";

const ID_RE = /^[a-z0-9][a-z0-9_-]*$/i;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const num = (v: unknown) => (v === "" || v == null || Number.isNaN(Number(v)) ? undefined : Number(v));

function cleanStyle(id: string, b: Any): Any {
  const out: Any = { id };
  if (str(b?.name)) out.name = str(b.name);
  out.slots = (Array.isArray(b?.slots) ? b.slots : []).map((s: Any, i: number) => {
    const slot: Any = { type: s.type === "upnext" ? "upnext" : "clips" };
    if (str(s.label)) slot.label = str(s.label);
    if (slot.type === "clips") {
      if (!str(s.collection)) throw new Error(`Slot ${i + 1}: pick a collection.`);
      slot.collection = str(s.collection);
      if (s.mode === "seconds") slot.seconds = num(s.seconds) ?? 60;
      else slot.count = num(s.count) ?? 1;
    } else {
      slot.seconds = num(s.seconds) ?? 6;
      if (str(s.background)) slot.background = str(s.background);
    }
    return slot;
  });
  if (!out.slots.length) throw new Error("Add at least one slot.");
  return out;
}

export function breakUsage(store: ConfigStore, id: string): string[] {
  return store.cfg.channels.filter((c) => c.breaks?.style === id).map((c) => c.name);
}

/** Rough length of a break: average clip length × count (or the time budget), plus cards. */
function estimate(store: ConfigStore, catalog: Catalog, slots: Any[]): { seconds: number; missing: string[] } {
  let seconds = 0;
  const missing: string[] = [];
  for (const s of slots) {
    if (s.type === "upnext") {
      seconds += s.seconds ?? 6;
      continue;
    }
    const items = catalog.collectionItems(s.collection);
    if (!items.length) {
      missing.push(s.collection);
      continue;
    }
    const avg = items.reduce((a, i) => a + i.duration, 0) / items.length;
    seconds += s.seconds ? Math.max(avg, s.seconds) : avg * (s.count ?? 1);
  }
  return { seconds: Math.round(seconds), missing };
}

export function breakRoutes(app: FastifyInstance, store: ConfigStore, catalog: Catalog): void {
  const cfg = store.cfg;

  app.get("/api/breaks", async () =>
    cfg.breaks.map((b) => ({ ...b, usedBy: breakUsage(store, b.id), estimate: estimate(store, catalog, b.slots) })),
  );

  app.post<{ Body: Any }>("/api/breaks/estimate", async (req, reply) => {
    try {
      return estimate(store, catalog, cleanStyle("x", req.body).slots);
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  app.put<{ Params: { id: string }; Querystring: { create?: string }; Body: Any }>("/api/breaks/:id", async (req, reply) => {
    const id = req.params.id;
    if (!ID_RE.test(id)) return reply.code(400).send({ error: "Name may only contain letters, numbers, - and _." });
    const exists = cfg.breaks.some((b) => b.id === id);
    if (req.query.create === "1" && exists) return reply.code(409).send({ error: `A break style called "${id}" already exists.` });
    if (req.query.create !== "1" && !exists) return reply.code(404).send({ error: "No such break style." });
    try {
      const next = cleanStyle(id, req.body);
      store.update((raw) => {
        raw.breaks ??= [];
        const i = raw.breaks.findIndex((b: Any) => b.id === id);
        if (i >= 0) raw.breaks[i] = next;
        else raw.breaks.push(next);
      });
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>("/api/breaks/:id", async (req, reply) => {
    const used = breakUsage(store, req.params.id);
    if (used.length) return reply.code(409).send({ error: `Used by ${used.join(", ")}. Change ${used.length > 1 ? "those channels" : "that channel"} first.` });
    try {
      store.update((raw) => {
        raw.breaks = (raw.breaks ?? []).filter((b: Any) => b.id !== req.params.id);
      });
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
    return { ok: true };
  });
}
