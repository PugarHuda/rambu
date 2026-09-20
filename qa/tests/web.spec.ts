// End-to-end tests of web/index.html against live data: the published snapshots (data/*.json), live Solana devnet
// (getProgramAccounts + simulateTransaction) and live mainnet (Raydium CLMM account reads). Nothing is mocked.
import { expect, test, type ConsoleMessage, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

const root = new URL("../../", import.meta.url);
const readJson = (p: string) => JSON.parse(readFileSync(new URL(p, root), "utf8"));
const fair = readJson("web/data/fair.json");
const sewa = readJson("web/data/sewa.json");
const lenders = readJson("web/data/lenders.json");

// every test starts from a loaded page and fails on a console error or a CSP violation
const errors = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => {
  const log: string[] = [];
  errors.set(page, log);
  page.on("console", (m: ConsoleMessage) => { if (m.type() === "error") log.push(m.text()); });
  page.on("pageerror", (e) => log.push(`pageerror: ${e.message}`));
  await page.goto("/", { waitUntil: "domcontentloaded" });
});
// Chrome logs a console error for every refused/throttled third-party RPC response even when the page handles it
// cleanly, so those transport statuses are filtered out here; the dedicated tests assert the handling itself.
// Anything else - a script error, a CSP violation, a bad decode - fails the test.
const RPC_STATUS = [403, 429, 502, 503];
const noErrors = (page: Page, allowHttp: number[] = RPC_STATUS) =>
  expect((errors.get(page) ?? []).filter((e) => !allowHttp.some((s) => e.includes(`status of ${s}`)))).toEqual([]);

// The devnet read can be throttled on any given load; the page offers Retry, so wait for the states properly
// instead of assuming a clear IP. Returns once #cPick is populated.
async function ensureStates(page: Page, tries = 4) {
  for (let i = 0; i < tries; i++) {
    await expect(page.locator("#chainMeta")).not.toContainText("reading devnet", { timeout: 90_000 });
    if (await page.locator("#cPick option").count()) return;
    await new Promise((r) => setTimeout(r, 11_000));
    await page.click('#chainRows button[data-retry="chain"]');
  }
  throw new Error(`devnet kept refusing the state read: ${await page.locator("#chainMeta").textContent()}`);
}

// Public devnet rate-limits simulateTransaction per IP. The page surfaces that with a Retry button; use it.
async function verdictWithRetry(page: Page, tries = 4) {
  const v = page.locator("#cVerdict");
  for (let i = 0; i < tries; i++) {
    await expect(v).not.toContainText("simulating", { timeout: 90_000 });
    const t = (await v.textContent()) ?? "";
    if (!/rate limit|429|Simulation failed/i.test(t)) return t;
    await new Promise((r) => setTimeout(r, 11_000)); // public devnet retry-after is ~10s
    await page.click('#cVerdict button[data-retry="sim"]');
  }
  throw new Error(`devnet kept refusing simulateTransaction: ${await v.textContent()}`);
}

