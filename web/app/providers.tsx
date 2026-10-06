"use client";

import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { WagmiProvider, useAccount, type State } from "wagmi";
import { useState, type ReactNode, useEffect, useRef } from "react";
import { config } from "@/lib/config";

/** When the wallet changes under the page — another account picked in the
 *  extension, or the wallet gone — every read of the old state is asked
 *  again, so the page catches up by itself: swapping wallets used to leave
 *  stale balances and a slow, half-connected page until a hard refresh. A
 *  first connection needs nothing: its reads are new keys anyway. */
function AccountEffects() {
  const queryClient = useQueryClient();
  const { address } = useAccount();
  const last = useRef<string | undefined>(undefined);
  useEffect(() => {
    const was = last.current;
    last.current = address;
    if (was !== undefined && was !== address) void queryClient.invalidateQueries();
  }, [address, queryClient]);
  return null;
}

export function Providers({
  children,
  initialState,
}: {
  children: ReactNode;
  initialState?: State;
}) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 4_000, // avoid duplicate fetches across components
            refetchOnWindowFocus: false,
            retry: 2,
          },
        },
      })
  );
  // the query client on window for poking at in development, set after render
  useEffect(() => {
    if (process.env.NODE_ENV === "development") (window as unknown as Record<string, unknown>).__qc = queryClient;
  }, [queryClient]);
  return (
    <WagmiProvider config={config} initialState={initialState}>
      <QueryClientProvider client={queryClient}>
        <AccountEffects />
        {children}
      </QueryClientProvider>
    </WagmiProvider>
  );
}
