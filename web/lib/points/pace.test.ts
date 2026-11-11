// The block of a time ago, searched by the blocks' timestamps.
//   node --test --experimental-strip-types lib/points/pace.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { blocksSince } from "./pace.ts";

/** a chain from a list of stretches: `blocks` blocks, `seconds` apart each, oldest first */
function chainOf(stretches: { blocks: number; seconds: number }[]) {
  const times: number[] = [1_700_000_000];
  for (const s of stretches) for (let i = 0; i < s.blocks; i++) times.push(times[times.length - 1] + s.seconds);
  let reads = 0;
  return {
    latest: BigInt(times.length - 1),
    timeOf: async (n: bigint) => {
      reads++;
      return times[Number(n)];
    },
    /** the exact answer: how many of the last blocks are within `seconds` of the latest */
    exact: (seconds: number) => {
      const mark = times[times.length - 1] - seconds;
      return times.length - 1 - times.findIndex((t) => t >= mark);
    },
    reads: () => reads,
  };
}

test("a steady chain: the day is the day, whatever the guess", async () => {
  const c = chainOf([{ blocks: 600_000, seconds: 0.2 }]);
  for (const guess of [43_200n, 432_000n, 5_000_000n]) {
    const n = Number(await blocksSince(c.timeOf, c.latest, 86_400, guess));
    assert.ok(n <= 432_000 && n > 432_000 * 0.98, `guess ${guess}: ${n}`);
  }
});

test("a chain that changed its pace: the count follows the times, not the old figure", async () => {
  // two-second blocks, then a tenth of that for the last half day
  const c = chainOf([
    { blocks: 100_000, seconds: 2 },
    { blocks: 216_000, seconds: 0.2 },
  ]);
  const exact = c.exact(86_400); // the 216,000 fast blocks (12 h) and some 21,600 slow ones (12 h)
  assert.ok(Math.abs(exact - 237_600) <= 1);
  const n = Number(await blocksSince(c.timeOf, c.latest, 86_400, 43_200n));
  assert.ok(n <= exact && n > exact * 0.98, `${n} of ${exact}`);
});

test("a chain that stops at night: a gap of hours between two blocks does not throw the search", async () => {
  // a busy evening, five hours in which a thousand blocks were made, a busy day
  const c = chainOf([
    { blocks: 300_000, seconds: 0.25 },
    { blocks: 1_000, seconds: 18 },
    { blocks: 200_000, seconds: 0.3 },
  ]);
  const exact = c.exact(86_400);
  const n = Number(await blocksSince(c.timeOf, c.latest, 86_400, 345_600n));
  assert.ok(n <= exact, `${n} counts blocks older than a day (exact ${exact})`);
  assert.ok(exact - n < 1_000, `${n} is far from ${exact}`);
  assert.ok(c.reads() <= 40, `${c.reads()} reads`);
});

test("a chain younger than the time asked: every block of it", async () => {
  const c = chainOf([{ blocks: 1_000, seconds: 1 }]);
  assert.equal(await blocksSince(c.timeOf, c.latest, 86_400, 345_600n), 1_000n);
});

test("a node that does not say fails the search, so the caller keeps what it had", async () => {
  await assert.rejects(
    blocksSince(
      async () => {
        throw new Error("no block");
      },
      100n,
      60,
      10n
    )
  );
});
