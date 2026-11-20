import { spawn, type ChildProcess } from "node:child_process";
import type { ServerResponse } from "node:http";
import type { ChannelCfg, Config } from "../config";
import type { PlayoutItem, PlayoutService } from "../schedule/playout";
import { hhmm, log, sleep } from "../util";
import { nextEvent } from "../schedule/resolve";
import { buildArgs, type RenderJob } from "./ffmpeg";
import type { GfxContext } from "./graphics";
import { resolveLive } from "./m3u";

const TS_PACKET = 188;
const MAX_CLIENT_BACKLOG = 32 * 1024 * 1024;
/** Start the next item's encoder this long before the current one ends, so there's no gap. */
const PRESTART_MS = 2000;

/** Turns a playout item's stored input into something ffmpeg can open (e.g. a media server URL). */
export type InputResolver = (path: string) => string;

/** One ffmpeg process. Output is held back until attach(), so it can be started ahead of time. */
class Encoder {
  readonly startedAt = Date.now();
  bytes = 0;
  private held: Buffer[] = [];
  private attached = false;
  private child: ChildProcess | null;
  readonly done: Promise<number | null>;

  constructor(
    bin: string,
    args: string[],
    cwd: string,
    private sink: (chunk: Buffer, offset: number) => void,
    onError: (msg: string) => void,
  ) {
    let stderr = "";
    const child = spawn(bin, args, { cwd, windowsHide: true });
    this.child = child;
    child.stdout.on("data", (chunk: Buffer) => {
      if (this.attached) this.emit(chunk);
      else this.held.push(chunk);
    });
    child.stderr.on("data", (d: Buffer) => (stderr = (stderr + d.toString()).slice(-2000)));
    this.done = new Promise((resolve) => {
      child.on("error", (e) => {
        onError(`could not start ffmpeg: ${e.message}`);
        resolve(null);
      });
      child.on("close", (code) => {
        this.child = null;
        if (code !== 0 && code !== null && stderr.trim()) onError(`ffmpeg exited ${code}: ${redact(stderr.trim())}`);
        resolve(code);
      });
    });
  }

  private emit(chunk: Buffer): void {
    this.sink(chunk, this.bytes);
    this.bytes += chunk.length;
  }

  attach(): void {
    this.attached = true;
    for (const c of this.held) this.emit(c);
    this.held = [];
  }

  kill(): void {
    this.child?.kill("SIGKILL");
  }
}

