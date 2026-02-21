# Design Decisions

> Key architectural decisions, options considered, and reasoning. ADR format: Context, Options, Decision, Rationale.

## Table of Contents

1. [Message Queue: Kafka vs Alternatives](#1-message-queue-kafka-vs-alternatives)
2. [Trader Tracking Strategy](#2-trader-tracking-strategy)
3. [Database Choice: TimescaleDB vs Alternatives](#3-database-choice-timescaledb-vs-alternatives)
4. [Polling vs WebSocket](#4-polling-vs-websocket)
5. [PnL Calculation Strategy](#5-pnl-calculation-strategy)
6. [Snapshot Granularity](#6-snapshot-granularity)
7. [Caching Strategy](#7-caching-strategy)
8. [Error Handling & Resilience](#8-error-handling--resilience)
9. [Data Storage: Trades + Snapshots](#9-data-storage-trades--snapshots)

---

## 1. Message Queue: Kafka vs Alternatives

### Context

Whether to introduce a message queue between data ingestion and processing, and which technology.

### Options Considered

| Option | Pros | Cons |
|--------|------|------|
| **Kafka** | Industry standard, replay, multi-consumer | Overkill for ~100 TPS, 3+ containers |
| **Redis Streams** | Already in stack, lightweight | Less ecosystem, single node limits |
| **BullMQ** | Already in stack, retries | Job-oriented, not streaming |
| **NATS** | Fast, simple | Limited persistence |
| **In-process RxJS** | Zero latency, simple | No cross-service, no replay |

### Decision

**Chosen: In-process RxJS streams**

### Rationale

Throughput bounded by Hyperliquid API (~20 RPS). At ~50–100 events/sec, Kafka's complexity isn't justified. External API is the bottleneck. Redis Streams is the fallback if cross-service or replay is needed.

---

## 2. Trader Tracking Strategy

### Context

How traders are discovered and how many to support.

### Options Considered

| Option | Description | Max Traders | Update Frequency |
|--------|-------------|-------------|------------------|
| **On-demand only** | Track when explicitly requested | Unlimited (lazy) | Real-time for tracked |
| **Auto-discovery** | Scan for all active traders | 100K+ | Rate limit dependent |
| **Hybrid** | On-demand + top N by volume | 10K–50K | Tiered by activity |

### Decision

**Chosen: On-demand** (start with explicit registration, add discovery later)

### Rationale

Rate limits: 1,000 traders @ 60s = 16.7 RPS ✓. Single instance + WebSocket + polling supports ~10K traders. Hybrid/tiered polling can scale further.

---

## 3. Database Choice: TimescaleDB vs Alternatives

### Context

PnL is time-series (snapshots) plus relational (traders → trades → positions).

### Options Considered

| Option | Pros | Cons |
|--------|------|------|
| **TimescaleDB** | Hypertables, continuous aggregates, compression, PostgreSQL | Learning curve |
| **PostgreSQL** | Simple, ACID | Manual partitioning |
| **MongoDB** | Flexible schema | Poor time-series joins, 16MB doc limit |
| **ClickHouse** | Fast analytics | Batched inserts, less OLTP |
| **InfluxDB** | Purpose-built TS | Limited query language |

### Decision

**Chosen: TimescaleDB**

### Rationale

Hypertables for auto time-partitioning; continuous aggregates for hourly/daily rollups; 90%+ compression; SQL joins across traders/trades/snapshots; PostgreSQL ecosystem.

---

## 4. Polling vs WebSocket

### Context

Hyperliquid offers REST (polling) and WebSocket. How to ingest data.

### Options Considered

| Option | Pros | Cons |
|--------|------|------|
| **Polling only** | Simple, predictable | Latency, wasted requests |
| **WebSocket only** | Real-time, efficient | Connection mgmt, may miss state |
| **Hybrid** | Best of both | More complex |

### Decision

**Chosen: Hybrid**

### Rationale

WebSocket for trade fills and order events (real-time). Polling for `clearinghouseState` (authoritative position snapshots). WebSocket = "what happened"; polling = "current state."

---

## 5. PnL Calculation Strategy

### Context

Calculate realized and unrealized PnL. Approach affects accuracy and performance.

### Options Considered

| Option | Pros | Cons |
|--------|------|------|
| **Full recomputation** | Always accurate | O(n) per update |
| **Incremental updates** | O(1) updates | Edge cases must be correct |
| **Event sourcing** | Full audit trail | Storage, complexity |

### Decision

**Chosen: Incremental updates**

### Rationale

Maintain running totals: on trade → `realized_pnl += closed_pnl - fee`; on funding → add payment; on position Δ → recalc unrealized for that coin. Handle position flip (split close+open), partial close (weighted avg), liquidation (realized loss).

---

## 6. Snapshot Granularity

### Context

Store PnL snapshots at regular intervals. Finer = more flexibility, higher storage.

### Options Considered

| Granularity | Storage (1000 traders, 1 year) | Query Flexibility |
|-------------|-------------------------------|-------------------|
| Per-trade | ~50GB+ | Maximum |
| 1 minute | ~5GB (uncompressed) | High |
| 5 minutes | ~1GB | Medium |
| 1 hour | ~100MB | Low |

### Decision

**Chosen: 1-minute snapshots with compression and retention**

### Rationale

1-minute balances flexibility and storage. TimescaleDB compression (~90% reduction after 7 days). Optional retention: drop raw after 90 days, keep hourly/daily aggregates.

---

## 7. Caching Strategy

### Context

API queries need to be fast. What to cache and how to invalidate.

### Options Considered

| Strategy | Pros | Cons |
|----------|------|------|
| **No cache** | Simple, fresh | High DB load |
| **TTL-based** | Simple | May serve stale |
| **Write-through** | Consistent | Complex writes |
| **Cache-aside** | Flexible | Stale reads possible |

### Decision

**Chosen: TTL-based Redis**

### Rationale

PnL is append-only; historical snapshots never change. TTL is safe: recent PnL 30s, historical 5 min. Leaderboard via Redis ZSET, rebuilt on snapshot tick.

---

## 8. Error Handling & Resilience

### Context

External API (Hyperliquid) may downtime, rate limit, or error. Need robust handling.

### Options Considered

| Pattern | Purpose |
|---------|---------|
| **Retry with backoff** | Transient failures |
| **Circuit breaker** | Prevent cascade |
| **Graceful degradation** | Serve cached on failure |
| **Stream isolation** | One failure doesn't crash others |

### Decision

**Chosen: Defense in depth (all patterns)**

### Rationale

Retry handles transient; circuit breaker stops hammering failing service; graceful degradation keeps UX; stream isolation (`catchError` → `EMPTY`) keeps other streams running.

---

## 9. Data Storage: Trades + Snapshots

### Context

We need both trade-level fidelity and efficient PnL queries across timeframes.

### Options Considered

| Approach | Pros | Cons |
|----------|------|------|
| **Trades only** | Single source of truth | Expensive aggregation for charts |
| **Snapshots only** | Fast reads | No trade-level audit |
| **Both (trades + snapshots)** | Audit trail + read-optimized | More storage, sync logic |

### Decision

**Chosen: Both trades and periodic PnL snapshots**

### Rationale

- **Trades**: Source of truth. Every fill persisted. Supports exact trade-level queries and audit.
- **Snapshots**: Read-optimized projections. Pre-computed PnL at 1-minute intervals for fast chart/leaderboard queries.

**Query strategy:**
- Short intervals (1h, 24h): raw snapshots
- Long intervals (7d, 30d): continuous aggregates (hourly/daily)
- Exact trade-level: trades table

**Storage (approx):** Trades ~50MB/month for 250 traders; snapshots ~200MB/month with compression.

---

## 10. Adaptive Rate Budget

### Context

Hyperliquid allows ~1,200 requests/minute per IP (no auth required). This budget must be shared between real-time polling, background backfill, and on-demand user requests. A rigid allocation wastes capacity when idle and starves users during bursts.

### Options Considered

| Option | Pros | Cons |
|--------|------|------|
| **Fixed allocation** (current: 2 workers) | Simple, predictable | Wastes 80% of budget when idle |
| **Adaptive budget** | Maximizes throughput, prioritizes users | Slightly more complex |
| **External rate limiter** (e.g. Bottleneck) | Battle-tested library | Extra dependency for simple logic |

### Decision

**Chosen: Weight-based adaptive rate budget targeting 80% of 1,200 weight/min**

### Hyperliquid Rate Limits (Official)

Limits are **weight-based per IP** ([docs](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits)):

| Endpoint | Weight | Notes |
|----------|--------|-------|
| `clearinghouseState` | 2 | Position snapshots |
| `userFillsByTime` | 20 + per 20 items | Backfill, on-demand |
| `userFunding` | 20 + per 20 items | Backfill, on-demand |
| `portfolio` | 20 | On-demand verification |
| WebSocket `userFills` | 0 (push) | **Max 10 unique users** |

### Budget Allocation (1,000 traders)

```
Total: 1,200 weight/min | Target 80%: 960 weight/min

Polling (1000 × 2 / 5min)           = 400 weight/min
Discovery (8 coins × 20 / 5min)     =  32 weight/min
User on-demand (reserved)            = ~100 weight/min
Backfill (remaining)                 = ~428 weight/min → ~10 chunks/min
```

### Key Constraints

- **WebSocket**: only 10 unique users for `userFills` (not 1000)
- **Startup burst**: must stagger polling across the 5-min interval
- **Backfill chunk**: 40+ weight (fills + funding), not 2
- **Max traders**: ~3,000 before polling alone hits the limit

### On-Demand Fetching

Per-trader query costs ~60 weight (portfolio + fills + funding). User requests take priority; backfill workers pause.

Full analysis: [RATE_LIMIT_ANALYSIS.md](./RATE_LIMIT_ANALYSIS.md)

---

## Decision Summary

| Topic | Decision | Key Reasoning |
|-------|----------|---------------|
| Message Queue | RxJS (no Kafka) | <100 TPS, single service, API bottleneck |
| Trader Tracking | On-demand | Explicit registration, add discovery later |
| Database | TimescaleDB | Hypertables, continuous aggregates, compression |
| Data Ingestion | Hybrid (WS for top 10 + polling) | WS limited to 10 users, poll the rest |
| PnL Calculation | Incremental updates | O(1), handle edge cases |
| Snapshot Granularity | 1 minute | Flexibility vs storage balance |
| Caching | Redis + TTL | Simple, append-only is cache-friendly |
| Error Handling | Defense in depth | Retry, circuit breaker, graceful degradation |
| Data Storage | Trades + Snapshots | Audit trail + read-optimized projections |
| Rate Budget | Weight-based, 80% target | Correct weights per endpoint, staggered polling |
