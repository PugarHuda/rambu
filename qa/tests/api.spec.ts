// The api/ handlers against live devnet/mainnet and the published snapshots. Run through qa/server.ts, which applies
// the real vercel.json headers, rewrites and redirects, so the Blink paths behave as deployed.
import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";

const root = new URL("../../", import.meta.url);
const readJson = (p: string) => JSON.parse(readFileSync(new URL(p, root), "utf8"));
const sewa = readJson("web/data/sewa.json");

test.describe.configure({ mode: "serial" });

test("static headers carry the CSP that the page's own RPC hosts need", async ({ request }) => {
  const r = await request.get("/");
  expect(r.status()).toBe(200);
  const csp = r.headers()["content-security-policy"];
  expect(csp).toBeTruthy();
  // the hosts index.html actually connects to must all be allowed, or the live site breaks silently
  const page = readFileSync(new URL("web/index.html", root), "utf8");
  const hosts = [...page.matchAll(/https:\/\/(api\.devnet\.solana\.com|api\.mainnet-beta\.solana\.com|solana-rpc\.publicnode\.com)/g)].map((m) => m[0]);
  expect(hosts.length).toBeGreaterThan(0);
  for (const h of new Set(hosts)) expect(csp, `${h} must be in connect-src`).toContain(h);
  expect(csp).toContain("frame-ancestors 'none'");
  expect(r.headers()["x-content-type-options"]).toBe("nosniff");
});

test("/api/state returns every live devnet state with a program verdict", async ({ request }) => {
  const r = await request.get("/api/state");
  expect(r.status()).toBe(200);
  const j = await r.json();
  expect(j.cluster).toBe("devnet");
  expect(j.program).toBe("5REh2DxuEB5j8baJ4Sz2ZFP1WXwnPict8UuYwqPtVUdm");
  expect(j.states.length).toBeGreaterThan(0);
  for (const s of j.states) {
    expect(s.mint).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    expect(s.refPriceE6).toBeGreaterThan(0);
    expect(s.bandBps).toBeGreaterThanOrEqual(10);
    expect(s.bandBps).toBeLessThanOrEqual(2000);
    expect(s.maxAgeS).toBeGreaterThanOrEqual(60);
    expect(s.maxAgeS).toBeLessThanOrEqual(3600);
    expect(["Tradable", "Stale", "Halted", "Paused", "EventPending", "OutsideBand", "NoReference", "PriceRequired"]).toContain(s.verdict);
  }
  expect(j.clusterTime).toBeGreaterThan(1.7e9);
});

test("/api/state?ticker= also simulates the program's own get_price", async ({ request }) => {
  const all = await (await request.get("/api/state")).json();
  const t = all.states[0].ticker;
  const j = await (await request.get(`/api/state?ticker=${t}`)).json();
  expect(j.states).toHaveLength(1);
  expect(j.states[0].getPrice).toBeTruthy();
  expect(j.states[0].getPrice.unitsConsumed).toBeGreaterThan(0);
  // get_price return data: the ref straight from the program, matching the decoded account
  if (j.states[0].getPrice.verdict === null || j.states[0].getPrice.priceE6 != null)
    expect(j.states[0].getPrice.priceE6 ?? j.states[0].refPriceE6).toBe(j.states[0].refPriceE6);
});

test("/api/state validates input and 404s an unknown ticker with the real list", async ({ request }) => {
  expect((await request.get("/api/state?price=-1")).status()).toBe(400);
  expect((await request.get("/api/state?price=abc")).status()).toBe(400);
  const r = await request.get("/api/state?ticker=NOPEx");
  expect(r.status()).toBe(404);
  const j = await r.json();
  expect(j.error).toContain("nopex");
  expect(j.tickers.length).toBeGreaterThan(0);
});

test("/api/state?price= judges an out-of-band price with the program's rules", async ({ request }) => {
  const all = await (await request.get("/api/state")).json();
  const s = all.states.find((x: any) => x.ageS <= x.maxAgeS && x.halt === 0) ?? all.states[0];
  const j = await (await request.get(`/api/state?ticker=${s.ticker}&price=${(s.refPrice * 0.6).toFixed(6)}`)).json();
  const want = s.ageS > s.maxAgeS ? "Stale" : s.halt !== 0 ? "Halted" : s.event !== 0 ? "EventPending" : "OutsideBand";
  expect(j.states[0].verdict).toBe(want);
  expect(j.priceChecked).toBeCloseTo(s.refPrice * 0.6, 4);
});

