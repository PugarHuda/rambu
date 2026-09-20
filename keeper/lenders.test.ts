import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chainlinkX, countDeposits, decodeReserve, effectiveLeg, flagsOf, lagOf, lastChange, multiplierUpdates, scopeView } from "./lenders.ts";

// Real Kamino SPYx reserve UvXjBuC7... (xStocks market), captured 19 Sep 2026
const res = readFileSync(new URL("fixtures/kamino-spyx.bin", import.meta.url));
const r = decodeReserve(res, "SPYx", 0.73);
assert.equal(r.scopeFeed, "3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH");
assert.deepEqual(r.chain, [344]);
assert.equal(r.maxAgeS, 300);
assert.equal(r.lt, 0.75);
// the name guard trips when the layout shifts by one byte, before any wrong price is read
assert.throws(() => decodeReserve(Buffer.concat([Buffer.alloc(1), res]), "SPYx"), /layout drifted/);
assert.throws(() => decodeReserve(res, "SPYx", 0.7), /LTV/);

// Real Scope OraclePrices + OracleMappings entries #278..#344 from the same slot
const s = readFileSync(new URL("fixtures/scope-slice.bin", import.meta.url));
const base = s.readUInt16LE(0), n = s.readUInt16LE(2);
const at = scopeView(s.subarray(4, 4 + 56 * n), s.subarray(4 + 56 * n, 4 + 57 * n), s.subarray(4 + 57 * n, 4 + 77 * n), base);
assert.equal(at(344).type, 33); // CappedFloored(source #343, cap #278, floor #278)
assert.equal(at(343).type, 28); // MostRecentOf(#278, #342)
const leg = effectiveLeg(at, 344);
assert.equal(leg.i, 278);
assert.equal(leg.type, 37); // ChainlinkX
assert.ok(Math.abs(leg.value - 765.967) < 1e-3, `${leg.value}`);
assert.equal(at(344).value, leg.value); // what Kamino stores is the pinned leg's value
// MostRecentOf resolves to the source whose value it copied
assert.equal(effectiveLeg(at, 343).value, at(343).value);
const cl = chainlinkX(leg)!;
assert.equal(cl.suspended, false);
assert.equal(cl.activation, 0);
assert.throws(() => at(100), /outside slice/);

// Issuer lag: SPYx has not stepped since 18 Jun for the 18 Sep ex-date; SPYon stepped the same afternoon
const ex = Date.UTC(2026, 8, 18, 13, 30), now = Date.UTC(2026, 8, 19, 15, 20);
assert.deepEqual(lagOf(ex, Date.UTC(2026, 5, 18, 4), now), { stepped: false, lagDays: 1 });
assert.deepEqual(lagOf(ex, Date.UTC(2026, 8, 18, 17, 54), now), { stepped: true, lagDays: 0 });
assert.equal(lagOf(ex, Date.UTC(2026, 5, 18, 4), now + 5 * 864e5).lagDays, 6); // keeps growing
assert.equal(lagOf(Date.UTC(2026, 7, 10, 13, 30), Date.UTC(2026, 7, 8, 0, 30), Date.UTC(2026, 7, 12)).stepped, true); // Saturday step, Monday ex
assert.equal(lagOf(ex, 0, now + 40 * 864e5).lagDays, null); // outside the 30-day window

// Flags
const spyx: any = { status: "CorpActionPending", pendingDiv: { exDate: ex, amount: 1.889, net: 1.3223, wht: 0.3 } };
assert.deepEqual(flagsOf(spyx, { errBp: -18.3, suspended: false, ageS: 20, maxAgeS: 300 }, false), ["should suspend", "dividend ex, lenders not suspended"]);
assert.deepEqual(flagsOf(spyx, { errBp: -0.8, suspended: false, ageS: 8, maxAgeS: null }, false), []); // Jupiter already right: no harm flag
assert.deepEqual(flagsOf({ status: "Open", pendingDiv: null } as any, { errBp: 2, suspended: true, ageS: 999, maxAgeS: 300 }, true), ["safe to resume", "oracle older than lender max age"]);
assert.deepEqual(flagsOf({ status: "Open", pendingDiv: null } as any, { errBp: 25, suspended: true, ageS: 1, maxAgeS: 300 }, true), []);
// Ondo batch 5uTBPPf8oP5s.. (18 Sep 17:54:18): the same stamp on SPYon (changed) and TSLAon (1 -> 1, no dividend)
const T = 1789754055, spyOn = "k18WJUULWheRkSpSquYGdNNmtuE2Vbw1hpuUi92ondo", tslaOn = "ZDnkXeN5awDioQjP691XFLdgZwDAv19g3fCr9KWondo";
const upd = (mint: string, m: string, ts = T) => ({ program: "spl-token", parsed: { type: "updateMultiplier", info: { mint, newMultiplier: m, newMultiplierTimestamp: ts } } });
const batch = { transaction: { message: { instructions: [] } }, meta: { innerInstructions: [{ index: 2, instructions: [upd(spyOn, "1.0094730727840426"), upd(tslaOn, "1"), { parsed: { type: "transfer", info: {} } }] }] } };
assert.deepEqual(multiplierUpdates(batch, new Set([spyOn])), [{ mint: spyOn, ts: T * 1000, m: 1.0094730727840426 }]);
const since = ex - 3 * 864e5, day = 864e5;
// SPYon: previous batch held the pre-dividend value -> the change is dated to the 18 Sep batch -> lag 0
assert.equal(lastChange([{ ts: T * 1000, m: 1.00947 }, { ts: T * 1000 - day, m: 1.00696 }, { ts: since - day, m: 1.00696 }], since), T * 1000);
assert.deepEqual(lagOf(ex, lastChange([{ ts: T * 1000, m: 1.00947 }, { ts: since - day, m: 1.00696 }], since)!, now), { stepped: true, lagDays: 0 });
// TSLAon-style no-op rewrites back past the window: not a step (0), so a real ex-date would show a growing lag
assert.equal(lastChange([{ ts: T * 1000, m: 1 }, { ts: since - day, m: 1 }], since), 0);
assert.deepEqual(lagOf(ex, 0, now), { stepped: false, lagDays: 1 });
// history never reaches before the window: unprovable, never a guessed date
assert.equal(lastChange([{ ts: T * 1000, m: 1 }], since), undefined);
assert.equal(lastChange([], since), undefined);

// Obligation deposit slots: count reserves with a non-zero deposit (slot 1 empty amount is not a position)
const ob = Buffer.alloc(8 * 136), resKey = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1));
resKey.copy(ob, 0); ob.writeBigUInt64LE(5n, 32); resKey.copy(ob, 136);
const cnt = countDeposits([ob, ob]);
assert.equal(cnt.size, 1);
assert.equal([...cnt.values()][0], 2);
console.log("lenders ok");
