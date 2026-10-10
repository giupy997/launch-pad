# Notus points — the service

One long-running Node process on the VPS: for every chain it is configured
for, it reads the launchpad's logs a stretch at a time, keeps them on disk,
recomputes the season's ledger after every pass, and answers the leaderboard,
a wallet's points and invite acceptances over HTTP. The website reads it
through its `/api/points` route. The design, the rules and why they are what
they are: [`POINTS.md`](../POINTS.md).

No key, no wallet. The only writes are invite bindings, each authorised by the
invitee's own signature.

## Layout

| Where | What |
|---|---|
| `points/service.ts` | the process: passes, HTTP, graceful stop |
| `web/lib/points/chains.ts` | the chains it can index: pad, deploy block, RPCs, quote decimals, season |
| `web/lib/points/rules.ts` | the weights and the ledger arithmetic, pure |
| `web/lib/points/decode.ts` | the five pad events, decoded with viem |
| `web/lib/points/scan.ts` | reading logs from public nodes: per-node tries, range caps learned from refusals, throttles, failures reported not thrown |
| `web/lib/points/indexer.ts` | one chain's facts in memory and on disk, the ledger, the views |
| `web/lib/points/store.ts` | JSON lines on disk: `events.jsonl`, `referrals.jsonl`, `meta.json` |
| `web/lib/points/referral.ts` | the invite message and its verification (shared with the site) |
| `points/deploy/notus-points.service` | the systemd unit |
| `points/deploy/Caddyfile` | the `/points/*` block in front of it (the VPS's only Caddy config) |

The logic lives under `web/lib/` so it resolves `viem` from the site's
`node_modules` (the process has none of its own) and so the site reuses the
same rules and the same referral message.

## Run

```bash
node points/service.ts                      # Node 22.18+ runs the TypeScript as is; older: add --experimental-strip-types
```

Environment: `PORT` (default 8789), `NOTUS_POINTS_CHAINS` (comma-separated
keys of `chains.ts`, default `liteforge`), `NOTUS_POINTS_DATA` (a directory,
default `points/data`), `NOTUS_POINTS_EVERY` (seconds between passes, default
10). Data lands in `<data>/<chain>/`; delete a chain's directory to re-index
it from the pad's deploy block.

Tests, against fakes of the real nodes and made-up pads (no network):

```bash
node --test --experimental-strip-types web/lib/points/*.test.ts
```

## On the VPS

```bash
cd ~/launch-pad && git pull && (cd web && npm install --no-audit --no-fund)
sudo cp points/deploy/notus-points.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now notus-points
journalctl -u notus-points -f                                 # the backfill of Season 0, then a pass every 10s
sudo cp points/deploy/Caddyfile /etc/caddy/Caddyfile && sudo systemctl reload caddy
curl -s https://desk.notus-pad.fun/points/health
```

Then on Netlify: `POINTS_URL=https://desk.notus-pad.fun/points`.

## API

JSON; `GET` answers carry `cache-control: max-age=30`.

```
GET  /health                              ok, per chain: last block, head, age, counts, last error
GET  /:chain/season                       chain, season, rules, what is indexed
GET  /:chain/leaderboard?limit=100        rank, wallet, points, trades, volume (quote wei), invitees
GET  /:chain/wallet/0x…                   points by kind, rank, trades, volume, inviter, invitees, bonus end
POST /:chain/referral                     { invitee, inviter, signature } → 201; 400 bad claim; 409 already invited; 429 too many
```

Points come as numbers with up to three decimals (they are kept in
thousandths); `volume` comes as a decimal string of the quote's smallest unit.

## Operating notes

- A pass reads up to 40 ranges; a backfill of a long history proceeds pass by
  pass while the API answers with what is indexed so far (`indexed.last` in
  `/season`).
- A stretch no node served is read again next pass; the indexer never skips
  blocks. `lastError` in `/health` says what stood in the way.
- The ledger is recomputed from the events on every pass and on every start,
  so a change of weights in `rules.ts` (and `RULES_VERSION`) applies to the
  whole season on the next restart; the events on disk are the only truth.
- A `FreezeAnnounced` on a pad being migrated out closes its season at the
  announced block.
