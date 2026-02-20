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
| **Data consistency during ingestion** | ⚠️ Weak | No reconciliation between trade/position state |
| **Edge cases**: position flips | ❌ Missing | Not detected or handled |
| **Edge cases**: partial closes | ❌ Missing | Relies entirely on API `closedPnl` |
| **Edge cases**: cross-margin | ❌ Missing | All positions treated identically |
| **Mark price vs last price** | ⚠️ Delegated | Uses API-provided unrealized PnL |
| **Leaderboard** (bonus) | ✅ Done | Delta calculation, dual-source |
| **Delta PnL** (bonus) | ✅ Done | Latest - earliest snapshot |
| **Backfill** (bonus) | ⚠️ Bug | State not chained between day chunks |
| **Cache layer** (bonus) | ⚠️ Scaffolded | Redis functions exist but NOT wired up |
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

## Dead Code / Unused Schema

| Component | Location | Status |
|-----------|----------|--------|
| `trades` table | `migrations/001_initial.sql` | Schema exists, **nothing writes to it** |
| `funding_payments` table | `migrations/001_initial.sql` | Schema exists, **nothing writes to it** |
| `data_gaps` table | `migrations/004_data_tracking.sql` | Schema exists, **not used anywhere** |
| `calculateUnrealizedPnlForPosition()` | `src/pnl/calculator.ts` | Function exists, **never called** in production |
| Redis leaderboard functions | `src/storage/cache/redis.ts` | Functions exist, **never called** |

---

## Edge Cases Not Handled

### Position Flips (long → short in one trade)

`applyTrade()` in `calculator.ts` adds `closedPnl` without detecting flips.
Position updates come separately via snapshots, so between a flip trade and the
next snapshot, internal position state is stale. No validation that the API's
`closedPnl` matches expected flip PnL.

### Partial Closes

No weighted average entry price tracking. Relies entirely on Hyperliquid's
`closedPnl` field. If the API value is incorrect, we have no way to detect it.

### Liquidations

`HyperliquidFill` includes a `liquidation` field but `applyTrade()` treats
liquidations identically to regular trades. No detection, logging, or special
handling of liquidation events.

### Cross-Margin

`HyperliquidPosition` includes `leverage.type: 'cross' | 'isolated'` but PnL
calculation treats all positions the same. Cross-margin positions should aggregate
unrealized PnL at the account level, not per-position.

### Mark Price vs Last Price

`calculateUnrealizedPnlForPosition()` exists but is never called. Production code
uses the API-provided `unrealizedPnl` value directly, giving us no control over
which price basis is used.

---

## Test Coverage Gaps

| Component | Coverage | Tests |
|-----------|---------|-------|
| PnL calculator | ✅ Good | 39 tests |
| Decimal utilities | ✅ Good | 32 tests |
| API routes (traders) | ⚠️ Partial | 10 tests, all mocked |
| API routes (leaderboard) | ⚠️ Partial | 9 tests, all mocked |
| Leaderboard repo (delta) | ⚠️ Partial | 7 tests, all mocked |
| Health routes | ✅ Good | 6 tests |
| Stream operators | ✅ Good | 12 tests |
| **Backfill job** | ❌ Zero | 0 tests |
| **Auto-subscribe job** | ❌ Zero | 0 tests |
| **Trader discovery stream** | ❌ Zero | 0 tests |
| **Stream pipeline (e2e)** | ❌ Zero | 0 tests |
| **Position flip handling** | ❌ Zero | 0 tests |
| **Liquidation handling** | ❌ Zero | 0 tests |
| **Summary (peak, drawdown)** | ❌ Zero | Calculation untested |

**Total: 132 tests across 9 files. 3 critical subsystems have zero coverage.**

---

## Documentation Gaps

| Issue | Details |
|-------|---------|
| Undocumented routes | `GET /v1/traders/:address/backfill` and `POST /v1/traders/:address/backfill` not in README |
| Architecture claims caching done | But Redis caching is not wired up |
| README references docs that may not exist | `DESIGN_DECISIONS.md`, `TESTING.md`, `VERIFICATION.md`, `RATE_LIMITS.md`, `DATA_COMPLETENESS.md`, `LEADERBOARD.md` |

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

6. **Tests for backfill, auto-subscribe, discovery** — Still needed
7. ✅ **FIXED: Schema documentation** — Added migration 005 documenting active vs reserved tables
8. ✅ **FIXED: Undocumented routes** — Added to README

### P3 — Remaining

9. Integration tests with real DB/Redis
10. Summary calculation tests (peak_pnl, max_drawdown)
11. ✅ **VERIFIED: All referenced docs exist** — DESIGN_DECISIONS.md, TESTING.md, VERIFICATION.md, RATE_LIMITS.md, DATA_COMPLETENESS.md, LEADERBOARD.md all present
