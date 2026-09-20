import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  bootstrap, crossPath, despike, dividendOwed, feeInside, fpOf, multiplierSteps, positionEvents, positionHistory, pTrade, pythBars, replay, splice, stepLoss, tickOf, tradingDay,
  type Candle, type Pool,
} from "./sewa.ts";

// Pool 4pCZ read on 19 Sep: tick 20363 at 766.1623 USD per SPYx raw (dec 8/6)
assert.equal(tickOf(766.1623 * 1e-2), 20363);

const pool: Pool = { id: "x", mint0: "a", mint1: "b", dec0: 8, dec1: 6, tickSpacing: 1, liquidity: 0, tick: 0, feeRate: 0.0001, protocolCut: 0.16 };
const always = "America/New_York;O,O,O,O,O,O,O;";
const sched = { regular: always, pre: "", post: "", overnight: "" };
const L = 1e13;
const full = [{ nft: "p1", lower: -400000, upper: 400000, liquidity: L }, { nft: "p2", lower: -400000, upper: 400000, liquidity: 3 * L }, { nft: "far", lower: 30000, upper: 30010, liquidity: L }];
const t0 = Date.UTC(2026, 8, 14, 15) / 1000;
const rel = (a: number, b: number) => Math.abs(a / b - 1);

// flat price: no LVR, fees = vol * 1bp * 84%, split 1:3, out-of-range position gets nothing
const flat: Candle[] = [0, 1, 2].map((i) => [t0 + 60 * i, 766, 766, 766, 766, 10_000]);
const a = replay(pool, full, flat, sched, [[t0 * 1000 - 1, 766]]);
assert.ok(Math.abs(a.bySession.regular.feesUsd - 3 * 10_000 * 0.0001 * 0.84) < 1e-9);
assert.equal(a.bySession.regular.lvrUsd, 0);
const p1 = a.top.find((p) => p.nft === "p1")!, far = a.top.find((p) => p.nft === "far")!;
assert.ok(Math.abs(p1.feesUsd - a.bySession.regular.feesUsd / 4) < 1e-9);
assert.equal(far.feesUsd, 0);
assert.equal(far.inRangePct, 0);

// one +1% step in the FAIR price: exact in-range loss L(sqrtP1 - sqrtP0)^2/sqrtP0 on the 4L in range, ≈ r^2 L sqrtP / 4
const move: Candle[] = [[t0, 766, 766, 766, 766, 0], [t0 + 60, 766, 773.66, 766, 773.66, 0]];
const b = replay(pool, full, move, sched, [[t0 * 1000 - 1, 766], [t0 * 1000 + 30e3, 773.66]]);
const s0 = Math.sqrt(766e-2), s1 = Math.sqrt(773.66e-2);
assert.ok(rel(b.bySession.regular.lvrUsd, (4 * L * (s1 - s0) ** 2) / s0 / 1e6) < 1e-9);
assert.ok(rel(b.bySession.regular.lvrUsd, (Math.log(773.66 / 766) ** 2 * 4 * L * s1) / 4 / 1e6) < 1e-4);
assert.equal(b.bounds.lvrTodayL, b.bounds.lvrOpenGated); // no history -> both bounds agree

// pool candles bouncing ±50bp do NOT create LVR when the fair price is flat
const noisy: Candle[] = Array.from({ length: 10 }, (_, i) => [t0 + 60 * i, 0, 0, 0, 766 * (1 + (i % 2) * 0.005), 1000]);
assert.equal(replay(pool, full, noisy, sched, [[t0 * 1000 - 1, 766]]).bySession.regular.lvrUsd, 0);

// a position opened at t0+60 gets no fees or LVR from the first candle (or the step inside it); openGated < todayL
const late = [{ nft: "late", lower: -400000, upper: 400000, liquidity: L, steps: [[(t0 + 60) * 1000, L]] as [number, number][] }];
const c = replay(pool, late, [[t0, 766, 766, 766, 766, 10_000]], sched, [[t0 * 1000 - 1, 766], [t0 * 1000, 773.66]]);
assert.equal(c.top[0].feesUsd, 0);
assert.equal(c.top[0].lvrUsd, 0);
assert.ok(c.top[0].lvrTodayL > 0 && c.bounds.lvrOpenGated === 0 && c.bySession.regular.feesUsd > 0);
const c2 = replay(pool, late, [[t0, 766, 766, 766, 766, 10_000], [t0 + 60, 766, 766, 766, 766, 10_000]], sched, [[t0 * 1000 - 1, 766]]);
assert.ok(Math.abs(c2.top[0].feesUsd - 10_000 * 0.0001 * 0.84) < 1e-9); // second minute: alive, gets all of it

