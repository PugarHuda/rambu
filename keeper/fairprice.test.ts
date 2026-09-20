import assert from "node:assert/strict";
import { inSchedule, lastClose, proPx, pythTicker, sessionAt, type Schedule } from "./pyth.ts";
import { bp, exDateOf, fairPrice, isStale, multiplierAt, parseCAs, pendingDividend, price, splitPending, statusOf, structuralCA, whtOf } from "./fairprice.ts";

// Pyth's real SPY session calendar (pyth.dourolabs.app/v1/symbols, 19 Sep 2026)
const SPY: Schedule = {
  regular: "America/New_York;0930-1600,0930-1600,0930-1600,0930-1600,0930-1600,C,C;0907/C,1126/C,1127/0930-1300,1224/0930-1300,1225/C",
  pre: "America/New_York;0400-0930,0400-0930,0400-0930,0400-0930,0400-0930,C,C;0907/C,1126/C,1225/C",
  post: "America/New_York;1600-2000,1600-2000,1600-2000,1600-2000,1600-2000,C,C;0907/C,1126/C,1127/1300-1700,1224/1300-1700,1225/C",
  overnight: "America/New_York;0000-0400&2000-2400,0000-0400&2000-2400,0000-0400&2000-2400,0000-0400&2000-2400,0000-0400,C,2000-2400;0906/C,0907/2000-2400",
};
const et = (iso: string) => Date.parse(iso); // pass explicit offsets
assert.equal(sessionAt(SPY, et("2026-09-18T10:00:00-04:00")), "regular"); // Fri 10:00 ET
assert.equal(sessionAt(SPY, et("2026-09-18T08:00:00-04:00")), "pre");
assert.equal(sessionAt(SPY, et("2026-09-18T17:00:00-04:00")), "post");
assert.equal(sessionAt(SPY, et("2026-09-17T23:00:00-04:00")), "overnight"); // Thu night
assert.equal(sessionAt(SPY, et("2026-09-18T21:00:00-04:00")), "closed"); // Fri night: no overnight into the weekend
assert.equal(sessionAt(SPY, et("2026-09-19T12:00:00-04:00")), "closed"); // Saturday
assert.equal(sessionAt(SPY, et("2026-09-20T21:00:00-04:00")), "overnight"); // Sunday evening reopens
assert.equal(sessionAt(SPY, et("2026-09-07T10:00:00-04:00")), "closed"); // Labor Day holiday override
assert.equal(inSchedule(SPY.regular, et("2026-11-27T12:59:00-05:00")), true); // early close day
assert.equal(inSchedule(SPY.regular, et("2026-11-27T13:00:00-05:00")), false);

// Token-2022 ScaledUiAmount clock switch
const mint = { multiplier: 1.003909240011759, newMultiplier: 1.005714560286254, effective: Date.UTC(2026, 5, 18, 4), paused: false };
assert.equal(multiplierAt(mint, Date.UTC(2026, 5, 18, 3)), mint.multiplier);
assert.equal(multiplierAt(mint, Date.UTC(2026, 8, 19)), mint.newMultiplier);

// Yahoo stamps SPY's ex-date at the 09:30 ET open (1789738200 = 18 Sep 13:30Z); it goes ex at 20:00 ET the evening before
const ex = exDateOf(1789738200);
assert.equal(ex, et("2026-09-17T20:00:00-04:00"));
assert.equal(exDateOf(1766154600), et("2025-12-18T20:00:00-05:00")); // winter print (19 Dec 2025 14:30Z) lands on 20:00 EST too

