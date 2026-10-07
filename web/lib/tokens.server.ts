import "server-only";
import { createPublicClient, http } from "viem";
import { launchpadAbi } from "./abi";
import { LAUNCHPAD_ADDRESS, RPC_URLS, VISIBLE_CHAINS } from "./config";

/** Every coin on every visible chain's pad, read at build time so that each
 *  coin's page is prerendered (generateStaticParams) and served from the CDN.
 *  A node that does not answer costs nothing but that chain's prerender: its
 *  coins' pages render on their first visit instead, and the build goes on.
 *  Addresses keep the case the chain returns, the one the site links with. */
export async function listTokens(): Promise<`0x${string}`[]> {
  const seen = new Set<string>();
  const out: `0x${string}`[] = [];
  for (const chain of VISIBLE_CHAINS) {
    const pad = LAUNCHPAD_ADDRESS[chain.id];
    if (!pad) continue;
    const url = RPC_URLS[chain.id]?.[0] ?? chain.rpcUrls.default.http[0];
    try {
      const client = createPublicClient({ chain, transport: http(url, { timeout: 10_000, retryCount: 1 }) });
      const n = Number(await client.readContract({ address: pad, abi: launchpadAbi, functionName: "tokenCount" }));
      const addrs = await Promise.all(
        Array.from({ length: n }, (_, i) => client.readContract({ address: pad, abi: launchpadAbi, functionName: "allTokens", args: [BigInt(i)] }))
      );
      for (const a of addrs as `0x${string}`[]) {
        if (seen.has(a.toLowerCase())) continue;
        seen.add(a.toLowerCase());
        out.push(a);
      }
    } catch (e) {
      console.warn(`[tokens] ${chain.name}: coins not listed at build, their pages render on first visit (${String((e as Error).message ?? e).slice(0, 100)})`);
    }
  }
  return out;
}
