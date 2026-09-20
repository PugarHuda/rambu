# Rambu

**Live:** https://rambu-kappa.vercel.app · **Repo:** https://github.com/PugarHuda/rambu

**Fair prices for tokenized stocks, and an honest P&L for the people who LP them.**

Two parts share one price engine:

1. **FairPrice**: what an xStock is worth right now. It takes the underlying price (Pyth), the mint's own Token-2022 multiplier, and a correction for dividends that have gone ex but that the issuer has not yet folded into the multiplier. Each stock also gets a status: `Open`, `Closed`, `Halted`, `Stale` or `CorpActionPending`.
2. **LP Audit (SEWA-Replay)**: fees minus LVR for every live position in the SPYx/USDC Raydium CLMM pools, split by Pyth's market-session calendar. Paste a wallet to see your own positions.

A keeper writes FairPrice and status to the `rambu` program on devnet. Lenders and DEXs check it with one CPI, and wallets, bots and other protocols read it over a JSON API or a Blink.

## What it found (19 Sep 2026, live mainnet)

**FairPrice and lenders** (`web/data/fair.json`, `web/data/lenders.json`):
- SPY went ex-dividend $1.889 on 18 Sep. On 19 Sep the SPYx mint still carried June's multiplier (1.005714), so FairPrice status is `CorpActionPending`.
- A naive `underlying × multiplier` oracle reads SPYx **17.3bp low**.
- **Kamino** reads SPYx through Scope (`CappedFloored → ChainlinkX`) **18.3bp low**. That is the naive number: the dividend is missing. $4.20M of SPYx is deposited in the main market and $0.41M in a second one, so about $8.4k of deposits are misvalued, and the reserves stay open.
- **Jupiter Lend** reads SPYx through Chainlink Data Streams **0.8bp** from FairPrice ($11.9M + $2.2M of SPYx deposits).
- Kamino is also 25.2bp low on NVDAx and 21.8bp high on AAPLx. Jupiter is within 1.9bp on every xStock it lists.

**LP Audit, 30 days to 19 Sep 14:05 UTC** (`web/data/sewa.json`):

| Pool | Volume | LP fees | LVR | LP net |
|---|---|---|---|---|
| `6truu3` (10bp, 648 positions) | $66.0M | $55.4k | $16.5k | **+$38.9k** |
| `4pCZCV` (1bp, 201 positions) | $125.5M | $10.5k | $6.1k | **+$4.4k** |

- **1bp pool.** The regular session (−$411) and pre-market (−$477) lose money. Post-market and the weekend earn, and both pass the 95% CI gate.
- **10bp pool.** Post-market, overnight and weekend pass the gate. Regular and pre-market are positive, but their CIs still include zero.
- **Pool candles cannot measure LVR.** GeckoTerminal minute closes jump in ±25/±50bp clusters, which inflates variance 20–60×. LVR is measured against an external fair path instead.

## Pyth usage

- **Market sessions.** `market_session_schedule` (regular, pre, post and overnight, plus holidays and early closes) labels every minute of pool activity and every keeper push.
- **Pyth Pro: latest and history.** `POST /v1/latest_price` gives the underlying price for FairPrice. `GET /v1/fixed_rate@1000ms/history` gives the minute bars for the LP replay. The free key is entitled to the QQQ and TSLA equity feeds only; SPY, NVDA, AAPL and the xStock and RR feeds return 403. With it, QQQx FairPrice (724.03) matches Chainlink to 0.01bp and TSLAx is 1.85bp from Chainlink.
- **Pyth Pro verified in the transaction.** `assert_tradable_verified` takes a signed Pyth Pro (`solana` format) message, verifies it by CPI to the Pyth Lazer program with the Ed25519 instruction, checks the feed is the one linked to the mint (`FeedLink`: QQQ 1363 and TSLA 1435 are set on devnet), reads the mint's ScaledUiAmount multiplier onchain, and applies the band. Rust unit tests run the parser on a real signed QQQ message. The instruction is deployed on devnet. `keeper/verify-chain.ts` sends every case as a real devnet transaction.
- **Fallback.** Tickers outside the entitlement use the Solana push accounts (`pythWSnsw…`) with a staleness check. On 19 Sep the SPY, SPYX/USD and SPYX/SPY.RR push accounts were stale (last updates 26 Aug, 12 Sep and 21 Jul), so FairPrice falls back to the xStocks mark and labels it `xstocks-mark`. It never presents that price as Pyth.

