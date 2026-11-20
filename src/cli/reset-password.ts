/**
 * Locked out? Run on the tvmanager PC:
 *   npm run reset-password -- <username>
 * Sets a new random password for that user (or creates them if there are no users)
 * and signs them out everywhere. Running on the machine itself is the proof of ownership.
 */
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { AuthStore } from "../auth";
import { loadConfig } from "../config";

const [username] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const cfgPath = resolve(process.argv.find((a) => a.startsWith("--config="))?.slice(9) ?? "config.json");
if (!existsSync(cfgPath)) {
  console.error(`No config at ${cfgPath}`);
  process.exit(1);
}
const auth = new AuthStore(loadConfig(cfgPath).dataDir);

if (!username) {
  const users = auth.users();
  console.log(users.length ? `Users: ${users.map((u) => u.username).join(", ")}\nUsage: npm run reset-password -- <username>` : "No users yet. Open the dashboard to create one.");
  process.exit(users.length ? 1 : 0);
}

const password = randomBytes(9).toString("base64url");
if (auth.findUser(username)) {
  await auth.setPassword(username, password);
  auth.endOtherSessions(auth.findUser(username)!.username);
  console.log(`New password for "${username}": ${password}\nAll of their sessions were signed out. Restart tvmanager if it's running, then change this password in Settings.`);
} else if (auth.needsSetup) {
  await auth.addUser(username, password);
  console.log(`Created "${username}" with password: ${password}\nRestart tvmanager if it's running.`);
} else {
  console.error(`No user "${username}". Users: ${auth.users().map((u) => u.username).join(", ")}`);
  process.exit(1);
}
