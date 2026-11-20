import { readdir, stat } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import type { SourceCfg } from "../config";
import type { MediaItem } from "../catalog/catalog";
import { hash, log } from "../util";
import { probe } from "./probe";

const VIDEO_EXT = new Set([".mkv", ".mp4", ".m4v", ".avi", ".mov", ".ts", ".m2ts", ".wmv", ".webm", ".mpg", ".mpeg", ".flv"]);

async function walk(dir: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (e) {
    log("local", `cannot read ${dir}: ${(e as Error).message}`);
    return;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) await walk(full, out);
    else if (e.isFile() && VIDEO_EXT.has(extname(e.name).toLowerCase())) out.push(full);
  }
}

const clean = (s: string) => s.replace(/[._]+/g, " ").replace(/\s+/g, " ").replace(/^[\s-]+|[\s-]+$/g, "").trim();

/** Pull show/season/episode/title out of names like "Show Name - S01E02 - Episode Title.mkv". */
export function describe(path: string): Pick<MediaItem, "title" | "show" | "season" | "episode"> {
  const base = basename(path, extname(path));
  const m = base.match(/^(.*?)[\s._-]*[Ss](\d{1,2})[Ee](\d{1,3})(?:[\s._-]+(.*))?$/);
  if (!m) return { title: clean(base) };
  let show = clean(m[1]);
  if (!show) {
    const parent = basename(dirname(path));
    show = /^season\s*\d+$/i.test(parent) ? basename(dirname(dirname(path))) : parent;
  }
  const season = Number(m[2]);
  const episode = Number(m[3]);
  const title = m[4] ? clean(m[4]) : `Episode ${episode}`;
  return { show, season, episode, title };
}

async function pool<T, R>(items: T[], size: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

export async function scanLocal(source: Extract<SourceCfg, { type: "local" }>, previous: MediaItem[], ffprobe: string): Promise<MediaItem[]> {
  const files: string[] = [];
  for (const p of source.paths) await walk(p, files);
  const byPath = new Map(previous.map((p) => [p.path, p]));
  let probed = 0;

  const results = await pool(files, 4, async (path): Promise<MediaItem | null> => {
    const st = await stat(path).catch(() => null);
    if (!st) return null;
    const old = byPath.get(path);
    // Items cached before chapters were recorded get probed once more.
    if (old && old.size === st.size && old.mtimeMs === st.mtimeMs && old.chapters) return { ...old, kind: old.kind ?? (old.show ? "episode" : "other") };
    const info = await probe(ffprobe, path);
    probed++;
    if (!info) {
      log("local", `skipping unreadable file: ${path}`);
      return null;
    }
    return {
      id: hash(`${source.id}:${path}`),
      sourceId: source.id,
      path,
      ...describe(path),
      kind: describe(path).show ? "episode" : "other",
      duration: info.duration,
      hasAudio: info.hasAudio,
      chapters: info.chapters,
      size: st.size,
      mtimeMs: st.mtimeMs,
    };
  });

  if (probed) log("local", `probed ${probed} new/changed files`);
  return results.filter((r): r is MediaItem => r !== null);
}
