# Hyperliquid API Rate Limits Analysis

This document explains Hyperliquid's rate limiting system and how it affects our PnL Indexer design.

## TL;DR

- **No authentication required** - Hyperliquid's info API is completely free and open
- **Base limit**: ~1,200 requests/minute per IP for REST API
- **WebSocket**: No rate limits on subscriptions (push-based)
- **Hybrid approach**: WebSocket for real-time fills + polling for snapshots
- **Our design handles 5,000+ traders** with the hybrid approach

---

## Understanding the Rate Limits

### How It Works

Hyperliquid uses a **volume-based rate limiting** system:

```
Rate Limit = Base Requests + (Cumulative Trading Volume × Multiplier)
```

| User Type | Approximate Limit |
|-----------|-------------------|
| New IP (no trading) | ~1,200 req/min |
| Active trader | Higher (based on volume) |

### What This Means in Simple Terms

1. **You can make ~20 requests per second** without any authentication
2. **If you trade on Hyperliquid**, you get more requests based on how much you trade
3. **The limit is per IP**, not per user or API key

### Checking Your Rate Limit

You can query your current rate limit:

```bash
curl -s -X POST https://api.hyperliquid.xyz/info \
  -H "Content-Type: application/json" \
  -d '{"type": "userRateLimit", "user": "0xYOUR_ADDRESS"}'
```

Response:
```json
{
  "cumVlm": "2854574.59",       // Your cumulative volume
  "nRequestsUsed": 2890,        // Requests used in current window
  "nRequestsCap": 2864574,      // Your personal cap
  "nRequestsSurplus": 0         // Extra requests available
}
```

---

## WebSocket: The Key to Scaling

Hyperliquid provides a **WebSocket API** that pushes data to us in real-time. This is critical for scaling to thousands of traders.

### WebSocket URL

```
wss://api.hyperliquid.xyz/ws
```

### Available Subscriptions

| Subscription | Purpose | Rate Limit |
|--------------|---------|------------|
| `userFills` | Trade fill events | **None** (push) |
| `userEvents` | All user events | **None** (push) |
| `trades` | Market trades | **None** (push) |
| `orderUpdates` | Order state changes | **None** (push) |

### Why WebSocket is Essential

```
┌──────────────────────────────────────────────────────────────────────────┐
│                     Polling vs WebSocket                                  │
├──────────────────────────────────────────────────────────────────────────┤
│  POLLING (REST API)                  │  WEBSOCKET (Real-time)            │
│  ────────────────────                │  ───────────────────────          │
│  • We ask: "Any new fills?"          │  • Server tells us: "New fill!"   │
│  • Every 30s per trader              │  • Instant when it happens        │
│  • 3 requests × traders × 2/min      │  • Single connection, many subs   │
│  • 1000 traders = 6000 req/min ❌    │  • 1000 traders = ~200 req/min ✅ │
└──────────────────────────────────────────────────────────────────────────┘
```

### What WebSocket CAN'T Do

Important limitation: WebSocket provides **events** (what happened), but the `clearinghouseState` endpoint (current position snapshot) **still requires polling**.

This is why we use a **hybrid approach**.

---

## Hybrid Architecture (Our Solution)

We combine WebSocket and polling for the best of both worlds:

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        HYBRID ARCHITECTURE                              │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│   WebSocket Connection                    Polling (Batched)             │
│   ─────────────────────                   ─────────────────             │
│   ┌─────────────────┐                     ┌─────────────────┐           │
│   │ Subscribe to    │                     │ Every 5 minutes │           │
│   │ userFills for   │──── Real-time ────▶│ fetch position  │           │
│   │ ALL traders     │     fills          │ snapshots       │           │
│   └─────────────────┘                     └─────────────────┘           │
│          │                                        │                     │
│          │                                        │                     │
│          └────────────────┬───────────────────────┘                     │
│                           │                                             │
│                           ▼                                             │
│                  ┌─────────────────┐                                    │
│                  │  Merge Events   │                                    │
│                  │  & Calculate    │                                    │
│                  │     PnL         │                                    │
│                  └─────────────────┘                                    │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Rate Limit Comparison

