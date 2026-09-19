import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseHalts, activeHalts, haltKind, etToUtc, eventOf, sessionOf, Halt, Event, Session } from "./sources.ts";

// ET -> UTC across DST: Sep is EDT (UTC-4), Jan is EST (UTC-5)
assert.equal(new Date(etToUtc("09/14/2026", "19:50:00.000")).toISOString(), "2026-09-14T23:50:00.000Z");
assert.equal(new Date(etToUtc("01/05/2026", "09:30:00")).toISOString(), "2026-01-05T14:30:00.000Z");
assert.equal(etToUtc("", ""), 0);

const halts = parseHalts(readFileSync(new URL("./fixtures/halts.xml", import.meta.url), "utf8"));
assert.ok(halts.length > 0 && halts.every((h) => h.symbol && h.code && h.haltAt > 0));

// resumption in the past clears; no resumption keeps it active
const t0 = Date.UTC(2026, 8, 14, 20);
const act = activeHalts([
  { symbol: "AAA", market: "NASDAQ", code: "LUDP", haltAt: t0 - 6e5, resumeAt: t0 - 3e5 },
  { symbol: "BBB", market: "NYSE", code: "T1", haltAt: t0 - 6e5, resumeAt: 0 },
  { symbol: "CCC", market: "NASDAQ", code: "T12", haltAt: t0 - 6e5, resumeAt: t0 + 3e5 },
], t0);
assert.deepEqual([...act.keys()].sort(), ["BBB", "CCC"]);

assert.equal(haltKind("LUDP"), Halt.Soft);
assert.equal(haltKind("T1"), Halt.Hard);

assert.equal(eventOf("8-K", "2.01,9.01"), Event.Merger);
assert.equal(eventOf("8-K", "8.01"), Event.None);
assert.equal(eventOf("SC TO-T", ""), Event.Tender);
assert.equal(eventOf("25-NSE", ""), Event.Delisting);

assert.equal(sessionOf("market"), Session.Regular);
assert.equal(sessionOf("extended", Date.UTC(2026, 8, 15, 12)), Session.Pre); // 08:00 ET
assert.equal(sessionOf("extended", Date.UTC(2026, 8, 15, 21)), Session.Post); // 17:00 ET

console.log(`sources ok (${halts.length} halts in fixture)`);
