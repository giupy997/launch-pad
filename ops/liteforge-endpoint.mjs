#!/usr/bin/env node
// Liteforge's endpoint, when LitVM moves it: take the chain's fingerprint from
// the endpoint in use, check a new endpoint against it, and write the new one
// wherever the repository names the old.
//
//   node ops/liteforge-endpoint.mjs snapshot                      # the chain as the current endpoint shows it → ops/liteforge-fingerprint.json
//   node ops/liteforge-endpoint.mjs check  <rpc> [--explorer <url>]   # is the new endpoint the same chain, and can the site and the points service use it
//   node ops/liteforge-endpoint.mjs switch <rpc> [--explorer <url>]   # check, then rewrite the endpoint in the repository (no commit, no push)
//
// The check answers what a change of infrastructure leaves open: whether the
// chain is the same chain (its id, the hashes of two old blocks, the pad's
// code and its list of coins), whether it is at least as far as the points
// service has read (an indexer ahead of its chain counts events that no longer
// exist), and whether the endpoint serves what is asked of it: thirty calls in
// one request (the browser's transport), a browser's cross-origin request from
// the site, 9,000 blocks of logs in one call (the points service's window),
// logs from the pad's first blocks (a coin's history).
//
// It reads only. An endpoint is named by its host in everything printed: a
// URL may carry a key. No dependencies: Node 22's fetch and crypto.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENDPOINTS = join(ROOT, "web/lib/points/endpoints.ts");
const FINGERPRINT = join(ROOT, "ops/liteforge-fingerprint.json");
const SITE = "https://notus-pad.fun";

const CHAIN_ID = 4441;
const PAD = "0x39D104b3258B6A18c5d5d967CDA182Ded20Bef7F";
const DEPLOY_BLOCK = 57_741_789; // the pad's (web/lib/points/chains.ts)
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const SEL = { tokenCount: "0x9f181b5e", allTokens: "0x634282af" };
const WINDOW = 9_000; // blocks of logs the points service asks for in one call
const BATCH = 30; // calls the browser's transport puts in one request

// the files that name the endpoint, beside ENDPOINTS: the contracts' scripts and the documents
const FILES = [
  "contracts/foundry.toml",
  "contracts/script/rehearse-liteforge.sh",
  "contracts/script/try-v12-liteforge.sh",
  "contracts/script/DeployLitVM.s.sol",
  "contracts/test/LiveLiteforge.fork.t.sol",
  "README.md",
];

const host = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return "(not a URL)";
  }
};
const hex = (n) => "0x" + BigInt(n).toString(16);
const sha = (s) => createHash("sha256").update(s).digest("hex");
const word = (n) => BigInt(n).toString(16).padStart(64, "0");

function current() {
  const text = readFileSync(ENDPOINTS, "utf8");
  const rpc = /^export const LITEFORGE_RPC = "([^"]+)";$/m.exec(text)?.[1];
  const explorer = /^export const LITEFORGE_EXPLORER = "([^"]+)";$/m.exec(text)?.[1];
  if (!rpc || !explorer) throw new Error("web/lib/points/endpoints.ts does not hold the two constants in their one-line shape");
  return { text, rpc, explorer };
}

/** one JSON-RPC call, or a batch when `body` is an array; the answer and the time it took */
async function post(url, body, { timeout = 30_000, headers = {} } = {}) {
  const t0 = Date.now();
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  const text = await r.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`HTTP ${r.status}, not JSON: ${text.slice(0, 80).replace(/\s+/g, " ")}`);
  }
  return { json, ms: Date.now() - t0, status: r.status, headers: r.headers };
}
async function rpc(url, method, params = [], opts) {
  const { json, ms } = await post(url, { jsonrpc: "2.0", id: 1, method, params }, opts);
  if (json.error) throw new Error(`${method}: ${json.error.message ?? JSON.stringify(json.error)}`.slice(0, 160));
  return { result: json.result, ms };
}
const call = (url, data, block = "latest", to = PAD) => rpc(url, "eth_call", [{ to, data }, block]);

