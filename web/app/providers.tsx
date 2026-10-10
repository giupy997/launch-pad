"use client";

import { QueryClient, useQueryClient, type Query } from "@tanstack/react-query";
import { PersistQueryClientProvider, removeOldestQuery, type Persister } from "@tanstack/react-query-persist-client";
import { createSyncStoragePersister } from "@tanstack/query-sync-storage-persister";
import { WagmiProvider, deserialize, serialize, useAccount } from "wagmi";
import { useState, type ReactNode, useEffect, useRef } from "react";
import { config } from "@/lib/config";
import { chainAnswered } from "@/lib/hooks";

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

// What the browser keeps between visits: the chains' public state — token
// lists, names, curves, metadata, pools — so a page, or a switch to the other
// chain, shows the last known picture at once and refreshes it behind. The
// reads bound to a wallet are not kept: a stale balance or allowance shown as
// fact misleads. (wagmi's serializer carries the bigints.)
const WALLET_BOUND = new Set(["balanceOf", "allowance", "cashbackOf", "creatorFees", "balances", "pendingCashback", "cashbackDebt"]);
type ReadKey = { functionName?: unknown; contracts?: readonly { functionName?: unknown }[] } | undefined;
// A multicall with an entry the RPC failed on (lib/hooks.ts chainAnswered) is
// not kept: it would come back on every visit in place of the answer, and the
// reads fixed once answered would not ask again. A revert is an answer, and the
// lists rely on it (a slot past the last coin, a read an older token lacks).
function keepQuery(query: Query): boolean {
  if (query.state.status !== "success") return false;
  const [kind, params] = query.queryKey as [unknown, ReadKey];
  if (kind === "readContract") return typeof params?.functionName === "string" && !WALLET_BOUND.has(params.functionName);
  if (kind === "readContracts")
    return (
      !!params?.contracts?.length &&
      params.contracts.every((c) => typeof c.functionName === "string" && !WALLET_BOUND.has(c.functionName)) &&
      ((query.state.data as readonly { status?: unknown; error?: unknown }[] | undefined) ?? []).every(chainAnswered)
    );
  return false;
}
// buster 2: drops what was kept before transport failures were left out
const PERSIST = { key: "notus.queries.v1", maxAge: 24 * 60 * 60 * 1000, buster: "2" } as const;
function makePersister(): Persister {
  let storage: Storage | undefined;
  try {
    storage = typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    storage = undefined; // storage blocked: nothing is kept, the page works as before
  }
  // without storage (the server render) the persister does nothing
  return createSyncStoragePersister({
    storage,
    key: PERSIST.key,
    throttleTime: 1_000,
    serialize,
    deserialize,
    retry: removeOldestQuery,
  });
}

// No initial wagmi state from the server: the pages are static, and the chain
// a browser last used is read from wagmi's cookie on the client (lib/hooks.ts).
export function Providers({ children }: { children: ReactNode }) {
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
  const [persister] = useState(makePersister);
  // the query client on window for poking at in development, set after render
  useEffect(() => {
    if (process.env.NODE_ENV === "development") (window as unknown as Record<string, unknown>).__qc = queryClient;
  }, [queryClient]);
  return (
    <WagmiProvider config={config}>
      <PersistQueryClientProvider
        client={queryClient}
        persistOptions={{
          persister,
          maxAge: PERSIST.maxAge,
          buster: PERSIST.buster,
          dehydrateOptions: { shouldDehydrateQuery: keepQuery },
        }}
      >
        <AccountEffects />
        {children}
      </PersistQueryClientProvider>
    </WagmiProvider>
  );
}
