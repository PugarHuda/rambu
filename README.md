# Rambu

**Live:** https://rambu-kappa.vercel.app · **Repo:** https://github.com/PugarHuda/rambu

**Fair prices for tokenized stocks, and an honest P&L for the people who LP them.**

Two parts that share one price engine:

1. **FairPrice**: what an xStock is worth right now. It uses the underlying price (Pyth), the mint's own Token-2022 multiplier, and a correction for dividends that went ex but that the issuer has not yet folded into the multiplier. It also carries a status: `Open`, `Closed`, `Halted`, `Stale`, or `CorpActionPending`.
2. **LP Audit (SEWA-Replay)**: fees minus LVR for every live position in the SPYx/USDC Raydium CLMM pools, split by Pyth's market-session calendar. Paste a wallet and see your own position.

## What it found (19 Sep 2026, live mainnet)

**FairPrice.**
- SPY went ex-dividend $1.889 on 18 Sep. On 19 Sep the SPYx mint still carried June's multiplier (1.005714), and xStocks had not yet posted the corporate action.
- A naive `Pyth equity × multiplier` oracle reads **17.3bp low**.
- Chainlink (Jupiter Lend vault 78) reads within **0.8bp** of FairPrice.
- The Jupiter DEX price reads 20bp low.

**LP Audit, last 30 days:**

| Pool | Volume | LP fees | LVR | LP net |
|---|---|---|---|---|
| `6truu3` (10bp) | $65.3M | $54.8k | $16.7k | **+$38.2k** |
| `4pCZCV` (1bp) | $125.0M | $10.5k | $6.3k | **+$4.2k** |

- **1bp pool.** Regular and pre-market sessions lose money. Post-market and the weekend earn.
- **10bp pool.** The overnight, weekend and post-market gates pass. The lower bound of the 95% CI is above zero.
- **Neither pool is losing money,** which contradicts a naive estimate built from the pool's own candles. Those minute closes jump in ±25/±50bp clusters, which inflate variance 20–60×.

## Pyth usage

- **Market sessions.** `market_session_schedule` (regular/pre/post/over_night, holidays, early closes) classifies every minute of pool activity.
- **Pyth Pro is live for QQQ and TSLA.** Our key is entitled to those two equity feeds. FairPrice for QQQx from Pyth Pro (724.03) matches Chainlink exactly (0.0bp), and TSLAx is within 1.9bp. The other tickers fall back until equity access is granted.
- **Underlying price.** Pyth Pro (`PYTH_PRO_TOKEN`) is first choice, then Solana push accounts (`pythWSnsw…`) with a staleness check. On 19 Sep the public push accounts for SPY, SPYX/USD and SPYX/SPY.RR were stale (last updates 26 Aug, 12 Sep and 21 Jul). The RR feed still equals the pre-dividend multiplier. FairPrice labels its fallback (`xstocks-mark`) and never passes it off as Pyth.

## Run

```bash
cd keeper
npm install
npm test          # schedule, dividend, fair-price math, LVR replay, splice/despike self-checks
npm run board     # FairPrice snapshot -> web/data/fair.json
npm run audit     # 30-day LP audit -> web/data/sewa.json (≈3 min, GeckoTerminal rate limit)
npm run serve     # http://localhost:8080

# automation (.github/workflows): keeper tick every 10 min on devnet, daily data snapshot -> Vercel redeploy

# onchain (devnet): keeper/.env with RAMBU_PROGRAM_ID, VAULT_PROGRAM_ID, KEEPER_KEYPAIR, SEC_UA
node --env-file=.env keeper.ts --init        # once
node --env-file=.env keeper.ts               # keeper loop (FairPrice -> onchain state)
node --env-file=.env demo.ts SPYx 680        # liquidation blocked: OutsideBand
```

Optional env: `PYTH_PRO_TOKEN`, `MAINNET_RPC`, `TRACK=SPY,QQQ,…`, `DAYS=30`, `POOLS=…`.

## Method

- **Fees.** Each minute's volume × pool fee rate × (1 − protocol and fund cut, read from `AmmConfig`), split pro-rata across the positions in range.
- **LVR.** At every step of the fair price, `r² · L · √P / 4` (Milionis et al., CLMM in-range form). `L` is the in-range liquidity rebuilt from every `PersonalPositionState`. At today's tick it matches the pool's `liquidity` exactly.
- **Fair-price history.** SPY 5-minute prints (regular plus extended hours). Overnight gaps are filled with ES futures returns. Bad prints that revert on the next bar are dropped. The result is × multiplier, plus any pending dividend.
- **Gate.** The daily net for each session must have a 95% bootstrap CI lower bound above zero.

## Limits

- **Position snapshot.** The position set is today's. There is no open/close history yet, which needs swap-level indexing.
- **Fair-price history source.** Historical fair prices come from Yahoo (unofficial) until Pyth Pro history is wired in. Dividends come from Yahoo too, until a licensed corporate-actions feed replaces it.
- **LVR is an upper bound.** The fee-adjusted LVR is lower.
- **Onchain programs.** Deployed on devnet: `rambu` `5REh2DxuEB5j8baJ4Sz2ZFP1WXwnPict8UuYwqPtVUdm`, `vault_demo` `EyqD7qbsbPfv3R42XxXgo61JP59ARZKxHLY8H6Suxsjz`. The next step is to verify Pyth Pro payloads in-transaction.
