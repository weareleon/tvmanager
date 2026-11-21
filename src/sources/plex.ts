import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PlexSourceCfg } from "../config";
import type { MediaItem } from "../catalog/catalog";
import { hash, log } from "../util";

/**
 * Plex as a media source.
 *
 * Sign-in uses Plex's PIN flow (the same one Plex's own apps use): we ask plex.tv for a PIN,
 * the user approves it at app.plex.tv, and we receive a token, then list their servers and
 * the addresses each one can be reached at. A Plex token grants access to the whole account,
 * so it only ever lives in config.json and in stream URLs built at play time.
 */

const PRODUCT = "tvmanager";

/** A stable client ID for this install, so plex.tv shows one "tvmanager" device, not one per sign-in. */
export function plexClientId(dataDir: string): string {
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, "plex-client.json");
  if (existsSync(file)) {
    try {
      return JSON.parse(readFileSync(file, "utf8")).clientId;
    } catch {
      /* regenerate */
    }
  }
  const clientId = randomUUID();
  writeFileSync(file, JSON.stringify({ clientId }, null, 2));
  return clientId;
}

const plexHeaders = (clientId: string, token?: string): Record<string, string> => ({
  Accept: "application/json",
  "X-Plex-Product": PRODUCT,
  "X-Plex-Client-Identifier": clientId,
  "X-Plex-Version": "1.3.0",
  "X-Plex-Device-Name": "tvmanager",
  ...(token ? { "X-Plex-Token": token } : {}),
});

// ---------------- sign-in (plex.tv) ----------------

export interface PlexServer {
  name: string;
  machineId: string;
  owned: boolean;
  /** Addresses to try, best first. */
  connections: { uri: string; local: boolean; relay: boolean }[];
  /** Token for this server (for shared servers it differs from the account token). */
  accessToken: string;
}

export async function createPin(clientId: string): Promise<{ id: number; code: string; authUrl: string }> {
  const res = await fetch("https://plex.tv/api/v2/pins?strong=true", { method: "POST", headers: plexHeaders(clientId) });
  if (!res.ok) throw new Error(`plex.tv answered ${res.status}`);
  const pin = (await res.json()) as { id: number; code: string };
  const params = new URLSearchParams({ clientID: clientId, code: pin.code, "context[device][product]": PRODUCT });
  return { id: pin.id, code: pin.code, authUrl: `https://app.plex.tv/auth#?${params}` };
}

/** The account token once the user has approved the PIN, or null while waiting. */
export async function checkPin(clientId: string, id: number): Promise<string | null> {
  const res = await fetch(`https://plex.tv/api/v2/pins/${id}`, { headers: plexHeaders(clientId) });
  if (res.status === 404) throw new Error("This sign-in expired. Start again.");
  if (!res.ok) throw new Error(`plex.tv answered ${res.status}`);
  const pin = (await res.json()) as { authToken?: string | null };
  return pin.authToken || null;
}

export async function listServers(clientId: string, token: string): Promise<PlexServer[]> {
  const res = await fetch("https://plex.tv/api/v2/resources?includeHttps=1&includeRelay=1", { headers: plexHeaders(clientId, token) });
  if (!res.ok) throw new Error(`plex.tv answered ${res.status}`);
  const all = (await res.json()) as {
    name: string;
    clientIdentifier: string;
    provides: string;
    owned: boolean;
    accessToken: string;
    connections: { uri: string; local: boolean; relay: boolean; address: string; port: number; protocol: string }[];
  }[];
  return all
    .filter((r) => r.provides.split(",").includes("server"))
    .map((r) => {
      const conns = r.connections.map((c) => ({ uri: c.uri, local: c.local, relay: c.relay }));
      // Plain-HTTP local addresses too (plex.direct HTTPS names need internet DNS).
      for (const c of r.connections) if (c.local && !c.relay) conns.push({ uri: `http://${c.address}:${c.port}`, local: true, relay: false });
      const rank = (c: { local: boolean; relay: boolean }) => (c.relay ? 2 : c.local ? 0 : 1);
      return {
        name: r.name,
        machineId: r.clientIdentifier,
        owned: r.owned,
        accessToken: r.accessToken,
        connections: [...new Map(conns.map((c) => [c.uri, c])).values()].sort((a, b) => rank(a) - rank(b)),
      };
    });
}

