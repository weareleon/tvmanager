import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChannelCfg, FfmpegCfg } from "../config";
import { graphicsChain, watermarkAlpha, type GfxContext } from "./graphics";

export interface RenderJob {
  kind: "media" | "slate" | "live";
  /** File path or stream URL (media/live). */
  input?: string;
  hasAudio?: boolean;
  /** Seconds into the input to start from. */
  seek: number;
  /** Seconds of output to produce. */
  duration: number;
  /** Seconds added to output timestamps so consecutive items form one continuous stream. */
  tsOffset: number;
  /** Text lines for a slate. */
  lines?: string[];
  /** A lower-third "Up next" card drawn over the picture (slate background or a clip). */
  card?: CardText;
  /** Loop the input (card background clips shorter than the card). */
  loop?: boolean;
  /** Context for on-screen graphics and watermark animation. */
  gfx?: GfxContext;
}

export interface CardText {
  kicker: string;
  title: string;
  subtitle?: string;
  footer?: string;
}

/**
 * Lower-third card: dark band, accent bar, small coloured kicker ("UP NEXT"),
 * big title, subtitle, and a footer on the right. Text fades in over 0.4s.
 * Each line goes through its own text file so titles never need filter escaping.
 */
function cardFilter(input: string, output: string, card: CardText, W: number, H: number, workDir: string, jobId: string, accent: string): string {
  const ac = accent.replace("#", "0x");
  const file = (name: string, text: string) => {
    const f = `card-${jobId}-${name}.txt`;
    writeFileSync(join(workDir, f), text);
    return f;
  };
  const fade = "alpha='min(1,t/0.4)'";
  const text = (name: string, value: string, size: number, color: string, x: string, y: string) =>
    `drawtext=fontfile=${FONT_FILE}:textfile=${file(name, value)}:expansion=none:fontsize=${Math.round(size)}:fontcolor=${color}:x=${x}:y=${y}:${fade}`;
  const parts = [
    `drawbox=x=0:y=ih*0.60:w=iw:h=ih*0.30:color=black@0.62:t=fill`,
    `drawbox=x=iw*0.06:y=ih*0.645:w=iw*0.006:h=ih*0.21:color=${ac}@1:t=fill`,
    text("k", card.kicker.toUpperCase(), H * 0.036, ac, "w*0.08", "h*0.645"),
    text("t", card.title, H * 0.08, "white", "w*0.08", "h*0.69"),
  ];
  if (card.subtitle) parts.push(text("s", card.subtitle, H * 0.042, "0xd5d9e2", "w*0.08", "h*0.795"));
  if (card.footer) parts.push(text("f", card.footer, H * 0.034, "0xaab2c0", "w-text_w-w*0.06", "h*0.645"));
  return `[${input}]${parts.join(",")}[${output}]`;
}

// ffmpeg runs with cwd = workDir, so these are plain relative names (no Windows drive-letter escaping in filters).
export const FONT_FILE = "font.ttf";

const DEFAULT_PRESET: Record<string, string> = {
  libx264: "veryfast",
  h264_nvenc: "p4",
  h264_qsv: "veryfast",
};

function bufsize(rate: string): string {
  const m = rate.match(/^(\d+(?:\.\d+)?)([kKmM]?)$/);
  return m ? `${Number(m[1]) * 2}${m[2]}` : rate;
}