test("/api/fair joins the snapshot with live onchain state and the lender rows", async ({ request }) => {
  const r = await request.get("/api/fair?symbol=SPYx");
  expect(r.status()).toBe(200);
  const j = await r.json();
  expect(j.rows).toHaveLength(1);
  const row = j.rows[0];
  expect(row.symbol).toBe("SPYx");
  expect(row.snapshot.fairRaw).toBeGreaterThan(0);
  expect(row.snapshot.px.source).not.toMatch(/mock|fake|todo/i);
  // the Chainlink comparison is the project's headline finding: it must be a real number here
  expect(typeof row.snapshot.chainlinkErrBp).toBe("number");
  expect(row.onchain, "devnet read should succeed").toBeTruthy();
  expect(row.onchain.refPriceE6).toBeGreaterThan(0);
  expect(row.lenders.markets.length).toBeGreaterThan(0);
  for (const m of row.lenders.markets) expect(["kamino", "jupiter"]).toContain(m.protocol);
  expect(r.headers()["cache-control"]).toBeTruthy();
  expect((await request.get("/api/fair?symbol=NOPEx")).status()).toBe(404);
});

test("/api/history decodes real upserts, or reports the throttle honestly", async ({ request }) => {
  const r = await request.get("/api/history?limit=60");
  expect(r.status()).toBe(200);
  const j = await r.json();
  expect(typeof j.scanned).toBe("number");
  if (j.pushes > 0) {
    const runs = Object.values(j.series ?? {}).flat() as any[];
    expect(runs.length).toBeGreaterThan(0);
    for (const run of runs.slice(0, 5)) {
      expect(run.sig).toMatch(/^[1-9A-HJ-NP-Za-km-z]{80,90}$/);
      expect(run.slot).toBeGreaterThan(0);
      expect(run.refLast).toBeGreaterThan(0);
      expect(["none", "pre", "regular", "post", "overnight", "closed"]).toContain(run.session);
    }
    // every price series point is [unix, price] read out of a transaction
    for (const pts of Object.values(j.prices ?? {}) as any[]) for (const p of pts) { expect(p[0]).toBeGreaterThan(1.7e9); expect(p[1]).toBeGreaterThan(0); }
  } else {
    expect(j.unreadable ?? j.throttled, "no pushes must be explained by unreadable/throttled, not silence").toBeTruthy();
  }
});

test("/api/history?format=atom is a valid feed", async ({ request }) => {
  const r = await request.get("/api/history?format=atom&limit=40");
  expect(r.status()).toBe(200);
  expect(r.headers()["content-type"]).toContain("xml");
  const body = await r.text();
  expect(body.startsWith("<?xml")).toBe(true);
  expect(body).toContain("<feed");
  expect(body).toContain("</feed>");
  // entries are optional (devnet may throttle every getTransaction) but must be well-formed when present
  const entries = body.match(/<entry>/g)?.length ?? 0;
  if (entries) expect(body).toContain("explorer.solana.com/tx/");
});

test("Blink: GET /api/actions/tradable is a valid Action, and the ticker rewrite works", async ({ request }) => {
  const r = await request.get("/api/actions/tradable");
  expect(r.status()).toBe(200);
  expect(r.headers()["x-action-version"]).toBe("2.4");
  expect(r.headers()["x-blockchain-ids"]).toContain("solana:");
  expect(r.headers()["access-control-allow-origin"]).toBe("*");
  const j = await r.json();
  expect(j.type).toBe("action");
  expect(j.icon).toMatch(/^https?:\/\/.+icon\.svg$/);
  expect(j.title).toBeTruthy();
  expect(j.links?.actions?.length ?? 0).toBeGreaterThan(0);

  // vercel.json rewrite /api/actions/tradable/:ticker
  const all = await (await request.get("/api/state")).json();
  const t = all.states[0].ticker;
  const p = await (await request.get(`/api/actions/tradable/${t}`)).json();
  expect(p.title).toContain(t);
});

// the Action's href template puts price/mode in the query string; the POST body only carries `account`
const done = (j: any) => j.links?.next?.action ?? j;

