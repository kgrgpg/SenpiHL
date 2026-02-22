# Testing Strategy

## Overview

This document outlines the testing strategy for the PnL Indexer, covering unit tests, integration tests, and the rationale behind each test category.

## Testing Philosophy

1. **Test Business Logic First**: The PnL calculator is the core of our application - any bugs here mean incorrect financial reporting
2. **Pure Functions are Easy to Test**: Our calculator uses pure functions, making them deterministic and easy to verify
3. **Mock External Dependencies**: API calls, database, and Redis are mocked in unit tests
4. **Use Marble Testing for Streams**: RxJS provides excellent testing utilities for async streams

## Test Summary

**242 unit tests across 16 files + 10 DB integration + 7 API integration = 259 total**

| Component | Test File | Tests | Focus |
|-----------|-----------|-------|-------|
| PnL Calculator | `src/pnl/calculator.test.ts` | 86 | Trade/funding PnL, position flips, liquidations, summary stats, live unrealized, partial close validation |
| Decimal Utilities | `src/utils/decimal.test.ts` | 32 | Type conversion, precision, aggregation |
| REST Client | `src/hyperliquid/client.test.ts` | 17 | API calls, retries, error handling |
| WebSocket Client | `src/hyperliquid/websocket.test.ts` | 11 | Subscriptions, reconnect, heartbeat, allMids filtering |
| API: Traders | `src/api/routes/v1/traders.test.ts` | 14 | PnL, stats, positions, subscribe/unsubscribe |
| API: Leaderboard | `src/api/routes/v1/leaderboard.test.ts` | 12 | Ranking, timeframes, metrics |
| API: Metrics | `src/api/routes/metrics.test.ts` | 4 | Prometheus endpoint, custom gauges |
| API: Health | `src/api/routes/health.test.ts` | 6 | Liveness and readiness probes |
| Leaderboard Repo | `src/storage/db/repositories/leaderboard.repo.test.ts` | 7 | Delta SQL, time boundaries |
| Stream: with-retry | `src/streams/operators/with-retry.test.ts` | 6 | Retry count, backoff |
| Stream: circuit-breaker | `src/streams/operators/circuit-breaker.test.ts` | 6 | Open/close/half-open states |
| Hybrid Stream | `src/streams/sources/hybrid.stream.test.ts` | 9 | WS fills, polling, 10-user limit, cleanup |
| Trader Discovery | `src/streams/sources/trader-discovery.stream.test.ts` | 11 | Address extraction, queueing, coin subs |
| Price Service | `src/state/price-service.test.ts` | 6 | allMids cache, unknown coin handling |
| Backfill Job | `src/jobs/backfill.test.ts` | 8 | State chaining, progress, resumption |
| Auto-Subscribe | `src/jobs/auto-subscribe.test.ts` | 7 | Queue processing, validation, rate limiting |
| **Subtotal** | **16 files** | **242** | |
| DB Integration | `src/__integration__/db.test.ts` | 10 | CRUD on all tables (gated by `INTEGRATION=1`) |
| API Integration | `src/__integration__/hyperliquid-api.test.ts` | 7 | Live API shape validation (gated by `INTEGRATION=1`) |

## Test Categories

### 1. Unit Tests — PnL Calculator (86 tests)

The most critical tests covering financial calculations:

| Area | Tests | What's Covered |
|------|-------|----------------|
| Core PnL | 39 | `applyTrade`, `applyFunding`, `createSnapshot`, position updates, edge cases |
| Position flips | 5 | Long→short, short→long, flip detection via `startPosition` |
| Liquidations | 3 | `isLiquidation` flag, count tracking |
| WsTrade parsing | 8 | `computeFillFromWsTrade`, buyer/seller mapping, side derivation |
| Summary stats | 8 | Peak, trough, max drawdown, V-recovery, all-negative, monotonic |
| Live unrealized | 5 | Mark price lookup, multi-position, missing prices |
| Partial close validation | 5 | `validateClosedPnl`, divergence calculation, zero positions |
| Edge cases | 13 | Dust amounts, whale positions, negative fees (maker rebates), zero-size |

