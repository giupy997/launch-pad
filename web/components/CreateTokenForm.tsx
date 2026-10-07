"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { formatEther, parseEther, parseEventLogs } from "viem";
import Link from "next/link";
import { useAccount, useReadContract, useReadContracts, useWaitForTransactionReceipt, useWriteContract } from "wagmi";
import { launchpadAbi } from "@/lib/abi";
import { useLaunchpadAddress, useExplorer, useAppChain, ZERO_ADDRESS } from "@/lib/hooks";
import {
  robinhood,
  QUOTE_ASSETS,
  PRE_IPO_DISCLAIMER,
  rwaLogo,
  type QuoteAssetInfo,
  MIGRATION_TARGET,
} from "@/lib/config";
import { TokenLogo } from "@/components/TokenLogo";
import { processLogoFile, dataUriBytes } from "@/lib/image";
import { fmtTokens, fmtUnits } from "@/lib/format";
import { FeeSplitEditor, splitTotal, type SplitPct } from "@/components/FeeSplitEditor";
import { feesLine, treasuryPct } from "@/lib/curve";

const inputCls =
  "w-full rounded-lg input px-3 py-2 text-sm focus:border-white outline-none placeholder:text-zinc-600";

// fresh-curve constants for the dev-buy estimate (mirror the contract)
const V_ETH = 1.25e18;
const V_TOK = 1.05e27;

function estimateTokens(ethIn: number, feeBps: number): number {
  if (ethIn <= 0) return 0;
  const e = ethIn * 1e18 * (1 - feeBps / 10_000); // the platform fee and the coin's tax off first
  return (V_TOK - (V_ETH * V_TOK) / (V_ETH + e)) / 1e18;
}

function prefixed(value: string, base: string): string {
  const v = value.trim();
  if (!v) return "";
  if (v.startsWith("http://") || v.startsWith("https://")) return v;
  return `https://${base}/${v.replace(/^@/, "")}`;
}