// a step after a >60 min gap is booked to "reopen", not to the session it lands in
const gap = replay(pool, full, [[t0 + 7200, 766, 766, 766, 766, 0]], sched, [[t0 * 1000, 766], [(t0 + 7200) * 1000, 773.66]]);
assert.ok(gap.bySession.reopen.lvrUsd > 0 && gap.bySession.regular.lvrUsd === 0);

// a step is booked to the session its bar ran in: the Friday 19:59 ET bar closes at 20:00 ET (= "closed"), still post
{
  const post = { regular: "", pre: "", overnight: "", post: "America/New_York;1600-2000,1600-2000,1600-2000,1600-2000,1600-2000,C,C;" };
  const T = Date.UTC(2026, 8, 19); // Sat 00:00Z = Fri 20:00 ET
  const f = replay(pool, full, [[T / 1000, 766, 766, 766, 766, 0]], post, [[T - 60e3, 766], [T, 773.66]]);
  assert.ok(f.bySession.post.lvrUsd > 0 && f.bySession.closed.lvrUsd === 0);
}

// stepLoss: in range ≈ r^2 L sqrtP1 / 4 for r = 1bp; below range on both ends = 0; a jump through the range is the
// edge-to-edge loss plus the linear overshoot of the (all token0) reserves past the upper edge.
{
  const P0 = 7.66, P1 = P0 * Math.exp(1e-4), Lx = 1e12;
  assert.ok(rel(stepLoss(Lx, -1000, 40000, P0, P1), (1e-8 * Lx * Math.sqrt(P1)) / 4) < 1e-6);
  assert.equal(stepLoss(Lx, 20000, 21000, 1.0001 ** 19000, 1.0001 ** 19500), 0);
  const pa = 1.0001 ** 20000, pb = 1.0001 ** 20100, x0 = Lx * (1 / Math.sqrt(pa) - 1 / Math.sqrt(pb));
  const through = stepLoss(Lx, 20000, 20100, pa * 0.9, pb * 1.1);
  assert.ok(rel(through, stepLoss(Lx, 20000, 20100, pa, pb) + (pb * 1.1 - pb) * x0) < 1e-9);
  assert.ok(stepLoss(Lx, 20000, 20100, pb * 1.1, pa * 0.9) > 0); // loss is never negative, either direction
}

// MMR trade probability: no fee -> every block; strictly falling in the fee
assert.equal(pTrade(1e-4, 0, 0.4), 1);
assert.ok(pTrade(1e-4, 1e-4, 0.4) > pTrade(1e-4, 1e-3, 0.4) && pTrade(1e-4, 1e-3, 0.4) > pTrade(1e-4, 1e-2, 0.4));

// splice: a 60-minute hole in the stock path is filled with the proxy's returns, then snaps back
const m = 60e3;
const sp = splice([[0, 100], [60 * m, 103]], [[-5 * m, 5000], [10 * m, 5050], [30 * m, 5100], [70 * m, 5200]]);
assert.deepEqual(sp, [[0, 100], [10 * m, 101], [30 * m, 102], [60 * m, 103]]);
assert.deepEqual(splice([[0, 1], [5 * m, 2]], [[m, 9]]), [[0, 1], [5 * m, 2]]); // no gap, nothing inserted
// 3 levels: futures cover 10-30m then stop (their weekend); the perp fills 30m..120m, chained onto the futures' last point
const es: [number, number][] = [[-m, 5000], [10 * m, 5050], [30 * m, 5100]];
const perp: [number, number][] = [[20 * m, 200], [30 * m, 200], [50 * m, 204], [90 * m, 206]];
assert.deepEqual(splice(splice([[0, 100], [120 * m, 104]], es), perp).map(([t, px]) => [t, +px.toFixed(9)]), [[0, 100], [10 * m, 101], [30 * m, 102], [50 * m, 104.04], [90 * m, 105.06], [120 * m, 104]]);

