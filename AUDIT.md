# Code Audit Report

**Date:** 2026-02-20
**Scope:** Full codebase review against REQUIREMENTS.md

---

## Requirements Compliance

| Requirement | Status | Notes |
|-------------|--------|-------|
| **Data Ingestion** (positions + trades) | ✅ Done | Hybrid WebSocket + REST |
| **PnL Computation** (realized + unrealized) | ✅ Done | Calculator with incremental updates |
| - Position entries/exits | ✅ Done | Via `closedPnl` from API |
| - Funding rate payments | ✅ Done | Via funding stream |
| - **Liquidations** | ⚠️ Partial | Treated as regular trades, no special handling |
| **Time-Series Storage** (configurable intervals) | ✅ Done | TimescaleDB hypertables |
| **Query API** (GET /traders/:address/pnl) | ✅ Done | With timeframe, from, to, granularity |
| **Response format** matches spec | ✅ Done | Extra `current_pnl` field (non-breaking) |
| **Arbitrary time ranges** | ✅ Done | ±30s precision via delta snapshots |
| **Thousands of traders** | ✅ Done | Hybrid mode scales to ~5k |
| **Incremental updates** | ✅ Done | Never recomputes from scratch |
| **Data consistency during ingestion** | ✅ Done | Gap detection, `data_status` metadata, `validateClosedPnl` divergence logging |
| **Edge cases**: position flips | ✅ Done | `isPositionFlip()` + `flipCount` tracking |
| **Edge cases**: partial closes | ✅ Done | `validateClosedPnl` cross-checks against local entry price tracking |
| **Edge cases**: cross-margin | ✅ Done | `marginType` on `PositionData`, passed from API |
| **Mark price vs last price** | ✅ Done | `calculateLiveUnrealizedPnl` uses allMids mark prices via price service |
| **Leaderboard** (bonus) | ✅ Done | Delta calculation, dual-source |
| **Delta PnL** (bonus) | ✅ Done | Latest - earliest snapshot |
| **Backfill** (bonus) | ✅ Done | State chained with `mergeScan` |
| **Cache layer** (bonus) | ✅ Done | Redis `cacheGet`/`cacheSet` wired in leaderboard route |
| **Docker Compose** | ✅ Done | App + TimescaleDB + Redis + Migrations |
| **Tests** for PnL logic | ✅ Done | 39 tests in calculator.test.ts |
| **Documentation** | ✅ Done | Extensive (ARCHITECTURE.md, README, CHANGELOG) |

---

## Critical Bugs

### BUG-1: Backfill state not chained between chunks

**File:** `src/jobs/backfill.ts` line ~169
**Severity:** Critical
**Impact:** Historical snapshots from backfill have incorrect cumulative PnL values

Each day-chunk resets to `initialState` instead of carrying forward the accumulated
state from the previous chunk. Only the last chunk's final snapshot is correct.

```typescript
// CURRENT (wrong): every chunk starts from zero
from(dayChunks).pipe(
  concatMap(c => processChunk$(address, c, initialState))
)

// CORRECT: chain state between chunks
from(dayChunks).pipe(
  concatMap(c => processChunk$(address, c, previousChunkState))
)
```

### BUG-2: Redis caching scaffolded but not wired

**File:** `src/storage/cache/redis.ts`, `src/api/routes/v1/leaderboard.ts`
**Severity:** Medium
**Impact:** Leaderboard queries always hit the database. Architecture docs claim caching is done.

Redis has `cacheGet`, `cacheSet`, `leaderboardAdd`, `leaderboardGetTop` functions
implemented but the leaderboard route queries the database directly without checking
or updating cache.

---

## Dead Code / Unused Schema (All Resolved)

| Component | Location | Status |
|-----------|----------|--------|
| `trades` table | `migrations/001_initial.sql` | ✅ Actively written to by hybrid fill capture |
| `funding_payments` table | `migrations/001_initial.sql` | ✅ Used by backfill job |
| `data_gaps` table | `migrations/004_data_tracking.sql` | ✅ Used by gap detector and surfaced in PnL responses |
| `calculateUnrealizedPnlForPosition()` | `src/pnl/calculator.ts` | ✅ Used by `calculateLiveUnrealizedPnl` in positions endpoint |
| Redis leaderboard functions | `src/storage/cache/redis.ts` | ✅ `cacheGet`/`cacheSet` wired in leaderboard route |

---

