import assert from "node:assert/strict";
process.env.RAMBU_PROGRAM_ID ??= "5REh2DxuEB5j8baJ4Sz2ZFP1WXwnPict8UuYwqPtVUdm"; // chain.ts reads it at import
const { decodeState, pushReasons } = await import("./chain.ts");

// hand-built 118-byte StockState at the web decodeState offsets
const b = new Uint8Array(118), v = new DataView(b.buffer);
b.set(new TextEncoder().encode("SPYx"), 40); b[52] = 2; b[53] = 1; b.set(new TextEncoder().encode("T1"), 54);
v.setBigInt64(58, 1_790_000_000n, true); v.setBigInt64(66, 0n, true); b[74] = 3; b.set(new TextEncoder().encode("0001417835-26-000274"), 75);
v.setBigUint64(95, 663_120_000n, true); v.setUint16(103, 1000, true); v.setUint32(105, 1800, true); v.setBigInt64(109, 1_790_000_100n, true);
const s = decodeState(b);
assert.deepEqual(s, { ticker: "SPYx", session: 2, halt: 1, haltCode: "T1", haltedAt: 1_790_000_000, resumeAt: 0, event: 3, eventRef: "0001417835-26-000274", refPriceE6: 663_120_000n, bandBps: 1000, maxAgeS: 1800, updatedAt: 1_790_000_100 });

const cfg = { bandBps: 1000, maxAgeS: 1800 }, t = s.updatedAt;
const same = { session: 2, halt: 1, haltCode: "T1", haltedAtS: 1_790_000_000, resumeAtS: 0, event: 3, eventRef: s.eventRef, refPriceE6: s.refPriceE6 };
assert.deepEqual(pushReasons(undefined, same, cfg, t), ["new"]);
assert.deepEqual(pushReasons(s, same, cfg, t + 60), []); // second immediate run pushes nothing
assert.deepEqual(pushReasons(s, same, cfg, t + 601), ["age"]); // > maxAge/3
assert.deepEqual(pushReasons(s, same, cfg, t + 1801), ["missed", "age"]);
assert.deepEqual(pushReasons(s, { ...same, halt: 0, haltCode: "", haltedAtS: 0 }, cfg, t + 60), ["halt"]);
assert.deepEqual(pushReasons(s, { ...same, event: 0, eventRef: "" }, cfg, t + 60), ["event"]);
// band 10% -> push above a 2.5% move
assert.deepEqual(pushReasons(s, { ...same, refPriceE6: 663_120_000n * 1024n / 1000n }, cfg, t + 60), []);
assert.deepEqual(pushReasons(s, { ...same, refPriceE6: 663_120_000n * 1026n / 1000n }, cfg, t + 60), ["ref"]);
assert.deepEqual(pushReasons(s, { ...same, refPriceE6: 0n }, cfg, t + 60), ["ref"]);
assert.deepEqual(pushReasons(s, same, { bandBps: 1000, maxAgeS: 900 }, t + 60), ["config"]);

console.log("chain ok");