| Traders | Polling Only | Hybrid (WS + Polling) | Savings |
|---------|--------------|----------------------|---------|
| 100 | 600 req/min | 20 req/min | 97% |
| 500 | 3,000 req/min ❌ | 100 req/min | 97% |
| 1,000 | 6,000 req/min ❌ | 200 req/min | 97% |
| 5,000 | 30,000 req/min ❌ | 1,000 req/min ✅ | 97% |
| 10,000 | 60,000 req/min ❌ | 2,000 req/min ⚠️ | 97% |

**Calculation for Hybrid:**
- WebSocket fills: 0 requests (pushed to us)
- Position snapshots: 1 request per trader per 5 minutes
- 5,000 traders ÷ 5 = 1,000 req/min

---

## Impact on Our Design

### Requests Per Trader Per Poll Cycle

Each time we poll a trader, we make **3 API calls**:

| Endpoint | Purpose | Request |
|----------|---------|---------|
| `clearinghouseState` | Current positions, account value | 1 |
| `userFillsByTime` | Recent trades | 1 |
| `userFunding` | Funding payments | 1 |

**Total: 3 requests per trader per poll**

### Scaling Calculations

With a **30-second poll interval**:

| Traders | Requests/Poll | Requests/Minute |
|---------|---------------|-----------------|
| 10 | 30 | 60 |
| 50 | 150 | 300 |
| 100 | 300 | 600 |
| 200 | 600 | 1,200 (at limit!) |

### Our Safe Operating Zone

**With Hybrid Mode (Default):**

```
┌─────────────────────────────────────────────────────────────┐
│  Safe Zone: Up to ~5,000 traders with hybrid mode           │
│                                                             │
│  WebSocket: No rate limit (push-based)                      │
│  Polling: 1 req per trader per 5 min                        │
│                                                             │
│  5,000 traders ÷ 5 min = 1,000 req/min ← Safe               │
│  2,000 traders ÷ 5 min = 400 req/min   ← Very safe          │
│  1,000 traders ÷ 5 min = 200 req/min   ← Lots of headroom   │
└─────────────────────────────────────────────────────────────┘
```

**With Polling Only (Legacy/Fallback):**

```
┌─────────────────────────────────────────────────────────────┐
│  Safe Zone: Up to ~200 traders @ 30s intervals              │
│                                                             │
│  Requests/min = (Traders × 3 requests) × (60s / interval)   │
│                                                             │
│  200 traders × 3 × 2 = 1,200 req/min ← At limit             │
│  100 traders × 3 × 2 = 600 req/min   ← 50% headroom         │
└─────────────────────────────────────────────────────────────┘
```

---

## Design Decisions Based on Rate Limits

### 1. Configurable Poll Interval (Default: 30s)

**Why 30 seconds?**
- Balances freshness vs. rate limit usage
- Allows ~200 traders within limits
- Most PnL changes aren't sub-minute critical

**When to increase:**
- More traders → increase interval to 60s or 120s
- Less critical data → can go to 5 minutes

### 2. Staggered Polling

Instead of polling all traders simultaneously:

```typescript
// Bad: All at once (spike in requests)
traders.forEach(t => poll(t));

// Good: Spread across the interval
const staggerMs = pollInterval / traders.length;
traders.forEach((t, i) => setTimeout(() => poll(t), i * staggerMs));
```

**Benefits:**
- Smoother request rate
- Avoids burst rate limiting
- Better for the Hyperliquid servers

### 3. Exponential Backoff on Errors

When we hit rate limits or errors:

```typescript
retry({
  count: 3,
  delay: (error, retryCount) => {
    // 2s, 4s, 8s backoff
    return timer(Math.pow(2, retryCount) * 1000);
  },
})
```

### 4. Circuit Breaker Pattern

