import { readFile } from "node:fs/promises";

export interface M3UEntry {
  name: string;
  attrs: Record<string, string>;
  url: string;
}

export function parseM3U(text: string): M3UEntry[] {
  const out: M3UEntry[] = [];
  let pending: Omit<M3UEntry, "url"> | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#EXTINF")) {
      const attrs: Record<string, string> = {};
      for (const m of line.matchAll(/([\w-]+)="([^"]*)"/g)) attrs[m[1].toLowerCase()] = m[2];
      const comma = line.lastIndexOf(",");
      pending = { name: comma >= 0 ? line.slice(comma + 1).trim() : "", attrs };
    } else if (!line.startsWith("#") && pending) {
      out.push({ ...pending, url: line });
      pending = null;
    }
  }
  return out;
}

const cache = new Map<string, { at: number; entries: M3UEntry[] }>();

/** Turn a restream config into a playable URL, looking the channel up in an M3U playlist if needed. */
export async function resolveLive(source: string, channel?: string): Promise<string> {
  if (!channel) return source;
  let hit = cache.get(source);
  if (!hit || Date.now() - hit.at > 10 * 60_000) {
    const text = /^https?:/i.test(source) ? await (await fetch(source)).text() : await readFile(source, "utf8");
    hit = { at: Date.now(), entries: parseM3U(text) };
    cache.set(source, hit);
  }
  const want = channel.toLowerCase();
  const e = hit.entries.find(
    (x) => x.attrs["tvg-id"]?.toLowerCase() === want || x.attrs["tvg-name"]?.toLowerCase() === want || x.name.toLowerCase() === want,
  );
  if (!e) throw new Error(`channel "${channel}" not found in playlist ${source}`);
  return e.url;
}
