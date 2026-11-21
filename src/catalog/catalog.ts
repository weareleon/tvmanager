import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { CollectionCfg, Config } from "../config";
import { log, normPath } from "../util";
import { MediaServerClient } from "../sources/jellyfin";
import { PlexClient, plexClientId } from "../sources/plex";
import { scanLocal } from "../sources/local";

export interface MediaItem {
  id: string;
  sourceId: string;
  /** Real file path (or a "Library/Name" label when the server's path is unknown). Used for filters and sorting. */
  path: string;
  /** What to hand ffmpeg when it isn't `path`, e.g. "jellyfin://<source>/<itemId>". */
  input?: string;
  title: string;
  show?: string;
  season?: number;
  episode?: number;
  /** Seconds */
  duration: number;
  hasAudio: boolean;
  library?: string;
  kind?: "movie" | "episode" | "other";
  genres?: string[];
  /** Chapter start times in seconds (natural places for mid-roll breaks). */
  chapters?: number[];
  size: number;
  mtimeMs: number;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Shows grouped together in season/episode order; everything else by path. */
function compareItems(a: MediaItem, b: MediaItem): number {
  if (a.show && b.show) {
    return collator.compare(a.show, b.show) || (a.season ?? 0) - (b.season ?? 0) || (a.episode ?? 0) - (b.episode ?? 0) || collator.compare(a.path, b.path);
  }
  return collator.compare(a.path, b.path);
}

export interface SourceStatus {
  items: number;
  scanning: boolean;
  lastScan?: number;
  error?: string;
}

export class Catalog {
  private items = new Map<string, MediaItem>();
  private collectionCache = new Map<string, MediaItem[]>();
  private servers = new Map<string, MediaServerClient | PlexClient>();
  private scans = new Map<string, Promise<void>>();
  private status = new Map<string, SourceStatus>();
  private file: string;
  /** Bumped whenever the catalog's contents change, so playouts know to retry empty slots. */
  generation = 0;
  /** Called after any source finishes scanning successfully. */
  onScanned?: () => void;

  constructor(private cfg: Config) {
    this.file = join(cfg.dataDir, "catalog.json");
    this.reloadSources();
  }

  /** Call after sources change: rebuilds server clients and drops items of removed sources. */
  reloadSources(): void {
    this.servers.clear();
    for (const s of this.cfg.sources) {
      if (s.type === "jellyfin" || s.type === "emby") this.servers.set(s.id, new MediaServerClient(s));
      if (s.type === "plex") this.servers.set(s.id, new PlexClient(s, plexClientId(this.cfg.dataDir)));
    }
    const ids = new Set(this.cfg.sources.map((s) => s.id));
    let removed = 0;
    for (const [id, it] of this.items) {
      if (!ids.has(it.sourceId)) {
        this.items.delete(id);
        removed++;
      }
    }
    for (const id of this.status.keys()) if (!ids.has(id)) this.status.delete(id);
    this.collectionCache.clear();
    this.generation++;
    if (removed) this.save();
  }

  sourceStatus(id: string): SourceStatus {
    const s = this.status.get(id);
    const items = [...this.items.values()].filter((i) => i.sourceId === id).length;
    return { scanning: this.scans.has(id), ...s, items };
  }

  collectionCount(id: string): number {
    return this.collectionItems(id).length;
  }

  load(): void {
    if (!existsSync(this.file)) return;
    try {
      const list = JSON.parse(readFileSync(this.file, "utf8")) as MediaItem[];
      for (const it of list) this.items.set(it.id, it);
      log("catalog", `loaded ${this.items.size} cached items`);
    } catch (e) {
      log("catalog", "could not read cache, rescanning everything:", (e as Error).message);
    }
  }

  private save(): void {
    mkdirSync(this.cfg.dataDir, { recursive: true });
    writeFileSync(this.file, JSON.stringify([...this.items.values()]));
  }

  async scan(): Promise<void> {
    await Promise.all(this.cfg.sources.map((s) => this.scanSource(s.id)));
    for (const c of this.cfg.collections) {
      const n = this.collectionItems(c.id).length;
      log("catalog", `collection "${c.id}": ${n} items${n ? "" : " (check its filters)"}`);
    }
  }

  /** Scan one source. Concurrent calls for the same source share one scan. */
  scanSource(id: string): Promise<void> {
    const running = this.scans.get(id);
    if (running) return running;
    const p = this.doScan(id).finally(() => this.scans.delete(id));
    this.scans.set(id, p);
    return p;
  }