/**
 * The first address that actually answers, trying this PC first (fastest, works offline),
 * then local network addresses, then remote, then Plex's relay.
 */
export async function pickConnection(clientId: string, server: PlexServer): Promise<string | null> {
  const candidates = ["http://127.0.0.1:32400", ...server.connections.map((c) => c.uri)];
  for (const uri of candidates) {
    try {
      const res = await fetch(`${uri}/identity`, { headers: plexHeaders(clientId), signal: AbortSignal.timeout(3000) });
      if (!res.ok) continue;
      const id = (await res.json()) as { MediaContainer?: { machineIdentifier?: string } };
      if (id.MediaContainer?.machineIdentifier === server.machineId) return uri;
    } catch {
      /* try the next one */
    }
  }
  return null;
}

// ---------------- library access ----------------

interface PlexPart {
  key: string;
  file?: string;
}
interface PlexMeta {
  ratingKey: string;
  type: string;
  title: string;
  grandparentTitle?: string;
  grandparentRatingKey?: string;
  parentIndex?: number;
  index?: number;
  duration?: number;
  Genre?: { tag: string }[];
  Media?: { audioChannels?: number; audioCodec?: string; Part?: PlexPart[] }[];
  Chapter?: { startTimeOffset?: number }[];
}

const PAGE = 500;
const VIDEO_TYPES = new Set(["movie", "show"]);

export class PlexClient {
  private base: string;

  constructor(
    private src: PlexSourceCfg,
    private clientId: string,
  ) {
    this.base = src.url.replace(/\/+$/, "");
  }

