# Points and referrals

A season-based points system for the launchpad **on LitVM**: every wallet
earns points for what it does on the pad, a public leaderboard ranks them, and
an invite link gives both sides a bonus. Everything is derived from the chain,
computed off-chain, and tied to wallet addresses, so it costs nothing on-chain
and needs no new contract next to the immutable pad.

It is one of four features that come with LitVM, not with Base (see
*Coming with LitVM* at the end). Until LitVM mainnet is live it runs **on the
Liteforge testnet only**, against the pad already there, as a rehearsal:
testnet points are for testing, are worth nothing and are wiped when mainnet
opens. On Base the site only announces it.

Points are a record of contribution. They are not a token, and nothing on the
site or in an announcement promises one: what a season's points unlock is
announced when the season closes, never before.

## What is rewarded, and why these numbers

The unit is tied to money that really leaves a trader: of every curve trade,
0.2% of the amount goes to the pad's treasury, whatever the coin's own fee
split. **A point is one ten-thousandth of an LTC that reached the treasury**,
which is the same as saying **20 points per LTC traded**, buy or sell (zkLTC
on LitVM, one LTC each; the figure reads the same for cbLTC on Base). That is
the whole base layer, and it is what makes the system hard to farm: however
you move LTC through the pad, the points you get are proportional to what you
gave up, and the same 0.2% funds whatever the points unlock. Nobody can take
out more than they put in.

Why not fees as a whole: a creator setting a 10% tax on their own coin and
trading it pays that tax to themselves. Why not volume with a multiplier per
coin: the same. The treasury cut is the one piece of a trade that is uniform
and gone for good.

On top of the base layer, bonuses for what makes the pad grow. Each is bounded
by something that costs real money:

| Event | Who | Bonus | Why it cannot be farmed cheaply |
|---|---|---|---|
| A coin graduates | every wallet still holding it at the graduation block | +50% on all the trade points it earned on that coin | proportional to fees already paid; a dust balance only keeps what you bought |
| A coin graduates | its creator | 2,000 points (the equivalent of 100 LTC traded) | graduating your own coin alone costs about 40 LTC of slippage into the locked pool, 18× the price of the same points earned trading |
| A coin graduates | its first 25 distinct buyers | 100 points each | needs the graduation above; 25 sybil wallets still pay gas and fees |
| Referral | the inviter | 10% of the invitee's trade points, for the season | an inviter inviting their own second wallet gets a 10% discount on their own points, nothing more |
| Referral | the invitee | +5% on their own trade points for 30 days after accepting | same |

Held back for a later version, with their caveats: a daily streak multiplier
(powerful for engagement, trivially gamed with one dust trade a day unless the
trade has a minimum size), and holding points per day (rewards not selling,
but valuing a position at the curve price lets a creator's own buys inflate
it; would need a per-wallet daily cap).

