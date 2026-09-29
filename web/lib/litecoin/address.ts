// Notus on Litecoin — addresses. Litecoin's network parameters (Litecoin
// Core's chainparams.cpp) and the two questions the ledger and the
// transaction builder both ask: is this string an address we can pay, and
// which address does this output script pay. Kept apart from tx.ts so the
// ledger can validate payout targets without importing the signer.
import * as btc from "@scure/btc-signer";
import { hex } from "@scure/base";
import type { Network } from "./ledger.ts";

export type BtcNetwork = { bech32: string; pubKeyHash: number; scriptHash: number; wif: number };

export const NETWORKS: Record<Network, BtcNetwork> = {
  main: { bech32: "ltc", pubKeyHash: 0x30, scriptHash: 0x32, wif: 0xb0 },
  test: { bech32: "tltc", pubKeyHash: 0x6f, scriptHash: 0x3a, wif: 0xef },
};

/** True when `address` is one this network's transaction builder can pay:
 *  legacy, P2SH, native segwit v0 or taproot. Unknown witness versions and
 *  other chains' prefixes are not. */
export function isAddress(address: string, network: Network): boolean {
  try {
    btc.Address(NETWORKS[network]).decode(address);
    return true;
  } catch {
    return false;
  }
}

/** The address an output script pays, or null for OP_RETURN and non-standard scripts. */
export function addressOfScript(scriptHex: string, network: Network): string | null {
  try {
    return btc.Address(NETWORKS[network]).encode(btc.OutScript.decode(hex.decode(scriptHex)));
  } catch {
    return null;
  }
}
