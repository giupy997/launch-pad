"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider, type State } from "wagmi";
import { useState, type ReactNode } from "react";
import { config } from "@/lib/config";

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
  if (typeof window !== "undefined" && process.env.NODE_ENV === "development") {
    (window as unknown as Record<string, unknown>).__qc = queryClient;
  }
  return (
    <WagmiProvider config={config} initialState={initialState}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}