test("Blink: POST /api/actions/tradable answers with the program's real verdict", async ({ request }) => {
  const all = await (await request.get("/api/state")).json();
  const s = all.states.find((x: any) => x.ageS <= x.maxAgeS && x.halt === 0) ?? all.states[0];
  const want = s.ageS > s.maxAgeS ? "Stale" : s.halt !== 0 ? "Halted" : s.event !== 0 ? "EventPending" : "OutsideBand";
  const post = (qs: string) => request.post(`/api/actions/tradable?ticker=${s.ticker}&${qs}`, { data: { account: s.mint } });

  const off = await post(`price=${(s.refPrice * 0.6).toFixed(2)}&mode=lender`);
  expect(off.status()).toBe(200);
  const j = done(await off.json());
  expect(j.type).toBe("completed");
  expect(j.title).toContain(want);
  expect(j.description).toMatch(/Error Number: 6\d{3}|compute units/);

  const at = done(await (await post(`price=${s.refPrice}&mode=lender`)).json());
  expect(at.title).toContain(s.ticker);
  // whatever the verdict, it must be one of the program's, never a guess
  expect(at.title).toMatch(/Tradable|passes|Stale|Halted|Paused|EventPending|OutsideBand|SessionClosed|NoReference|PriceRequired/);
  expect(at.description).toContain("Simulated on devnet");

  // a missing price must reach the program's PriceRequired, not a JS short-circuit
  const none = done(await (await post("mode=lender")).json());
  expect(none.title).toContain("PriceRequired");

  // regular-session-only callers get SessionClosed outside regular hours; that flag must really change the answer
  const reg = done(await (await post(`price=${s.refPrice}&mode=regular`)).json());
  expect(reg.title).toMatch(/Tradable|SessionClosed|Stale|Halted/);
  if (s.sessionName !== "regular" && s.ageS <= s.maxAgeS && s.halt === 0) expect(reg.title).toContain("SessionClosed");
});

test("Blink: /api/actions/lp summarises the real audit and looks up a real position", async ({ request }) => {
  const r = await request.get("/api/actions/lp");
  expect(r.status()).toBe(200);
  const j = await r.json();
  expect(j.type).toBe("action");
  expect(j.title).not.toContain("undefined");
  expect(j.description).toMatch(/\$/);

  const pool = sewa.pools.find((p: any) => p.pos.length) as any;
  const first = pool.pos[0];
  const nft = Array.isArray(first) ? first[0] : first.nft;
  const owedSnap = Array.isArray(first) ? first[8] : first.owedUsd;
  const p = await request.post("/api/actions/lp", { data: { account: nft } });
  expect(p.status()).toBe(200);
  const pj = done(await p.json());
  expect(pj.type).toBe("completed");
  expect(pj.title).not.toContain("undefined");
  // the pool's own symbol pair, from sewa.json's restored top-level shape
  expect(pj.title).toMatch(/\bx?[A-Z]{2,5}x?\/(USDC|SOL)\b/);
  // the uncollected figure must be plausible money, not a millisecond timestamp leaking from openedAt
  const nums = [...JSON.stringify(pj).matchAll(/\$([\d,]+(?:\.\d+)?)/g)].map((m) => Number(m[1].replace(/,/g, "")));
  expect(nums.length).toBeGreaterThan(0);
  for (const n of nums) expect(n, `${n} looks like a timestamp, not USD`).toBeLessThan(1e9);
  if (owedSnap != null) expect(nums.some((n) => Math.abs(n - owedSnap) < Math.max(50, owedSnap * 0.5))).toBe(true);
});

test("actions.json and the dial.to redirects are wired", async ({ request }) => {
  const r = await request.get("/actions.json");
  expect(r.status()).toBe(200);
  expect(r.headers()["x-action-version"]).toBe("2.4");
  const j = await r.json();
  expect(j.rules.length).toBeGreaterThan(0);
  for (const rule of j.rules) expect(rule.apiPath).toMatch(/^\/api\/actions\//);
});

test("an unknown path serves the real 404 page, not a stack trace", async ({ request }) => {
  const r = await request.get("/nope");
  expect(r.status()).toBe(404);
  const body = await r.text();
  expect(body).toContain("<");
  expect(body.toLowerCase()).not.toContain("stack");
  expect((await request.get("/api/nope")).status()).toBe(404);
});

test("OPTIONS preflight is answered on both Blink endpoints", async ({ request }) => {
  for (const p of ["/api/actions/tradable", "/api/actions/lp"]) {
    const r = await request.fetch(p, { method: "OPTIONS" });
    expect([200, 204]).toContain(r.status());
    expect(r.headers()["access-control-allow-origin"]).toBe("*");
  }
});
