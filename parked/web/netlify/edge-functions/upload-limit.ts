// A tighter window for uploads alone: a wallet needs a handful per coin.
import type { Config, Context } from "https://edge.netlify.com";

export default async (_request: Request, context: Context) => context.next();

export const config: Config = {
  path: "/api/ltc-logo",
  method: "POST",
  rateLimit: {
    windowLimit: 20,
    windowSize: 60,
    aggregateBy: ["ip", "domain"],
    action: "rate_limit",
  },
};
