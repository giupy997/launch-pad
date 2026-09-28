/** Where the code lives. The repository is public; NEXT_PUBLIC_SOURCE_URL
 *  overrides the address, and the value "off" hides the links (the site then
 *  says the code is published at launch). */
export const SOURCE_URL: string | null =
  process.env.NEXT_PUBLIC_SOURCE_URL === "off" ? null : process.env.NEXT_PUBLIC_SOURCE_URL?.trim() || "https://github.com/giupy997/launch-pad";
/** `git clone` target for the "rebuild this ledger" instructions. */
export const CLONE_LINE = SOURCE_URL ? `git clone ${SOURCE_URL} && cd ${SOURCE_URL.split("/").pop()?.replace(/\.git$/, "") ?? "notus"}` : null;
