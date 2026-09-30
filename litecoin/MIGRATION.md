# Migrating the Litecoin ledger to LitVM mainnet

The ledger on Litecoin mainnet is frozen at a block announced a week ahead.
Its frozen state — every coin's curve, every holder's balance — becomes a
migration file whose state root is committed on the LitVM Launchpad before
the first coin. The LTC in the curves and pools leaves the desk with the
`bridge` memo and is taken to LitVM. The migration script schedules the
re-creation of every coin through the timelock — 48 hours in the open — then
executes it: each coin gets its token, its holders their balances at the
same price, a graduated coin its locked pool. The site then links every
Litecoin coin page to its LitVM token. Claims, refunds and payouts stay on
Litecoin, paid by the desk as before.

Rehearsed end to end on the testnets on 2026-09-30: LCAT, Litecoin testnet4
frozen at block 4,903,863 → Liteforge (chain 4441), scheduled and executed
through the timelock `0xFaFc…0C87`, token `0xA12e…808F`, ~0.93M gas for a coin
with no holders. Every step below is the same command with the mainnet names.

## What moves, and to whom

- **Every coin.** One still on its curve continues at the same price: its
  LitVM curve is funded with exactly the LTC the ledger's curve held. One
  that graduated brings its pool — its LTC against its tokens, the same
  price — into a locked Uniswap v2 pool.
