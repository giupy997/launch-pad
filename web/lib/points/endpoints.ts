// Where LitVM's Liteforge testnet is reached, in one place. The site's wagmi
// chain (lib/config.ts), the points service and the server routes
// (lib/points/chains.ts), the explorer API (lib/explorers.ts), the bridge page
// and the Content-Security-Policy (next.config.mjs, which reads this file as
// text: keep each constant on one line, a plain string) all take it from
// here, so that a change of endpoint is a change of these two lines.
// `node ops/liteforge-endpoint.mjs` checks a new endpoint against the chain
// as it was and writes it here and in the contracts' scripts (ops/README.md).
//
// No imports: the points service loads this file under Node as it is.

/** the chain's JSON-RPC endpoint, public: it is in the browser's bundle */
export const LITEFORGE_RPC = "https://rpc.testnet.liteforge.zeeve.net";
/** the chain's block explorer (Blockscout), without a trailing slash */
export const LITEFORGE_EXPLORER = "https://explorer.testnet.liteforge.zeeve.net";