test("page shell, no console errors, no horizontal scroll, meta", async ({ page }) => {
  await expect(page.locator("h1")).toHaveText("RAMBU.");
  await expect(page).toHaveTitle(/Rambu/i);
  await expect(page.locator('meta[name="description"]')).toHaveCount(1);
  await expect(page.locator('link[rel="icon"]')).toHaveCount(1);
  // the fair board is the first thing to settle; wait for it before measuring layout
  await expect(page.locator("#fairRows tr")).toHaveCount(fair.rows.length);
  const { sw, cw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  expect(sw).toBeLessThanOrEqual(cw);
  noErrors(page);
});

test("FairPrice board shows every snapshot row with its real status and price source", async ({ page }) => {
  const rows = page.locator("#fairRows tr");
  await expect(rows).toHaveCount(fair.rows.length);
  await expect(page.locator("#fairMeta")).toContainText(`${fair.rows.length} tokens`);

  const spy = fair.rows.find((r: any) => r.symbol === "SPYx");
  expect(spy, "fair.json must carry SPYx").toBeTruthy();
  const row = rows.filter({ has: page.locator("td b", { hasText: /^SPYx$/ }) }).first();
  await expect(row.locator(".pill").first()).toHaveText(spy.status);
  await expect(row).toContainText(spy.fairRaw.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ","));
  // Chainlink column: the verified -0.8bp finding must be visible, not just in the JSON
  await expect(row).toContainText(`${spy.chainlinkErrBp >= 0 ? "+" : "−"}${Math.abs(spy.chainlinkErrBp).toFixed(1)}bp`);
  // price-source cell carries the real provenance string (issuer mark / pyth-pro), never a placeholder
  await expect(row.locator("td").last()).toHaveText(spy.px.source);
  expect(spy.px.source).not.toMatch(/mock|fake|todo|placeholder|coming soon/i);

  // a Pyth Pro entitled feed must show publishers + session in the quote column
  const pro = fair.rows.find((r: any) => r.px?.publishers != null);
  if (pro) await expect(rows.filter({ has: page.locator("td b", { hasText: new RegExp(`^${pro.symbol}$`) }) }).first())
    .toContainText(`${pro.px.publishers} publishers`);
  noErrors(page);
});

test("lender exposure and wrapper tables render the real reserves", async ({ page }) => {
  const uniq = new Set(lenders.lenders.map((x: any) => x.account)).size;
  await expect(page.locator("#lendRows tr")).toHaveCount(uniq);
  await expect(page.locator("#lendMeta")).toContainText(`${uniq} reserves`);
  await expect(page.locator("#lendMeta")).toContainText(`±${lenders.bandBp}bp`);
  // sorted by $ misvaluation: the top row is the largest real mispricing
  const top = [...lenders.lenders].sort((a: any, b: any) => (b.misvalUsd ?? -1) - (a.misvalUsd ?? -1))[0];
  await expect(page.locator("#lendRows tr").first().locator("td b")).toHaveText(top.ticker);
  // every reserve links to its real Solscan account
  await expect(page.locator(`#lendRows a[href="https://solscan.io/account/${top.account}"]`)).toHaveCount(1);

  await expect(page.locator("#wrapRows tr")).toHaveCount(lenders.wrappers.length);
  // the xStocks vs Ondo lag claim is the headline; it must be a real number or an explicit dash, never invented
  for (const w of lenders.wrappers) {
    const r = page.locator("#wrapRows tr").filter({ has: page.locator("td b", { hasText: new RegExp(`^${w.ticker}$`) }) })
      .filter({ hasText: w.issuer === "ondo" ? "Ondo" : "xStocks" }).first();
    await expect(r).toContainText(w.lagDays == null ? "—" : `${w.lagDays} d`);
  }
  noErrors(page);
});

test("devnet status table decodes live states and agrees with /api/state", async ({ page, request }) => {
  await ensureStates(page);
  const api = await (await request.get("/api/state")).json();
  const n = api.states.length;
  expect(n).toBeGreaterThan(0);
  await expect(page.locator("#chainRows tr")).toHaveCount(n);
  await expect(page.locator("#chainMeta")).toContainText(`${n} states`);

  for (const s of api.states) {
    const row = page.locator("#chainRows tr").filter({ has: page.locator("td b", { hasText: new RegExp(`^${s.ticker}$`) }) }).first();
    // the page's JS check() mirror must reach the same verdict as api/_rambu.ts checkWith() at the ref price
    await expect(row.locator(".pill").first()).toHaveText(s.verdict);
    await expect(row).toContainText(`±${s.bandBps / 100}%`);
    await expect(page.locator(`#chainRows a[href="https://explorer.solana.com/address/${s.key}?cluster=devnet"]`)).toHaveCount(1);
  }
  // the stale banner is truthful: present only when every state really is past max_age
  const allStale = api.states.every((s: any) => s.ageS > s.maxAgeS);
  await expect(page.locator("#chainBanner .banner")).toHaveCount(allStale ? 1 : 0);
  await expect(page.locator(".legend")).toContainText("ISSR");
  noErrors(page);
});

