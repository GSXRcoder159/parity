// mulberry32 seeded generator, from Slim (src/fuzz/gen.ts, MIT, same author).
import type { Gen } from "./types.ts";

export function createGen(seed: number): Gen {
  let s = seed >>> 0;
  const next = (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min: number, max: number): number => min + Math.floor(next() * (max - min + 1));
  return {
    next,
    int,
    pick: (xs) => {
      if (xs.length === 0) throw new Error("Gen.pick: empty array");
      return xs[int(0, xs.length - 1)]!;
    },
    bool: () => next() < 0.5,
  };
}