// SPY went ex $1.889 on 18 Sep; xStocks' last SPYx CA and the mint's last step are 18 Jun -> dividend still pending
const ca0 = { fromUnits: null, toUnits: null, multiplierNew: null };
const cas = [{ symbol: "SPYx", type: "CashDividend", effective: Date.UTC(2026, 5, 18, 3, 45), gross: 1.903516, net: 1.3324612, wht: 0.3, ...ca0 }];
const now = Date.UTC(2026, 8, 19, 5);
const spyDiv = { exDate: ex, amount: 1.889 };
assert.deepEqual(pendingDividend([spyDiv], cas, now, mint), spyDiv);
assert.deepEqual(pendingDividend([spyDiv], cas, et("2026-09-18T08:00:00-04:00"), mint), spyDiv); // already pending in Friday pre-market
assert.equal(pendingDividend([spyDiv], cas, et("2026-09-17T19:00:00-04:00"), mint), undefined); // Thu post-market is still cum
// once the issuer posts the September CA it is no longer pending
assert.equal(pendingDividend([spyDiv], [...cas, { ...cas[0], effective: ex + 36e5 }], now), undefined);
// a CA scheduled after now has not stepped the multiplier yet
assert.deepEqual(pendingDividend([spyDiv], [...cas, { ...cas[0], effective: now + 36e5 }], now), spyDiv);
// a future ex-date is not pending yet
assert.equal(pendingDividend([{ exDate: now + 864e5, amount: 1 }], cas, now), undefined);
assert.equal(whtOf(cas), 0.3);

// AAPLx: mint stepped Sat 8 Aug 00:30Z (1.0026642 -> 1.0032690) for AAPL ex Mon 10 Aug ($0.27): applied, not pending
const aaplMint = { multiplier: 1.0026642075893797, newMultiplier: 1.0032690125398187, effective: Date.parse("2026-08-08T00:30:00Z"), paused: false };
const aaplDiv = { exDate: exDateOf(Date.parse("2026-08-10T13:30:00Z") / 1000), amount: 0.27 };
assert.equal(pendingDividend([aaplDiv], [], Date.parse("2026-08-11T15:00:00Z"), aaplMint), undefined);
// METAx: mint stepped Sat 19 Sep 00:30Z (1.0022983 -> 1.0028515) ahead of META ex Mon 21 Sep ($0.525): not pending then
const metaMint = { multiplier: 1.002298265651938, newMultiplier: 1.0028515433272898, effective: Date.parse("2026-09-19T00:30:00Z"), paused: false };
const metaDiv = { exDate: exDateOf(Date.parse("2026-09-21T13:30:00Z") / 1000), amount: 0.525 };
assert.equal(pendingDividend([metaDiv], [], Date.parse("2026-09-21T15:00:00Z"), metaMint), undefined);
// same via the issuer CA alone (xStocks METAx CashDividend effective 19 Sep 00:30Z), the old 2-day window double-counted it
const metaCA = { symbol: "METAx", type: "CashDividend", effective: Date.parse("2026-09-19T00:30:00Z"), gross: 0.525, net: 0.3675, wht: 0.3, ...ca0 };
assert.equal(pendingDividend([metaDiv], [metaCA], Date.parse("2026-09-21T15:00:00Z")), undefined);
// Ondo SPYon has no xStocks CA feed; its mint stepped to 1.0094730727840426 at 2026-09-18T17:54:15Z -> SPY dividend applied
const spyon = { multiplier: 1.0094730727840426, newMultiplier: 1.0094730727840426, effective: 1789754055 * 1000, paused: false };
assert.equal(pendingDividend([spyDiv], [], now, spyon), undefined);