- **Every holder**, to an EVM address chosen in this order: the address they
  registered on the ledger with `NOTUS1 evm 0x…` (the wallet page, rules v2,
  from block 3,191,000); else the account of the very key that signed their
  Litecoin transactions (Litecoin and EVM share the curve — the wallet page
  shows it, and the browser wallet's secret opens it in MetaMask); else — a
  holder who only ever *received* coins by `send` and never signed anything,
  or one whose key cannot be read (Taproot) — the vault (`--vault`), a fresh
  EVM address you control, for a signed claim (step 10).
- **Every creator**, resolved the same way: creator fees on LitVM accrue
  there. Fees already earned on the ledger stay claimable on Litecoin.
- **Not the treasury**: deploy fees and the desk's share stay on Litecoin
  (sweep them to cold storage later). **Not the claims and payouts**: the desk
  keeps paying them on Litecoin; anything sent to the desk with a trading memo
  after the freeze is credited back to its sender.

Holders need do nothing — unless they want another destination or hold with
a hardware or Taproot key: those register before the snapshot.

## 0. The checklist, and one file for the names

From LitVM mainnet: its chain id, a public RPC URL, its Blockscout URL, the
route that bridges LTC to zkLTC, and a Uniswap v2 router (Lester Labs on
Liteforge — find their mainnet router, or deploy without one and
`setMigrator` later through the timelock; graduations stay manual until then).

On our side: the deployer key (`contracts/.env`, `PRIVATE_KEY`) holding zkLTC
for gas — bridge a little first; the mainnet desk healthy
(`https://desk.notus-pad.fun/main/health` says `"ok":true`), with more than
one explorer source; a backup of `/etc/notus/desk-main.key`; Litecoin past
block 3,191,000 (rules v2: `evm`, `bridge`, `sweep`); the repo's tests green
(`forge test`, and the Node tests in `litecoin/README.md`).

Every block below starts with `source ~/notus-mainnet.env`. Fill it in as the
pieces arrive, so no command ever carries a placeholder:

```bash
cat > ~/notus-mainnet.env <<'EOF2'
export PATH="$HOME/.foundry/bin:$PATH"
export CHAIN_ID=              # LitVM mainnet
export BLOCKSCOUT=            # https://… (no trailing slash)
export UNIV2_ROUTER=          # the Uniswap v2 router, or leave empty
export TREASURY=              # where the Launchpad's fees go: a cold address, not the deployer
export LAUNCHPAD=             # step 2
export TIMELOCK=              # step 2
export FREEZE=                # step 4: the block
export BRIDGE_FROM=           # step 6: your own Litecoin address, the one you bridge from
export DESK_ENV="NOTUS_LTC_NETWORK=main NOTUS_LTC_STATE=/home/notus/launch-pad/litecoin/cache/main-state.json NOTUS_LTC_DESK_DIR=/home/notus/launch-pad/litecoin/desk-main NOTUS_LTC_DESK_KEY_FILE=/etc/notus/desk-main.key NOTUS_LTC_API=https://litecoinspace.org/api,https://litecoinblockexplorer.net/api/v2"
EOF2
chmod 600 ~/notus-mainnet.env
```

`DESK_ENV` mirrors the desk unit's environment for the two commands that
spend from the desk key (steps 6 and 10): copy the unit's `NOTUS_LTC_API`
line, and `NOTUS_LTC_API_KEY=…` if it has one.

## 1. The chain in the repo (a commit, days before)

- `contracts/foundry.toml`: `litvm = "<rpc>"` under `[rpc_endpoints]` and
  `litvm = { key = "verifyContract", chain = <id>, url = "<blockscout>/api" }`
  under `[etherscan]`.
- `web/next.config.mjs`: the RPC's origin in `RPC_HOSTS`, or the policy blocks
  the wallets' reads.

Push, pull on the VPS.

## 2. Deploy and verify: Launchpad, migrator, timelock

```bash
source ~/notus-mainnet.env; cd ~/launch-pad && git pull && cd contracts && source .env
${UNIV2_ROUTER:+UNIV2_ROUTER=$UNIV2_ROUTER} TREASURY="$TREASURY" forge script script/DeployLitVM.s.sol --rpc-url litvm --private-key "$PRIVATE_KEY" --broadcast
```

(The first word passes the router only when the env file has one: the script
takes an unset variable as "no migrator yet", an empty one as an error.)
Note `Launchpad`, `UniV2Migrator` and `Deploy block` from the log; put the
Launchpad in `~/notus-mainnet.env`. Then the timelock — 48 hours, owning the
pad from the same transaction:

```bash
source ~/notus-mainnet.env; cd ~/launch-pad/contracts && source .env
TIMELOCK_DELAY=172800 LAUNCHPAD="$LAUNCHPAD" forge script script/DeployTimelock.s.sol --rpc-url litvm --private-key "$PRIVATE_KEY" --broadcast
cast call "$LAUNCHPAD" "owner()(address)" --rpc-url litvm     # must print the timelock
```

Put the timelock in the env file. Verify all three on Blockscout, from this
very checkout (same sources, same `foundry.toml`); the proposer is the
deployer unless `PROPOSER` was set:

```bash
source ~/notus-mainnet.env; cd ~/launch-pad/contracts && source .env
Z=0x0000000000000000000000000000000000000000; PROPOSER=$(cast wallet address --private-key "$PRIVATE_KEY")
MIGRATOR=$(cast call "$LAUNCHPAD" "migrator()(address)" --rpc-url litvm)
forge verify-contract --chain "$CHAIN_ID" --verifier blockscout --verifier-url "$BLOCKSCOUT/api/" --watch \
  --constructor-args "$(cast abi-encode 'constructor(address,address)' "$TREASURY" $Z)" "$LAUNCHPAD" src/Launchpad.sol:Launchpad
forge verify-contract --chain "$CHAIN_ID" --verifier blockscout --verifier-url "$BLOCKSCOUT/api/" --watch \
  --constructor-args "$(cast abi-encode 'constructor(address,address)' "$LAUNCHPAD" "$UNIV2_ROUTER")" "$MIGRATOR" src/UniV2Migrator.sol:UniV2Migrator
forge verify-contract --chain "$CHAIN_ID" --verifier blockscout --verifier-url "$BLOCKSCOUT/api/" --watch \
  --constructor-args "$(cast abi-encode 'constructor(uint256,address[],address[],address)' 172800 "[$PROPOSER]" "[$PROPOSER,$Z]" $Z)" \
  "$TIMELOCK" lib/openzeppelin-contracts/contracts/governance/TimelockController.sol:TimelockController
```

When the CLI keeps retrying (Blockscout indexes a new address with a lag: open
its page once first), verify by hand: `forge build && node
script/standard-input.mjs src/Launchpad.sol:Launchpad
src/UniV2Migrator.sol:UniV2Migrator
lib/openzeppelin-contracts/contracts/governance/TimelockController.sol:TimelockController`
writes `out/verify/<Name>.standard-input.json`; on each contract's page,
*Verify & publish → Solidity (Standard JSON input)*, compiler 0.8.24, the
same constructor arguments as above (without `0x`).

## 3. The site knows the chain (a commit)

In `web/lib/config.ts`: a `litvm` chain like `litvmTestnet` (id, RPC,
explorer, native zkLTC); into `APP_CHAINS`; make it `DEFAULT_CHAIN` and the
one in `VISIBLE_CHAINS`; its rows in `LAUNCHPAD_ADDRESS` (the pad),
`LAUNCHPAD_DEPLOY_BLOCK` (the deploy block), `QUOTE_ASSETS` (native zkLTC),
and the wagmi `chains`/`transports`. The Deployments rows in `README.md`.
Push: Netlify deploys; the LitVM pages show the new, empty pad without errors,
and a wallet connects to the new chain.

## 4. Announce the freeze, a week ahead

Pick a block at least 4,032 ahead (seven days at 2.5 minutes) and past
3,191,000. On the mainnet desk:

```bash
source ~/notus-mainnet.env; echo "$FREEZE" > ~/freeze-main.txt
sudo mkdir -p /etc/systemd/system/notus-desk-main.service.d
printf '[Service]\nEnvironment=NOTUS_LTC_FREEZE=%s\n' "$FREEZE" | sudo tee /etc/systemd/system/notus-desk-main.service.d/freeze.conf >/dev/null
sudo systemctl daemon-reload && sudo systemctl restart notus-desk-main
sleep 30; curl -s https://desk.notus-pad.fun/main/state.json | grep -o '"freezeHeight":[^,]*'; curl -s https://desk.notus-pad.fun/main/health
```

The indexer refuses a height behind the chain and one that moves (only
deleting `litecoin/cache/main.json`, a full re-index, starts over). From now
every Litecoin page counts down to the block and links to the wallet page's
*LitVM — where your coins land*. Announce it: the block and its date, that
holders on hardware or Taproot wallets — or who want another destination —
register there before the snapshot, that trading continues until the block,
and that claims and payouts go on afterwards on Litecoin.

## 5. Past the freeze: settle, then snapshot

Wait until the chain is six blocks past `FREEZE` (~15 minutes; the snapshot
refuses earlier) and the desk has paid the refunds the freeze produced
(`/main/health`: `payouts.live` 0). Then, as `notus`:

```bash
source ~/notus-mainnet.env; cd ~/launch-pad
NOTUS_LTC_STATE=litecoin/cache/main-state.json node litecoin/migration-snapshot.ts
```

It prints `N coins, H holders, bridge X LTC, settle Y LTC on Litecoin` and
writes `litecoin/migration/main-$FREEZE.json`. If it stops on *unresolved*
holders, it lists them: wait for their registration and run it again, or
add `--vault 0x…` — a fresh EVM address you control, on a hardware wallet —
and their coins go there for a signed claim. Commit and push the file from a
machine with push access: it is the public record anyone replays the ledger
against (`stateRoot`).

## 6. Bridge the curves' LTC

Desk stopped, no payout in flight (the tool refuses otherwise):

```bash
source ~/notus-mainnet.env; cd ~/launch-pad
sudo systemctl stop notus-desk-main
sudo env $DESK_ENV node litecoin/sweep.ts --bridge litecoin/migration/main-$FREEZE.json --to "$BRIDGE_FROM"          # shows what it would send
sudo env $DESK_ENV node litecoin/sweep.ts --bridge litecoin/migration/main-$FREEZE.json --to "$BRIDGE_FROM" --yes    # broadcasts it
sudo systemctl start notus-desk-main
```

It sends exactly the file's `bridge` amount, whole (the desk pays the fee),
with the `bridge` memo; two confirmations later the ledger page shows
*Bridged to LitVM* and *Owed to users* drops by as much, health stays green.
Run again and it sends nothing. **Never lift the freeze after this**: without
it the ledger would not read the bridge and count the curves as owed again.

From `BRIDGE_FROM`, take that LTC to LitVM through the bridge, to the
deployer account — it pays each coin's `value` at the execute. Wait until it
holds the amount plus gas:

```bash
source ~/notus-mainnet.env; cd ~/launch-pad/contracts && source .env
cast balance "$(cast wallet address --private-key "$PRIVATE_KEY")" --rpc-url litvm --ether
```

## 7. Schedule: 48 hours in the open

```bash
source ~/notus-mainnet.env; cd ~/launch-pad/contracts && source .env
LAUNCHPAD="$LAUNCHPAD" TIMELOCK="$TIMELOCK" MODE=schedule MIGRATION_FILE=../litecoin/migration/main-$FREEZE.json \
  forge script script/MigrateFromLedger.s.sol --rpc-url litvm --private-key "$PRIVATE_KEY" --broadcast
```

For each operation the log says `calls`, `ready at` (unix time) and `LTC
needed` (wei): the first carries `setMigrationRoot`, and the needs add up to
the bridged amount. Publish the transaction hashes: anyone can read what
will run. The proposer can still `cancel` an operation on the timelock until
it runs.

## 8. Execute, in rounds, and publish

After the delay:

```bash
source ~/notus-mainnet.env; cd ~/launch-pad/contracts && source .env
LAUNCHPAD="$LAUNCHPAD" TIMELOCK="$TIMELOCK" MODE=execute MIGRATION_FILE=../litecoin/migration/main-$FREEZE.json \
  forge script script/MigrateFromLedger.s.sol --rpc-url litvm --private-key "$PRIVATE_KEY" --broadcast
```

`executed operation i` for each, then either `ticker -> token map written to
…main-$FREEZE.json.migrated.json` — done — or `not every coin has its token
and its holders yet`: a coin with more than 150 holders takes another round.
Run `MODE=schedule` again (only what is left is scheduled), wait the delay,
`MODE=execute`, until the map is written. Both modes are safe to repeat.

Spot checks on Blockscout: a holder's token balance is their ledger balance
× 10¹⁰; `migrationPending(token)` is 0 on every token; a coin's price on the
LitVM page equals its last price on the Litecoin page. Then publish the map:

```bash
source ~/notus-mainnet.env; cd ~/launch-pad
cp litecoin/migration/main-$FREEZE.json.migrated.json web/public/litecoin/migrated.json
# commit litecoin/migration/main-$FREEZE.json* and web/public/litecoin/migrated.json, push
```

Netlify deploys; every Litecoin coin page now says *Trade $X on LitVM* and
links its token.

## 9. Close, and make the freeze history

Once every coin is delivered, close the migration for good through the
timelock (48 hours between the two):

```bash
source ~/notus-mainnet.env; cd ~/launch-pad/contracts && source .env
Z32=0x0000000000000000000000000000000000000000000000000000000000000000; SALT=$(cast keccak "notus-close-migration"); DATA=$(cast calldata "closeMigration()")
cast send "$TIMELOCK" "schedule(address,uint256,bytes,bytes32,bytes32,uint256)" "$LAUNCHPAD" 0 "$DATA" $Z32 "$SALT" 172800 --rpc-url litvm --private-key "$PRIVATE_KEY"
# 48 hours later:
cast send "$TIMELOCK" "execute(address,uint256,bytes,bytes32,bytes32)" "$LAUNCHPAD" 0 "$DATA" $Z32 "$SALT" --rpc-url litvm --private-key "$PRIVATE_KEY"
```

Commit the freeze into the rules — `freezeHeight: <FREEZE>` in
`PARAMS.main`, `web/lib/litecoin/ledger.ts` — so every replay agrees without
the variable; the desk's `freeze.conf` may then go (the indexer takes the
committed value when the variable is unset).

