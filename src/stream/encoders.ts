import { spawn } from "node:child_process";

/**
 * Which H.264 encoders actually work on this PC. ffmpeg builds list NVENC/QSV/AMF even when the
 * hardware or driver isn't there, so each one gets a real 2-second test encode.
 */

export const ENCODERS = [
  { id: "libx264", label: "Software (x264)", hint: "Works everywhere, uses the CPU." },
  { id: "h264_nvenc", label: "NVIDIA (NVENC)", hint: "GeForce/RTX/Quadro graphics cards." },
  { id: "h264_qsv", label: "Intel (Quick Sync)", hint: "Intel CPUs with integrated graphics, and Arc cards." },
  { id: "h264_amf", label: "AMD (AMF)", hint: "Radeon graphics cards and Ryzen APUs." },
] as const;

export interface EncoderResult {
  id: string;
  label: string;
  hint: string;
  works: boolean;
  /** Frames per second encoded in the test (720p), a rough speed indicator. */
  fps?: number;
  error?: string;
}

function test(ffmpeg: string, id: string, width: number, height: number): Promise<{ works: boolean; fps?: number; error?: string }> {
  const frames = 120;
  const args = [
    "-hide_banner", "-loglevel", "error", "-nostdin",
    "-f", "lavfi", "-i", `testsrc2=s=${width}x${height}:r=30`,
    "-frames:v", String(frames),
    "-vf", `format=${id === "h264_qsv" ? "nv12" : "yuv420p"}`,
    "-c:v", id, "-b:v", "3000k",
    "-f", "null", "-",
  ];
  return new Promise((resolve) => {
    const started = Date.now();
    let stderr = "";
    const p = spawn(ffmpeg, args, { windowsHide: true });
    p.stderr.on("data", (d: Buffer) => (stderr = (stderr + d.toString()).slice(-600)));
    const timer = setTimeout(() => p.kill(), 20_000);
    p.on("error", (e) => resolve({ works: false, error: e.message }));
    p.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ works: true, fps: Math.round(frames / ((Date.now() - started) / 1000)) });
      else resolve({ works: false, error: stderr.trim().split(/\r?\n/).pop()?.slice(0, 200) || `exit ${code}` });
    });
  });
}

let cache: { at: number; results: EncoderResult[] } | null = null;

export function cachedEncoders(): { at: number; results: EncoderResult[] } | null {
  return cache;
}

export async function detectEncoders(ffmpeg: string, width: number, height: number): Promise<EncoderResult[]> {
  const results: EncoderResult[] = [];
  // One at a time, so the speed numbers don't compete with each other.
  for (const e of ENCODERS) results.push({ ...e, ...(await test(ffmpeg, e.id, width, height)) });
  cache = { at: Date.now(), results };
  return results;
}
