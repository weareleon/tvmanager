import { existsSync, statSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import type { Catalog } from "../catalog/catalog";
import type { ConfigStore, MediaServerSourceCfg, PlexSourceCfg } from "../config";
import { MediaServerClient } from "../sources/jellyfin";
import { checkPin, createPin, listServers, pickConnection, PlexClient, plexClientId, type PlexServer } from "../sources/plex";

interface Body {
  type?: string;
  id?: string;
  url?: string;
  apiKey?: string;
  /** Plex: the finished sign-in to take the token from, and which server. */
  signIn?: string;
  machineId?: string;
  userId?: string;
  libraries?: string[] | null;
  playback?: string;
  pathReplacements?: { from: string; to: string }[];
  paths?: string[];
}

class BadRequest extends Error {}

const ID_RE = /^[a-z0-9][a-z0-9_-]*$/i;

/**
 * Plex sign-ins in progress or just finished, kept server-side so Plex tokens never reach the
 * browser: the form only sees server names and refers to the sign-in by its PIN id.
 */
interface SignIn {
  created: number;
  servers?: (PlexServer & { url: string | null })[];
}
const signIns = new Map<string, SignIn>();
const SIGN_IN_TTL = 30 * 60_000;
function pruneSignIns() {
  for (const [k, v] of signIns) if (Date.now() - v.created > SIGN_IN_TTL) signIns.delete(k);
}

/** Extra settings shared by media-server sources. */
function common(b: Body, existing: Record<string, unknown> | undefined, raw: Record<string, unknown>) {
  if (b.libraries === undefined && existing?.libraries) raw.libraries = existing.libraries;
  else if (b.libraries?.length) raw.libraries = b.libraries;
  if (b.playback && b.playback !== "auto") raw.playback = b.playback;
  const repl = (b.pathReplacements ?? []).filter((r) => r.from?.trim() && r.to?.trim());
  if (repl.length) raw.pathReplacements = repl;
  return raw;
}

/** Build the JSON written to config.json from a dashboard form, keeping only known fields. */
function toRaw(b: Body, existing: Record<string, unknown> | undefined): Record<string, unknown> {
  const type = b.type;
  if (type === "local") {
    const paths = (b.paths ?? []).map((p) => p.trim()).filter(Boolean);
    if (!paths.length) throw new BadRequest("Add at least one folder.");
    return { type, id: b.id, paths };
  }
  if (type === "plex") {
    let url = existing?.url as string | undefined;
    let token = existing?.token as string | undefined;
    let serverName = existing?.serverName as string | undefined;
    let machineId = existing?.machineId as string | undefined;
    if (b.signIn) {
      const s = signIns.get(b.signIn)?.servers?.find((x) => x.machineId === b.machineId);
      if (!s) throw new BadRequest("That Plex sign-in has expired. Sign in with Plex again.");
      if (!s.url) throw new BadRequest(`tvmanager can't reach "${s.name}". Is it running and on this network?`);
      ({ url, accessToken: token, name: serverName, machineId } = { ...s, url: s.url });
    }
    if (!url || !token) throw new BadRequest("Sign in with Plex and pick a server first.");
    return common(b, existing, { type, id: b.id, url, token, serverName, machineId });
  }
  if (type !== "jellyfin" && type !== "emby") throw new BadRequest("Unknown source type.");
  const apiKey = b.apiKey?.trim() || (existing?.apiKey as string | undefined);
  if (!apiKey) throw new BadRequest("An API key is required.");
  const raw: Record<string, unknown> = { type, id: b.id, url: (b.url ?? "").trim().replace(/\/+$/, ""), apiKey };
  if (b.userId?.trim()) raw.userId = b.userId.trim();
  return common(b, existing, raw);
}

export function sourceRoutes(app: FastifyInstance, store: ConfigStore, catalog: Catalog): void {
  const cfg = store.cfg;

  app.get("/api/sources", async () =>
    cfg.sources.map((s) => {
      // Never send credentials to the browser.
      const { apiKey: _key, token: _token, ...safe } = s as typeof s & { apiKey?: string; token?: string };
      return {
        ...safe,
        hasApiKey: ("apiKey" in s && !!s.apiKey) || ("token" in s && !!s.token),
        status: catalog.sourceStatus(s.id),
        usedBy: cfg.collections.filter((c) => c.source === s.id).map((c) => ({ id: c.id, items: catalog.collectionCount(c.id) })),
      };
    }),
  );

  // ---- Sign in with Plex (PIN flow) ----
  const clientId = plexClientId(cfg.dataDir);

  app.post("/api/plex/signin", async (_req, reply) => {
    pruneSignIns();
    try {
      const pin = await createPin(clientId);
      signIns.set(String(pin.id), { created: Date.now() });
      return { signIn: String(pin.id), authUrl: pin.authUrl };
    } catch (e) {
      return reply.code(502).send({ error: `Couldn't reach plex.tv: ${(e as Error).message}` });
    }
  });

  /** Poll: { done: false } until approved, then the account's servers (names and reachability only). */
  app.get<{ Params: { id: string } }>("/api/plex/signin/:id", async (req, reply) => {
    const s = signIns.get(req.params.id);
    if (!s) return reply.code(404).send({ error: "That sign-in expired. Start again." });
    if (!s.servers) {
      let token: string | null;
      try {
        token = await checkPin(clientId, Number(req.params.id));
      } catch (e) {
        return reply.code(400).send({ error: (e as Error).message });
      }
      if (!token) return { done: false };
      const servers = await listServers(clientId, token);
      s.servers = await Promise.all(servers.map(async (srv) => ({ ...srv, url: await pickConnection(clientId, srv) })));
    }
    return {
      done: true,
      servers: s.servers.map((x) => ({ machineId: x.machineId, name: x.name, owned: x.owned, reachable: !!x.url, url: x.url })),
    };
  });

  /** Try the settings in the form without saving them. */
  app.post<{ Body: Body }>("/api/sources/test", async (req, reply) => {
    const b = req.body ?? {};
    if (b.type === "plex") {
      const existing = cfg.sources.find((s) => s.id === b.id && s.type === "plex") as PlexSourceCfg | undefined;
      const picked = b.signIn ? signIns.get(b.signIn)?.servers?.find((x) => x.machineId === b.machineId) : undefined;
      const url = picked?.url ?? existing?.url;
      const token = picked?.accessToken ?? existing?.token;
      if (!url || !token) return reply.code(400).send({ error: "Sign in with Plex and pick a server first." });
      try {
        const client = new PlexClient({ type: "plex", id: b.id || "test", url, token, playback: "auto", pathReplacements: [] }, clientId);
        return { ok: true, ...(await client.test()) };
      } catch (e) {
        const msg = (e as Error).message;
        return reply.code(400).send({ error: msg === "fetch failed" ? `Could not reach Plex at ${url}` : `Connection failed: ${msg}` });
      }
    }
    if (b.type === "local") {
      const results = (b.paths ?? []).filter((p) => p.trim()).map((p) => {
        const ok = existsSync(p) && statSync(p).isDirectory();
        return { path: p, ok };
      });
      return { ok: results.length > 0 && results.every((r) => r.ok), folders: results };
    }
    const existing = cfg.sources.find((s) => s.id === b.id) as MediaServerSourceCfg | undefined;
    const apiKey = b.apiKey?.trim() || existing?.apiKey;
    if (!b.url || !apiKey) return reply.code(400).send({ error: "Enter the server URL and API key first." });
    const client = new MediaServerClient({
      type: b.type === "emby" ? "emby" : "jellyfin",
      id: b.id || "test",
      url: b.url,
      apiKey,
      playback: "auto",
      pathReplacements: [],
    });
    try {
      return { ok: true, ...(await client.test()) };
    } catch (e) {
      const msg = (e as Error).message;
      return reply.code(400).send({ error: msg === "fetch failed" ? `Could not reach ${b.url}` : `Connection failed: ${msg}` });
    }
  });

  /** Create (with ?create=1) or update a source, then scan it. */
  app.put<{ Params: { id: string }; Querystring: { create?: string }; Body: Body }>("/api/sources/:id", async (req, reply) => {
    const id = req.params.id;
    const creating = req.query.create === "1";
    if (!ID_RE.test(id)) return reply.code(400).send({ error: "Name may only contain letters, numbers, - and _." });
    const exists = cfg.sources.some((s) => s.id === id);
    if (creating && exists) return reply.code(409).send({ error: `A source called "${id}" already exists.` });
    if (!creating && !exists) return reply.code(404).send({ error: "No such source." });

    try {
      store.update((raw) => {
        raw.sources ??= [];
        const i = raw.sources.findIndex((s: { id: string }) => s.id === id);
        const next = toRaw({ ...req.body, id }, i >= 0 ? raw.sources[i] : undefined);
        if (i >= 0) {
          if (raw.sources[i].type !== next.type) throw new BadRequest("A source's type can't be changed; add a new source instead.");
          raw.sources[i] = next;
        } else raw.sources.push(next);
      });
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
    void catalog.scanSource(id);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/sources/:id/scan", async (req, reply) => {
    if (!cfg.sources.some((s) => s.id === req.params.id)) return reply.code(404).send({ error: "No such source." });
    void catalog.scanSource(req.params.id);
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>("/api/sources/:id", async (req, reply) => {
    const id = req.params.id;
    const used = cfg.collections.filter((c) => c.source === id).map((c) => c.id);
    if (used.length) return reply.code(409).send({ error: `Still used by collection${used.length > 1 ? "s" : ""} ${used.join(", ")}. Remove or change those first.` });
    try {
      store.update((raw) => {
        raw.sources = (raw.sources ?? []).filter((s: { id: string }) => s.id !== id);
      });
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
    return { ok: true };
  });
}