## 10. Afterwards, on Litecoin

- **Keep the desk running.** Claims and payouts continue; late instructions
  are credited back. `/main/health` stays the monitor.
- **Vault claims**, by hand. The holder signs the text
  `Notus vault claim <TICKER> <their LitVM address>` with the Litecoin
  address's key (Electrum-LTC or Litescribe, *Sign message*), and sends
  address, text and signature. Verify, then transfer from the vault:

  ```bash
  cd ~/launch-pad/web && node --experimental-strip-types --input-type=module -e '
  const m = await import("./lib/litecoin/message.ts");
  const [address, text, signature] = process.argv.slice(1);
  console.log(m.verifyMessage(address, text, signature, "main") ? "signed by that address" : "NOT signed by that address");' -- "$ADDRESS" "$TEXT" "$SIGNATURE"
  ```

- **Sweep the treasury** to cold storage once payouts are quiet
  (`litecoin/README.md`, *Cold storage*): what was bridged no longer counts
  as owed, so the sweep sees the treasury whole.

## If something goes wrong

- **Before the freeze block**: removing `freeze.conf` and restarting lifts
  it cleanly; nothing happened yet. Announce it.
- **Past the freeze block**: do not lift it. Refunds the desk paid for late
  instructions would not be owed in a replay without the freeze, and the
  ledger would stop adding up. Go forward: snapshot again if holders still
  register, bridge, schedule.
- **Scheduled, not executed**: the proposer cancels the operation on the
  timelock; the bridged LTC is still in the deployer account. A new snapshot
  means a new root — but the pad takes `setMigrationRoot` once, so a wrong
  root already executed means a new pad (and its timelock), as on the
  testnet.
- **Executed**: the coins exist. A coin left half-delivered simply takes its
  next round; the script skips what exists and what was delivered.
