// Snapshot FairPrice for tracked xStocks into web/data/fair.json (static site reads it).
import { mkdirSync, writeFileSync } from "node:fs";
import { fairPrice } from "./fairprice.ts";
import { fetchXStocks } from "./sources.ts";

const TRACK = (process.env.TRACK ?? "SPY,QQQ,NVDA,AAPL,TSLA,GOOGL,MSFT,META,AMZN,IWM").split(",");
const xs = (await fetchXStocks()).filter((x) => TRACK.includes(x.underlying));
const rows = [];
for (const x of xs) {
  try {
    rows.push(await fairPrice(x));
  } catch (e: any) {
    console.error(x.symbol, "failed:", e.message);
  }
}
const fmt = (n: number | null, d = 2) => (n == null ? "-" : n.toFixed(d));
for (const r of rows)
  console.log(r.symbol.padEnd(7), r.status.padEnd(18), r.session.padEnd(9), "fair", fmt(r.fairRaw), "naive", fmt(r.naiveRaw), `(${fmt(r.naiveErrBp, 1)}bp)`,
    "chainlink", fmt(r.chainlinkRaw), `(${fmt(r.chainlinkErrBp, 1)}bp)`, "dex", fmt(r.dexRaw), `(${fmt(r.dexErrBp, 1)}bp)`, "|", r.px?.source ?? "no px");
mkdirSync(new URL("../web/data/", import.meta.url), { recursive: true });
writeFileSync(new URL("../web/data/fair.json", import.meta.url), JSON.stringify({ at: Date.now(), rows }, null, 1));