### 2. API Route Tests (36 tests)

Using Fastify's `inject()` method for HTTP-level testing without starting a server.

| Route Group | Tests | Endpoints |
|-------------|-------|-----------|
| Traders | 14 | `/v1/traders/:address/pnl`, `/stats`, `/positions`, `/subscribe`, `/unsubscribe`, `/backfill` |
| Leaderboard | 12 | `/v1/leaderboard`, `/v1/leaderboard/info` |
| Health | 6 | `/health`, `/ready` |
| Metrics | 4 | `/metrics` (Prometheus format, custom gauges) |

### 3. Stream & Operator Tests (32 tests)

| Component | Tests | Focus |
|-----------|-------|-------|
| with-retry | 6 | Retry count, exponential backoff timing |
| circuit-breaker | 6 | State transitions, threshold, reset |
| Hybrid stream | 9 | WS fills, polling loop, 10-user cap, deferred snapshot |
| Trader discovery | 11 | Address extraction from trades, coin subscriptions, queue dedup |

### 4. Integration Tests (17 tests, gated)

Run with `INTEGRATION=1 npx vitest run src/__integration__/`:

| Suite | Tests | What |
|-------|-------|------|
| DB integration | 10 | Insert/query/upsert on traders, snapshots, trades, funding, data_gaps |
| API integration | 7 | Live Hyperliquid API shape validation, PnL cross-check |

## Running Tests

```bash
# Unit tests (242 tests)
npm test

# Watch mode
npm run test:watch

# With coverage
npm run test:coverage

# Integration tests (requires running DB or live API)
INTEGRATION=1 npx vitest run src/__integration__/

# Run specific file
npx vitest run src/pnl/calculator.test.ts

# Run tests matching pattern
npx vitest run -t "applyTrade"
```

## Test Configuration

### Vitest Setup (`vitest.config.ts`)

- Globals enabled, Node.js environment
- `src/__integration__/` excluded by default (only runs with `INTEGRATION=1`)
- Coverage via V8 provider

### Mocking Strategy

| Dependency | Mock Approach |
|------------|---------------|
| Hyperliquid API | `vi.mock()` with fake responses |
| Database | In-memory or mock query function |
| Redis | Manual mock |
| Time | `vi.useFakeTimers()` for timing tests |

## Coverage Goals

| Category | Target | Rationale |
|----------|--------|-----------|
| PnL Calculator | 100% | Critical business logic |
| API Routes | 90% | User-facing endpoints |
| Utilities | 80% | Helper functions |
| Streams | 70% | Complex async behavior |

## Test File Organization

```
src/
├── pnl/
│   ├── calculator.ts
│   └── calculator.test.ts             # 86 tests — PnL math, edge cases
├── api/routes/
│   ├── health.test.ts                 # 6 tests — liveness/readiness
│   ├── metrics.test.ts                # 4 tests — Prometheus
│   └── v1/
│       ├── traders.test.ts            # 14 tests — trader endpoints
│       └── leaderboard.test.ts        # 12 tests — ranking endpoints
├── hyperliquid/
│   ├── client.test.ts                 # 17 tests — REST client
│   └── websocket.test.ts             # 11 tests — WS client
├── streams/
│   ├── operators/
│   │   ├── with-retry.test.ts         # 6 tests
│   │   └── circuit-breaker.test.ts    # 6 tests
│   └── sources/
│       ├── hybrid.stream.test.ts      # 9 tests
│       └── trader-discovery.stream.test.ts  # 11 tests
├── state/
│   └── price-service.test.ts          # 6 tests
├── storage/db/repositories/
│   └── leaderboard.repo.test.ts       # 7 tests
├── jobs/
│   ├── backfill.test.ts               # 8 tests
│   └── auto-subscribe.test.ts         # 7 tests
├── utils/
│   └── decimal.test.ts                # 32 tests
└── __integration__/
    ├── db.test.ts                     # 10 tests (INTEGRATION=1)
    └── hyperliquid-api.test.ts        # 7 tests (INTEGRATION=1)
```
