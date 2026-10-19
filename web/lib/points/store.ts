// What the service keeps on disk, per chain: the pad's events as they were
// read (append-only, the source of truth), the referral bindings
// (append-only), and the last block indexed. Plain JSON lines, so a
// `git pull` or a Node upgrade never has a database to migrate, and anyone
// can read them. The ledger is never stored: it is recomputed from these.

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, truncateSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { PadEvent } from "./decode.ts";
import type { Referral } from "./rules.ts";

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

/** bigints as decimal strings tagged with a trailing "n", so they come back as bigints */
function pack(v: unknown): Json {
  if (typeof v === "bigint") return `${v.toString()}n`;
  if (Array.isArray(v)) return v.map(pack);
  if (v && typeof v === "object") {
    const o: { [k: string]: Json } = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (x !== undefined) o[k] = pack(x);
    return o;
  }
  return v as Json;
}
function unpack(v: Json): unknown {
  if (typeof v === "string" && /^-?\d+n$/.test(v)) return BigInt(v.slice(0, -1));
  if (Array.isArray(v)) return v.map(unpack);
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) o[k] = unpack(x);
    return o;
  }
  return v;
}

export type Meta = {
  last: bigint;
  rulesVersion?: number;
  chunk?: bigint;
  /** the newest block whose coin transfers are in the events (absent: none read yet, the
   *  backfill starts at the deploy block on the next pass) */
  transfersLast?: bigint;
};

export class Store {
  readonly dir: string;
  private readonly eventsPath: string;
  private readonly referralsPath: string;
  private readonly metaPath: string;

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
    this.eventsPath = join(dir, "events.jsonl");
    this.referralsPath = join(dir, "referrals.jsonl");
    this.metaPath = join(dir, "meta.json");
  }

  private readLines<T>(path: string): T[] {
    if (!existsSync(path)) return [];
    const text = readFileSync(path, "utf8");
    const lines = text.split("\n");
    const out: T[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;
      try {
        out.push(unpack(JSON.parse(line) as Json) as T);
      } catch (e) {
        // a last line without its newline is a write cut short (a crash, a full disk): dropped,
        // the file trimmed to its last whole line; the events in it are read again from the
        // chain. Anything else is a corrupt file, which is not guessed at
        if (i === lines.length - 1 && !text.endsWith("\n")) {
          console.warn(`${path}: the last line is cut short (${line.length} chars): dropped`);
          truncateSync(path, Buffer.byteLength(text.slice(0, text.lastIndexOf("\n") + 1)));
          break;
        }
        throw e;
      }
    }
    return out;
  }

  /** appended and flushed to disk before returning: the checkpoint written after it never
   *  outlives the events it covers */
  private appendLines(path: string, rows: unknown[]) {
    if (!rows.length) return;
    const fd = openSync(path, "a");
    try {
      writeSync(fd, rows.map((r) => JSON.stringify(pack(r))).join("\n") + "\n");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  loadEvents(): PadEvent[] {
    return this.readLines<PadEvent>(this.eventsPath);
  }
  appendEvents(events: PadEvent[]) {
    this.appendLines(this.eventsPath, events);
  }

  loadReferrals(): Referral[] {
    return this.readLines<Referral>(this.referralsPath);
  }
  appendReferral(r: Referral) {
    this.appendLines(this.referralsPath, [r]);
  }

  readMeta(): Meta | null {
    if (!existsSync(this.metaPath)) return null;
    try {
      return unpack(JSON.parse(readFileSync(this.metaPath, "utf8")) as Json) as Meta;
    } catch {
      return null;
    }
  }
  /** written whole, flushed, and renamed into place: a crash leaves the old file, never half a new one */
  writeMeta(meta: Meta) {
    const tmp = `${this.metaPath}.tmp`;
    const fd = openSync(tmp, "w");
    try {
      writeSync(fd, JSON.stringify(pack(meta)));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.metaPath);
  }
}
