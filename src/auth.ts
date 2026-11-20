import { createHash, randomBytes, randomInt, scrypt, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;

const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const SESSION_DAYS = 30;
const DAY = 86_400_000;

export interface User {
  username: string;
  /** scrypt$N$r$p$salt$hash (base64) */
  password: string;
  created: number;
}

interface Session {
  /** sha256 of the cookie token, so a leaked auth.json can't be replayed as a cookie. */
  id: string;
  username: string;
  created: number;
  expires: number;
  lastSeen: number;
  userAgent?: string;
}

interface AuthFile {
  users: User[];
  sessions: Session[];
}

export const MIN_PASSWORD = 8;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(pw, salt, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

async function checkPassword(pw: string, stored: string): Promise<boolean> {
  const [alg, N, r, p, salt, hash] = stored.split("$");
  if (alg !== "scrypt") return false;
  const expected = Buffer.from(hash, "base64");
  const got = await scryptAsync(pw, Buffer.from(salt, "base64"), expected.length, { N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem });
  return got.length === expected.length && timingSafeEqual(got, expected);
}

/**
 * Users and sessions for the dashboard, kept in data/auth.json (not config.json,
 * so the config can be shared without credentials in it).
 */
export class AuthStore {
  private file: string;
  private data: AuthFile = { users: [], sessions: [] };
  /** One-time code required to create the first account from another device. */
  readonly setupCode = String(randomInt(100000, 1000000));
  private attempts = new Map<string, number[]>();
  /** A hash to compare against when the username doesn't exist, so timing doesn't reveal valid names. */
  private dummy = hashPassword(randomBytes(16).toString("hex"));

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.file = join(dataDir, "auth.json");
    if (existsSync(this.file)) this.data = JSON.parse(readFileSync(this.file, "utf8"));
    this.data.sessions ??= [];
    this.prune();
  }

  private save(): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  private prune(): void {
    const now = Date.now();
    this.data.sessions = this.data.sessions.filter((s) => s.expires > now && this.data.users.some((u) => u.username === s.username));
  }

  get needsSetup(): boolean {
    return this.data.users.length === 0;
  }

  users(): { username: string; created: number }[] {
    return this.data.users.map(({ username, created }) => ({ username, created }));
  }

  findUser(username: string): User | undefined {
    return this.data.users.find((u) => u.username.toLowerCase() === username.toLowerCase());
  }

  async addUser(username: string, password: string): Promise<void> {
    username = username.trim();
    if (!/^[a-z0-9._-]{2,32}$/i.test(username)) throw new Error("Usernames are 2–32 letters, numbers, dots, dashes or underscores.");
    if (password.length < MIN_PASSWORD) throw new Error(`Passwords need at least ${MIN_PASSWORD} characters.`);
    if (this.findUser(username)) throw new Error(`There's already a user called "${username}".`);
    this.data.users.push({ username, password: await hashPassword(password), created: Date.now() });
    this.save();
  }

  removeUser(username: string): void {
    if (this.data.users.length <= 1) throw new Error("You can't remove the last user.");
    const u = this.findUser(username);
    if (!u) throw new Error("No such user.");
    this.data.users = this.data.users.filter((x) => x !== u);
    this.prune();
    this.save();
  }

  async setPassword(username: string, password: string): Promise<void> {
    if (password.length < MIN_PASSWORD) throw new Error(`Passwords need at least ${MIN_PASSWORD} characters.`);
    const u = this.findUser(username);
    if (!u) throw new Error("No such user.");
    u.password = await hashPassword(password);
    this.save();
  }

  /** Returns the canonical username if the credentials are right. */
  async verify(username: string, password: string): Promise<string | null> {
    const u = this.findUser(username);
    if (!u) {
      await checkPassword(password, await this.dummy);
      return null;
    }
    return (await checkPassword(password, u.password)) ? u.username : null;
  }

  // ---- sessions ----

  createSession(username: string, userAgent?: string): string {
    const token = randomBytes(32).toString("base64url");
    const now = Date.now();
    this.data.sessions.push({ id: sha256(token), username, created: now, lastSeen: now, expires: now + SESSION_DAYS * DAY, userAgent: userAgent?.slice(0, 200) });
    this.save();
    return token;
  }

  /** The user for a cookie token, extending the session if it's in use (sliding expiry). */
  session(token: string | undefined): { username: string; id: string } | null {
    if (!token) return null;
    const id = sha256(token);
    const s = this.data.sessions.find((x) => x.id === id);
    if (!s || s.expires < Date.now()) return null;
    const now = Date.now();
    // Write at most once an hour, not on every request.
    if (now - s.lastSeen > 3_600_000) {
      s.lastSeen = now;
      s.expires = now + SESSION_DAYS * DAY;
      this.save();
    }
    return { username: s.username, id };
  }

  endSession(token: string | undefined): void {
    if (!token) return;
    const id = sha256(token);
    this.data.sessions = this.data.sessions.filter((s) => s.id !== id);
    this.save();
  }

  /** Sign a user out everywhere except (optionally) one session. */
  endOtherSessions(username: string, keepId?: string): number {
    const before = this.data.sessions.length;
    this.data.sessions = this.data.sessions.filter((s) => s.username !== username || s.id === keepId);
    this.save();
    return before - this.data.sessions.length;
  }

  sessionsOf(username: string): { id: string; created: number; lastSeen: number; userAgent?: string }[] {
    return this.data.sessions.filter((s) => s.username === username).map(({ id, created, lastSeen, userAgent }) => ({ id, created, lastSeen, userAgent }));
  }

  // ---- brute-force protection ----

  /** Seconds to wait before another attempt from this address, or 0. */
  throttled(ip: string): number {
    const recent = (this.attempts.get(ip) ?? []).filter((t) => t > Date.now() - 15 * 60_000);
    this.attempts.set(ip, recent);
    if (recent.length < 10) return 0;
    return Math.ceil((recent[0] + 15 * 60_000 - Date.now()) / 1000);
  }

  failed(ip: string): void {
    const list = this.attempts.get(ip) ?? [];
    list.push(Date.now());
    this.attempts.set(ip, list);
  }

  succeeded(ip: string): void {
    this.attempts.delete(ip);
  }
}
