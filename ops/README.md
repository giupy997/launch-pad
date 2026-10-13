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
sudo cp ops/deploy/notus-watch.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now notus-watch
```

The first message lists what it watches and what is pending. State (the last
block read, the pending operations, the site's deploy fingerprint) lives in
`ops/state/watch.json`, gitignored. `node ops/watch.mjs --dry --once` runs one
pass and prints instead of sending.

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
