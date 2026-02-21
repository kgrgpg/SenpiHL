# PnL Indexer - Architecture Overview

> Executive summary. A senior engineer should understand the system in ~3 minutes.

---

## 1. System Overview

Production-grade PnL indexing service for Hyperliquid perpetuals. Ingests real-time fills via WebSocket and REST (positions, funding), computes incremental PnL in-memory, and persists snapshots to TimescaleDB. REST API serves historical PnL, leaderboards, and trader stats. Redis caches hot queries. Backfill job reconstructs historical snapshots from Hyperliquid REST.

```
┌─────────────────────────────────────────────────────────────────┐
│                    DATA FLOW                                     │
│                                                                  │
│  Hyperliquid WS ──┬──> trades table (individual fills)           │
│                   └──> PnL Calculator ──> pnl_snapshots          │
│                                                                  │
│  Hyperliquid REST ──> Position snapshots ──> unrealized PnL      │
│                                                                  │
│  Backfill Job ──> Historical trades + funding ──> snapshots       │
│                                                                  │
│  REST API <── TimescaleDB (snapshots, aggregates, trades)         │
│          <── Redis (leaderboard cache)                           │
└─────────────────────────────────────────────────────────────────┘
```

**Stack:** Node.js, TypeScript, RxJS, Fastify, TimescaleDB, Redis, BullMQ.

---

## 2. Database Schema

| Table | Key Columns | Notes |
|-------|-------------|-------|
| **traders** | id, address, is_active | Trader registry |
| **trades** | trader_id, coin, side, size, price, closed_pnl, fee, timestamp, tid | Hypertable |
| **funding_payments** | trader_id, coin, payment, timestamp | Hypertable |
| **pnl_snapshots** | trader_id, timestamp, realized_pnl, unrealized_pnl, total_pnl, volume | Hypertable |
| **pnl_hourly** | trader_id, bucket (1h), realized/unrealized/total_pnl, volume | Continuous aggregate |
| **pnl_daily** | trader_id, bucket (1d), realized/unrealized/total_pnl, volume | Continuous aggregate |

---

## 3. PnL Calculation

```
Total PnL = Realized PnL + Unrealized PnL

Realized PnL = Trading PnL + Funding PnL - Fees
  - Trading PnL  = Sum of closed_pnl from all trades
  - Funding PnL  = Sum of funding payments
  - Fees         = Sum of trading fees

Unrealized PnL = Σ (mark_price - entry_price) × size × direction
  - Uses API-provided unrealizedPnl (mark-price based)
  - direction = 1 for long, -1 for short
```

**Incremental:** Each trade/funding event updates running totals; no full recompute.

---

## 4. Query Strategy

| Timeframe | Query Target | Rationale |
|-----------|--------------|-----------|
| < 24h | `pnl_snapshots` (raw) | Fine-grained precision |
| 1–7d | `pnl_hourly` (fallback to raw) | Pre-computed, faster |
| > 7d | `pnl_daily` (fallback to raw) | Minimal data, fastest |
| Exact trade-level | `trades` table | Per-fill analytics |

---

## 5. Edge Cases Handled

| Case | Handling |
|------|----------|
| **Position flips** | Detected via `startPosition` / `dir` from API; close old position, open new |
| **Liquidations** | Tracked via `isLiquidation` flag on fills |
| **Cross-margin** | `marginType` (cross/isolated) per position; account-level PnL |
| **Mark price** | Uses API-provided `unrealizedPnl` (mark-price based) |
| **Partial closes** | Weighted average entry: `(old_entry × old_size + fill_price × fill_size) / new_size` |

---

## 6. Weight-Based Rate Budget

Hyperliquid rate limits are **weight-based**: 1,200 weight/min per IP. We target 80% (960 weight/min):

| Consumer | Priority | Weight Cost | Typical Usage |
|----------|----------|-------------|--------------|
| On-demand user queries | Highest | 60/query (portfolio+fills+funding) | Varies |
| Position polling | Medium | 2/trader (clearinghouseState) | 400 weight/min |
| Backfill workers | Fills remaining | 40/chunk (fills+funding) | ~500 weight/min |

**WebSocket limits**: Max 10 unique users for `userFills`. We subscribe the first 10 traders; rest are polling-only. Discovery uses coin-level `trades` subscriptions (BTC, ETH, SOL) at zero weight cost.

**Heartbeat**: 30s ping prevents 60s idle timeout.

Unknown traders return live data on first request (no 404) -- fetched from Hyperliquid in ~2s, then backfilled in background.

Full rate limit analysis: [RATE_LIMIT_ANALYSIS.md](./RATE_LIMIT_ANALYSIS.md)

---

## 7. Full Documentation

For the complete architecture including data flow diagrams, storage trade-off analysis, caching strategy, and query performance benchmarks, see [ARCHITECTURE.md](./ARCHITECTURE.md).
