// node api/_rambu.test.ts — offline self-checks against real devnet bytes.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { assertTradableIx, assertTradableV2Ix, b58, check, checkWith, decodePrice, decodeState, errName, getPriceIx, legacyTx, onCurve, PROGRAM, registryPda, REQUIRE_REGULAR_SESSION, statePda, unb58 } from "./_rambu.ts";

// SPYx StockState account C6Bq… on devnet, fetched 19 Sep 2026 (keeper push with ref = FairPrice incl. SPY dividend)
const SPYX = Buffer.from("0jwFisHtufMH6Nws3nsjoNdD+PEna2V9ip7qBpULpnqNMDPFPEzeT1NQWXgAAAAAAAAAAAUARElWAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAkLb0tAAAAAOgDCAcAAEaTrmoAAAAA/w==", "base64");
const s = decodeState(new Uint8Array(SPYX), "C6BqRKgrFkcDwnRDEDmKBJKYRchiXJ1efbyPGEq64kSa");
assert.equal(s.ticker, "SPYx");
assert.equal(s.mint, "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W");
assert.equal(s.haltCode, "DIV");
assert.equal(s.sessionName, "closed");
assert.ok(Math.abs(s.refPrice - 767.37) < 0.01, `ref ${s.refPrice}`);
assert.equal(s.bandBps, 1000);
assert.equal(s.maxAgeS, 1800);
assert.equal(s.bump, 255);

// check() / check_with() mirror: same rule order as lib.rs (price 0 is only allowed on the swap path)
const t = s.updatedAt + 60;
assert.equal(check(s, t), "PriceRequired");
assert.equal(check(s, t, 0, true), "Tradable");
assert.equal(check(s, t, 680_000_000), "OutsideBand"); // −11.4% vs ±10% band
assert.equal(check(s, t, s.refPriceE6), "Tradable");
assert.equal(check(s, s.updatedAt + s.maxAgeS + 1, 680_000_000), "Stale"); // staleness wins over band
const R = s.refPriceE6;
assert.equal(check({ ...s, halt: 3 }, t, R), "Halted");
assert.equal(check({ ...s, halt: 77 }, t, R), "Halted");
assert.equal(check({ ...s, halt: 2, resumeAt: t + 1 }, t, R), "Paused");
assert.equal(check({ ...s, halt: 2, resumeAt: t }, t, R), "Tradable");
assert.equal(check({ ...s, event: 1 }, t, R), "EventPending");
assert.equal(check({ ...s, event: 1 }, t, 0, true), "Tradable");
assert.equal(check({ ...s, refPriceE6: 0 }, t, R), "NoReference");
// v2 limits only tighten: 2% band / 60s age from the caller; 90% / 1 day stay capped by the state
assert.equal(checkWith(s, t, 760_000_000, 0, 0, 200), "Tradable");
assert.equal(checkWith(s, t, 750_000_000, 0, 0, 200), "OutsideBand");
assert.equal(checkWith(s, t, 680_000_000, 0, 0, 9_000), "OutsideBand");
assert.equal(checkWith(s, t + 1, R, 0, 60), "Stale");
assert.equal(checkWith(s, s.updatedAt + 1801, R, 0, 86_400), "Stale");
assert.equal(checkWith(s, t, R, REQUIRE_REGULAR_SESSION), "SessionClosed"); // fixture is session 5 (closed)
assert.equal(checkWith({ ...s, session: 2 }, t, R, REQUIRE_REGULAR_SESSION), "Tradable");

// PDAs derived from scratch (WebCrypto sha256 + ed25519 on-curve test) match the live devnet accounts
assert.equal(await statePda(s.mint), s.key);
assert.equal(await registryPda(), "B1bDw3briMcKeKZ2ZEKGXkwAB1CCQxmwRZmQgNmkrCJ9");
assert.ok(onCurve(unb58("11111111111111111111111111111111")) === true); // y=0 is a curve point
assert.ok(onCurve(unb58(PROGRAM)));
assert.equal(b58(unb58(PROGRAM)), PROGRAM);

// assert_tradable ix: anchor discriminator + u64 LE + bool = 17 bytes
const ix = await assertTradableIx(680_000_000n);
assert.equal(ix.length, 17);
assert.deepEqual([...ix.subarray(0, 8)], [...createHash("sha256").update("global:assert_tradable").digest().subarray(0, 8)]);
assert.equal(Buffer.from(ix.subarray(8, 16)).readBigUInt64LE(), 680_000_000n);
assert.equal(ix[16], 0);

// v2 ix: disc | mint | u64 price | u8 flags | u32 max age | u16 max band = 55 bytes; get_price: disc | mint
const v2 = await assertTradableV2Ix(s.mint, 767_370_000n, 2, 60, 200);
assert.equal(v2.length, 55);
assert.deepEqual([...v2.subarray(0, 8)], [...createHash("sha256").update("global:assert_tradable_v2").digest().subarray(0, 8)]);
assert.equal(b58(v2.subarray(8, 40)), s.mint);
assert.deepEqual([...v2.subarray(48)], [2, 60, 0, 0, 0, 200, 0]);
assert.equal((await getPriceIx(s.mint)).length, 40);
const rd = new Uint8Array(20); new DataView(rd.buffer).setBigUint64(0, 767372580n, true); new DataView(rd.buffer).setInt32(8, -6, true); new DataView(rd.buffer).setBigInt64(12, 1789831255n, true);
assert.deepEqual(decodePrice(rd), { priceE6: 767372580, expo: -6, updatedAt: 1789831255 });