  private async doScan(id: string): Promise<void> {
    const source = this.cfg.sources.find((s) => s.id === id);
    if (!source) return;
    const started = Date.now();
    const previous = [...this.items.values()].filter((i) => i.sourceId === source.id);
    let found: MediaItem[];
    try {
      found = source.type === "local" ? await scanLocal(source, previous, this.cfg.ffmpeg.ffprobe) : await this.servers.get(source.id)!.scan(previous);
    } catch (e) {
      // Server down or misconfigured: keep what we had so channels keep running.
      const msg = (e as Error).message === "fetch failed" ? "could not reach the server" : (e as Error).message;
      this.status.set(id, { items: previous.length, scanning: false, lastScan: Date.now(), error: msg });
      log("catalog", `source "${source.id}" scan failed, keeping ${previous.length} cached items: ${msg}`);
      return;
    }
    // The source may have been removed or replaced while we were scanning.
    if (!this.cfg.sources.some((s) => s.id === id)) return;
    for (const p of previous) this.items.delete(p.id);
    for (const f of found) this.items.set(f.id, f);
    this.status.set(id, { items: found.length, scanning: false, lastScan: Date.now() });
    this.generation++;
    log("catalog", `source "${source.id}": ${found.length} items (${((Date.now() - started) / 1000).toFixed(1)}s)`);
    this.collectionCache.clear();
    this.save();
    this.onScanned?.();
  }

  /** Local paths play as-is; media-server references become authenticated stream URLs. */
  resolveInput(path: string): string {
    // jellyfin://<source>/<itemId>, emby://…, or plex://<source>/library/parts/<…>/file.ext
    const m = path.match(/^(jellyfin|emby|plex):\/\/([^/]+)\/(.+)$/);
    if (!m) return path;
    const server = this.servers.get(m[2]);
    if (!server) throw new Error(`media source "${m[2]}" is no longer configured`);
    return server.streamUrl(m[3]);
  }

  get(id: string): MediaItem | undefined {
    return this.items.get(id);
  }

  /** Items in a collection, sorted so episodes play in order. */
  collectionItems(id: string): MediaItem[] {
    const cached = this.collectionCache.get(id);
    if (cached) return cached;
    const col = this.cfg.collections.find((c) => c.id === id);
    if (!col) return [];
    const list = this.itemsFor(col);
    this.collectionCache.set(id, list);
    return list;
  }

  /** Evaluate a collection definition that may not be saved yet (dashboard preview). */
  itemsFor(col: CollectionCfg): MediaItem[] {
    return [...this.items.values()].filter((i) => i.sourceId === col.source && i.duration >= 1 && this.matches(col, i)).sort(compareItems);
  }

  /** Values to offer in the collection filter pickers for a source. */
  facets(sourceId: string): { libraries: string[]; shows: { name: string; episodes: number }[]; genres: string[]; folders: string[]; kinds: Record<string, number> } {
    const items = [...this.items.values()].filter((i) => i.sourceId === sourceId);
    const libraries = new Set<string>();
    const genres = new Set<string>();
    const folders = new Set<string>();
    const shows = new Map<string, number>();
    const kinds: Record<string, number> = { movie: 0, episode: 0, other: 0 };
    const source = this.cfg.sources.find((s) => s.id === sourceId);
    const roots = source?.type === "local" ? source.paths.map((r) => normPath(resolve(r))) : [];
    for (const i of items) {
      if (i.library) libraries.add(i.library);
      for (const g of i.genres ?? []) genres.add(g);
      if (i.show) shows.set(i.show, (shows.get(i.show) ?? 0) + 1);
      kinds[i.kind ?? "other"]++;
      // First-level subfolders of a local source, as folder suggestions.
      const p = normPath(i.path);
      const root = roots.find((r) => p.startsWith(r + "/"));
      if (root) {
        const rel = i.path.replace(/\\/g, "/").slice(root.length + 1).split("/");
        if (rel.length > 1) folders.add(rel[0]);
      }
    }
    const sort = (a: string, b: string) => collator.compare(a, b);
    return {
      libraries: [...libraries].sort(sort),
      shows: [...shows].map(([name, episodes]) => ({ name, episodes })).sort((a, b) => sort(a.name, b.name)),
      genres: [...genres].sort(sort),
      folders: [...folders].sort(sort),
      kinds,
    };
  }

  private matches(col: CollectionCfg, item: MediaItem): boolean {
    const p = normPath(item.path);
    if (col.match && !p.includes(col.match.toLowerCase())) return false;
    if (col.library && item.library?.toLowerCase() !== col.library.toLowerCase()) return false;
    if (col.kind && item.kind !== col.kind) return false;
    if (col.shows?.length && !col.shows.some((s) => s.toLowerCase() === item.show?.toLowerCase())) return false;
    if (col.genres?.length) {
      const g = new Set((item.genres ?? []).map((x) => x.toLowerCase()));
      if (!col.genres.some((x) => g.has(x.toLowerCase()))) return false;
    }
    if (col.folder) {
      const source = this.cfg.sources.find((s) => s.id === col.source);
      const roots = isAbsolute(col.folder)
        ? [col.folder]
        : (source?.type === "local" ? source.paths : []).map((r) => join(r, col.folder!));
      if (!roots.some((r) => p.startsWith(normPath(resolve(r)) + "/"))) return false;
    }
    return true;
  }
}
