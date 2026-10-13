// Netlify edge rate limits for the API routes that cost a node call or a log
// scan per request the CDN has not got: trades, holders, health, the points
// proxy. The same allowance per client as the image proxy (a page asks for
// several at once; the CDN answers the repeats). Over it the platform answers
// 429 before the function runs; under it the request goes through untouched.
// Deno code, run by Netlify; not part of the Next.js build.
import type { Config, Context } from "https://edge.netlify.com";

export default async (_request: Request, context: Context) => context.next();

export const config: Config = {
  path: ["/api/trades", "/api/holders", "/api/health", "/api/points/*"],
  rateLimit: {
    windowLimit: 240,
    windowSize: 60,
    aggregateBy: ["ip", "domain"],
    action: "rate_limit",
  },
};
