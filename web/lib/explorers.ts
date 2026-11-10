/** The Blockscout API of each chain the site shows, for what the chain's own
 *  nodes do not answer cheaply (a token's holder count). No wagmi in here: the
 *  server routes import it too. */
import { LITEFORGE_EXPLORER } from "./points/endpoints";

export const EXPLORER_API: Record<number, string> = {
  8453: "https://base.blockscout.com/api/v2", // Base
  4441: `${LITEFORGE_EXPLORER}/api/v2`, // LitVM Liteforge testnet
};
