/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  // The usual hardening headers; the site frames nothing and needs no
  // camera, microphone, location or payment API. The policy stops at
  // framing, plugins and <base>: scripts and connections are left alone
  // until the wallet flows (WalletConnect, AppKit) are mapped out.
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'; object-src 'none'; base-uri 'self'" },
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