## Integrate

Program `rambu` on devnet: `5REh2DxuEB5j8baJ4Sz2ZFP1WXwnPict8UuYwqPtVUdm` (IDL: [`web/idl/rambu.json`](web/idl/rambu.json)).

| Account | Seeds | Size |
|---|---|---|
| `Registry` (authority, keeper) | `["registry"]` | 73 |
| `StockState` per xStock | `["rambu", mint]` | 118 |
| `FeedLink` (mint → Pyth Pro feed id) | `["feed", mint]` | 45 |

**CPI from a lender** (from `programs/vault_demo`). The limits can only be tighter than the keeper's; `0` keeps the state value:

```rust
use rambu::cpi::accounts::AssertTradableV2;
use rambu::REQUIRE_REGULAR_SESSION;

rambu::cpi::assert_tradable_v2(
    CpiContext::new(ctx.accounts.rambu_program.key(), AssertTradableV2 { state: ctx.accounts.state.to_account_info() }),
    mint, price_e6, REQUIRE_REGULAR_SESSION, /* max_age_s */ 300, /* max_band_bps */ 200,
)?;
```

Errors are append-only, `6000 + index`: `Stale`, `Halted`, `Paused`, `EventPending`, `OutsideBand`, `BadParam`, `PriceRequired`, `NoReference`, `SessionClosed`, `BadPayload`, `FeedMismatch`, `BadMint`. A lender must pass a nonzero price (`PriceRequired`); only the swap path (`IGNORE_EVENTS` flag) may skip the band. `get_price(mint)` applies the same lender rules and returns `(ref_price_e6: u64, expo: i32 = -6, updated_at: i64)` as return data.

**HTTP API** (CORS `*`, no key):

```bash
# live devnet state + verdict at cluster time; one ticker also runs the program's get_price in simulation
curl 'https://rambu-kappa.vercel.app/api/state?ticker=SPYx'
curl 'https://rambu-kappa.vercel.app/api/state?mint=XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W&price=680'
# snapshot FairPrice row + live onchain state + lender oracle readings for the same mint
curl 'https://rambu-kappa.vercel.app/api/fair?symbol=SPYx'
# keeper push history decoded from devnet transactions (JSON series, or Atom with one entry per status change)
curl 'https://rambu-kappa.vercel.app/api/history?ticker=SPYx&limit=300'
curl 'https://rambu-kappa.vercel.app/api/history?format=atom'
# the program's own verdict: assert_tradable_v2 simulated on devnet (mode = lender | swap | regular)
curl -X POST 'https://rambu-kappa.vercel.app/api/actions/tradable?ticker=SPYx&price=680&mode=lender' -d '{"account":"2Heyq6SB4xN5JBJ9evmR5NG2T2qbXECEqZwBMbWYEYMQ"}'
```

**Blinks** (Solana Actions 2.4, rules in `/actions.json`):
- `https://dial.to/?action=solana-action:https://rambu-kappa.vercel.app/api/actions/tradable&cluster=devnet` returns the program's verdict (for example `SPYx @ $680: OutsideBand`) with its logs and compute units. `/check/SPYx` redirects to it.
- `https://dial.to/?action=solana-action:https://rambu-kappa.vercel.app/api/actions/lp` audits the connected wallet's (or any pasted wallet's) SPYx/USDC positions: range, in-range %, fees, LVR and net from the audit, plus live uncollected fees (`owedUsd`) computed from the position, pool and tick-array accounts. `/lp` redirects to it.

