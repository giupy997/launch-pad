import "server-only";
import { createPublicClient, http } from "viem";
import { launchpadAbi } from "./abi";
import { POINTS_CHAINS } from "./points/chains";

/** Every coin on every pad the site serves, read at build time so that each
 *  coin's page is prerendered (generateStaticParams) and served from the CDN.
 *  The chains come from lib/points/chains.ts, the table kept free of wagmi
 *  for Node and server code (lib/config.ts pulls the wallet connectors in).
 *  A node that does not answer costs nothing but that chain's prerender: its
 *  coins' pages render on their first visit instead, and the build goes on.
 *  Addresses keep the case the chain returns, the one the site links with. */
export async function listTokens(): Promise<`0x${string}`[]> {
  const seen = new Set<string>();
  const out: `0x${string}`[] = [];
  for (const chain of Object.values(POINTS_CHAINS)) {
    try {
      const client = createPublicClient({ transport: http(chain.rpcs[0], { timeout: 10_000, retryCount: 1 }) });
      const n = Number(await client.readContract({ address: chain.pad, abi: launchpadAbi, functionName: "tokenCount" }));
      const addrs = await Promise.all(
        Array.from({ length: n }, (_, i) =>
          client.readContract({ address: chain.pad, abi: launchpadAbi, functionName: "allTokens", args: [BigInt(i)] })
        )
      );
      for (const a of addrs as `0x${string}`[]) {
        if (seen.has(a.toLowerCase())) continue;
        seen.add(a.toLowerCase());
        out.push(a);
      }
    } catch (e) {
      console.warn(
        `[tokens] ${chain.name}: coins not listed at build, their pages render on first visit (${String((e as Error).message ?? e).slice(0, 100)})`
      );
    }
  }
  return out;
}
