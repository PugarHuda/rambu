# Rambu: Stocklana submission

**One-liner:** Fair prices for tokenized stocks, and an honest P&L for the people who LP them.

**Tracks:** Main (Infrastructure: price feeds, corporate actions, analytics), Pyth.

## Problem
- **Oracles miss dividends between the ex-date and the multiplier update.** SPY went ex-dividend $1.889 on 18 Sep 2026. On 19 Sep the SPYx mint still carried June's multiplier, so any `Pyth equity × multiplier` price read 17bp low. Pyth's own `SPYX/SPY.RR` push account had not updated since 21 Jul.
- **LPs cannot see what they actually earn.** Raydium shows a gross APR. It does not subtract the protocol cut or what arbitrage takes (LVR), and it does not say when during the day the money is made or lost.

## What we built
1. **FairPrice.** Underlying price (Pyth first, clearly labeled fallback otherwise) × the mint's Token-2022 multiplier, plus any dividend that is ex but not yet in the multiplier. Every stock carries a status: `Open`, `Closed`, `Halted`, `Stale` or `CorpActionPending`. Market sessions come from Pyth's `market_session_schedule`.
2. **Onchain.** A keeper writes FairPrice and status into the `rambu` program. Any Solana protocol can CPI `assert_tradable(price)`, which fails when the stock is halted, the state is stale, or the price is outside the band around FairPrice.
3. **LP Audit.** Replays 30 days of the SPYx/USDC Raydium CLMM pools minute by minute. Fees minus LVR are attributed to every live position and split by Pyth session. Paste a wallet to audit your own position.

## Results (live mainnet data, 19 Sep 2026)
- **Chainlink vs naive on SPYx.** Chainlink (Jupiter Lend) was within 0.8bp of FairPrice. The naive oracle was 17.3bp off.
- **10bp pool, 30 days.** $54.8k of LP fees against $16.7k of LVR, **+$38.2k net**. Overnight, weekend and post-market pass a 95% CI gate.
- **1bp pool, 30 days.** +$4.2k net. Regular and pre-market lose money. Post-market and the weekend earn.
- **Pool candles cannot be used for LVR.** Minute closes jump in ±25/±50bp clusters and overstate LVR by 20–60×. We use an external fair path instead: SPY 5m prints, ES futures overnight, bad prints removed.

## Why Solana
- The mint's Token-2022 `ScaledUiAmount` and `Pausable` state are read directly.
- CLMM position state is public, so every LP can be audited without their cooperation.
- `assert_tradable` is one CPI inside a lender's liquidation transaction.

## Demo script (3 min)
1. **0:00, the problem.** Explorer: SPYx mint multiplier 1.005714 (June). SPY dividend on 18 Sep. The FairPrice board shows SPYx `CorpActionPending`: naive −17.3bp, Chainlink −0.8bp.
2. **0:40, onchain.** Run `npm run replay` or the keeper tick, then `npm run demo`:
   - SPYx at $767: liquidation passes.
   - SPYx at $680: `OutsideBand`.
   - QQQx: `Halted` (issuer halt).
3. **1:30, LP Audit.** Session table for both pools. Paste a wallet and see one position: fees $7,427, LVR $734, net +$6,693.
4. **2:20, method and honesty.** Why pool candles lie, and what is unofficial (Yahoo history, until Pyth Pro history is wired in).
5. **2:45, next.** Pyth Pro verified payloads inside `assert_tradable`, swap-level indexing, more pools.

## Deployed (devnet)
- **`rambu`:** [`5REh2DxuEB5j8baJ4Sz2ZFP1WXwnPict8UuYwqPtVUdm`](https://explorer.solana.com/address/5REh2DxuEB5j8baJ4Sz2ZFP1WXwnPict8UuYwqPtVUdm?cluster=devnet)
- **`vault_demo`:** [`EyqD7qbsbPfv3R42XxXgo61JP59ARZKxHLY8H6Suxsjz`](https://explorer.solana.com/address/EyqD7qbsbPfv3R42XxXgo61JP59ARZKxHLY8H6Suxsjz?cluster=devnet)
- **SPYx liquidation at FairPrice, passes:** [tx](https://explorer.solana.com/tx/4i7Y6BEdhtCbFXgL4PCBZJNKAnZHAjK7a54Lp3ZGFuHZtYZQdBjoYhTZHeyreA8Jh3N8nJhjXGJdM6hrBE8nbx3W?cluster=devnet)
- **SPYx at $680:** blocked with `OutsideBand`.
- **QQQx:** blocked with `Halted` (issuer halt).

## Status and limits
- **Pyth Pro token not set yet.** Without it, the underlying price falls back to the xStocks mark and is labeled as such.
- **LP Audit simplifications.** The position set is today's snapshot. LVR is an upper bound (not fee-adjusted).
