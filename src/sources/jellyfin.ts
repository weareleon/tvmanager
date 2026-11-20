import { existsSync } from "node:fs";
import type { MediaServerSourceCfg } from "../config";
import type { MediaItem } from "../catalog/catalog";
import { hash, log } from "../util";

/**
 * Jellyfin and Emby share the same API lineage, so one adapter serves both.
 * We import metadata (titles, episode numbers, runtimes) from the server, so no probing is needed,
 * and play either the file directly (fast, no load on the server) or the server's static stream.
 */

interface ServerItem {
  Id: string;
  Name: string;
  Type: string;
  SeriesName?: string;
  ParentIndexNumber?: number;
  IndexNumber?: number;
  RunTimeTicks?: number;
  Path?: string;
  LocationType?: string;
  Genres?: string[];
  MediaStreams?: { Type: string }[];
  Chapters?: { StartPositionTicks?: number }[];
}

interface VirtualFolder {
  Name: string;
  ItemId: string;
  CollectionType?: string;
}

const VIDEO_LIBRARY_TYPES = new Set(["movies", "tvshows", "musicvideos", "homevideos", "mixed", ""]);
const PAGE = 500;

export class MediaServerClient {
  private base: string;

  constructor(private src: MediaServerSourceCfg) {
    this.base = src.url.replace(/\/+$/, "");
  }

