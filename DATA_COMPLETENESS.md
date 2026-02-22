# Data Completeness Strategy

This document explains how we handle trader discovery and ensure data completeness over time.

> **Status: FULLY INTEGRATED** ✅
> 
> As of v1.1.0, trader discovery and auto-subscribe are fully integrated into the main application.
> The system automatically discovers and subscribes to new traders when you run `npm run dev`.

## The Fundamental Challenge

**Hyperliquid does NOT provide:**
- A "list all traders" API endpoint
- A "new trader joined" event stream

**BUT we discovered a solution!**

The `recentTrades` endpoint includes **both buyer and seller addresses** for every trade!

---

## 🆕 Automatic Trader Discovery (IMPLEMENTED)

### How It Works

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    AUTO-DISCOVERY PIPELINE                              │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  1. WebSocket trades     2. Extract addresses    3. Queue & Subscribe   │
│  ─────────────────────   ────────────────────    ─────────────────────  │
│                                                                         │
│  Subscribe to coin-level Each trade has:         Check against DB       │
│  `trades` WS channels    { users: [buyer,       If new → add to queue   │
│  (BTC, ETH, SOL, ...)     seller] }            Auto-subscribe job      │
│                                                                         │
│  8 coin channels ──────▶  continuous stream ────▶ thousands per day!     │
│  (zero weight cost)                                                     │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

**Note**: Discovery uses WebSocket `trades` subscriptions (zero API weight), not REST `recentTrades` polling. This is far more efficient and provides real-time discovery.

### Discovery Rate

| Metric | Value |
|--------|-------|
| **Addresses per poll** | ~50-100 unique |
| **Poll interval** | Every 5 minutes |
| **Coins watched** | BTC, ETH, SOL, ARB, DOGE, WIF, SUI, PEPE |
| **Estimated daily discovery** | **~10,000+ traders** |

### Key Files

```
src/streams/sources/trader-discovery.stream.ts  # Discovery polling
src/jobs/auto-subscribe.ts                       # Queue processing
```

### Running Discovery

```bash
# Test discovery manually
npx tsx scripts/test-discovery.ts

# In production, discovery runs automatically with the main app
```

---

## All Trader Discovery Methods

### Automatic (Implemented ✅)

| Method | Description | Rate |
|--------|-------------|------|
| **recentTrades Polling** | Extract addresses from market trades | ~10k/day |

### Semi-Automatic (Optional)

| Method | Description | Feasibility |
|--------|-------------|-------------|
| **Manual** | Someone adds an address via API | Easy |
| **Leaderboard** | Copy addresses from UI | Semi-manual |
| **Known Whales** | Pre-populated list | One-time |
| **Leaderboard Scraping** | Periodically scrape Hyperliquid UI | Medium |
| **Nansen API** | Use paid service for trader lists | High (paid) |
| **On-chain Events** | Index Arbitrum for deposit events | Complex |

---

## Data Completeness Tracking

### Per-Trader Tracking

For each trader, we track:

```sql
traders
├── data_start_date          -- Oldest data we have
├── backfill_complete_until  -- How far back we've backfilled
├── last_snapshot_at         -- Last successful snapshot
├── last_fill_at             -- Most recent fill timestamp
├── total_fills_count        -- Total fills stored
├── total_snapshots_count    -- Total snapshots stored
└── discovery_source         -- How we found this trader
```

### Data Freshness States

| State | Meaning |
|-------|---------|
| `current` | Last snapshot < 5 minutes ago |
| `stale` | Last snapshot < 1 hour ago |
| `very_stale` | Last snapshot > 1 hour ago |
| `never` | No snapshots yet |

### Backfill Status

| Status | Meaning |
|--------|---------|
| `no_backfill` | Never backfilled historical data |
| `partial` | Some historical data, not complete |
| `complete` | 30+ days of historical data |

---

## Building a Complete Database

