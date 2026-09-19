import assert from "node:assert/strict";
import { inSchedule, sessionAt, type Schedule } from "./pyth.ts";
import { bp, multiplierAt, pendingDividend, price, statusOf, whtOf } from "./fairprice.ts";

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

// SPY went ex $1.889 on 18 Sep; xStocks' last SPYx CA is 18 Jun -> dividend still pending on 19 Sep
const ex = Date.UTC(2026, 8, 18, 13, 30);
const cas = [{ symbol: "SPYx", type: "CashDividend", effective: Date.UTC(2026, 5, 18, 3, 45), gross: 1.903516, net: 1.3324612, wht: 0.3 }];
const now = Date.UTC(2026, 8, 19, 5);
assert.deepEqual(pendingDividend([{ exDate: ex, amount: 1.889 }], cas, now), { exDate: ex, amount: 1.889 });
// once the issuer posts the September CA it is no longer pending
assert.equal(pendingDividend([{ exDate: ex, amount: 1.889 }], [...cas, { ...cas[0], effective: ex + 36e5 }], now), undefined);
// a future ex-date is not pending yet
assert.equal(pendingDividend([{ exDate: now + 864e5, amount: 1 }], cas, now), undefined);
assert.equal(whtOf(cas), 0.3);

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

console.log("fairprice ok");
