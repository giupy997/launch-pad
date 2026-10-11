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
executable by anyone after the delay, from the proposer's key on the VPS:

| | |
|---|---|
| `grant` | an address (a Safe) becomes proposer and canceller next to the deployer's key |
| `revoke` | the deployer's key loses both roles: only after the Safe has scheduled and executed an operation of its own |
| `set-treasury` | the pad pays its 0.5% to a new address from the execution on |
| `execute ID` | once ready (anyone may) |
| `status ID`, `cancel ID` | |
| `safe-calldata set-treasury\|revoke` | the same operations prepared for a Safe that is proposer: the calldata to send to the timelock from the Safe's Transaction Builder; the execution stays a plain command |

Addresses are asked at the prompt and echoed back checksummed for a `yes`.
Every scheduled operation is written to `~/notus-ops/<id>.json`, so `execute`
and `cancel` find their arguments. The watch reports each one as it lands.

The order the owner planned: a Safe 2-of-3 on Base (the dev wallet, a fresh
signing wallet, a fresh recovery wallet) made proposer with `grant`; proven
with one operation of its own; the deployer's key then revoked with `revoke`.
From then on only the Safe schedules and cancels; the key on the VPS schedules
nothing on Base. With the Safe as proposer, the migration runbook's `schedule`
steps are sent from the Safe (`safe-calldata`, or the Transaction Builder with
the same arguments); every `execute` stays as written.
