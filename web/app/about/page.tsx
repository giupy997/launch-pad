import type { Metadata } from "next";
import { SOURCE_URL } from "@/lib/site";
import { DEFAULT_CHAIN, PAD_VERSION } from "@/lib/config";

// the fee story follows the pad the site runs on: v11 (the platform fee feeding the pot) or v12
const V12 = (PAD_VERSION[DEFAULT_CHAIN.id] ?? 11) === 12;

export const metadata: Metadata = {
  title: "About",
  description:
    "What Notus is, how coins work in cbLTC on Base, how they move to LitVM mainnet, what comes with LitVM, how your keys are handled, what the risks are, and how to reach us.",
};

const X_URL = "https://x.com/Notuspad";
const EMAIL = "notuspad@gmail.com";

export default function AboutPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <header className="space-y-4">
        <div className="pill">About</div>
        <h1 className="display text-4xl sm:text-5xl text-white">What Notus is</h1>
        <p className="text-base leading-relaxed text-zinc-400">
          Notus is an independent, open-source token launchpad. Its coins are priced in cbLTC — Litecoin wrapped by Coinbase,
          one LTC in custody for every token, with a public proof of reserves — and live in smart contracts on Base. The same
          contracts run on LitVM&apos;s Liteforge testnet, Litecoin&apos;s EVM layer, where every coin moves when its mainnet
          goes live. Notus is not affiliated with, endorsed by or operated by Coinbase, Base, Litecoin, the Litecoin Foundation,
          LitVM or Lester Labs: their names identify the public networks and protocols this site connects to.
        </p>
      </header>

      <Section title="How a coin works">
        <li>
          Anyone creates a coin in one transaction. Its whole supply sits in the launchpad contract, which sells it along a
          bonding curve: the price rises with every buy and falls with every sell, by a formula anyone can check.
        </li>
        <li>
          You pay in cbLTC, or in ETH: the buy swaps ETH for cbLTC on Aerodrome and buys, in the same transaction.{" "}
          {V12
            ? "The launchpad takes 0.5% of every buy and every sell, whole to its treasury; a coin may add a tax of its own, up to 10% on buys and on sells, split as its creator fixed at launch between the creator, its holders as cashback, buying the coin back to burn it, and the liquidity of its pool."
            : "The platform fee is 1% per trade, 0.2% of it to the treasury; a coin may add a tax of its own, up to 10% on buys and on sells. The rest is the coin's pot, split as its creator fixed at launch between the creator, its holders as cashback, buying the coin back to burn it, and the liquidity of its pool."}
        </li>
        <li>
          At 800M coins sold the coin graduates: the rest of the supply and the cbLTC raised seed a Uniswap v2 pool whose
          liquidity is locked. From then on it trades there, with no price ceiling.
          {V12 &&
            " The launchpad's fee and the coin's tax go on in the pool, taken in coins on every swap and sold by anyone's harvest, which pays everyone their share."}
        </li>
        <li>
          The launchpad&apos;s only owner is a timelock: every change — fees, treasury, the migration below — is public on the
          chain for 24 hours before it can take effect.
        </li>
      </Section>

      <Section title="The move to LitVM" id="migration">
        <li>
          When LitVM mainnet is live, every coin here is re-created there with the same holders and the same price, its pool
          included, quoted in zkLTC — LTC on LitVM — which is what cbLTC becomes, one to one.
        </li>
        <li>
          The timelock announces a freeze block at least a day ahead; every page shows the countdown. Trading goes on until
          that block, and no new coin is created from the announcement on, so the list of coins that move is final. From the
          block, the launchpad stands still: no buys, sells or transfers, so the snapshot is final.
        </li>
        <li>
          The pool that moves is the one the launchpad seeded and locked. Liquidity anyone else added to that pool on Base
          stays in it and can be withdrawn once the coin has moved; nothing can be sold into it or added to it after the
          freeze. Liquidity in any other pool of a coin — one somebody opened on another DEX, or against another asset — must
          be withdrawn before the freeze block: from that block the coin cannot leave such a pool, and its liquidity cannot be
          taken out.
        </li>
        <li>
          The snapshot reads every balance and every curve at that block, from the chain, and anyone can recompute it. The
          coins&apos; cbLTC leaves the contract to be turned into LTC and bridged to LitVM; there, the coins are created from
          the snapshot and open for trading, a few hours after the freeze. Cashback and creator fees earned here stay claimable
          here.
        </li>
        <li>
          Nothing to do on your side for the coins in your wallet: they appear at your address on LitVM, and each coin page
          here links to its new home.
        </li>
      </Section>

      <Section title="Coming with LitVM" id="roadmap">
        <li>
          Four features are being built for the pad on LitVM, where the coins are headed, not for Base. Each is rehearsed on
          LitVM&apos;s Liteforge testnet first, with the same wallets and the same pages, and opens on mainnet when the coins
          move. Nothing below is live on Base.
        </li>
        <li>
          <span className="text-white">Points and referrals.</span> A season-based record of what each wallet does on the pad,
          computed from the chain: 20 points per LTC traded, bonuses when a coin you hold or created graduates, an invite link
          that pays both sides. A public leaderboard; what a season unlocks is announced when it closes. Points are not a token.
        </li>
        <li>
          <span className="text-white">Badges.</span> Soulbound NFTs minted from that record: among the first buyers of a coin
          that graduated, creator of a graduated coin, top of a season. Status, free to mint, nothing financial.
        </li>
        <li>
          <span className="text-white">Staking and liquidity rewards.</span> For graduated coins only, paid from the fees the
          pad and the pools really earn, never from emissions. The pages will show what was paid out, not an APY.
        </li>
      </Section>

      <Section title="Your keys">
        <li>
          You connect the wallet you already have — its browser extension, or WalletConnect from your phone. Notus never sees
          its private key.
        </li>
        <li>
          Notus never asks for the seed phrase, recovery words or private key of any wallet, anywhere. A page or a message that
          does is not us.
        </li>
      </Section>

      <Section title="What to know before you trade">
        <li>Cryptoassets are highly volatile. Coins launched here can lose all of their value.</li>
        <li>
          cbLTC is Coinbase&apos;s token: Coinbase holds the LTC behind it and can pause or restrict the token, as its issuer.
          That is a risk of every cbLTC balance, in or out of Notus.
        </li>
        <li>
          During a migration the timelock takes each coin&apos;s cbLTC out of the contract to bridge it. It is the one moment the
          operator holds the reserves, for hours, announced a day ahead and visible on the chain at every step.
        </li>
        <li>
          The contracts are open source and tested, not audited. Nothing on this site is financial advice. Notus does not sell
          coins and cannot reverse a transaction.
        </li>
      </Section>

      <Section title="Verify it yourself">
        <li>
          The code:{" "}
          {SOURCE_URL ? (
            <a href={SOURCE_URL} target="_blank" rel="noreferrer" className="underline break-all">
              {SOURCE_URL}
            </a>
          ) : (
            "published at launch"
          )}
          . The site, the contracts, the migration tools and their tests are all in it.
        </li>
        <li>The contracts are verified on Blockscout; their addresses are in the repository&apos;s README and on the coin pages.</li>
      </Section>

      <Section title="Contact and security" id="security">
        <li>
          Email: <a href={`mailto:${EMAIL}`} className="underline">{EMAIL}</a>. X:{" "}
          <a href={X_URL} target="_blank" rel="noreferrer" className="underline">@Notuspad</a>. Bugs and questions: the
          repository&apos;s issues.
        </li>
        <li>
          Security reports:{" "}
          {SOURCE_URL ? (
            <a href={`${SOURCE_URL}/security`} target="_blank" rel="noreferrer" className="underline">
              GitHub security
            </a>
          ) : (
            "the repository, once it is published"
          )}
          , an email to the address above, or a direct message on X. Please give us time to fix before disclosing. Machine-readable:{" "}
          <a href="/.well-known/security.txt" className="underline font-mono">/.well-known/security.txt</a>.
        </li>
      </Section>
    </div>
  );
}

function Section({ title, id, children }: { title: string; id?: string; children: React.ReactNode }) {
  return (
    <section id={id} className="card p-5 sm:p-6 space-y-3">
      <h2 className="label">{title}</h2>
      <ul className="list-disc space-y-2 pl-5 text-sm leading-relaxed text-zinc-300 marker:text-zinc-600">{children}</ul>
    </section>
  );
}