If too many requests fail:

```
Closed (normal) → Open (stop requests) → Half-Open (test) → Closed
```

This prevents hammering the API when it's having issues.

---

## Data Pagination Limits

From the [Hyperliquid docs](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint):

| Endpoint | Max Records | Pagination |
|----------|-------------|------------|
| `userFillsByTime` | 2,000 per response | Use `startTime` of last record |
| `userFunding` | 500 per response | Use `startTime` of last record |
| Historical data | 10,000 most recent | Cannot access older |

### Handling Pagination

For high-volume traders, we paginate:

```typescript
async function getAllFills(address: string, since: number): Promise<Fill[]> {
  const allFills: Fill[] = [];
  let startTime = since;
  
  while (true) {
    const fills = await fetchFills(address, startTime);
    if (fills.length === 0) break;
    
    allFills.push(...fills);
    startTime = fills[fills.length - 1].time + 1; // Next batch
    
    if (fills.length < 2000) break; // Last page
  }
  
  return allFills;
}
```

---

## Recommendations for Production

### Default: Hybrid Mode (5,000+ traders)

The hybrid mode is **enabled by default** and can handle thousands of traders:

```bash
# .env
USE_HYBRID_MODE=true          # Enable WebSocket + polling (default)
POLL_INTERVAL_MS=300000       # Snapshot poll every 5 minutes
HYPERLIQUID_WS_URL=wss://api.hyperliquid.xyz/ws
```

### Scaling Beyond 5,000 Traders

| Option | Implementation | Capacity |
|--------|----------------|----------|
| Longer poll interval | `POLL_INTERVAL_MS=600000` (10 min) | ~10,000 traders |
| Multiple instances | Shard traders across instances | ~50,000+ traders |
| Tiered polling | Active: 2min, Inactive: 30min | ~20,000 traders |
| Multiple IPs | Load balancer with N outbound IPs | N × 5,000 traders |

### Monitoring Rate Limit Usage

Track these metrics:

```typescript
// In our metrics
pnl_api_requests_total
pnl_api_rate_limit_remaining
pnl_api_errors_rate_limited
```

### Alerting Thresholds

| Metric | Warning | Critical |
|--------|---------|----------|
| Requests/min | 800 | 1,000 |
| Rate limit errors | 5/min | 20/min |
| Failed polls | 10% | 25% |

---

## Comparison with Alternatives

| Provider | Rate Limit | Auth Required | Cost |
|----------|------------|---------------|------|
| **Hyperliquid API** | ~1,200/min | No | Free |
| Nansen API | Varies | Yes (API key) | Paid |
| The Graph | 1,000/day free | Sometimes | Freemium |

**Our choice**: Hyperliquid's native API is ideal because:
- No authentication complexity
- Generous free tier
- Direct source of truth
- Real-time data

---

## Summary

| Aspect | Our Approach |
|--------|--------------|
| **Auth** | None needed |
| **Data ingestion** | Hybrid: WebSocket + periodic polling |
| **Base capacity** | ~5,000 traders with hybrid mode |
| **Real-time data** | WebSocket for instant fill events |
| **Position snapshots** | Polling every 5 minutes |
| **Scaling** | Longer intervals, sharding, multiple IPs |
| **Error handling** | Exponential backoff + circuit breaker + auto-reconnect |

### Key Files

| File | Purpose |
|------|---------|
| `src/hyperliquid/websocket.ts` | WebSocket client with auto-reconnect |
| `src/streams/sources/hybrid.stream.ts` | Combines WebSocket + polling |
| `src/hyperliquid/client.ts` | REST API client for polling |

### Why Hybrid Works

1. **WebSocket for fills**: Instant, no rate limit, scales infinitely
2. **Polling for snapshots**: Authoritative position state, batched requests
3. **Best of both**: Real-time responsiveness + data consistency

This architecture meets the requirement to **"handle thousands of traders efficiently"** while staying well within Hyperliquid's rate limits.