/** Keep API keys out of logs. */
const redact = (s: string) => s.replace(/(api_key|X-Plex-Token|token)=[^&\s"']+/gi, "$1=***");

interface Playing {
  item: PlayoutItem;
  enc: Encoder;
}

/**
 * One running encoder chain for one channel, shared by every viewer of that channel.
 * Each playout item gets its own ffmpeg process; the next one is started a couple of
 * seconds early and its output is spliced in the moment the current one finishes.
 * Output timestamps come from the schedule, so the joined stream is continuous.
 */
export class ChannelSession {
  private clients = new Set<ServerResponse>();
  /** Clients that joined mid-chunk and are waiting for a TS packet boundary. */
  private joining = new Set<ServerResponse>();
  private encoders = new Set<Encoder>();
  private running = false;
  private startedAt = 0;
  private jobCounter = 0;
  idleTimer: NodeJS.Timeout | null = null;
  readonly id: string;
  private lastCfg: ChannelCfg;

  constructor(
    ch: ChannelCfg,
    private cfg: Config,
    private playout: PlayoutService,
    private workDir: string,
    private resolveInput: InputResolver,
  ) {
    this.id = ch.id;
    this.lastCfg = ch;
  }

  /** Always the channel's current config, so dashboard edits (e.g. watermark) apply from the next item on. */
  get ch(): ChannelCfg {
    const cur = this.cfg.channels.find((c) => c.id === this.id);
    if (cur) this.lastCfg = cur;
    return this.lastCfg;
  }

  get viewers(): number {
    return this.clients.size + this.joining.size;
  }

  add(res: ServerResponse): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.joining.add(res);
    if (!this.running) void this.run();
  }

  remove(res: ServerResponse): void {
    this.clients.delete(res);
    this.joining.delete(res);
  }

  stop(): void {
    this.running = false;
    for (const e of this.encoders) e.kill();
    for (const c of [...this.clients, ...this.joining]) c.end();
    this.clients.clear();
    this.joining.clear();
    log(this.ch.id, "encoder stopped");
  }

  private async run(): Promise<void> {
    this.running = true;
    this.startedAt = Date.now();
    log(this.ch.id, "encoder started");
    let failures = 0;
    let cur: Playing | null = null;

    while (this.running) {
      try {
        if (!cur) {
          cur = await this.startAt(Date.now());
          if (!cur) {
            await sleep(500);
            continue;
          }
          cur.enc.attach();
        }

        // Wait until it's time to pre-start the next item, or the current one ends early.
        const prestartAt = cur.item.end - PRESTART_MS;
        const endedEarly = await Promise.race([cur.enc.done.then(() => true), sleep(prestartAt - Date.now()).then(() => false)]);
        if (!this.running) break;

        if (endedEarly && Date.now() < prestartAt - 1000) {
          // Broken file, unreachable stream, etc. Cover the rest of the slot instead of retrying.
          failures++;
          if (failures > 2) await sleep(1000);
          log(this.ch.id, `"${cur.item.title}" stopped early, showing a slate until ${hhmm(cur.item.end)}`);
          const slate: PlayoutItem = { ...cur.item, kind: "slate" };
          cur = { item: slate, enc: this.spawn(this.slateJob(slate, Date.now(), [this.ch.name, "We'll be right back"])) };
          cur.enc.attach();
          continue;
        }
        failures = 0;

        const now = Date.now();
        let nextItem = this.playout.itemStartingAt(this.ch, cur.item.end);
        if (!nextItem || nextItem.end <= now) nextItem = this.playout.itemAt(this.ch, Math.max(now, cur.item.end));
        const next = nextItem ? await this.startItem(nextItem, now) : null;

        await cur.enc.done;
        this.encoders.delete(cur.enc);
        if (!this.running) {
          next?.enc.kill();
          break;
        }
        next?.enc.attach();
        cur = next;
      } catch (e) {
        log(this.ch.id, "error:", (e as Error).message);
        cur?.enc.kill();
        cur = null;
        await sleep(1000);
      }
    }
  }

  private async startAt(now: number): Promise<Playing | null> {
    const item = this.playout.itemAt(this.ch, now);
    return item ? this.startItem(item, now) : null;
  }

  /** Start encoding `item` (from the right offset if we're already into it). Output is held until attach(). */
  private async startItem(item: PlayoutItem, now: number): Promise<Playing> {
    const seekMs = Math.max(0, now - item.start);
    let job: RenderJob;
    try {
      job = await this.jobFor(item, seekMs);
    } catch (e) {
      log(this.ch.id, `cannot play "${item.title}": ${(e as Error).message}`);
      job = this.slateJob(item, item.start + seekMs, [this.ch.name, "We'll be right back"]);
    }
    log(this.ch.id, `▶ ${hhmm(item.start)} ${item.kind} "${item.title}${item.subtitle ? ` — ${item.subtitle}` : ""}"${seekMs > 1000 ? ` (joining ${Math.round(seekMs / 1000)}s in)` : ""}`);
    return { item, enc: this.spawn(job) };
  }

  private timing(item: PlayoutItem, seekMs: number) {
    return {
      seek: seekMs / 1000,
      // End a hair early: encoders (esp. AAC) overshoot -t slightly, and overlapping the next
      // item's first frame would make timestamps step backwards at the splice.
      duration: Math.max(0.1, (item.end - item.start - seekMs) / 1000 - 0.04),
      tsOffset: (item.start + seekMs - this.startedAt) / 1000,
    };
  }

  private slateJob(item: PlayoutItem, from: number, lines: string[]): RenderJob {
    const seekMs = Math.max(0, from - item.start);
    return { ...this.timing(item, seekMs), seek: 0, kind: "slate", lines };
  }

  /** What on-screen graphics need to know about this item: what's on, what's next, upcoming events. */
  private gfxFor(item: PlayoutItem, seekMs: number, duration: number): GfxContext {
    const programme = item.kind === "media";
    const lastPart = !item.parts || item.part === item.parts - 1;
    const next = programme && lastPart ? this.playout.nextProgramme(this.ch, item.end) : undefined;
    return {
      W: this.cfg.ffmpeg.width,
      H: this.cfg.ffmpeg.height,
      jobStart: item.start + seekMs,
      duration,
      itemStart: item.start,
      itemEnd: item.end,
      programme,
      firstPart: !item.part,
      lastPart,
      current: programme ? { title: item.title, subtitle: item.subtitle } : undefined,
      next: next ? { title: next.title, subtitle: next.subtitle, start: next.start } : undefined,
      event: nextEvent(this.ch, item.start + seekMs),
    };
  }

  private async jobFor(item: PlayoutItem, seekMs: number): Promise<RenderJob> {
    const job = await this.baseJob(item, seekMs);
    return { ...job, gfx: this.gfxFor(item, seekMs, job.duration) };
  }

  private async baseJob(item: PlayoutItem, seekMs: number): Promise<RenderJob> {
    const t = this.timing(item, seekMs);
    switch (item.kind) {
      case "media":
      case "filler":
      case "break":
        // Parts after a mid-roll break start partway into the file.
        return { ...t, seek: (item.inPoint ?? 0) + t.seek, kind: "media", input: this.resolveInput(item.path!), hasAudio: item.hasAudio };
      case "card": {
        const next = this.playout.nextProgramme(this.ch, item.end, true);
        const card = {
          kicker: next?.part ? "Back to" : "Up next",
          title: next?.title ?? this.ch.name,
          subtitle: next?.subtitle,
          footer: next ? `${this.ch.name} · ${hhmm(next.start)}` : this.ch.name,
        };
        // Over a background clip (looped if it's shorter than the card), or over a plain backdrop.
        if (item.path) return { ...t, kind: "media", input: this.resolveInput(item.path), hasAudio: item.hasAudio, loop: true, card };
        return { ...t, seek: 0, kind: "slate", card };
      }
      case "live":
        return { ...t, seek: 0, kind: "live", input: await resolveLive(item.live!.source, item.live!.channel) };
      case "slate": {
        const next = this.playout.nextProgramme(this.ch, item.end);
        const lines = [this.ch.name];
        if (next) lines.push("", `Up next: ${next.title}`, `at ${hhmm(next.start)}`);
        return this.slateJob(item, item.start + seekMs, lines);
      }
    }
  }

  private spawn(job: RenderJob): Encoder {
    const args = buildArgs(job, this.ch, this.cfg.ffmpeg, this.workDir, `${this.ch.id}-${this.jobCounter++ % 4}`);
    const enc = new Encoder(
      this.cfg.ffmpeg.ffmpeg,
      args,
      this.workDir,
      (chunk, offset) => this.broadcast(chunk, offset),
      (msg) => this.running && log(this.ch.id, msg),
    );
    this.encoders.add(enc);
    void enc.done.then(() => this.encoders.delete(enc));
    return enc;
  }

  private broadcast(chunk: Buffer, offset: number): void {
    for (const c of this.clients) {
      if (c.destroyed) {
        this.clients.delete(c);
        continue;
      }
      if (c.writableLength > MAX_CLIENT_BACKLOG) {
        log(this.ch.id, "dropping a viewer that can't keep up");
        c.destroy();
        this.clients.delete(c);
        continue;
      }
      c.write(chunk);
    }

    for (const c of this.joining) {
      // Start new viewers on a TS packet boundary so their player syncs immediately.
      const skip = (TS_PACKET - (offset % TS_PACKET)) % TS_PACKET;
      if (skip < chunk.length) {
        c.write(chunk.subarray(skip));
        this.joining.delete(c);
        this.clients.add(c);
      }
    }
  }
}
