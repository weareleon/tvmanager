import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ChannelCfg, Config } from "../config";
import { log, sleep } from "../util";
import type { StreamManager } from "./manager";

/**
 * HLS output, for players that prefer it (and Safari on iPhone/iPad, which can't play raw MPEG-TS).
 *
 * The first playlist request starts a small ffmpeg "segmenter" that joins the channel as one more
 * viewer and copies its stream into 4-second segments, with no re-encoding. It shuts down once
 * nobody has asked for the playlist or a segment for a while, which also lets the channel's
 * encoder stop if there are no other viewers.
 */

const IDLE_MS = 45_000;
const READY_TIMEOUT_MS = 25_000;
const SEGMENT_RE = /^seg_\d{5}\.ts$/;

interface Output {
  proc: ChildProcess;
  dir: string;
  lastAccess: number;
  detach: () => void;
}

export class HlsManager {
  private outputs = new Map<string, Output>();
  private root: string;

  constructor(
    private cfg: Config,
    private streams: StreamManager,
  ) {
    this.root = join(cfg.dataDir, "hls");
    rmSync(this.root, { recursive: true, force: true }); // leftovers from a previous run
    mkdirSync(this.root, { recursive: true });
    setInterval(() => this.reap(), 10_000).unref();
  }

  private start(ch: ChannelCfg): Output {
    const dir = join(this.root, ch.id);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const proc = spawn(
      this.cfg.ffmpeg.ffmpeg,
      [
        "-hide_banner", "-loglevel", "error", "-nostdin",
        "-f", "mpegts", "-i", "pipe:0",
        "-map", "0", "-c", "copy",
        "-f", "hls",
        "-hls_time", "4",
        "-hls_list_size", "8",
        "-hls_flags", "delete_segments+independent_segments+omit_endlist+temp_file",
        "-hls_segment_filename", "seg_%05d.ts",
        "index.m3u8",
      ],
      { cwd: dir, windowsHide: true, stdio: ["pipe", "ignore", "pipe"] },
    );
    let stderr = "";
    proc.stderr?.on("data", (d: Buffer) => (stderr = (stderr + d.toString()).slice(-1000)));
    proc.stdin?.on("error", () => {}); // EPIPE when the segmenter exits first; handled on close
    const out: Output = { proc, dir, lastAccess: Date.now(), detach: () => {} };
    out.detach = this.streams.addSink(ch, proc.stdin!, "HLS segmenter");
    proc.on("close", (code) => {
      out.detach();
      if (this.outputs.get(ch.id) === out) this.outputs.delete(ch.id);
      if (code && stderr.trim()) log(ch.id, `HLS segmenter exited ${code}: ${stderr.trim()}`);
    });
    this.outputs.set(ch.id, out);
    return out;
  }

  private stopOutput(id: string, out: Output): void {
    this.outputs.delete(id);
    out.detach();
    out.proc.stdin?.end();
    setTimeout(() => out.proc.kill(), 2000).unref();
  }

  private reap(): void {
    for (const [id, out] of this.outputs) {
      if (Date.now() - out.lastAccess > IDLE_MS) {
        log(id, "HLS idle, stopping segmenter");
        this.stopOutput(id, out);
      }
    }
  }

  /** The live playlist, starting the segmenter and waiting for the first segments if needed. */
  async playlist(ch: ChannelCfg): Promise<string | null> {
    const out = this.outputs.get(ch.id) ?? this.start(ch);
    out.lastAccess = Date.now();
    const file = join(out.dir, "index.m3u8");
    const deadline = Date.now() + READY_TIMEOUT_MS;
    // Hand out the playlist once it lists at least two segments, so players can start smoothly.
    while (Date.now() < deadline) {
      if (existsSync(file)) {
        const text = readFileSync(file, "utf8");
        if ((text.match(/#EXTINF/g) ?? []).length >= 2) return text;
      }
      if (out.proc.exitCode !== null) return null;
      await sleep(300);
    }
    return null;
  }

  /** Path of a segment file, or null. */
  segment(ch: ChannelCfg, name: string): string | null {
    const out = this.outputs.get(ch.id);
    if (!out || !SEGMENT_RE.test(name)) return null;
    out.lastAccess = Date.now();
    const p = join(out.dir, name);
    return existsSync(p) ? p : null;
  }

  active(): string[] {
    return [...this.outputs.keys()];
  }

  stopAll(): void {
    for (const [id, out] of this.outputs) this.stopOutput(id, out);
    try {
      for (const d of readdirSync(this.root)) rmSync(join(this.root, d), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}
