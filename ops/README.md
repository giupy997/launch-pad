# Notus ops — the watch and the timelock operations

Two tools for the owner, nothing the site or the contracts depend on.

## The watch (`ops/watch.mjs`)

One process on the VPS, read-only, that tells the owner on Telegram of
anything that could move the launchpad's money or change who controls it:

- **the Base timelocks** (v12 `0xe28f…6f76`, v11 `0xeDCe…9EB2`): every
  operation scheduled, executed or cancelled, decoded to the call it makes
  (`Launchpad v12 → setTreasury(0x…)`, `migrateOut(…)`, `grantRole(PROPOSER, …)`),
  with the time it becomes executable; every role granted or revoked; a change
  of the delay. A scheduled operation nobody knows of is the one way the pad's
  cbLTC can leave: the 24-hour delay is worth exactly as much as the chance of
  seeing it in time. An operation that becomes executable is said once more.
- **the pads** (v12 and v11): the owner-only events as a second signal
  (treasury, fee, migrator, quote, operator, freeze, migrateOut, ownership,
  pool registered).
- **the site**, every ten minutes: `/api/health` answers, the homepage's (or
  the Create page's) scripts still carry the pad's address, a new deploy is
  reported when the scripts change. A hostile deploy that swapped the address
  the site sends money to is the classic frontend hack; it is reported within
  twenty minutes.
- **a heartbeat** once a day (08:00 UTC), with what is pending.

Install, on the VPS: a Telegram bot (BotFather), its token and your chat id in
`/etc/notus/watch.env` (`ops/deploy/watch.env.example`; written with `read -rs`,
root-only), then the unit:

```bash
cd ~/launch-pad && sudo bash ops/deploy/install-units.sh
```

(the script installs the watch and the points service together, each as its
own system user, sandboxed: `ops/deploy/notus-watch.service`; run it again
after a change to a unit). The first message lists what it watches and what
is pending. State (the last block read, the pending operations, the site's
deploy fingerprint, the messages not yet sent) lives in
`/var/lib/notus-watch/watch.json`. The Base nodes come from `NOTUS_WATCH_RPC`
(a keyed one first), and the three public nodes are always kept after them:
when a key is refused and one public node rate-limits the server, the watch
reads from the next one instead of going blind (as it did on 2026-11-01 for
an hour). `node ops/watch.mjs --dry --once` runs one
pass and prints instead of sending (from a shell, it writes its state to
`ops/state/watch.json`, gitignored).

## Liteforge's endpoint (`ops/liteforge-endpoint.mjs`)

LitVM's testnet is reached through one RPC endpoint, written once for the
site and the points service (`web/lib/points/endpoints.ts`: the wagmi chain,
the server routes, the explorer API, the bridge page and the
Content-Security-Policy all read it) and named in the contracts' scripts,
`foundry.toml`, the live fork test and the README. When LitVM moves it (the
infrastructure upgrade of 2026-11-10 retired the Caldera endpoints for
Zeeve's, `rpc.testnet.liteforge.zeeve.net`, switched that evening with every
check passed), the script checks the new endpoint and writes it in all of
them:

```bash
node ops/liteforge-endpoint.mjs snapshot                         # before the move: the chain as the current endpoint shows it
node ops/liteforge-endpoint.mjs check  <new rpc> [--explorer <url>]
node ops/liteforge-endpoint.mjs switch <new rpc> [--explorer <url>]   # check, then rewrite; no commit, no push
```

`snapshot` writes `ops/liteforge-fingerprint.json`: the chain id, the hashes
of the pad's deploy block and of a recent block, the pad's code and its list
of coins. `check` holds a new endpoint to it: the same chain id, the same
two hashes, the pad with the same code and the same coins, a head at least
as far as the fingerprint and as the points service has read; and it asks of
the endpoint what the site and the service ask: thirty calls in one request,
a browser's cross-origin request from notus-pad.fun, 9,000 blocks of logs in
one call, the pad's first logs. It reads only and names an endpoint by its
host. `switch` refuses an endpoint that fails a check.

After a switch: `cd web && npm run typecheck && npm test`, commit `web`,
`contracts` and `README.md`, push (Netlify builds the site with the new
endpoint in its bundle and in its policy), then on the server
`cd ~/launch-pad && git pull && sudo systemctl restart notus-points` (the
service reads the chain from the same file and resumes from its checkpoint),
and `curl -s https://notus-pad.fun/api/health` for `rpc:liteforge` and
`points`. Between the old endpoint going dark and the push, the testnet's
pages show their placeholders and the service leaves the blocks for its next
pass; Base is untouched. A wallet that already holds the network keeps the
old RPC: its owner edits the network's RPC URL, or removes the network and
lets the site add it again.

If the check fails on the chain itself (another chain id, no code at the
pad's address, other hashes), the state did not come over and a new endpoint
is not enough: the pad would be deployed again (`DeployLitVM.s.sol`, the
owner's call) and its address, deploy block and the season written in
`web/lib/config.ts` and `web/lib/points/chains.ts`. The points service's
record of Season 0 stays on the server whatever the chain does.

## The timelock operations (`contracts/script/ops/timelock.sh`)

The owner's operations on the Base v12 timelock, each scheduled now and
executable by anyone after the delay (24 h). Since the handover of 2026-10-12
the only proposer and canceller is the Safe 2-of-3: an operation is prepared
on the VPS as calldata, signed in the Safe (Transaction Builder → custom data,
two signatures), and executed from the VPS once ready. The key on the VPS
executes; it schedules only on a timelock where it still proposes (a
rehearsal pad's).

| | |
|---|---|
| `safe-calldata set-treasury` | the pad pays its 0.5% to a new address from the execution on (the zero address is refused) |
| `safe-calldata set-migrator` | a migrator deployed with `migrator.sh`, before any coin graduates (a coin keeps the one it graduated through) |
| `safe-calldata set-root FILE` | the pad commits to a migration snapshot's root and freeze block, once (a dry-run file is refused) |
| `safe-calldata revoke` | this machine's key loses PROPOSER and CANCELLER; never the Safe's own (refused: a timelock with no proposer and no admin can never be given one again) |
| `safe-calldata cancel ID` | a pending operation is withdrawn before it is ready: the Safe's one move against a wrong or hostile one; the watch's siren prints the same `to`/`data` |
| `execute ID` | once ready (anyone may); the outcome is read from the transaction's receipt |
| `status ID` | |
| `grant`, `handover`, `revoke`, `set-treasury`, `cancel ID` | the same from this machine's key, for a timelock it proposes on (none on Base today) |

Each `safe-calldata` prints `to` (the timelock), `value` 0 and `data` for the
Transaction Builder, and saves the operation by its id under
`~/notus-ops/<id>.json`, so `execute` finds its arguments. Addresses are asked
at the prompt and echoed back checksummed for a `yes`. The scripts refuse a
node that answers for another chain than the addresses file's, and a
`PRIVATE_KEY` from the environment on a live chain (`ALLOW_PRIVATE_KEY=1` to
insist); the RPC URL travels in `ETH_RPC_URL`, never on a command line. The
watch reports each operation as it lands, and tells how to cancel one it
flags.

Before signing: decode the `data` on another machine (`cast 4byte-decode`,
or paste it into the Safe's decoder) and compare it with what the VPS
printed. The calldata is produced on the VPS; the Safe exists so that the VPS
alone can do nothing, which holds only if a signer reads what it signs.
