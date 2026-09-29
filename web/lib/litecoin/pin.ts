// Notus on Litecoin — pinning a coin logo to IPFS.
//
// An OP_RETURN holds 80 bytes, so a logo cannot travel in the transaction the
// way it does on the EVM launchpads (a data URI in the token metadata). It
// lives on IPFS instead and the instruction carries its CID: `ipfs://Qm…`
// is 53 bytes, which leaves room for the ticker. The site pins through
// Pinata with the operator's key (PINATA_JWT); without one, creators paste
// an image URL of their own.

/** What the browser sends: the square, compressed image `processLogoFile` made. */
export const MAX_LOGO_BYTES = 32 * 1024;
const PINATA = "https://api.pinata.cloud/pinning/pinFileToIPFS";

export function decodeDataUri(dataUri: string): { type: string; bytes: Uint8Array } {
  const m = /^data:(image\/(?:webp|png|jpeg|gif));base64,([A-Za-z0-9+/=]+)$/.exec(dataUri);
  if (!m) throw new Error("not a base64 image data URI");
  const bytes = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
  if (bytes.length === 0 || bytes.length > MAX_LOGO_BYTES) throw new Error(`image must be 1–${MAX_LOGO_BYTES / 1024} KB`);
  if (imageTypeOf(bytes) !== m[1]) throw new Error("the bytes are not the image type they claim to be");
  return { type: m[1], bytes };
}

/** The image type the first bytes say, or null: what gets stored is judged
 *  by its bytes, never by the label a client put on it. */
export function imageTypeOf(b: Uint8Array): string | null {
  const at = (i: number, ...v: number[]) => v.every((x, j) => b[i + j] === x);
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  return null;
}

/** Pins the image and returns its `ipfs://Qm…` URI (CIDv0: the short form). */
export async function pinLogo(dataUri: string, name: string, jwt: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const { type, bytes } = decodeDataUri(dataUri);
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(bytes)], { type }), `logo.${type.split("/")[1]}`);
  form.append("pinataOptions", JSON.stringify({ cidVersion: 0 }));
  form.append("pinataMetadata", JSON.stringify({ name: `notus-ltc-logo-${name.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || "coin"}` }));
  const r = await fetchImpl(PINATA, { method: "POST", headers: { authorization: `Bearer ${jwt}` }, body: form, signal: AbortSignal.timeout(30_000) });
  const text = await r.text();
  if (!r.ok) throw new Error(`pinning failed: HTTP ${r.status} ${text.slice(0, 120)}`);
  const cid = (JSON.parse(text) as { IpfsHash?: string }).IpfsHash;
  if (!cid || !/^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(cid)) throw new Error(`pinning failed: unexpected answer ${text.slice(0, 120)}`);
  return `ipfs://${cid}`;
}
