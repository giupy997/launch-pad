/** Where the code lives, when it is public. Unset while the repository is
 *  private (before launch): the site then says the code is published at
 *  launch instead of linking to it. Set NEXT_PUBLIC_SOURCE_URL on the host
 *  (e.g. https://github.com/giupy997/launch-pad) to bring the links back. */
export const SOURCE_URL: string | null = process.env.NEXT_PUBLIC_SOURCE_URL?.trim() || null;
/** `git clone` target for the "rebuild this ledger" instructions. */
export const CLONE_LINE = SOURCE_URL ? `git clone ${SOURCE_URL} && cd ${SOURCE_URL.split("/").pop()?.replace(/\.git$/, "") ?? "notus"}` : null;
