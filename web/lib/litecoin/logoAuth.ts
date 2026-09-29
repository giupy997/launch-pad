// Who may upload a coin logo: a wallet that exists on this site and holds
// some LTC. The browser signs the image's hash and the time with the wallet
// it already has; the server checks the signature, learns the address and
// looks its balance up. No account, no cookie: the same key that pays for
// the coin vouches for its picture. Two wallets sign here: the site's own
// browser wallet, with its raw key, and an extension (Litescribe), which
// signs text the way Litecoin wallets do.
import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils";
import * as btc from "@scure/btc-signer";
import { NETWORKS, isAddress } from "./address.ts";
import type { Network } from "./ledger.ts";
import { recoverSigner } from "./message.ts";

/** How old (or how far ahead) a signed request may be, in seconds. */
export const LOGO_AUTH_WINDOW_S = 10 * 60;

export type LogoAuth =
  /** The browser wallet: its key over sha256 of the message. */
  | { ts: number; pubkey: string; signature: string }
  /** An extension wallet: the message signed the Litecoin way, for its address. */
  | { ts: number; address: string; signedMessage: string };

export function logoMessage(imageSha256Hex: string, ts: number): string {
  return `notus-logo|${imageSha256Hex}|${ts}`;
}

/** The text an extension wallet is asked to sign for these image bytes. */
export function logoMessageFor(imageBytes: Uint8Array, ts = Math.floor(Date.now() / 1000)): { ts: number; text: string } {
  return { ts, text: logoMessage(bytesToHex(sha256(imageBytes)), ts) };
}

/** Sign an upload with the browser wallet's secret (64 hex). */
export function signLogo(secret: string, imageBytes: Uint8Array, ts = Math.floor(Date.now() / 1000)): LogoAuth {
  const priv = hexToBytes(secret);
  const digest = sha256(utf8ToBytes(logoMessage(bytesToHex(sha256(imageBytes)), ts)));
  return { ts, pubkey: bytesToHex(secp256k1.getPublicKey(priv, true)), signature: secp256k1.sign(digest, priv).toCompactHex() };
}

/** The address vouching for these very bytes, when `auth` is its fresh,
 *  valid signature; null otherwise. */
export function verifyLogo(auth: LogoAuth | undefined, imageBytes: Uint8Array, network: Network, now = Math.floor(Date.now() / 1000)): string | null {
  if (!auth || typeof auth.ts !== "number" || !Number.isInteger(auth.ts)) return null;
  if (Math.abs(now - auth.ts) > LOGO_AUTH_WINDOW_S) return null;
  const text = logoMessage(bytesToHex(sha256(imageBytes)), auth.ts);
  try {
    if ("pubkey" in auth) {
      if (!/^0[23][0-9a-f]{64}$/.test(auth.pubkey) || !/^[0-9a-f]{128}$/.test(auth.signature)) return null;
      if (!secp256k1.verify(auth.signature, sha256(utf8ToBytes(text)), auth.pubkey)) return null;
      return btc.p2wpkh(hexToBytes(auth.pubkey), NETWORKS[network]).address ?? null;
    }
    if (typeof auth.address !== "string" || typeof auth.signedMessage !== "string" || auth.signedMessage.length > 120) return null;
    if (!isAddress(auth.address, network)) return null;
    return recoverSigner(auth.address, text, auth.signedMessage, network) ? auth.address : null;
  } catch {
    return null;
  }
}