  private async get<T>(path: string, query: Record<string, string | number | undefined> = {}): Promise<T> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined) qs.set(k, String(v));
    const url = `${this.base}${path}${qs.size ? `?${qs}` : ""}`;
    const res = await fetch(url, {
      headers: {
        Accept: "application/json",
        "X-Emby-Token": this.src.apiKey,
        Authorization: `MediaBrowser Client="tvmanager", Device="tvmanager", DeviceId="tvmanager", Version="0.1.0", Token="${this.src.apiKey}"`,
      },
      signal: AbortSignal.timeout(60_000),
    });
    if (res.status === 401 || res.status === 403) throw new HttpError(res.status, "the server rejected the API key");
    if (!res.ok) throw new HttpError(res.status, `${res.status} ${res.statusText} for ${path}`);
    return (await res.json()) as T;
  }

  private async userId(): Promise<string> {
    if (this.src.userId) return this.src.userId;
    const users = await this.get<{ Id: string; Name: string; Policy?: { IsAdministrator?: boolean } }[]>("/Users");
    const u = users.find((x) => x.Policy?.IsAdministrator) ?? users[0];
    if (!u) throw new Error("server has no users");
    return u.Id;
  }

  private async libraries(): Promise<VirtualFolder[]> {
    const all = await this.get<VirtualFolder[]>("/Library/VirtualFolders");
    if (this.src.libraries?.length) {
      const want = new Set(this.src.libraries.map((l) => l.toLowerCase()));
      const picked = all.filter((l) => want.has(l.Name.toLowerCase()));
      const missing = this.src.libraries.filter((l) => !all.some((x) => x.Name.toLowerCase() === l.toLowerCase()));
      if (missing.length) log(this.src.id, `libraries not found on server: ${missing.join(", ")} (have: ${all.map((l) => l.Name).join(", ")})`);
      return picked;
    }
    return all.filter((l) => VIDEO_LIBRARY_TYPES.has((l.CollectionType ?? "").toLowerCase()));
  }

  /** Page through a library. Newer servers use /Items?userId=, older ones (and Emby) /Users/{id}/Items. */
  private async libraryItems(userId: string, libraryId: string): Promise<ServerItem[]> {
    const out: ServerItem[] = [];
    let legacy = false;
    for (let start = 0; ; start += PAGE) {
      const query = {
        ParentId: libraryId,
        Recursive: "true",
        IncludeItemTypes: "Movie,Episode,MusicVideo,Video",
        Fields: "Path,MediaStreams,Genres,Chapters",
        EnableImages: "false",
        EnableUserData: "false",
        StartIndex: start,
        Limit: PAGE,
      };
      let page: { Items: ServerItem[]; TotalRecordCount: number };
      if (!legacy) {
        try {
          page = await this.get("/Items", { ...query, UserId: userId });
        } catch (e) {
          if (!(e instanceof HttpError) || ![400, 404].includes(e.status)) throw e;
          legacy = true;
          page = await this.get(`/Users/${userId}/Items`, query);
        }
      } else {
        page = await this.get(`/Users/${userId}/Items`, query);
      }
      out.push(...page.Items);
      if (page.Items.length < PAGE || out.length >= page.TotalRecordCount) break;
    }
    return out;
  }

  private mapPath(p: string): string {
    for (const r of this.src.pathReplacements) {
      if (p.toLowerCase().startsWith(r.from.toLowerCase())) {
        p = r.to + p.slice(r.from.length);
        break;
      }
    }
    return p;
  }

  async scan(): Promise<MediaItem[]> {
    const userId = await this.userId();
    const libs = await this.libraries();
    const items: MediaItem[] = [];
    let streamed = 0;

    for (const lib of libs) {
      const raw = await this.libraryItems(userId, lib.ItemId);
      let count = 0;
      for (const it of raw) {
        if (it.LocationType === "Virtual" || !it.RunTimeTicks) continue; // missing episodes / unknown length
        const serverPath = it.Path ?? "";
        const local = serverPath ? this.mapPath(serverPath) : "";
        const useFile = this.src.playback === "file" || (this.src.playback === "auto" && !!local && existsSync(local));
        if (!useFile) streamed++;
        const isEpisode = it.Type === "Episode";
        items.push({
          id: hash(`${this.src.id}:${it.Id}`),
          sourceId: this.src.id,
          path: local || `${lib.Name}/${it.Name}`,
          input: useFile ? undefined : `${this.src.type}://${this.src.id}/${it.Id}`,
          title: it.Name,
          show: isEpisode ? it.SeriesName : undefined,
          season: isEpisode ? it.ParentIndexNumber : undefined,
          episode: isEpisode ? it.IndexNumber : undefined,
          duration: it.RunTimeTicks / 10_000_000,
          hasAudio: it.MediaStreams ? it.MediaStreams.some((s) => s.Type === "Audio") : true,
          library: lib.Name,
          kind: it.Type === "Movie" ? "movie" : isEpisode ? "episode" : "other",
          genres: it.Genres ?? [],
          chapters: (it.Chapters ?? []).map((c) => (c.StartPositionTicks ?? 0) / 10_000_000).filter((t) => t > 0),
          size: 0,
          mtimeMs: 0,
        });
        count++;
      }
      log(this.src.id, `library "${lib.Name}": ${count} items`);
    }
    if (streamed) log(this.src.id, `${streamed} items will stream from the server (file not reachable from this PC)`);
    return items;
  }

  /** Check the URL and key, and list the server's libraries (for the dashboard). */
  async test(): Promise<{ serverName: string; version: string; libraries: { name: string; type: string; video: boolean }[] }> {
    const info = await this.get<{ ServerName?: string; Version?: string }>("/System/Info");
    const libs = await this.get<VirtualFolder[]>("/Library/VirtualFolders");
    return {
      serverName: info.ServerName ?? "",
      version: info.Version ?? "",
      libraries: libs.map((l) => ({
        name: l.Name,
        type: l.CollectionType ?? "mixed",
        video: VIDEO_LIBRARY_TYPES.has((l.CollectionType ?? "").toLowerCase()),
      })),
    };
  }

  /** URL ffmpeg can read for a server item: the original file, served as-is (no server transcoding). */
  streamUrl(itemId: string): string {
    return `${this.base}/Videos/${itemId}/stream?static=true&api_key=${encodeURIComponent(this.src.apiKey)}`;
  }
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