export function buildArgs(job: RenderJob, ch: ChannelCfg, ff: FfmpegCfg, workDir: string, jobId: string): string[] {
  const { width: W, height: H, fps } = ff;
  const a = ["-hide_banner", "-loglevel", "error", "-nostdin"];
  let n = 0;
  let audioMap: string | null = null;

  // Pacing note: we deliberately avoid -re. It paces the *input*, so after a seek ffmpeg would
  // replay the run-up from the previous keyframe in real time and the channel drifts late.
  // Instead the realtime/arealtime filters pace the already-trimmed output frames.
  const paced = job.kind !== "live"; // live sources are already real time
  if (job.kind === "media") {
    if (job.loop) a.push("-stream_loop", "-1");
    if (job.seek > 0.05) a.push("-ss", job.seek.toFixed(3));
    a.push("-i", job.input!);
    if (job.hasAudio) audioMap = `${n}:a:0`;
    n++;
  } else if (job.kind === "live") {
    if (/^https?:/i.test(job.input!)) a.push("-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5");
    a.push("-i", job.input!);
    audioMap = `${n}:a:0?`;
    n++;
  } else {
    a.push("-f", "lavfi", "-i", `color=c=0x10131c:s=${W}x${H}:r=${fps}`);
    n++;
  }

  if (!audioMap) {
    a.push("-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo");
    audioMap = `${n}:a:0`;
    n++;
  }

  let wmIndex = -1;
  const wm = ch.watermark;
  const showWm = wm && existsSync(wm.image) && !(wm.showDuring === "programmes" && job.gfx && !job.gfx.programme);
  // Seconds into the programme at this job's first frame (animations play at the programme's start).
  const itemOffset = job.gfx ? Math.max(0, (job.gfx.jobStart - job.gfx.itemStart) / 1000) : 0;
  const wmAlpha = wm ? watermarkAlpha(wm.animation, wm.opacity, itemOffset, job.duration) : null;
  if (showWm && wm) {
    if (/\.gif$/i.test(wm.image)) a.push("-ignore_loop", "0", "-i", wm.image); // animated GIF plays on a loop
    else if (wmAlpha) a.push("-loop", "1", "-framerate", String(fps), "-i", wm.image); // a stream, so the alpha can change over time
    else a.push("-i", wm.image); // a single frame; overlay repeats it for the whole item
    wmIndex = n++;
  }

  const f: string[] = [
    `[0:v:0]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${fps}[v0]`,
  ];
  let last = "v0";

  if (job.kind === "slate" && job.lines?.length) {
    const textFile = `slate-${jobId}.txt`;
    writeFileSync(join(workDir, textFile), job.lines.join("\n"));
    const size = Math.round(H / 16);
    f.push(
      `[${last}]drawtext=fontfile=${FONT_FILE}:textfile=${textFile}:expansion=none:fontcolor=white:fontsize=${size}:line_spacing=${Math.round(size / 2)}:x=(w-text_w)/2:y=(h-text_h)/2[v1]`,
    );
    last = "v1";
  }

  if (job.card) {
    f.push(cardFilter(last, "vc", job.card, W, H, workDir, jobId, ch.accent));
    last = "vc";
  }

  if (wmIndex >= 0 && wm) {
    const ww = Math.max(2, Math.round((W * wm.scale) / 2) * 2);
    const m = wm.margin;
    const right = wm.position.endsWith("right");
    let x = right ? `main_w-overlay_w-${m}` : `${m}`;
    const y = wm.position.startsWith("bottom") ? `main_h-overlay_h-${m}` : `${m}`;
    if (wm.animation === "slide") {
      // Glide in from the nearest edge over the first 0.8s of each programme.
      const ease = `pow(max(0,1-(t+${itemOffset.toFixed(3)})/0.8),3)`;
      x = right ? `main_w-overlay_w-${m}+(overlay_w+${m})*${ease}` : `${m}-(overlay_w+${m})*${ease}`;
    }
    const alpha = wmAlpha
      ? `geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*${wmAlpha}'`
      : `colorchannelmixer=aa=${wm.opacity}`;
    f.push(`[${wmIndex}:v]scale=${ww}:-1,format=rgba,${alpha}[wm]`);
    f.push(`[${last}][wm]overlay=x='${x}':y='${y}'${/\.gif$/i.test(wm.image) ? ":shortest=0" : ""}[v2]`);
    last = "v2";
  }

  if (job.gfx && ch.graphics.length) {
    const chain = graphicsChain(ch.graphics, ch.accent, job.gfx, workDir, jobId);
    if (chain.length) {
      f.push(`[${last}]${chain.join(",")}[vg]`);
      last = "vg";
    }
  }

  f.push(`[${last}]format=yuv420p${paced ? ",realtime" : ""}[vout]`);
  if (paced) f.push(`[${audioMap}]arealtime[aout]`);
  a.push("-filter_complex", f.join(";"), "-map", "[vout]", "-map", paced ? "[aout]" : audioMap);

  const enc = ff.videoEncoder;
  a.push("-c:v", enc);
  const preset = ff.preset ?? DEFAULT_PRESET[enc];
  if (preset) a.push("-preset", preset);
  a.push("-b:v", ff.videoBitrate, "-maxrate", ff.videoBitrate, "-bufsize", bufsize(ff.videoBitrate), "-g", String(fps * 2));
  if (enc === "libx264") a.push("-sc_threshold", "0", "-profile:v", "high");

  a.push("-c:a", "aac", "-b:a", ff.audioBitrate, "-ar", "48000", "-ac", "2");
  a.push("-t", job.duration.toFixed(3), "-output_ts_offset", job.tsOffset.toFixed(3), "-f", "mpegts", "pipe:1");
  return a;
}
