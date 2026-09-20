// Snapshot FairPrice for tracked xStocks into web/data/fair.json, then what every lender prices them at
// into web/data/lenders.json (static site reads both).
import { mkdirSync, writeFileSync } from "node:fs";
import { fairPrice } from "./fairprice.ts";
import { LENDER_BAND_BP, lenders, lentMints } from "./lenders.ts";
import { fetchXStocks } from "./sources.ts";

const REFRESH = "daily snapshot; onchain devnet every ~1-10 min";
const TRACK = (process.env.TRACK ?? "SPY,QQQ,NVDA,AAPL,TSLA,GOOGL,MSFT,META,AMZN,IWM").split(",");
const all = await fetchXStocks();
// TRACK plus every xStock a lender holds: a lender row without a fair would show no error and no dollars at risk
const lent = await lentMints(new Set(all.map((x) => x.mint))).catch((e) => { console.error("lender mints failed, TRACK only:", e.message); return new Set<string>(); });
const xs = all.filter((x) => TRACK.includes(x.underlying) || lent.has(x.mint));
const rows = [];
for (const x of xs) {
  try {
    rows.push(await fairPrice(x));
  } catch (e: any) {
    console.error(x.symbol, "failed:", e.message);
  }
}
// an empty board must never replace yesterday's good one; a partial one is written but fails the job
if (!rows.length) { console.error("no FairPrice rows, keeping previous fair.json"); process.exit(1); }
if (rows.length < xs.length) process.exitCode = 1;
const fmt = (n: number | null, d = 2) => (n == null ? "-" : n.toFixed(d));
for (const r of rows)
  console.log(r.symbol.padEnd(7), r.status.padEnd(18), r.session.padEnd(9), "fair", fmt(r.fairRaw), "naive", fmt(r.naiveRaw), `(${fmt(r.naiveErrBp, 1)}bp)`,
    "chainlink", fmt(r.chainlinkRaw), `(${fmt(r.chainlinkErrBp, 1)}bp)`, "dex", fmt(r.dexRaw), `(${fmt(r.dexErrBp, 1)}bp)`, "|", r.px?.source ?? "no px");
const out = new URL("../web/data/", import.meta.url);
mkdirSync(out, { recursive: true });
writeFileSync(new URL("fair.json", out), JSON.stringify({ at: Date.now(), refresh: REFRESH, rows }, null, 1));

try {
  const l = await lenders(rows, new Set(all.map((x) => x.mint)));
  const usd = (n: number | null) => (n == null ? "-" : `$${Math.round(n).toLocaleString("en-US")}`);
  console.log("\nlender".padEnd(9), "market".padEnd(26), "price".padStart(9), "err bp".padStart(7), "age/val s".padStart(11), "collateral".padStart(12), "misval".padStart(9), "pos".padStart(5), "leg / flags");
  for (const x of l.lenders)
    console.log(x.ticker.padEnd(8), `${x.protocol} ${x.protocol === "kamino" ? x.market.slice(0, 4) : x.market}`.slice(0, 26).padEnd(26), fmt(x.priceRaw).padStart(9), fmt(x.errBp, 1).padStart(7),
      `${fmt(x.ageS, 0)}/${fmt(x.valueAgeS, 0)}`.padStart(11), usd(x.collateralUsd).padStart(12), usd(x.misvalUsd).padStart(9), String(x.positions ?? "-").padStart(5), x.leg, x.fairSource?.startsWith("xstocks-mark") ? "(fair=issuer mark)" : "", x.suspended ? "SUSPENDED" : "", x.flags.join("; "));
  for (const w of l.wrappers)
    console.log(w.ticker.padEnd(6), w.issuer.padEnd(8), "m", w.multiplier.toFixed(6), "stepped", w.stepAt ? new Date(w.stepAt).toISOString().slice(0, 16) : "never", "lag", w.lagDays ?? "-", "d  dex", `${fmt(w.dexBp, 1)}bp`, "liq", usd(w.liquidityUsd), "|", w.stepProof);
  for (const c of l.curators) console.log("curator", c.name.padEnd(24), usd(c.xstockUsd).padStart(12), `${(c.share * 100).toFixed(2)}% of vault`);
  writeFileSync(new URL("lenders.json", out), JSON.stringify({ at: Date.now(), refresh: REFRESH, bandBp: LENDER_BAND_BP, ...l }, null, 1));
} catch (e: any) {
  console.error("lenders failed, keeping previous lenders.json:", e.message);
  process.exitCode = 1;
}