  private async get<T>(path: string, query: Record<string, string | number> = {}): Promise<T> {
    const qs = new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)]));
    const res = await fetch(`${this.base}${path}${qs.size ? `?${qs}` : ""}`, {
      headers: plexHeaders(this.clientId, this.src.token),
      signal: AbortSignal.timeout(60_000),
    });
    if (res.status === 401) throw new Error("Plex rejected the sign-in. Sign in with Plex again.");
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${path}`);
    return (await res.json()) as T;
  }

  private async sections(): Promise<{ key: string; title: string; type: string }[]> {
    const r = await this.get<{ MediaContainer: { Directory?: { key: string; title: string; type: string }[] } }>("/library/sections");
    return r.MediaContainer.Directory ?? [];
  }

  async test(): Promise<{ serverName: string; version: string; libraries: { name: string; type: string; video: boolean }[] }> {
    const root = await this.get<{ MediaContainer: { friendlyName?: string; version?: string } }>("/");
    const secs = await this.sections();
    return {
      serverName: root.MediaContainer.friendlyName ?? "Plex",
      version: root.MediaContainer.version ?? "",
      libraries: secs.map((s) => ({ name: s.title, type: s.type, video: VIDEO_TYPES.has(s.type) })),
    };
  }

  private async all(sectionKey: string, type: number): Promise<PlexMeta[]> {
    const out: PlexMeta[] = [];
    for (let start = 0; ; start += PAGE) {
      const r = await this.get<{ MediaContainer: { Metadata?: PlexMeta[]; totalSize?: number } }>(`/library/sections/${sectionKey}/all`, {
        type,
        "X-Plex-Container-Start": start,
        "X-Plex-Container-Size": PAGE,
      });
      const page = r.MediaContainer.Metadata ?? [];
      out.push(...page);
      if (page.length < PAGE || (r.MediaContainer.totalSize !== undefined && out.length >= r.MediaContainer.totalSize)) break;
    }
    return out;
  }

  private mapPath(p: string): string {
    for (const r of this.src.pathReplacements) {
      if (p.toLowerCase().startsWith(r.from.toLowerCase())) return r.to + p.slice(r.from.length);
    }
    return p;
  }

  /** Chapter marks for one item (Plex only returns them per item). */
  private async chapters(ratingKey: string): Promise<number[]> {
    const r = await this.get<{ MediaContainer: { Metadata?: PlexMeta[] } }>(`/library/metadata/${ratingKey}`, { includeChapters: 1 });
    return (r.MediaContainer.Metadata?.[0]?.Chapter ?? []).map((c) => (c.startTimeOffset ?? 0) / 1000).filter((t) => t > 0);
  }

  async scan(previous: MediaItem[]): Promise<MediaItem[]> {
    const want = this.src.libraries?.map((l) => l.toLowerCase());
    const secs = (await this.sections()).filter((s) => VIDEO_TYPES.has(s.type) && (!want || want.includes(s.title.toLowerCase())));
    if (want) {
      const missing = this.src.libraries!.filter((l) => !secs.some((s) => s.title.toLowerCase() === l.toLowerCase()));
      if (missing.length) log(this.src.id, `libraries not found on Plex: ${missing.join(", ")}`);
    }
    const prevChapters = new Map(previous.map((p) => [p.id, p.chapters]));
    const items: MediaItem[] = [];
    const ratingKeyOf = new Map<string, string>();
    let streamed = 0;

    for (const sec of secs) {
      const isShow = sec.type === "show";
      // Plex keeps genres on the show, not the episode.
      const showGenres = new Map<string, string[]>();
      if (isShow) for (const s of await this.all(sec.key, 2)) showGenres.set(s.ratingKey, (s.Genre ?? []).map((g) => g.tag));
      const raw = await this.all(sec.key, isShow ? 4 : 1);
      let count = 0;
      for (const m of raw) {
        const part = m.Media?.[0]?.Part?.[0];
        if (!part || !m.duration) continue;
        const local = part.file ? this.mapPath(part.file) : "";
        const useFile = this.src.playback === "file" || (this.src.playback === "auto" && !!local && existsSync(local));
        if (!useFile) streamed++;
        const id = hash(`${this.src.id}:${m.ratingKey}`);
        ratingKeyOf.set(id, m.ratingKey);
        const media = m.Media?.[0];
        items.push({
          id,
          sourceId: this.src.id,
          path: local || `${sec.title}/${m.title}`,
          input: useFile ? undefined : `plex://${this.src.id}${part.key}`,
          title: m.title,
          show: isShow ? m.grandparentTitle : undefined,
          season: isShow ? m.parentIndex : undefined,
          episode: isShow ? m.index : undefined,
          duration: m.duration / 1000,
          hasAudio: media ? !!(media.audioChannels || media.audioCodec) : true,
          library: sec.title,
          kind: isShow ? "episode" : "movie",
          genres: isShow ? (showGenres.get(m.grandparentRatingKey ?? "") ?? []) : (m.Genre ?? []).map((g) => g.tag),
          chapters: prevChapters.get(id),
          size: 0,
          mtimeMs: 0,
        });
        count++;
      }
      log(this.src.id, `library "${sec.title}": ${count} items`);
    }
    if (streamed) log(this.src.id, `${streamed} items will stream from Plex (file not reachable from this PC)`);

    // Chapters need one request per item, so fetch the missing ones a few at a time.
    // Only long items matter: mid-roll breaks never cut short ones.
    const need = items.filter((i) => !i.chapters && i.duration >= 15 * 60);
    let next = 0;
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        while (next < need.length) {
          const it = need[next++];
          const key = ratingKeyOf.get(it.id);
          if (!key) continue;
          it.chapters = await this.chapters(key).catch(() => []);
        }
      }),
    );
    for (const i of items) i.chapters ??= [];
    return items;
  }

  /** Original file from Plex, no transcoding. `ref` is the part key, e.g. /library/parts/12/345/file.mkv */
  streamUrl(ref: string): string {
    const path = ref.startsWith("/") ? ref : `/${ref}`;
    return `${this.base}${path}?X-Plex-Token=${encodeURIComponent(this.src.token)}`;
  }
}
