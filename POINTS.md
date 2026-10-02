# Points and referrals

A season-based points system for the Base launchpad: every wallet earns points
for what it does on the pad, a public leaderboard ranks them, and an invite
link gives both sides a bonus. Everything is derived from the chain, computed
off-chain, and tied to wallet addresses, so it costs nothing on-chain, needs no
new contract next to the immutable pad, and survives the move to LitVM (the
addresses are the same there).

Points are a record of contribution. They are not a token, and nothing on the
site or in an announcement promises one: what a season's points unlock is
announced when the season closes, never before.

## What is rewarded, and why these numbers

The unit is tied to money that really leaves a trader: of every curve trade,
0.2% of the amount goes to the pad's treasury, whatever the coin's own fee
split. **A point is one ten-thousandth of a cbLTC that reached the treasury**,
which is the same as saying **20 points per cbLTC traded**, buy or sell. That
is the whole base layer, and it is what makes the system hard to farm: however
you move cbLTC through the pad, the points you get are proportional to what you
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
| A coin graduates | its creator | 2,000 points (the equivalent of 100 cbLTC traded) | graduating your own coin alone costs about 40 cbLTC of slippage into the locked pool, 18× the price of the same points earned trading |
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

Worked example. A wallet buys 2 cbLTC of a coin and later sells 1 cbLTC of it:
3 cbLTC of volume, 60 points. The coin graduates while the wallet still holds
the rest: +30. It was among the first 25 buyers: +100. It came in through an
invite within the last 30 days: +3 on the 60. Total 193, and the inviter gets 6.

## Seasons

Points accrue in seasons. **Season 1 runs from the pad's deploy block
(52,045,689) to the LitVM freeze block**, so every trade made so far counts
retroactively. The freeze announcement (`FreezeAnnounced` on the pad) fixes the
end; the season closes at that block and its ranking is final. Season 2 opens
on LitVM with the same wallets.

Rules may be tuned during a season (weights, a new bonus), and the doc and the
site say so. Tuning is safe because points are never stored as the source of
truth: they are recomputed from the indexed trades, coins and referrals, so a
rule change replays the season deterministically.

## Referrals

The invite link is the wallet address: `notus-pad.fun/?ref=0x…`. No codes to
generate or store; a vanity name can come later.

Accepting is a signature, not a transaction: the invitee signs the plain
message `Notus referral · I was invited by 0x… · Season 1` (EIP-191) from
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
with a clear line on what both sides get and a "not now".

## How it runs

Mirrors the Litecoin desk (`litecoin/desk.ts`): one long-running Node process
on the VPS, a systemd unit, Caddy in front, the site reading it through a
same-origin API route. No framework, no native modules: Node 22 runs the
TypeScript directly, `node:sqlite` holds the data, `fetch` talks to the RPCs.

**Indexer.** Reads the pad's logs on Base in 1,999-block ranges (the public
nodes' cap, measured) from `mainnet.base.org` with the same fallbacks as the
site, 60 blocks behind the head so a reorg never credits a trade twice. Only
four events matter, all with the fields we need in their topics or as plain
uint256 words, so there is no ABI decoding to depend on:

- `TokenCreated(token, creator, …)`: a coin and its creator.
- `Bought(token, buyer, ethIn, tokensOut, fee)` and
  `Sold(token, seller, tokensIn, ethOut, fee)`: a trade, its volume in cbLTC
  (`ethIn` or `ethOut`, 8 decimals), its tokens.
- `Graduated(token, raisedEth)`: the block that fixes the holder, creator and
  early-buyer bonuses.
- `FreezeAnnounced(freezeBlock)`: the season's end.

Holdings at graduation need no Transfer logs: before graduation a LaunchToken
only moves through the pad, so a wallet's balance is its buys minus its sells.

**Data** (`points/data/points.sqlite`), raw tables as the source of truth and
a ledger derived from them:

```
meta(key, value)                       last indexed block, season bounds, rules version
coins(token PK, creator, created_block, graduated_block)
trades(tx, log_index, block, ts, token, wallet, side, quote, tokens)   PK (tx, log_index)
referrals(invitee PK, inviter, block, ts, signature)
ledger(wallet, season, kind, points, token, ref, block)                 kind: trade | grad_holder | grad_creator | early | ref_inviter | ref_invitee
```

`rebuild` drops the ledger and replays it from the raw tables; the service
does it itself when the rules version changes.

**API** on `127.0.0.1:8789`, JSON, GET answers cached a minute:

```
GET  /season                      season number, bounds, last indexed block, rules version
GET  /leaderboard?limit=100       rank, wallet, points, trades, referrals
GET  /wallet/0x…                  points by kind, rank, trades, inviter, invitees, 30-day bonus left
POST /referral                    { invitee, inviter, signature } → 201, or 409 when already bound
GET  /health
```

Caddy exposes it under the desk's hostname, `desk.notus-pad.fun/points/*`,
no new DNS. The site proxies it at `/api/points/*` (`POINTS_URL` in Netlify's
environment, like `LTC_STATE_URL`), with the edge caching GETs for 30 seconds
and passing POSTs through; the service rate-limits POSTs by IP.

**Site.**

- `/points`: the season banner (what counts, how long it has run), the
  leaderboard, and, with a wallet connected, "your points" with the breakdown
  and your invite link with a copy button. The explainer is short and uses
  the table above in words.
- Profile: a "Points" section at the top with rank, points by kind, the invite
  link, the invitees and what they brought.
- Trade box: a one-line hint under the quote, "≈ +40 pts", so every trade
  shows what it earns.
- Explore: a thin "Season 1 is on" strip linking to `/points`.
- Layout: a client component that reads `?ref=` into `localStorage` and, when
  a wallet connects with a pending invite, offers the signature.

## Rollout

1. This document agreed, with the open choices below settled.
2. `points/` service: indexer, ledger, API, `points/deploy/notus-points.service`
   and the Caddy block; backfill Season 1 from the deploy block (a day of
   history today, minutes of work for the indexer).
3. Site: proxy route, `/points`, the profile section, the trade-box hint, the
   referral capture and signature.
4. Announce Season 1 with its retroactive start, and the invite links.

Later, in this order if wanted: streaks with a minimum trade, holding points
with a daily cap, soulbound badges minted from the same ledger (first 25 of a
graduated coin, graduated creator, top 10 of a season).

## Open choices

- **The weights.** 20 points per cbLTC traded; +50% holder bonus; 2,000 to the
  graduated creator; 100 to each of the first 25 buyers; 10% to the inviter,
  +5% for 30 days to the invitee. The base rate only scales the numbers; the
  bonuses are what shape behaviour.
- **Season 1's end.** The LitVM freeze, as proposed, or a fixed date if the
  freeze is far.
- **What Season 1 unlocks.** Decided and announced at its close. The honest
  options are a share of the treasury's cbLTC of the season, or priority and
  badges on LitVM. Never worded as a token.
- **Whether a bare referral link counts without a signature.** Proposed no,
  for the reasons above.
- **Retroactivity.** Proposed yes from the deploy block: the first traders
  are exactly who should be at the top of the first board.
