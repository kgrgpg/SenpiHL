# PnL Indexer for Hyperliquid - Architecture Design

> A production-grade PnL indexing service built with reactive streams (RxJS), TimescaleDB, and TypeScript.

## Table of Contents

1. [Technology Stack](#technology-stack)
2. [System Architecture](#system-architecture)
3. [Database Schema Design](#database-schema-design)
4. [PnL Calculation Logic](#pnl-calculation-logic)
5. [Reactive Stream Architecture](#reactive-stream-architecture)
6. [API Design](#api-design)
7. [Project Structure](#project-structure)
8. [Deployment Architecture](#deployment-architecture)
9. [Application Lifecycle](#application-lifecycle)
10. [Testing Strategy](#testing-strategy)
11. [Monitoring and Observability](#monitoring-and-observability)
12. [Production Enhancements](#production-enhancements-time-permitting)
13. [Implementation Roadmap](#implementation-roadmap)

---

## Technology Stack

### Core Technologies

| Technology | Purpose |
|------------|---------|
| **Node.js + TypeScript** | Runtime with strict type checking |
| **RxJS 7** | Declarative data flow, backpressure handling |
| **Fastify** | High-performance REST API framework |
| **TimescaleDB** | Time-series database (PostgreSQL extension) |
| **Redis** | Caching, leaderboards, rate limiting |
| **BullMQ** | Backfill jobs only (persistent, resumable) |
| **Docker Compose** | Container orchestration |

### Production Enhancements (Time Permitting)

| Technology | Purpose | Priority |
|------------|---------|----------|
| **Swagger/OpenAPI** | API documentation & client SDK generation | P1 |
| **API Keys / JWT** | Authentication & access control | P2 |
| **OpenTelemetry** | Distributed tracing & observability | P3 |
| **Grafana** | Pre-built monitoring dashboards | P4 |
| **GitHub Actions** | CI/CD pipeline | P5 |
| **Mercurius** | GraphQL API (stretch goal) | P6 |

### Technology Rationale

**Why RxJS for Data Flows?**
- Declarative stream composition - code reads like a data flow diagram
- Built-in error recovery (`retryWhen`, `catchError`)
- Backpressure handling (`bufferTime`, `throttle`, `debounce`)
- Elegant WebSocket integration via `webSocket()`
- Testable with marble diagrams

**Why TimescaleDB over MongoDB/ClickHouse?**
- **vs MongoDB**: Native time-series partitioning (hypertables), SQL joins, continuous aggregates that auto-update
- **vs ClickHouse**: Better for mixed read/write workloads, simpler operational model, PostgreSQL ecosystem
- **Killer feature**: Continuous aggregates pre-compute hourly/daily rollups automatically

**Why Redis?**
- Sorted sets for O(log N) leaderboard operations
- Sub-millisecond cache lookups for hot data
- Pub/sub for real-time updates (future feature)

**Why BullMQ (minimal)?**
- Only for backfill jobs that need persistence across restarts
- All real-time streaming handled by RxJS (no separate worker process needed)

---

## System Architecture

### High-Level Overview

```mermaid
flowchart TB
    subgraph external [External]
        HL[Hyperliquid API]
        Clients[API Clients]
    end
    
    subgraph gateway [API Gateway - Time Permitting]
        Swagger[Swagger Docs]
        Auth[Authentication]
        RateLimit[Rate Limiter]
    end
    
    subgraph sources [Source Observables]
        positions$["positions$ (interval 30s)"]
        fills$["fills$ (interval 5m)"]
        funding$["funding$ (interval 1h)"]
        ws$["wsEvents$ (real-time)"]
    end
    
    subgraph streams [Stream Processing - RxJS Operators]
        merge[merge streams]
        calculate["map: calculatePnL()"]
        buffer["bufferTime(60s)"]
        retry["retryWhen: exponential backoff"]
    end
    
    subgraph sinks [Sink Subscribers]
        dbSink["DB Sink: TimescaleDB"]
        cacheSink["Cache Sink: Redis"]
        metricsSink["Metrics Sink: Prometheus"]
    end
    
    subgraph api [API Layer]
        FastifyAPI[Fastify REST API]
        Analytics[Portfolio Analytics]
    end
    
    HL --> positions$
    HL --> fills$
    HL --> funding$
    HL --> ws$
    
    positions$ --> merge
    fills$ --> merge
    funding$ --> merge
    ws$ --> merge
    
    merge --> calculate
    calculate --> buffer
    buffer --> retry
    
    retry --> dbSink
    retry --> cacheSink
    retry --> metricsSink
    
    Clients --> Swagger
    Swagger --> Auth
    Auth --> RateLimit
    RateLimit --> FastifyAPI
    
    dbSink --> FastifyAPI
    cacheSink --> FastifyAPI
    FastifyAPI --> Analytics
```

### Reactive Data Flow Concept

All data ingestion and processing is modeled as **Observable streams** that are composed declaratively:

```
Source Observables → Merge → Transform → Buffer → Retry → Sink Subscribers
```

This pattern provides:
- **Separation of concerns**: Data sources, processing, and persistence are decoupled
- **Composability**: Operators can be mixed and matched
- **Error isolation**: Failures in one stream don't crash others
- **Testability**: Each stage can be tested independently

---

## Database Schema Design

### Entity Relationship

```mermaid
erDiagram
    traders ||--o{ trades : "has many"
    traders ||--o{ funding_payments : "has many"
    traders ||--o{ pnl_snapshots : "has many"
    
    traders {
        serial id PK
        varchar address UK
        timestamptz first_seen_at
        timestamptz last_updated_at
        boolean is_active
    }
    
    trades {
        bigserial id PK
        integer trader_id FK
        varchar coin
        varchar side
        numeric size
        numeric price
        numeric closed_pnl
        numeric fee
        timestamptz timestamp PK
        varchar tx_hash
        bigint tid UK
    }
    
    funding_payments {
        bigserial id PK
        integer trader_id FK
        varchar coin
        numeric funding_rate
        numeric payment
        numeric position_size
        timestamptz timestamp PK
    }
    
    pnl_snapshots {
        integer trader_id PK
        timestamptz timestamp PK
        numeric realized_pnl
        numeric unrealized_pnl
        numeric total_pnl
        numeric funding_pnl
        numeric trading_pnl
        integer open_positions
        numeric total_volume
        numeric account_value
    }
```

### Core Tables

**traders** - Trader registry

```sql
CREATE TABLE traders (
    id SERIAL PRIMARY KEY,
    address VARCHAR(42) UNIQUE NOT NULL,
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    is_active BOOLEAN DEFAULT TRUE
);

CREATE INDEX idx_traders_address ON traders(address);
CREATE INDEX idx_traders_active ON traders(is_active) WHERE is_active = TRUE;
```

**trades** - Raw trade fills (hypertable)

```sql
CREATE TABLE trades (
    id BIGSERIAL,
    trader_id INTEGER NOT NULL REFERENCES traders(id),
    coin VARCHAR(20) NOT NULL,
    side VARCHAR(1) NOT NULL,  -- 'B' (buy) or 'A' (ask/sell)
    size NUMERIC(20,8) NOT NULL,
    price NUMERIC(20,8) NOT NULL,
    closed_pnl NUMERIC(20,8),
    fee NUMERIC(20,8),
    timestamp TIMESTAMPTZ NOT NULL,
    tx_hash VARCHAR(66),
    oid BIGINT,
    tid BIGINT UNIQUE,
    PRIMARY KEY (id, timestamp)
);

-- Convert to hypertable (auto-partitions by time)
SELECT create_hypertable('trades', 'timestamp');

-- Indexes for common queries
CREATE INDEX idx_trades_trader_time ON trades(trader_id, timestamp DESC);
CREATE INDEX idx_trades_coin ON trades(coin, timestamp DESC);
```

**funding_payments** - Funding rate payments (hypertable)

```sql
CREATE TABLE funding_payments (
    id BIGSERIAL,
    trader_id INTEGER NOT NULL REFERENCES traders(id),
    coin VARCHAR(20) NOT NULL,
    funding_rate NUMERIC(20,12) NOT NULL,
    payment NUMERIC(20,8) NOT NULL,
    position_size NUMERIC(20,8) NOT NULL,
    timestamp TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (id, timestamp)
);

SELECT create_hypertable('funding_payments', 'timestamp');

CREATE INDEX idx_funding_trader_time ON funding_payments(trader_id, timestamp DESC);
```

**pnl_snapshots** - PnL snapshots at minute granularity (hypertable)

```sql
CREATE TABLE pnl_snapshots (
    trader_id INTEGER NOT NULL REFERENCES traders(id),
    timestamp TIMESTAMPTZ NOT NULL,
    realized_pnl NUMERIC(20,8) NOT NULL,
    unrealized_pnl NUMERIC(20,8) NOT NULL,
    total_pnl NUMERIC(20,8) NOT NULL,
    funding_pnl NUMERIC(20,8) NOT NULL,
    trading_pnl NUMERIC(20,8) NOT NULL,
    open_positions INTEGER NOT NULL,
    total_volume NUMERIC(20,8) NOT NULL,
    account_value NUMERIC(20,8),
    PRIMARY KEY (trader_id, timestamp)
);

SELECT create_hypertable('pnl_snapshots', 'timestamp');

-- Optimized for time-range queries per trader
CREATE INDEX idx_pnl_trader_time ON pnl_snapshots(trader_id, timestamp DESC);
```

### Continuous Aggregates (Pre-computed Rollups)

TimescaleDB's killer feature - materialized views that automatically refresh:

```sql
-- Hourly rollup
CREATE MATERIALIZED VIEW pnl_hourly
WITH (timescaledb.continuous) AS
SELECT 
    trader_id,
    time_bucket('1 hour', timestamp) AS bucket,
    LAST(realized_pnl, timestamp) AS realized_pnl,
    LAST(unrealized_pnl, timestamp) AS unrealized_pnl,
    LAST(total_pnl, timestamp) AS total_pnl,
    LAST(open_positions, timestamp) AS positions,
    MAX(total_volume) - MIN(total_volume) AS volume,
    MAX(total_pnl) AS peak_pnl,
    MIN(total_pnl) AS trough_pnl
FROM pnl_snapshots
GROUP BY trader_id, bucket;

-- Auto-refresh policy: refresh hourly aggregates every 5 minutes
SELECT add_continuous_aggregate_policy('pnl_hourly',
    start_offset => INTERVAL '2 hours',
    end_offset => INTERVAL '1 minute',
    schedule_interval => INTERVAL '5 minutes'
);

-- Daily rollup
CREATE MATERIALIZED VIEW pnl_daily
WITH (timescaledb.continuous) AS
SELECT 
    trader_id,
    time_bucket('1 day', timestamp) AS bucket,
    LAST(realized_pnl, timestamp) AS realized_pnl,
    LAST(unrealized_pnl, timestamp) AS unrealized_pnl,
    LAST(total_pnl, timestamp) AS total_pnl,
    LAST(open_positions, timestamp) AS positions,
    MAX(total_volume) - MIN(total_volume) AS volume,
    MAX(total_pnl) AS peak_pnl,
    MIN(total_pnl) AS trough_pnl
FROM pnl_snapshots
GROUP BY trader_id, bucket;

-- Auto-refresh policy: refresh daily aggregates every hour
SELECT add_continuous_aggregate_policy('pnl_daily',
    start_offset => INTERVAL '2 days',
    end_offset => INTERVAL '1 hour',
    schedule_interval => INTERVAL '1 hour'
);
```

### Data Retention & Compression

```sql
-- Compress data older than 7 days (90%+ storage reduction)
ALTER TABLE pnl_snapshots SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'trader_id'
);

SELECT add_compression_policy('pnl_snapshots', INTERVAL '7 days');

-- Optional: Drop raw minute data older than 90 days (keep aggregates)
SELECT add_retention_policy('pnl_snapshots', INTERVAL '90 days');
```

---

## PnL Calculation Logic

### Components of PnL

```
┌─────────────────────────────────────────────────────────────┐
│                      TOTAL PnL                               │
│                         │                                    │
│         ┌───────────────┴───────────────┐                   │
│         ▼                               ▼                    │
│   ┌─────────────┐               ┌─────────────────┐         │
│   │ REALIZED    │               │ UNREALIZED      │         │
│   │ PnL         │               │ PnL             │         │
│   └──────┬──────┘               └────────┬────────┘         │
│          │                               │                   │
│    ┌─────┴─────┐                        │                   │
│    ▼           ▼                        ▼                   │
│ Trading    Funding               (mark_price - entry)       │
│ PnL        PnL                   × size × direction         │
│ - Fees                                                       │
└─────────────────────────────────────────────────────────────┘
```

**Formulas:**

```
Total PnL = Realized PnL + Unrealized PnL

Realized PnL = Trading PnL + Funding PnL - Fees
  - Trading PnL  = Sum of closed_pnl from all trades
  - Funding PnL  = Sum of all funding payments
  - Fees         = Sum of trading fees

Unrealized PnL = Σ (current_mark_price - entry_price) × position_size × direction
  - direction = 1 for long, -1 for short
```

### Incremental Update Strategy

The key to efficiency is **never recomputing from scratch**:

| Event | Action |
|-------|--------|
| New trade | `realized_pnl += trade.closed_pnl - trade.fee` |
| Funding payment | `funding_pnl += payment.amount` |
| Position change | Recalculate unrealized_pnl for affected coin only |
| Snapshot tick | Store current state to `pnl_snapshots` |

### State Machine

```typescript
interface TraderPnLState {
    traderId: number;
    address: string;
    
    // Cumulative realized (only grows, never recomputed)
    realizedTradingPnl: Decimal;
    realizedFundingPnl: Decimal;
    totalFees: Decimal;
    
    // Current positions (for unrealized calc)
    positions: Map<string, Position>;
    
    // Metrics
    totalVolume: Decimal;
    tradeCount: number;
}

interface Position {
    coin: string;
    size: Decimal;      // Positive = long, negative = short
    entryPrice: Decimal;
    leverage: number;
}
```

### Edge Case Handling

**Position Flips** (long → short or vice versa):

```typescript
function handlePositionUpdate(current: Position | null, newSize: Decimal, price: Decimal) {
    if (!current) {
        // New position
        return { size: newSize, entryPrice: price };
    }
    
    const currentSign = current.size.sign();
    const newSign = newSize.sign();
    
    if (currentSign !== newSign && newSign !== 0) {
        // Position flip: close old, open new
        const closedPnl = calculateClosePnl(current, price);
        return {
            closedPnl,
            newPosition: { size: newSize, entryPrice: price }
        };
    }
    
    // Same direction: update weighted average entry
    // ...
}
```

**Partial Closes**:
- Use weighted average entry price
- `new_entry = (old_entry × old_size + fill_price × fill_size) / new_size`

**Liquidations**:
- Captured via trades with `liquidation: true` flag from Hyperliquid API
- Include in realized PnL (usually a loss)

**Cross-Margin**:
- Use `clearinghouseState` for accurate margin and liquidation price
- Account-level PnL, not per-position

---

## Reactive Stream Architecture

### Core Stream Definitions

```typescript
import { interval, from, merge } from 'rxjs';
import { 
    switchMap, mergeMap, map, share, startWith,
    bufferCount, concatMap, toArray, withLatestFrom,
    tap, filter
} from 'rxjs/operators';

// positions$ - Polls clearinghouseState every 30 seconds
const positions$ = interval(30_000).pipe(
    startWith(0),                                    // Emit immediately on subscribe
    switchMap(() => from(getActiveTraders())),       // Get trader list
    mergeMap(traders => 
        from(traders).pipe(
            bufferCount(50),                         // Batch 50 traders per API call
            concatMap(batch => from(fetchPositions(batch))),
            toArray()
        )
    ),
    map(responses => responses.flat()),
    share()                                          // Multicast to multiple subscribers
);

// fills$ - Polls userFillsByTime every 5 minutes
const fills$ = interval(5 * 60_000).pipe(
    startWith(0),
    withLatestFrom(lastProcessedTime$),
    switchMap(([_, since]) => from(fetchAllFills(since))),
    tap(fills => updateLastProcessedTime(fills)),
    share()
);

// funding$ - Polls funding payments every hour
const funding$ = interval(60 * 60_000).pipe(
    startWith(0),
    switchMap(() => from(fetchFundingPayments())),
    share()
);

// wsEvents$ - Real-time WebSocket events (optional enhancement)
const wsEvents$ = webSocket<HyperliquidEvent>(WS_URL).pipe(
    filter(isRelevantEvent),
    share()
);
```

### Main Pipeline Composition

```typescript
// Merge all data sources into unified event stream
const dataEvents$ = merge(
    positions$.pipe(map(data => ({ type: 'positions' as const, data }))),
    fills$.pipe(map(data => ({ type: 'fills' as const, data }))),
    funding$.pipe(map(data => ({ type: 'funding' as const, data }))),
    wsEvents$.pipe(map(data => ({ type: 'realtime' as const, data })))
);

// Process events and calculate PnL using scan (reducer pattern)
const pnlUpdates$ = dataEvents$.pipe(
    scan((state, event) => updatePnLState(state, event), initialState),
    map(state => computeSnapshots(state)),
    filter(snapshots => snapshots.length > 0)
);

// Buffer snapshots for batch writes (every 60 seconds)
const snapshotBatches$ = pnlUpdates$.pipe(
    bufferTime(60_000),
    filter(batch => batch.flat().length > 0),
    map(batch => batch.flat())
);

// Persist with retry logic
const persistence$ = snapshotBatches$.pipe(
    mergeMap(snapshots => 
        forkJoin({
            db: from(saveToTimescale(snapshots)),
            cache: from(updateRedisCache(snapshots))
        }).pipe(
            retryWhen(errors => errors.pipe(
                scan((retryCount, err) => {
                    if (retryCount > 5) throw err;
                    return retryCount + 1;
                }, 0),
                delayWhen(count => timer(Math.pow(2, count) * 1000))
            ))
        )
    )
);
```

### Custom Operators

**Rate Limiter:**

```typescript
const withRateLimit = <T>(rps: number) => (source$: Observable<T>) =>
    source$.pipe(
        concatMap(item => 
            of(item).pipe(delay(1000 / rps))
        )
    );
```

**Circuit Breaker:**

```typescript
const withCircuitBreaker = <T>(threshold = 5, resetTime = 60_000) => {
    let failures = 0;
    let circuitOpen = false;
    
    return (source$: Observable<T>) => source$.pipe(
        tap({
            next: () => { failures = 0; circuitOpen = false; },
            error: () => { failures++; }
        }),
        retryWhen(errors => errors.pipe(
            delayWhen(() => {
                if (failures >= threshold) {
                    circuitOpen = true;
                    logger.warn('Circuit breaker OPEN');
                    return timer(resetTime).pipe(
                        tap(() => { failures = 0; circuitOpen = false; })
                    );
                }
                return timer(Math.pow(2, failures) * 1000);
            })
        ))
    );
};
```

**Metrics Tap:**

```typescript
const withMetrics = <T>(streamName: string) => (source$: Observable<T>) =>
    source$.pipe(
        tap({
            next: () => metricsCounter.inc({ stream: streamName, result: 'success' }),
            error: () => metricsCounter.inc({ stream: streamName, result: 'error' })
        })
    );
```

### Backfill Jobs (BullMQ)

BullMQ is used **only** for backfill operations that need persistence:

```typescript
import { Queue, Worker } from 'bullmq';
import { lastValueFrom, from } from 'rxjs';
import { concatMap, bufferCount, tap } from 'rxjs/operators';

const backfillQueue = new Queue('backfill', { connection: redisConnection });

// Job processor
const backfillWorker = new Worker('backfill', async (job) => {
    const { traderAddress, fromTime, toTime } = job.data;
    
    // Use RxJS for the actual processing
    await lastValueFrom(
        from(generateTimeRanges(fromTime, toTime, '1 day')).pipe(
            concatMap(range => fetchHistoricalData(traderAddress, range)),
            bufferCount(100),
            concatMap(batch => saveToTimescale(batch)),
            tap((_, index) => job.updateProgress(index))
        )
    );
}, { connection: redisConnection });

// Add a backfill job
await backfillQueue.add('backfill-trader', {
    traderAddress: '0x...',
    fromTime: Date.now() - 30 * 24 * 60 * 60 * 1000,  // 30 days ago
    toTime: Date.now()
});
```

### Rate Limiting Strategy

| Constraint | Solution |
|------------|----------|
| Hyperliquid: ~1200 req/min | `concatMap` + `delay(50)` = 20 RPS |
| Batch efficiency | `bufferCount(50)` traders per API call |
| Burst protection | `throttleTime(100)` on WebSocket events |
| Failure recovery | Exponential backoff: 1s → 2s → 4s → 8s → 16s |
| Sustained failure | Circuit breaker opens after 5 failures, resets after 60s |

---

## API Design

### Endpoints

**GET /traders/:address/pnl**

Query historical PnL data for a trader.

```
Query params:
  - timeframe: 1h | 1d | 7d | 30d (bucket size for response)
  - from: Unix timestamp in seconds (start)
  - to: Unix timestamp in seconds (end)
  - granularity: raw | hourly | daily (optional, auto-selected based on range)
```

Response:

```json
{
    "trader": "0x1234...abcd",
    "timeframe": "1d",
    "data": [
        {
            "timestamp": 1699920000,
            "realized_pnl": "1234.56",
            "unrealized_pnl": "567.89",
            "total_pnl": "1802.45",
            "positions": 3,
            "volume": "50000.00"
        }
    ],
    "summary": {
        "total_realized": "1234.56",
        "peak_pnl": "2500.00",
        "max_drawdown": "-500.00",
        "current_pnl": "1802.45"
    }
}
```

**GET /leaderboard**

Top traders by PnL.

```
Query params:
  - timeframe: 1d | 7d | 30d
  - metric: total_pnl | realized_pnl | roi
  - limit: 10-100 (default 50)
```

Response:

```json
{
    "timeframe": "7d",
    "metric": "total_pnl",
    "data": [
        {
            "rank": 1,
            "address": "0x...",
            "pnl": "125000.00",
            "volume": "5000000.00",
            "trade_count": 342
        }
    ],
    "updated_at": 1699920000
}
```

**GET /traders/:address/stats**

Aggregate statistics for a trader.

```json
{
    "address": "0x...",
    "total_trades": 1523,
    "win_rate": 0.62,
    "avg_profit": "125.50",
    "avg_loss": "-85.20",
    "max_drawdown": "-2500.00",
    "sharpe_ratio": 1.85,
    "first_trade": 1699000000,
    "last_trade": 1699920000
}
```

**POST /traders/:address/subscribe**

Register a trader for tracking.

```json
// Request
{
    "backfill_days": 30  // Optional, default 30
}

// Response
{
    "address": "0x...",
    "status": "tracking",
    "backfill_job_id": "abc123"
}
```

**GET /health** - Liveness probe

**GET /ready** - Readiness probe (DB + streams active)

### Endpoints (Time Permitting)

These endpoints will be added if time permits:

**GET /traders/:address/analytics** (Portfolio Analytics)

```json
{
    "address": "0x...",
    "period": "30d",
    "metrics": {
        "sharpe_ratio": 1.85,
        "sortino_ratio": 2.10,
        "max_drawdown": "-2500.00",
        "max_drawdown_duration_days": 5,
        "win_rate": 0.62,
        "profit_factor": 2.15,
        "expectancy": "45.30",
        "avg_win": "125.50",
        "avg_loss": "-85.20",
        "max_consecutive_wins": 8,
        "max_consecutive_losses": 3,
        "trades_per_day": 12.5
    }
}
```

**POST /webhooks** (Webhook Registration - Stretch Goal)

```json
// Request
{
    "url": "https://my-app.com/webhook",
    "events": ["pnl.threshold"],
    "config": {
        "threshold": 10000,
        "direction": "above"
    }
}

// Response
{
    "id": "wh_abc123",
    "status": "active"
}
```

**GET /docs** - Swagger UI (OpenAPI documentation)

**GET /metrics** - Prometheus metrics endpoint

### API Versioning Strategy

All endpoints will be prefixed with `/v1/` to support future API evolution:

```
/v1/traders/:address/pnl
/v1/traders/:address/stats
/v1/traders/:address/analytics
/v1/leaderboard
/v1/webhooks
```

### Response Caching Strategy

| Endpoint | Cache TTL | Cache Key Pattern |
|----------|-----------|-------------------|
| /pnl (historical) | 5 min | `pnl:{address}:{timeframe}:{from}:{to}` |
| /pnl (recent 1h) | 30 sec | `pnl:{address}:recent` |
| /leaderboard | 1 min | `leaderboard:{timeframe}:{metric}` |
| /stats | 5 min | `stats:{address}` |

---

## Project Structure

```
src/
├── api/
│   ├── routes/
│   │   ├── v1/                      # Versioned routes
│   │   │   ├── traders.ts           # /v1/traders/:address/* endpoints
│   │   │   ├── leaderboard.ts       # /v1/leaderboard endpoint
│   │   │   ├── analytics.ts         # /v1/traders/:address/analytics (time permitting)
│   │   │   └── webhooks.ts          # /v1/webhooks (stretch goal)
│   │   └── health.ts                # /health, /ready, /metrics endpoints
│   ├── schemas/                     # JSON Schema for request/response validation
│   │   ├── pnl.schema.ts
│   │   ├── leaderboard.schema.ts
│   │   └── analytics.schema.ts      # (time permitting)
│   ├── middleware/
│   │   ├── cache.ts                 # Redis cache middleware
│   │   ├── auth.ts                  # API key authentication (time permitting)
│   │   └── rate-limit.ts            # Rate limiting (time permitting)
│   ├── plugins/
│   │   ├── swagger.ts               # OpenAPI documentation (time permitting)
│   │   └── metrics.ts               # Prometheus metrics plugin
│   └── server.ts                    # Fastify setup and plugin registration
│
├── streams/                         # RxJS Stream Definitions
│   ├── sources/                     # Source Observables
│   │   ├── positions.stream.ts      # positions$ - clearinghouseState polling
│   │   ├── fills.stream.ts          # fills$ - trade fills polling
│   │   ├── funding.stream.ts        # funding$ - funding payments polling
│   │   └── websocket.stream.ts      # wsEvents$ - real-time WebSocket
│   ├── operators/                   # Custom RxJS Operators
│   │   ├── rate-limit.ts            # Rate limiting operator
│   │   ├── circuit-breaker.ts       # Circuit breaker pattern
│   │   ├── with-retry.ts            # Configurable retry logic
│   │   └── with-metrics.ts          # Prometheus metrics tap
│   ├── processors/                  # Processing Pipelines
│   │   ├── pnl-calculator.ts        # PnL state machine & calculation
│   │   └── snapshot-generator.ts    # Snapshot batching logic
│   ├── sinks/                       # Output Subscribers
│   │   ├── timescale.sink.ts        # Database persistence
│   │   ├── redis.sink.ts            # Cache updates
│   │   └── metrics.sink.ts          # Prometheus metrics emission
│   └── index.ts                     # Main pipeline composition & export
│
├── hyperliquid/                     # Hyperliquid API Client
│   ├── client.ts                    # REST API wrapper (returns Observables)
│   ├── types.ts                     # API response types
│   └── websocket.ts                 # WebSocket Observable factory
│
├── pnl/                             # PnL Domain Logic (Pure Functions)
│   ├── calculator.ts                # PnL calculation functions
│   ├── state.ts                     # Immutable state management
│   └── types.ts                     # PnL domain types
│
├── analytics/                       # Portfolio Analytics (Time Permitting)
│   ├── metrics.ts                   # Sharpe, Sortino, drawdown calculations
│   ├── streaks.ts                   # Win/loss streak analysis
│   └── types.ts                     # Analytics types
│
├── storage/
│   ├── db/
│   │   ├── client.ts                # PostgreSQL/TimescaleDB connection pool
│   │   ├── migrations/              # SQL migration files
│   │   │   ├── 001_initial.sql
│   │   │   ├── 002_hypertables.sql
│   │   │   └── 003_continuous_aggregates.sql
│   │   └── repositories/            # Data access layer
│   │       ├── traders.repo.ts
│   │       ├── trades.repo.ts
│   │       ├── snapshots.repo.ts
│   │       └── leaderboard.repo.ts
│   └── cache/
│       └── redis.ts                 # Redis client wrapper
│
├── backfill/                        # Historical Data Backfill (BullMQ)
│   ├── queue.ts                     # Queue setup
│   └── processor.ts                 # Job processor (uses RxJS internally)
│
├── webhooks/                        # Webhook System (Stretch Goal)
│   ├── manager.ts                   # Webhook registration & management
│   └── dispatcher.ts                # Event dispatch to webhooks
│
├── utils/
│   ├── decimal.ts               # Decimal.js wrapper for precision math
│   ├── logger.ts                # Pino logger setup
│   ├── config.ts                # Environment configuration
│   └── rx-helpers.ts            # RxJS utility functions
│
├── types/
│   └── index.ts                 # Shared TypeScript types
│
└── index.ts                     # Application entry point
```

### Key Architectural Principles

1. **Streams as First-Class Citizens**: All data flows are Observables
2. **Pure Functions for Logic**: PnL calculations are pure, stateless functions (easy to test)
3. **Operators for Cross-Cutting Concerns**: Rate limiting, retry, circuit breaker as reusable operators
4. **Sinks for Side Effects**: Database writes, cache updates isolated in sink subscribers
5. **Testable**: Marble testing for time-based stream behavior

---

## Deployment Architecture

### Docker Compose Stack

```mermaid
flowchart TB
    subgraph docker [Docker Compose Stack]
        App["app (API + Streams)"]
        DB[(timescaledb)]
        Cache[(redis)]
        Migrations[migrations - one-shot]
    end
    
    App --> DB
    App --> Cache
    Migrations --> DB
```

### Services

| Service | Description | Port |
|---------|-------------|------|
| **app** | Node.js process running API + RxJS streams | 3000 |
| **timescaledb** | TimescaleDB with persistence volume | 5432 |
| **redis** | Redis with AOF persistence | 6379 |
| **migrations** | One-shot migration runner | - |

### docker-compose.yml

```yaml
version: '3.8'

services:
  app:
    build: .
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=production
      - DATABASE_URL=postgresql://postgres:password@timescaledb:5432/pnl_indexer
      - REDIS_URL=redis://redis:6379
    depends_on:
      timescaledb:
        condition: service_healthy
      redis:
        condition: service_healthy
    restart: unless-stopped

  timescaledb:
    image: timescale/timescaledb:latest-pg15
    volumes:
      - timescale_data:/var/lib/postgresql/data
    environment:
      - POSTGRES_USER=postgres
      - POSTGRES_PASSWORD=password
      - POSTGRES_DB=pnl_indexer
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 10s
      timeout: 5s
      retries: 5

  redis:
    image: redis:7-alpine
    volumes:
      - redis_data:/data
    command: redis-server --appendonly yes
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5

  migrations:
    build: .
    command: npm run migrate
    environment:
      - DATABASE_URL=postgresql://postgres:password@timescaledb:5432/pnl_indexer
    depends_on:
      timescaledb:
        condition: service_healthy

volumes:
  timescale_data:
  redis_data:
```

### Why Single Process?

With RxJS, there's no need for a separate worker process:

- Streams run concurrently within the event loop (non-blocking I/O)
- `share()` operator multicasts to multiple subscribers efficiently
- Backpressure is handled by RxJS operators (`bufferTime`, `throttle`)
- Graceful shutdown: `takeUntil(shutdown$)` on all streams

For horizontal scaling, run multiple instances behind a load balancer with Redis-based coordination (e.g., leader election for polling).

---

## Application Lifecycle

### Startup Sequence

```typescript
async function bootstrap() {
    // 1. Initialize connections
    await initializeDatabase();
    await initializeRedis();
    logger.info('Connections established');
    
    // 2. Create shutdown signal
    const shutdown$ = new Subject<void>();
    
    // 3. Start stream pipelines (all takeUntil shutdown$)
    const subscription = mainPipeline$.pipe(
        takeUntil(shutdown$)
    ).subscribe({
        next: () => logger.debug('Pipeline tick'),
        error: (err) => logger.error('Pipeline error', err),
        complete: () => logger.info('Pipeline completed')
    });
    
    // 4. Start API server
    await startFastifyServer();
    logger.info('API server started on port 3000');
    
    // 5. Handle shutdown signals
    process.on('SIGTERM', () => gracefulShutdown(shutdown$, subscription));
    process.on('SIGINT', () => gracefulShutdown(shutdown$, subscription));
}
```

### Graceful Shutdown

```typescript
async function gracefulShutdown(shutdown$: Subject<void>, subscription: Subscription) {
    logger.info('Shutdown initiated');
    
    // Signal all streams to complete
    shutdown$.next();
    shutdown$.complete();
    
    // Wait for in-flight operations (buffered writes)
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // Cleanup
    subscription.unsubscribe();
    await closeDatabaseConnection();
    await closeRedisConnection();
    
    logger.info('Shutdown complete');
    process.exit(0);
}
```

---

## Testing Strategy

### Unit Tests (Pure Functions)

```typescript
describe('PnL Calculator', () => {
    it('should calculate realized PnL from trades', () => {
        const trades = [
            { closedPnl: '100.00', fee: '1.00' },
            { closedPnl: '-50.00', fee: '0.50' }
        ];
        
        const result = calculateRealizedPnL(trades);
        
        expect(result.tradingPnl).toEqual(new Decimal('50.00'));
        expect(result.fees).toEqual(new Decimal('1.50'));
        expect(result.netRealized).toEqual(new Decimal('48.50'));
    });
    
    it('should handle position flip correctly', () => {
        const currentPosition = { size: new Decimal('1.0'), entryPrice: new Decimal('50000') };
        const fill = { size: new Decimal('-1.5'), price: new Decimal('51000') };
        
        const result = handlePositionUpdate(currentPosition, fill);
        
        expect(result.closedPnl).toEqual(new Decimal('1000.00')); // (51000 - 50000) * 1.0
        expect(result.newPosition.size).toEqual(new Decimal('-0.5'));
        expect(result.newPosition.entryPrice).toEqual(new Decimal('51000'));
    });
});
```

### Marble Testing (Streams)

```typescript
import { TestScheduler } from 'rxjs/testing';

describe('Snapshot Generator Stream', () => {
    let scheduler: TestScheduler;
    
    beforeEach(() => {
        scheduler = new TestScheduler((actual, expected) => {
            expect(actual).toEqual(expected);
        });
    });
    
    it('should buffer and emit snapshots every 60s', () => {
        scheduler.run(({ cold, expectObservable }) => {
            // Input: PnL updates arrive at various times
            // Using marble syntax: - = 10ms, a/b/c = emissions
            const pnlUpdates$ = cold('--a--b--------------------c|', {
                a: mockPnLUpdate(100),
                b: mockPnLUpdate(150),
                c: mockPnLUpdate(200)
            });
            
            const result$ = pnlUpdates$.pipe(
                bufferTime(60, scheduler),
                filter(batch => batch.length > 0)
            );
            
            // Expected: first batch at 60ms, second at 120ms
            expectObservable(result$).toBe('--------------------x------(y|)', {
                x: [mockPnLUpdate(100), mockPnLUpdate(150)],
                y: [mockPnLUpdate(200)]
            });
        });
    });
    
    it('should retry on database failure with exponential backoff', () => {
        scheduler.run(({ cold, expectObservable }) => {
            let attempts = 0;
            const failTwiceThenSucceed = () => {
                attempts++;
                if (attempts < 3) {
                    return throwError(() => new Error('DB error'));
                }
                return of('success');
            };
            
            const source$ = cold('a|').pipe(
                mergeMap(() => failTwiceThenSucceed()),
                retry({ count: 3, delay: 1000 })
            );
            
            expectObservable(source$).toBe('-- 1s -- 2s (a|)', { a: 'success' });
        });
    });
});
```

### Integration Tests

```typescript
describe('Full Pipeline Integration', () => {
    beforeAll(async () => {
        await setupTestDatabase();
    });
    
    afterAll(async () => {
        await teardownTestDatabase();
    });
    
    it('should process positions and persist to database', async () => {
        // Mock Hyperliquid API
        const mockPositions = [
            { trader: '0x123', coin: 'BTC', size: '1.0', entryPx: '50000' }
        ];
        jest.spyOn(hyperliquidClient, 'fetchPositions')
            .mockReturnValue(of(mockPositions));
        
        // Run pipeline for one cycle
        await firstValueFrom(
            positions$.pipe(
                take(1),
                switchMap(() => snapshotBatches$.pipe(take(1))),
                mergeMap(batch => from(saveToTimescale(batch)))
            )
        );
        
        // Verify database state
        const saved = await db.query(
            'SELECT * FROM pnl_snapshots WHERE trader_id = $1',
            [1]
        );
        expect(saved.rows).toHaveLength(1);
        expect(saved.rows[0].total_pnl).toBeDefined();
    });
});
```

---

## Monitoring and Observability

### Health Checks

```typescript
// Liveness: app is running
app.get('/health', async () => {
    return { status: 'ok', timestamp: Date.now() };
});

// Readiness: streams are active, DB connected
app.get('/ready', async () => {
    const checks = {
        database: await checkDatabaseConnection(),
        redis: await checkRedisConnection(),
        streams: !mainSubscription.closed
    };
    
    const allHealthy = Object.values(checks).every(Boolean);
    
    if (allHealthy) {
        return { status: 'ready', checks };
    }
    
    throw { statusCode: 503, message: 'Not ready', checks };
});
```

### Prometheus Metrics

```typescript
import { Counter, Histogram, Gauge } from 'prom-client';

// Counters
const snapshotsCreated = new Counter({
    name: 'pnl_snapshots_created_total',
    help: 'Total PnL snapshots created',
    labelNames: ['status']
});

const streamEvents = new Counter({
    name: 'stream_events_total',
    help: 'Total events processed by stream',
    labelNames: ['stream', 'result']
});

// Histograms
const apiLatency = new Histogram({
    name: 'api_request_duration_seconds',
    help: 'API request latency',
    labelNames: ['method', 'route', 'status'],
    buckets: [0.01, 0.05, 0.1, 0.5, 1, 5]
});

const hyperliquidLatency = new Histogram({
    name: 'hyperliquid_api_latency_seconds',
    help: 'Hyperliquid API call latency',
    labelNames: ['endpoint'],
    buckets: [0.1, 0.5, 1, 2, 5, 10]
});

// Gauges
const activeTraders = new Gauge({
    name: 'active_traders_count',
    help: 'Number of traders being tracked'
});

const lastSnapshotTime = new Gauge({
    name: 'last_snapshot_timestamp',
    help: 'Timestamp of last snapshot write'
});
```

### Metrics Operator

```typescript
const withMetrics = <T>(streamName: string) => (source$: Observable<T>) =>
    source$.pipe(
        tap({
            next: () => streamEvents.inc({ stream: streamName, result: 'success' }),
            error: () => streamEvents.inc({ stream: streamName, result: 'error' })
        })
    );

// Usage
const positions$ = createPositionsStream().pipe(
    withMetrics('positions')
);
```

### Logging

Structured JSON logs via Pino:

```typescript
import pino from 'pino';

const logger = pino({
    level: process.env.LOG_LEVEL || 'info',
    formatters: {
        level: (label) => ({ level: label })
    },
    timestamp: pino.stdTimeFunctions.isoTime
});

// Stream logging with tap
const loggingOperator = <T>(name: string) => (source$: Observable<T>) =>
    source$.pipe(
        tap({
            next: (value) => logger.debug({ stream: name, event: 'next' }),
            error: (err) => logger.error({ stream: name, error: err.message }),
            complete: () => logger.info({ stream: name, event: 'complete' })
        })
    );
```

### Alerting Rules (Prometheus)

```yaml
groups:
  - name: pnl-indexer
    rules:
      - alert: IngestionLag
        expr: time() - last_snapshot_timestamp > 300
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "No new snapshots in 5+ minutes"
          
      - alert: StreamErrorRate
        expr: rate(stream_events_total{result="error"}[5m]) > 0.01
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "Stream error rate > 1%"
          
      - alert: APIErrorRate
        expr: rate(api_request_duration_seconds_count{status=~"5.."}[5m]) / rate(api_request_duration_seconds_count[5m]) > 0.01
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "API error rate > 1%"
          
      - alert: DatabaseConnectionFailure
        expr: up{job="timescaledb"} == 0
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "Database connection lost"
```

---

## Production Enhancements (Time Permitting)

The following enhancements elevate the solution to production-grade. They are prioritized and will be implemented if time permits after core functionality is complete.

### P1: API Documentation (Swagger/OpenAPI)

**Justification**: Any production API needs documentation. Enables client SDK generation and interactive testing.

```typescript
// src/api/plugins/swagger.ts
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';

await fastify.register(swagger, {
    openapi: {
        info: {
            title: 'PnL Indexer API',
            version: '1.0.0'
        }
    }
});

await fastify.register(swaggerUi, {
    routePrefix: '/docs'
});
```

### P2: Authentication (API Keys)

**Justification**: Trader PnL data may be sensitive. API keys provide access control and usage tracking.

```typescript
// src/api/middleware/auth.ts
const authenticate = async (request: FastifyRequest) => {
    const apiKey = request.headers['x-api-key'];
    if (!apiKey) {
        throw { statusCode: 401, message: 'API key required' };
    }
    
    const client = await redis.hgetall(`apikey:${apiKey}`);
    if (!client) {
        throw { statusCode: 401, message: 'Invalid API key' };
    }
    
    request.client = client;
};
```

### P3: Rate Limiting

**Justification**: Protect the API from abuse and enable tiered access.

```typescript
// Configuration by tier
const rateLimits = {
    anonymous: { max: 10, window: '1 minute' },
    free: { max: 100, window: '1 minute' },
    premium: { max: 1000, window: '1 minute' }
};
```

### P4: Portfolio Analytics

**Justification**: Derived metrics provide actionable insights beyond raw PnL data.

```typescript
// src/analytics/metrics.ts
interface PortfolioMetrics {
    sharpeRatio: number;      // (avg_return - risk_free) / std_dev
    sortinoRatio: number;     // Uses downside deviation only
    maxDrawdown: number;      // Worst peak-to-trough decline
    winRate: number;          // Winning trades / total trades
    profitFactor: number;     // Gross profit / gross loss
    expectancy: number;       // Expected value per trade
}

function calculateSharpeRatio(returns: number[], riskFreeRate = 0): number {
    const avgReturn = mean(returns);
    const stdDev = standardDeviation(returns);
    return stdDev === 0 ? 0 : (avgReturn - riskFreeRate) / stdDev;
}
```

### P5: OpenTelemetry Tracing

**Justification**: Industry standard for distributed tracing. Essential for production debugging.

```typescript
// src/utils/tracing.ts
import { NodeSDK } from '@opentelemetry/sdk-node';
import { JaegerExporter } from '@opentelemetry/exporter-jaeger';

const sdk = new NodeSDK({
    traceExporter: new JaegerExporter(),
    instrumentations: [
        getNodeAutoInstrumentations()
    ]
});
```

### P6: CI/CD Pipeline (GitHub Actions)

**Justification**: Automated testing and deployment demonstrates production readiness.

```yaml
# .github/workflows/ci.yml
name: CI
on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: npm ci
      - run: npm run lint
      - run: npm test
      - run: npm run build
```

---

## Implementation Roadmap

### Phase 1: Core Functionality (Required)

| Task | Description | Priority |
|------|-------------|----------|
| Project setup | TypeScript, ESLint, Docker | P0 |
| Hyperliquid client | REST API wrapper with RxJS | P0 |
| Data streams | positions$, fills$, funding$ | P0 |
| PnL calculator | Incremental calculation engine | P0 |
| Database layer | TimescaleDB schema, migrations | P0 |
| REST API | `/traders/:address/pnl`, `/health` | P0 |
| Basic tests | Unit tests for PnL logic | P0 |

### Phase 2: Bonus Features (Required)

| Task | Description | Priority |
|------|-------------|----------|
| Leaderboard | `/leaderboard` with Redis ZSET | P1 |
| Delta PnL | Change calculations between snapshots | P1 |
| Backfill | BullMQ job for historical data | P1 |
| Caching | Redis cache layer with TTL | P1 |

### Phase 3: Production Enhancements (Time Permitting)

| Task | Description | Priority |
|------|-------------|----------|
| Swagger docs | OpenAPI specification | P2 |
| Authentication | API key middleware | P2 |
| Rate limiting | Per-client limits | P2 |
| Analytics | Sharpe, Sortino, drawdown | P2 |
| OpenTelemetry | Distributed tracing | P3 |
| Grafana | Pre-built dashboards | P3 |
| CI/CD | GitHub Actions pipeline | P3 |

### Phase 4: Stretch Goals (If Time Allows)

| Task | Description | Priority |
|------|-------------|----------|
| GraphQL API | Alternative query interface | P4 |
| Webhooks | Push notifications on thresholds | P4 |
| Position history | Track position changes over time | P4 |

---

## Summary

This architecture provides a production-grade foundation for a PnL indexing service:

- **Reactive streams** (RxJS) for declarative, testable data flows
- **TimescaleDB** for efficient time-series storage with automatic aggregation
- **Redis** for caching, leaderboards, and rate limiting
- **Fastify** for high-performance API serving
- **Defense in depth** error handling with retry, circuit breaker, and graceful degradation

The modular design allows core functionality to be delivered first, with production enhancements layered on as time permits.
