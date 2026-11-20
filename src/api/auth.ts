import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AuthStore } from "../auth";
import { log, sleep } from "../util";

declare module "fastify" {
  interface FastifyRequest {
    user: { username: string; id: string } | null;
  }
}

const COOKIE = "tvm_session";
const MAX_AGE = 30 * 86_400;

function cookies(req: FastifyRequest): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** A request straight from this PC (not through a reverse proxy, which would also look local). */
function isLocal(req: FastifyRequest): boolean {
  if (req.headers["x-forwarded-for"] || req.headers["x-real-ip"] || req.headers.forwarded) return false;
  return ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "");
}

function setSession(req: FastifyRequest, reply: FastifyReply, token: string, maxAge = MAX_AGE): void {
  const secure = req.protocol === "https" || req.headers["x-forwarded-proto"] === "https";
  reply.header("Set-Cookie", `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`);
}

const body = (req: FastifyRequest) => (req.body ?? {}) as Record<string, unknown>;
const s = (v: unknown) => (typeof v === "string" ? v : "");

/**
 * Dashboard sign-in. The dashboard page and its assets load without a session (the page
 * shows the sign-in form itself); every /api/ route except sign-in requires one.
 * The playlist, guide and stream URLs stay open, because TV apps can't sign in.
 */
export function authRoutes(app: FastifyInstance, auth: AuthStore): void {
  app.decorateRequest("user", null);

  app.addHook("onRequest", async (req, reply) => {
    req.user = auth.session(cookies(req)[COOKIE]);
    const path = req.url.split("?")[0];
    if (!path.startsWith("/api/")) return;
    // CSRF: other sites can make a browser send our cookie, but can't add a custom header.
    if (req.method !== "GET" && req.method !== "HEAD" && req.headers["x-requested-with"] !== "tvmanager") {
      return reply.code(403).send({ error: "This request must come from the tvmanager dashboard." });
    }
    if (path.startsWith("/api/auth/")) return;
    if (!req.user) return reply.code(401).send({ error: auth.needsSetup ? "Create an account first." : "Please sign in.", auth: true });
  });

  app.get("/api/auth/status", async (req) => ({
    setup: auth.needsSetup,
    needsCode: auth.needsSetup && !isLocal(req),
    user: req.user?.username ?? null,
  }));

  app.post("/api/auth/setup", async (req, reply) => {
    if (!auth.needsSetup) return reply.code(409).send({ error: "This server already has an account. Sign in instead." });
    const wait = auth.throttled(req.ip);
    if (wait) return reply.code(429).send({ error: `Too many attempts. Try again in ${Math.ceil(wait / 60)} min.` });
    const b = body(req);
    if (!isLocal(req) && s(b.code).trim() !== auth.setupCode) {
      auth.failed(req.ip);
      return reply.code(403).send({ error: "That setup code isn't right. It's printed in the tvmanager server log." });
    }
    try {
      await auth.addUser(s(b.username), s(b.password));
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
    const user = auth.findUser(s(b.username))!.username;
    setSession(req, reply, auth.createSession(user, req.headers["user-agent"]));
    log("auth", `admin account "${user}" created`);
    return { ok: true, user };
  });

  app.post("/api/auth/login", async (req, reply) => {
    const wait = auth.throttled(req.ip);
    if (wait) return reply.code(429).send({ error: `Too many attempts. Try again in ${Math.ceil(wait / 60)} min.` });
    const b = body(req);
    const user = await auth.verify(s(b.username), s(b.password));
    if (!user) {
      auth.failed(req.ip);
      log("auth", `failed sign-in for "${s(b.username).slice(0, 40)}" from ${req.ip}`);
      await sleep(400);
      return reply.code(401).send({ error: "Wrong username or password." });
    }
    auth.succeeded(req.ip);
    setSession(req, reply, auth.createSession(user, req.headers["user-agent"]));
    return { ok: true, user };
  });

  app.post("/api/auth/logout", async (req, reply) => {
    auth.endSession(cookies(req)[COOKIE]);
    setSession(req, reply, "", 0);
    return { ok: true };
  });

  // ---- account management (signed in) ----

  app.get("/api/account", async (req) => ({
    user: req.user!.username,
    users: auth.users(),
    sessions: auth.sessionsOf(req.user!.username).map((x) => ({ ...x, current: x.id === req.user!.id, id: undefined })),
  }));

  app.post("/api/account/password", async (req, reply) => {
    const b = body(req);
    if (!(await auth.verify(req.user!.username, s(b.current)))) {
      await sleep(400);
      return reply.code(400).send({ error: "Your current password isn't right." });
    }
    try {
      await auth.setPassword(req.user!.username, s(b.next));
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
    const ended = auth.endOtherSessions(req.user!.username, req.user!.id);
    return { ok: true, signedOut: ended };
  });

  app.post("/api/account/users", async (req, reply) => {
    const b = body(req);
    try {
      await auth.addUser(s(b.username), s(b.password));
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
    log("auth", `user "${s(b.username)}" added by ${req.user!.username}`);
    return { ok: true };
  });

  app.delete<{ Params: { name: string } }>("/api/account/users/:name", async (req, reply) => {
    if (req.params.name.toLowerCase() === req.user!.username.toLowerCase()) return reply.code(400).send({ error: "You can't remove yourself. Sign in as another user to do that." });
    try {
      auth.removeUser(req.params.name);
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
    log("auth", `user "${req.params.name}" removed by ${req.user!.username}`);
    return { ok: true };
  });

  app.post("/api/account/signout-others", async (req) => ({ ok: true, signedOut: auth.endOtherSessions(req.user!.username, req.user!.id) }));
}