// despike drops the 17 Sep 16:15 bad print, keeps a real move that does not revert
assert.deepEqual(despike([[0, 762.43], [1, 754.0727], [2, 762.16], [3, 762.2]]), [[0, 762.43], [2, 762.16], [3, 762.2]]);
assert.equal(despike([[0, 100], [1, 101], [2, 101.1]]).length, 3);

// Pyth Pro QQQ minute bars (real response, 17 Sep 13:00-19:00 UTC): stamped at bar close, no weekday gap > 10 min
const qqq = pythBars(JSON.parse(readFileSync(new URL("fixtures/pyth-qqq-1m.json", import.meta.url), "utf8")));
assert.equal(qqq.length, 360);
assert.equal(qqq[0][0], Date.UTC(2026, 8, 17, 13, 1));
for (let i = 1; i < qqq.length; i++) {
  const dow = new Date(qqq[i - 1][0]).getUTCDay();
  if (dow >= 1 && dow <= 5) assert.ok(qqq[i][0] - qqq[i - 1][0] <= 10 * m, `gap at ${new Date(qqq[i - 1][0]).toISOString()}`);
  assert.ok(qqq[i][1] > 500 && qqq[i][1] < 1000);
}

// SPYx multiplier steps from api.xstocks.fi corporate-actions/history (real nodes; a stale lower version is ignored)
const node = (eventId: string, version: number, eff: string, o: string, n: string) => ({ eventId, version, xstockSymbol: "SPYx", caType: "CashDividend", effectiveTimeUtc: eff, multiplierOld: o, multiplierNew: n, netCashflowUsd: null, grossCashflowUsd: null, withholdingTaxRate: "0.3" });
const spyx = multiplierSteps([
  node("aeb368f9", 2, "2026-06-18T04:00:00.000Z", "1.003909240011759", "1.005714560286254"),
  node("604ecc95", 1, "2025-10-31T23:55:00.000Z", "1", "1.00099942056"),
  node("83999b87", 2, "2026-05-01T00:15:00.000Z", "1.002560758222989779", "1.003909240011759"),
  node("83999b87", 1, "2026-05-01T00:15:00.000Z", "1.002560758222989779", "1.0039"),
  node("c577c497", 1, "2026-01-30T23:55:00.000Z", "1.00099942056", "1.002560758222989779"),
  { ...node("x", 9, "2026-07-01T00:00:00.000Z", "1", "2"), xstockSymbol: "QQQx" },
], "SPYx");
assert.deepEqual(spyx.map((s) => s[0]), [0, Date.parse("2025-10-31T23:55:00Z"), Date.parse("2026-01-30T23:55:00Z"), Date.parse("2026-05-01T00:15:00Z"), Date.parse("2026-06-18T04:00:00Z")]);
assert.deepEqual(spyx.map((s) => +s[1].toFixed(6)), [1, 1.000999, 1.002561, 1.003909, 1.005715]);

// dividend owed from the ex-date until the issuer steps the multiplier for it
const div = [{ exDate: Date.UTC(2026, 8, 18, 13, 30), amount: 1.8 }];
assert.equal(dividendOwed(div, spyx, 0.3, Date.UTC(2026, 8, 18, 13)), 0);
assert.ok(Math.abs(dividendOwed(div, spyx, 0.3, Date.UTC(2026, 8, 19)) - 1.26) < 1e-12);
assert.equal(dividendOwed(div, [...spyx, [Date.UTC(2026, 8, 19, 23), 1.0075]], 0.3, Date.UTC(2026, 8, 20)), 0);

// xStock/SOL: SOL USD / xStock USD, xStock forward-filled over SOL's weekend minutes, q carries the xStock USD
assert.deepEqual(crossPath([[10, 700]], [[5, 140], [10, 140], [20, 147]]), [[10, 0.2, 700], [20, 0.21, 700]]);