/** the chain as `url` shows it: what a new endpoint must agree with */
async function fingerprint(url) {
  const chainId = Number((await rpc(url, "eth_chainId")).result);
  const head = Number((await rpc(url, "eth_blockNumber")).result);
  const at = head - 2_000; // settled, and old enough to be history by the time of a switch
  const blockHash = async (n) => (await rpc(url, "eth_getBlockByNumber", [hex(n), false])).result?.hash ?? null;
  const code = (await rpc(url, "eth_getCode", [PAD, "latest"])).result;
  const count = Number((await call(url, SEL.tokenCount, hex(at))).result);
  const token = async (i) => "0x" + (await call(url, SEL.allTokens + word(i), hex(at))).result.slice(-40);
  return {
    taken: new Date().toISOString(),
    from: host(url),
    chainId,
    block: at,
    blocks: { [DEPLOY_BLOCK]: await blockHash(DEPLOY_BLOCK), [at]: await blockHash(at) },
    pad: { address: PAD, codeBytes: (code.length - 2) / 2, codeSha256: sha(code) },
    tokens: { count, first: await token(0), last: await token(count - 1) },
  };
}

async function snapshot() {
  const { rpc: url } = current();
  const f = await fingerprint(url);
  writeFileSync(FINGERPRINT, JSON.stringify(f, null, 2) + "\n");
  console.log(`fingerprint of chain ${f.chainId} from ${f.from}, at block ${f.block.toLocaleString("en-US")}: ${f.tokens.count} coins, pad ${f.pad.codeBytes} bytes`);
  console.log(`written to ops/liteforge-fingerprint.json`);
}

