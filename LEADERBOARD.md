# Leaderboard Design & Data Accuracy

This document explains how the PnL leaderboard works, its limitations, and how we ensure accuracy.

---

## The Challenge

### What We Can Track

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        TRADER DATA TIMELINE                             │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  Trader's actual history          Our tracking                          │
│  ─────────────────────────        ─────────────                         │
│                                                                         │
│  Jan 2024        Jun 2024        Feb 2026                               │
│     │               │               │                                   │
│     ▼               ▼               ▼                                   │
│  ┌──────────────────────────────────────────────────────────┐          │
│  │  Started      Made $500k      We start      Current      │          │
│  │  trading      profit          tracking      time         │          │
│  └──────────────────────────────────────────────────────────┘          │
│                                       │                                 │
│                                       │                                 │
│                        ┌──────────────┴──────────────┐                 │
│                        │  OUR DATA COVERAGE          │                 │
│                        │  (from tracking start)      │                 │
│                        └─────────────────────────────┘                 │
│                                                                         │
│  ⚠️  We DON'T have the $500k profit data from before tracking!         │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### The Problem

If we only use our collected data for "all-time" rankings:
- Trader A: Trading since 2024, made $1M total, but we only have $50k (since Feb 2026)
- Trader B: Trading since Feb 2026, made $60k total
- **Wrong ranking**: B > A (because we don't see A's full history)

---

## Our Solution: Dual Data Sources

### Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                      LEADERBOARD DATA FLOW                              │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  Timeframe Selection                                                    │
│  ───────────────────                                                    │
│                                                                         │
│      ?timeframe=1d/7d/30d              ?timeframe=all                   │
│              │                                │                         │
│              ▼                                ▼                         │
│  ┌─────────────────────┐          ┌─────────────────────┐              │
│  │   OUR DATABASE      │          │  HYPERLIQUID API    │              │
│  │   (pnl_snapshots)   │          │  (portfolio)        │              │
│  │                     │          │                     │              │
│  │   ✓ Recent data     │          │  ✓ All-time data    │              │
│  │   ✓ High granularity│          │  ✓ Authoritative    │              │
│  │   ✓ Fast queries    │          │  ✓ Complete history │              │
│  │                     │          │                     │              │
│  │   ⚠️ Limited to     │          │  ⚠️ Slower (API)    │              │
│  │     tracking start  │          │  ⚠️ Rate limited    │              │
│  └─────────────────────┘          └─────────────────────┘              │
│              │                                │                         │
│              ▼                                ▼                         │
│  ┌─────────────────────────────────────────────────────────┐           │
│  │                 UNIFIED LEADERBOARD API                  │           │
│  │                                                          │           │
│  │  {                                                       │           │
│  │    rank: 1,                                              │           │
│  │    address: "0x...",                                     │           │
│  │    pnl: "50000.00",                                      │           │
│  │    tracking_since: "2026-02-15T00:00:00Z",  ← NEW        │           │
│  │    data_source: "calculated" | "hyperliquid_portfolio"   │           │
│  │  }                                        ↑ NEW          │           │
│  └─────────────────────────────────────────────────────────┘           │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## API Reference

### GET /v1/leaderboard

#### Query Parameters

| Parameter | Options | Default | Description |
|-----------|---------|---------|-------------|
| `timeframe` | `1d`, `7d`, `30d`, `all` | `7d` | Time period for ranking |
| `metric` | `total_pnl`, `realized_pnl`, `volume` | `total_pnl` | Ranking metric |
| `limit` | 10-100 | 50 | Number of results |

#### Response Fields

| Field | Type | Description |
|-------|------|-------------|
| `rank` | number | Position in leaderboard |
| `address` | string | Trader's wallet address |
| `total_pnl` / `all_time_pnl` | string | PnL value |
| `tracking_since` | string | ISO timestamp when we started tracking |
| `data_source` | string | `"calculated"` or `"hyperliquid_portfolio"` |

---

## Timeframe Comparison

### 1d / 7d / 30d (Our Data)

```bash
GET /v1/leaderboard?timeframe=7d
```

**Response:**
```json
{
  "timeframe": "7d",
  "metric": "total_pnl",
  "description": "7d PnL calculated from our tracked data",
  "data": [
    {
      "rank": 1,
      "address": "0x20c2d95a...",
      "total_pnl": "15420.50",
      "realized_pnl": "12000.00",
      "unrealized_pnl": "3420.50",
      "volume": "500000.00",
      "trade_count": 150,
      "tracking_since": "2026-02-15T10:30:00Z",
      "data_source": "calculated"
    }
  ],
  "note": "PnL is calculated from data collected since each trader was added to tracking."
}
```

**Use when:**
- You want recent performance
- You need trade-level granularity
- You want fast response times