test('"Would it pass?" asks the program: ref price and a price far outside the band', async ({ page, request }) => {
  await ensureStates(page);
  const api = await (await request.get("/api/state")).json();
  // pick a state that is fresh and not halted, so the band is what decides
  const s = api.states.find((x: any) => x.verdict === "Tradable")
    ?? api.states.find((x: any) => x.ageS <= x.maxAgeS && x.halt === 0)
    ?? api.states[0];
  await page.selectOption("#cPick", { label: s.ticker });
  // the form prefills the onchain ref, so a plain submit is the "at ref" case
  await expect(page.locator("#cPrice")).toHaveValue(String(s.refPrice));

  await page.click("#cGo");
  const atRef = await verdictWithRetry(page);
  expect(atRef, "the verdict must come from the program, with a real CU count").toMatch(/\d[\d,]*\s+compute units/);
  // what the program says at the ref must match the verdict /api/state computed with the same rules
  if (s.verdict === "Tradable") expect(atRef).toContain("assert_tradable passes");
  else expect(atRef).toContain(s.verdict);

  // 40% off the ref is far outside any band (max 2000bp); on a fresh, unhalted state that is OutsideBand
  await page.fill("#cPrice", String(+(s.refPrice * 0.6).toFixed(6)));
  await page.click("#cGo");
  const off = await verdictWithRetry(page);
  expect(off).toContain("assert_tradable fails with");
  const expected = s.ageS > s.maxAgeS ? "Stale" : s.halt !== 0 ? "Halted" : s.event !== 0 ? "EventPending" : "OutsideBand";
  expect(off, `${s.ticker} halt=${s.halt} age=${s.ageS}/${s.maxAgeS}`).toContain(expected);
  expect(off).toMatch(/\(6\d{3}\)/); // a real Anchor error code from the error table
  noErrors(page);
});

test("the price field refuses 0 and blank the way the program does", async ({ page }) => {
  await ensureStates(page);
  for (const val of ["", "0", "-5"]) {
    await page.fill("#cPrice", val);
    await page.click("#cGo");
    await expect(page.locator("#cVerdict")).toContainText("Enter a price > 0");
  }
  noErrors(page);
});

test("onchain history: real decoded pushes, or an honest rate-limit notice", async ({ page }) => {
  // how much devnet lets through varies per call, so assert against the exact payload THIS page received
  const got = page.waitForResponse((r) => r.url().includes("/api/history"), { timeout: 150_000 });
  await page.reload({ waitUntil: "domcontentloaded" });
  const h = await (await got).json().catch(() => null);
  const meta = page.locator("#histMeta");
  await expect(meta).not.toContainText("decoding keeper transactions", { timeout: 150_000 });
  const txt = (await meta.textContent()) ?? "";

  if (!h || h.error || /History unavailable/.test(txt)) {
    // devnet refused the read; the page must say so and offer Retry, never invent a series
    await expect(meta).toContainText("History unavailable");
    await expect(meta.locator("button[data-retry=hist]")).toHaveCount(1);
    await expect(page.locator("#histCards .card")).toHaveCount(0);
    await expect(page.locator("#histList li")).toHaveCount(0);
    return;
  }
  expect(txt).toContain(`${h.pushes} keeper pushes decoded from the last ${h.scanned} program transactions`);
  const runs = Object.values(h.series ?? {}).flat() as any[];
  if (h.pushes > 0) {
    // one sparkline per ticker, each labelled with its real first and last ref price
    await expect(page.locator("#histCards .card")).toHaveCount(Object.keys(h.prices).length);
    await expect(page.locator("#histCards .card svg").first()).toHaveAttribute("aria-label", /ref price from \$/);
    await expect(page.locator("#histList li")).toHaveCount(Math.min(30, runs.length));
    // the newest status change links the transaction that actually made it
    const first = [...runs].sort((a, b) => b.t - a.t)[0];
    await expect(page.locator(`#histList a[href="https://explorer.solana.com/tx/${first.sig}?cluster=devnet"]`)).toHaveCount(1);
    await expect(page.locator("#histMeta a[href='/api/history?format=atom']")).toHaveCount(1);
  } else {
    await expect(page.locator("#histList li")).toHaveText(/No keeper pushes in the scanned window/);
  }
  if (h.unreadable) await expect(meta).toContainText("rate-limited");
  noErrors(page);
});

