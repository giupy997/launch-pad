// The launch batch (lib/launch.ts): the coin's address foretold from the factory's nonce
// (checked against two coins the v12 factory on Base deployed), the fresh curve's
// arithmetic, and the calls in their order with their targets and values.
//   node --test --experimental-strip-types lib/launch.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { toFunctionSelector } from "viem";
import { CURVE_SUPPLY, freshCurveBuy, launchCalls, lessSlippage, predictedToken, zapPath, type Launch } from "./launch.ts";

// Base v12's LaunchTokenFactory and the first two coins it deployed (README, Deployments; the chain)
const FACTORY = "0x2662A5433f360176E3555D5EEc81AC5aCE5F36f9" as const;
const LITVMCOOL = "0xbd08f4DD7CAa10F07a3B862990928553cFCF2Ea0";
const MUR = "0xA10c421A9c2EA5d184B2eC0474E36f29971b97Ce";
const PAD = "0x23231924281B34Bb28F10D854DB8D2DcBd7F78c5" as const;
const CBLTC = "0xcb17C9Db87B595717C857a08468793f5bAb6445F" as const;
const ZAP = "0x15045E01b6A38f40695EEa0BB31aE0342f7Ee810" as const;
const WETH = "0x4200000000000000000000000000000000000006" as const;
const sel = (sig: string) => toFunctionSelector(sig);

test("the factory's next coin is its CREATE address at its nonce: the first two coins on Base", () => {
  // a contract's nonce starts at 1 (EIP-161): its first deployment is nonce 1
  assert.equal(predictedToken(FACTORY, 1).toLowerCase(), LITVMCOOL.toLowerCase());
  assert.equal(predictedToken(FACTORY, 2n).toLowerCase(), MUR.toLowerCase());
});

test("a buy on a fresh curve: the pad's arithmetic, the fee off first, capped at the curve's supply", () => {
  const virtual = 50n * 10n ** 8n; // 50 cbLTC
  const quoteIn = 1n * 10n ** 8n; // 1 cbLTC at 0.5% + 1% of rate
  const out = freshCurveBuy(virtual, quoteIn, 150n);
  const forCurve = quoteIn - (quoteIn * 150n) / 10_000n;
  const expected = 1_050_000_000n * 10n ** 18n - (virtual * 1_050_000_000n * 10n ** 18n) / (virtual + forCurve);
  assert.equal(out, expected);
  assert.ok(out > 20_000_000n * 10n ** 18n && out < 21_000_000n * 10n ** 18n, "about 20.6M coins");
  assert.equal(freshCurveBuy(virtual, 1_000_000n * 10n ** 8n, 50n), CURVE_SUPPLY, "a buy past the curve gets the curve");
  assert.equal(freshCurveBuy(virtual, 0n, 50n), 0n);
  assert.equal(lessSlippage(10_000n), 9_900n);
});

const base: Omit<Launch, "devBuy"> = {
  pad: PAD,
  token: predictedToken(FACTORY, 3),
  name: "Notus",
  symbol: "NOTUS",
  meta: { logoURI: "", website: "", twitter: "", telegram: "", livestream: "", description: "" },
  quoteAsset: CBLTC,
  fees: { buyTaxBps: 100, sellTaxBps: 100, creatorBps: 2500, holdersBps: 0, burnBps: 5000, liquidityBps: 2500, platformBps: 0 },
};

test("without a dev buy the batch is the launch alone", () => {
  const calls = launchCalls({ ...base, devBuy: null });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].to, PAD);
  assert.equal(calls[0].data.slice(0, 10), sel("createTokenWithFees(string,string,uint256,(string,string,string,string,string,string),address,(uint16,uint16,uint16,uint16,uint16,uint16,uint16))"));
  assert.equal(calls[0].value, undefined);
});

test("a dev buy in the quote: the approval when needed, the launch, the guard on the foretold address, the buy", () => {
  const calls = launchCalls({ ...base, devBuy: { kind: "quote", quote: CBLTC, amount: 10n ** 8n, minTokensOut: 1n, approve: true } });
  assert.deepEqual(
    calls.map((c) => [c.to, c.data.slice(0, 10), c.value]),
    [
      [CBLTC, sel("approve(address,uint256)"), undefined],
      [PAD, sel("createTokenWithFees(string,string,uint256,(string,string,string,string,string,string),address,(uint16,uint16,uint16,uint16,uint16,uint16,uint16))"), undefined],
      [PAD, sel("setFeeRecipient(address,address)"), undefined],
      [PAD, sel("buyWithQuote(address,uint256,uint256)"), undefined],
    ]
  );
  // the guard and the buy name the foretold coin
  assert.ok(calls[2].data.toLowerCase().includes(base.token.slice(2).toLowerCase()));
  assert.ok(calls[3].data.toLowerCase().includes(base.token.slice(2).toLowerCase()));
  const without = launchCalls({ ...base, devBuy: { kind: "quote", quote: CBLTC, amount: 10n ** 8n, minTokensOut: 1n, approve: false } });
  assert.equal(without.length, 3, "no approval when the allowance is there");
});

test("a dev buy in ETH: the launch, the guard, the zap with the value", () => {
  const path = zapPath(WETH, 200, CBLTC);
  assert.equal(path.length, 2 + (20 + 3 + 20) * 2, "address, 3-byte hop, address");
  const calls = launchCalls({ ...base, devBuy: { kind: "eth", zap: ZAP, path, value: 10n ** 16n, minQuoteOut: 1n, minTokensOut: 1n } });
  assert.deepEqual(
    calls.map((c) => [c.to, c.data.slice(0, 10), c.value]),
    [
      [PAD, sel("createTokenWithFees(string,string,uint256,(string,string,string,string,string,string),address,(uint16,uint16,uint16,uint16,uint16,uint16,uint16))"), undefined],
      [PAD, sel("setFeeRecipient(address,address)"), undefined],
      [ZAP, sel("zapBuy(address,bytes,uint256,uint256)"), 10n ** 16n],
    ]
  );
});
