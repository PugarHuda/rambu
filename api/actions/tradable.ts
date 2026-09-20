// Solana Action (Blink): "would assert_tradable pass for this xStock at this price?"
// GET  -> ActionGetResponse with a select of the live devnet states and a price field.
// POST -> builds assert_tradable_v2 for the mint's state PDA, simulates it on devnet (sigVerify off, fee payer = the
//         keeper from Registry) and answers with the real program verdict as an inline completed action.
// Nothing is signed: the verdict comes from the program itself, not from a JS re-implementation.
import { assertTradableV2Ix, checkWith, clusterTime, CORS, explorer, fetchStates, IGNORE_EVENTS, isAddress, REQUIRE_REGULAR_SESSION, simulate } from "../_rambu.ts";

// who is asking: the v2 flags a lender, a DEX or a regular-hours-only protocol would pass
const MODES: Record<string, { label: string; flags: number }> = {
  lender: { label: "Lender liquidation", flags: 0 },
  swap: { label: "Swap (corporate events allowed)", flags: IGNORE_EVENTS },
  regular: { label: "Lender, regular session only", flags: REQUIRE_REGULAR_SESSION },
};

const HEADERS = { ...CORS, "x-action-version": "2.4", "x-blockchain-ids": "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" };
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...HEADERS } });
const icon = (req: Request) => new URL("/icon.svg", req.url).toString();
const money = (x: number) => `$${x.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

async function get(req: Request) {
  const states = await fetchStates();
  const want = new URL(req.url).searchParams.get("ticker") ?? new URL(req.url).pathname.split("/").pop();
  const pre = states.find((s) => s.ticker.toLowerCase() === want?.toLowerCase());
  return reply({
    type: "action",
    icon: icon(req),
    title: pre ? `Rambu: can ${pre.ticker} be liquidated?` : "Rambu: can this xStock be liquidated?",
    description: `Runs the rambu program's assert_tradable on Solana devnet against the keeper's FairPrice state: fails when the stock is halted, the state is stale, a corporate event is pending, or the price is outside the band. ${states.length} live states.`,
    label: "Check",
    links: {
      actions: [{
        type: "post",
        label: "Simulate assert_tradable",
        href: `/api/actions/tradable?ticker={ticker}&price={price}&mode={mode}`,
        parameters: [
          { type: "select", name: "ticker", label: "xStock", required: true,
            options: states.map((s) => ({ label: `${s.ticker} (ref ${money(s.refPrice)}, band ±${s.bandBps / 100}%)`, value: s.ticker, selected: s === pre })) },
          { type: "number", name: "price", label: "Execution price in USD", required: true, min: 0 },
          { type: "select", name: "mode", label: "Caller", required: false, options: Object.entries(MODES).map(([value, m]) => ({ label: m.label, value, selected: value === "lender" })) },
        ],
      }],
    },
  });
}

async function post(req: Request) {
  const q = new URL(req.url).searchParams;
  const body: any = await req.json().catch(() => ({}));
  if (body.account !== undefined && !isAddress(body.account)) return reply({ message: "account is not a valid Solana address" }, 400);
  const price = Number(q.get("price") || 0);
  if (!Number.isFinite(price) || price < 0) return reply({ message: "price must be a non-negative number" }, 400);
  const states = await fetchStates();
  const s = states.find((x) => x.ticker.toLowerCase() === (q.get("ticker") ?? "").toLowerCase() || x.mint === q.get("mint"));
  if (!s) return reply({ message: `unknown ticker; live states: ${states.map((x) => x.ticker).join(", ")}` }, 400);

  const mode = MODES[q.get("mode") ?? "lender"] ?? MODES.lender;
  const priceE6 = BigInt(Math.round(price * 1e6));
  // ponytail: fee payer is the funded keeper (read from Registry) so any visitor can simulate; nothing is signed
  const [sim, now] = await Promise.all([
    simulate(await assertTradableV2Ix(s.mint, priceE6, mode.flags), [{ pubkey: s.key, signer: false, writable: false }]),
    clusterTime(),
  ]);
  const { verdict, logs, unitsConsumed: units } = sim;
  const at = price ? money(price) : "no price";
  const mirror = checkWith(s, now, Number(priceE6), mode.flags);
  const why = verdict === "Tradable"
    ? `assert_tradable_v2 passes: ${mode.label.toLowerCase()} of ${s.ticker} at ${at} would go through.`
    : `assert_tradable_v2 fails with ${verdict}: ${mode.label.toLowerCase()} of ${s.ticker} at ${at} is blocked.`;
  const description = [
    why,
    `Onchain ref ${money(s.refPrice)} ±${s.bandBps / 100}%, halt ${s.haltCode || s.haltKind}, session ${s.sessionName}, updated ${now - s.updatedAt}s ago (max ${s.maxAgeS}s).`,
    `Simulated on devnet (flags ${mode.flags}), ${units} compute units.${mirror !== verdict ? ` (JS mirror says ${mirror}; the program is authoritative.)` : ""}`,
    `Logs: ${logs.filter((l) => !/invoke \[|success$/.test(l)).join(" | ")}`,
    `State: ${explorer("address", s.key)}`,
  ].join("\n");
  return reply({
    type: "post",
    message: `${s.ticker} @ ${at}: ${verdict}`,
    links: { next: { type: "inline", action: { type: "completed", icon: icon(req), title: `${s.ticker} @ ${at}: ${verdict}`, description, label: verdict } } },
    // not part of the Actions spec: raw simulation for API callers
    simulation: { verdict, mode: mode.label, flags: mode.flags, err: sim.err, unitsConsumed: units, logs, state: s.key, feePayer: sim.feePayer, account: body.account ?? null, mirror },
  });
}

export default {
  async fetch(req: Request): Promise<Response> {
    try {
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: HEADERS });
      if (req.method === "GET") return await get(req);
      if (req.method === "POST") return await post(req);
      return reply({ message: "method not allowed" }, 405);
    } catch (e: any) {
      return reply({ message: e.message }, 502);
    }
  },
};
