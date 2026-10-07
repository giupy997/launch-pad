import { TokenPage } from "./TokenPage";
import { listTokens } from "@/lib/tokens.server";

/** A coin's page is prerendered for every coin the pads know at build time
 *  (lib/tokens.server.ts): served from the CDN and prefetched by the cards
 *  that link to it, so a tap opens it at once. A coin created after the build
 *  is rendered on its first visit and cached from then on. The page reads the
 *  chain in the browser, so the shell is the same whichever coin it is. */
export const dynamicParams = true;

export async function generateStaticParams() {
  return (await listTokens()).map((address) => ({ address }));
}

export default async function Page({ params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  return <TokenPage address={address} />;
}
