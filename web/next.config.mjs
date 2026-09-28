/** @type {import('next').NextConfig} */
const nextConfig = {
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
