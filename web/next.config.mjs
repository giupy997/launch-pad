// Where the pages may reach out to, and nowhere else. The wallet key lives
// in the browser's storage: a script that got in (a dependency gone bad)
// must find no way to send it anywhere. Connections go to this origin, the
// chains' RPCs and WalletConnect's relay and services; images come from
// this origin (other hosts' logos through /api/img) and WalletConnect's
// wallet icons; only WalletConnect's verify and secure frames may be
// embedded. Scripts are this origin's: Next.js needs its inline ones, and
// in development the tooling needs eval.
const RPC_HOSTS = [
  "https://liteforge.rpc.caldera.xyz", // LitVM Liteforge
  "https://mainnet.base.org", // Base
  "https://sepolia-rpc.giwa.io", // GIWA Sepolia
  "https://rpc.mainnet.chain.robinhood.com", // Robinhood Chain
  "https://11155111.rpc.thirdweb.com", // Sepolia (viem's default)
  "https://ethereum.reth.rs", // Ethereum (viem's default)
];
const WALLETCONNECT_CONNECT = [
  "wss://relay.walletconnect.org",
  "wss://relay.walletconnect.com",
  "https://rpc.walletconnect.org",
  "https://rpc.walletconnect.com",
  "https://pulse.walletconnect.org",
  "https://api.web3modal.org",
  "https://echo.walletconnect.com",
  "https://explorer-api.walletconnect.com",
  "https://verify.walletconnect.org",
  "https://verify.walletconnect.com",
];
const WALLETCONNECT_IMAGES = ["https://api.web3modal.org", "https://explorer-api.walletconnect.com", "https://imagedelivery.net"];
const WALLETCONNECT_FRAMES = [
  "https://verify.walletconnect.org",
  "https://verify.walletconnect.com",
  "https://secure.walletconnect.org",
  "https://secure-mobile.walletconnect.org",
  "https://secure-mobile.walletconnect.com",
];
const dev = process.env.NODE_ENV === "development";
const CSP = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""}`,
  // WalletConnect's modal dresses itself in Inter from Google Fonts
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  `img-src 'self' data: blob: ${WALLETCONNECT_IMAGES.join(" ")}`,
  "font-src 'self' data: https://fonts.gstatic.com",
  "media-src 'self'",
  `connect-src 'self' ${[...RPC_HOSTS, ...WALLETCONNECT_CONNECT].join(" ")}${dev ? " ws://localhost:* http://localhost:*" : ""}`,
  `frame-src ${WALLETCONNECT_FRAMES.join(" ")}`,
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "form-action 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  ...(dev ? [] : ["upgrade-insecure-requests"]),
].join("; ");

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Notus on Litecoin has closed: its explore, deploy and coin pages go home.
  // The wallet and ledger pages stay, for LTC left in a browser wallet or a
  // claim to collect (see components/litecoin/ClosedNotice.tsx).
  async redirects() {
    return [
      { source: "/litecoin", destination: "/", permanent: false },
      { source: "/litecoin/create", destination: "/", permanent: false },
      { source: "/litecoin/fund", destination: "/bridge", permanent: false },
      { source: "/litecoin/c/:ticker", destination: "/", permanent: false },
    ];
  },
  poweredByHeader: false,
  // The usual hardening headers; the site frames nothing and needs no
  // camera, microphone, location or payment API.
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "Content-Security-Policy", value: CSP },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
          { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
        ],
      },
    ];
  },
  webpack: (config) => {
    // wagmi's connector index pulls in Coinbase's Base Account SDK, whose
    // optional x402 payment peers are not installed. Nothing here uses them:
    // resolve them to empty modules instead of failing the build.
    config.resolve.alias = {
      ...config.resolve.alias,
      "@x402/core": false,
      "@x402/evm": false,
      "@x402/express": false,
      "@x402/extensions": false,
      "@x402/fetch": false,
      "@x402/svm": false,
    };
    return config;
  },
};

export default nextConfig;
