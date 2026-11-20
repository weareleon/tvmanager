import { execFile } from "node:child_process";

export interface ProbeResult {
  duration: number;
  hasAudio: boolean;
  chapters: number[];
}

export function probe(ffprobe: string, path: string): Promise<ProbeResult | null> {
  return new Promise((resolve) => {
    execFile(
      ffprobe,
      ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", "-show_chapters", path],
      { windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: 60_000 },
      (err, stdout) => {
        if (err) return resolve(null);
        try {
          const j = JSON.parse(stdout);
          const duration = Number(j.format?.duration);
          const streams: { codec_type?: string; disposition?: { attached_pic?: number } }[] = j.streams ?? [];
          const hasVideo = streams.some((s) => s.codec_type === "video" && !s.disposition?.attached_pic);
          if (!hasVideo || !Number.isFinite(duration) || duration <= 0) return resolve(null);
          const chapters = ((j.chapters ?? []) as { start_time?: string }[])
            .map((c) => Number(c.start_time))
            .filter((t) => Number.isFinite(t) && t > 0);
          resolve({ duration, hasAudio: streams.some((s) => s.codec_type === "audio"), chapters });
        } catch {
          resolve(null);
        }
      },
    );
  });
}