// legacy tx layout: 1 sig slot, header [1,0,2], keys payer/state/program, one ix [programIdx=2, accounts [1]]
const payer = "2Heyq6SB4xN5JBJ9evmR5NG2T2qbXECEqZwBMbWYEYMQ";
const tx = legacyTx(payer, PROGRAM, [{ pubkey: s.key, signer: false, writable: false }], ix);
assert.equal(tx[0], 1);
assert.deepEqual([...tx.subarray(65, 68)], [1, 0, 2]);
assert.equal(tx[68], 3);
assert.equal(b58(tx.subarray(69, 101)), payer);
assert.equal(b58(tx.subarray(101, 133)), s.key);
assert.equal(b58(tx.subarray(133, 165)), PROGRAM);
assert.deepEqual([...tx.subarray(197, 202)], [1, 2, 1, 1, 17]);
assert.equal(tx.length, 202 + 17);

// error naming: known code, then Anchor log fallback for codes this map does not know yet
assert.equal(errName({ InstructionError: [0, { Custom: 6004 }] }), "OutsideBand");
assert.equal(errName({ InstructionError: [0, { Custom: 6006 }] }), "PriceRequired");
assert.equal(errName({ InstructionError: [0, { Custom: 6011 }] }), "BadMint");
assert.equal(errName({ InstructionError: [0, { Custom: 6099 }] }, ["Program log: AnchorError occurred. Error Code: NewThing. Error Number: 6099."]), "NewThing");
assert.equal(errName(null), null);
// history: real keeper upsert ix (tx 3aky3v…) and the StateChanged event it emitted
const { atom, compress, decodeEvent, decodeUpsert } = await import("./history.ts");
const u = decodeUpsert(unb58("2HGhbenyzyXTsy1tSKQFJ1AqgEUe2JtPHpQwgdfzgHYxEJcd4HLFMRvmMEZmqr9tPk2Vf2pJ64YFTkBp7jAb7CUcZL6EHcP5MbfQ9521uH"))!;
assert.deepEqual({ ...u, refPrice: Math.round(u.refPrice * 100) / 100 },
  { ticker: "SPYx", session: "closed", halt: "none", haltCode: "DIV", haltedAt: 0, resumeAt: 0, event: "none", eventRef: "", refPrice: 767.37, bandBps: 1000, maxAgeS: 1800 });
const ev = decodeEvent(Buffer.from("AJY34Csa1sAH6Nws3nsjoNdD+PEna2V9ip7qBpULpnqNMDPFPEzeTwAABQ==", "base64"))!;
assert.deepEqual(ev, { kind: "StateChanged", mint: s.mint, halt: 0, event: 0, session: 5 });
// v2 layout (lib.rs StateChanged after the P3 upgrade): built field by field, then decoded back
const e2 = new Uint8Array(97), dv = new DataView(e2.buffer);
e2.set(Buffer.from("AJY34Csa1sAH6Nws3nsjoNdD+PEna2V9ip7qBpULpnqNMDPFPEzeTwAABQ==", "base64"));
dv.setBigUint64(43, 767372580n, true); dv.setBigUint64(51, 766042723n, true); dv.setUint16(59, 1000, true); dv.setUint32(61, 1800, true);
e2.set(new TextEncoder().encode("DIV"), 65); dv.setBigInt64(89, 1789831874n, true);
assert.deepEqual(decodeEvent(e2), { kind: "StateChanged", mint: s.mint, halt: 0, event: 0, session: 5, refPrice: 767.37258, prevRefPrice: 766.042723, bandBps: 1000, maxAgeS: 1800, haltCode: "DIV", eventRef: "", updatedAt: 1789831874 });
assert.deepEqual(decodeEvent(e2.subarray(0, 48), "Heartbeat"), { kind: "Heartbeat", mint: s.mint, updatedAt: Number(dv.getBigInt64(40, true)) });
const push = (slot: number, haltCode: string, refPrice: number) => ({ ...u, sig: `s${slot}`, slot, t: slot * 10, mint: s.mint, haltCode, refPrice });
const series = compress([push(3, "DIV", 768), push(1, "DIV", 767), push(2, "DIV", 767.5), push(4, "", 769)]);
assert.equal(series.SPYx.length, 2); // DIV run of 3 pushes, then the change
assert.deepEqual([series.SPYx[0].pushes, series.SPYx[0].refFirst, series.SPYx[0].refLast, series.SPYx[0].until], [3, 767, 768, 30]);
const feed = atom(series, "https://x/api/history?format=atom&a=<b>");
assert.ok(feed.startsWith("<?xml") && feed.split("<entry>").length === 3 && feed.includes("&amp;a=&lt;b&gt;"));
// LP owed fees: Uniswap-v3 fee growth inside, u128 wrapping, Q64.64
const { feeGrowthInside, owedDelta, tickArrayStart } = await import("./actions/lp.ts");
const Q = 1n << 64n;
assert.equal(feeGrowthInside(10, 0, 20, 100n, 30n, 20n), 50n); // in range: global - below - above
assert.equal(feeGrowthInside(-5, 0, 20, 100n, 30n, 20n), 10n); // below range: outside(lower) - outside(upper)
assert.equal(feeGrowthInside(25, 0, 20, 100n, 30n, 20n), (1n << 128n) - 10n); // wraps, like the program
assert.equal(owedDelta(5n * Q, 3n * Q, 1000n), 2000n);
assert.equal(owedDelta(1n, (1n << 128n) - 1n, Q), 2n); // growth that wrapped past 2^128 still counts
assert.deepEqual([tickArrayStart(20369, 10), tickArrayStart(-1, 10), tickArrayStart(-600, 10)], [19800, -600, -600]);
console.log("api/_rambu ok");
