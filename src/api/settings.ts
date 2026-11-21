import type { FastifyInstance } from "fastify";
import type { ConfigStore } from "../config";
import { cachedEncoders, detectEncoders, ENCODERS } from "../stream/encoders";

export const RESOLUTIONS = [
  { id: "480p", width: 854, height: 480 },
  { id: "720p", width: 1280, height: 720 },
  { id: "1080p", width: 1920, height: 1080 },
] as const;

/** Server-wide encoding settings for the dashboard. Applies to channels as they next start. */
export function settingsRoutes(app: FastifyInstance, store: ConfigStore): void {
  const cfg = store.cfg;

  const current = () => {
    const f = cfg.ffmpeg;
    return {
      videoEncoder: f.videoEncoder,
      width: f.width,
      height: f.height,
      fps: f.fps,
      videoBitrate: f.videoBitrate,
      audioBitrate: f.audioBitrate,
    };
  };

  app.get("/api/settings/encoding", async () => ({
    current: current(),
    encoders: cachedEncoders(),
    known: ENCODERS,
    resolutions: RESOLUTIONS,
  }));

  app.post("/api/settings/encoding/detect", async () => ({ at: Date.now(), results: await detectEncoders(cfg.ffmpeg.ffmpeg, 1280, 720) }));

  app.put<{ Body: Record<string, unknown> }>("/api/settings/encoding", async (req, reply) => {
    const b = req.body ?? {};
    const enc = String(b.videoEncoder ?? "");
    if (!ENCODERS.some((e) => e.id === enc)) return reply.code(400).send({ error: "Unknown encoder." });
    const res = RESOLUTIONS.find((r) => r.id === b.resolution);
    if (!res) return reply.code(400).send({ error: "Pick a resolution." });
    const fps = Number(b.fps);
    if (![25, 30, 50, 60].includes(fps)) return reply.code(400).send({ error: "Frame rate must be 25, 30, 50 or 60." });
    const vb = Number(b.videoBitrate);
    if (!(vb >= 500 && vb <= 40000)) return reply.code(400).send({ error: "Video bitrate must be between 500 and 40000 kbps." });
    const ab = Number(b.audioBitrate);
    if (![96, 128, 160, 192, 256, 320].includes(ab)) return reply.code(400).send({ error: "Pick an audio bitrate." });
    try {
      store.update((raw) => {
        raw.ffmpeg = { ...(raw.ffmpeg ?? {}), videoEncoder: enc, width: res.width, height: res.height, fps, videoBitrate: `${vb}k`, audioBitrate: `${ab}k` };
        // A preset chosen for one encoder may not exist for another; let each use its default.
        delete raw.ffmpeg.preset;
      });
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
    return { ok: true, current: current() };
  });
}
