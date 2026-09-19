import assert from "node:assert/strict";
import { bootstrap, despike, replay, splice, tickOf, type Candle, type Pool } from "./sewa.ts";

// Pool 4pCZ read on 19 Sep: tick 20363 at 766.1623 USD per SPYx raw (dec 8/6)
assert.equal(tickOf(766.1623 * 1e-2), 20363);

const pool: Pool = { id: "x", mint0: "a", mint1: "b", dec0: 8, dec1: 6, tickSpacing: 1, liquidity: 0, tick: 0, feeRate: 0.0001, protocolCut: 0.16 };
const always = "America/New_York;O,O,O,O,O,O,O;";
const sched = { regular: always, pre: "", post: "", overnight: "" };
const L = 1e13;
const full = [{ nft: "p1", lower: -400000, upper: 400000, liquidity: L }, { nft: "p2", lower: -400000, upper: 400000, liquidity: 3 * L }, { nft: "far", lower: 30000, upper: 30010, liquidity: L }];
const t0 = Date.UTC(2026, 8, 14, 15) / 1000;

// flat price: no LVR, fees = vol * 1bp * 84%, split 1:3, out-of-range position gets nothing
const flat: Candle[] = [0, 1, 2].map((i) => [t0 + 60 * i, 766, 766, 766, 766, 10_000]);
const a = replay(pool, full, flat, sched, [[t0 * 1000 - 1, 766]]);
assert.ok(Math.abs(a.bySession.regular.feesUsd - 3 * 10_000 * 0.0001 * 0.84) < 1e-9);
assert.equal(a.bySession.regular.lvrUsd, 0);
const p1 = a.top.find((p) => p.nft === "p1")!, far = a.top.find((p) => p.nft === "far")!;
assert.ok(Math.abs(p1.feesUsd - a.bySession.regular.feesUsd / 4) < 1e-9);
assert.equal(far.feesUsd, 0);
assert.equal(far.inRangePct, 0);

// one +1% step in the FAIR price: LVR = r^2 * L_total * sqrt(P_raw) / 4 / 1e6
const move: Candle[] = [[t0, 766, 766, 766, 766, 0], [t0 + 60, 766, 773.66, 766, 773.66, 0]];
const b = replay(pool, full, move, sched, [[t0 * 1000 - 1, 766], [t0 * 1000 + 30e3, 773.66]]);
const want = (Math.log(773.66 / 766) ** 2 * 4 * L * Math.sqrt(773.66e-2)) / 4 / 1e6;
assert.ok(Math.abs(b.bySession.regular.lvrUsd - want) / want < 1e-9);

// pool candles bouncing ±50bp do NOT create LVR when the fair price is flat
const noisy: Candle[] = Array.from({ length: 10 }, (_, i) => [t0 + 60 * i, 0, 0, 0, 766 * (1 + (i % 2) * 0.005), 1000]);
assert.equal(replay(pool, full, noisy, sched, [[t0 * 1000 - 1, 766]]).bySession.regular.lvrUsd, 0);


// splice: a 60-minute hole in the stock path is filled with the proxy's returns, then snaps back
const m = 60e3;
const sp = splice([[0, 100], [60 * m, 103]], [[-5 * m, 5000], [10 * m, 5050], [30 * m, 5100], [70 * m, 5200]]);
assert.deepEqual(sp, [[0, 100], [10 * m, 101], [30 * m, 102], [60 * m, 103]]);
assert.deepEqual(splice([[0, 1], [5 * m, 2]], [[m, 9]]), [[0, 1], [5 * m, 2]]); // no gap, nothing inserted

// despike drops the 17 Sep 16:15 bad print, keeps a real move that does not revert
assert.deepEqual(despike([[0, 762.43], [1, 754.0727], [2, 762.16], [3, 762.2]]), [[0, 762.43], [2, 762.16], [3, 762.2]]);
assert.equal(despike([[0, 100], [1, 101], [2, 101.1]]).length, 3);

const ci = bootstrap([1, 2, 3, 4, 5]);
assert.equal(ci.meanDaily, 3);
assert.ok(ci.lo >= 1 && ci.hi <= 5 && ci.lo < 3 && ci.hi > 3);

console.log("sewa ok");
