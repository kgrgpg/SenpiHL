# Testing Strategy

## Overview

This document outlines the testing strategy for the PnL Indexer, covering unit tests, integration tests, and the rationale behind each test category.

## Testing Philosophy

1. **Test Business Logic First**: The PnL calculator is the core of our application - any bugs here mean incorrect financial reporting
2. **Pure Functions are Easy to Test**: Our calculator uses pure functions, making them deterministic and easy to verify
3. **Mock External Dependencies**: API calls, database, and Redis are mocked in unit tests
4. **Use Marble Testing for Streams**: RxJS provides excellent testing utilities for async streams

## Test Categories

### 1. Unit Tests

#### PnL Calculator (`src/pnl/calculator.test.ts`)

The most critical tests - these verify our financial calculations are correct.

| Function | Test Cases | Why |
|----------|------------|-----|
| `createInitialState` | Zero initialization | Ensures clean slate for new traders |
| `applyTrade` | Single trade, multiple trades, accumulation | Core trade processing logic |
| `applyFunding` | Positive/negative funding | Funding affects realized PnL |
| `calculatePnL` | Combined trades + funding | Integration of all PnL components |
| `calculateUnrealizedPnlForPosition` | Long profit, short profit, losing positions | Mark-to-market calculations |
| `updatePositions` | Add, update, remove positions | Position state management |
| `createSnapshot` | Snapshot generation | Point-in-time capture |

**Edge Cases to Cover:**
- Zero-size positions (position closed)
- Very small decimals (dust amounts like 0.00000001)
- Very large numbers (whale positions)
- Negative fees (maker rebates)
- Position flips (long → short)

#### Hyperliquid Client (`src/hyperliquid/client.test.ts`)

| Function | Test Cases | Why |
|----------|------------|-----|
| `isValidAddress` | Valid/invalid addresses | Input validation |
| `fetchClearinghouseState` | Success, retry, failure | API resilience |
| `fetchUserFills` | Response parsing | Data transformation |
| `fetchUserFunding` | Response parsing | Data transformation |

#### Decimal Utilities (`src/utils/decimal.test.ts`)

| Function | Test Cases | Why |
|----------|------------|-----|
| `toDecimal` | String, number, Decimal inputs | Type conversion |
| `formatDecimal` | Various precision levels | Output formatting |
| `sum`, `mean` | Arrays of decimals | Aggregation accuracy |

### 2. API Route Tests

Using Fastify's `inject()` method for HTTP-level testing without starting a server.

#### Traders Routes (`src/api/routes/v1/traders.test.ts`)

| Endpoint | Test Cases | Why |
|----------|------------|-----|
| `GET /v1/traders/:address/pnl` | Valid request, invalid address, not found | Core query endpoint |
| `GET /v1/traders/:address/stats` | Returns correct shape | Statistics endpoint |
| `POST /v1/traders/:address/subscribe` | Creates trader, idempotent | Subscription flow |

#### Leaderboard Routes (`src/api/routes/v1/leaderboard.test.ts`)

| Endpoint | Test Cases | Why |
|----------|------------|-----|
| `GET /v1/leaderboard` | Default params, custom params | Ranking accuracy |

#### Health Routes (`src/api/routes/health.test.ts`)

| Endpoint | Test Cases | Why |
|----------|------------|-----|
| `GET /health` | Returns ok | Liveness probe |
| `GET /ready` | DB/Redis checks | Readiness probe |

### 3. RxJS Stream Tests (Marble Testing)

Marble testing provides a visual way to test async streams using ASCII diagrams.

#### Operators (`src/streams/operators/*.test.ts`)

| Operator | Test Cases | Why |
|----------|------------|-----|
| `withRetry` | Retry count, backoff timing | Resilience |
| `withCircuitBreaker` | Open/close/half-open states | Fault tolerance |
| `withMetrics` | Counter increments | Observability |

**Marble Diagram Example:**
```
Source:   --a--b--#          (# = error)
Expected: --a--b----a--b--|  (retried once)
```

### 4. Integration Tests

End-to-end flows with real (or containerized) dependencies.

| Flow | Description |
|------|-------------|
| Subscribe → Query | New trader subscription returns empty, then data |
| Backfill → Query | Historical data appears after backfill |
| Stream Processing | Position updates flow through pipeline |

## Test Configuration

### Vitest Setup (`vitest.config.ts`)

```typescript
{
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      exclude: ['**/*.test.ts']
    }
  }
}
```

### Mocking Strategy

| Dependency | Mock Approach |
|------------|---------------|
| Hyperliquid API | `vi.mock()` with fake responses |
| Database | In-memory or mock query function |
| Redis | `ioredis-mock` or manual mock |
| Time | `vi.useFakeTimers()` for timing tests |

## Running Tests

```bash
# Run all tests
npm test

# Watch mode
npm run test:watch

# With coverage
npm run test:coverage

# Run specific file
npx vitest run src/pnl/calculator.test.ts

# Run tests matching pattern
npx vitest run -t "applyTrade"
```

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
│   └── calculator.test.ts      # Unit tests
├── api/
│   └── routes/
│       ├── health.ts
│       ├── health.test.ts      # Route tests
│       └── v1/
│           ├── traders.ts
│           └── traders.test.ts
├── hyperliquid/
│   ├── client.ts
│   └── client.test.ts          # Client tests
├── streams/
│   └── operators/
│       ├── with-retry.ts
│       └── with-retry.test.ts  # Marble tests
└── utils/
    ├── decimal.ts
    └── decimal.test.ts         # Utility tests
```

## CI Integration

Tests run on every push via GitHub Actions:

```yaml
- name: Run tests
  run: npm test

- name: Upload coverage
  uses: codecov/codecov-action@v3
```
