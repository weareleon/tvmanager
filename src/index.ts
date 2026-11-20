import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { AuthStore } from "./auth";
import { Catalog } from "./catalog/catalog";
import { ConfigStore } from "./config";
import { PlayoutService } from "./schedule/playout";
import { createServer } from "./server";
import { FONT_FILE } from "./stream/ffmpeg";
import { FONT_BOLD, FONT_MONO } from "./stream/graphics";
import { StreamManager } from "./stream/manager";
import { log } from "./util";

async function main() {
  const cfgPath = resolve(process.argv[2] ?? "config.json");
  if (!existsSync(cfgPath)) {
    // First run: start empty and let the dashboard do the rest.
    writeFileSync(cfgPath, JSON.stringify({ sources: [], collections: [], breaks: [], channels: [] }, null, 2) + "\n");
    log("main", `created ${cfgPath}; set everything up in the dashboard`);
  }
  const store = new ConfigStore(cfgPath);
  const cfg = store.cfg;

  for (const [name, bin] of [["ffmpeg", cfg.ffmpeg.ffmpeg], ["ffprobe", cfg.ffmpeg.ffprobe]] as const) {
    try {
      execFileSync(bin, ["-version"], { stdio: "ignore", windowsHide: true });
    } catch {
      log("main", `⚠ ${name} not found at "${bin}". Install ffmpeg (https://ffmpeg.org/download.html) and add it to PATH, or set "ffmpeg": { "${name}": "<full path>" } in config.json.`);
    }
  }

  const workDir = join(cfg.dataDir, "work");
  mkdirSync(workDir, { recursive: true });
  if (existsSync(cfg.ffmpeg.font)) copyFileSync(cfg.ffmpeg.font, join(workDir, FONT_FILE));
  else log("main", `font not found at ${cfg.ffmpeg.font}; slate text will not render`);
  // Bold and monospaced faces for graphics; fall back to the regular font if missing.
  for (const [src, name] of [[cfg.ffmpeg.fontBold, FONT_BOLD], [cfg.ffmpeg.fontMono, FONT_MONO]] as const) {
    const from = existsSync(src) ? src : cfg.ffmpeg.font;
    if (existsSync(from)) copyFileSync(from, join(workDir, name));
  }

  const catalog = new Catalog(cfg);
  catalog.load();
  const playout = new PlayoutService(cfg, catalog);
  catalog.onScanned = () => playout.ensureAll();
  playout.ensureAll();

  // Dashboard edits: rebuild source clients, then re-plan channels.
  store.onChange(() => {
    catalog.reloadSources();
    playout.ensureAll();
  });

  const streams = new StreamManager(cfg, playout, workDir, (p) => catalog.resolveInput(p));
  const auth = new AuthStore(cfg.dataDir);
  const app = createServer({ auth, store, cfg, catalog, playout, streams });
  await app.listen({ port: cfg.server.port, host: cfg.server.host });
  log("main", `ready on http://localhost:${cfg.server.port}  (dashboard: /, playlist: /iptv/channels.m3u, guide: /iptv/xmltv.xml)`);
  if (auth.needsSetup) {
    log("auth", `no account yet: open the dashboard to create one.`);
    log("auth", `setting up from another device? Setup code: ${auth.setupCode}`);
  }

  // Scan in the background so the dashboard is usable right away, even with a big library.
  const scanAll = () => void catalog.scan().catch((e) => log("catalog", (e as Error).message));
  scanAll();
  setInterval(scanAll, cfg.scanIntervalMinutes * 60_000);
  setInterval(() => playout.ensureAll(), 5 * 60_000);

  const shutdown = () => {
    streams.stopAll();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
