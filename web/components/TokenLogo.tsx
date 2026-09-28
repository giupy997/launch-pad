"use client";

import { useState } from "react";
import { safeLogo } from "@/lib/sanitize";

/** Square (1:1) token logo with a monochrome fallback. */
export function TokenLogo({
  uri,
  symbol,
  size = 48,
}: {
  uri: string;
  symbol: string;
  size?: number;
}) {
  const [failed, setFailed] = useState(false);
  const src = safeLogo(uri);

  if (!src || failed) {
    return (
      <div
        style={{ width: size, height: size }}
        className="flex items-center justify-center rounded-lg input font-mono font-bold text-zinc-400 select-none"
      >
        {symbol?.slice(0, 1).toUpperCase() || "?"}
      </div>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element -- arbitrary external hosts
    <img
      src={src}
      alt={symbol}
      width={size}
      height={size}
      onError={() => setFailed(true)}
      style={{ width: size, height: size }}
      className="rounded-lg object-cover aspect-square border border-white/10"
    />
  );
}
