# Hyperliquid Rate Limit Analysis

Based on the [official Hyperliquid rate limit documentation](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits).

## The Budget: 1,200 Weight Per Minute Per IP

Hyperliquid rate limits are **weight-based**, not raw request counts. Each API call costs a different weight depending on the endpoint and response size.

### Request Weights

| Endpoint | Weight | We Use For |
|----------|--------|-----------|
| `clearinghouseState` | 2 | Position snapshots (polling) |
| `allMids` | 2 | Price data |
| `userFillsByTime` | 20 + 1 per 20 items | Backfill fills, on-demand |
| `userFunding` | 20 + 1 per 20 items | Backfill funding, on-demand |
| `portfolio` | 20 | On-demand PnL verification |
| `recentTrades` | 20 + 1 per 20 items | Trader discovery |
| `userRole` | 60 | Not used |

Example: fetching 100 fills costs `20 + floor(100/20) = 25` weight.

### WebSocket Limits

| Limit | Value | Impact |
|-------|-------|--------|
| Max connections | 10 | One connection is sufficient |
| Max subscriptions | 1000 | Can subscribe to 1000 channels |
| **Max unique users** | **10** | Can only get `userFills` for 10 traders via WebSocket |
| Max new connections/min | 30 | Reconnects are fine |
| Max messages sent/min | 2000 | Subscription messages |

The **10 unique users** limit is the critical constraint. WebSocket `userFills` subscriptions only work for 10 traders. All other traders must be polled via REST.

## Budget Allocation

### Scenario: 1,000 Traders

```
Total budget: 1,200 weight/min

┌─────────────────────────────────────────────────────────┐
│ Consumer              │ Weight  │ Frequency │ Cost/min  │
├───────────────────────┼─────────┼───────────┼───────────┤
│ Position polling      │ 2 each  │ /5 min    │ 400       │
│ (1000 × 2 / 5)       │         │           │           │
├───────────────────────┼─────────┼───────────┼───────────┤
│ Discovery (8 coins)   │ 20 each │ /5 min    │ 32        │
│ (8 × 20 / 5)         │         │           │           │
├───────────────────────┼─────────┼───────────┼───────────┤
│ Reserved for user     │ varies  │ on-demand │ ~100      │
│ queries (portfolio,   │         │           │           │
│ fills, funding)       │         │           │           │
├───────────────────────┼─────────┼───────────┼───────────┤
│ Backfill              │ 40 each │ remaining │ ~668      │
│ (fills + funding per  │ chunk   │           │           │
│ day-chunk)            │         │           │           │
├───────────────────────┼─────────┼───────────┼───────────┤
│ TOTAL                 │         │           │ 1,200     │
└─────────────────────────────────────────────────────────┘
```

Backfill throughput: `668 / 40 = ~16 chunks/min = ~1 chunk every 4 seconds`

### Scaling by Trader Count

| Traders | Polling Cost/min | Remaining for Backfill | Max Backfill Chunks/min |
|---------|-----------------|----------------------|------------------------|
| 100 | 40 | 1,128 | 28 |
| 500 | 200 | 968 | 24 |
| 1,000 | 400 | 668 | 16 |
| 2,000 | 800 | 268 | 6 |
| 3,000 | 1,200 | 0 | 0 (at limit!) |

**Maximum traders with polling only: ~3,000** (fills all 1,200 weight just for snapshots).

### The Startup Burst Problem

When the app starts, it polls ALL traders immediately in the first cycle. 1,000 traders × 2 weight = 2,000 weight in <1 minute, exceeding the 1,200 limit.

**Solution**: Stagger initial polling across the full 5-minute interval.
- 1,000 traders / 5 min = 200 req/min = 400 weight/min (safe)
- Batch size 10, delay 3s between batches: 100 batches × 3s = 300s = 5 min

## Design Decisions

### 1. WebSocket for Top 10 Traders Only

Since the limit is 10 unique users, we subscribe the 10 most recently active traders via WebSocket for real-time fills. All other traders are polled.

### 2. Weight-Based Rate Budget

The rate budget tracks weight consumed, not raw request counts. Each API call registers its actual weight:

```
clearinghouseState: 2 weight
userFillsByTime:    20 weight (minimum)
userFunding:        20 weight (minimum)
portfolio:          20 weight
```

### 3. Polling Stagger

Position snapshots are spread across the 5-minute interval to avoid bursts:
- Batch size: 10 traders
- Delay between batches: 3 seconds
- Total cycle time: matches the polling interval

### 4. Backfill Throttle

Backfill chunks (40 weight each) are rate-limited by the budget manager. Workers wait when weight budget is exhausted.

### 5. On-Demand Queries Use "User" Priority

When a user queries a specific trader, the API calls (portfolio + fills + funding = 60+ weight) are prioritized over backfill. Backfill workers pause to make room.

## Comparison: Before and After

| Aspect | Before (wrong) | After (correct) |
|--------|---------------|-----------------|
| Budget unit | raw requests | weighted requests |
| Budget size | 1,200 "requests" | 1,200 weight |
| clearinghouseState cost | 1 | 2 |
| Backfill chunk cost | 2 | 40+ |
| WebSocket traders | 1000+ (silently failing) | 10 (actual limit) |
| Polling burst | all-at-once | staggered over 5 min |
| Max safe traders | "5000" (claimed) | ~3,000 (real) |