// Real xStocks CA rows: SCCOx event cancelled in its latest version, BITXx cancelled with no date, APHx 1:2 split
const nodes = [
  { eventId: "ed857d4c", version: 4, xstockSymbol: "SCCOx", caType: "StockDividend", effectiveTimeUtc: "2026-08-12T00:30:00.000Z", status: "Scheduled" },
  { eventId: "ed857d4c", version: 6, xstockSymbol: "SCCOx", caType: "StockDividend", effectiveTimeUtc: null, status: "Cancelled" },
  { eventId: "4b30c0da", version: 4, xstockSymbol: "BITXx", caType: "CashDividend", effectiveTimeUtc: null, grossCashflowUsd: "0.0127", status: "Cancelled" },
  { eventId: "9f076793", version: 1, xstockSymbol: "APHx", caType: "ForwardSplit", effectiveTimeUtc: "2026-09-03T08:45:00.000Z", fromUnits: "1", toUnits: "2", status: "Scheduled" },
  { eventId: "be483bd5", version: 1, xstockSymbol: "APHx", caType: "CashDividend", effectiveTimeUtc: "2026-09-22T00:30:00.000Z", grossCashflowUsd: "0.125", netCashflowUsd: "0.0875", withholdingTaxRate: "0.3", status: "Scheduled" },
  { eventId: "undated", version: 1, xstockSymbol: "APHx", caType: "CashDividend", effectiveTimeUtc: null, withholdingTaxRate: "0.15", status: "Scheduled" },
  { eventId: "ca3da1bc", version: 1, xstockSymbol: "HONx", caType: "SpinOff", effectiveTimeUtc: "2026-06-29T23:55:00.000Z", withholdingTaxRate: "0", status: "Scheduled" },
];
const parsed = parseCAs(nodes);
assert.deepEqual(parsed.map((c) => c.symbol + ":" + c.type), ["APHx:ForwardSplit", "APHx:CashDividend", "HONx:SpinOff"]);
assert.deepEqual([parsed[0].fromUnits, parsed[0].toUnits], [1, 2]);
assert.equal(whtOf(parsed), 0.3); // spin-off's 0% never becomes the dividend rate
assert.equal(whtOf(parseCAs([...nodes].reverse())), whtOf(parsed)); // order-independent
assert.equal(structuralCA(parsed, Date.parse("2026-06-30T12:00:00Z"))?.type, "SpinOff");
assert.equal(structuralCA(parsed, Date.parse("2026-09-19T12:00:00Z")), undefined);

// APHx 2:1 split: CA effective 3 Sep 08:45Z, Yahoo split 3 Sep 13:30Z, mint 1 -> 2 at 08:45Z; pre-market APH ~81.8
const aphSplits = [{ at: Date.parse("2026-09-03T13:30:00Z"), ratio: 2 }];
const aphMint = { multiplier: 1, newMultiplier: 2, effective: Date.parse("2026-09-03T08:45:00Z"), paused: false };
const pre = Date.parse("2026-09-03T12:00:00Z"); // 08:00 ET pre-market, after the step
assert.equal(splitPending(aphSplits, parsed, aphMint, pre), undefined);
assert.ok(splitPending(aphSplits, parsed, aphMint, Date.parse("2026-09-03T08:00:00Z"))); // step scheduled but not yet live
const unstepped = { multiplier: 1, newMultiplier: 1, effective: 0, paused: false };
assert.ok(splitPending(aphSplits, [], unstepped, pre)); // Yahoo alone catches it
assert.ok(splitPending([], parsed, unstepped, pre)); // issuer CA alone catches it
assert.equal(splitPending(aphSplits, parsed, unstepped, Date.parse("2026-09-10T12:00:00Z")), undefined); // outside the window
const good = price(81.8, multiplierAt(aphMint, pre)), bad = price(81.8, multiplierAt(unstepped, pre));
assert.ok(Math.abs(good.fairRaw - 163.6) < 1e-9);
const splitErr = bp(good.fairRaw, bad.fairRaw)!; // what the xStock market (priced post-split x2) says vs an unstepped fair
const s = { issuerHalted: false, paused: false, px: { stale: false, price: 81.8, conf: 0.01 }, pending: false, session: "pre" as const };
assert.deepEqual(statusOf({ ...s, split: true, dexErrBp: splitErr }), { status: "CorpActionPending", haltCode: "SPLT", reasons: ["split pending, multiplier not stepped"] });
assert.equal(statusOf({ ...s, dexErrBp: splitErr }).reasons[0], "fair vs market diverged"); // split feed missed: sanity check still trips
assert.equal(statusOf({ ...s, dexErrBp: splitErr }).status, "Stale");
assert.equal(statusOf({ ...s, structural: "SpinOff" }).status, "Halted");