test("LP audit: selectors switch pools and every gate pill is earned", async ({ page }) => {
  await expect(page.locator("#lpRows tr").first()).toBeAttached();
  const assets = [...new Set(sewa.pools.map((p: any) => p.xsym ?? p.xsymbol ?? sewa.xsymbol))];
  await expect(page.locator("#assetPick option")).toHaveCount(assets.length);

  for (const [i, p] of sewa.pools.entries()) {
    const asset = p.xsym ?? p.xsymbol ?? sewa.xsymbol;
    await page.selectOption("#assetPick", asset as string);
    await page.selectOption("#poolPick", String(i));
    await expect(page.locator("#lpMeta")).toContainText(p.pool.id.slice(0, 6));
    // reference-path badge: the real source, and refFill must not be hidden behind a fake label
    if (p.refSource) await expect(page.locator("#lpMeta .pill")).toContainText(p.refSource);
    await expect(page.locator("#lpRows tr")).toHaveCount(Object.keys(p.bySession).length);
    // gate label must follow the CI rule: pass only when lo > 0 and loExBest > 0 and robust !== false
    for (const [sess, b] of Object.entries<any>(p.bySession)) {
      const g = p.gate?.[sess];
      const want = !g || !g.days ? "no data" : g.lo > 0 && g.loExBest > 0 && g.robust !== false ? "pass"
        : g.lo > 0 && g.loExBest > 0 ? "under 2 weeks of data" : g.lo > 0 ? (g.loExBest == null ? "CI > 0, best-day check missing" : "fails without best day") : "not yet";
      const row = page.locator("#lpRows tr").filter({ hasText: new RegExp(`^${sess === "pre" ? "pre-market" : sess === "post" ? "post-market" : sess === "reopen" ? "reopen" : sess}`) }).first();
      await expect(row.locator(".pill")).toHaveText(want);
    }
    await expect(page.locator("#lpCards .card")).not.toHaveCount(0);
    await expect(page.locator("#posRows tr")).toHaveCount(Math.min(10, p.pos.length));
  }
  noErrors(page);
});

test("position lookup: rejects junk, then reads uncollected fees live from mainnet", async ({ page }) => {
  await expect(page.locator("#posRows tr").first()).toBeAttached();
  await page.fill("#who", "abc");
  await page.click("#go");
  await expect(page.locator("#whoMsg")).toContainText("Not a valid Solana address");

  // a real position NFT from the published snapshot: its uncollected fees come from mainnet accounts, not the snapshot
  const pool = sewa.pools.find((p: any) => p.pos.length) as any;
  const nft = Array.isArray(pool.pos[0]) ? pool.pos[0][0] : pool.pos[0].nft;
  await page.fill("#who", nft);
  await page.click("#go");
  await expect(page.locator("#whoMsg")).not.toHaveText("searching…", { timeout: 120_000 });
  const msg = (await page.locator("#whoMsg").textContent()) ?? "";
  if (/Public RPC refuses|Lookup failed/.test(msg)) {
    // an honest refusal is an acceptable outcome; an invented row is not
    expect(msg).toMatch(/Public RPC refuses large wallets|Lookup failed/);
    return;
  }
  expect(msg).toContain("uncollected fees read live from mainnet");
  const row = page.locator("#posRows tr").filter({ hasText: nft.slice(0, 6) }).first();
  await expect(row).toBeAttached();
  await expect(row).toContainText(/in range now|out of range now/);
  // the "Uncollected (onchain, exact)" cell holds token amounts computed in the browser from live accounts
  await expect(row.locator("td").nth(5)).toContainText(/\d/);
  noErrors(page);
});