export function CreateTokenForm() {
  const padMaybe = useLaunchpadAddress();
  const deployed = !!padMaybe;
  const pad = padMaybe ?? ("0x0000000000000000000000000000000000000000" as `0x${string}`);
  const explorer = useExplorer();
  const chain = useAppChain();
  const { isConnected } = useAccount();

  // a v8 pad closes to new coins the moment a migration freeze is announced
  // (trading goes on until the block); older pads have no freezeBlock and read as open
  const { data: freezeBlock } = useReadContract({
    address: pad,
    abi: launchpadAbi,
    functionName: "freezeBlock",
    query: { enabled: deployed, refetchInterval: 30_000 },
  });
  const closed = !!freezeBlock && freezeBlock > 0n;
  const target = MIGRATION_TARGET[chain.id] ?? "its new chain";

  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [description, setDescription] = useState("");
  const [initialBuy, setInitialBuy] = useState("");
  const [logoURI, setLogoURI] = useState("");
  const [website, setWebsite] = useState("");
  const [twitter, setTwitter] = useState("");
  const [telegram, setTelegram] = useState("");
  const [logoError, setLogoError] = useState("");
  const [quoteIdx, setQuoteIdx] = useState(0);
  const [feesToHolders, setFeesToHolders] = useState(false);
  // a coin's own fees (pads from v9 on): its tax each way, and the split of its pot
  const [buyTax, setBuyTax] = useState(0);
  const [sellTax, setSellTax] = useState(0);
  const [split, setSplit] = useState<SplitPct>({ creator: 100, holders: 0, burn: 0, liquidity: 0 });
  // a pad that knows fee configurations answers MAX_TAX_BPS; older ones take the launch-time choice alone.
  // Until the answer is in, the fee section waits: a choice made on the wrong form would be lost
  const { data: maxTaxRaw, isFetched: feeUiReady } = useReadContract({
    address: pad,
    abi: launchpadAbi,
    functionName: "MAX_TAX_BPS",
    query: { enabled: deployed, staleTime: Infinity, retry: 2 },
  });
  const customFees = maxTaxRaw !== undefined;
  const maxTaxPct = customFees ? Number(maxTaxRaw as bigint) / 100 : 10;
  const { data: padFees } = useReadContracts({
    contracts: [
      { address: pad, abi: launchpadAbi, functionName: "feeBps" },
      { address: pad, abi: launchpadAbi, functionName: "creatorFeeShareBps" },
      { address: pad, abi: launchpadAbi, functionName: "holderCashbackBps" },
    ],
    query: { enabled: deployed, staleTime: 60_000 },
  });
  const padBig = (i: number, fallback: bigint) => (padFees?.[i]?.status === "success" ? (padFees[i].result as bigint) : fallback);
  const platformFeeBps = padBig(0, 100n);
  const treasury = treasuryPct(platformFeeBps, padBig(1, 5_000n) + padBig(2, 3_000n));
  const platformPct = `${(Number(platformFeeBps) / 100).toString()}%`;
  const buyTaxBps = customFees ? Math.round(buyTax * 100) : 0;
  const sellTaxBps = customFees ? Math.round(sellTax * 100) : 0;
  const holdersOn = customFees ? split.holders > 0 : feesToHolders;
  const splitOk = !customFees || splitTotal(split) === 100;
  const splitText = customFees
    ? (
        [
          [split.creator, "you"],
          [split.holders, "holders"],
          [split.burn, "buyback & burn"],
          [split.liquidity, "liquidity"],
        ] as const
      )
        .filter(([pct]) => pct > 0)
        .map(([pct, who]) => `${pct}% ${who}`)
        .join(" · ")
    : feesToHolders
      ? "100% holders"
      : "100% you";
  const [logoProcessing, setLogoProcessing] = useState(false);

  const { writeContract, data: hash, isPending, error, reset } = useWriteContract();
  const { data: receipt, isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash });
  const [copied, setCopied] = useState(false);

  // the new token's address, from the TokenCreated event in the receipt
  const newToken = useMemo(() => {
    if (!receipt) return null;
    try {
      const events = parseEventLogs({
        abi: launchpadAbi,
        logs: receipt.logs,
        eventName: "TokenCreated",
      });
      return (events[0]?.args as { token?: `0x${string}` } | undefined)?.token ?? null;
    } catch {
      return null;
    }
  }, [receipt]);

  async function onLogoFile(file: File | undefined) {
    if (!file) return;
    setLogoError("");
    setLogoProcessing(true);
    try {
      setLogoURI(await processLogoFile(file));
    } catch (e) {
      setLogoError(e instanceof Error ? e.message : "Could not process image");
    } finally {
      setLogoProcessing(false);
    }
  }

  const native = chain.nativeCurrency.symbol;
  const quoteAssets = QUOTE_ASSETS[chain.id] ?? [
    { address: null, symbol: native, decimals: 18, kind: "native" as const },
  ];
  const quote = quoteAssets[Math.min(quoteIdx, quoteAssets.length - 1)];
  // the virtual reserve a curve in this quote opens with, as the pad has it now (the timelock may change it)
  const { data: virtualRaw } = useReadContract({
    address: pad,
    abi: launchpadAbi,
    functionName: "quoteVirtualReserve",
    args: [quote.address ?? ZERO_ADDRESS],
    query: { enabled: deployed, staleTime: 60_000 },
  });
  const virtualReserve = (virtualRaw as bigint | undefined) ?? 0n;
  const isEthQuote = quote.address === null;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (closed || !splitOk) return;
    const meta = {
      logoURI: logoURI.trim(),
      website: website.trim(),
      twitter: prefixed(twitter, "x.com"),
      telegram: prefixed(telegram, "t.me"),
      livestream: "",
      description: description.trim(),
    };
    const value = isEthQuote && initialBuy ? parseEther(initialBuy) : 0n;
    if (customFees) {
      writeContract({
        address: pad,
        abi: launchpadAbi,
        functionName: "createTokenWithFees",
        chainId: chain.id,
        args: [
          name.trim(),
          symbol.trim().toUpperCase(),
          0n,
          meta,
          quote.address ?? ZERO_ADDRESS,
          {
            buyTaxBps,
            sellTaxBps,
            creatorBps: split.creator * 100,
            holdersBps: split.holders * 100,
            burnBps: split.burn * 100,
            liquidityBps: split.liquidity * 100,
          },
        ],
        value,
      });
    } else {
      writeContract({
        address: pad,
        abi: launchpadAbi,
        functionName: "createToken",
        chainId: chain.id,
        args: [name.trim(), symbol.trim().toUpperCase(), 0n, meta, quote.address ?? ZERO_ADDRESS, feesToHolders],
        value,
      });
    }
  }

  const devBuyNum = parseFloat(initialBuy) || 0;
  const estTokens = estimateTokens(devBuyNum, Number(platformFeeBps) + buyTaxBps);
  const ticker = symbol.trim().toUpperCase();

  return (
    <div className="grid gap-8 lg:grid-cols-[1fr_380px]">
      {/* ------------------------------------------------ form */}
      <form onSubmit={submit} className="space-y-5 order-2 lg:order-1">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <Label>Name</Label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Token name"
              required
              maxLength={32}
              className={inputCls}
            />
            <Hint>Letters, numbers and spaces · 32 max</Hint>
          </div>
          <div>
            <Label>Ticker</Label>
            <div className="flex items-center rounded-lg input focus-within:border-white">
              <span className="pl-3 text-zinc-500 text-sm">$</span>
              <input
                value={symbol}
                onChange={(e) => setSymbol(e.target.value)}
                placeholder="SYMBOL"
                required
                maxLength={10}
                className="w-full bg-transparent px-2 py-2 text-sm uppercase outline-none placeholder:text-zinc-600"
              />
            </div>
            <Hint>Letters and numbers · 10 max</Hint>
          </div>
        </div>

        <div>
          <div className="flex justify-between items-baseline">
            <Label>Description <span className="normal-case text-zinc-600">optional</span></Label>
            <span className="font-mono text-[10px] text-zinc-600">{description.length} / 300</span>
          </div>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="A short description of the token"
            maxLength={300}
            rows={3}
            className={`${inputCls} resize-none`}
          />
        </div>

        <div>
          <Label>Token image</Label>
          <div className="flex gap-3 items-center">
            <label className="flex-1 cursor-pointer rounded-lg border border-dashed border-white/15 px-3 py-3 text-sm text-zinc-400 hover:border-white hover:text-white text-center">
              {logoProcessing
                ? "Processing…"
                : logoURI.startsWith("data:")
                  ? `Logo ready · ${(dataUriBytes(logoURI) / 1024).toFixed(1)} KB · tap to change`
                  : "📷 Upload a square image (stored on-chain)"}
              <input
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => onLogoFile(e.target.files?.[0])}
              />
            </label>
          </div>
          <input
            value={logoURI.startsWith("data:") ? "" : logoURI}
            onChange={(e) => setLogoURI(e.target.value)}
            placeholder="…or paste an image URL"
            type="url"
            className={`${inputCls} mt-2`}
          />
          {logoError && <Hint>⚠ {logoError}</Hint>}
        </div>

        <div>
          <Label>Links <span className="normal-case text-zinc-600">optional</span></Label>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <input value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="Website" type="text" className={inputCls} />
            <PrefixInput base="x.com/" value={twitter} onChange={setTwitter} />
            <PrefixInput base="t.me/" value={telegram} onChange={setTelegram} />
          </div>
        </div>

        <div>
          <Label>Pair with <span className="normal-case text-zinc-600">the asset your curve is priced in</span></Label>
          <PairSelect assets={quoteAssets} value={quote} onChange={setQuoteIdx} />
          {!isEthQuote && (
            <Hint>Buys, sells, fees and the graduation pool will all be in {quote.symbol}.</Hint>
          )}
          {quote.kind === "premarket" && <Hint>⚠ {PRE_IPO_DISCLAIMER}</Hint>}
          {quote.kind === "preipo" && (
            <Hint>Official Robinhood tokenized share of a private, pre-IPO company.</Hint>
          )}
        </div>

        <div>
          <Label>
            Trading fees{" "}
            <span className="normal-case text-zinc-600">
              {customFees
                ? `${platformPct} platform fee on every curve trade (${treasury} to the treasury) · add your own tax up to ${maxTaxPct}% each way · you split the pot, fixed forever`
                : `${platformPct} per trade on the curve · ${treasury} to the treasury · you pick where the rest goes, locked forever`}
            </span>
          </Label>
          {deployed && !feeUiReady ? (
            <div className="rounded-xl border border-white/10 px-4 py-6 text-center text-xs text-zinc-500">Loading the fee options…</div>
          ) : customFees ? (
            <FeeSplitEditor
              buyTax={buyTax}
              sellTax={sellTax}
              maxTax={maxTaxPct}
              split={split}
              onTax={(side, pct) => (side === "buy" ? setBuyTax(pct) : setSellTax(pct))}
              onSplit={setSplit}
            />
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <FeeModeCard
                title="Keep the fees"
                detail="80% of every trade fee accrues to you"
                selected={!feesToHolders}
                onClick={() => setFeesToHolders(false)}
              />
              <FeeModeCard
                title="Reward holders"
                detail="80% of every trade fee is cashback for your holders, for as long as the curve trades"
                selected={feesToHolders}
                onClick={() => setFeesToHolders(true)}
              />
            </div>
          )}
        </div>

        <div>
          <Label>Dev buy <span className="normal-case text-zinc-600">optional — be the first holder</span></Label>
          <div className="flex gap-2 items-center flex-wrap">
            {["0", "0.01", "0.05", "0.1"].map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setInitialBuy(v === "0" ? "" : v)}
                className={`rounded-full px-3 py-1.5 text-xs font-mono ${
                  (v === "0" && !initialBuy) || initialBuy === v
                    ? "bg-white text-black"
                    : "border border-white/15 text-zinc-400 hover:border-white hover:text-white"
                }`}
              >
                {v === "0" ? "Off" : `${v} ${native}`}
              </button>
            ))}
            <input
              value={initialBuy}
              onChange={(e) => setInitialBuy(e.target.value)}
              placeholder="custom"
              type="number"
              step="any"
              min="0"
              className="w-24 rounded-full input px-3 py-1.5 text-xs font-mono focus:border-white outline-none text-right"
            />
          </div>
          {isEthQuote && devBuyNum > 0 && (
            <Hint>≈ {fmtTokens(BigInt(Math.floor(estTokens)) * 10n ** 18n)} ${ticker || "TOKENS"} at launch price</Hint>
          )}
          {!isEthQuote && (
            <Hint>Dev buy in {quote.symbol} is done right after launch from the token page.</Hint>
          )}
        </div>

        <div className="rounded-lg border border-white/10 px-4 py-3 font-mono text-[11px] tracking-wide text-zinc-400 uppercase">
          {feesLine(platformFeeBps, { buyTaxBps, sellTaxBps })} →{" "}
          <span className="text-white">{splitText}</span> · {treasury} treasury
        </div>

        <button
          type="submit"
          disabled={!deployed || closed || !feeUiReady || !splitOk || !isConnected || isPending || isConfirming}
          className="btn-primary w-full py-3"
        >
          {!deployed
            ? "Not deployed on this chain"
            : closed
              ? `Closed: moving to ${target}`
            : !splitOk
              ? `Split must total 100% (${splitTotal(split)}% now)`
            : !isConnected
              ? "Connect wallet to launch"
              : isPending
                ? "Sign in wallet…"
                : isConfirming
                  ? "Confirming…"
                  : "Launch token"}
        </button>
        {closed && (
          <p className="text-xs text-zinc-500">
            The migration to {target} is announced: this launchpad takes no new coins until every coin
            is live there. Trading goes on until the freeze block; launch yours on {target} once it opens.
          </p>
        )}

        {isSuccess && hash && (
          <div className="card p-4 space-y-3">
            <p className="text-sm text-white font-semibold">🎉 Token created!</p>
            {newToken && (
              <>
                <div className="flex items-center gap-2 flex-wrap">
                  <code className="font-mono text-xs text-zinc-300 break-all">{newToken}</code>
                  <button
                    type="button"
                    onClick={() => {
                      navigator.clipboard.writeText(newToken);
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1500);
                    }}
                    className="rounded-full border border-white/15 px-2.5 py-0.5 text-xs text-zinc-300 hover:border-white hover:text-white shrink-0"
                  >
                    {copied ? "Copied ✓" : "Copy CA"}
                  </button>
                </div>
                <Link
                  href={`/token/${newToken}`}
                  className="block w-full rounded-full bg-white py-2 text-center text-sm font-semibold text-black hover:bg-zinc-100 transition-colors"
                >
                  Open trading page →
                </Link>
              </>
            )}
            <p className="text-xs text-zinc-500">
              <a href={`${explorer}/tx/${hash}`} target="_blank" className="underline">
                View transaction
              </a>
              <button type="button" onClick={() => reset()} className="text-zinc-600 underline ml-3">
                dismiss
              </button>
            </p>
          </div>
        )}
        {error && (
          <p className="text-sm text-zinc-400 break-all border border-white/15 rounded-lg p-2">
            ⚠ {(error as { shortMessage?: string }).shortMessage ?? error.message}
          </p>
        )}
      </form>

      {/* ------------------------------------------------ live preview */}
      <aside className="order-1 lg:order-2">
        <div className="lg:sticky lg:top-24 space-y-4">
        {/* the head with its astrolabe, above the preview */}
        <div className="relative hidden h-44 overflow-hidden rounded-2xl border border-white/10 card lg:block">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 bg-[url('/art/statue-orbit.webp')] bg-cover bg-[center_18%] opacity-90 mix-blend-screen"
          />
          <div aria-hidden className="pointer-events-none absolute inset-0 bg-gradient-to-t from-ink/90 via-transparent to-transparent" />
          <div className="absolute bottom-3 left-4 label">See the next rotation</div>
        </div>
        <div className="card p-5 space-y-4">
          <div className="flex items-center justify-between">
            <span className="font-mono text-[10px] tracking-widest uppercase text-zinc-500">
              Your coin
            </span>
            <span className="font-mono text-[10px] tracking-widest uppercase text-zinc-400">
              ● live preview
            </span>
          </div>

          <div className="flex items-center gap-3">
            <TokenLogo uri={logoURI.trim()} symbol={ticker || "?"} size={56} />
            <div className="min-w-0">
              <div className="font-mono text-xl font-bold">${ticker || "TICKER"}</div>
              <div className="text-sm text-zinc-400 truncate">{name || "Your token name"}</div>
            </div>
          </div>
          <p className="text-sm text-zinc-500 min-h-10">
            {description || "Your description will appear here."}
          </p>

          <div className="divide-y divide-white/[0.06] font-mono text-xs">
            <Row k="Fees" v={feesLine(platformFeeBps, { buyTaxBps, sellTaxBps })} />
            <Row k="Fee split" v={`${splitText} · ${treasury} treasury`} strong />
            <Row k="Holders earn" v={holdersOn ? `Cashback in ${quote.symbol}` : "—"} />
            <Row k="Supply" v="1B fixed" />
            <Row
              k="Pair"
              v={
                quote.kind === "preipo" || quote.kind === "premarket"
                  ? `${quote.symbol} · Pre-IPO`
                  : quote.symbol
              }
              strong
            />
            {virtualReserve > 0n ? (
              <>
                <Row k="Opens with" v={`${fmtUnits(virtualReserve, quote.decimals)} ${quote.symbol} virtual reserve`} />
                <Row k="Curve raises" v={`~${fmtUnits((virtualReserve * 32n) / 10n, quote.decimals)} ${quote.symbol}, then it graduates`} />
              </>
            ) : (
              <Row k="Curve" v={isEthQuote ? `800M · graduates at ~4 ${native}` : `800M on the ${quote.symbol} curve`} />
            )}
            <Row
              k="Liquidity"
              v={chain.id === robinhood.id ? "Locked forever on Uniswap v4" : "Locked at graduation"}
              strong
            />
            {chain.id === robinhood.id && <Row k="After graduation" v="1% fee keeps flowing" strong />}
            <Row
              k="Dev buy"
              v={devBuyNum > 0 ? `${formatEther(parseEtherSafe(initialBuy))} ${native}` : `0 ${native}`}
            />
          </div>

          <p className="text-[11px] text-zinc-600">
            {chain.id === robinhood.id
              ? `One transaction deploys your coin and its bonding curve. At graduation, liquidity moves to a Uniswap v4 pool, locked forever, and every swap there keeps paying the 1% fee — ${feesToHolders ? "to your holders" : "to you"}, as chosen above.`
              : "One transaction deploys your coin and its bonding curve, its fees fixed for good. At graduation, liquidity moves to the DEX automatically and is locked forever."}
          </p>
        </div>
        </div>
      </aside>
    </div>
  );
}

