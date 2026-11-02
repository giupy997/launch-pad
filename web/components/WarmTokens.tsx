"use client";

import { useEffect, useState } from "react";
import { useTokens } from "@/lib/hooks";

/** Reads another chain's token list into the cache, once and without
 *  polling, so that switching there finds the list ready instead of a second
 *  or two of placeholders. Renders nothing.
 *
 *  It waits for the browser to be idle, and a few seconds besides: the home
 *  keeps reading this chain's prices, volumes and holders after its list is
 *  in, and the other chain's list (dozens of calls to a node of its own, some
 *  of them slow) competed with those reads and was measured holding the page
 *  back. On a connection that asked for less data it is not read at all. */
export function WarmTokens({ chainId }: { chainId: number }) {
  const [go, setGo] = useState(false);
  useEffect(() => {
    if (typeof navigator !== "undefined" && (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData) return;
    let idle: number | undefined;
    const timer = window.setTimeout(() => {
      if ("requestIdleCallback" in window) idle = window.requestIdleCallback(() => setGo(true), { timeout: 10_000 });
      else setGo(true);
    }, WARM_AFTER_MS);
    return () => {
      window.clearTimeout(timer);
      if (idle !== undefined && "cancelIdleCallback" in window) window.cancelIdleCallback(idle);
    };
  }, []);
  return go ? <Warm chainId={chainId} /> : null;
}

const WARM_AFTER_MS = 8_000;

function Warm({ chainId }: { chainId: number }) {
  useTokens(chainId, { warm: true });
  return null;
}