// Raydium CLMM events for position 16B3Wh… in pool 4pCZ (real logs): Create + 2 Increase = its onchain L today
const hex = (h: string, len: number) => { const b = Buffer.alloc(len); Buffer.from(h, "hex").copy(b); return b.toString("base64"); };
const create = hex("641e57f9c4df9ace38aa6c9b2a8feb25fdf31f0807f1e4ff326c2e1ef80be34e2b272b2ef045e2e6d494b01972735f98ea6723866661a0447039961e6d60f582f312287d765ad02cd494b01972735f98ea6723866661a0447039961e6d60f582f312287d765ad02ca04c0000bd500000f354b6090000000000000000000000000e2c0f00000000008d8ef0000000000000000000", 160);
const incA = hex("314f69d420221e5429ad07c33f17fe50f961fc4bff28e31a2fd0d3002803698d736f989bb789a56614612f0a000000000000000000000000f97c0f0000000000107fff", 88);
const incB = hex("314f69d420221e5429ad07c33f17fe50f961fc4bff28e31a2fd0d3002803698d736f989bb789a5669327a813000000000000000000000000434d1e000000000032f7e901", 88);
const { getAddressDecoder } = await import("@solana/kit");
const nft = getAddressDecoder().decode(Buffer.from("29ad07c33f17fe50f961fc4bff28e31a2fd0d3002803698d736f989bb789a566", "hex"));
const pos16 = { nft, lower: 19616, upper: 20669 };
const ev = [create, incA, incB].map((d) => positionEvents(["Program log: x", `Program data: ${d}`], "4pCZCVEiYyT4efNdXUdL2tJF8VGMgiMXrZWq6FiNXhRw", pos16));
assert.equal(ev[0].create! + ev[1].delta + ev[2].delta, 663608730n);
assert.equal(positionEvents([`Program data: ${create}`], "6truu3rZuiB9rKQg4VYC3Dt3QwV7DgwGqXrYUcrvnDDE", pos16).create, undefined); // other pool
assert.equal(positionEvents([`Program data: ${incA}`], "4pCZCVEiYyT4efNdXUdL2tJF8VGMgiMXrZWq6FiNXhRw", { ...pos16, nft: "11111111111111111111111111111111" }).delta, 0n);

// fee growth inside, u128 wrap-around: current tick in range -> global - outside(lower) - outside(upper) mod 2^128
assert.equal(feeInside(5n, 10n, 1n, 100, 50, 150), (1n << 128n) - 6n);
assert.equal(feeInside(100n, 30n, 20n, 200, 50, 150), 100n - 30n - (100n - 20n) + (1n << 128n)); // above range: g - lo - (g - hi) wraps
assert.equal(feeInside(100n, 30n, 20n, 100, 50, 150), 50n);

// New York trading date: 20:00 ET belongs to the next day
assert.equal(tradingDay(Date.UTC(2026, 8, 19, 0, 0)), "2026-09-19"); // Fri 20:00 ET belongs to the next calendar date
assert.equal(tradingDay(Date.UTC(2026, 8, 18, 23, 59)), "2026-09-18"); // Fri 19:59 ET, post session

// week-block bootstrap: one huge day among otherwise negative days is not a pass
const bad = Array.from({ length: 20 }, (_, i) => [new Date(Date.UTC(2026, 7, 3 + i + Math.floor(i / 5) * 2)).toISOString().slice(0, 10), -10] as [string, number]);
bad.push(["2026-09-01", 1000]);
const g = bootstrap(bad);
assert.ok(g.meanDaily > 0 && !g.robust && g.loExBest < 0);
const good = bootstrap(Array.from({ length: 15 }, (_, i) => [new Date(Date.UTC(2026, 7, 3 + i)).toISOString().slice(0, 10), 5 + (i % 3)]));
assert.ok(good.robust && good.lo > 0 && good.lo <= good.meanDaily && good.hi >= good.meanDaily);
assert.equal(bootstrap([]).robust, false);

// positionHistory: an unchanged position account (same L, fee growth, owed) is reused from the cache without any RPC
{
  const ph = { nft, pda: "pda1", lower: 0, upper: 1, liquidity: 5, raw: { liq: 5n, fg0: 1n, fg1: 2n, owed0: 0n, owed1: 0n } };
  const hit = { lastSig: "s", openedAt: 1, steps: [[1, 5]] as [number, number][], decreases: 0, ok: false, fp: fpOf(ph), owner: "o" };
  assert.equal((await positionHistory(pool, [ph], { pda1: hit }, 0)).pda1, hit);
}

console.log("sewa ok");