// Today's numbers: close 761.69, m 1.0057146, net dividend 1.889 * 0.7
const p = price(761.69, mint.newMultiplier, { net: 1.889 * 0.7 });
assert.ok(Math.abs(p.naiveRaw - 766.04) < 0.01);
assert.ok(Math.abs(p.fairRaw - 767.37) < 0.01);
// Chainlink via Jupiter Lend vault 78 read 767.3125 at the same time: within 1bp of fair, naive is 17bp low
assert.ok(Math.abs(bp(767.312488, p.fairRaw)!) < 1);
assert.ok(bp(p.naiveRaw, p.fairRaw)! < -17);

assert.equal(statusOf({ issuerHalted: true, paused: false, px: { stale: false }, pending: true, session: "regular" }).status, "Halted");
assert.equal(statusOf({ issuerHalted: false, paused: false, px: { stale: true }, pending: false, session: "regular" }).status, "Stale");
assert.equal(statusOf({ issuerHalted: false, paused: false, px: { stale: false }, pending: true, session: "closed" }).status, "CorpActionPending");
assert.equal(statusOf({ issuerHalted: false, paused: false, px: { stale: false }, pending: false, session: "closed" }).status, "Closed");
assert.equal(statusOf({ issuerHalted: false, paused: false, px: { stale: false }, pending: false, session: "closed", caDown: true }).reasons[0], "dividend source down");

// Pyth Pro latest_price for QQQ (lazer 1363), Sat 19 Sep 2026: last print Fri 19:59:59.95 ET, 6 publishers, session closed
const qqq = proPx({ priceFeedId: 1363, price: "72206567", bestBidPrice: "72205000", bestAskPrice: "72208000", publisherCount: 6, exponent: -5, confidence: 17696, marketSession: "closed", feedUpdateTimestamp: 1789775999950000 });
assert.deepEqual([qqq.price, qqq.publishers, qqq.session, qqq.bid, qqq.ask], [722.06567, 6, "closed", 722.05, 722.08]);
const sat = Date.parse("2026-09-19T15:21:00Z");
assert.equal(lastClose(SPY, sat), et("2026-09-18T20:00:00-04:00"));
assert.equal(lastClose(SPY, et("2026-09-18T10:00:00-04:00")), et("2026-09-18T10:00:00-04:00")); // open: now
assert.equal(isStale(qqq.publishTime, "closed", SPY, sat), false); // the closing print holds all weekend
assert.equal(isStale(et("2026-09-18T15:00:00-04:00"), "closed", SPY, sat), true); // a feed that died Friday afternoon does not
assert.equal(statusOf({ issuerHalted: false, paused: false, px: { ...qqq, stale: false }, pending: false, session: "closed" }).status, "Closed");
assert.equal(statusOf({ issuerHalted: false, paused: false, px: { ...qqq, publishers: 2, stale: false }, pending: false, session: "regular" }).reasons[0], "low publishers");
assert.equal(statusOf({ issuerHalted: false, paused: false, px: { ...qqq, conf: qqq.price * 0.006, stale: false }, pending: false, session: "regular" }).reasons[0], "wide confidence");
// xstocks-mark aged by its own updatedAt: 10 minutes old in the regular session is stale
const fri = et("2026-09-18T11:00:00-04:00");
assert.equal(isStale(fri - 10 * 60e3, "regular", SPY, fri), true);
assert.equal(isStale(fri - 30e3, "regular", SPY, fri), false);

assert.equal(pythTicker("BRK.B"), "BRK-B");
assert.equal("Equity.US.BRK-B/USD".slice("Equity.US.".length).split("/")[0], "BRK-B");

// Live: the Jupiter Lend endpoint failing must not take FairPrice down, only its Chainlink column.
const realFetch = globalThis.fetch;
globalThis.fetch = (async (u: any, i?: any) => (String(u).includes("/lend/") ? Promise.reject(new Error("lend down")) : realFetch(u, i))) as typeof fetch;
try {
  const f = await fairPrice({ symbol: "SPYx", underlying: "SPY", mint: "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W", issuerHalted: false, period: "" });
  assert.equal(f.chainlinkRaw, null);
  assert.ok(f.mOnchain > 1);
} finally {
  globalThis.fetch = realFetch;
}

console.log("fairprice ok");
