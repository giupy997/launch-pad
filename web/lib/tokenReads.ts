import { launchpadAbi, launchTokenAbi } from "./abi";

/** The reads a coin's page opens with, in one multicall each: what never
 *  changes (name, symbol, the fee setup) and what moves (curve, metadata, the
 *  pots). The Explore cards ask for the same lists ahead of a tap, so the
 *  page finds them in the cache: the two sides must build identical lists,
 *  chain id included, for wagmi's query keys to match. */
export function tokenStaticReads(pad: `0x${string}`, token: `0x${string}`, chainId: number) {
  return [
    { address: token, abi: launchTokenAbi, functionName: "name", chainId },
    { address: token, abi: launchTokenAbi, functionName: "symbol", chainId },
    { address: pad, abi: launchpadAbi, functionName: "feesToHolders", args: [token], chainId },
    { address: pad, abi: launchpadAbi, functionName: "feeConfig", args: [token], chainId },
    { address: pad, abi: launchpadAbi, functionName: "feeBps", chainId },
    { address: pad, abi: launchpadAbi, functionName: "creatorFeeShareBps", chainId },
    { address: pad, abi: launchpadAbi, functionName: "holderCashbackBps", chainId },
  ] as const;
}

export function tokenLiveReads(pad: `0x${string}`, token: `0x${string}`, chainId: number) {
  return [
    { address: pad, abi: launchpadAbi, functionName: "curves", args: [token], chainId },
    { address: pad, abi: launchpadAbi, functionName: "tokenMetadata", args: [token], chainId },
    { address: pad, abi: launchpadAbi, functionName: "burnPot", args: [token], chainId },
    { address: pad, abi: launchpadAbi, functionName: "liquidityPot", args: [token], chainId },
    { address: pad, abi: launchpadAbi, functionName: "burned", args: [token], chainId },
  ] as const;
}
