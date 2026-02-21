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

## Design Decisions (Implemented)

### 1. WebSocket for Top 10 Traders Only

The limit is 10 unique users for user-specific subscriptions. We subscribe the first 10 traders via WebSocket for real-time fills. All other traders get position polling only.

Additionally, we subscribe to `trades` by coin (BTC, ETH, SOL) for trader discovery -- these are coin-level subscriptions, not user-specific, so they don't count toward the 10-user limit.

### 2. Weight-Based Rate Budget

The rate budget tracks weight consumed, not raw request counts. Each API call registers its actual weight via the `ENDPOINT_WEIGHTS` map in `client.ts`:

```
clearinghouseState: 2 weight
userFillsByTime:    20 weight (+ 1 per 20 items returned)
userFunding:        20 weight (+ 1 per 20 items returned)
portfolio:          20 weight
allMids:            2 weight
userRole:           60 weight
```

Non-user-priority requests wait (backoff) when the weight budget is exceeded.

### 3. Polling Stagger

Position snapshots are spread across the 5-minute interval:
- Batch size: 10 traders
- Delay between batches: 3 seconds
- 1000 traders = 100 batches × 3s = 300s = 5 min (matches interval)

### 4. WebSocket Heartbeat

Ping every 30 seconds to prevent the 60-second idle timeout. Pong responses are filtered from the message stream.

### 5. Discovery via WebSocket Trades

Trader discovery uses WebSocket `trades` subscriptions for BTC/ETH/SOL (zero weight cost) instead of REST `recentTrades` polling (160 weight/cycle). Real-time discovery with no rate limit impact.

### 6. Backfill Throttle

Backfill API calls are tagged as `'backfill'` priority. Workers wait up to 30 attempts (2-5s each) when weight budget is exhausted. Worker concurrency adjusts every 10s based on available backfill budget.

### 7. On-Demand Queries Use "User" Priority

When a user queries a specific trader, the API calls (portfolio + fills + funding = 60+ weight) use `'user'` priority which always proceeds even when the budget is tight.

## Current Implementation Status

| Aspect | Status |
|--------|--------|
| Weight-based budget | Implemented (`rate-budget.ts`) |
| Endpoint weight map | Implemented (`client.ts`) |
| WebSocket 10-user cap | Implemented (`hybrid.stream.ts`) |
| WebSocket heartbeat | Implemented (`websocket.ts`, 30s ping) |
| Discovery via WS trades | Implemented (`trader-discovery.stream.ts`) |
| Staggered polling | Implemented (3s batch delay) |
| Backfill throttle | Implemented (wait on budget) |
| 429 errors | Zero after initial startup burst |
