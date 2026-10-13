// The service over HTTP, as a process of its own on a port the system picks:
// a request that is not a plain JSON object is answered 400 and the process
// lives on (a thrown handler would take the whole service down, and systemd
// would restart it into the next such request); the reads answer.
//   cd web && node --test --experimental-strip-types ../points/service.test.ts
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const data = mkdtempSync(join(tmpdir(), "notus-points-service-"));
let proc: ChildProcess;
let base = "";
const lines: string[] = [];

before(async () => {
  proc = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", join(here, "service.ts")], {
    // a pass an hour: the one at start reaches no node here and is logged, nothing more
    env: { ...process.env, PORT: "0", NOTUS_POINTS_DATA: data, NOTUS_POINTS_EVERY: "3600" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  base = await new Promise<string>((resolve, reject) => {
    const onData = (d: Buffer) => {
      for (const line of d.toString().split("\n")) {
        if (!line) continue;
        lines.push(line);
        const m = /on 127\.0\.0\.1:(\d+)/.exec(line);
        if (m) resolve(`http://127.0.0.1:${m[1]}`);
      }
    };
    proc.stdout!.on("data", onData);
    proc.stderr!.on("data", onData);
    proc.on("exit", (code) => reject(new Error(`the service exited with ${code}: ${lines.join(" | ")}`)));
    setTimeout(() => reject(new Error(`the service did not listen: ${lines.join(" | ")}`)), 30_000).unref();
  });
});
after(() => {
  proc.kill("SIGTERM");
  rmSync(data, { recursive: true, force: true });
});

const post = (path: string, body: string) =>
  fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(5_000) });

test("a body that is JSON but no object is refused, and the service lives on", async () => {
  for (const body of ["null", "1", '"x"', "[1]", "true"]) {
    const r = await post("/liteforge/referral", body);
    assert.equal(r.status, 400, body);
    assert.equal((await r.json()).error, "not a JSON object");
  }
  const r = await post("/liteforge/referral", "{not json");
  assert.equal(r.status, 400);
  const fields = await post("/liteforge/referral", JSON.stringify({ invitee: 1 }));
  assert.equal(fields.status, 400);
  assert.equal((await fields.json()).error, "invitee, inviter and signature are needed");
  assert.equal(proc.exitCode, null);
});

test("the reads answer, an unknown chain and route do not", async () => {
  const season = await fetch(base + "/liteforge/season", { signal: AbortSignal.timeout(5_000) });
  assert.equal(season.status, 200);
  const board = await fetch(base + "/liteforge/leaderboard?limit=5", { signal: AbortSignal.timeout(5_000) });
  assert.equal(board.status, 200);
  assert.ok(Array.isArray((await board.json()).rows));
  const chain = await fetch(base + "/nowhere/season", { signal: AbortSignal.timeout(5_000) });
  assert.equal(chain.status, 404);
  const route = await fetch(base + "/liteforge/other", { signal: AbortSignal.timeout(5_000) });
  assert.equal(route.status, 404);
  assert.equal(proc.exitCode, null);
});