Trades on hidden coins (`HIDDEN_TOKENS` in the site's config) do not count.
Nothing else is excluded: a creator trading their own coin pays the same 0.2%
as anyone.

Worked example. A wallet buys 2 LTC of a coin and later sells 1 LTC of it:
3 LTC of volume, 60 points. The coin graduates while the wallet still holds
the rest: +30. It was among the first 25 buyers: +100. It came in through an
invite within the last 30 days: +3 on the 60. Total 193, and the inviter gets 6.

## Seasons

Points accrue in seasons, each on one chain:

- **Season 0, Liteforge testnet, now.** From the testnet pad's deploy block
  (57,741,789; the v11 rehearsal pad at `0x39D1…ef7F`, quoted in native zkLTC
  with a 0.05 zkLTC virtual reserve, so that a curve graduates on faucet
  money; the v9 pad's season was wiped with it) until LitVM mainnet opens. A
  rehearsal of the whole thing: indexer, rules, leaderboard, invites. Worth
  nothing, says so on the page, wiped at the end.
- **Season 1, LitVM mainnet.** Opens with the receiving pad's first block
  (`DeployLitVM.s.sol`, the one the Base coins migrate to) and runs until a
  date set when it opens. Its ranking is the first that counts.

Base has no season: what happened on Base can still be honoured at Season 1
as a one-off genesis credit (the Base trades are indexed anyway, by the same
code), an open choice below.

Rules may be tuned during a season (weights, a new bonus), and the doc and the
site say so. Tuning is safe because points are never stored as the source of
truth: they are recomputed from the indexed trades, coins and referrals, so a
rule change replays the season deterministically.

## Referrals

The invite link is the wallet address: `notus-pad.fun/?ref=0x…`. No codes to
generate or store; a vanity name can come later.

Accepting is a signature, not a transaction: the invitee signs the plain
message `Notus referral · I was invited by 0x… · Season N` (EIP-191) from
their wallet, once, and the service stores the binding. Why a signature:
without one, anyone could post a binding for somebody else's wallet and steal
their referral, or bind them to a stranger. Why not on-chain: the pad is
immutable, and a router that buys on the invitee's behalf to emit an event is
more friction than a free signature.

Rules: one inviter per wallet, forever; a wallet cannot invite itself; the
binding can happen at any time (before or after the first trade) and the
bonuses apply to trade points earned from that block on, never to the past.
The link is kept in the browser (`localStorage`) from the first visit, and the
site asks for the signature when a wallet connects with a pending invite,
with a clear line on what both sides get and a "not now". Bindings are per
chain: a testnet invite does not carry into Season 1.

## How it runs

Mirrors the Litecoin desk (`litecoin/desk.ts`): one long-running Node process
on the VPS (`points/service.ts`), a systemd unit, Caddy in front, the site
reading it through a same-origin API route. No framework, no database, no
native modules: Node 22 runs the TypeScript directly, the facts live in JSON
lines on disk, `fetch` talks to the RPCs. The logic sits in `web/lib/points/`
(like the desk's in `web/lib/litecoin/`), so it resolves viem from the site's
node_modules and the site reuses the same rules and the same invite message.
One process serves every chain it is configured for (today Liteforge, later
LitVM mainnet), each with its own pad address, deploy block, RPCs and quote
decimals (18 for native zkLTC, 8 for cbLTC). Running it: `points/README.md`.

**Indexer.** Reads the pad's logs in ranges the chain's public nodes accept
(1,999 blocks on Base, measured; Liteforge takes far wider ones; the size is
configured and learned from a refusal like the site does), 60 blocks behind
the head so a reorg never credits a trade twice. Only four events matter, all
with the fields we need in their topics or as plain uint256 words, so there is
no ABI decoding to depend on, and they are the same on every pad the site
reads (one ABI decodes all of them today):

- `TokenCreated(token, creator, …)`: a coin and its creator.
- `Bought(token, buyer, ethIn, tokensOut, fee)` and
  `Sold(token, seller, tokensIn, ethOut, fee)`: a trade, its volume in the
  quote (`ethIn` or `ethOut`), its tokens.
- `Graduated(token, raisedEth)`: the block that fixes the holder, creator and
  early-buyer bonuses.
- `FreezeAnnounced(freezeBlock)`: on a pad being migrated out, the season's end.

Holdings at graduation need no Transfer logs: before graduation a LaunchToken
only moves through the pad, so a wallet's balance is its buys minus its sells.

**Data** (`points/data/<chain>/`), the facts as the source of truth and a
ledger derived from them, never stored:

```
events.jsonl      the pad's events as read: created, bought, sold, graduated, freeze (append-only)
referrals.jsonl   the invite bindings: invitee, inviter, block, time (append-only)
meta.json         the last block indexed, the rules version, the getLogs size the nodes taught
ledger            in memory: wallet, kind, points, coin, trade, block
                  kind: trade | grad_holder | grad_creator | early | ref_inviter | ref_invitee
```

The ledger is recomputed from the events after every pass and on every
start, so a change of weights (and of `RULES_VERSION`) replays the whole
season on the next restart. Everything is tested against fakes of the real
nodes and made-up pads: `node --test --experimental-strip-types
web/lib/points/*.test.ts`.

**API** on `127.0.0.1:8789`, JSON, GET answers cached half a minute, the
chain in the path:

```
GET  /:chain/season                   chain, season, the rules, what is indexed
GET  /:chain/leaderboard?limit=100    rank, wallet, points, trades, volume, invitees
GET  /:chain/wallet/0x…               points by kind, rank, trades, volume, inviter, invitees, bonus end
POST /:chain/referral                 { invitee, inviter, signature } → 201; 400 bad claim; 409 already bound; 429 too many
GET  /health
```

Caddy exposes it under the desk's hostname, `desk.notus-pad.fun/points/*`,
no new DNS. The site proxies it at `/api/points/*` (`POINTS_URL` in Netlify's
environment, like `LTC_STATE_URL`), with the edge caching GETs for 30 seconds
and passing POSTs through; the service rate-limits POSTs by IP.

**Site.** Everything below shows on a LitVM chain (Liteforge today) and only
there; on Base, `/points` is the *Coming with LitVM* page.

- `/points`: the season banner (which season, what counts, how long it has
  run, and on the testnet that it is a rehearsal), the leaderboard, and, with
  a wallet connected, "your points" with the breakdown and your invite link
  with a copy button. The explainer is short and uses the table above in words.
- Profile: a "Points" section at the top with rank, points by kind, the invite
  link, the invitees and what they brought.
- Trade box: a one-line hint under the quote, "≈ +40 pts", so every trade
  shows what it earns.
- Explore: a thin "Season 0 is on, testnet" strip linking to `/points`.
- Layout: a client component that reads `?ref=` into `localStorage` and, when
  a wallet connects with a pending invite, offers the signature.

## Rollout

1. This document agreed, with the open choices below settled.
2. `points/` service: indexer, ledger, API, `points/deploy/notus-points.service`
   and the Caddy block; configured for Liteforge; backfill Season 0 from the
   testnet pad's deploy block. **Done**: `points/README.md`.
3. Site: proxy route, `/points` (live on Liteforge, the roadmap page on Base),
   the profile section, the trade-box hint, the referral capture and
   signature; the *Coming with LitVM* section on the About page. **Done**:
   `web/app/api/points/`, `web/app/points/`, `web/lib/points/client.ts`,
   `components/{PointsCard,SeasonStrip,InviteLink,InviteCapture}.tsx`; Netlify
   needs `POINTS_URL=https://desk.notus-pad.fun/points`.
4. Rehearse on the testnet with real wallets: trades, a graduation, invites.
5. At LitVM mainnet: add the chain to the service, open Season 1, announce it
   with the invite links.

## Coming with LitVM

The four features are a set, and none of them belongs on Base: the Base pad
is the bridge to LitVM, not the destination. In the order they can land:

1. **Points and referrals**: this document. Rehearsed on the testnet now.
2. **Badges**: soulbound NFTs minted from the same ledger (first 25 of a
   graduated coin, graduated creator, top 10 of a season). Status only, free
   to mint, nothing financial.
3. **Staking**: fee-sharing for graduated coins, the yield being the real fees
   the pad and the pools earn, never emissions. Possible only after
   graduation, since a coin on its curve moves only through the pad, and only
   once there are coins and fees worth sharing. No "APY" is quoted anywhere:
   the page shows what was actually paid out.
4. **Liquidity rewards**: for liquidity added to a graduated coin's pool, paid
   from the same real fees, with the pool's measured fee return shown as a
   fact, not a promise.

## Open choices

- **The weights.** 20 points per LTC traded; +50% holder bonus; 2,000 to the
  graduated creator; 100 to each of the first 25 buyers; 10% to the inviter,
  +5% for 30 days to the invitee. The base rate only scales the numbers; the
  bonuses are what shape behaviour. The testnet season is where to try them.
- **Season 1's length.** Set when it opens: three months is a sensible first.
- **A genesis credit for Base.** Whether Season 1 opens with a one-off credit
  for what each wallet traded on Base (the same 20 per LTC, or a capped
  amount), as a thank-you to the first traders. Proposed yes, capped.
- **What Season 1 unlocks.** Decided and announced at its close. The honest
  options are a share of the treasury's LTC of the season, or priority and
  badges. Never worded as a token.
- **Whether a bare referral link counts without a signature.** Proposed no,
  for the reasons above.
