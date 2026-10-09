import type { Abi } from "viem";
import { launchpadAbi, launchpadV11Abi, launchTokenAbi, padAbiFor, type PadVersion } from "./abi";

/** One read of a coin's page, typed loosely: the lists below mix two pad
 *  ABIs, and the page casts each result as it reads it. */
export type TokenRead = {
  address: `0x${string}`;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
  chainId: number;
};

/** The reads a coin's page opens with, in one multicall each: what never
 *  changes (name, symbol, the fee setup) and what moves (curve, metadata, the
 *  pots). The Explore cards ask for the same lists ahead of a tap, so the
 *  page finds them in the cache: the two sides must build identical lists,
 *  chain id and pad version included, for wagmi's query keys to match (the
 *  key carries every field but the ABI). On v11 the list ends with the
 *  pad-wide split of its fee, which v12 has no more of (the reads revert) —
 *  there the coin's rate is feeConfig's seventh field. */
export function tokenStaticReads(pad: `0x${string}`, token: `0x${string}`, chainId: number, version: PadVersion): readonly TokenRead[] {
  const abi = padAbiFor(version);
  const reads: TokenRead[] = [
    { address: token, abi: launchTokenAbi, functionName: "name", chainId },
    { address: token, abi: launchTokenAbi, functionName: "symbol", chainId },
    { address: pad, abi, functionName: "feesToHolders", args: [token], chainId },
    { address: pad, abi, functionName: "feeConfig", args: [token], chainId },
    { address: pad, abi, functionName: "feeBps", chainId },
  ];
  if (version === 11) {
    reads.push(
      { address: pad, abi: launchpadV11Abi, functionName: "creatorFeeShareBps", chainId },
      { address: pad, abi: launchpadV11Abi, functionName: "holderCashbackBps", chainId }
    );
  }
  return reads;
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
