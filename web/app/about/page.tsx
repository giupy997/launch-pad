import type { Metadata } from "next";
import Link from "next/link";
import { SOURCE_URL } from "@/lib/site";

export const metadata: Metadata = {
  title: "About",
  description:
    "What Notus is, how coins work on the Litecoin ledger and on LitVM, how your keys are handled, what the risks are, and how to reach us.",
};

const X_URL = "https://x.com/Notuspad";

export default function AboutPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <header className="space-y-4">
        <div className="pill">About</div>
        <h1 className="display text-4xl sm:text-5xl text-white">What Notus is</h1>
        <p className="text-base leading-relaxed text-zinc-400">
          Notus is an independent, open-source token launchpad. It runs in two places: on Litecoin itself, where coins live in
          an OP_RETURN ledger, and on LitVM, Litecoin&apos;s EVM layer, where they live in smart contracts. It is not affiliated
          with, endorsed by or operated by Litecoin, the Litecoin Foundation, LitVM or Lester Labs: their names identify the
          public networks and protocols this site connects to.
        </p>
      </header>

      <Section title="How a coin works on Litecoin">
        <li>
          Every action is an ordinary Litecoin transaction that you sign yourself. It pays the desk address and carries a short
          OP_RETURN memo, such as <code className="font-mono text-zinc-200">NOTUS1 buy LESTER</code>.
        </li>
        <li>
          The ledger is recomputed from the chain. Anyone can replay the same transactions with the open-source indexer and get
          the same balances and the same state root: the <Link href="/litecoin/ledger" className="underline">ledger page</Link>{" "}
          shows it and explains how.
        </li>
        <li>
          Buys move a coin along a bonding curve; sells are paid back in LTC by the desk, automatically, once the transaction has
          two confirmations. Fees are 1% per trade: 80% goes to the coin&apos;s creator or to its holders, 20% to the desk.
        </li>
        <li>At 800M coins sold, a coin graduates into a locked constant-product pool, with no price ceiling.</li>
        <li>
          When LitVM mainnet goes live, every coin is recreated there from a snapshot of the ledger: same holders, same price,
          its pool on a DEX.
        </li>
      </Section>

      <Section title="Your keys">
        <li>
          On Litecoin, you either connect a Litecoin browser extension, Litescribe or Enkrypt, which signs what the site
          builds and keeps its keys to itself, or let the site create a wallet in your browser. That key is generated locally and
          stored only in that browser; it is never sent to us or to anyone else. You back it up from the wallet page and
          can restore it on another device.
        </li>
        <li>
          On LitVM, you connect the wallet you already have, through its browser extension or WalletConnect. Notus never sees
          its private key.
        </li>
        <li>
          Notus never asks for the seed phrase, recovery words or private key of any other wallet, anywhere. A page or a
          message that does is not us.
        </li>
      </Section>

      <Section title="What to know before you trade">
        <li>Cryptoassets are highly volatile. Coins launched here can lose all of their value.</li>
        <li>
          The LTC inside a coin&apos;s curve is held by the desk, a server Notus operates, until it pays out sells. The ledger is
          public, so the desk&apos;s liabilities can be checked against its balance at any time, but it is an operational risk
          you should know about.
        </li>
        <li>
          Nothing on this site is financial advice. Notus does not sell coins, does not hold your Litecoin wallet and cannot
          reverse a transaction.
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
          . The site, the indexer, the desk and the contracts are all in it.
        </li>
        <li>
          The ledger: <Link href="/litecoin/ledger" className="underline">/litecoin/ledger</Link>, with the desk address, the
          current state root and the command that recomputes it.
        </li>
        <li>The LitVM contracts are verified on the Liteforge explorer; their addresses are in the repository and on the token pages.</li>
      </Section>

      <Section title="Contact and security" id="security">
        <li>
          X: <a href={X_URL} target="_blank" rel="noreferrer" className="underline">@Notuspad</a>. Bugs and questions: the
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
          , or a direct message on X. Please give us time to fix before disclosing. Machine-readable:{" "}
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
