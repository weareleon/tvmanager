import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GraphicCfg } from "../config";
import { hhmm } from "../util";

/**
 * On-screen graphics drawn live by ffmpeg (drawtext/drawbox with time expressions),
 * so animation costs nothing extra and needs no browser or pre-rendered assets.
 *
 * All times are seconds relative to the start of the current ffmpeg job (`t` = 0 at the
 * first frame), computed from wall-clock times so graphics land at the right moment even
 * when a viewer tunes in halfway through a programme.
 */

export const FONT_BOLD = "font-bold.ttf";
export const FONT_MONO = "font-mono.ttf";
const FONT = "font.ttf";

export interface GfxContext {
  W: number;
  H: number;
  /** Wall-clock time (ms) of the job's first frame. */
  jobStart: number;
  /** Job length in seconds. */
  duration: number;
  itemStart: number;
  itemEnd: number;
  /** A programme (not a break, card, filler or slate). */
  programme: boolean;
  firstPart: boolean;
  lastPart: boolean;
  current?: { title: string; subtitle?: string };
  next?: { title: string; subtitle?: string; start: number };
  event?: { title: string; start: number; end: number };
}

const num = (n: number) => (Math.round(n * 1000) / 1000).toString();
const color = (hex: string, a = 1) => `0x${hex.replace("#", "")}@${a}`;

class Builder {
  private filters: string[] = [];
  private n = 0;
  constructor(
    private workDir: string,
    private jobId: string,
  ) {}

  /** Text goes through a file so titles never need filter escaping. */
  file(content: string): string {
    const f = `gfx-${this.jobId}-${this.n++}.txt`;
    writeFileSync(join(this.workDir, f), content);
    return f;
  }

  text(o: {
    content: string;
    font?: string;
    size: number;
    color: string;
    x: string;
    y: string;
    box?: string;
    border?: number;
    enable?: string;
    alpha?: string;
    expand?: boolean;
  }): void {
    const parts = [
      `fontfile=${o.font ?? FONT}`,
      `textfile=${this.file(o.content)}`,
      `expansion=${o.expand ? "normal" : "none"}`,
      `fontsize=${Math.round(o.size)}`,
      `fontcolor=${o.color}`,
      `x='${o.x}'`,
      `y='${o.y}'`,
    ];
    if (o.box) parts.push("box=1", `boxcolor=${o.box}`, `boxborderw=${Math.round(o.border ?? 8)}`);
    if (o.alpha) parts.push(`alpha='${o.alpha}'`);
    if (o.enable) parts.push(`enable='${o.enable}'`);
    this.filters.push(`drawtext=${parts.join(":")}`);
  }

  box(x: number, y: number, w: string, h: number, c: string, enable?: string): void {
    this.filters.push(`drawbox=x=${num(x)}:y=${num(y)}:w=${w}:h=${num(h)}:color=${c}:t=fill${enable ? `:enable='${enable}'` : ""}`);
  }

  get chain(): string[] {
    return this.filters;
  }
}

/**
 * A lower-third banner (kicker / title / subtitle) that slides in from the left at `a`,
 * holds, and slides back out to finish at `b`.
 */
function banner(g: Builder, ctx: GfxContext, accent: string, a: number, b: number, kicker: string, title: string, sub: string | undefined, bottom: number) {
  const { W, H } = ctx;
  const ks = H * 0.032, kb = ks * 0.4;
  const ts = H * 0.062, tb = ts * 0.28;
  const ss = H * 0.034, sb = ss * 0.4;
  const x0 = W * 0.05;
  // Box tops, stacked upwards from `bottom`; text y is box top + border.
  const subTop = bottom - (ss + 2 * sb);
  const titleTop = (sub ? subTop - 6 : bottom) - (ts + 2 * tb);
  const kickerTop = titleTop - 6 - (ks + 2 * kb);
  const ease = `(pow(max(0,1-(t-${num(a)})/0.5),3)+pow(max(0,1-(${num(b)}-t)/0.5),3))`;
  const x = (border: number) => `${num(x0 + border)}-(${num(x0 + border + 80)}+tw)*${ease}`;
  const enable = `between(t,${num(a)},${num(b)})`;
  g.text({ content: kicker.toUpperCase(), font: FONT_BOLD, size: ks, color: "white", box: color(accent, 0.95), border: kb, x: x(kb), y: num(kickerTop + kb), enable });
  g.text({ content: title, font: FONT_BOLD, size: ts, color: "white", box: "black@0.72", border: tb, x: x(tb), y: num(titleTop + tb), enable });
  if (sub) g.text({ content: sub, size: ss, color: "0xd5d9e2", box: "black@0.6", border: sb, x: x(sb), y: num(subTop + sb), enable });
}

/** Two stacked lines (small accent label above a bigger value) pinned to a corner. */
function cornerPair(g: Builder, ctx: GfxContext, corner: string, accent: string, label: string | undefined, value: { content: string; expand?: boolean; enable?: string }[], margin: number) {
  const { H } = ctx;
  const ls = H * 0.026, lb = ls * 0.4;
  const vs = H * 0.05, vb = vs * 0.22;
  const right = corner.endsWith("right");
  const top = corner.startsWith("top");
  const x = (border: number) => (right ? `w-tw-${num(margin + border)}` : num(margin + border));
  const labelH = label ? ls + 2 * lb + 4 : 0;
  const blockTop = top ? margin : H - margin - labelH - (vs + 2 * vb);
  // The label shows whenever any of the values does (enable expressions are truthy when non-zero).
  const anyEnable = value.every((v) => v.enable) ? value.map((v) => v.enable).join("+") : undefined;
  if (label) g.text({ content: label.toUpperCase(), font: FONT_BOLD, size: ls, color: "white", box: color(accent, 0.95), border: lb, x: x(lb), y: num(blockTop + lb), enable: anyEnable });
  for (const v of value) {
    g.text({ content: v.content, expand: v.expand, font: FONT_MONO, size: vs, color: "white", box: "black@0.7", border: vb, x: x(vb), y: num(blockTop + labelH + vb), enable: v.enable });
  }
}

