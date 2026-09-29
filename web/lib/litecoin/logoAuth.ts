// Who may upload a coin logo: a wallet that exists on this site and holds
// some LTC. The browser signs the image's hash and the time with the wallet
// key it already has; the server checks the signature, derives the address
// and looks its balance up. No account, no cookie: the same key that pays
// for the coin vouches for its picture.
import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils";

/** How old (or how far ahead) a signed request may be, in seconds. */
export const LOGO_AUTH_WINDOW_S = 10 * 60;

export type LogoAuth = { ts: number; pubkey: string; signature: string };

export function logoMessage(imageSha256Hex: string, ts: number): string {
  return `notus-logo|${imageSha256Hex}|${ts}`;
}

/** Sign an upload with the wallet's secret (64 hex). */
export function signLogo(secret: string, imageBytes: Uint8Array, ts = Math.floor(Date.now() / 1000)): LogoAuth {
  const priv = hexToBytes(secret);
  const digest = sha256(utf8ToBytes(logoMessage(bytesToHex(sha256(imageBytes)), ts)));
  return { ts, pubkey: bytesToHex(secp256k1.getPublicKey(priv, true)), signature: secp256k1.sign(digest, priv).toCompactHex() };
}

/** True when `auth` is a fresh, valid signature over these very bytes by `auth.pubkey`. */
export function verifyLogo(auth: LogoAuth | undefined, imageBytes: Uint8Array, now = Math.floor(Date.now() / 1000)): boolean {
  if (!auth || typeof auth.ts !== "number" || !Number.isInteger(auth.ts)) return false;
  if (Math.abs(now - auth.ts) > LOGO_AUTH_WINDOW_S) return false;
  if (!/^0[23][0-9a-f]{64}$/.test(auth.pubkey) || !/^[0-9a-f]{128}$/.test(auth.signature)) return false;
  try {
    const digest = sha256(utf8ToBytes(logoMessage(bytesToHex(sha256(imageBytes)), auth.ts)));
    return secp256k1.verify(auth.signature, digest, auth.pubkey);
  } catch {
    return false;
  }
}