test("owner wallet lookup finds the snapshot's positions", async ({ page }) => {
  await expect(page.locator("#posRows tr").first()).toBeAttached();
  const owner = sewa.pools.flatMap((p: any) => p.pos).map((r: any) => (Array.isArray(r) ? r[6] : r.owner)).find(Boolean);
  expect(owner, "sewa.json must carry a resolved owner").toBeTruthy();
  await page.fill("#who", owner as string);
  await page.click("#go");
  await expect(page.locator("#whoMsg")).not.toHaveText("searching…", { timeout: 150_000 });
  const msg = (await page.locator("#whoMsg").textContent()) ?? "";
  expect(msg).toMatch(/position\(s\) in the audited pools|No positions in the audited pools|Public RPC refuses large wallets/);
  if (/position\(s\)/.test(msg)) await expect(page.locator("#posRows tr").first()).toContainText(/\$|—/);
  noErrors(page);
});

test("devnet read failure shows an error row and Retry recovers", async ({ page }) => {
  await page.route("https://api.devnet.solana.com/**", (r) => r.abort("connectionrefused"));
  await page.locator("#chainRows").waitFor();
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#chainRows .err")).toContainText("Could not read devnet", { timeout: 90_000 });
  await expect(page.locator("#chainRows button[data-retry=chain]")).toHaveCount(1);
  await page.unroute("https://api.devnet.solana.com/**");
  await page.click("#chainRows button[data-retry=chain]");
  await ensureStates(page);
  await expect(page.locator("#chainRows .err")).toHaveCount(0);
});

test("a missing snapshot is reported, not faked", async ({ page }) => {
  await page.route("**/data/fair.json", (r) => r.fulfill({ status: 404, body: "not found" }));
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#fairMeta")).toContainText("Snapshot unavailable");
  await expect(page.locator("#fairRows .err")).toContainText("data/fair.json");
  await expect(page.locator("#fairRows tr")).toHaveCount(1);
});

test("no mock, fake, TODO or coming-soon copy anywhere in the rendered page", async ({ page }) => {
  await expect(page.locator("#fairRows tr")).toHaveCount(fair.rows.length);
  await ensureStates(page);
  const body = (await page.locator("body").innerText()).toLowerCase();
  for (const bad of ["lorem ipsum", "coming soon", "todo", "placeholder", "mock data", "sample data", "dummy", "not implemented", "in the future"])
    expect(body, `rendered page must not say "${bad}"`).not.toContain(bad);
});

test("accessibility basics: names, live regions, tap targets", async ({ page }) => {
  await expect(page.locator("#fairRows tr")).toHaveCount(fair.rows.length);
  const unnamed = await page.evaluate(() => [...document.querySelectorAll("input,select,button")]
    .filter((el) => !(el.getAttribute("aria-label") || el.getAttribute("title") || (el as HTMLElement).innerText?.trim() || el.closest("label")))
    .map((el) => el.id || el.tagName));
  expect(unnamed).toEqual([]);
  expect(await page.locator("[aria-live]").count()).toBeGreaterThanOrEqual(3);
  const small = await page.evaluate(() => [...document.querySelectorAll("a")].filter((a) => a.getBoundingClientRect().height < 24 && a.offsetParent).map((a) => a.textContent));
  expect(small).toEqual([]);
  noErrors(page);
});