/** hh:mm:ss remaining until `r0` seconds into the job, as a drawtext expansion. */
function countdownText(r0: number): string {
  const R = `(${num(r0)}-t)`;
  return `%{eif:max(0,floor(${R}/3600)):d:2}:%{eif:max(0,mod(floor(${R}/60),60)):d:2}:%{eif:max(0,mod(floor(${R}),60)):d:2}`;
}

/**
 * Filters for all of a channel's enabled graphics on this job, or [] if none apply.
 * Order matters: later filters draw on top.
 */
export function graphicsChain(graphics: GraphicCfg[], accent: string, ctx: GfxContext, workDir: string, jobId: string): string[] {
  const g = new Builder(workDir, jobId);
  const rel = (wall: number) => (wall - ctx.jobStart) / 1000;
  const on = (gr: { enabled: boolean; showDuring?: string }) => gr.enabled && (gr.showDuring !== "programmes" || ctx.programme);
  const ticker = graphics.find((x) => x.type === "ticker" && on(x));
  const bandH = Math.round(ctx.H * 0.065);
  const bannerBottom = ctx.H * (ticker ? 0.9 : 0.93) - (ticker ? bandH * 0.4 : 0);
  const margin = Math.round(ctx.H * 0.045);

  for (const gr of graphics) {
    if (!gr.enabled) continue;
    switch (gr.type) {
      case "upnext": {
        if (!ctx.programme || !ctx.lastPart || !ctx.next) break;
        const a = Math.max(rel(ctx.itemEnd - gr.secondsBeforeEnd * 1000), -10);
        const b = Math.min(a + gr.duration, ctx.duration - 0.3);
        if (b - a < 2 || b <= 0.5) break;
        const sub = [ctx.next.subtitle, hhmm(ctx.next.start)].filter(Boolean).join("  ·  ");
        banner(g, ctx, accent, a, b, "Up next", ctx.next.title, sub, bannerBottom);
        break;
      }
      case "nowplaying": {
        if (!ctx.programme || !ctx.firstPart || !ctx.current) break;
        const a = rel(ctx.itemStart + gr.delay * 1000);
        const b = Math.min(a + gr.duration, ctx.duration - 0.3);
        if (b - a < 2 || b <= 0.5) break;
        banner(g, ctx, accent, a, b, "You're watching", ctx.current.title, ctx.current.subtitle, bannerBottom);
        break;
      }
      case "countdown": {
        if (!on(gr)) break;
        let ev = ctx.event;
        if (gr.target === "at" && gr.at) {
          const start = new Date(gr.at).getTime(); // "YYYY-MM-DDTHH:MM" parses as local time
          ev = { title: gr.title ?? "Coming up", start, end: start + 3_600_000 };
        }
        if (!ev) break;
        const s0 = rel(ev.start - gr.showHoursBefore * 3_600_000);
        const r0 = rel(ev.start);
        const e0 = rel(ev.end);
        if (e0 <= 0 || s0 >= ctx.duration) break;
        const title = gr.title || ev.title;
        cornerPair(g, ctx, gr.position, accent, title, [
          { content: countdownText(r0), expand: true, enable: `between(t,${num(s0)},${num(r0)})` },
          { content: "ON NOW", enable: `between(t,${num(r0)},${num(e0)})` },
        ], margin);
        break;
      }
      case "clock": {
        if (!on(gr)) break;
        const content = gr.format === "12h" ? "%{localtime:%I}:%{localtime:%M} %{localtime:%p}" : "%{localtime:%H}:%{localtime:%M}";
        cornerPair(g, ctx, gr.position, accent, undefined, [{ content, expand: true }], margin);
        break;
      }
      case "ticker":
        break; // drawn last so it sits on top
    }
  }

  if (ticker && ticker.type === "ticker") {
    const { H } = ctx;
    const fs = bandH * 0.5;
    const ty = H - bandH + (bandH - fs) / 2;
    // Offset by wall-clock time so the scroll continues smoothly across programmes.
    const o = (ctx.jobStart / 1000) % 100000;
    g.box(0, H - bandH, "iw", bandH, "black@0.78");
    g.text({ content: `${ticker.text}        `, size: fs, color: "white", x: `w-mod((t+${num(o)})*${ticker.speed},w+tw)`, y: num(ty) });
    if (ticker.label) {
      const lb = (bandH - fs) / 2;
      g.text({ content: ticker.label.toUpperCase(), font: FONT_BOLD, size: fs, color: "white", box: color(accent, 1), border: lb, x: num(lb), y: num(ty) });
    }
  }
  return g.chain;
}

/**
 * Alpha expression for an animated watermark (used with geq on the logo).
 * `offset` = seconds into the programme at the job's first frame, so a fade-in
 * happens at the programme's start, not whenever someone tunes in.
 */
export function watermarkAlpha(animation: string, opacity: number, offset: number, duration: number): string | null {
  const T = `(T+${num(offset)})`;
  if (animation === "pulse") return `${num(opacity)}*(0.55+0.45*(0.5+0.5*cos(2*PI*${T}/5)))`;
  if (animation === "fade") return `${num(opacity)}*min(1,max(0,${T}/1.2))*min(1,max(0,(${num(duration)}-T)/1))`;
  return null;
}
