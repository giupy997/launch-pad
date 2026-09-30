"use client";

import { useEffect, useState } from "react";

/** The time, in unix seconds, refreshed every `everyMs`: for "updated 12 s
 *  ago" displays, which must not read the clock during render. */
export function useNow(everyMs = 30_000): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}