/** every check of a new endpoint, printed as it goes; true when nothing failed */
async function check(url, explorer) {
  if (!/^https:\/\//.test(url)) throw new Error("the endpoint must be an https URL");
  const fp = JSON.parse(readFileSync(FINGERPRINT, "utf8"));
  console.log(`checking ${host(url)} against the fingerprint of ${fp.taken} (block ${fp.block.toLocaleString("en-US")}, from ${fp.from})\n`);
  let failed = 0;
  let warned = 0;
  const line = (mark, what, note = "") => console.log(`  ${mark}  ${what}${note ? `  — ${note}` : ""}`);
  const run = async (what, fn, { warn = false } = {}) => {
    try {
      const note = await fn();
      line("ok  ", what, note ?? "");
      return true;
    } catch (e) {
      if (warn) warned++;
      else failed++;
      line(warn ? "WARN" : "FAIL", what, String(e.message ?? e).slice(0, 200));
      return false;
    }
  };
  const expect = (cond, message) => {
    if (!cond) throw new Error(message);
  };

  let head = 0;
  const alive = await run("answers, and is chain 4441", async () => {
    const id = Number((await rpc(url, "eth_chainId")).result);
    expect(id === CHAIN_ID, `chain id ${id}: another chain; the site's chain, the wallets' network and the points service all name ${CHAIN_ID}`);
    head = Number((await rpc(url, "eth_blockNumber")).result);
    return `head ${head.toLocaleString("en-US")}`;
  });
  if (!alive) {
    console.log("\nNOT READY: the endpoint does not answer as Liteforge. Nothing else was checked.");
    return false;
  }

  await run("is at least as far as the fingerprint", async () => {
    expect(head >= fp.block, `head ${head} is behind block ${fp.block}: the chain restarted, or this node is still syncing`);
    return `${(head - fp.block).toLocaleString("en-US")} blocks on`;
  });
  await run("is at least as far as the points service has read", async () => {
    const r = await fetch(`${SITE}/api/points/health`, { signal: AbortSignal.timeout(15_000) });
    const last = Number((await r.json()).chains?.liteforge?.last);
    expect(Number.isFinite(last), "the points service did not say where it is");
    expect(head >= last, `the service has read to ${last}, the chain is at ${head}: its record holds events of blocks this chain does not have`);
    return `service at ${last.toLocaleString("en-US")}`;
  });
  for (const [n, hash] of Object.entries(fp.blocks)) {
    await run(`has block ${Number(n).toLocaleString("en-US")} with the same hash`, async () => {
      const b = (await rpc(url, "eth_getBlockByNumber", [hex(n), false])).result;
      expect(b, "the node does not have the block (no history)");
      expect(b.hash === hash, `hash ${b.hash.slice(0, 12)}… where the chain had ${hash.slice(0, 12)}…: another history`);
    });
  }
  await run("has the pad, with the same code", async () => {
    const code = (await rpc(url, "eth_getCode", [PAD, "latest"])).result;
    expect(code && code.length > 2, "no code at the pad's address: the state did not come over");
    expect(sha(code) === fp.pad.codeSha256, "the code at the pad's address is not the pad's");
    return `${(code.length - 2) / 2} bytes`;
  });
  await run("has the pad's coins", async () => {
    const count = Number((await call(url, SEL.tokenCount)).result);
    expect(count >= fp.tokens.count, `${count} coins where there were ${fp.tokens.count}`);
    const first = "0x" + (await call(url, SEL.allTokens + word(0))).result.slice(-40);
    const kept = "0x" + (await call(url, SEL.allTokens + word(fp.tokens.count - 1))).result.slice(-40);
    expect(first === fp.tokens.first && kept === fp.tokens.last, "the list of coins is not the same list");
    return `${count} coins`;
  });

  await run(`takes ${BATCH} calls in one request (the site's transport)`, async () => {
    const batch = Array.from({ length: BATCH }, (_, i) => ({ jsonrpc: "2.0", id: i, method: "eth_call", params: [{ to: PAD, data: SEL.allTokens + word(i) }, "latest"] }));
    const { json, ms } = await post(url, batch);
    expect(Array.isArray(json), `a batch is refused: ${JSON.stringify(json).slice(0, 120)}`);
    const good = json.filter((x) => x.result).length;
    expect(good === BATCH, `${good} of ${BATCH} answered`);
    return `${ms} ms`;
  });
  await run("answers a browser on the site (cross-origin)", async () => {
    const pre = await fetch(url, {
      method: "OPTIONS",
      headers: { origin: SITE, "access-control-request-method": "POST", "access-control-request-headers": "content-type" },
      signal: AbortSignal.timeout(15_000),
    });
    const allowed = (h) => h.get("access-control-allow-origin");
    expect(pre.ok, `the preflight is answered ${pre.status}`);
    expect(["*", SITE].includes(allowed(pre.headers)), `the preflight allows "${allowed(pre.headers) ?? "nobody"}"`);
    const { headers } = await post(url, { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }, { headers: { origin: SITE } });
    expect(["*", SITE].includes(allowed(headers)), `the answer allows "${allowed(headers) ?? "nobody"}"`);
  });
  await run(`gives ${WINDOW.toLocaleString("en-US")} blocks of the pad's logs in one call (the points service's window)`, async () => {
    const { result, ms } = await rpc(url, "eth_getLogs", [{ address: PAD, fromBlock: hex(head - WINDOW), toBlock: hex(head) }], { timeout: 60_000 });
    return `${result.length} logs, ${ms} ms`;
  });
  await run(
    "gives the pad's first logs (a coin's history, a backfill)",
    async () => {
      const { result, ms } = await rpc(url, "eth_getLogs", [{ address: PAD, fromBlock: hex(DEPLOY_BLOCK), toBlock: hex(DEPLOY_BLOCK + WINDOW) }], { timeout: 60_000 });
      expect(result.length > 0, "no logs where the pad's first events are: the node keeps no old logs");
      return `${result.length} logs, ${ms} ms`;
    },
    { warn: true }
  );
  await run(
    "answers quickly",
    async () => {
      const times = [];
      for (let i = 0; i < 5; i++) times.push((await call(url, SEL.tokenCount)).ms);
      times.sort((a, b) => a - b);
      expect(times[2] < 2_000, `a single eth_call takes ${times[2]} ms (median of five)`);
      return `eth_call ${times[2]} ms median, ${times[4]} ms worst of five`;
    },
    { warn: true }
  );
  await run(
    "Multicall3",
    async () => {
      const code = (await rpc(url, "eth_getCode", [MULTICALL3, "latest"])).result;
      return code && code.length > 2 ? "deployed (the site does not use it on this chain: web/lib/config.ts says why)" : "not deployed (the site does not use it)";
    },
    { warn: true }
  );
  if (explorer) {
    await run(
      `the explorer ${host(explorer)} answers its API`,
      async () => {
        const r = await fetch(`${explorer.replace(/\/$/, "")}/api/v2/addresses/${PAD}`, { signal: AbortSignal.timeout(20_000), headers: { accept: "application/json" } });
        expect(r.ok, `HTTP ${r.status}`);
        expect((await r.json()).is_contract === true, "it does not know the pad as a contract");
      },
      { warn: true }
    );
  }

  console.log(
    failed
      ? `\nNOT READY: ${failed} check${failed > 1 ? "s" : ""} failed. Do not switch.`
      : `\nREADY${warned ? ` (${warned} warning${warned > 1 ? "s" : ""}, read above)` : ""}: ${host(url)} is the same chain and serves what the site and the points service ask.`
  );
  return failed === 0;
}

function rewrite(newRpc, newExplorer) {
  const { text, rpc: oldRpc, explorer: oldExplorer } = current();
  const explorer = (newExplorer ?? oldExplorer).replace(/\/$/, "");
  writeFileSync(
    ENDPOINTS,
    text.replace(`export const LITEFORGE_RPC = "${oldRpc}";`, `export const LITEFORGE_RPC = "${newRpc}";`).replace(`export const LITEFORGE_EXPLORER = "${oldExplorer}";`, `export const LITEFORGE_EXPLORER = "${explorer}";`)
  );
  const changed = ["web/lib/points/endpoints.ts"];
  for (const f of FILES) {
    const p = join(ROOT, f);
    const before = readFileSync(p, "utf8");
    const after = before.split(oldRpc).join(newRpc).split(oldExplorer).join(explorer);
    if (after !== before) {
      writeFileSync(p, after);
      changed.push(f);
    }
  }
  return { changed, explorerChanged: explorer !== oldExplorer };
}

const [cmd, url, ...rest] = process.argv.slice(2);
const explorerArg = rest[0] === "--explorer" ? rest[1] : undefined;
try {
  if (cmd === "snapshot") {
    await snapshot();
  } else if (cmd === "check" && url) {
    process.exitCode = (await check(url, explorerArg)) ? 0 : 1;
  } else if (cmd === "switch" && url) {
    if (!(await check(url, explorerArg))) {
      process.exitCode = 1;
    } else {
      const { changed, explorerChanged } = rewrite(url, explorerArg);
      console.log(`\nwritten in ${changed.length} files:\n${changed.map((f) => `  ${f}`).join("\n")}`);
      if (!explorerChanged) console.log("the explorer is unchanged: pass --explorer <url> if it moved too");
      console.log(
        [
          "",
          "next, by hand:",
          "  cd web && npm run typecheck && npm test        # the endpoints test holds the file's shape",
          "  git add web contracts README.md && git commit && git push   # Netlify builds the site with the new endpoint and its CSP",
          "  on the server: cd ~/launch-pad && git pull && sudo systemctl restart notus-points",
          "  then: curl -s https://notus-pad.fun/api/health   # rpc:liteforge ok, points ok",
        ].join("\n")
      );
    }
  } else {
    console.log("usage: node ops/liteforge-endpoint.mjs snapshot | check <rpc> [--explorer <url>] | switch <rpc> [--explorer <url>]");
    process.exitCode = 2;
  }
} catch (e) {
  console.error(`error: ${String(e.message ?? e).replace(/https?:\/\/[^\s"']+/g, (u) => host(u))}`);
  process.exitCode = 1;
}
