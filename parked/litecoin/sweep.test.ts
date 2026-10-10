// node --test --experimental-strip-types litecoin/sweep.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { bridgeLeft, sweepable } from "./sweep.ts";

const LTC = 100_000_000n;

test("sweepable: the treasury less the reserve, never beyond what the balance holds over the liabilities", () => {
  // a healthy desk: balance covers liabilities and treasury with dust to spare
  assert.equal(sweepable(10n * LTC, 7n * LTC, 3n * LTC, LTC / 20n), 3n * LTC - LTC / 20n);
  // the balance is short of what the ledger says (fees ate into it): the balance rules
  assert.equal(sweepable(9n * LTC, 7n * LTC, 3n * LTC, LTC / 20n), 2n * LTC - LTC / 20n);
  // no treasury: nothing, however large the balance
  assert.equal(sweepable(100n * LTC, 7n * LTC, 0n, LTC / 20n), 0n);
  // insolvent: nothing
  assert.equal(sweepable(5n * LTC, 7n * LTC, 3n * LTC, 0n), 0n);
  // the reserve alone: nothing
  assert.equal(sweepable(LTC, 0n, LTC, LTC), 0n);
});

test("bridgeLeft: what the migration needs, in lit, less what already left the desk", () => {
  const WEI = 10n ** 18n;
  assert.equal(bridgeLeft(3n * WEI, 0n), 3n * LTC);
  assert.equal(bridgeLeft(3n * WEI, LTC), 2n * LTC);
  assert.equal(bridgeLeft(3n * WEI, 3n * LTC), 0n);
  // more left than needed (a clamp upstream, a hand-edited file): nothing, never negative
  assert.equal(bridgeLeft(3n * WEI, 5n * LTC), 0n);
  // wei under a litoshi is dropped, never rounded up
  assert.equal(bridgeLeft(3n * WEI + 9_999_999_999n, 0n), 3n * LTC);
});