/** Grouped dropdown for the pair asset: ETH · Pre-IPO · Stocks. */
function PairSelect({
  assets,
  value,
  onChange,
}: {
  assets: QuoteAssetInfo[];
  value: QuoteAssetInfo;
  onChange: (idx: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const s = search.trim().toLowerCase();
  const matches = assets.filter(
    (a) =>
      !s ||
      a.symbol.toLowerCase().includes(s) ||
      (a.name ?? "").toLowerCase().includes(s) ||
      a.address?.toLowerCase() === s
  );
  const groups: { label: string; note?: string; assets: QuoteAssetInfo[] }[] = [
    { label: "", assets: matches.filter((a) => a.kind === "native" || a.kind === "stable" || a.kind === "crypto") },
    {
      label: "◆ Pre-IPO",
      note: "no public market",
      assets: matches.filter((a) => a.kind === "premarket" || a.kind === "preipo"),
    },
    {
      label: "ETFs & commodities",
      assets: matches.filter((a) => a.kind === "etf"),
    },
    { label: "Stocks", assets: matches.filter((a) => a.kind === "stock") },
  ].filter((g) => g.assets.length > 0);

  const pick = (a: QuoteAssetInfo) => {
    onChange(assets.indexOf(a));
    setSearch("");
    setOpen(false);
  };

  const item = (a: QuoteAssetInfo) => {
    const active = a === value;
    return (
      <button
        key={a.symbol}
        type="button"
        onClick={() => pick(a)}
        className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left ${
          active ? "bg-white text-black" : "text-zinc-300 hover:bg-zinc-900 hover:text-white"
        }`}
      >
        <AssetLogo asset={a} size={22} />
        <span className="font-mono text-sm">{a.symbol}</span>
        <span
          className={`truncate text-[11px] flex-1 ${active ? "text-zinc-700" : "text-zinc-500"}`}
        >
          {a.name}
        </span>
        {a.kind === "premarket" && (
          <span
            className={`font-mono text-[9px] tracking-widest uppercase rounded-full px-1.5 py-px border shrink-0 ${
              active ? "border-black" : "border-white"
            }`}
          >
            Notus
          </span>
        )}
      </button>
    );
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full sm:w-72 items-center justify-between rounded-lg input px-3 py-2 text-sm text-white hover:border-white focus:border-white outline-none"
      >
        <span className="flex items-center gap-2 min-w-0">
          <AssetLogo asset={value} size={20} />
          <span className="font-mono">{value.symbol}</span>
          <span className="truncate text-[11px] text-zinc-500">{value.name}</span>
        </span>
        <span className={`text-zinc-500 transition-transform ${open ? "rotate-180" : ""}`}>▾</span>
      </button>

      {open && (
        <div className="absolute left-0 top-full mt-2 w-full sm:w-80 rounded-xl input p-1.5 z-30 shadow-lg shadow-black/60">
          <input
            autoFocus
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={`Search ${assets.length} assets — ticker, name or CA`}
            className="w-full rounded-lg bg-zinc-950 border border-white/10 px-3 py-1.5 text-xs outline-none focus:border-white placeholder:text-zinc-600 mb-1"
          />
          <div className="max-h-72 overflow-y-auto">
            {groups.length === 0 && (
              <p className="px-3 py-4 text-center text-xs text-zinc-600">No asset matches.</p>
            )}
            {groups.map((g) => (
              <div key={g.label}>
                {g.label && (
                  <div
                    className={`px-2.5 pt-2 pb-1 font-mono text-[9px] tracking-widest uppercase ${
                      g.label.startsWith("◆") ? "text-white" : "text-zinc-500"
                    }`}
                  >
                    {g.label}
                    {g.note && <span className="text-zinc-600 normal-case"> — {g.note}</span>}
                  </div>
                )}
                {g.assets.map(item)}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** The asset's own logo, else Robinhood's for RWAs, else a monogram. */
function AssetLogo({ asset, size }: { asset: QuoteAssetInfo; size: number }) {
  const [failed, setFailed] = useState(false);
  const src = asset.logo ?? rwaLogo(asset);
  if (src && !failed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt=""
        width={size}
        height={size}
        onError={() => setFailed(true)}
        className="rounded-full bg-zinc-900 shrink-0 object-cover"
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <span
      className="rounded-full bg-zinc-800 text-white font-mono grid place-items-center shrink-0"
      style={{ width: size, height: size, fontSize: size * (asset.kind === "native" ? 0.6 : 0.42) }}
    >
      {asset.kind === "native" ? "Ξ" : asset.symbol.slice(0, 2)}
    </span>
  );
}

function FeeModeCard({
  title,
  detail,
  selected,
  onClick,
}: {
  title: string;
  detail: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-xl border px-4 py-3 text-left ${
        selected
          ? "border-white bg-white text-black"
          : "border-white/15 text-zinc-400 hover:border-white hover:text-white"
      }`}
    >
      <div className="font-mono text-xs font-bold tracking-widest uppercase">{title}</div>
      <div className={`mt-1 text-[11px] ${selected ? "text-zinc-700" : "text-zinc-500"}`}>
        {detail}
      </div>
    </button>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div className="font-mono text-[10px] tracking-widest uppercase text-zinc-500 mb-1.5">
      {children}
    </div>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return <p className="mt-1 text-[11px] text-zinc-600">{children}</p>;
}

function Row({ k, v, strong }: { k: string; v: string; strong?: boolean }) {
  return (
    <div className="flex justify-between gap-3 py-2">
      <span className="text-zinc-500">{k}</span>
      <span className={strong ? "text-white text-right" : "text-zinc-300 text-right"}>{v}</span>
    </div>
  );
}

function PrefixInput({
  base,
  value,
  onChange,
}: {
  base: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex items-center rounded-lg input focus-within:border-white">
      <span className="pl-3 text-zinc-600 text-sm whitespace-nowrap">{base}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="handle"
        className="w-full bg-transparent px-1.5 py-2 text-sm outline-none placeholder:text-zinc-700 min-w-0"
      />
    </div>
  );
}

function parseEtherSafe(v: string): bigint {
  try {
    return v ? parseEther(v) : 0n;
  } catch {
    return 0n;
  }
}
