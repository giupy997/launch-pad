/** The Blockscout API of each chain the site shows, for what the chain's own
 *  nodes do not answer cheaply (a token's holder count). No wagmi in here: the
 *  server routes import it too. */
export const EXPLORER_API: Record<number, string> = {
  8453: "https://base.blockscout.com/api/v2", // Base
  4441: "https://liteforge.explorer.caldera.xyz/api/v2", // LitVM Liteforge testnet
};
