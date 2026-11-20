import type { IncomingMessage, ServerResponse } from "node:http";
import type { ChannelCfg, Config } from "../config";
import type { PlayoutService } from "../schedule/playout";
import { log } from "../util";
import { ChannelSession, type InputResolver } from "./session";

/** Starts a channel's encoder when the first viewer tunes in and stops it after the last one leaves. */
export class StreamManager {
  private sessions = new Map<string, ChannelSession>();

  constructor(
    private cfg: Config,
    private playout: PlayoutService,
    private workDir: string,
    private resolveInput: InputResolver,
  ) {}

  viewers(channelId: string): number {
    return this.sessions.get(channelId)?.viewers ?? 0;
  }

  attach(ch: ChannelCfg, req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "video/mp2t",
      "Cache-Control": "no-cache, no-store",
      Connection: "keep-alive",
    });
    let s = this.sessions.get(ch.id);
    if (!s) {
      s = new ChannelSession(ch, this.cfg, this.playout, this.workDir, this.resolveInput);
      this.sessions.set(ch.id, s);
    }
    const session = s;
    session.add(res);
    log(ch.id, `viewer connected (${session.viewers} watching)`);

    req.on("close", () => {
      session.remove(res);
      log(ch.id, `viewer left (${session.viewers} watching)`);
      if (session.viewers > 0 || session.idleTimer) return;
      session.idleTimer = setTimeout(() => {
        session.idleTimer = null;
        if (session.viewers > 0) return;
        session.stop();
        this.sessions.delete(ch.id);
      }, this.cfg.server.idleSeconds * 1000);
    });
  }

  /** Stop a channel's encoder now (e.g. the channel was deleted). */
  stop(channelId: string): void {
    const s = this.sessions.get(channelId);
    if (!s) return;
    if (s.idleTimer) clearTimeout(s.idleTimer);
    s.stop();
    this.sessions.delete(channelId);
  }

  stopAll(): void {
    for (const s of this.sessions.values()) s.stop();
    this.sessions.clear();
  }
}
