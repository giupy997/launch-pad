import type { Metadata } from "next";
import { SOURCE_URL } from "@/lib/site";

export const metadata: Metadata = {
  title: "Developers",
  description:
    "How to read Notus without the site: the contracts on Base and the events they emit, and the two public API routes the site keeps stable, with their fields, caching and limits.",
};

const PAD = "0x23231924281B34Bb28F10D854DB8D2DcBd7F78c5";
const MIGRATOR = "0x60070f76f885616D675305624497ed0797303434";
const TIMELOCK = "0xe28f446D3a1DB105F8F9b34A65474E1F6d256f76";
const CBLTC = "0xcb17C9Db87B595717C857a08468793f5bAb6445F";
const EXPLORER = "https://basescan.org/address/";

/** Everything a program needs to follow the pad: the chain first, the
 *  site's API second. The two routes named stable here keep their shape;
 *  the other routes under /api/ serve the site's own pages and may change
 *  with them. */
export default function DevelopersPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <header className="space-y-4">
        <div className="pill">Developers</div>
        <h1 className="display text-4xl sm:text-5xl text-white">Read Notus without the site</h1>
        <p className="text-base leading-relaxed text-zinc-400">
          Everything the site shows comes from contracts on Base that anyone can read. If you are writing a bot, a terminal or
          a monitor, read the chain: it does not depend on this site being up, and it does not cost us bandwidth. Where a
          JSON is more convenient, two routes of the site are kept stable for programs; the rest of <code>/api/</code>{" "}
          serves the site&apos;s own pages and changes with them.
        </p>
      </header>

      <Section title="The contracts (Base, chain 8453)">
        <li>
          Launchpad <Addr a={PAD} />: every coin is created, sold on its curve and graduated here. The list of coins is{" "}
          <code>tokenCount()</code> and <code>allTokens(i)</code>, in creation order; a coin&apos;s state is{" "}
          <code>curves(token)</code> (virtual and real reserves, sold, graduated, creator, quote asset), its tax split{" "}
          <code>feeConfig(token)</code>, its links and logo <code>tokenMetadata(token)</code>.
        </li>
        <li>
          Events to follow: <code>TokenCreated(address indexed token, address indexed creator, string name, string symbol,
          bool feesToHolders)</code> for every new coin, <code>Bought</code> and <code>Sold</code> for every trade on a curve,{" "}
          <code>Graduated(address indexed token, uint256 raisedEth)</code> when a curve fills. One <code>eth_getLogs</code> on the launchpad&apos;s address with the
          event&apos;s topic is the whole feed; a bot waiting for the next launch needs nothing else, and it is faster than
          reloading a page.
        </li>
        <li>
          Graduation pools are Uniswap v2 pairs against cbLTC <Addr a={CBLTC} />, seeded by the migrator <Addr a={MIGRATOR} />
          , which keeps the LP tokens. The launchpad is owned by a 24-hour TimelockController <Addr a={TIMELOCK} />: every
          owner action is public on chain a day before it can run.
        </li>
        <li>
          The ABIs, the deploy blocks, every address of every version and the standard JSON inputs the explorers accepted are
          in the repository{" "}
          {SOURCE_URL ? (
            <a href={SOURCE_URL} target="_blank" rel="noreferrer" className="underline break-all">
              {SOURCE_URL}
            </a>
          ) : (
            "(published at launch)"
          )}
          , <code>README.md</code>, Deployments.
        </li>
      </Section>

      <Section title="GET /api/launchpad/tokens" id="tokens">
        <li>
          The coins the launchpad created, in creation order, for a program that syncs a list (this is the shape GoPlus asks
          of a launchpad). Query: <code>orderId</code> (the first id wanted, 0 by default) and <code>limit</code> (100 by
          default, 1,000 at most).
        </li>
        <li>
          Answer: <code>{`{ code: 1, message: "ok", result: [{ chainId: "8453", address, launchTime, orderId }] }`}</code>.{" "}
          <code>orderId</code> is the coin&apos;s position in the launchpad&apos;s own list and never changes;{" "}
          <code>launchTime</code> is the timestamp of the block that created it, in milliseconds. Your next sync asks from
          the largest <code>orderId</code> you have plus one.
        </li>
        <li>
          Every coin of the launchpad is in it, the ones the site does not list included. Cached for five minutes for
          everyone; 503 with <code>code: 0</code> when the chain&apos;s archive node does not answer, never a partial list.
          Try it:{" "}
          <a href="/api/launchpad/tokens?orderId=0&limit=5" className="underline font-mono break-all">
            /api/launchpad/tokens?orderId=0&amp;limit=5
          </a>
        </li>
      </Section>

      <Section title="GET /api/health" id="health">
        <li>
          One answer for an uptime monitor: 200 with <code>{`{ ok: true, status: "up" }`}</code> while Base&apos;s nodes and
          the site&apos;s store answer, 503 otherwise, and under <code>checks</code> every check&apos;s result with its time
          in milliseconds (the testnet&apos;s nodes and the points service are reported there, not decisive).{" "}
          <a href="/api/health" className="underline font-mono">
            /api/health
          </a>
        </li>
      </Section>

      <Section title="Limits and promises">
        <li>
          No key, no sign-up: the routes are public and read-only, and nothing you send reaches a wallet or a contract. Each
          client gets 240 requests a minute on <code>/api/</code>; over that the edge answers 429 until the minute turns.
          Answers carry <code>cache-control</code>: read it and do not poll faster than it says.
        </li>
        <li>
          The two routes above keep their fields; a field may be added, none removed or renamed without notice here and in
          the repository&apos;s README. <code>/api/trades</code>, <code>/api/holders</code>, <code>/api/ltc-price</code>,{" "}
          <code>/api/points/</code> and <code>/api/img</code> are the site&apos;s own and may change with its pages: read
          the chain, or write to us first.
        </li>
        <li>
          Something wrong or missing: <a href="mailto:notuspad@gmail.com" className="underline">notuspad@gmail.com</a>, or
          an issue in the repository. Security reports go to <a href="/about#security" className="underline">the security
          address</a>, not a public issue.
        </li>
      </Section>
    </div>
  );
}

function Addr({ a }: { a: string }) {
  return (
    <a href={`${EXPLORER}${a}`} target="_blank" rel="noreferrer" className="underline font-mono text-xs break-all">
      {a}
    </a>
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
