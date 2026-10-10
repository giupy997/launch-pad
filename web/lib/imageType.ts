// What an image is, judged by its first bytes: the image proxy (/api/img)
// serves a logo under the type its bytes say, never the one the host
// declared. Pure, with no imports, so it runs on the server and in the
// browser alike.

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
