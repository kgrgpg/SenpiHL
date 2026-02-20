# Architecture Decision Records (ADR)

> This document captures key architectural decisions, the options considered, and the reasoning behind each choice. Documenting these decisions helps maintain context for future development and ensures design choices are well-understood.

## Table of Contents

1. [Message Queue: Kafka vs Alternatives](#1-message-queue-kafka-vs-alternatives)
2. [Trader Tracking Strategy](#2-trader-tracking-strategy)
3. [Database Choice: TimescaleDB vs Alternatives](#3-database-choice-timescaledb-vs-alternatives)
4. [Polling vs WebSocket](#4-polling-vs-websocket)
5. [PnL Calculation Strategy](#5-pnl-calculation-strategy)
6. [Snapshot Granularity](#6-snapshot-granularity)
7. [Caching Strategy](#7-caching-strategy)
8. [Error Handling & Resilience](#8-error-handling--resilience)

---

## 1. Message Queue: Kafka vs Alternatives

### Context

We need to decide whether to introduce a message queue between data ingestion and processing, and if so, which technology to use.

### Options Considered

| Option | Pros | Cons |
|--------|------|------|
| **Kafka** | Industry standard, replay capability, multi-consumer, persistence | Overkill for ~100 TPS, operational complexity, 3+ containers (ZK/Kafka) |
| **Redis Streams** | Already have Redis, lightweight, consumer groups, ~100K msg/sec | Less ecosystem than Kafka, single node limits |
| **BullMQ** | Already in stack, retries, delayed jobs | Not designed for streaming, job-oriented |
| **NATS** | Extremely fast, simple | Less persistence options |
| **In-process RxJS** | Zero latency, simple, no extra infra | No cross-service communication, no replay |

### Throughput Analysis

```
Hyperliquid Rate Limit: ~1200 req/min = 20 RPS (this is our bottleneck)

Expected TPS:
- Position updates: ~30-50/sec (depends on trader count)
- Trade fills: ~5-10/sec
- Funding payments: ~0.1/sec
- Total: ~50-100 events/sec
```

### Decision

**Chosen: In-process RxJS streams**

### Rationale

Our throughput is bounded by Hyperliquid's API rate limits (~20 RPS). At ~100 events/second, Kafka's operational complexity (ZooKeeper, brokers, partition management) isn't justified. The external API is the bottleneck, not internal processing.

If cross-service communication or event replay becomes necessary, Redis Streams would be the next choice since Redis is already in the stack. Kafka would only make sense at 10K+ TPS or if compliance requires a full audit trail.

### When to Revisit

- Multiple services need the same event stream
- Throughput exceeds 10K events/second
- Audit trail / event replay becomes a requirement

---

## 2. Trader Tracking Strategy

### Context

The system needs to track PnL for traders, but the requirements don't specify how traders are discovered or how many we need to support.

### Options Considered

| Option | Description | Max Traders | Update Frequency |
|--------|-------------|-------------|------------------|
| **On-demand only** | Track traders when explicitly requested | Unlimited (lazy) | Real-time for tracked |
| **Auto-discovery** | Scan blockchain for all active traders | 100K+ | Depends on rate limits |
| **Hybrid** | On-demand + auto-discover top N by volume | 10K-50K | Tiered by activity |

### Rate Limit Constraints

```
Hyperliquid: ~1200 requests/minute = 20 RPS

Polling clearinghouseState per trader:
- 1,000 traders @ 30s interval = 33 RPS ❌ (exceeds limit)
- 1,000 traders @ 60s interval = 16.7 RPS ✓
- 5,000 traders @ 5min interval = 16.7 RPS ✓
- 10,000 traders @ 10min interval = 16.7 RPS ✓
```

### Scaling Strategies Available

1. **Batch API calls** (if supported): Query 50-100 traders per request
2. **Tiered polling**: Hot (30s), warm (5min), cold (1hr) based on activity
3. **WebSocket subscriptions**: Real-time for active traders, no rate limit concerns
4. **Horizontal scaling**: Multiple instances with trader sharding

### Decision

**To be determined based on requirements**

### Capacity Estimates

| Setup | Max Traders | Update Frequency | Infrastructure |
|-------|-------------|------------------|----------------|
| Single instance, polling only | ~3,000 | 2-5 min | 1 node |
| Single instance, WebSocket + polling | ~10,000 | Real-time (active), 5 min (inactive) | 1 node |
| 4 instances, sharded | ~40,000 | 1-2 min | 4 nodes |
| WebSocket-primary + batch polling | ~50,000+ | Real-time | 1-2 nodes |

### Open Questions

- [ ] Does Hyperliquid support batch clearinghouseState queries?
- [ ] What are WebSocket subscription limits per connection?
- [ ] How do we define "active" traders for tiered polling?

---

## 3. Database Choice: TimescaleDB vs Alternatives

### Context

PnL data is time-series in nature (snapshots over time) but also has relational aspects (traders → trades → positions). We need a database that handles both well.

### Options Considered

| Option | Pros | Cons |
|--------|------|------|
| **TimescaleDB** | Auto-partitioning (hypertables), continuous aggregates, compression, PostgreSQL compatible | Learning curve, extension management |
| **PostgreSQL** | Simple, well-known, ACID | Manual partitioning, no auto-aggregates |
| **MongoDB** | Flexible schema, document model | Poor for time-series joins, 16MB doc limit, manual TTL |
| **ClickHouse** | Blazing fast analytics, great compression | Requires batched inserts, less flexible for OLTP |
| **InfluxDB** | Purpose-built for time-series | Limited query language, less relational |

### Decision

**Chosen: TimescaleDB**

### Rationale

1. **Hypertables**: Automatic time-based partitioning without manual table management
2. **Continuous Aggregates**: Pre-computed hourly/daily rollups that auto-refresh - critical for efficient timeframe queries
3. **Compression**: 90%+ storage reduction on historical data (built-in)
4. **SQL Joins**: Easy to join traders ↔ trades ↔ snapshots (unlike pure time-series DBs)
5. **PostgreSQL Ecosystem**: Works with existing tools (pgAdmin, Prisma, TypeORM, etc.)

MongoDB was considered but rejected because:
- Time-series queries require manual aggregation pipelines
- Joins via `$lookup` are inefficient
- 16MB document limit problematic for traders with extensive history

ClickHouse was considered but rejected because:
- Requires batched inserts (doesn't fit our streaming model)
- Better suited for heavy analytics than mixed read/write

---

## 4. Polling vs WebSocket

### Context

Hyperliquid provides both REST API (polling) and WebSocket (real-time subscriptions). We need to decide how to ingest data.

### Options Considered

| Option | Pros | Cons |
|--------|------|------|
| **Polling only** | Simple, predictable load, works behind firewalls | Latency, wastes requests on unchanged data |
| **WebSocket only** | Real-time, efficient for active data | Connection management, reconnection logic, may miss state |
| **Hybrid** | Best of both: WS for real-time, polling for consistency | More complex |

### Hyperliquid WebSocket Capabilities

```typescript
// Available subscriptions
{ type: "userEvents", user: "0x..." }      // Fills, liquidations
{ type: "userFills", user: "0x..." }       // Trade fills only
{ type: "orderUpdates", user: "0x..." }    // Order state changes
```

**Note**: WebSocket provides events (what happened), but `clearinghouseState` (current position snapshot) still requires polling.

### Decision

**Chosen: Hybrid approach**

### Rationale

- **WebSocket** for real-time trade fills and order events (low latency, efficient)
- **Polling** for `clearinghouseState` to get authoritative position snapshots

The WebSocket handles "what happened" while polling handles "what is the current state". This provides:
- Real-time responsiveness for trades
- Consistent position data (WebSocket events alone could drift from actual state)
- Efficient use of rate limits (fewer polling requests needed)

---

## 5. PnL Calculation Strategy

### Context

We need to calculate realized and unrealized PnL for traders. The approach affects both accuracy and performance.

### Options Considered

| Option | Pros | Cons |
|--------|------|------|
| **Full recomputation** | Always accurate, simple logic | O(n) per update, expensive at scale |
| **Incremental updates** | O(1) updates, efficient | Must handle edge cases correctly |
| **Event sourcing** | Full audit trail, can replay | Storage overhead, complexity |

### Decision

**Chosen: Incremental updates**

### Rationale

Full recomputation would require scanning all historical trades on every update - O(n) complexity that doesn't scale. Instead, we maintain running totals:

```
On new trade:     realized_pnl += trade.closed_pnl - trade.fee
On funding:       funding_pnl += payment.amount  
On position Δ:    Recalculate unrealized for that coin only
On snapshot tick: Store current state
```

### Edge Cases Handled

| Case | Solution |
|------|----------|
| **Position flip** (long → short) | Split into close + open, realize PnL on close portion |
| **Partial close** | Weighted average entry price |
| **Liquidation** | Include as realized loss (captured via trade with liquidation flag) |
| **Cross-margin** | Account-level PnL calculation, not per-position |

### Trade-offs

- Requires careful handling of edge cases
- State must be persisted to survive restarts
- Historical recalculation available via backfill if needed

---

## 6. Snapshot Granularity

### Context

We need to store PnL snapshots at regular intervals. Finer granularity means more flexibility but higher storage costs.

### Options Considered

| Granularity | Storage (1000 traders, 1 year) | Query Flexibility |
|-------------|-------------------------------|-------------------|
| Per-trade | ~50GB+ | Maximum |
| 1 minute | ~5GB (uncompressed) | High |
| 5 minutes | ~1GB | Medium |
| 1 hour | ~100MB | Low |

### Decision

**Chosen: 1-minute snapshots with compression and retention policies**

### Rationale

1-minute granularity provides good query flexibility while remaining manageable with TimescaleDB's compression:

```sql
-- Compress data older than 7 days (90%+ reduction)
ALTER TABLE pnl_snapshots SET (timescaledb.compress);
SELECT add_compression_policy('pnl_snapshots', INTERVAL '7 days');

-- Optional: Drop raw minute data after 90 days
SELECT add_retention_policy('pnl_snapshots', INTERVAL '90 days');
-- Continuous aggregates (hourly/daily) are retained indefinitely
```

### Storage Projection

| Data Age | Granularity | Storage per 1000 traders |
|----------|-------------|-------------------------|
| 0-7 days | 1 minute (raw) | ~50MB |
| 7-90 days | 1 minute (compressed) | ~5MB |
| 90+ days | Hourly/daily aggregates only | ~1MB/year |

---

## 7. Caching Strategy

### Context

API queries for PnL data need to be fast. We need to decide what to cache and how to handle invalidation.

### Options Considered

| Strategy | Pros | Cons |
|----------|------|------|
| **No cache** | Simple, always fresh | High DB load |
| **TTL-based** | Simple to implement | May serve stale data |
| **Write-through** | Always consistent | More complex writes |
| **Cache-aside** | Flexible | Potential for stale reads |

### Decision

**Chosen: TTL-based caching with Redis**

### Cache Configuration

| Data Type | Cache Location | TTL | Rationale |
|-----------|----------------|-----|-----------|
| Recent PnL (1h) | Redis | 30 sec | Near-real-time for active queries |
| Historical PnL | Redis | 5 min | Historical data doesn't change |
| Leaderboard | Redis ZSET | 1 min | Updated on each snapshot tick |
| Trader stats | Redis | 5 min | Aggregate data, infrequent changes |

### Rationale

PnL data is append-only - historical snapshots never change once written. This makes TTL-based caching safe:
- Stale cache for historical data is fine (it's immutable)
- Recent data uses short TTL for near-real-time updates
- No complex invalidation logic needed

Leaderboards use Redis sorted sets (ZSET) for O(log N) ranking operations, rebuilt on each snapshot tick rather than cached.

---

## 8. Error Handling & Resilience

### Context

The system depends on an external API (Hyperliquid) that may experience downtime, rate limiting, or errors. We need robust error handling.

### Patterns Implemented

| Pattern | Implementation | Purpose |
|---------|----------------|---------|
| **Retry with backoff** | `retryWhen` + exponential delay | Handle transient failures |
| **Circuit breaker** | Open after 5 failures, reset after 60s | Prevent cascade failures |
| **Graceful degradation** | Serve cached data on API failure | Maintain user experience |
| **Stream isolation** | `catchError` returns `EMPTY` | Failures don't crash other streams |

### Decision

**Chosen: Defense in depth with all patterns**

### Implementation Details

```typescript
// Exponential backoff: 1s → 2s → 4s → 8s → 16s (max 5 retries)
retryWhen(errors => errors.pipe(
    scan((count, err) => count >= 5 ? throwError(err) : count + 1, 0),
    delayWhen(count => timer(Math.pow(2, count) * 1000))
))

// Circuit breaker: Opens after 5 consecutive failures
// Waits 60 seconds before allowing retry
// Prevents hammering a failing service

// Stream isolation: If funding stream fails, positions/fills continue
catchError(err => {
    logger.error('Stream failed', err);
    return EMPTY;
})
```

### Rationale

External API dependencies require multiple layers of protection:
1. **Retry** handles transient network issues
2. **Circuit breaker** prevents overwhelming a struggling service
3. **Graceful degradation** keeps the system useful during outages
4. **Stream isolation** ensures one failure doesn't take down everything

---

## Decision Summary

| Topic | Decision | Key Reasoning |
|-------|----------|---------------|
| Message Queue | RxJS (no Kafka) | <100 TPS, single service, external API is bottleneck |
| Trader Tracking | TBD | Depends on scale requirements |
| Database | TimescaleDB | Hypertables, continuous aggregates, compression |
| Data Ingestion | Hybrid (WS + polling) | Real-time events + consistent state |
| PnL Calculation | Incremental updates | O(1) performance, handle edge cases |
| Snapshot Granularity | 1 minute | Balance of flexibility and storage |
| Caching | Redis + TTL | Simple, append-only data is cache-friendly |
| Error Handling | Defense in depth | Retry, circuit breaker, graceful degradation |

---

## Open Questions

- [ ] **Trader source**: On-demand vs auto-discovery vs hybrid?
- [ ] **Scale target**: Hundreds, thousands, or tens of thousands of traders?
- [ ] **Hyperliquid batch API**: Does it support multi-trader queries?
- [ ] **WebSocket limits**: How many subscriptions per connection?
- [ ] **Historical backfill**: How far back should we fetch on new trader registration?

---

## Changelog

| Date | Decision | Change |
|------|----------|--------|
| Initial | All | Initial architecture decisions documented |
