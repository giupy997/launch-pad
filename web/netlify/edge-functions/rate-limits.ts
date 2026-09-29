// Netlify edge rate limits for the routes anyone can hit hard: the logo
// upload (a permanent blob per call) and the explorer proxy (an upstream
// call per request). Over the limit the platform answers 429 before the
// function runs; under it the request goes through untouched.
// Deno code, run by Netlify; not part of the Next.js build.
import type { Config, Context } from "https://edge.netlify.com";

export default async (_request: Request, context: Context) => context.next();

export const config: Config = {
  path: ["/api/ltc-logo", "/api/ltc/*"],
  rateLimit: {
    windowLimit: 240,
    windowSize: 60,
    aggregateBy: ["ip", "domain"],
    action: "rate_limit",
  },
};
