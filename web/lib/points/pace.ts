// How many blocks ago a time was, found from the blocks' own timestamps.
//
// A chain's pace is not a figure to divide by. Base made a block every 2 s
// until 2026-11-05 and one every 0.2 s since; Liteforge, after its move of
// 2026-11-10, makes its blocks as its traffic asks: 0.3 s apart in a busy
// hour, and at night a thousand blocks span five hours. Measured there on
// 2026-11-11, 202,061 blocks back was 20.7 hours ago and 203,045 blocks back
// was 25.4. So "a day ago" is searched for: the blocks' times only ever
// grow, and a few rounds of probes close in on the one that crosses the mark.
//
// No imports: the points service loads this file under Node as it is.

/** The number of blocks, counting back from `latest`, that were made in the
 *  last `seconds`: `latest` minus the earliest block found whose time is
 *  within them. `timeOf` reads a block's timestamp (unix seconds); `guess` is
 *  a rough count (the configured pace's) and only sets where the search
 *  starts. Each round reads `fan` blocks at once and narrows the bracket
 *  `fan + 1` times: four rounds of eight find the block to within a 6,561st
 *  of the bracket (a couple of hundred blocks of a million). The answer errs
 *  short, never long: every block counted is within the time; where the
 *  chain stood still for hours, the blocks left out are the few of those
 *  hours. Throws what `timeOf` throws. */
export async function blocksSince(
  timeOf: (block: bigint) => Promise<number>,
  latest: bigint,
  seconds: number,
  guess: bigint,
  { fan = 8, rounds = 4 }: { fan?: number; rounds?: number } = {}
): Promise<bigint> {
  if (latest <= 0n) return 0n;
  const target = (await timeOf(latest)) - seconds;
  // a bracket: `lo` at or before the mark (or the chain's first block), `hi` after it
  let hi = latest;
  let back = guess > 0n ? guess * 4n : 1n;
  let lo = latest > back ? latest - back : 0n;
  for (let i = 0; i < 4 && lo > 0n && (await timeOf(lo)) > target; i++) {
    back *= 4n;
    lo = latest > back ? latest - back : 0n;
  }
  // the chain's first block is within the time: all of it
  if (lo === 0n && (await timeOf(0n)) >= target) return latest;
  for (let r = 0; r < rounds; r++) {
    const step = (hi - lo) / BigInt(fan + 1);
    if (step <= 0n) break;
    const probes = Array.from({ length: fan }, (_, i) => lo + step * BigInt(i + 1));
    const times = await Promise.all(probes.map(timeOf));
    const k = times.findIndex((t) => t >= target);
    if (k === -1) lo = probes[fan - 1];
    else {
      hi = probes[k];
      if (k > 0) lo = probes[k - 1];
    }
  }
  return latest - hi;
}
