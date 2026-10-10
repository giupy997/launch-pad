// Notus on Litecoin — signed messages, the way wallets sign them for a site.
//
// Litecoin Core, Electrum and the browser extensions sign text with the
// coin's key as Bitcoin does: ECDSA over sha256d(varstr(magic) ‖
// varstr(text)), a 65-byte signature whose first byte carries the recovery
// id, base64. The verifier recovers the public key and asks whether the
// address given is one that key spends from. Litescribe (a UniSat fork)
// carries both magics in its code, so both are tried.
import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha2";
import { concatBytes, utf8ToBytes } from "@noble/hashes/utils";
import { base64, hex } from "@scure/base";
import * as btc from "@scure/btc-signer";
import { NETWORKS } from "./address.ts";
import type { Network } from "./ledger.ts";

export const MAGICS = ["Litecoin Signed Message:\n", "Bitcoin Signed Message:\n"] as const;

function varint(n: number): Uint8Array {
  if (n < 0xfd) return Uint8Array.of(n);
  if (n <= 0xffff) return Uint8Array.of(0xfd, n & 0xff, n >> 8);
  return Uint8Array.of(0xfe, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff);
}

function varstr(s: string): Uint8Array {
  const b = utf8ToBytes(s);
  return concatBytes(varint(b.length), b);
}

/** What is actually signed: sha256d of the magic and the text, length-prefixed. */
export function messageHash(text: string, magic: string = MAGICS[0]): Uint8Array {
  return sha256(sha256(concatBytes(varstr(magic), varstr(text))));
}

/** Sign `text` with a 32-byte secret (hex), as a wallet with a compressed key does. */
export function signMessage(secret: string, text: string, magic: string = MAGICS[0]): string {
  const sig = secp256k1.sign(messageHash(text, magic), hex.decode(secret));
  return base64.encode(concatBytes(Uint8Array.of(27 + 4 + sig.recovery), sig.toCompactRawBytes()));
}

/** Every address a compressed public key spends from, in the kinds wallets
 *  offer: native segwit, taproot, segwit wrapped in P2SH, legacy. */
export function addressesOfPubkey(pub: Uint8Array, network: Network): string[] {
  const net = NETWORKS[network];
  return [btc.p2wpkh(pub, net).address!, btc.p2tr(pub.slice(1), undefined, net).address!, btc.p2sh(btc.p2wpkh(pub, net), net).address!, btc.p2pkh(pub, net).address!];
}

/** The compressed public key that signed `text` for `address`, or null when
 *  the signature is not one of that address's key over this very text. */
export function recoverSigner(address: string, text: string, signature: string, network: Network): Uint8Array | null {
  let raw: Uint8Array;
  try {
    raw = base64.decode(signature);
  } catch {
    return null;
  }
  if (raw.length !== 65 || raw[0] < 27 || raw[0] > 42) return null;
  const recovery = (raw[0] - 27) & 3;
  for (const magic of MAGICS) {
    try {
      const pub = secp256k1.Signature.fromCompact(raw.slice(1)).addRecoveryBit(recovery).recoverPublicKey(messageHash(text, magic)).toRawBytes(true);
      if (addressesOfPubkey(pub, network).includes(address)) return pub;
    } catch {}
  }
  return null;
}

export function verifyMessage(address: string, text: string, signature: string, network: Network): boolean {
  return recoverSigner(address, text, signature, network) !== null;
}
