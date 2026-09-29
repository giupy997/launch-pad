// Where the desk's key comes from. In order: NOTUS_LTC_DESK_KEY (the 64-hex
// secret itself), NOTUS_LTC_DESK_KEY_FILE (a key.json outside the checkout —
// systemd's LoadCredential= hands one over as $CREDENTIALS_DIRECTORY/<name>),
// else <desk dir>/key.json as keygen.ts writes it.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = import.meta.dirname;

export function deskDir(): string {
  return process.env.NOTUS_LTC_DESK_DIR ?? join(ROOT, "desk");
}

export function deskKeyFile(): string {
  return process.env.NOTUS_LTC_DESK_KEY_FILE ?? join(deskDir(), "key.json");
}

export function hasDeskKey(): boolean {
  return !!process.env.NOTUS_LTC_DESK_KEY || existsSync(deskKeyFile());
}

export function deskSecret(): string {
  if (process.env.NOTUS_LTC_DESK_KEY) return process.env.NOTUS_LTC_DESK_KEY.trim();
  const file = deskKeyFile();
  if (!existsSync(file)) throw new Error(`no desk key: set NOTUS_LTC_DESK_KEY_FILE, or make one with \`node litecoin/keygen.ts desk\` (looked in ${file})`);
  const parsed = JSON.parse(readFileSync(file, "utf8")) as { secret?: string };
  if (!parsed.secret) throw new Error(`${file} has no "secret"`);
  return parsed.secret;
}