**Refresh SLA.**
- **Onchain.** The keeper polls every 60 s. It pushes on any status change, when the reference moves a quarter of the band, and once a third of `max_age_s` (1800 s) has passed. Past that age, `assert_tradable` fails `Stale`.
- **Snapshots.** `fair.json`, `lenders.json` and `sewa.json` are rebuilt daily at 01:30 UTC.
- **API caching.** Responses are CDN-cached for 30 s (60 s for history).

## Run

```bash
cd keeper
npm install
npm test          # schedule, dividend, fair-price math, LVR/MMR replay, splice/despike, lender decode self-checks
npm run board     # FairPrice + lender snapshot -> web/data/fair.json, lenders.json
npm run audit     # 30-day LP audit -> web/data/sewa.json (≈3 min, GeckoTerminal rate limit)
npm run serve     # http://localhost:8080
node ../api/_rambu.test.ts   # API helpers: PDA derivation, decoders, check mirror, tx layout, fee growth

# onchain (devnet): keeper/.env with RAMBU_PROGRAM_ID, VAULT_PROGRAM_ID, KEEPER_KEYPAIR, SEC_UA, PYTH_PRO_TOKEN
node --env-file=.env keeper.ts               # keeper loop (FairPrice -> onchain state)
node --env-file=.env demo.ts SPYx 680        # liquidation blocked: OutsideBand
node --env-file=.env verify-chain.ts         # every program rule as a real devnet transaction
```

Automation (`.github/workflows`): `keeper.yml` keeps one keeper loop alive on devnet. `snapshot.yml` runs the tests and rebuilds the data files daily, and each commit redeploys Vercel.

## Method

- **Fees.** Each minute's volume × pool fee rate × (1 − protocol and fund cut, read from `AmmConfig`), split pro-rata across the positions in range.
- **LVR.** At every step of the fair price, `r² · L · √P / 4` (Milionis et al., CLMM in-range form). `L` is rebuilt from every `PersonalPositionState`. At today's tick it matches the pool's `liquidity` exactly.
- **Fees vs arbitrage (MMR).** LVR is the loss to frictionless arbitrage. With fees, an arbitrageur trades in a block only with probability `P_trade`, which depends on σ, the fee and the block time (Milionis, Moallemi and Roughgarden, 2023). So arbitrageurs keep `LVR · P_trade`, and the rest, `LVR · (1 − P_trade)`, comes back to LPs as the fees the arbitrageurs pay. The audit reports both parts per session, and it keeps fees from uninformed flow separate from fees paid by arbitrage.
- **Fair-price history.** Pyth Pro minute bars where the key is entitled. Otherwise SPY 5-minute prints (regular and extended hours), with overnight gaps filled from ES futures returns and bad prints that revert on the next bar dropped. The result is × multiplier, plus any pending dividend.
- **Gate.** The daily net for each session must have a 95% bootstrap CI lower bound above zero.

## Limits

- **Position set.** The audit replays today's positions over 30 days. Positions opened after the snapshot appear in the LP Blink with their live range and uncollected fees, but without a replay. Positions closed earlier in the window are not in the set.
- **Offchain sources.** SPY/ES history and dividends come from Yahoo for tickers outside the Pyth Pro entitlement. A licensed corporate-actions feed would replace it.
- **Keeper.** One keeper key is trusted to write state. The program bounds what it can write (band 10–2000bp, max age 60–3600 s), and lenders can tighten both per call.
- **Onchain programs** run on devnet: `rambu` `5REh2DxuEB5j8baJ4Sz2ZFP1WXwnPict8UuYwqPtVUdm`, `vault_demo` `EyqD7qbsbPfv3R42XxXgo61JP59ARZKxHLY8H6Suxsjz`. xStocks mints exist only on mainnet, so the verified path runs against Token-2022 mirrors on devnet that copy the mainnet ScaledUiAmount multiplier (synced when `verify-chain.ts` or `admin.ts --mirror` runs).