### Our Approach: Automatic Discovery + Subscription

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    COMPLETE DATA PIPELINE (IMPLEMENTED)                 │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  Discovery Sources          Queue                    Processing         │
│  ─────────────────          ─────                    ──────────         │
│                                                                         │
│  ┌─────────────┐           ┌──────────────┐        ┌──────────────┐    │
│  │recentTrades │           │              │        │              │    │
│  │  Polling    │──────────▶│  Discovery   │───────▶│ Subscribe &  │    │
│  │ (AUTO!) ✅  │           │    Queue     │        │  Collect     │    │
│  └─────────────┘           │              │        │              │    │
│  ┌─────────────┐           │ (DB table)   │        │ (Hybrid      │    │
│  │  Manual     │──────────▶│              │        │  Stream)     │    │
│  │   Input     │           │              │        │              │    │
│  └─────────────┘           └──────────────┘        └──────────────┘    │
│                                   │                        │           │
│                                   │                        ▼           │
│                                   │               ┌──────────────┐     │
│                                   └──────────────▶│  TimescaleDB │     │
│                                                   │  (pnl_data)  │     │
│                                                   └──────────────┘     │
│                                                                         │
│  📊 Expected Growth: ~10,000 new traders/day via auto-discovery        │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### How It Works

1. **Discovery Stream** polls `recentTrades` for BTC, ETH, SOL, etc.
2. New addresses are added to `trader_discovery_queue` table
3. **Auto-Subscribe Job** processes the queue every minute
4. Subscribed traders are tracked via the **Hybrid Stream** (WebSocket + polling)
5. All data flows into TimescaleDB

---

## API Endpoints for Data Management

### System Status

```bash
GET /v1/status

# Returns: mode, connections, discovery stats, data integrity info
```

### Trader Data Status (via PnL endpoint)

```bash
GET /v1/traders/{address}/pnl?timeframe=1d

# Response includes data_status:
# - pnl_source, tracking_since, tracking_covers_timeframe
# - fills_in_range, snapshots_in_range
# - known_gaps (from gap detector)
```

### Subscribe a Trader

```bash
POST /v1/traders/{address}/subscribe

# Manually add a trader to tracking; auto-discovery handles the rest
```

---

## Handling Data Gaps

### Detection

Data gaps are detected when:
- A poll fails and can't be retried
- WebSocket disconnects for extended period
- Backfill discovers missing time ranges

### Resolution

```sql
-- Find unresolved gaps
SELECT * FROM data_gaps 
WHERE resolved_at IS NULL
ORDER BY gap_start;

-- After backfilling, mark as resolved
UPDATE data_gaps 
SET resolved_at = NOW() 
WHERE id = ?;
```

### Gap Types

| Type | Cause | Resolution |
|------|-------|------------|
| `fills` | Missed trades | Backfill via `userFillsByTime` |
| `snapshots` | Failed polls | Re-poll and interpolate |
| `funding` | Missed funding | Backfill via `userFunding` |

---

## Practical Recommendations

### For This Assignment

1. **Enable auto-discovery** (implemented!)
   - Run the discovery stream to find traders
   - Auto-subscribe job processes the queue
   - System grows database automatically

2. **Seed with some known addresses**
   - Add 5-10 addresses from leaderboard for immediate testing
   - Discovery will add thousands more over time

### For Production

1. **Run discovery continuously**
   - `TraderDiscoveryStream` runs with main app
   - Discovers ~10k traders/day passively
   - No external dependencies or costs

2. **Prioritize high-value traders**
   - Adjust discovery queue priority based on trade volume
   - Backfill important traders first

3. **Monitor data quality**
   - Dashboard showing completeness
   - Alerts for stale data
   - Automated gap detection and backfill

4. **Optional: Supplementary sources**
   - Nansen API for whale-specific tracking
   - Leaderboard scraping for performance leaders

---

## Summary

| Question | Answer |
|----------|--------|
| **Do we have a list of traders?** | ✅ Yes! We auto-discover from market trades |
| **How do we discover new traders?** | `recentTrades` endpoint includes addresses (~10k/day) |
| **How do we track completeness?** | `traders` table with tracking columns |
| **How do we ensure complete data?** | Backfill jobs + gap detection + monitoring |

**Key insight**: While Hyperliquid doesn't provide a "list all traders" API, every trade in `recentTrades` includes both the buyer and seller addresses. By polling this endpoint for popular coins, we can **passively discover thousands of active traders per day** without any scraping or paid APIs!