## Edge Cases (All Resolved)

### Position Flips (long → short in one trade)
✅ `isPositionFlip()` detects flips via `startPosition` field. `flipCount` tracked in state. `computeFillFromWsTrade` correctly splits closedPnl on close portion only.

### Partial Closes
✅ `updatePositionFromFill()` tracks weighted average entry prices. `validateClosedPnl()` cross-checks Hyperliquid's `closedPnl` against our local computation and logs divergence.

### Liquidations
✅ `isLiquidation` flag parsed from API. `liquidationCount` tracked in state. Liquidations are logged and counted separately from regular trades.

### Cross-Margin
✅ `marginType: 'cross' | 'isolated'` stored on `PositionData`, parsed from API's `leverage.type`. Exposed in positions endpoint.

### Mark Price vs Last Price
✅ `calculateLiveUnrealizedPnl()` uses allMids mark prices from the price service to compute live unrealized PnL. Positions endpoint returns both polled `unrealized_pnl` and live `live_unrealized_pnl`.

---

## Test Coverage

| Component | Coverage | Tests |
|-----------|---------|-------|
| PnL calculator | ✅ Good | 86 tests (was 39) |
| Decimal utilities | ✅ Good | 32 tests |
| API routes (traders) | ✅ Good | 14 tests |
| API routes (leaderboard) | ✅ Good | 12 tests |
| API routes (metrics) | ✅ Good | 4 tests |
| Leaderboard repo (delta) | ✅ Good | 7 tests |
| Health routes | ✅ Good | 6 tests |
| Stream operators | ✅ Good | 12 tests |
| Backfill job | ✅ Good | 8 tests |
| Auto-subscribe job | ✅ Good | 7 tests |
| Trader discovery stream | ✅ Good | 11 tests |
| Hybrid stream | ✅ Good | 9 tests |
| WebSocket client | ✅ Good | 11 tests |
| Price service | ✅ Good | 6 tests |
| Client (REST) | ✅ Good | 17 tests |
| Summary (peak, drawdown) | ✅ Good | 8 tests in calculator |
| Live unrealized PnL | ✅ Good | 5 tests in calculator |
| Partial close validation | ✅ Good | 5 tests in calculator |
| DB integration | ✅ Good | 10 tests (INTEGRATION=1) |

**Total: 242 unit tests across 16 files + 10 DB integration tests.**

---

## Documentation Gaps

All previously identified documentation gaps have been resolved.

---

## Fix Priority & Resolution Status

### P0 — Bugs

1. ✅ **FIXED: Backfill state chaining** — Used `mergeScan` (concurrency 1) to chain state between day chunks
2. ✅ **FIXED: Redis caching** — Wired up `cacheGet`/`cacheSet` in leaderboard route with per-timeframe TTL

### P1 — Required by spec

3. ✅ **FIXED: Liquidation handling** — Added `isLiquidation` field, `liquidationCount` tracking
4. ✅ **FIXED: Position flip detection** — Added `isPositionFlip()` function, `flipCount` tracking
5. ✅ **FIXED: Cross-margin awareness** — Added `marginType` to `PositionData`, passed from API

### P2 — Quality

6. ✅ **FIXED: Tests for backfill, auto-subscribe, discovery** — All have test coverage now
7. ✅ **FIXED: Schema documentation** — Added migration 005 documenting active vs reserved tables
8. ✅ **FIXED: Undocumented routes** — Added to README

### P3 — Remaining (all resolved in v1.4.0)

9. ✅ **FIXED: DB integration tests** — 10 tests covering traders, snapshots, trades, funding, data_gaps tables (INTEGRATION=1)
10. ✅ **FIXED: Summary calculation tests** — `calculateSummaryStats` extracted to pure function with 8 tests (peak, drawdown, V-recovery, all-negative, etc.)
11. ✅ **VERIFIED: All referenced docs exist**
12. ✅ **FIXED: Dead code `calculateUnrealizedPnlForPosition`** — Now used via `calculateLiveUnrealizedPnl` in positions endpoint with live mark prices
13. ✅ **FIXED: Price service not wired** — allMids prices now enrich positions endpoint with `live_unrealized_pnl`
14. ✅ **FIXED: No Prometheus endpoint** — `GET /metrics` exposes prom-client registry + application gauges
15. ✅ **FIXED: Partial close validation** — `validateClosedPnl` cross-checks HL's closedPnl against local position state, logs divergence