**Limitations:**
- Only covers time since `tracking_since`
- May not reflect true 7d performance if tracked < 7 days

---

### all (Hyperliquid's Data)

```bash
GET /v1/leaderboard?timeframe=all
```

**Response:**
```json
{
  "timeframe": "all",
  "metric": "all_time_pnl",
  "description": "All-time PnL from Hyperliquid portfolio (authoritative)",
  "data": [
    {
      "rank": 1,
      "address": "0x20c2d95a...",
      "all_time_pnl": "1250000.00",
      "all_time_volume": "50000000.00",
      "perp_pnl": "1200000.00",
      "perp_volume": "48000000.00",
      "tracking_since": "2026-02-15T10:30:00Z",
      "data_source": "hyperliquid_portfolio"
    }
  ],
  "note": "All-time PnL is fetched directly from Hyperliquid and represents true lifetime performance."
}
```

**Use when:**
- You want true all-time rankings
- Accuracy is more important than speed
- You're comparing traders' total career performance

**Limitations:**
- Slower (requires API calls per trader)
- Rate limited for large trader counts

---

## Data Source Comparison

| Aspect | Our Calculated Data | Hyperliquid Portfolio |
|--------|--------------------|-----------------------|
| **Coverage** | Since tracking started | All-time |
| **Accuracy** | ✅ Accurate for our period | ✅ Authoritative |
| **Speed** | ⚡ Fast (database query) | 🐢 Slower (API calls) |
| **Granularity** | Trade-by-trade | Summary only |
| **Updates** | Real-time | On-demand |

---

## Ensuring Data Completeness

### What We Guarantee

1. **From Tracking Start → Now**: Complete data via hybrid stream
   - WebSocket for real-time fills (no missed trades)
   - Periodic snapshots for position reconciliation
   
2. **All-Time Rankings**: Accurate via Hyperliquid portfolio
   - Fetched directly from the source
   - No data gaps possible

### What We Track Per Trader

```sql
traders table:
├── first_seen_at          -- When we started tracking
├── last_snapshot_at       -- Most recent data point
├── last_fill_at           -- Most recent trade
├── total_fills_count      -- Trades recorded
├── total_snapshots_count  -- Snapshots recorded
└── discovery_source       -- How we found this trader
```

### Transparency Fields

Every leaderboard entry includes:

| Field | Purpose |
|-------|---------|
| `tracking_since` | Shows data coverage start |
| `data_source` | Indicates which data source was used |

This lets API consumers understand exactly what the numbers represent.

---

## Implementation Details

### Time-Bounded Leaderboard (1d/7d/30d)

```typescript
// Query our pnl_snapshots table
SELECT 
  ROW_NUMBER() OVER (ORDER BY total_pnl DESC) as rank,
  t.address,
  ls.total_pnl,
  t.first_seen_at as tracking_since,
  'calculated' as data_source
FROM pnl_snapshots ls
JOIN traders t ON t.id = ls.trader_id
WHERE timestamp >= NOW() - INTERVAL '7 days'
```

### All-Time Leaderboard

```typescript
// Fetch from Hyperliquid for each tracked trader
for (trader of trackedTraders) {
  const portfolio = await fetchPortfolio(trader.address);
  const allTimePnl = portfolio.get('allTime').pnlHistory.last();
  // Rank by allTimePnl
}
```

---

## Recommendations

### For Users of This API

| Goal | Recommended Endpoint |
|------|---------------------|
| True all-time rankings | `?timeframe=all` |
| Recent hot performers | `?timeframe=1d` |
| Weekly performance | `?timeframe=7d` |
| Monthly performance | `?timeframe=30d` |

### For Production Deployment

1. **Cache all-time leaderboard** (expensive to compute)
   - Refresh every 5-10 minutes
   - Store in Redis sorted set

2. **Background refresh** for portfolio data
   - Don't compute on-demand for large trader counts
   - Pre-fetch portfolio data periodically

3. **Show coverage clearly** in UI
   - Display `tracking_since` prominently
   - Explain data source differences

---

## Summary

| Question | Answer |
|----------|--------|
| **Is our leaderboard accurate?** | Yes, within its scope |
| **What is the scope?** | Time-bounded: since tracking. All-time: authoritative from Hyperliquid |
| **How do we prevent missing data?** | Hybrid stream (WS + polling) ensures no gaps |
| **How can users verify accuracy?** | `tracking_since` and `data_source` fields |
| **Which timeframe is most reliable?** | `all` - directly from Hyperliquid |

---

## Files

| File | Purpose |
|------|---------|
| `src/api/routes/v1/leaderboard.ts` | API endpoint |
| `src/storage/db/repositories/leaderboard.repo.ts` | Data fetching logic |
| `src/hyperliquid/client.ts` | Portfolio API integration |
